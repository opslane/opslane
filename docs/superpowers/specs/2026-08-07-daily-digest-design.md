# Daily Digest v1 — Design

Status: approved pending user review
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
- No `digests` table or dashboard archive page; the outbox event payload is
  the system of record.
- No trend arrows / spike detection (needs time-bucketed baselines; arrives
  with priority score work).
- No per-user preferences, weekly rollups, or org-level digests.
- No Slack app / OAuth connect flow — separate follow-up slice using the
  `incoming-webhook` OAuth scope, which yields a webhook URL that lands in the
  same `notification_destinations` row. Nothing in the digest depends on how
  the webhook URL was obtained.

## Architecture

Everything lives in the ingestion service (Go). Rationale: the free tier is
watching + digest; the digest must not depend on worker health, and the
notification outbox/dispatcher already live in ingestion.

```
digest sweep (ticker, ~5 min)
  └─ due-ness query → due projects
       └─ per project: aggregate 24h window → build payload (JSON)
            └─ publish digest.daily to outbound_events
                 (dedup_key = digest.daily:<project_id>:<YYYY-MM-DD local date>)
                      └─ existing dispatcher → Slack formatter → webhook POST
```

### Scheduling: sweep + derived due-ness (no scheduler state)

A goroutine in ingestion following the retention/scrubber ticker pattern,
tick ~5 minutes (bounds worst-case lateness at ~5 min; the tick frequency is
safe to change — correctness never depends on it).

A project is **due** when all of:

1. It has ≥1 enabled notification destination subscribed to `digest.daily`
   (no subscriber → no work, matching publish-time fan-out semantics).
2. No `digest.daily` outbound event exists for today's date in the project's
   timezone (checked via `dedup_key`).
3. Either:
   - **First digest:** no `digest.daily` event has ever been published for the
     project, and the project's first production data is ≥24h old, where
     first production data = `MIN(sessions.started_at)` for the project's
     default environment (`projects.default_environment_id`); fully served by
     `idx_sessions_project_env_started`. No stamped column.
   - **Subsequent:** a prior digest exists and local time ≥ 09:00 in
     `projects.digest_timezone`.

Durability and idempotency come from data: the sweep recomputes due-ness from
the tables every tick, and `outbound_events UNIQUE (project_id, dedup_key)`
makes concurrent/repeated publishes a no-op. Restarts, replicas, and missed
ticks are all safe by construction. A day with no successful send does not
roll forward: the next digest still covers only its own trailing 24h window
(accepted tradeoff for simplicity).

Per-project isolation: a failure aggregating or publishing one project's
digest is logged and skipped; the next tick retries it. No retry state.

### Window

Trailing 24 hours at generation time. No since-last-digest bookkeeping.

### Schema changes (one migration, idempotent per migration conventions)

1. Widen `outbound_events.event_type` CHECK to include `digest.daily`.
2. Widen `notification_destinations.event_types` containment CHECK to allow
   `digest.daily`.
3. Backfill: add `digest.daily` to `event_types` of all existing destinations
   (decision: digest is automatic everywhere; a destination can be
   unsubscribed via the existing update endpoint).
4. `projects.digest_timezone TEXT NOT NULL DEFAULT 'UTC'` — IANA zone name,
   validated on write in the settings handler; 09:00 local is the fixed send
   slot in v1.
5. Index `end_users (project_id, last_seen)` to support the watching line's
   user count.

Code-side constants: add `digest.daily` to `knownNotificationEventTypes` and
to the default `event_types` used when creating a destination.

## Payload

Channel-neutral, versioned JSON stored as the outbox event payload. The
existing `EventPayload` struct is issue-shaped; per its declared add-only
contract it grows a digest variant (nil for issue events) rather than being
reshaped. Slack rendering must not require any further DB reads.

```jsonc
{
  "version": 1,
  "project": { "id": "…", "name": "acme-web", "dashboard_url": "…" },
  "date": "2026-08-07",            // local date in project timezone
  "window": { "from": "…", "to": "…" },
  "all_quiet": false,
  "outcomes": {
    "prs_opened":  [ { "title": "…", "pr_url": "…", "pr_number": 482, "merged": true } ],
    "needs_human": [ { "title": "…", "reason_message": "…", "url": "…" } ],
    "prs_opened_more": 0,           // overflow counts beyond the 3 listed
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
```

Section sources (all existing columns; queries re-scope the admin-overview /
`GetFixStats` shapes to one project over the window):

- `outcomes`: `error_groups.pr_created_at` / `merged_at` / `needs_human_at`
  within window; merged flag via `pr_outcomes`.
- `needs_human_backlog`: count of groups with current status `needs_human`.
- `top_new_issues`: `kind='error'`, `first_seen` within window, ranked by
  `affected_users_count * occurrence_count`, top 3. Priority score v1 swaps
  into this ORDER BY later without changing the payload.
- `insights`: `kind='friction'` groups that reached `insight` status within
  window, carrying the friction investigator's stored `reason_message` /
  `remediation` (LLM prose written earlier by the friction pipeline, not at
  digest time), top 3.
- `watching`: `COUNT(*)` sessions started in window
  (`idx_sessions_project_started`); `COUNT(*)` end users with `last_seen` in
  window (new index).
- `all_quiet` = outcomes, top_new_issues, and insights all empty. The digest
  still sends: short form with the watching line (and backlog count if > 0).

All lists cap at 3 with `*_more` overflow counts and dashboard deep-links.

## Rendering

The `notify` formatter layer gains per-event-type awareness: the Slack
formatter renders the digest payload as Block Kit (header with project + date,
one section per non-empty digest section, quiet form when `all_quiet`),
staying within Slack's 50-block / 3000-chars-per-section limits by
construction (caps of 3). Existing `issue.created` rendering is untouched.
A future email destination is a new destination type + formatter only.

## API

`POST /projects/{projectID}/digest/test` — mirrors the existing destination
test-send: `AuthenticateUserSession` + `requireIntegrationAdmin` +
`verifyProjectAccess`, synchronous send, bypasses the outbox, returns
`{ok, classification, status_code}`. Unlike the notification test-send, it
renders the project's **real** trailing-24h digest (this is the concierge
demo button). Sent to a destination specified in the body or to all
digest-subscribed destinations of the project.

## Error handling

- Sweep tick failures: logged, next tick retries; due-ness is derived so
  nothing is lost.
- Publish conflicts (`ON CONFLICT DO NOTHING` on dedup key): expected under
  replica concurrency; not an error.
- Delivery failures/retries/pruning: existing dispatcher machinery, unchanged.
- Invalid `digest_timezone` writes are rejected at the API; the sweep treats
  an unloadable zone as UTC and logs it (cannot happen via API, defends
  against manual writes).

## Testing

- DB-gated Go tests (table-driven) for due-ness: fresh project (< 24h data),
  first-digest boundary, already-sent-today, timezone boundary around 09:00,
  no-subscriber, quiet-day payload, backlog count.
- Payload builder tests against seeded fixtures covering every section and
  the caps/overflow counts.
- Slack renderer golden test (payload → Block Kit JSON), including the quiet
  form.
- Live smoke per repo verification rules: seed events/sessions + a
  destination pointed at a test webhook receiver, run the sweep, assert the
  outbound event row, delivery row, and received POST body.

## Rollout note

On deploy, existing projects with subscribed destinations and ≥24h of
production data all become due at the next tick and receive their first
digest that day (small N; acceptable). Their digests then settle onto the
09:00 local slot.
