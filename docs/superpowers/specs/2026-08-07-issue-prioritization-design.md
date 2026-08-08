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

**impact** — "how many people is this hurting right now?" Reach with a
24-hour recency boost (deliberately NOT trend or spike detection — that
stays deferred; recent reach simply counts double):

```
reach_w = distinct identified users in window
        + distinct sessions in window having no identified user
impact  = reach_7d + 2 × reach_24h
```

- One monotonic estimate per window, additive across the identified and
  anonymous populations. An earlier draft used users-else-sessions
  fallback; rejected for its discontinuity (a group with 100 anonymous
  sessions + 1 identified user would collapse to reach 1, ranking below
  a 50-session fully-anonymous group — instrumenting identify() must
  never lower a rank).
- Identified users come from the existing `error_group_affected_users`
  rollup; anonymous-only sessions from `error_events` over the window.
- Display shows both parts honestly: "14 known users + 6 anonymous
  sessions this week." A meaningful anonymous share drives the
  integration hint, upgraded when the project has identify data on other
  surfaces ("identify() is wired elsewhere in your app but not here").
  Rationale: AMFJ's JSM portal panel — its customer-facing surface — had
  541 error occurrences and zero identified users because that bundle
  inits the Opslane SDK but never calls `setUser`, while calling
  `Sentry.setUser` with the same data
  (`client/asset-portal-panel/src/hooks/useAuth.ts:55`).
- Identity is whatever the customer passes to `identify()` — AMFJ passes
  `install_id`, so its "users" are customer orgs. That is acceptable and
  not corrected for.
- Friction groups (`kind='friction'`) are scored with the same formula,
  sourced from `friction_signals` (accepted signals' distinct
  users/sessions per window), so the mixed dashboard list has one
  ordering and friction incidents are not silently floored. Error and
  friction reach must never mix sources for one group.

**context** — "who is standing on the page when it breaks?"

Route weight from the route map (below), assigned by precedence, each with
a plain-language reason shown wherever the tag appears:

1. **Customer-facing ×3** — someone outside the team is on this page:
   end customers, counterparties, the public. Detected from code facts,
   not business inference: unauthenticated/token routes (`/sign/:token`),
   public-domain middleware allowlists, portal/embed module declarations
   (AMFJ's manifest declares its panel renders on the JSM customer
   portal). Reason string: "your customers see this page."
2. **Admin & settings ×0.5** — `requiresAdmin` flags, `/settings/*`,
   `/admin/*`. Reason string: "internal config page."
3. **Everything else ×1.**

Unmapped URL or no repo connected: ×1. Weights are fixed and identical
for every project in v1; humans edit a route's tier, never the numbers.
An earlier draft used business tiers (revenue/core/standard); rejected
because "revenue" required business-model inference the spikes never
tested and read as jargon on the dashboard — audience is a code fact and
self-explanatory. A "heavily used ×1.5" tier measured from replay
page-visit data is deferred (nothing is reserved in code or schema;
multiplication composes later).

**Separability (review-driven constraint):** the score job must be fully
functional against an empty `route_map` — every weight resolves to ×1
and the formula degrades to reach × cap. The route-map job ships as its
own increment behind that boundary; if v1 timeline pressure forces a
cut, the cut line is the route-map job alone, and priority still ships.
This also preserves value-before-repo-connect: pre-repo, priority is
reach × cap with the scrubbed page path displayed unclassified.

**cap** — "can anyone act on it through Opslane?"

