# Daily Digest v1 — Design

Status: approved pending user review (rev 4, post external review)
Date: 2026-08-07
CEO plan: `~/.gstack/projects/opslane-opslane-oss/ceo-plans/2026-08-07-v1-positioning-gtm.md` (scope #4)

## Purpose

The digest is Opslane's daily proof-of-work heartbeat for the "error tracker
you never have to open" positioning, told **from the customer's perspective**:
where end users struggled (with named accounts and a replay link), what new
errors they hit, and what Opslane did about it — delivered so the reader
ideally never needs to open the dashboard. It is templated end to end — **no
LLM calls anywhere in the digest path** — so free-tier COGS stays ~0. Any
prose it shows (root-cause excerpts) was authored earlier by the
investigation pipelines, where an LLM already runs, and stored. It is
decoupled from the delivery channel: the digest is an event in the existing
notification outbox; channels are formatters.

Section order is customer-first: where customers struggled → new errors
customers hit → what Opslane did about it → standing backlog → watching line.
The digest reads as "your customers' day," not "our activity log."

Friction items need no stored prose at all: the three signal types map to
three fixed customer-language phrasings ("clicked repeatedly with no
response", "clicked and nothing happened", "abandoned a form"), rendered
with page, accounts, and replay link. An authored per-incident impact
sentence (a `customer_impact` column written at investigation time) is
**deferred**: add it only if concierge users find the template insufficient.

## Non-goals (v1)

- No LLM synthesis or narrative (CEO plan scope #4; act-two item), and no
  new stored-prose columns (`customer_impact` deferred, see above).
- No email destination (one migration + one formatter later; digest unchanged).
- No `digests` table or dashboard archive page. The outbox event payload is
  the **retained delivery record** (pruned after ~30 days by the existing
  dispatcher prune), not a permanent system of record.
- No environment scoping: the digest is **project-wide**. Production-only
  aggregation would need per-environment occurrence/affected-user semantics
  that don't exist; revisit only if a customer asks.
- No trend arrows / spike detection (needs time-bucketed baselines; arrives
  with priority score work).
- No per-user preferences, weekly rollups, org-level digests, or
  configurable send time (09:00 local is fixed; only the timezone varies).
- No Slack app / OAuth connect flow — separate follow-up slice using the
  `incoming-webhook` OAuth scope, which yields a webhook URL that lands in
  the same `notification_destinations` row.

## Architecture

Everything lives in the ingestion service (Go). **No worker changes.**
Rationale: the free tier is watching + digest; the digest must not depend on
worker health, and the notification outbox/dispatcher already live in
ingestion.

```
digest sweep (ticker, ~5 min; enabled by config — see Rollout)
  └─ due-ness query → candidate projects; per-project TZ check in Go
       └─ per project: aggregate trailing 24h → build payload (JSON)
            └─ publish digest.daily to outbound_events
                 (dedup_key = digest.daily:<project_id>:<YYYY-MM-DD local date>)
                      └─ existing dispatcher → Slack formatter → webhook POST
```

The digest is **one deep module** (`packages/ingestion/digest/`) exposing two
deliberate operations: `RunOnce(ctx, now)` (the sweep tick) and
`Build(ctx, projectID, now)` (construct one project's payload; used by
`RunOnce` and by the test-send endpoint). Candidate selection, aggregation,
and publishing stay behind them. Passing `now` explicitly makes tests
deterministic; no clock interface.

### Scheduling: sweep + derived due-ness (no scheduler state)

Tick ~5 minutes (bounds worst-case lateness at ~5 min; the tick frequency is
safe to change — correctness never depends on it).

A project is **due** when all of:

1. It has ≥1 enabled notification destination subscribed to `digest.daily`
   (no subscriber → no work, matching publish-time fan-out semantics).
2. No `digest.daily` outbound event exists for today's date in the project's
   timezone (checked via `dedup_key`).
3. Either:
   - **First digest:** no `digest.daily` event exists for the project, and
     the project's first-activity anchor —
     `COALESCE(MIN(sessions.started_at), projects.created_at)` — is ≥24h
     old. The data anchor is deliberate (decision: the 24h clock starts at
     first production data, not project creation); the COALESCE covers
     projects with no session rows. Served by `idx_sessions_project_started`.
   - **Subsequent:** a prior digest event exists and local time ≥ 09:00 in
     `projects.digest_timezone`.

Timezone evaluation happens **per project in Go**, not in SQL: SQL fetches
candidates; Go loads each zone and decides due-ness. An invalid stored zone
(impossible via the validating API, defends against manual writes) is
**skipped and logged** — never silently coerced to UTC, and never able to
fail the whole sweep.

Durability and idempotency come from data: the sweep recomputes due-ness from
the tables every tick, and `outbound_events UNIQUE (project_id, dedup_key)`
makes concurrent/repeated publishes a no-op. Restarts, replicas, and missed
ticks are all safe by construction. Accepted edges, stated plainly:

- A day with no successful send does not roll forward; the next digest still
  covers only its own trailing 24h window.
- Because outbox events are pruned after ~30 days, a project unsubscribed for
  longer than retention and then re-subscribed is treated as a first digest
  (sends at next tick rather than waiting for 09:00). We accept this rather
  than adding scheduler state for it.

Per-project isolation: a failure aggregating or publishing one project's
digest is logged and skipped; the next tick retries it. No retry state.

### Window

Trailing 24 hours at generation time. No since-last-digest bookkeeping.

### Schema changes (one migration, idempotent per migration conventions)

1. Widen `outbound_events.event_type` CHECK to include `digest.daily`.
2. Widen `notification_destinations.event_types` containment CHECK to allow
   `digest.daily`, and change the column default to
   `'{issue.created,digest.daily}'`.
3. **Backfill** existing destination rows: one UPDATE appending
   `digest.daily` to `event_types` where absent. Why: fan-out happens at
   publish time and only creates deliveries for destinations whose
   `event_types` contains the event type; a changed default only affects
   future rows. Decision (kept over reviewer objection): digest is automatic
   everywhere — it is the product's heartbeat, current destinations are
   concierge-managed, and the unsubscribe toggle ships in the same release.
4. `projects.digest_timezone TEXT NOT NULL DEFAULT 'UTC'` — IANA zone name,
   validated on write; 09:00 local is the fixed send slot in v1.

No other schema changes: no `insight_at` (windowing comes from
`friction_signals.occurred_at`), no `customer_impact` (deferred), no new
index on `end_users` (user count comes from `sessions.end_user_id`).

Code-side changes with the migration:

- Add `digest.daily` to `knownNotificationEventTypes`.
- **Create-handler default:** the handler explicitly supplies
  `["issue.created"]` when the request omits `event_types`
  (`notifications.go`); change that literal to include `digest.daily` — the
  DB default alone does not affect this path.
- **Unsubscribe path (ships in the same release as the backfill, never
  after):** add `event_types` to the PATCH request, validate against
  `knownNotificationEventTypes` + non-empty, thread it through
  `UpdateNotificationDestination`'s COALESCE update, and expose the toggle
  in the dashboard's notification settings. Include project-settings PATCH +
  dashboard control + handler tests for `digest_timezone` in the same scope.

## Payload

Channel-neutral, versioned JSON stored as the outbox event payload. Frozen
envelope — digest fields live under a `digest` key, never at the top level:

```jsonc
{
  "version": 1,
  "event_type": "digest.daily",
  "project": { "id": "…", "name": "AMFJ 2" },
  "dashboard_url": "…",
  "digest": {
    "date": "2026-08-07",            // local date in project timezone
    "window": { "from": "…", "to": "…" },
    "insights": [                     // section 1: where customers struggled (windowed)
      { "signal_type": "rage_click", "page": "/assets/:id",
        "occurrences": 9, "affected_users": 4,      // in-window, from friction_signals
        "accounts": ["apptronik.atlassian.net", "randstadgr.atlassian.net", "irembo.atlassian.net"],
        "accounts_more": 1,
        "replay_url": "…",            // session from the window; fallback representative_session_id; null when absent
        "url": "…" }
    ],
    "insights_has_more": false,
    "top_new_issues": [               // section 2: new errors customers hit
      { "title": "RangeError: Invalid time value", "url": "…",
        "root_cause_excerpt": "The Asset Details page builds a Date directly from an activity timestamp…",  // null when uninvestigated
        "occurrences": 1, "affected_users": 1,
        "accounts": ["marcomgroup.atlassian.net"], "accounts_more": 0,
        "replay_url": null }
    ],
    "top_new_issues_has_more": true,
    "outcomes": {                     // section 3: what Opslane did about it
      "prs_opened": [                 // pr_created_at in window; merged flag = current pr_outcomes state
        { "title": "…", "pr_url": "…", "pr_number": 1306, "merged": false,
          "root_cause_excerpt": "Originates in @forge/bridge changeWindowTitle.js…" }
      ],
      "prs_merged": [                 // merged_at in window, opened before it (no overlap with prs_opened)
        { "title": "…", "pr_url": "…", "pr_number": 1291 }
      ],
      "needs_human": [                // needs_human_at in window
        { "title": "Error: cancelled", "url": "…",
          "reason_message": "Investigation couldn't rule out app-side causes…",
          "accounts": ["cariad-us-sandbox-279.atlassian.net"], "accounts_more": 0 }
      ],
      "prs_opened_has_more": false,
      "prs_merged_has_more": false,
      "needs_human_has_more": false
    },
    "needs_human_backlog": 121,       // standing count of groups currently in needs_human
    "watching": { "sessions": 13470, "users": 147 }
  }
}
```

Go side: the envelope becomes a real tagged union. `Issue` becomes
`*IssueRef `json:"issue,omitempty"``, `Environment` gains `omitempty`, and
`Digest *DigestPayload `json:"digest,omitempty"`` is added; publish-side
validation requires exactly one body matching `event_type`. (Stored
issue-event JSON is unaffected — the pointer changes Go marshalling of empty
values, not existing rows.) `FormatSlack` switches on `payload.EventType`
and errors on an unknown type — no new formatter registry. There is
deliberately **no stored `all_quiet` flag**: quietness is derived by the
renderer from empty sections.

Field sourcing:

- **Lists cap at 3** and set `*_has_more` by fetching 4 and displaying 3 —
  no exact overflow count queries. `accounts_more` is the exception: it
  falls out of the same aggregate that produces the top-3 names.
- `accounts` / `accounts_more`: top 3 distinct account names, ordered by
  affected users per account descending, then account name (deterministic).
  For insights: from windowed `friction_signals.end_user_id → end_users`.
  For errors: via `error_group_affected_users → end_users`. Omit the
  fragment when empty (anonymous traffic).
- `replay_url`: dashboard `/sessions/<id>` — for insights, the most recent
  in-window signal's `session_id`, falling back to
  `representative_session_id`; null otherwise.
- `root_cause_excerpt`: leading sentence(s) of stored `root_cause`, budgeted
  by the renderer; null when uninvestigated. Renderer fallback: excerpt,
  then title alone.
- **Dedup rule:** a group appearing in `outcomes` is excluded from
  `top_new_issues` — outcomes wins. (Observed in prod: the same error was
  both PR'd and first-seen in one window.)
- Ranking arithmetic (`affected_users_count * occurrence_count`) casts to
  BIGINT.

Section sources (existing columns only; project-wide, trailing 24h):

- `insights`: aggregate **`friction_signals`** with `occurred_at` in window,
  `retracted_at IS NULL AND superseded_by IS NULL`, grouped by
  `incident_id`, keeping groups whose current status is `insight`; metrics
  are `SUM(occurrence_count)` and `COUNT(DISTINCT end_user_id)` over the
  window — **not** the cumulative `error_groups` counters. Ranked by
  windowed affected users, top 3.
- `top_new_issues`: `kind='error'`, `first_seen` within window (cumulative
  counters are window-accurate for new groups), minus groups already in
  `outcomes`, ranked by `affected_users_count * occurrence_count`, top 3.
  Priority score v1 swaps into this ORDER BY later without changing the
  payload.
- `outcomes`: `pr_created_at` / `merged_at` / `needs_human_at` within
  window; merged flag and `prs_merged` via `pr_outcomes`.
- `needs_human_backlog`: count of groups with current status `needs_human`.
- `watching`: `COUNT(*)` sessions started in window and
  `COUNT(DISTINCT end_user_id)` over those same sessions
  (`idx_sessions_project_started`) — consistent semantics, no new index.

Slack rendering must not require any further DB reads.

## Rendering

`FormatSlack` gains a digest branch rendering Block Kit: header with project +
date, one section per non-empty digest section in the customer-first order,
and a short quiet form when all sections are empty (watching line + backlog
count if > 0). Friction items render the fixed per-signal-type phrasing.
Every prose field (titles, excerpts, reasons, pages, account names) gets
**masking, markdown neutralization, escaping, and rune-safe truncation** with
explicit per-field budgets, reusing the existing helpers in
`notify/slack.go` — the 3-item caps alone do not guarantee Slack's
3,000-chars-per-section limit. Existing `issue.created` rendering is
untouched. A future email destination is a new destination type + formatter
only.

## API

Digest test-send **reuses the existing route**
`POST /projects/{projectID}/notification-destinations/{destID}/test`: the
body gains an optional `event_type` field (default: today's behavior). With
`"event_type": "digest.daily"` it calls the digest module's
`Build(ctx, projectID, now)` and sends the result synchronously to that
destination, bypassing the outbox — same auth
(`AuthenticateUserSession` + `requireIntegrationAdmin` +
`verifyProjectAccess`). This is the concierge demo button.

## Rollout (two-phase, required)

An old-replica dispatcher that claims a `digest.daily` delivery would render
it through the issue-shaped formatter with empty fields. Therefore:

1. **Phase 1:** deploy the release with formatters, migration, PATCH/toggle,
   and the sweep **disabled by config** (`DIGEST_SWEEP_ENABLED=false`
   default).
2. **Phase 2:** once no old replicas remain, enable the sweep. Existing
   projects with subscribed destinations and ≥24h of data become due at the
   next tick and receive their first digest that day; digests then settle
   onto the 09:00 local slot.

The new `FormatSlack` erroring on unknown event types protects the reverse
direction (future event types against this binary).

## Error handling

- Sweep tick failures: logged, next tick retries; due-ness is derived so
  nothing is lost.
- Publish conflicts (`ON CONFLICT DO NOTHING` on dedup key): expected under
  replica concurrency; not an error.
- Delivery failures/retries/pruning: existing dispatcher machinery, unchanged.
- Invalid `digest_timezone`: rejected at the API; the sweep skips and logs
  the project.

## Testing

- DB-gated Go tests (table-driven) driving `RunOnce(ctx, now)` with explicit
  `now` values: fresh project (< 24h data), first-digest boundary (with and
  without session rows), already-sent-today, timezone boundary around 09:00,
  invalid-zone skip, no-subscriber, quiet-day payload, backlog count, sweep
  disabled by config.
- `Build` tests against seeded fixtures covering every section, caps +
  `has_more`, windowed friction metrics (including retracted/superseded
  signals excluded and cumulative-vs-window divergence), account attribution
  (ordering, top-3 + overflow, empty/anonymous), replay-URL
  window-preference and fallback, the outcomes-wins dedup rule, and
  `prs_merged` (merged in window, opened before it).
- Envelope tests: exactly-one-body validation; digest JSON emits no `issue`
  or `environment` keys; issue JSON unchanged.
- Slack renderer golden test (payload → Block Kit JSON), including the quiet
  form, per-signal-type phrasings, per-field budgets, and masking/markdown
  neutralization; unknown event type errors.
- PATCH `event_types` tests: subscribe/unsubscribe round-trip, rejection of
  unknown types and empty lists; create-handler default includes
  `digest.daily`; `digest_timezone` PATCH validation.
- Live smoke per repo verification rules: seed events/sessions/signals + a
  destination pointed at a test webhook receiver, enable the sweep, run it,
  assert the outbound event row, delivery row, and received POST body.
