# Daily Digest v1 — Design

Status: approved pending user review (rev 2, post-review)
Date: 2026-08-07
CEO plan: `~/.gstack/projects/opslane-opslane-oss/ceo-plans/2026-08-07-v1-positioning-gtm.md` (scope #4)

## Purpose

The digest is Opslane's daily proof-of-work heartbeat for the "error tracker
you never have to open" positioning: what Opslane did, what it found, and what
it watched in the last 24 hours, delivered to the customer's channel. It is
templated end to end — **no LLM calls anywhere in the digest path** — so
free-tier COGS stays ~0. It is decoupled from the delivery channel: the digest
is an event in the existing notification outbox; channels are formatters.

## Non-goals (v1)

- No LLM synthesis or narrative (CEO plan scope #4; act-two item).
- No email destination (one migration + one formatter later; digest unchanged).
- No `digests` table or dashboard archive page. The outbox event payload is
  the **retained delivery record** (pruned after ~30 days by the existing
  dispatcher prune), not a permanent system of record.
- No environment scoping: the digest is **project-wide**. Production-only
  aggregation would need per-environment occurrence/affected-user semantics
  that don't exist; revisit only if a customer asks.
- No trend arrows / spike detection (needs time-bucketed baselines; arrives
  with priority score work).
- No per-user preferences, weekly rollups, or org-level digests.
- No Slack app / OAuth connect flow — separate follow-up slice using the
  `incoming-webhook` OAuth scope, which yields a webhook URL that lands in the
  same `notification_destinations` row. Nothing in the digest depends on how
  the webhook URL was obtained.

## Architecture

Everything lives in the ingestion service (Go), except one small worker change
(stamping `insight_at`). Rationale: the free tier is watching + digest; the
digest must not depend on worker health, and the notification
outbox/dispatcher already live in ingestion.

```
digest sweep (ticker, ~5 min)
  └─ due-ness query → candidate projects; per-project TZ check in Go
       └─ per project: aggregate trailing 24h → build payload (JSON)
            └─ publish digest.daily to outbound_events
                 (dedup_key = digest.daily:<project_id>:<YYYY-MM-DD local date>)
                      └─ existing dispatcher → Slack formatter → webhook POST
```

The digest is **one deep module** (`packages/ingestion/digest/`) exposing a
small interface — `RunOnce(ctx, now)` — called by the ticker. Candidate
selection, aggregation, payload construction, and publishing are
implementation details behind it. Passing `now` explicitly makes tests
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
   - **First digest:** no `digest.daily` event exists for the project, and the
     project's first activity — `MIN(sessions.started_at)` anywhere in the
     project, served by `idx_sessions_project_started` — is ≥24h old.
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
   `digest.daily`, and change the column **default** to
   `'{issue.created,digest.daily}'` so new destinations subscribe
   automatically.
3. **Backfill** existing destination rows: one UPDATE appending
   `digest.daily` to `event_types` where absent. Why it's needed: fan-out
   happens at publish time and only creates deliveries for destinations whose
   `event_types` contains the event type — a changed default only affects
   rows created later, so without the backfill no existing channel would ever
   receive a digest.
4. `projects.digest_timezone TEXT NOT NULL DEFAULT 'UTC'` — IANA zone name,
   validated on write in the settings handler; 09:00 local is the fixed send
   slot in v1.
5. `error_groups.insight_at TIMESTAMPTZ` — stamped by the worker on the
   transition into `insight` status, exactly like `pr_created_at` /
   `needs_human_at` (worker `updateGroupStatus` CASE gains one branch).
   Status is mutable; the timestamp is what makes "reached insight in
   window" queryable.
6. Index `end_users (project_id, last_seen)` to support the watching line's
   user count.

Code-side changes with the migration:

- Add `digest.daily` to `knownNotificationEventTypes`.
- **Unsubscribe path (required before automatic opt-in ships):** add
  `event_types` to the PATCH request
  (`updateNotificationDestinationRequest`), validate against
  `knownNotificationEventTypes` + non-empty, thread it through
  `UpdateNotificationDestination`'s COALESCE update, and expose the toggle in
  the dashboard's notification settings. Without this, backfilled customers
  would have no way out.

## Payload

Channel-neutral, versioned JSON stored as the outbox event payload. Frozen
envelope — digest fields live under a `digest` key, never at the top level:

```jsonc
{
  "version": 1,
  "event_type": "digest.daily",
  "project": { "id": "…", "name": "acme-web" },
  "dashboard_url": "…",
  "digest": {
    "date": "2026-08-07",            // local date in project timezone
    "window": { "from": "…", "to": "…" },
    "outcomes": {
      "prs_opened":  [ { "title": "…", "pr_url": "…", "pr_number": 482, "merged": true } ],
      "needs_human": [ { "title": "…", "reason_message": "…", "url": "…" } ],
      "prs_opened_more": 0,           // overflow beyond the 3 listed
      "needs_human_more": 0
    },
    "needs_human_backlog": 3,         // standing count of groups currently in needs_human
    "top_new_issues": [
      { "title": "…", "url": "…", "occurrences": 214, "affected_users": 38 }
    ],
    "top_new_issues_more": 4,
    "insights": [
      { "signal_type": "rage_click", "page": "/settings/profile",
        "affected_users": 14, "reason": "…", "remediation": "…", "url": "…" }
    ],
    "insights_more": 0,
    "watching": { "sessions": 1204, "users": 212 }
  }
}
```

Go side: `EventPayload` gains `Digest *DigestPayload
`json:"digest,omitempty"`` per its add-only contract; existing issue fields
are untouched (zero-valued and unused for digest events). `FormatSlack`
switches on the existing `payload.EventType` field — no new formatter
registry or abstraction. There is deliberately **no stored `all_quiet`
flag**: quietness is derived by the renderer from empty sections (a stored
flag could contradict `needs_human_backlog > 0`).

Section sources (all existing columns plus `insight_at`; queries re-scope the
admin-overview / `GetFixStats` shapes to one project over the window, all
project-wide):

- `outcomes`: `error_groups.pr_created_at` / `merged_at` / `needs_human_at`
  within window; merged flag via `pr_outcomes`.
- `needs_human_backlog`: count of groups with current status `needs_human`.
- `top_new_issues`: `kind='error'`, `first_seen` within window, ranked by
  `affected_users_count * occurrence_count`, top 3. Priority score v1 swaps
  into this ORDER BY later without changing the payload.
- `insights`: `kind='friction'` groups with `insight_at` within window,
  carrying the friction investigator's stored `reason_message` /
  `remediation` (LLM prose written earlier by the friction pipeline, not at
  digest time), top 3.
- `watching`: `COUNT(*)` sessions started in window
  (`idx_sessions_project_started`); `COUNT(*)` end users with `last_seen` in
  window (new index).

All lists cap at 3 with `*_more` overflow counts and dashboard deep-links.
Slack rendering must not require any further DB reads.

## Rendering

`FormatSlack` gains a digest branch rendering Block Kit: header with project +
date, one section per non-empty digest section, and a short quiet form when
all sections are empty (watching line + backlog count if > 0). Field content
(titles, reasons, remediations) is unbounded at the source, so the renderer
applies **explicit per-field budgets** using the existing rune-safe
truncation/escaping helpers in `notify/slack.go` — the 3-item caps alone do
not guarantee Slack's 3,000-chars-per-section limit. Existing `issue.created`
rendering is untouched. A future email destination is a new destination type
+ formatter only.

## API

Digest test-send **reuses the existing route**
`POST /projects/{projectID}/notification-destinations/{destID}/test`: the
body gains an optional `event_type` field (default: today's behavior). With
`"event_type": "digest.daily"` it renders the project's **real** trailing-24h
digest and sends it synchronously to that destination, bypassing the outbox,
returning `{ok, classification, status_code}` — same auth
(`AuthenticateUserSession` + `requireIntegrationAdmin` +
`verifyProjectAccess`). No new route, no one-vs-all delivery modes. This is
the concierge demo button.

## Error handling

- Sweep tick failures: logged, next tick retries; due-ness is derived so
  nothing is lost.
- Publish conflicts (`ON CONFLICT DO NOTHING` on dedup key): expected under
  replica concurrency; not an error.
- Delivery failures/retries/pruning: existing dispatcher machinery, unchanged.
- Invalid `digest_timezone`: rejected at the API; the sweep skips and logs
  the project (see Scheduling).

## Testing

- DB-gated Go tests (table-driven) driving `RunOnce(ctx, now)` with explicit
  `now` values: fresh project (< 24h data), first-digest boundary,
  already-sent-today, timezone boundary around 09:00, invalid-zone skip,
  no-subscriber, quiet-day payload, backlog count.
- Payload builder tests against seeded fixtures covering every section, the
  caps/overflow counts, and `insight_at` windowing.
- Worker test for the `insight_at` stamping branch (transition vs. re-set).
- Slack renderer golden test (payload → Block Kit JSON), including the quiet
  form and per-field truncation budgets.
- PATCH `event_types` tests: subscribe/unsubscribe round-trip, rejection of
  unknown types and empty lists.
- Live smoke per repo verification rules: seed events/sessions + a
  destination pointed at a test webhook receiver, run the sweep, assert the
  outbound event row, delivery row, and received POST body.

## Rollout note

On deploy, existing projects with subscribed destinations and ≥24h of data
all become due at the next tick and receive their first digest that day
(small N; acceptable). Their digests then settle onto the 09:00 local slot.
The unsubscribe path (PATCH `event_types` + dashboard toggle) ships in the
same release as the backfill, never after it.