×0.1 when the group's stamped `reason_code` is in the existing terminal
unfixable-class set (`unfixable_third_party`, `unfixable_no_app_frames`,
`unfixable_infra`, `unfixable_test_error`, `triage_unfixable`).
Uninvestigated groups have no reason code and are therefore uncapped —
stated plainly: before any investigation has run (and before repo-connect
entirely), priority is reach-only; the pre-repo fixability heuristic
belongs to graduated onboarding (plan #1), not this spec. Capped issues
are never hidden — they rank low, and when one still makes a surface
(digest/top of list) it shows its existing per-reason-code remediation
string (e.g. stale deploy → "serve previous deploy's assets or
auto-reload on chunk failure").

**Scope of a score:** scores are project-wide in v1. Groups span
environments, and the API supports environment filtering — under an
active environment filter the explanation must say "project-wide" so a
filtered page never implies its reach came from that environment.
Per-environment scores are explicitly not built.

Ties (all-zero scores) fall back to the current `last_seen DESC` ordering.

Not in the formula, by decision: rage/dead-click evidence (display context
only), page-importance config, spike-vs-baseline detection, revenue
weighting (plan #15). Chronic-but-expected errors (e.g. deploy-window chunk
errors) are handled by a human archiving them once, not by the score.

## Data and jobs

Two new pieces. Event ingestion hot path and the wire contract are
untouched.

### Score job (Go, in ingestion)

A ticker recomputes all open groups (status not in resolved/merged/
archived — closed groups keep their last score, which no list surface
reads) per project every 30 minutes in plain SQL and writes onto
`error_groups`:

- `priority_score REAL`
- `priority_scored_at TIMESTAMPTZ` — so the UI can distinguish "not yet
  scored" from "genuinely zero impact"
- `priority_inputs JSONB` with a fixed shape:
  `{users_7d, anon_sessions_7d, users_24h, anon_sessions_24h, impact,
  route_pattern, route_name, route_tier, route_weight, cap_applied,
  reason_code}` (route_name/route_tier are null until a route map row
  matches; cap_applied is always a boolean, never null)

All ordering uses `COALESCE(priority_score, 0)` so a group created
between ticks joins the zero-score cohort (tie-broken by `last_seen`)
instead of sinking below every stored score for up to 30 minutes.

Cadence rationale: consumers are a daily digest and a glanced-at dashboard;
the full recompute measured ~1s on current prod scale, so the interval is
comfort, not cost. Runs with the app role's normal write access (the
read-only `debug_ro` path stays what it is: a human/agent debugging tool).

The job also stamps each **error** group's top recent URL into the
existing `page_url_normalized` column — defined precisely as the
normalized path with the most events in the last 7 days, ties broken by
latest event. Friction groups keep their existing `page_url_normalized`
semantics untouched. Normalization:

1. Host collapse: `app.*`/`api.*`/raw-IP variants of one product are one
   origin family; classify by path (AMFJ: path-only ingress + Connect
   iframes served from the api host).
2. Fragment routes: if the fragment starts with `!`, the post-`!` string is
   the path (`/#!/reports` → `/reports`).
3. Forge CDN URLs: extract the module segment
   (`.../issue-context/_ctx_...` → `issue-context`) and map via the route
   map. Known limit: the `global-page` module runs a whole SPA on memory
   history, so those errors attribute to "main app" only.
4. ID and token templating: numeric/uuid segments → `:id`; long opaque
   segments (hex/base64 runs, JWT-shaped strings) → `:token`. This runs
   **before the stamp is stored and before any model call** — the SDK's
   `scrubUrl` strips query strings and credentials but deliberately keeps
   path segments, so a raw `/sign/<opaque-token>` path otherwise reaches
   `page_url_normalized` and the route-map job verbatim. Templating here
   is the privacy boundary for the surfaces this feature adds. (Raw URLs
   already live inside `error_events.context` under existing retention
   and scrubbing; changing event storage is out of scope.)

### Route-map job (worker, LLM)

Triggered by the score sweeper's tick: any project with a connected repo
and stamped patterns that have no `route_map` row gets a classification
job enqueued (deduped). This covers repo-connect (≤ one tick later),
repos connected before the feature shipped, and new URLs appearing —
no handler hook and no manual-rerun mechanism needed in v1. It
classifies **observed stamped patterns, not the route tree**: the input
is the project's distinct `page_url_normalized` values, which is exactly
the set the score consumes — secondary URLs within a group are neither
scored nor displayed, so classifying them buys nothing in v1. For each
pattern, the agent reads the code behind it (router config,
manifest/descriptor for embedded apps, the component) and writes one
row: `pattern, name, purpose, tier` into a new `route_map` table.
Patterns the agent cannot ground still get a row (tier `standard`,
weight-neutral, marked unresolved) so enqueueing converges. Humans can
edit rows and edits win (`source='human'` is never overwritten); in v1
"editing" is a concierge-level direct DB update — a settings UI is
deferred.

Evidence for this shape (spike, 2026-08-07, on documenso/dub/formbricks +
AMFJ for real): classification accuracy ~90–95% when the job reads the
code behind each URL; the failure modes are all in *enumerating* route
trees (middleware-only routes, redirect stubs, hostname folders,
non-standard router conventions) — which observed-URL classification
sidesteps entirely. Cost: a handful of LLM calls per repo per run.

The route-map job is a **separate increment from the score job** (see
Separability above): its own PR, its own migration for `route_map`, and
the score job never depends on it existing. It only ever receives
templated patterns (`/sign/:token`), never raw observed paths.

Pre-repo-connect, priority runs as reach × cap with the scrubbed,
templated page path shown unclassified; the route layer activating is
part of the repo-connect value story.

## Surfaces

- **Dashboard**: the server feed orders by `COALESCE(priority_score, 0)
  DESC, last_seen DESC` — priority is THE feed order. Because the server
  returns only the top 100, client-side re-sorts can only reorder those
  loaded rows; the existing sort controls stay but are labeled "loaded
  issues only" rather than pretending to be global. Passing sort to the
  server is a deliberate non-goal for this issue. Each row shows the
  route name (or bare path pre-classification) and a plain-language
  reason built from stored ingredients: "Checkout — 14 known users + 6
  anonymous sessions this week", plus the identify hint and (for capped
  issues) the remediation line.
