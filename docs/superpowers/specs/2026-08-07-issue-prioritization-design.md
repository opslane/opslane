# Issue Prioritization v1 — Design

Date: 2026-08-07
Status: awaiting review
Scope anchor: CEO plan 2026-08-07 (scope #5, "Priority score v1"), sequenced
before notification inversion (#3) and the daily digest (#4).

## Goal

Rank error issues by real user impact so the dashboard and the daily digest
surface what needs fixing and bury what does not. This is the load-bearing
proof of "an error tracker you never have to open": today the dashboard
orders by `last_seen`, which put smoke-test errors and 0-user noise above a
354-occurrence issue affecting 10 users (verified on prod, 2026-08-07).

Design principle (Abhishek): simplicity and constraints; good enough over
perfect; every mechanism explainable in one sentence.

## The score

```
priority = impact × context × cap
```

Computed per error group, stored on the group with its ingredients.

**impact** — "how many people is this hurting right now?"

```
reach_7d  = identified users seen in last 7 days;  if zero → distinct sessions in last 7 days
reach_24h = same rule over last 24 hours
impact    = reach_7d + 2 × reach_24h
```

- Identified users come from the existing `error_group_affected_users`
  rollup (per-user `last_seen` gives both windows with no new ingest
  writes). Sessions come from `error_events.session_id` over the window.
- Groups scored via the session fallback carry a visible flag: "no user
  identification on this surface." When the project HAS identified users on
  other groups, the flag upgrades to an integration hint ("identify() is
  wired elsewhere in your app but not on this surface"). Rationale: AMFJ's
  JSM portal panel — its only revenue-tier surface — had 541 error
  occurrences and scored 0 because that bundle inits the Opslane SDK but
  never calls `setUser`, while calling `Sentry.setUser` with the same data
  (`client/asset-portal-panel/src/hooks/useAuth.ts:55`). The fallback keeps
  such issues visible; the flag makes the root cause fixable.
- Identity is whatever the customer passes to `identify()` — AMFJ passes
  `install_id`, so its "users" are customer orgs. That is acceptable and
  not corrected for.

**context** — "who is standing on the page when it breaks?"

Route weight from the route map (below), assigned by precedence, each with
a plain-language reason shown wherever the tag appears:

1. **Customer-facing ×3** — someone outside the team is on this page:
   end customers, counterparties, the public. Detected from code facts,
   not business inference: unauthenticated/token routes (`/sign/:token`),
   public-domain middleware allowlists, portal/embed module declarations
   (AMFJ's manifest declares its panel renders on the JSM customer
   portal). Reason string: "your customers see this page."
2. **Heavily used ×1.5 — v1.1, not v1.** The old "core workflow" tier,
   resurrected as a measurement: pages with top share of observed session
   visits (replay navigation data; recording is always-on). Needs a
   page→distinct-sessions rollup that does not exist yet, so v1 reserves
   the slot and does not ship it. Reason string: "most of your users'
   sessions touch this page."
3. **Admin & settings ×0.5** — `requiresAdmin` flags, `/settings/*`,
   `/admin/*`. Reason string: "internal config page."
4. **Everything else ×1.**

Unmapped URL or no repo connected: ×1. Weights are fixed and identical
for every project in v1; humans edit a route's tier, never the numbers.
An earlier draft used business tiers (revenue/core/standard); rejected
because "revenue" required business-model inference the spikes never
tested and read as jargon on the dashboard — audience is a code fact and
self-explanatory.

**cap** — "can anyone act on it through Opslane?"

×0.1 when the group's stamped `reason_code` is in the existing terminal
unfixable-class set (`unfixable_third_party`, `unfixable_no_app_frames`,
`unfixable_infra`, `unfixable_test_error`, `triage_unfixable`).
Uninvestigated groups are uncapped. Capped issues are never hidden — they
rank low, and when one still makes a surface (digest/top of list) it shows
its existing per-reason-code remediation string (e.g. stale deploy → "serve
previous deploy's assets or auto-reload on chunk failure").

Ties (all-zero scores) fall back to the current `last_seen DESC` ordering.

Not in the formula, by decision: rage/dead-click evidence (display context
only), page-importance config, spike-vs-baseline detection, revenue
weighting (plan #15). Chronic-but-expected errors (e.g. deploy-window chunk
errors) are handled by a human archiving them once, not by the score.

## Data and jobs

Two new pieces. Event ingestion hot path and the wire contract are
untouched.

### Score job (Go, in ingestion)

A ticker recomputes all groups per project every 30 minutes in plain SQL
and writes `priority_score` plus an ingredients JSON (reach values, which
reach source was used, route tier, cap applied) onto `error_groups`.
Cadence rationale: consumers are a daily digest and a glanced-at dashboard;
the full recompute measured ~1s on current prod scale, so the interval is
comfort, not cost. Runs with the app role's normal write access (the
read-only `debug_ro` path stays what it is: a human/agent debugging tool).

The job also stamps each group's top recent URL into the existing
`page_url_normalized` column (currently friction-only), after
normalization:

1. Host collapse: `app.*`/`api.*`/raw-IP variants of one product are one
   origin family; classify by path (AMFJ: path-only ingress + Connect
   iframes served from the api host).
2. Fragment routes: if the fragment starts with `!`, the post-`!` string is
   the path (`/#!/reports` → `/reports`).
3. Forge CDN URLs: extract the module segment
   (`.../issue-context/_ctx_...` → `issue-context`) and map via the route
   map. Known limit: the `global-page` module runs a whole SPA on memory
   history, so those errors attribute to "main app" only.
4. ID templating: numeric/uuid segments → `:id`.

### Route-map job (worker, LLM)

Runs at repo-connect, then on demand (manual re-run); classifies **observed
URLs, not the route tree**. Input: the project's distinct normalized URLs
with error events. For each, the agent reads the code behind the URL
(router config, manifest/descriptor for embedded apps, the component) and
writes one row: `pattern, name, purpose, tier` into a new `route_map`
table. Humans can edit rows; edits win.

Evidence for this shape (spike, 2026-08-07, on documenso/dub/formbricks +
AMFJ for real): classification accuracy ~90–95% when the job reads the
code behind each URL; the failure modes are all in *enumerating* route
trees (middleware-only routes, redirect stubs, hostname folders,
non-standard router conventions) — which observed-URL classification
sidesteps entirely. Cost: a handful of LLM calls per repo per run.

Pre-repo-connect, priority runs as users × trend with raw URLs shown; the
route layer activating is part of the repo-connect value story.

## Surfaces

- **Dashboard**: server query orders by `priority_score DESC NULLS LAST,
  last_seen DESC` and "Priority" becomes the default sort (existing client
  sorts stay). Each row shows the route name and a plain-language reason
  built from stored ingredients: "Checkout — 14 users this week, 6 today",
  plus the no-identify flag and (for capped issues) the remediation line.
- **Digest (plan #4)**: consumes the same stored fields; this design
  guarantees field + wording exist, the digest remains its own scope item.
- Friction signals (rage/dead clicks sharing a session with the error) are
  shown as context when present; they do not move the score in v1.

## One-time cleanup

Archive legacy groups whose error class is now suppressed at ingest (e.g.
the prod `ResizeObserver loop` group: 5,796 occurrences, 139 users/7d —
new events of that class are already deleted before grouping, but the old
group still tops any impact ranking). Verify during implementation that
new events cannot silently resurrect an archived group; if regression
logic reopens them, add an explicit muted/expected marker (check, not a
build).

## Install-time requirement

`identify()` wiring — on every bundle, not just the main SPA — becomes an
explicit install/concierge checklist step, since reach quality depends on
it. The per-surface missing-identify flag is the runtime backstop.

## Testing

- Score job: seeded-fixture SQL tests asserting order (spiking beats
  steady; customer-facing beats admin; capped sinks; session-fallback
  groups rank and carry the flag).
- Normalization: unit tests for the four rules against real observed URL
  shapes (AMFJ fixtures: api-host, `#!`, Forge CDN, numeric ids).
- Route-map job: run against `test-fixtures/vue-app`'s router; assert sane
  rows.
- Live smoke per repo gate: seed events → run score job → dashboard API
  returns priority order.

## Validation already done (2026-08-07)

- Formula executed read-only against prod: correctly sank smoke-test and
  0-user noise, surfaced the 10-user stale-deploy issue; exposed the
  ResizeObserver legacy ghost (→ cleanup) and the portal-panel zero-score
  blind spot (→ session fallback + flag).
- Route-map job executed for real on AMFJ (`conelike/asset-management-jira`):
  produced a correct, code-grounded map (portal panel = customer-facing,
  confirmed via the manifest's JSM portal-panel declaration + Connect
  descriptor), plus the normalization rules above.

## Deferred (improve over time)

**First increment (v1.1): the heavily-used ×1.5 boost** — build the
page→distinct-sessions rollup from replay navigation data and activate
the reserved context slot. This replaces LLM judgment of "core workflow"
with observed usage and is the piece competitors structurally lack.

Then: spike-vs-baseline detection; deploy-correlation ("expected during
deploys"); rage-click score boost; important-routes config UI;
reason-code split into human-actionable vs nobody-can-act; route-map
refresh on release changes; Stripe/revenue weighting (plan #15);
per-page attribution inside Forge global-page (needs SDK route
breadcrumb).
