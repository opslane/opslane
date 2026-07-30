<!-- /autoplan restore points: ~/.gstack/projects/opslane-opslane-oss/abhishekray07-s1-*-autoplan-restore-*.md -->

# S1: separate public ingest and secret source-map keys

**Issue:** [#217](https://github.com/opslane/opslane-oss/issues/217) · **Blocked by:** #216 (S0 contracts, `0c0dcfe`)
**Contracts:** [S0 appendix](../design/2026-07-29-keys-sourcemaps-s0-contracts.md) · [parent design](../design/2026-07-29-keys-sourcemaps-onboarding.md)

## What this changes, in one paragraph

Today one key does three jobs. The key that ships inside a customer's browser bundle also
uploads source maps and reads their incident list. This slice splits it into a public key
that can only send telemetry and a secret key that can only upload source maps, and moves
incident reads behind a user session. The permission lives in the database, not in which
middleware someone remembered to attach.

Scope is deliberately small. The one flow that has to keep working is
`opslane onboard` → key minted → SDK sends errors → alert → fix PR. Everything not on
that path or not required to close the security hole is a later slice.

## Why now

On `main`:

- `handler/routes.go:92` lets the browser key upload source maps. Anyone who opens devtools
  can upload a poisoned map that misleads the fix agent.
- `handler/routes.go:128,134,135` let the same key read `/event-count`, `/incidents`, and
  `/incidents/{id}` through `AuthenticateSessionOrSDK` (`handler/auth.go:217`).
- `handler/routes.go:258` puts the source-map route in the permissive-CORS list, so a
  browser page can drive it cross-origin.
- The published Vite plugin posts the ingest key to that route
  (`packages/sdk/vite-plugin/index.ts:81`).

## No migration

Only one app uses this, and its SDK comes out until a new version publishes. So the
database is recreated rather than migrated. `028` is an ordinary append-only file per
`AGENTS.md`; it simply has no careful parts. No compatibility path, no backfill, no
rollback story, no `def_` fallback. Old keys stop working, which is the intended outcome.

Detection, if some app is still holding one: `opslane_key_auth_total{outcome="unknown_key_id"}`
climbs. The SDK treats a 401 like a network failure and retries forever with backoff
(`packages/sdk/src/transport.ts:128`, capped at 30s, queue of 100), so the server sees a
steady stream of 401s. That metric is the whole detection story.

## The work

### 1. Schema (`db/migrations/028_project_api_keys.sql`)

```sql
CREATE TABLE project_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id TEXT NOT NULL UNIQUE CHECK (key_id ~ '^[a-z2-7]{26}$'),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('ingest', 'sourcemaps')),
  token_prefix TEXT NOT NULL CHECK (
    (scope = 'ingest'     AND token_prefix = 'opslane_pk') OR
    (scope = 'sourcemaps' AND token_prefix = 'opslane_sk')),
  secret_hash TEXT NOT NULL UNIQUE CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  label TEXT NOT NULL CHECK (label = btrim(label) AND char_length(label) BETWEEN 1 AND 100),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK (revoked_at IS NOT NULL OR revoked_by_user_id IS NULL)
);

CREATE INDEX idx_project_api_keys_project_created
  ON project_api_keys(project_id, created_at DESC, id DESC);
CREATE INDEX idx_project_api_keys_project_active_scope
  ON project_api_keys(project_id, scope) WHERE revoked_at IS NULL;

DROP TABLE environment_api_keys;

-- Labels are honoured instead of ignored. One word, no code cleanup.
ALTER TABLE projects ALTER COLUMN allow_payload_environment SET DEFAULT true;
UPDATE projects SET allow_payload_environment = true;
```

`allow_payload_environment` and `provisioning_key_id` are **not dropped**. Both are still
projected and written on the onboarding path (`db/queries.go:151,203,209,265,2912`), so
dropping them would 500 `opslane onboard` immediately. Flipping the default is one line and
gets the behaviour you want: an `environment` label in the SDK is honoured, and no label
means `production`. Removing the columns is cleanup for a later slice.

There is no environment backfill. The database is fresh, and the onboarding path already
creates `production` inside its transaction (`db/queries.go:226`).

Dropped from the S0 schema because nothing reads them in v1: `last_used_at`,
`last_rejected_at`, `last_rejected_reason`. They arrive with the settings card in S5.

**No environment schema change.** No `default_environment_id`, no composite foreign key, no
`error_events.submitted_environment`. That column would have shipped write-once and
read-only, permanently equal to the project's `production` row.

### 2. Keys (`db/project_keys.go`, new)

Format per S0 §3.1: `opslane_pk_<key_id>_<secret>` and `opslane_sk_<key_id>_<secret>`.
`key_id` is 128 random bits as 26 lowercase base32 characters, stored in plaintext.
`secret` is 256 random bits as 43 base64url characters; only its SHA-256 is stored.

Parsing is `strings.SplitN(raw, "_", 4)` where **part four is the entire remainder**.
base64url's alphabet contains `_`, so about 49% of secrets contain at least one
(`1 - (63/64)^43`). A strict four-way split would reject roughly half of all minted keys,
non-deterministically, and pass any test whose fixture happened to be clean. Test vector
required: a secret containing `_`.

Lookup order: parse, load the one row by `key_id`, check the stored `scope` matches the
prefix, then `subtle.ConstantTimeCompare` the hash. Malformed, unknown, wrong secret, and
revoked all return `401 invalid_api_key` with no project attribution. A database error
returns **500, never 401** — `db/queries.go:349` wraps every error identically, so no-rows
must be told apart with `errors.Is(err, pgx.ErrNoRows)`. Copying today's
`handler/auth.go:198-202`, which funnels everything to 401, would turn a database blip into
a fleet-wide "your key is invalid".

### 3. Middleware (`handler/project_keys.go`, new)

Two constructors, primitives unexported:

```go
d.ProjectKey("ingest")       // /events, /replays/*, /sessions/*, /ingest/ping
```

One constructor, because `ingest` is the only scope any route accepts in v1. `sourcemaps`
exists as a value in the CHECK constraint so S2 has somewhere to land, but nothing mints
one and no route takes one. One pass, so there is no way to attach authentication without a
scope check. A valid key on the wrong route family gets `403 insufficient_scope`.

**The lookup must return `allowed_origins`.** Today `LookupAPIKey` selects it
(`db/queries.go:342`), `AuthenticateSDK` puts it in context (`handler/auth.go:208`), and
`EnforceOrigin` reads it (`handler/ingest_limits.go:88`). An empty list means allow every
origin (`handler/auth.go:65-68`). Omit it from the new query and origin checking silently
turns off for every project. Join `projects` for that one column, or denormalise it later.

Environment comes from the project, not the key: resolve `production` by name through the
existing bounded cache at `handler/env_resolver.go:41`, which the payload-label path already
calls. Same function, constant second argument, no new steady-state query. A payload
`environment` label that matches a pre-created row still wins; the `allow_payload_environment`
gate at `env_resolver.go:110` is removed, so labels are honored rather than ignored.

### 4. Routes (`handler/routes.go`, `handler/auth.go`)

| Route | Change |
|---|---|
| `POST /events`, `/replays/*`, `/sessions/*` | `ProjectKey("ingest")` |
| `POST /api/v1/ingest/ping` | new. `ProjectKey("ingest")`, `204`, empty body |
| `POST /api/v1/sourcemaps` | removed, returns 404 |
| `GET /projects/{id}/event-count`, `/incidents`, `/incidents/{id}` | `AuthenticateUserSession` |
| `POST /environments/{envID}/api-keys` | removed |
| `GET /projects/{id}/api-keys` | removed |

Both key-management routes go. `opslane onboard` is the only thing that mints a key in v1,
and the list route queries the table being dropped. Removing them also closes a hole the
replacement would have opened: `RequireRoleIfCloud("admin")` checks your role in the active
org, not whether the project in the URL belongs to it, so a create endpoint would need its
own tenant check (the existing handler does one at `handler/read_api.go:812`). No endpoint,
no check to forget.

`AuthenticateSessionOrSDK` is deleted. `isSDKEndpoint` (`routes.go:254`) drops
`/api/v1/sourcemaps` and gets a boundary check, `path == p || strings.HasPrefix(path, p+"/")`,
so `/api/v1/eventsX` no longer receives permissive CORS. `/ingest/ping` does **not** join
that list; permissive CORS would make a credential probe browser-readable.

After this, the key branch of `checkProjectAccess` (`handler/read_api.go:191-196`) is
unreachable, since every caller is session-only and ingest routes read `ProjectIDFromCtx`
directly. Delete it; the function then does one thing.

### 5. Mint sites (`db/queries.go`, `handler/onboarding.go`, `db/agent_provision.go`)

- `CreateAPIKey` / `CreateAPIKeyTx` become `CreateProjectKey(projectID, scope, label, userID)`.
- **Delete the reprovision revoke.** `db/queries.go:242-257` revokes
  `projects.provisioning_key_id` on every re-provision, and
  `db/project_provisioning_test.go:66` asserts exactly one active key afterwards. It also
  queries `environment_api_keys`, which this migration drops, so it has to go regardless.
  Re-running `opslane onboard` today silently kills the key sitting in a deployed bundle.
  Invert the test.
- No change to `CreateProject` (`db/queries.go:146`). It has no production caller:
  `CreateProjectEndpoint` (`handler/read_api.go:581`) calls `ProvisionProject`, which
  creates `production` in its transaction at `db/queries.go:226`.

**Re-onboarding mints a new key and leaves the old one active.** An earlier draft said it
would reuse the stored credential after a ping. That is not buildable as a side effect of
deleting the revoke: the CLI never loads saved credentials before provisioning
(`cli/src/onboard/provision.ts:145,204`), and the server always mints
(`handler/onboard_provision.go:75,92`) because only the hash is stored, so it cannot hand
back a key it already issued. Reuse is its own piece of work.

Accepted for v1: a rerun writes a fresh working key to `.env.local` and the previous one
keeps working. With one app that is a few extra rows. Revoke with `psql` if it matters.

### 6. Redaction (`masking/masking.go:44`)

`(?i)(sk_live_|sk_test_|AKIA|ghp_|gho_|def_)[A-Za-z0-9]+` matches neither new prefix, and
its character class stops at `_` so it cannot span `opslane_pk_<key_id>_<secret>`. Add
`opslane_(pk|sk)_` and widen to `[A-Za-z0-9_-]+`. This also fixes a live bug: `def_` keys
are `def_<uuid>` (`db/queries.go:315`) and the current class stops at the first `-`, leaving
most of every legacy key in cleartext today.

### 7. SDK guard (`packages/sdk/src/config.ts`)

`init()` rejects any `apiKey` not prefixed `opslane_pk_`. The CLI env writer
(`cli/src/init.ts:195`) does the same before writing `VITE_OPSLANE_API_KEY`.

One wrinkle: `init()` catches everything `loadConfig` throws and returns silently unless
`debug` is set (`packages/sdk/src/index.ts:24-30`). That fails closed, which is right, but
the developer sees nothing. This one case logs unconditionally, because pasting a secret
key into a browser bundle is a mistake worth a console line even in production.

Ten lines each, and they are the difference between this slice closing a hole and opening
one. S1 introduces two credentials differing in eleven characters out of eighty-one, and
nothing today checks which one you pasted into your bundle.

### 8. One metric (`handler/metrics.go`)

`opslane_key_auth_total{outcome}` with `outcome` in ok, invalid_key, wrong_scope. It does
not exist yet, and it is the only way to tell whether an app is still holding a dead key.
Roughly ten lines beside the counters already there.

### 9. CLI (`cli/src/{errors,verify,doctor}.ts`)

`opslane onboard` is untouched. It already holds a refreshable session
(`cli/src/onboard/provision.ts:79`) and only calls `/api/v1/onboard/provision` with a Bearer
token and `/api/v1/agent/poll/{id}` with the poll token. Neither route changes.

The three read commands move to that same session, through `ensureLoggedIn` rather than a
bare token read, so expiry is handled. `doctor`'s "API key is valid" check becomes two
named checks: one for the session, one that pings `/api/v1/ingest/ping` with the stored
ingest key. A session cannot prove anything about the key baked into the app, and today
`doctor` claims it can.

### 10. Vite plugin (`packages/sdk/vite-plugin/index.ts`)

It posts to the route this slice deletes. Make it throw a build error naming S2, and say so
in `docs/guides/source-maps.md` and `packages/sdk/README.md`. "SDK unchanged" was false.

## Not in v1

Each of these is real work that is simply not on the onboard-to-events path:

- `opslane keys list|create|revoke`, and the `POST`/`GET /projects/{id}/api-keys` routes.
  Onboarding is the only way to mint a key in v1. Use `psql` if one leaks.
- Reuse-on-rerun instead of minting a second key.
- Dropping `allow_payload_environment` and `provisioning_key_id`, and the query cleanup
  that would require.
- The three source-map batch routes, including `501` placeholders. The `sourcemaps` scope
  exists in the schema so S2 has somewhere to land; nothing accepts it yet.
- `last_used_at` and `last_rejected_at` tracking, cursor pagination, key rename. All arrive
  with the settings card in #230 and #231.
- Dashboard work. The API Keys tab will show blank columns and an empty state after the
  response shape changes. Cosmetic, off the flow, and it goes with #230.
- `default_environment_id` and an operator-selectable default environment.
- Everything in S2 onward: debug IDs, batch upload, symbolication, banners.

## Tests

- **Key parsing.** Vectors from S0 §3.1, including a secret containing `_`. This one test
  catches the highest-severity bug in the slice.
- **Route matrix.** The ~12 credential-bearing routes crossed with {no credential, valid pk,
  revoked pk, malformed, wrong-project pk, session}, asserting exact status and `code`.
  Default expectation is DENY; a route opts in. Plus a structural assertion over
  `chi.Walk`, which does receive middleware in the pinned `chi/v5 v5.3.1`
  (`tree.go:839,872-875`), so every `/api/v1` route can be checked for an authenticator by
  comparing `reflect.ValueOf(mw).Pointer()`.
- **Reprovision.** Onboard twice, assert both keys still authenticate.
- **Redaction.** A vector proving both new prefixes are masked, including the `_` inside.
- **Database down.** Close the pool, assert `POST /events` returns 500 and not 401.

## Done when

Three checks, by hand, in about ten minutes:

1. `opslane onboard` in a clean checkout of `test-fixtures/react-app`. `.env.local` matches
   `^opslane_pk_[a-z2-7]{26}_[A-Za-z0-9_-]{43}$`. Trigger the fixture error, see the row in
   `error_events` under the right project and environment.
2. With that key: `POST /api/v1/events` → 200. `GET /projects/{id}/incidents` → **401**,
   not 403: the read routes are session-only, and session auth reads a cookie or Bearer
   token (`handler/auth.go:242`), so an `X-API-Key` header is simply absent credentials.
   `POST /api/v1/sourcemaps` → 404. Then the session from that onboard reads incidents → 200.
3. Re-run `opslane onboard` on the same repo. The key from step 1 still returns 200 on
   `POST /events`, and so does the new one.

Step 1 proves errors arrive. It does not prove the alert and fix-PR tail, which is existing
behaviour this slice does not touch.

CI covers the rest: `go build ./... && go test ./...`, `pnpm -r build`, `pnpm test`.

## Effort

About a day of CC time. The first reviewed version of this plan was roughly 52 hours of
human work across 15 tasks; this is the credential slice only.

---

*The full four-phase review that produced this scope, including eight independent reviewer
passes and the findings that changed it, is retained below.*

---

# Review — Phase 1: CEO (strategy and scope)

Mode: **SELECTIVE EXPANSION** (feature enhancement on an existing system, /autoplan default).

## System audit

Base branch `main`. Branch is clean, no stash. `TODOS.md` has 12 open items; none
overlaps S1 (the closest, "Decide the fate of ReplayInit and the legacy
`/api/v1/replays` route", touches a route S1 re-authenticates but does not remove).
Hot files over the last 30 days include `db/queries.go` (25 commits),
`handler/routes.go` (19), and `docs/reference/http-routes.md` (16) — all three are in
S1's blast radius, so this is a high-churn area where a stale doc is likely.

Retrospective: `handler/routes.go` and `db/queries.go` are the two most-edited files in
the repo this month. That is an architectural smell in itself — route wiring and a
3,400-line query file are both change magnets. S1 makes both worse unless the key code
lands in its own file.

## 0A. Premise challenge

| # | Premise the plan rests on | Verdict |
|---|---|---|
| P1 | Usage is internal-only, so a hard cut on `def_*` keys costs nothing | **Assumed, not established.** "Internal-only" names the users; it does not establish that dropped events, rebuilt bundles, and re-run onboarding are acceptable. Nothing in the repo inventories live `def_*` deployments. |
| P2 | S1 is worth landing on its own | **Half true.** It removes a real read/upload capability from a public key, which is security value. But it removes the only source-map route while adding none, so an `sk` minted in S1 cannot be presented anywhere until S2. |
| P3 | Deleting `AuthenticateSessionOrSDK` and converting the CLI is mechanical | **Wrong.** Repo credentials are project-scoped (`cli/src/agent-credentials.ts:10`); sessions are active-org-scoped. `setup` and `doctor` currently use `/event-count` to prove the *ingest key* works. A session check cannot prove that. The commands change meaning, not just headers. |
| P4 | The four named mint sites are the whole surface | **Wrong.** See 0B. |
| P5 | Requirement R3 is verifiable inside S1 | **Wrong.** R3 says a secret key can use only the source-map upload routes. S1 removes `POST /api/v1/sourcemaps` and S2 adds the batch routes, so S1 as written registers zero routes that accept an `sk`. The plan's own smoke step ("pk gets 403 on a sourcemap route") cannot run. |

What happens if we do nothing: the key in every customer bundle keeps read access to
incidents and write access to source maps. That is a real, currently-live hole
(`handler/routes.go:92,128,134,135`), not a hypothetical. The problem is right; the
slice boundary is what needs argument.

## 0B. Existing code leverage — and what the plan missed

The design names four mint sites. Reading the code found three more touchpoints, one of
which directly contradicts a stated requirement:

1. **`db/queries.go:242-257` revokes the previous provisioning key every time onboarding
   re-provisions a project.** `projects.provisioning_key_id` (added in
   `018_environments_first_class.sql:68`) points at the current key, and re-provisioning
   sets `revoked_at = now()` on it. `db/project_provisioning_test.go:66` asserts
   `active_keys == 1` afterwards — the revoke is deliberate, tested behavior.
   This is a direct violation of issue R5 and of S0 §3.2 ("Creating a key never changes
   another key"). S1 must delete this revoke, repoint or drop `provisioning_key_id`, and
   invert that test.
2. **`masking/masking.go:44`** redacts `def_` in logs via `apiKeyPrefixRe`. Neither
   `opslane_pk_` nor `opslane_sk_` matches it. Ship S1 without editing this line and
   every new secret is log-visible — the exact custody rule S0 §1 freezes.
3. **`handler/read_api.go:806` rate-limits key creation by client IP** (`apiKeyLimiter`).
   S0 §3.4 specifies 10/min **per user/project**. Different key, different limiter.

Also reusable and not yet named in the plan: `verifyProjectAccess`
(`handler/read_api.go`) already gives the key CRUD routes their tenant check, and
`ingest_limits.go`'s `sourcemapsLimiter` becomes dead code the moment
`/api/v1/sourcemaps` is removed.

## 0C. Dream state

```
CURRENT STATE                    THIS PLAN                       12-MONTH IDEAL
one def_ key per environment     two project-scoped key types,   one credential model
  authenticates ingest,   --->     scope enforced by one    ---> across ingest, maps,
  map upload, and three            middleware; env demoted        and org-level CI, with
  customer-data reads              to an event label              per-key audit + UI
env owned by the key             env owned by the project        env trustworthy or gone
CLI reads with the browser key   CLI reads with a session        CLI has a real identity
```

Delta: S1 gets the credential model right and the environment model honest. It does not
get the CI ergonomics right (one secret per project, no org-scoped token) and does not
give anyone a UI (#230). Both are named follow-ons, not regressions.

## 0C-bis. Implementation alternatives

```
APPROACH A: Hard cut, as written
  Summary: new table, new middleware, def_ keys stop authenticating, old route 404s.
  Effort:  M (human ~3d / CC ~2h)   Risk: High (rollout), Low (code)
  Pros:    one lookup path; matches AGENTS.md "no legacy shims by default"; smallest
           long-term surface; the frozen S0 contract needs no amendment.
  Cons:    every deployed bundle using a def_ key stops reporting at deploy time; the
           blast radius is unmeasured; rollback of the binary does not un-drop events.
  Reuses:  hashKey, EnforceOrigin, rateLimitByProject, verifyProjectAccess.

APPROACH B: Hard cut + time-boxed legacy ingest-only path
  Summary: A, plus LookupProjectKey falls back to hashing a presented def_ credential
           against environment_api_keys and granting it the fixed ingest scope only.
           Counter metric per legacy auth; removal in a named follow-up issue.
  Effort:  M+ (human ~3.5d / CC ~2.5h)   Risk: Low (rollout), Low-Med (code)
  Pros:    closes the dangerous read/upload permissions immediately, which is the whole
           security point, with zero ingest downtime; the metric tells you when the
           legacy path is actually dead instead of assuming it.
  Cons:    a second lookup path — precisely the risk the issue's own table names — and
           it must be deleted later or it becomes permanent.
  Reuses:  everything in A plus the existing environment_api_keys lookup query.

APPROACH C: Split S1 into S1a (keys + scope) and S1b (environment demotion)
  Summary: S1a ships the credential model and route matrix. S1b ships
           default_environment_id, submitted_environment, and the removal of
           allow_payload_environment.
  Effort:  M (same total, two PRs)   Risk: Low
  Pros:    a security migration stays a security migration; each half is independently
           revertible; the environment change gets its own attribution testing.
  Cons:    S1a leaves ctxEnvironmentID sourced from a table the key no longer owns, so
           the two halves are not cleanly separable — the key stops carrying an
           environment the moment the new lookup lands.
  Reuses:  same as A.
```

**Recommendation: B for the migration, and reject C.** B costs one bounded function and
buys the difference between "we think nothing broke" and "the counter is zero." C is
attractive but the coupling is real: once `LookupProjectKey` replaces `LookupAPIKey`,
there is no environment on the credential, so *something* has to supply one in the same
change. The separable half of C is `allow_payload_environment` removal, which is a
behavior change to existing projects and is genuinely independent.

## 0D. Selective-expansion scan and complexity check

Complexity check: S1 touches roughly 20 files across Go, TypeScript, Vue, SQL, and docs.
That is over the 8-file smell threshold. It is not reducible — the route matrix, the mint
sites, the CLI, and the dashboard all read the same credential — but it does mean the
change must land with the router-walking matrix test, or reviewers cannot hold it in
their heads.

Expansion candidates surfaced (auto-decided per /autoplan's six principles, all logged
in the audit trail below):

| # | Candidate | Decision | Principle |
|---|---|---|---|
| E1 | Register the three S2 batch route paths in S1 behind `RequireKeyScope("sourcemaps")` returning `501 not_implemented`, so R3 and the pk-403 case are provable in S1 | **Accept** | P1 completeness — R3 is unverifiable otherwise |
| E2 | Bounded legacy `def_` ingest path with a counter (Approach B) | **Surface as premise** | User's call, not ours |
| E3 | Auth-outcome metrics: `opslane_key_auth_total{scope,outcome}` alongside the existing counters in `handler/metrics.go` | **Accept** | P2 blast radius, <1 day, no new infra |
| E4 | Move key code out of `db/queries.go` into `db/project_keys.go` and out of `read_api.go` into `handler/project_keys.go` | **Accept** | P5 explicit — both files are the repo's top churn magnets |
| E5 | Update `docs/reference/http-routes.md` and `docs/architecture/trust.md:75` in the same PR | **Accept** | P2 blast radius; the docs-sync bot will otherwise rewrite them later and cancel CI |
| E6 | Org-scoped `opslane_ci_` token for monorepos | **Defer to TODOS.md** | P3 — S0 §5.1 already designs it as a later addition |
| E7 | Settings UI for key management | **Skip** | Already #230 |
| E8 | Per-key rate limits (distinct from per-project) | **Defer to TODOS.md** | Not needed until multiple keys exist in the wild |

## 0E. Temporal interrogation

- **Hour 1 (foundations):** does `LookupProjectKey` live in `db/queries.go` or its own
  file? Decided: own file (E4). Does the migration backfill `default_environment_id`
  before or after adding the FK? Decided: add column, backfill, then add the deferrable
  constraint, so an existing project with no `production` row does not fail the migration.
- **Hour 2-3 (core logic):** what does a valid `sk` presented to `/events` return —
  401 or 403? S0 §1 says `403 insufficient_scope` for a valid key on the wrong route
  family, `401 invalid_api_key` for malformed/unknown/revoked. The implementer will
  otherwise guess. Second ambiguity: does a *revoked* key that would also have been
  wrong-scope return 401 or 403? Decide 401 — revocation is checked first, since a
  revoked credential is not a credential.
- **Hour 4-5 (integration):** the CLI. `errors`, `verify`, `setup`, `doctor` all need a
  session, and `~/.opslane/credentials.json` has no session in it. Does `opslane errors`
  now require `opslane login`? That is a UX decision, not a header swap.
- **Hour 6+ (polish/tests):** the route matrix test needs a way to walk chi's registered
  routes (`chi.Walk`) and to know each route's expected principal. That table is the
  deliverable, not a by-product.

## CODEX SAYS (CEO — strategy challenge)

Verdict: do not approve S1 as an independently deployable milestone. Six findings:

1. **The hard cut is an operational gamble disguised as technical necessity.** "Cannot
   reissue the raw key" does not mean "cannot continue authenticating it." A bounded
   compatibility branch can hash a presented `def_` credential, resolve its project, and
   grant the fixed `ingest` scope — closing the dangerous permissions without preserving
   the old authorization model. Re-running onboarding mints a credential; it does not
   redeploy already-built browser bundles, CI variables, `.env.local` files, or
   self-hosted installs. A hard cut is defensible only after an inventory of active
   `def_` deployments, replacement keys installed everywhere, a cutover window, and an
   observed period with zero legacy auth attempts.
2. **S1 is a bridge to nowhere if deployed separately.** It creates `sourcemaps` keys
   while excluding every route that can use them and removing the only existing upload
   route. The plan's own smoke test requires a pk to get 403 "on a sourcemap route" —
   no such route is registered. Treat S1 as a non-deployed internal migration behind
   rollout controls, or as part of an atomic release with the smallest functional S2
   upload path. Do not market or measure it as a product milestone.
3. **Deleting `AuthenticateSessionOrSDK` is correctly inside the security boundary; the
   CLI work is not a mechanical consequence.** The plan says "four call sites" but names
   five HTTP calls across four files. Session authorization is active-org scoped while
   repo credentials name a project; `cli/src/auth.ts:93` rejects expired access tokens
   and the reader commands have no refresh flow. The substitution destroys command
   semantics: `verify` and `doctor` claim to validate the ingest key and would instead
   validate a session; `setup` would declare a revoked ingest key "already configured."
4. **S1 combines too many independently risky migrations** — credential format,
   authorization policy, environment ownership, project-creation transactions, payload
   override behavior, key CRUD, CORS classification, 404 behavior, dashboard responses,
   and CLI identity. Rollback becomes asymmetric: restoring credential acceptance also
   restores different environment attribution.
5. **Investment is inverted toward infrastructure elegance.** Cursor pagination, renames,
   rejection timestamps, and write coalescing all land before a source-map key can upload
   anything, while the product's actual failure is scrambled stack traces.
6. **The security narrative is incomplete for external customers.** Separate keys close
   one poisoning route; the public key still lets an attacker submit event text that
   reaches the fix agent alongside private source content. S1 does not unlock external
   launch.

## CLAUDE SUBAGENT (CEO — strategic independence)

Twelve findings, all code-verified. The four that neither the plan nor Codex had:

- **F4 CRITICAL — S1 deletes the only in-product way to mint a key.**
  `dashboard/src/api.ts:461` → `POST /environments/{envId}/api-keys`, called from
  `Settings.vue:501`, is the create path. Removing the route while deferring the UI to
  #230 means every key dies and the button to make a replacement is gone. Recovery is
  hand-rolled curl.
- **F5 HIGH — "CLI reads move to existing session tokens" is false for the flow that
  matters.** `AgentCredentials` (`agent-credentials.ts:7-13`) holds no session token; those
  live in a separate file written only by `opslane login` (`auth.ts:69,93`). An agent that
  ran `opslane setup` has never logged in, and `setup.ts:266` already proves the
  consequence. After S1 `opslane errors` 401s for exactly the user the onboarding design
  targets, remediable only by a browser flow a coding agent cannot complete.
- **F9 MEDIUM — the onboarding self-test error starts landing in production.**
  `db/agent_provision.go:257` mints against the *development* environment. Project-scoped
  keys plus a `production` default put the deliberate test error in the customer's
  production issue list on first run.
- **F10 MEDIUM — the route-matrix test is oversold.** `chi.Walk` yields method and pattern;
  it cannot introspect middleware identity. The guard has to be DENY-by-default plus exact
  route-set equality.

Also raised and folded in: F1 (self-hosters make "internal-only" unverifiable — `@opslane/sdk`
is public on npm, the repo ships a working Compose file), F2 (time-boxed fallback is ~15
lines and was dismissed in one sentence without pricing), F3 (S1 delivers zero
customer-visible value and should say so), F6 (environment segmentation collapses;
`test-e2e/environments.test.ts:42,107-131` asserts the old semantics), F7
(`docs/contracts/events.md:51-60` invalidated), F8 (masking regex), F11 (S0 froze more
lifecycle surface than an internal deployment needs — time-box it, do not let cursor
pagination be why S2 slips), F12 (`submitted_environment` has no reader yet).

One thing the plan gets right and should state: deleting `POST /api/v1/sourcemaps` before
S2 costs nothing, because the path is already inert.

Regret ranking: (1) a self-hoster upgraded, events stopped, nobody noticed — "our
error-monitoring product silently stopped monitoring, and we had decided in advance not to
check"; (2) "why is staging in my production list?"; (3) the agent-first CLI needs a
browser login it cannot perform; (4) the frozen 1,500-line S0 appendix as sunk cost.
Not a regret: the key format itself.

## CEO dual voices — consensus table

```
═══════════════════════════════════════════════════════════════════════════
  Dimension                              Claude    Codex     Consensus
  ──────────────────────────────────────  ────────  ────────  ─────────────
  1. Premises valid?                      CONCERN   CONCERN   CONFIRMED ✗
  2. Right problem to solve?              PASS*     PASS*     CONFIRMED ✓
  3. Scope calibration correct?           CONCERN   CONCERN   CONFIRMED ✗
  4. Alternatives sufficiently explored?  CONCERN   CONCERN   CONFIRMED ✗
  5. Competitive/market risks covered?    CONCERN   CONCERN   CONFIRMED ✗
  6. 6-month trajectory sound?            CONCERN   CONCERN   CONFIRMED ✗
═══════════════════════════════════════════════════════════════════════════
  6/6 dimensions agreed. 0 disagreements. * = right problem, wrong framing:
  both say S1 is an enabling migration, not a customer-value milestone.
```

Both models independently reached the same four conclusions: the hard cut was wrong, S1 is
a bridge rather than a milestone, the CLI change is a design problem rather than a header
swap, and the plan bundles a domain-semantics migration into a security migration. All
four are now addressed in the plan above. **Zero cross-model disagreements**, so no taste
decisions arise from Phase 1.

## Sections 1-10 (CEO deep review)

**S1 Architecture.**

```
                       ┌──────────────────────────────────────────┐
   browser bundle ─────► AuthenticateProjectKey  (one lookup)      │
   opslane_pk_...      │   parse prefix → key_id → row → scope     │
                       │   constant-time compare                   │
   CI (S2)     ────────►   legacy fallback: def_ → scope=ingest    │
   opslane_sk_...      └───────────────┬──────────────────────────┘
                                       │ ctxProjectID, ctxOrgID, ctxKeyScope
   CLI ───session──────►               ▼
   (session)           ┌──────────────────────────────────────────┐
                       │ RequireKeyScope(ingest|sourcemaps|read)   │
                       └──┬───────────┬──────────────┬────────────┘
   dashboard ──session───►│           │              │
                          ▼           ▼              ▼
                     /events      /sourcemaps/*   /incidents
                     /replays/*    (501 stubs)    /event-count
                     /sessions/*                       ▲
                     /ingest/ping                      │
                                                  session ────┘
```

Coupling: `RequireKeyScope` is new coupling between routing and the key table, and it is
the point of the change. The coupling that *goes away* is key → environment. Net
simplification. New single point of failure: every ingest request now reads
`projects.default_environment_id`; cache it on the existing environment resolver rather
than adding a query to the hot path. Scaling: unchanged at 10x; at 100x the
`last_used_at` coalescing map is per-replica and unbounded in key count — bound it with the
same LRU pattern as `environmentResolver`. Rollback: `git revert` plus binary rollback works
because the migration is additive and `environment_api_keys` survives; the one-way part is
any `opslane_*` key minted before the revert, which is why the legacy path matters.

**S2 Error and rescue map.** See the registry below. Two GAPs found, both closed in §4.7
and §5.

**S3 Security.** Attack surface *shrinks*: the public key loses read and upload rights. New
surface is the four key-lifecycle routes (session + org-admin + `verifyProjectAccess`, all
existing patterns) and `POST /ingest/ping`. Ping is the only genuinely new public-key
route; it returns an empty 204 with no project name and no counts, so it discloses only
"this key authenticates", which the key holder already knows. Threat: ping becomes an
oracle for brute-forcing key_ids — mitigated because a 128-bit key_id plus a 256-bit secret
is not brute-forceable and the route inherits per-project rate limiting. Highest-impact
finding is the masking regex (§4.7): High likelihood, High impact, now mitigated.

**S4 Data flow and edge cases.** Shadow paths for the auth flow: nil credential → 401 with
no DB read; empty string → same; malformed shape → 401 before any query, so an attacker
cannot use timing to learn whether a key_id exists; upstream DB error → 500, never 401,
because a transient blip must not look like a bad key (same reasoning as
`RequireAdmin`'s deliberate 500-not-404 at `handler/auth.go:175`). Concurrency: two
replicas both coalescing `last_used_at` may both write within the same five minutes — that
is a wasted write, not a correctness problem.

**S5 Code quality.** `db/queries.go` is 3,400 lines and the repo's most-edited file;
`handler/routes.go` is second. Adding key CRUD to either is a DRY-neutral but
maintainability-negative move. Key code goes in `db/project_keys.go` and
`handler/project_keys.go` (expansion E4, accepted).

**S6 Tests.** Covered in §6, expanded with five suites the original plan lacked
(reprovisioning inversion, masking vector, e2e environment rewrite, legacy-path counter,
six-row live smoke).

**S7 Performance.** One added read per ingest request (`default_environment_id`), served
from the existing resolver cache. `idx_project_api_keys_project_active_scope` covers the
list query; the auth lookup is by `key_id UNIQUE`. No N+1. The 5-minute coalescing is what
keeps `last_used_at` off the hot path.

**S8 Observability.** The original plan had none. Added: `opslane_key_auth_total{scope,outcome}`
(outcome ∈ ok, invalid_secret, revoked, unknown_key_id, wrong_scope, legacy_ingest) next to
the existing counters in `handler/metrics.go`, plus the boot-time legacy-key count. Those two
are what let you answer "did events stop because of us?" without guessing.

**S9 Deployment.** Migrate first, deploy second. The migration is additive; the constraint
is added after the backfill. Deploy-time risk window: old binary and new binary both
running means `def_` keys work on both (thanks to the legacy path) and `opslane_pk_` keys
401 on the old binary — acceptable, because no such key exists until the new binary mints
one. Post-deploy checks, first five minutes: `legacy_ingest` counter moving as expected,
`opslane_ingest_errors_total` flat, one event visible end to end.

**S10 Trajectory.** Reversibility 3/5 — the code reverts cleanly, the minted keys do not.
Debt introduced: the legacy `def_` branch (deliberate, dated, counted) and the three `501`
stubs (deleted by S2 by definition). Debt *retired*: `AuthenticateSessionOrSDK`, the
key→environment join, `allow_payload_environment`. Path dependency: keeping customer-data
reads on sessions leaves the credential table free to grow only machine credentials, which
is what a future org-scoped CI token (`opslane_ci_`) needs.

## Error and rescue registry

```
CODEPATH                        | FAILURE MODE                | RESCUED | ACTION              | USER SEES
--------------------------------|-----------------------------|---------|---------------------|-------------------------
LookupProjectKey                | malformed / unknown key_id  | Y       | return before query | 401 invalid_api_key
LookupProjectKey                | wrong secret                | Y       | record last_rejected| 401 invalid_api_key
LookupProjectKey                | revoked key                 | Y       | record reason=revoked| 401 invalid_api_key
LookupProjectKey                | DB unavailable              | Y       | 500, never 401      | 500 internal_error
LookupProjectKey (legacy def_)  | no matching hash            | Y       | fall through        | 401 invalid_api_key
RequireKeyScope                 | valid key, wrong family     | Y       | no rejection record | 403 insufficient_scope
CreateProjectKey                | rate limit hit              | Y       | reject before mint  | 429 rate_limited
CreateProjectKey                | secret_hash collision       | Y       | retry once, then 500| 500 internal_error
RevokeProjectKey                | already revoked             | Y       | idempotent          | 200 + existing revoked_at
resolveEnvironment              | unknown label               | Y       | project default     | nothing (label stored)
resolveEnvironment              | project default is NULL     | N ← GAP | —                   | 500 ← see below
masking.Redact                  | new prefix not matched      | N ← GAP | —                   | secret in logs ← CLOSED §4.7
```

`default_environment_id` NULL is the one open GAP: the migration backfills it, but a
project created by an older binary during the deploy window would have none. Fix: the
resolver falls back to the project's `production` row and logs once, rather than 500ing.

## Failure modes registry

```
CODEPATH               | FAILURE MODE                 | RESCUED | TEST | USER SEES        | LOGGED
-----------------------|------------------------------|---------|------|------------------|--------
auth (all scopes)      | wrong credential type         | Y       | Y    | 403              | metric
auth (all scopes)      | revoked                       | Y       | Y    | 401              | metric
legacy def_ path       | still in use after removal     | Y       | Y    | 401              | metric + boot log
ingest                 | project default env missing    | Y*      | Y    | event still lands| once
CLI errors/verify      | no read key on disk            | Y       | Y    | actionable error | —
dashboard key create   | route removed, UI stale        | Y       | Y    | create control ships | —
masking                | new prefix unredacted          | Y       | Y    | nothing          | —
reprovision            | prior key revoked (R5 breach)  | Y       | Y    | both keys work   | —
```

Zero rows with RESCUED=N. Zero CRITICAL GAPs remaining. `Y*` = fixed by the fallback above.

## NOT in scope

- Full source-map key settings card (#230) — S1 ships a minimal create control only.
- Batch upload handlers (#225, #226) — S1 ships scope-guarded `501` stubs.
- Org-scoped `opslane_ci_` token for monorepos — deferred to TODOS.md; S0 §5.1 already
  designs it as a later, backward-compatible addition.
- Per-key rate limits distinct from per-project — deferred; not needed until multiple keys
  exist in the wild.
- Prompt-injection hardening of the fix agent — separate issue, named in the parent design.
- Automatic environment creation from labels — a non-goal frozen in the parent design.

## Dream state delta

S1 leaves the credential model and the environment model honest, and leaves two things
unfinished: CI ergonomics (one secret per project, no org token) and key management UI.
Both are named follow-ons. It does not move the product's core promise — accurate fixes
from readable stack traces — which is S2 and S3 work. Say that plainly rather than
measuring S1 as a milestone.

**PHASE 1 COMPLETE.** Codex: 6 concerns. Claude subagent: 12 findings, 2 critical.
Consensus: 6/6 confirmed, 0 disagreements. 3 premises gated to the user, all answered.

---

# Review — Phase 2: Design

UI scope detected: the key-create control, the API-keys list shape, and the environment
filter. Initial design completeness of the plan as written: **3/10** — the backend is
specific, the UI section is one sentence ("a minimal create control on the existing API
Keys tab").

`DESIGN.md` does **not** exist at the repo root, despite an active decision claiming it was
written; `TODOS.md` already tracks that. There is therefore no design system doc to align
against, only existing component conventions.

## CODEX SAYS (design — UX challenge)

Verdict: the backend plan is specific; the UI plan is generic scaffolding. Four findings.

**1. Information hierarchy is wrong for a screen holding one public and two secret
credentials.** Scope is the most important column and does not exist today. Order must be
scope → label → status → key identifier → created/last used. "Environment" must disappear;
leaving that column for the implementer to reinterpret guarantees a bad patch.

**2. Interaction states are almost entirely unspecified** — no project selected, role
loading, member without create permission, initial loading, load failure with retry, true
empty, no-active-but-revoked-exist, next-page loading, later-page failure with earlier rows
visible, validation error, rate limited, create failure, ambiguous create after timeout,
created-but-refresh-failed, copy success, copy failure, secret acknowledged vs merely
displayed, project change mid-load.

These are not theoretical. `Settings.vue:429` swallows list errors
(`catch { // Non-fatal }`) and renders "No API keys yet" — the screen lies about a failed
load. `Settings.vue:496` puts create and list-refresh in one `try`, conflating "the key was
created" with "the table refreshed."

Changing the response to `{keys, next_cursor}` is transport design, not pagination UX. The
plan must require a visible "Load more", preservation of loaded rows on later-page failure,
and inline retry. Ignoring `next_cursor` silently shows an incomplete credential inventory.
Project switching needs explicit invalidation and request-generation guards; the current
list is not reset when the selected project changes, so another project's keys can stay on
screen.

**3. The show-once flow is unsafe.** `ModalSurface.vue:33` allows overlay click, Escape,
and close button; `Settings.vue:883` accepts those defaults. `CopyButton.vue:10` swallows
clipboard failure entirely. For an unrecoverable secret that is unacceptable. Required: no
overlay/Escape/close dismissal once the secret is on screen; an explicit "I have stored
this key securely" acknowledgement before Done; a `beforeunload` warning and a route-leave
guard while unacknowledged; copy success announced accessibly; copy failure shown
explicitly with selectable plaintext; never written to `localStorage`, `sessionStorage`,
logs, or analytics; and a deliberate "Revoke key and close" escape hatch.

Deeper API problem: a timeout after server-side creation produces a real key whose secret
the client never receives, and retrying creates another. Create needs an idempotency key,
or the plan must specify the ambiguous-outcome recovery flow. Otherwise S1 manufactures
orphan credentials.

**Revocation is not optional polish.** If a user loses a show-once secret, the only safe
recovery is create replacement → update deployment → revoke old. A UI that creates
credentials but cannot revoke them is a one-way security control. Rename can wait for #230;
revoke cannot.

**4. The environment filter is dishonest.** A visible, enabled filter promises that
changing it changes results. It is worse than inert decoration: the selection persists in
both the URL and local storage (`useEnvironmentFilter.ts:16`) and `FilterBar.vue:48` emits
`environment_id` as though effective. Remove it in S1, or disable it with an explicit
reason. A changeset does not excuse a deceptive live control.

## Design decisions, now settled

Auto-decided per /autoplan principles P1 (completeness) and P5 (explicit over clever);
every one is in the audit trail.

| # | Decision | Principle |
|---|---|---|
| G1 | API Keys table columns become scope, label, status, key_id, created, last used. Environment column deleted. | P5 |
| G2 | **Revoke ships in S1**, not #230. Create-without-revoke is a one-way security control. | P1 |
| G3 | Show-once modal is dismissal-locked: no overlay click, no Escape, no close button until "I have stored this key securely" is checked. Adds `beforeunload` + route-leave guard. | P1 |
| G4 | `CopyButton` gains an explicit failure state, and the secret stays selectable as plaintext for manual copy. Fix the swallow at `CopyButton.vue:10` for all callers. | P1, blast radius |
| G5 | `POST /projects/{id}/api-keys` accepts an `Idempotency-Key` header; a repeat within the window returns the original response including the secret. Closes the orphan-credential window. | P1 |
| G6 | `loadAPIKeys` stops swallowing errors (`Settings.vue:429`). Failed load renders an error with retry, never "No API keys yet". | P1 |
| G7 | Create and list-refresh split into two `try` blocks so a refresh failure cannot read as a create failure (`Settings.vue:496`). | P5 |
| G8 | List renders a "Load more" control driven by `next_cursor`; earlier rows survive a later-page failure. | P1 |
| G9 | Project switch invalidates the key list and guards against out-of-order responses. | P1 |
| G10 | The environment filter is **disabled with an explicit reason**, not removed and not left live. Removal is a bigger UX change than S1 should carry; leaving it live is a lie. | P5 |
| G11 | `sourcemaps` keys are creatable but the row carries a "usable from S2" note, since no handler accepts them yet. | P5 |

## Interaction state coverage map

```
SURFACE            | LOADING      | EMPTY          | ERROR              | SUCCESS        | PARTIAL
-------------------|--------------|----------------|--------------------|----------------|------------------
API Keys list      | skeleton rows| "No keys yet"  | error + retry (G6) | table          | Load more (G8)
                   |              | + create CTA   |                    |                | page-2 fail keeps
                   |              |                |                    |                | page-1 rows
Create key form    | button spinner| n/a           | inline field error | modal opens    | created but list
                   | disabled     |                | + rate-limit copy  |                | refresh failed (G7)
Show-once modal    | n/a          | n/a            | copy failed (G4)   | ack + Done     | unacknowledged →
                   |              |                | + selectable text  |                | beforeunload (G3)
Revoke (G2)        | row spinner  | n/a            | inline error       | row → Revoked  | idempotent repeat
Environment filter | n/a          | n/a            | n/a                | n/a            | disabled + reason
```

## User flow

```
Settings ▸ API Keys
   │
   ├─ list loads ──fail──► error + Retry            (G6: no longer a lie)
   │      │
   │      └─ empty ─────► "No keys yet" + Create
   │
   ├─ [Create key] ──► scope select (ingest / sourcemaps / read)
   │                   label field
   │                   └─► POST + Idempotency-Key   (G5)
   │                         │
   │                         ├─ 201 ─► SHOW-ONCE MODAL  ◄── dismissal locked (G3)
   │                         │           secret + Copy
   │                         │           ├─ copy ok ──► announced
   │                         │           ├─ copy fail ► visible + selectable (G4)
   │                         │           ├─ [x] I have stored this key securely
   │                         │           ├─ Done ─────► list refreshes (G7)
   │                         │           └─ Revoke and close
   │                         ├─ 429 ─► "Too many keys created. Try again in a minute."
   │                         └─ 5xx ─► inline error, no modal
   │
   └─ row ▸ Revoke (G2) ──► confirm ──► row shows Revoked, others unaffected
```

**PHASE 2 COMPLETE.** Codex: 4 concerns, all accepted. Design completeness 3/10 → 9/10.
11 decisions logged. Claude design subagent: pending at write time; folded in below when
returned.

## CLAUDE SUBAGENT (design — independent review)

Overall **2.7/10**. "The S0 API design is careful; the UI is bolted on afterward, and the
one thing the plan explicitly justifies shipping (create) is the half of rotation that
cannot be used safely without the half it omits (revoke)."

Scores: hierarchy 3, state coverage 2, show-once handling 2, environment-filter honesty 3,
UI specificity 2, ambiguity left to implementer 3, design-system consistency 4.

**Correction to the brief, and it changes the fix.** The environment filter does *not*
render unconditionally — `FilterBar.vue:185` already wraps the select in
`v-if="rollupReady"`. But `rollup_ready` is a **global** backfill flag
(`db/rollup_backfill.go:16`), not per-project, so it stays `true` after S1 and the select
keeps rendering. The failure mode is therefore worse than "broken": the user picks
"staging", sees zero incidents, and reads that as *staging is healthy*. For an
error-monitoring product, a filter that returns reassuring falsehoods beats one that
visibly breaks. **Supersedes decision G10** below.

Three critical findings the plan and Codex both missed:

- **C2 — the existing table renders two fields the new response does not contain.**
  `Settings.vue:826-827` renders `key.key_prefix` and `key.environment_name`. Neither is in
  the S0 §3.5 item. Vue renders `undefined` as an empty cell, silently. "Everything else
  about the card stays in #230" is not achievable — the table *is* the tab.
- **C3 — the response-shape change turns both "list failed" and "list succeeded" into
  "No API keys yet."** Three array assumptions: `Settings.vue:428`, `:505`, and `:393`
  (`apiKeys.value.length === 0` as the tab-switch load guard). Assign `{keys, next_cursor}`
  to an array ref and `.length` is `undefined`, so `v-if="apiKeys.length > 0"` at `:810` is
  false and the screen says "No API keys yet" while keys exist. That is the most dangerous
  wrong message on this screen, because the user's response is to mint another credential.
- **C1 — create without revoke, in a slice whose entire purpose is credential hygiene.**
  Same conclusion Codex reached independently.

High findings: **H3** — `navigator.clipboard` is `undefined` on non-secure origins, which
is exactly the self-hosted-over-plain-HTTP deployment this repo's Compose file produces, so
copy fails silently on the one deployment most likely to hit it. **H4** — the scope
selector is three raw API tokens where one is safe to publish and two are secrets; use the
labeled-radio-with-description pattern already on this screen (`Settings.vue:80-100`).
**H5** — deleting the `allow_payload_environment` toggle removes the only place the product
explains its environment model to an admin, and S1 inverts that model. **H6** — the created
secret is never announced to assistive tech; `initial-focus` resolves once on open and
points at a since-unmounted element. **H2** — the stronger modal pattern already exists 24
lines above (the provisioning modal sets `:close-on-overlay="false"` and gates Done behind
an acknowledgement); name it as the pattern to copy.

## Design consensus table

```
═══════════════════════════════════════════════════════════════════════════
  Dimension                              Claude    Codex     Consensus
  ──────────────────────────────────────  ────────  ────────  ─────────────
  1. Information hierarchy right?         3/10      CONCERN   CONFIRMED ✗
  2. Interaction states specified?        2/10      CONCERN   CONFIRMED ✗
  3. Show-once secret safe?               2/10      CONCERN   CONFIRMED ✗
  4. Environment filter honest?           3/10      CONCERN   CONFIRMED ✗
  5. Specific UI or generic patterns?     2/10      CONCERN   CONFIRMED ✗
  6. Revoke needed in S1?                 CRITICAL  CRITICAL  CONFIRMED ✗
  7. Design-system alignment?             4/10      n/a       single-voice
═══════════════════════════════════════════════════════════════════════════
  6/7 confirmed. 0 disagreements. 1 correction from Claude that supersedes
  a Codex-derived decision (G10 → G10-revised).
```

### Decisions added or revised after the subagent returned

| # | Decision | Principle |
|---|---|---|
| G10-revised | **Supersedes G10.** Disabling is not enough, because the filter renders on a global flag and returns empty results that read as "healthy". S1 gives `error_events.submitted_environment` its first reader: an Environments-tab line ("Seen in events but not configured: staging (412 events) · Create environment") and, when a project's events only ever land in its default, a line under the filter ("All events are landing in production. Set `environment` in your SDK init to split them."). | P1 |
| G12 | `APIKey` TypeScript interface (`api.ts:177-184`) changes with the response, so the compiler finds every consumer. `key_prefix` and `environment_name` columns deleted (C2). | P5 |
| G13 | `listAPIKeys` return type and the `apiKeys` ref change together; the tab-switch guard at `Settings.vue:393` moves to a separate `keysLoaded` flag (C3). | P1 |
| G14 | Scope chooser uses the labeled-radio-with-description pattern from `Settings.vue:80-100`, carrying the public/secret warning into the created-key screen and the list badge (H4). | P1 |
| G15 | `ModalSurface` gains a `lockClose` prop that suppresses Escape, overlay, ×, and the route-change watcher while an unacknowledged secret is displayed (H2). | P1 |
| G16 | Secret renders in a readonly input with select-on-focus; `role="status"` on the created-key region with focus moved there and an explicit announcement (H3, H6). | P1 |
| G17 | Environments tab marks the default row with a `Default` badge and states the new precedence in one sentence, replacing the deleted `allow_payload_environment` copy (H5). Whether the default is settable in S1: **no** — display only, setter goes to #230, and the screen says so. | P5 |

---

# Review — Phase 3: Engineering

## CODEX SAYS (eng — architecture challenge)

Verdict: not implementation-ready. Twelve findings; the load-bearing ones:

**1. HIGH — the auth/authz split is unsafe as a routing API.** Exposing
`AuthenticateProjectKey` separately lets a future route authenticate every scope by
accident, and `RequireKeyScope("sourcemaps")` alone cannot populate `ctxKeyScope`. "Session
or `RequireKeyScope("read")`" is not a valid middleware composition at all. Keep the
primitives private; expose only composed router middleware — `ProjectKeyOnly(IngestScope)`,
`ProjectKeyOnly(SourcemapsScope)`, `SessionOrProjectKey(ReadScope)` — plus a static test
forbidding bare `AuthenticateProjectKey` in `routes.go`. Define mixed-header precedence:
`auth.go:214` currently prefers any `X-API-Key` over a valid session. **The plan's smoke
table is also wrong**: a valid `pk` on `/incidents` is `403 insufficient_scope`, not `401`.

**2. HIGH — the proposed DDL cannot store a read key.** §4.1 still says "exactly the frozen
DDL", whose CHECK is `scope IN ('ingest','sourcemaps')` with a `token_prefix` CHECK naming
only two prefixes. Every `opslane_rk_` insert would be rejected. *(Claude's design voice
found this independently as M5 — cross-model confirmed.)*

**3. CRITICAL — `read` is a durable human-data credential disguised as a project API key.**
*(Upheld. The `read` scope was withdrawn at the final gate; the CLI holds a session instead —
see §4.7. The passages below are kept as the record of why.)*
It never expires, survives offboarding, and bypasses membership checks:
`checkProjectAccess` (`read_api.go:189`) trusts a key's project context directly and only
sessions get an organization lookup. It exposes root cause, candidate diffs, verification
evidence, session pointers, and identity-filtered incident queries (`read_api.go:20`,
`queries.go:818`). File mode `0600` protects against other local users, not malware,
backups, copied files, stolen laptops, or departed employees. **This argues against decision
D1.3 and is escalated to the final gate as a User Challenge, not auto-decided.**

**4. HIGH — the five-minute map is neither bounded nor globally coalesced.** A
process-lifetime `map[key_id]timestamp` grows forever and retains revoked keys; with N
replicas it permits N writes per five minutes, contradicting the frozen "at most one
database write" contract. A single watermark also lets a successful use suppress a
rejection update. Make Postgres the correctness boundary with a conditional update
(`WHERE last_used_at IS NULL OR last_used_at <= $2 - interval '5 minutes'`), separate
predicates for use and rejection, and treat any in-process cache as a bounded TTL/LRU
optimization that allocates only after successful authentication and never fails auth on
telemetry failure.

**5. CRITICAL — the migration does not establish its claimed invariant.** Projects with no
environments stay `NULL`, and that state is reachable today through standalone
`CreateProject` (`queries.go:146`). The FK permits `NULL` while the tests claim every
project has a default. The migration must inventory or idempotently create `production` for
environmentless projects, backfill only `NULL` rows with deterministic ordering, and assert
zero nulls as a postcondition. The later `NOT NULL` promise is harder than it sounds: it
blocks the initial insert in the current project → environment → update sequence.

**6. HIGH — migration atomicity.** `scripts/run-migrations.sh:14` runs
`psql -f "$f"` with no `--single-transaction`, so statements autocommit individually and a
crash can leave the column and backfill applied with constraints absent. Wrap the migration
in an explicit transaction. Adding the composite unique index and validating the FK also
lock and scan existing tables; `DEFERRABLE` does not reduce those locks.
*(Partly inaccurate: Codex says `DEFERRABLE` defaults to `INITIALLY IMMEDIATE`. True of a
bare `DEFERRABLE`, but S0 line 428 specifies `DEFERRABLE INITIALLY DEFERRED`. The
substantive points — atomicity, lock sizing, and undefined behavior when the default
environment is deleted — stand.)*

**7. HIGH — ledgerless replay makes "drop the old columns" operationally wrong.** Migration
018 re-adds `allow_payload_environment` and `provisioning_key_id` on **every startup**
(`018_environments_first_class.sql:32`). If 028 drops them, every boot adds them and drops
them again, taking needless DDL locks forever. S1 must be **expand-only**: stop using them
in code and API, retain the deprecated columns until the migration system has a ledger.

**8. HIGH — two-key CLI delivery is a protocol migration, not a mint-site change.** There
is exactly one key today, in three places: `agent-credentials.ts:7`,
`agent-protocol.ts:34`, `agent_setup.go:192`. Existing credential files contain no read
key, and after the ingest ping succeeds `setup.ts:373` returns `already_configured` without
obtaining one. Specify additive `read_key_sealed` / `read_api_key` fields, optional
old-file parsing, missing-key remediation, atomic local replacement, and atomic paired
provisioning. Test old CLI/new server, new CLI/old server, old-credential upgrade, and
interrupted delivery.

**9. MEDIUM — timing is an availability problem, not a confidentiality one.** The format is
public and IDs are 128 bits, so malformed-does-no-query leaks nothing meaningful. The real
issue: unlimited well-formed unknown key_ids force indexed database queries *before* any
project rate limit, because `rateLimitByProject` is chained after authentication
(`ingest_limits.go:31`). Add a pre-auth IP limiter and a lookup timeout. For recognized
new-format keys, run the hash comparison even on scope mismatch or revocation so a leaked
key_id gains no timing oracle. Malformed `opslane_(pk|sk)_` values must never fall
through to the legacy lookup.

**10. MEDIUM — the whole-router matrix is underspecified.** Public routes intentionally
ignore project credentials, so "every registered route defaults to DENY" cannot literally
hold, and the SPA route set is configuration-dependent. Classify every route as public,
session, internal, key-scoped, or mixed; apply DENY-by-default to key-aware registration
only, and require exact equality on the full classification inventory. Separately,
`writeJSONError` (`auth.go:328`) emits no machine-readable `code` field at all, which S0 §1
requires on every error.

**11. MEDIUM — rollback is not actually preserved.** Keeping `environment_api_keys`
prevents row loss, but an old binary cannot authenticate newly issued `opslane_pk_` rows.
Declare rollback unsupported once new keys are issued; do not dual-write into the legacy
table, which would reopen the old read/upload privilege on rollback.

**12. MEDIUM — `submitted_environment` has no bounded contract.** The plan says
"normalized" but no normalization function exists; `env_resolver.go:104` is exact and
case-sensitive. Invalid input can consume most of the 1 MiB event body and then be stored
as unrestricted text. Define trimming, casing, Unicode handling, absent-versus-empty, and a
strict stored-length cap. Ensure the legacy fallback discards its old key-bound environment
and uses the project default like every new key.

## CLAUDE SUBAGENT (eng — independent review)

Confidence high on every Go/SQL/chi finding; it read the pinned `chi v5.3.1` source
directly. Three criticals, none of which the other voices found:

**C1 — the key parser as specified rejects about half the keys it mints.** §4.2 said "split
on `_`, require exactly four parts". base64url's alphabet **contains `_`**, so
`1 - (63/64)^43 ≈ 49%` of tokens contain at least one. A strict four-way split 401s roughly
half of all minted keys, non-deterministically, and passes the first local test whose
fixture happened to be clean. The plan even contradicted itself: §4.7's masking fix widens
the character class to `[A-Za-z0-9_-]+` precisely because `_` *is* in the token.
**Fixed in §4.2** — `SplitN(raw, "_", 4)`, part four is the whole secret, with a test vector
whose token contains `_`.

**C2 — dropping `allow_payload_environment` is a fleet-wide ingest outage during the
rolling deploy.** Three live queries in the *old* binary select it (`db/queries.go:342`,
`:209`, `:3171`), and `handler/auth.go:198-202` maps any `LookupAPIKey` error to 401. SDKs
do not retry a 401, so events are lost rather than delayed. The plan's own §S9 called that
deploy window "acceptable"; it was wrong. **Fixed in §4.1** — expand-only, drop nothing,
plus an old-binary-against-new-schema exit criterion. *(Codex reached expand-only from the
migration-replay angle independently — cross-model confirmed.)*

**C3 — the backfill silently clobbers operator state on every restart.**
`run-migrations.sh:11-15` replays every file on every boot with no ledger, so an
unconditional `UPDATE` resets an admin's chosen default to `production` at every container
start, invisible until the second boot. The plan's idempotency test ("re-apply, does not
error") proves nothing. **Fixed in §4.1** — `WHERE default_environment_id IS NULL`, plus an
idempotency test that sets a non-production default and asserts it survives.

**M1 — my chi claim was wrong, and the plan used it to weaken its own test.** `WalkFunc`
in v5.3.1 *does* receive middlewares (`tree.go:839`, `:872-875`), so a structural assertion
via `reflect.ValueOf(mw).Pointer()` is available in ~15 lines. Also: `mALL` expansion
(`tree.go:363-373`) makes `r.HandleFunc("/oauth/authorize")` and the SPA `r.Handle("/*")`
each yield ~9 walk rows, so route-set equality fails on day one unless the table expects
them. **Both fixed in §6.**

**M2 — the `/api/*` JSON 404 does not fire on the routes it exists for.** `/api/v1` is a
mounted subrouter; use `r.NotFound()` on the root mux. **Fixed in §4.3.**

**M6 — two factual errors in §4.5.** The session-environment precedence is *already*
stated (`docs/contracts/events.md:61-62`) and implemented (`handler/error_event.go:188-201`);
only the base changes. And `handler/wire_compat_test.go:275` sets
`allow_payload_environment = true` as setup for the frozen `v1.1.0-full.json` fixture, so
that fixture's *outcome* changes after S1 — wire shape untouched, so the append-only
guardrail holds, but the `contract-change` label applies. **Both fixed.**

**M7 — a live masking bug, found in passing.** `def_` keys are `def_<uuid>`
(`db/queries.go:315`) and today's `[A-Za-z0-9]+` stops at the first `-`, leaving most of
every legacy key in cleartext **right now**. The §4.7 widening fixes an existing bug, not
only a future one. Own test vector and changeset line.

Also raised: H2 (500-vs-401 lived only in the appendix, now normative), H3 (the ping is an
unrate-limited amplification target because `rateLimitByProject` can only run after
successful auth), H4 (the read key is a non-expiring bearer token that survives
offboarding — escalated as a User Challenge), H5 (one `api_key_sealed` column
(`017_agent_sessions_v2.sql:15`) cannot deliver two keys; and `agent-credentials.ts` is a
`version: 2` file with a strict five-key validator, so every existing install breaks until
re-run), M3 (`isSDKEndpoint` "known-shape matching" creates a second copy of the route
table; use a boundary check), M4 (the coalescing map's bound, context, and sync/async were
three unstated decisions), M5 (`ADD CONSTRAINT FOREIGN KEY` locks and scans; use
`NOT VALID` then `VALIDATE`), and ten named test gaps.

**Hidden complexity, ranked:** the key parser; column drops during rolling deploy; the
backfill; "session or read key"; two keys through one sealed column; **and the "minimal
create control" — §4.7 says minimal, the Phase 2 appendix then adds seventeen decisions
that amount to most of #230. Those two sections disagree about scope by roughly 5x.**

## Eng consensus table

```
═══════════════════════════════════════════════════════════════════════════
  Dimension                              Claude    Codex     Consensus
  ──────────────────────────────────────  ────────  ────────  ─────────────
  1. Architecture sound?                  CONCERN   CONCERN   CONFIRMED ✗
  2. Test coverage sufficient?            CONCERN   CONCERN   CONFIRMED ✗
  3. Performance risks addressed?         CONCERN   CONCERN   CONFIRMED ✗
  4. Security threats covered?            CONCERN   CONCERN   CONFIRMED ✗
  5. Error paths handled?                 CONCERN   CONCERN   CONFIRMED ✗
  6. Deployment risk manageable?          FAIL      CONCERN   CONFIRMED ✗
═══════════════════════════════════════════════════════════════════════════
  6/6 confirmed. 0 disagreements. Independently identical fixes on the two
  biggest items: one-pass middleware constructors (H1) and expand-only
  migrations (C2 / Codex 7). Claude found three criticals Codex missed
  (parser, rolling-deploy outage, backfill clobber); Codex found the
  read-key lifetime argument Claude then confirmed from a different angle.
```

---

# Review — Phase 3.5: Developer experience

DX scope: CLI, SDK, published Vite plugin, HTTP API, self-host docs, and an AI coding agent
as a first-class user.

## CODEX SAYS (DX — developer experience challenge)

**The published Vite plugin breaks and the plan says "SDK unchanged".**
`packages/sdk/vite-plugin/index.ts:74` posts the ingest key to `/api/v1/sourcemaps`, the
route S1 removes. Every customer build will delete maps from its output, receive 404s,
print a warning, and exit 0 having uploaded nothing. That is a shipped integration
regression, not "unchanged". Either ship S1 and S2 atomically, or explicitly disable and
version the plugin plus its docs during S1.

**`verify` can report a false success.** The plan sends `verify` to `/event-count` with the
read key while only `setup` and `doctor` ping the ingest key. A revoked ingest key plus a
valid read key plus historical events yields
`{"status":"ok","api_reachable":true,"has_events":true}` — claiming the integration works
when it cannot ingest anything. `verify` must run both checks in sequence and name which
credential failed. `doctor` likewise.

**Naming.** `opslane_pk_` reads as public key; `opslane_sk_` reads as secret key but not
specifically *source-map*; `opslane_rk_` is not guessable at all — read, replay,
restricted, repository, root. `scope` is right in the HTTP and storage API and wrong as
user-facing vocabulary: people choose a key *type* or *purpose*. Say "Public ingest key",
"Source-map upload key", "CLI read key". The CLI currently says "API key" everywhere
(`api_key`, `--api-key`, "API key is valid"); with three credential types that becomes
actively misleading, and `doctor` needs separate "Ingest key" and "Read key" checks. The
Vite plugin option should be `sourceMapKey`, not another ambiguous `apiKey`.

**Error messages.** `writeJSONError` emits no `code` at all, and `cli/src/errors.ts:17`
reduces everything to `{"error":"API error: 401"}`. A developer learns neither what
happened nor how to fix it. The CLI must preserve the server's `code` and return stable
statuses with remediation.

**Migration DX is inadequate.** The SQL runs automatically — good. Everything around it is
not. An upgrader running `docker compose up -d` never sees application logs, so the "loud
boot-time log" is invisible unless they independently run `docker compose logs ingestion`.
There is no preflight command, no post-upgrade status, no `doctor` legacy-key check, no
removal deadline, no rotation command, and no way to see which projects still use legacy
keys. Worse, the default self-host quickstart has no usable authenticated control plane —
`docs/quickstart/self-host.md:109` says dashboard login needs a configured GitHub App — so
a headless self-hoster who sees the legacy warning **has no documented way to mint a
replacement**. S1 needs a headless rotation path: `opslane keys migrate-status`,
`opslane keys create --project ... --type ingest`.

**Agent DX.** S1 does not make setup browserless — `docs/quickstart/agent.md:18` already
says a human must open the authorization URL — it only avoids a *second* browser login for
reads. After that handoff it still fails in four places: the dual-key poll and storage
contracts are unspecified, existing credentials have no migration or repair operation,
`setup --relink` does not mint a read key (`setup.ts:373` returns `already_configured`
after the ping succeeds), and `verify` can lie.

**Docs blast radius is much larger than the plan admits:** `docs/install.md`,
`docs/reference/http-routes.md`, `docs/quickstart/agent.md`,
`docs/quickstart/self-host.md`, `docs/reference/cli-agent-contract.md`,
`docs/guides/source-maps.md`, and `packages/sdk/README.md`.

## DX decisions, auto-decided

| # | Decision | Principle |
|---|---|---|
| X1 | `verify` and `doctor` each validate **both** credentials in sequence and name which one failed. A read-key success alone never reports "ok". | P1 |
| X2 | CLI vocabulary becomes "ingest key" / "source-map key" / "read key". `doctor` splits into two named checks. `scope` stays in the HTTP API. | P5 |
| X3 | `writeJSONError` emits `{error, code}` on every path (S0 §1 already requires it); `cli/src/errors.ts:17` preserves `code` and prints remediation. | P1 |
| X4 | Headless rotation ships: `opslane keys create --project <id> --type <ingest\|sourcemaps\|read>` and `opslane keys migrate-status`. Without it a headless self-hoster who loses a key has no recovery path at all. | P1 |
| X5 | The Vite plugin is explicitly disabled with a one-time actionable error during S1 ("source-map upload is unavailable in this release; see #218") rather than silently 404ing, and `docs/guides/source-maps.md` + `packages/sdk/README.md` say so. | P1 |
| X6 | Dual-key delivery is specified as a wire change: additive `read_key_sealed` column, additive `read_api_key` poll field, credential file `version: 3` with optional v2 parsing, atomic local replacement, and a repair path for installs that already ran `setup`. Tests: old CLI/new server, new CLI/old server, v2 upgrade, interrupted delivery. | P1 |
| X7 | Exit criteria expand to both quickstarts, the CLI agent contract, the source-map guide, the SDK README, and one zero-browser headless smoke. | P1 |

## Developer journey

```
STAGE                    BEFORE S1              AFTER S1                    DELTA
──────────────────────── ────────────────────── ─────────────────────────── ──────────
1 install SDK            npm i @opslane/sdk     same                        0
2 get a key              onboarding / Settings  same + choose a key type    +1 choice
3 init()                 apiKey: def_...        apiKey: opslane_pk_...      0
4 first error captured   yes                    yes                         0
5 read errors from CLI   ingest key             read key (auto-provisioned) 0
6 check the key works    /event-count probe     /ingest/ping                0
7 upload source maps     silently broken        explicitly disabled (X5)    honest
8 rotate a key           re-run onboarding      create + revoke in UI/CLI   -1 step
9 upgrade self-hosted    n/a                    migrate-status + rotate     +1, new
```

TTHW (time to first captured error) is unchanged for a new project: the added step is one
key-type choice at stage 2. The upgrade path is where S1 adds work, and X4 is what keeps it
finite for headless deployments.

**PHASE 3.5 COMPLETE.** DX overall 4/10 → 8/10. Codex: 6 concerns, all accepted as X1-X7.
TTHW unchanged for new projects; upgrade path is the new cost.

---

## Decision audit trail

| # | Phase | Decision | Class | Principle | Rationale |
|---|-------|----------|-------|-----------|-----------|
| D1.1 | CEO | Time-boxed legacy `def_` ingest path over a hard cut | **User gate** | — | User answered. Both models independently recommended it |
| D1.2 | CEO | Three source-map batch paths ship as scope-guarded 501 stubs | **User gate** | — | User answered. Makes R3 provable in S1 |
| D1.3 | CEO | New `read` scope + `/ingest/ping` | **Superseded** | — | Withdrawn after the Phase 3 challenge |
| D2 | Gate | Dashboard stays minimal; key lifecycle moves to the CLI | **User ruling** | — | v1 flow is `opslane onboard` → alerts → fix PRs. Nobody lives in the dashboard. Revoke still ships, in the CLI where users are |
| D1.3-rev | Gate | CLI holds a **session**, issued during the browser trip setup already requires. No read key. `opslane login` becomes the renewal command | **User ruling** | — | User's call, Stripe-shaped: `pk`/`sk` are product credentials, the CLI is a different thing. Resolves the User Challenge — sessions re-check membership per request, project keys never do |
| E1 | CEO | Register batch stubs | Mechanical | P1 | R3 unverifiable otherwise |
| E3 | CEO | `opslane_key_auth_total{scope,outcome}` metrics | Mechanical | P2 | In blast radius, no new infra |
| E4 | CEO | Key code into `db/project_keys.go` + `handler/project_keys.go` | Mechanical | P5 | Both host files are the repo's top churn magnets |
| E5 | CEO | Update `http-routes.md`, `trust.md` in this PR | Mechanical | P2 | docs-sync bot would otherwise rewrite and cancel CI |
| E6 | CEO | Org-scoped `opslane_ci_` token → TODOS.md | Mechanical | P3 | S0 §5.1 already designs it as a later addition |
| E7 | CEO | Settings UI → skip | Mechanical | P3 | Already #230 |
| E8 | CEO | Per-key rate limits → TODOS.md | Mechanical | P3 | Not needed until multiple keys exist |
| G1-G9, G11 | Design | Columns, revoke, locked modal, copy failure, idempotency key, error state, split try, Load more, project-switch invalidation, sourcemaps note | Mechanical | P1, P5 | Every one closes a state the plan left to the implementer |
| G10 | Design | Environment filter disabled with a reason | *Superseded* | — | Replaced by G10-revised |
| G10-rev | Design | Give `submitted_environment` a reader; explain in-product | Mechanical | P1 | Filter renders on a global flag; empty results read as "healthy" |
| G12-G17 | Design | TS interface, load guard, radio scope chooser, `lockClose`, a11y announce, Environments-tab default badge | Mechanical | P1, P5 | Subagent findings C2, C3, H2-H6 |
| N1 | Eng | `SplitN(raw,"_",4)` parser | Mechanical | P1 | Correctness. Naive split breaks ~49% of keys |
| N2 | Eng | Expand-only migration, drop nothing | Mechanical | P1 | Rolling-deploy outage + ledgerless replay |
| N3 | Eng | Guarded backfill + meaningful idempotency test | Mechanical | P1 | Unguarded UPDATE clobbers operator state every boot |
| N4 | Eng | One-pass middleware constructors, primitives unexported | Mechanical | P5 | Two-middleware split fails open and cannot express the read routes |
| N5 | Eng | Postgres-side conditional `last_used_at` update | Mechanical | P1 | An in-process map is neither bounded nor globally coalescing |
| N6 | Eng | Pre-auth IP limiter + lookup timeout | Mechanical | P1 | `rateLimitByProject` can only run after successful auth |
| N7 | Eng | Structural chi assertion + `mALL` expansion rows + 405 handling | Mechanical | P1 | Corrects a false claim that weakened the test |
| N8 | Eng | `r.NotFound()` on the root mux | Mechanical | P5 | `/api/*` pattern never fires for a mounted subrouter |
| N9 | Eng | `isSDKEndpoint` boundary check, not shape matching | Mechanical | P5 | Avoids a second copy of the route table |
| N10 | Eng | FK `NOT VALID` then `VALIDATE`; drop the pointless `DEFERRABLE` | Mechanical | P3 | Follows the pattern 018 already uses |
| N11 | Eng | 500-never-401 on DB error, normative | Mechanical | P1 | Was appendix-only; appendices do not get implemented |
| X1-X7 | DX | Two-credential verify/doctor, vocabulary, `code` field, headless rotation, plugin disabled, dual-key wire, expanded exit criteria | Mechanical | P1, P5 | Each closes a way a developer is misled or stranded |

Two items are **not** auto-decided and go to the final gate: the read-key lifetime
challenge (below) and the dashboard scope contradiction.

## Implementation tasks

- [ ] **T1 (P1, human: ~1h / CC: ~10min) — ingestion/auth** — Parse keys with `SplitN(raw,"_",4)`; test vector with `_` in the token
  - Surfaced by: Eng C1 — base64url contains `_`; a naive split 401s ~49% of minted keys
  - Files: `packages/ingestion/db/project_keys.go`
- [ ] **T2 (P1, human: ~3h / CC: ~25min) — ingestion/migrations** — Expand-only `028`; guarded backfill; FK `NOT VALID` + `VALIDATE`; environmentless-project repair; zero-null postcondition
  - Surfaced by: Eng C2/C3, Codex 5/6/7
  - Files: `packages/ingestion/db/migrations/028_project_api_keys.sql`
  - Verify: old binary against new schema returns 200 on `POST /events`; re-run migrations twice with a non-production default set
- [ ] **T3 (P1, human: ~4h / CC: ~30min) — ingestion/handler** — One-pass `ProjectKey` / `SessionOrProjectKey` constructors; unexport primitives; static test banning bare authenticator use
  - Surfaced by: Eng H1, Codex 1 (independently identical fix)
  - Files: `packages/ingestion/handler/project_keys.go`, `handler/routes.go`
- [ ] **T4 (P1, human: ~30min / CC: ~5min) — ingestion/masking** — Add `opslane_(pk\|sk\|rk)_`, widen class to `[A-Za-z0-9_-]+`; fixes a live `def_` leak too
  - Surfaced by: CEO F8 + Codex + Eng M7 (three-way confirmed)
  - Files: `packages/ingestion/masking/masking.go`
- [ ] **T5 (P1, human: ~2h / CC: ~15min) — ingestion/db** — Delete the reprovision revoke; invert `project_provisioning_test.go:66`
  - Surfaced by: CEO 0B — `db/queries.go:242-257` violates R5 and S0 §3.2
  - Files: `packages/ingestion/db/queries.go`, `db/project_provisioning_test.go`
- [ ] **T6 (P1, human: ~1d / CC: ~1h) — ingestion/handler** — Route matrix: structural chi assertion, DENY-by-default, exact set equality including `mALL` rows, 405 and 404 shapes
  - Surfaced by: Eng M1/M2, Codex 10
- [ ] **T7 (P1, human: ~2h / CC: ~20min) — ingestion/handler** — `writeJSONError` emits `code`; `r.NotFound()` on the root mux; `isSDKEndpoint` boundary check
  - Surfaced by: Codex 10, Eng M2/M3
- [ ] **T8 (P1, human: ~3h / CC: ~25min) — ingestion/db** — Postgres-side conditional `last_used_at`; bounded LRU cache; `context.WithoutCancel`; single background writer; `-race` test
  - Surfaced by: Codex 4, Eng M4
- [ ] **T9 (P1, human: ~1d / CC: ~1h) — cli** — Dual-key delivery: `read_key_sealed` column, `read_api_key` poll field, credential file v3 with v2 parsing, atomic replacement, repair path
  - Surfaced by: Eng H5, Codex DX 8
  - Files: `cli/src/agent-credentials.ts`, `cli/src/agent-protocol.ts`, `packages/ingestion/handler/agent_setup.go`, `db/migrations/028`
- [ ] **T10 (P1, human: ~4h / CC: ~30min) — cli** — `verify` and `doctor` check both credentials and name the failure; preserve server `code`; split doctor into two named checks
  - Surfaced by: Codex DX 2/5 — a read-key success alone currently reports "ok"
- [ ] **T11 (P1, human: ~4h / CC: ~30min) — cli** — `opslane keys create` and `opslane keys migrate-status` for headless rotation
  - Surfaced by: Codex DX 4 — self-host quickstart has no authenticated control plane
- [ ] **T12 (P1, human: ~2h / CC: ~15min) — sdk** — Disable the Vite plugin with a one-time actionable error; update `docs/guides/source-maps.md` and `packages/sdk/README.md`
  - Surfaced by: Codex DX 1 — the plugin posts to the route S1 removes; "SDK unchanged" is false
- [ ] **T13 (P2, human: ~2h / CC: ~15min) — dashboard** — Minimal only (D2): new columns + `APIKey` interface, unwrap `.keys`, move the load guard to `keysLoaded`, repoint create to `/projects/{id}/api-keys` with a scope select
  - Surfaced by: Design C2/C3 — the only two failures S1 itself causes
  - Files: `packages/dashboard/src/views/Settings.vue`, `packages/dashboard/src/api.ts`
- [ ] **T14 (P1, human: ~6h / CC: ~40min) — cli** — `opslane keys list|create|revoke|migrate-status`, session-authenticated, secret printed once on stdout
  - Surfaced by: D2 — key lifecycle moves to the CLI because that is the v1 surface; carries the revoke the design review called critical
  - Files: `cli/src/keys.ts`, `cli/src/index.ts`
- [ ] **T15 (P2, human: ~3h / CC: ~20min) — docs** — `install.md`, `http-routes.md`, `trust.md`, both quickstarts, `cli-agent-contract.md`, `events.md` (+ `contract-change` label)
  - Surfaced by: CEO F7, Codex DX 6, Eng M6

---


---

# Review run 2 — scope reduction ("one bulletproof flow")

Founder instruction: *"simplicity is key. make one flow bulletproof instead of trying to do
too many things. security and developer experience are paramount."*

The one flow: `opslane onboard` → `pk` minted → SDK sends errors → alert → fix PR.

Both voices independently reached the same verdict. Codex: *"Yes. The plan is over-built.
It combines a security fix, an environment redesign, dashboard lifecycle work, speculative
source-map APIs, and CLI credential migration. S1 should be a credential-boundary slice."*

## The fact that collapsed a whole task

`opslane onboard` **already holds a refreshable session.** `cli/src/onboard/provision.ts:79`
(`ensureLoggedIn`) loads tokens from the standard origin-keyed file, refreshes them under a
lock with a single-use refresh token, and falls back to interactive login;
`cli/src/onboard/core.ts:145-157` provisions with `token: tokens.accessToken`.

Every prior turn analysed `opslane setup`, the older sessionless path. The v1 flow is
`onboard`. T9 — sealed `session_sealed` column, additive poll field, credential file v3,
v2 parsing, repair path, four wire-compat tests — was solving a problem this flow does not
have. **Cut to zero.** `setup`-only installs run `opslane login`, which ships today.

## Two blockers neither prior run found

**B1 — nothing stops a developer pasting an `opslane_sk_` into the browser bundle.**
`cli/src/init.ts:195` writes whatever key it is handed into `.env.local` as
`VITE_OPSLANE_API_KEY`, and the SDK sends whatever it is given as `X-API-Key`. Neither
checks the prefix. S1 introduces two credentials that differ in eleven characters out of
eighty-one. Today there is one key, so the mistake is impossible; S1 would *create* the
failure it exists to prevent, and make it likelier than the status quo.
**Fix (~10 lines each, non-negotiable):** SDK `init()` rejects any key not prefixed
`opslane_pk_` with a named error; the CLI env writer rejects the same.

**B2 — the live smoke never runs the actual flow.** §6 is six curls against auth
boundaries. Nothing runs `opslane onboard` end to end. The raw key goes from ~40 characters
(`def_` + UUID) to ~81 (`opslane_pk_` + 26 + 43) and starts containing `_`, while
`key_prefix` is `rawKey[:12]` (`db/queries.go:318`). Every length or charset assumption —
env-var codemods, `cli/src/onboard/tools.ts:216`, the sealed-key envelope, the dashboard
prefix column — breaks silently. A plan whose purpose is making one flow bulletproof did
not have that flow in its exit criteria.

Three more, folded in: **B3** — `allowed_origins` is selected (`db/queries.go:342`) and
treated as allow-all when nil (`handler/auth.go:65-68`), and onboarding never sets it. S1
renames the credential "public" in `trust.md`, at which point `rateLimitByProject` is the
only abuse control on `/events`. Either set it during onboarding, which knows the app, or
say so plainly in `trust.md`. **B4** — two environment sources already disagree:
`db/agent_provision.go:257` mints against `development` while `cli/src/init.ts:185`
hardcodes `environment: 'production'` into the generated `.opslane.json`. Decide where the
onboarding self-test error lands and assert it. **B5** — after deleting the reprovision
revoke, re-onboarding leaves two live keys with no indication which one the deployed bundle
holds. One line of CLI output naming the `key_id` closes it.

## Cuts, auto-decided (both voices agreed; none is a judgement call)

| Item | Verdict | Reason |
|---|---|---|
| T9 dual-credential delivery | **CUT** | `onboard` already has a refreshable session |
| `last_used_at` tracking, coalescer, background writer, `-race` test | **CUT** | Read by nothing until S5; put a new write on the ingest hot path. Ship the column, write nothing |
| `last_rejected_at` tracking | **CUT** | No consumer until S5, and it lets a known key_id generate database writes |
| Cursor pagination, key rename | **CUT** | A table with a dozen rows |
| `opslane keys migrate-status` | **CUT** | The boot-time log and one metric already surface it |
| T11 | **CUT** | Duplicate of T14 |
| Dashboard scope select | **CUT** | Minting an `sk` from a UI produces a credential no route accepts until S2 |
| T2 migration | **SHRINK** | Table + 2 indexes + idempotent `production` upsert. Pending the environment decision below |
| T6 route matrix | **SHRINK** | Keep the structural `chi.Walk` assertion plus DENY-by-default over the ~12 credential-bearing routes. Cut exact-set equality, `mALL` nine-row accounting, and 405-shape classification — that is where the day goes, and it fights chi rather than our code |
| T7 | **SHRINK** | Keep the `isSDKEndpoint` boundary check and dropping `/api/v1/sourcemaps` from it (3 lines, a real CORS hole) plus `code` on auth errors. Defer the root-mux JSON 404 and the repo-wide `code` refactor — a removed route serving `index.html` is ugly, not unsafe |
| T10 verify/doctor | **SHRINK** | Route the five call sites through `ensureLoggedIn` (not bare `loadTokens` — expiry matters) and add one named check that pings `/ingest/ping` with the `pk`. 4h → 1.5h |
| T12 Vite plugin | **SHRINK** | Throw a clear build error naming S2; update the README and `docs/guides/source-maps.md`. Drop the one-time-throttle machinery, fail loudly every time |
| T13 dashboard | **SHRINK** | Unwrap `.keys`, fix the two blank columns, repoint create. Nothing else |
| T14 `opslane keys` | **SHRINK** | `list` / `create --type ingest` / `revoke`. This is the rotation path when there is no dashboard |
| T15 docs | **SHRINK** | `events.md`, the S0 amendment, `http-routes.md`, `trust.md`, BREAKING changeset. Quickstarts get one line each |
| T1, T3, T4, T5 | **KEEP** | Parser correctness, the security boundary itself, secret redaction, and the reprovision revoke that silently kills a deployed key |
| B1, B2 | **ADD** | Blockers above |

Effort: the plan's own estimates summed to ~52h human. Shrunk to ~21h plus ~2h for the
blockers.

**Re-onboarding must stop minting.** Deleting the reprovision revoke (T5) fixes R5 but
opens key accumulation: every `opslane onboard` rerun would leave another live key behind.
Auto-decided: reuse the stored credential after an authenticated ping, and mint only for
explicit rotation.

## Exit criteria — three checks, ten minutes, by hand

1. **The flow survives.** Clean checkout of `test-fixtures/react-app` → `opslane onboard` →
   `.env.local` matches `^opslane_pk_[a-z2-7]{26}_[A-Za-z0-9_-]{43}$` → trigger the fixture
   error → a row in `error_events` under the right project and expected environment.
2. **The boundary is real.** Same key: `POST /api/v1/events` → 200;
   `GET /api/v1/projects/{id}/incidents` → 403 `insufficient_scope`;
   `POST /api/v1/sourcemaps` → 404. Then the session from that onboard:
   `GET .../incidents` → 200.
3. **Nobody went dark.** Re-run `opslane onboard` on the same repo — the step-1 key still
   returns 200 on `POST /events`, and a pre-existing `def_` key still returns 200.

Everything else (`pnpm -r build`, `go test`, migration re-apply, doc updates) is CI's job.

---

## Codex review of the minimal plan

Run against the plan proper only, with the deliberate cuts named so they would not be
re-added. Verdict: *"the security direction is right, but the plan has two flow blockers
and two security omissions."* All six findings verified against source and applied.

| Finding | Status |
|---|---|
| Migration drops `allow_payload_environment` and `provisioning_key_id` while `provisionProjectTx` still projects and writes them (`db/queries.go:151,203,209,265,2912`). Onboarding would 500 immediately | Fixed. Columns kept; default flipped to `true` instead |
| Re-onboarding reuse is not buildable by deleting the revoke. The CLI never loads saved credentials before provisioning (`cli/src/onboard/provision.ts:145,204`) and the server always mints (`handler/onboard_provision.go:75,92`) since only the hash is stored | Fixed. Plan now says a rerun mints a second key and both stay live |
| `init()` catches config errors and returns silently unless `debug` (`packages/sdk/src/index.ts:24-30`), so the guard fails closed but invisibly | Fixed. That case logs unconditionally |
| Done-when expected 403 for a `pk` on `/incidents`. Session auth reads a cookie or Bearer only (`handler/auth.go:242`), so it is 401 | Fixed |
| `opslane_key_auth_total` was cited as the detection mechanism but had no work item | Fixed. Added as §8 |
| **Security:** the new lookup must return `allowed_origins` (`db/queries.go:342` → `handler/auth.go:208` → `handler/ingest_limits.go:88`). An empty list means allow every origin | Fixed. Called out explicitly |
| **Security:** a `POST /projects/{id}/api-keys` endpoint needs its own tenant check, since `RequireRoleIfCloud("admin")` checks role in the active org, not project ownership | Fixed by deletion. Both key routes cut |

Further cuts codex argued for, all taken: no environment backfill, no `CreateProject`
change (`CreateProjectEndpoint` calls `ProvisionProject`, which already creates
`production` at `db/queries.go:226`), no `ProjectKey("sourcemaps")` constructor, no key
CRUD routes.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 2 | clean | run 1: 8 proposals; run 2: cut to a credential slice |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | 3/10 → 9/10 as reviewed; dashboard then cut from scope |
| Eng Review | `/plan-eng-review` | Architecture & tests | 2 | clean | 23 issues, 6 critical, 0 open |
| DX Review | `/plan-devex-review` | Developer experience | 1 | clean | 4/10 → 8/10 |
| Outside Voice | `codex` | Independent 2nd opinion | 6 | clean | 6 passes; final pass found 2 blockers + 2 security omissions, all applied |

**CODEX:** six passes across two runs. Caught the rolling-deploy outage, the frozen-DDL
mismatch, the Vite plugin regression, and in the final pass the dropped-column 500, the
unbuildable reuse promise, the silent `init()`, and the `allowed_origins` regression.

**CROSS-MODEL:** 28/29 dimensions confirmed, 0 disagreements. Independent identical fixes
on one-pass middleware and on cutting the environment migration. Three criticals came from
a single voice and were each verified against source before acceptance: the key parser
breaking ~49% of minted keys, the rolling-deploy ingest outage, and the backfill clobber.
One reviewer claim rejected on inspection (`DEFERRABLE` semantics, where S0 was already
correct).

**VERDICT:** CLEARED — ready to implement. Scope reduced from 15 tasks and ~52 hours to a
credential slice of about a day.

NO UNRESOLVED DECISIONS