- **Digest (plan #4)**: consumes the same stored fields; this design
  guarantees field + wording exist, the digest remains its own scope item.
- Friction signals sharing a session with an error never move the score
  in v1; displaying them as row context needs a session join the API does
  not expose today, so that display is deferred with the other
  improve-over-time items.

## One-time cleanup (operational runbook, not feature scope)

Legacy groups whose error class is now suppressed at ingest (e.g. the
prod `ResizeObserver loop` group: 5,796 occurrences, 139 users/7d — new
events of that class are deleted before grouping, but the old group
still tops any impact ranking) need archiving. This is a **separate
operational procedure with a dry-run first** (list what would be
archived, review, then archive), documented as a runbook — it touches
retained production data and is not part of the reusable feature
design. Prerequisite check before running it: verify new events cannot
silently resurrect an archived group; if regression logic reopens them,
add an explicit muted/expected marker first.

## Install-time requirement

`identify()` wiring — on every bundle, not just the main SPA — becomes an
explicit install/concierge checklist step, since reach quality depends on
it. The per-surface missing-identify flag is the runtime backstop.

## Testing

- Score job: seeded-fixture SQL tests asserting order (recent reach
  beats older reach; customer-facing beats admin; capped sinks; a
  monotonicity case — adding an identified user to a group never lowers
  its rank; anonymous-heavy groups rank and carry the identify hint;
  friction groups receive scores from friction reach).
- Storage: `priority_scored_at` set on every write; unscored new group
  orders inside the zero cohort via COALESCE, not below it.
- Normalization: unit tests for the four rules against real observed URL
  shapes (AMFJ fixtures: api-host, `#!`, Forge CDN, numeric ids, opaque
  token segments → `:token`).
- Route-map job (its own increment): measurable contract against
  `test-fixtures/vue-app` — given the fixture's observed-URL list, the
  job returns one row per URL pattern where every tier is in the enum,
  every pattern actually matches its source URL, and every row has a
  non-empty name and reason; assertions are exact on the fixture's known
  routes, not "sane".
- Live smoke per repo gate: seed events → run score job → dashboard API
  returns priority order.

## Validation already done (2026-08-07)

- Formula executed read-only against prod: correctly sank smoke-test and
  0-user noise, surfaced the 10-user stale-deploy issue; exposed the
  ResizeObserver legacy ghost (→ cleanup runbook) and the portal-panel
  zero-score blind spot (→ additive anonymous-session reach + identify
  hint). A Codex review (2026-08-07) then hardened the spec: additive
  monotonic reach replacing the fallback, "recency boost" naming,
  project-wide score semantics, friction-group scoring, feed-order
  sorting decision, scored_at + typed inputs + COALESCE, path-token
  templating as a privacy boundary, and the score/route-map
  separability constraint.
- Route-map job executed for real on AMFJ (`conelike/asset-management-jira`):
  produced a correct, code-grounded map (portal panel = customer-facing,
  confirmed via the manifest's JSM portal-panel declaration + Connect
  descriptor), plus the normalization rules above.

## Deferred (improve over time)

**First increment (v1.1): the heavily-used ×1.5 boost** — build the
page→distinct-sessions rollup from replay navigation data and multiply
it into context. This replaces LLM judgment of "core workflow" with
observed usage and is the piece competitors structurally lack. Nothing
is pre-built for it in v1 code or schema.

Then: spike-vs-baseline detection; deploy-correlation ("expected during
deploys"); rage-click score boost; important-routes config UI;
reason-code split into human-actionable vs nobody-can-act; route-map
refresh on release changes; Stripe/revenue weighting (plan #15);
per-page attribution inside Forge global-page (needs SDK route
breadcrumb).
