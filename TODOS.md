# TODOS

Deferred work with enough context to pick up cold. Add items with What / Why / Pros / Cons / Context / Depends on.

---

## Polish the action-scope settings section to match the page's idiom

**What:** Five review findings on the new "Limit automatic error investigation" section in `packages/dashboard/src/views/Settings.vue` and one copy issue elsewhere: (1) the enable control is a bare checkbox while the page's enable/disable idiom is the styled `role="switch"` used by "Draft PRs for unverified fixes"; (2) the section has no `<h3>` heading, so its title lives inside the checkbox label and is invisible to screen-reader heading navigation; (3) non-admins see disabled controls with no "Only admins and owners can change this" hint, unlike sibling sections; (4) the section requires an explicit "Save automation scope" click while every sibling setting saves on change, with no dirty-state indicator; (5) `IncidentLifecycle.vue:13` says "Ready for investigation." for status `new`, which is now misleading for dormant out-of-scope groups that will not be investigated until an in-scope event arrives.

**Why:** All cosmetic or copy-level; none block the feature. Left as-is the section works but reads inconsistent, and the lifecycle copy can mislead scoped-project users into waiting for an investigation that is deliberately not coming.

**Pros:** Each item is small and independent; (1)–(3) are direct pattern copies from the same file.

**Cons:** (4) is a real interaction-model decision (auto-save vs deferred save for a multi-checkbox control); (5) needs project scope state threaded into a component that today only knows the status string.

**Context:** Found during `/review` of the environment-scoping branch on 2026-08-12 (design specialist findings). The unsaved-edits-wiped-by-sibling-saves bug from the same review was already fixed in that branch (`actionScopeServerState` guard in Settings.vue).

**Depends on:** Nothing.

---

## Gate session automation by environment (action scope follow-up)

**What:** `session_analysis` enqueue sites (`packages/ingestion/db/sessions.go:381` and `:609`, `packages/ingestion/db/sessions_read.go:205`) do not consult `project_action_environments`, so scoped projects still get session analysis — and, under `auto_fix`/`auto_fix_ux` friction autonomy, potentially auto-PRs — from out-of-scope environments.

**Why:** A customer who scopes automation to `production` reasonably expects staging sessions to stop spending LLM budget. V1 deliberately narrows the promise instead (Settings copy says "automatic error investigation"; `docs/contracts/action-scope.md` § "What the scope does not cover" documents the exclusion), but the cost leak is real.

**Pros:** Closes the gap between the intuitive reading of the setting and its behavior; sessions already carry `environment_id`, so the gate is a join against the allowlist mirroring `eventInActionScope`.

**Cons:** Session-close paths are batch UPDATE...INSERT statements, so the gate must be folded into set-based SQL, not a per-row helper; needs its own dormant/activation semantics decision (probably none — just skip enqueue).

**Context:** Red-team finding from `/review` on 2026-08-12. The error-pipeline gate (S3) landed in the environment-scoping branch; this is the S4-adjacent follow-up. A cross-model merge review added a second reason to prioritize S4: C2's auto-fix policy gate (`getGroupImpactBar`) reads affected-user counts that include out-of-scope occurrences, so a staging identified user can help an in-scope production incident clear the impact bar (`docs/contracts/action-scope.md` § "What the scope does not cover" documents this).

**Depends on:** Environment-scoping branch landing (migration 049 provides the allowlist table).

---

## Update Sonnet 5 pricing when the introductory rate expires on 2026-08-31

**What:** Change `claude-sonnet-5` from the introductory `{ input: 2, output: 10, cacheWrite: 2.50, cacheRead: 0.20 }` to list `{ input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 }` in BOTH pricing tables: `packages/worker/src/harness/agent-loop.ts` (`MODEL_PRICING`) and `packages/worker/src/investigate.ts` (`MODEL_PRICING`). Optionally collapse the two tables onto the exported `pricingFor()` so the next rate change is a one-file edit.

**Why:** After 2026-08-31 every investigation's `job_usage.cost_usd` understates real spend by ~33%, and the ledger is insert-only by design — wrong rows can never be corrected. The admin "Spend 7d" and "Cost / merged PR 7d" tiles present these numbers as dollars, and the investigation budget ceiling also enforces against the stale rate.

**Pros:** Two-line change if done on time; keeps the immutable ledger honest from the switchover day.

**Cons:** None — the only risk is forgetting, which is what this entry exists to prevent.

**Context:** Flagged during `/review` of the job-usage-ledger branch on 2026-08-09 (Codex ranked it the top finding). Both tables carry a "runs through 2026-08-31" comment; nothing else enforces the date.

**Depends on:** Nothing.

---

## Replace full-list polling on the issue list with a count or since-timestamp endpoint

**What:** `ActivityFeed.vue` (renamed to `IssuesList.vue`) polls `listIncidents()` every 30 seconds and uses only `latest.length`. Replace it with a lightweight endpoint that returns a count, or a `since=<timestamp>` query that returns only what changed.

**Why:** Every open dashboard tab fetches the complete incident payload — titles, fingerprints, per-environment rollups, evidence records — twice a minute, then discards all of it except one integer. The comparison is also the wrong signal: it only fires when the list *grows*. If one issue resolves and one new one arrives inside the same 30-second window, the count is unchanged and the user is told nothing happened.

**Pros:**
- Cuts steady-state dashboard traffic to a fraction of current volume, per tab, per user.
- Fixes the missed-replacement case, so the "N new issues" banner becomes trustworthy.
- Makes it safe to shorten the poll interval later if we want fresher data.

**Cons:**
- Requires a new Go handler in `packages/ingestion`, so it is no longer a dashboard-only change.
- A `since` variant needs a stable ordering key and careful handling of the filter set, which the current naive length compare sidesteps.

**Context:** Found during `/plan-eng-review` of `docs/plans/2026-07-22-issue-list-polish.md` on 2026-07-22. The polling code is `ActivityFeed.vue:73-82`:

```ts
async function pollForNew() {
  const latest = await listIncidents(projectId.value, currentFilters.value);
  if (latest.length > incidents.value.length) {
    newIncidentCount.value = latest.length - incidents.value.length;
  }
}
```

It was deliberately left alone by the issue-list polish plan, which is scoped dashboard-only (no Go, no migrations). Start at that function and at the read API in `packages/ingestion/handler/read_api.go`. Note the poller must respect `currentFilters` — a count endpoint needs the same filter parameters `listIncidents` takes, or the banner will report issues the user has filtered out.

**Depends on / blocked by:** Nothing. Independent of the issue-list polish plan; can land before or after either PR.

---

## Plumb the worker's GitHub host to the dashboard so Enterprise PR links render

**What:** The dashboard's `safeUrl` host allowlist for `pr_url` accepts `github.com` and `www.github.com` only. Self-hosted GitHub Enterprise PR links therefore render as plain text instead of links. Expose the worker's configured GitHub host to the dashboard and add it to the allowlist.

**Why:** The worker already supports a custom host through `OPSLANE_GITHUB_URL` (`packages/worker/src/repo-clone.ts:27`), so an Enterprise install produces perfectly valid `pr_url` values that the dashboard then refuses to link. The user sees a status badge that looks clickable-adjacent and does nothing, with no explanation.

**Pros:**
- Enterprise installs get working PR links, which is the single most valuable click on the issue list.
- Removes a silent degradation that is very hard to diagnose from the UI.

**Cons:**
- Needs a config surface the dashboard can read (an API-served settings value or a build-time env var), which is a small new contract.
- A misconfigured or attacker-influenced host value would widen the allowlist, so the plumbing has to treat it as trusted config, not user input.

**Context:** Found during `/codex review` and confirmed in `/plan-eng-review` of the issue-list polish plan on 2026-07-22. The original plan used `hostname.startsWith('github.')` to try to cover Enterprise; that was rejected because it also accepts `github.evil.com`. Exact hosts were chosen instead, with Enterprise explicitly out of scope. Start at `safeUrl` in `packages/dashboard/src/utils.ts` and the allowlist constant beside it.

**Depends on / blocked by:** The issue-list polish PR 1, which introduces the allowlist parameter on `safeUrl`.

---

## Add tests for `safeUrl`'s four pre-existing call sites

**What:** `safeUrl` in `packages/dashboard/src/utils.ts` had zero tests despite guarding four render sites that bind untrusted values to `href`. The issue-list polish plan adds tests for the function itself; this item covers the call sites.

**Why:** `IncidentDetail.vue:406,422`, `AdminView.vue:324`, `IncidentConclusion.vue:20`, and `SetupWizard.vue:361` all bind a sanitized URL to an `href`. Nothing asserts that any of them actually calls the sanitizer. A future refactor could drop the call and no test would notice.

**Pros:**
- Locks the sanitizer into the render path so it cannot be silently removed.
- Cheap: each is a mount-and-assert-href test in an existing test style.

**Cons:**
- Four more component tests to maintain, in files otherwise unrelated to the issue list.

**Context:** Found during `/plan-eng-review` on 2026-07-22. PR 1 of the issue-list polish plan hardens `safeUrl` and adds unit tests for the function, plus a regression test proving `http:` trace URLs still pass (self-hosted Langfuse via `LANGFUSE_BASE_URL`, `docker-compose.yml:119`). The call-site tests were scoped out to keep PR 1 focused.

**Depends on / blocked by:** The issue-list polish PR 1.

---

## Write DESIGN.md and correct the stale decision claiming it exists

**What:** The design system exists only as CSS custom properties in `packages/dashboard/src/styles/tokens.css` ("Forensic Ledger": paper `#fbfaf7`, ink `#24211d`, ember accent `#b74420`, four status hues). There is no DESIGN.md. A stored gstack decision from 2026-07-20 states "DESIGN.md written at repo root" — that file does not exist.

**Why:** Every design review has to reverse-engineer the system from `tokens.css` before it can judge anything against it. `/plan-design-review` rated design-system alignment 6/10 partly because there is no document to align to. The stale decision is worse than the gap: it tells a future session the doc exists, so it will not go looking in the right place.

**Pros:**
- Design reviews calibrate against a stated system instead of inferring one.
- Gives status-hue contrast targets a home — a prior learning records that two status chips shipped failing WCAG AA because they were eyeballed against the page background rather than their own tint.
- `/design-consultation` can produce it in one pass.

**Cons:**
- A design doc that drifts from `tokens.css` is worse than none; it needs an owner.

**Context:** Found during `/plan-design-review` of `docs/plans/2026-07-22-issue-list-polish.md` on 2026-07-22. Start from `tokens.css` — it is already the source of truth and is enforced by `tailwind-token.test.ts`. Also supersede the stale decision so future sessions stop believing the file exists.

**Depends on / blocked by:** Nothing.

---

## Decide how long issue titles are clamped in the list

**What:** Error titles render with no line clamp. Variant C's mockup shows them wrapping to two lines. A 300-character error message would make a single row fill the viewport.

**Why:** Row height variance breaks vertical scan rhythm, which is the whole point of a dense triage list. It also interacts with the stacked mobile layout, where a long title plus a meta line could push a single issue past a phone screen.

**Pros:**
- Predictable row heights make the list scannable.
- A clamp with a `title` attribute keeps the full text reachable on hover.

**Cons:**
- Truncating an error message can hide the part that identifies it, since the distinguishing detail is often at the end.

**Context:** Surfaced in `/plan-design-review` Pass 7 on 2026-07-22 and deliberately left unresolved. The relevant code is the row's `<router-link>` title in `IncidentLedgerRow.vue`. Note the tension: clamping at 2 lines is good for rhythm, bad for a `TypeError: Cannot destructure property 'name' of 'props.user.profile' as it is null.` where the useful part is the tail.

**Depends on / blocked by:** The stacked mobile layout (Design decision D6), which should use the same clamp.

---

## Bring Settings and Admin selects up to the 44px touch minimum

**What:** Selects on `/settings` and `/admin` measure 30px tall. The sanctioned `ui/SelectField.vue:42` uses `min-h-10 max-md:min-h-11` (40px desktop, 44px touch), and the issue-list filters were brought to that in the polish work. These were not.

**Why:** 30px is below the 44px minimum touch target. On a phone these are hard to hit accurately, and the inconsistency means the same control renders two different sizes depending on which page you are on.

**Pros:**
- Consistent control sizing across the app.
- Removes a real accessibility gap on two pages.

**Cons:**
- Taller controls change the vertical rhythm of both pages, so the surrounding spacing may need a look.

**Context:** Measured during `/qa` on 2026-07-23 against a live build: `/settings` has one 30px select, `/admin` has 30px and 40px selects. These pages were in scope for the chevron padding fix (Task 1 of the issue-list plan) but not for the touch-target fix, which design decision D8 scoped to the issue-list filters only. Pre-existing, not a regression. The cleanest fix is probably migrating them to `SelectField` rather than hand-adding classes.

**Depends on / blocked by:** Nothing.

## Revisit member-level onboarding provisioning in cloud

**What:** `POST /api/v1/onboard/provision` is admin-gated in cloud (`RequireRoleIfCloud("admin")`, `packages/ingestion/handler/routes.go:113`). Decide deliberately whether org members should be able to self-provision.

**Why:** The milestone 0.5 plan (docs/plans/2026-07-22-milestone-0.5-account-provisioning.md, line 24) settled the opposite — "no admin gate, login + org membership only" — to enable bottom-up adoption (any teammate tries Opslane without pinging an admin). Commit e365003 reversed that as a security hardening with no written rationale; the integration test now asserts member→403. If bottom-up adoption becomes the growth motion, this gate silently blocks it.

**Pros:** members can adopt Opslane solo; matches the original product decision. **Cons:** provisioning mints/rotates a production key — member-level access widens that surface; sibling key routes are admin-gated.

**Context:** Found during the 2026-07-24 /plan-eng-review of Phase 2 (onboarding-10x). The CLI now surfaces a typed `NotAuthorizedError` with "ask an org admin" remediation, so the failure is at least honest. Self-hosted OSS is unaffected (`RequireRoleIfCloud` is transparent there). Re-decide with real cloud data on who actually runs `opslane onboard`.

**Depends on / blocked by:** cloud usage data; a product call, not an eng task.

## SDK: recover from a 409 on /sessions/init instead of never reporting

**What:** When the browser SDK holds a stored session identity from a previous project (localStorage on the same origin) and the app is re-onboarded to a NEW project, `POST /api/v1/sessions/init` returns 409 repeatedly and the SDK never reaches `app_reporting`. It should treat 409 as "discard stored identity, start a fresh session."

**Why:** Found live during Phase 2 /qa (2026-07-24): two onboarding runs against the same fixture origin — second run's phone-home 409'd until site storage was cleared manually. Real-world shape: a dev re-onboarding an app to a different org/project, or shared localhost origins across projects.

**Pros:** onboarding "waiting for your app" can't stall on stale browser state. **Cons:** touches the MIT SDK's session lifecycle; needs care not to discard identity on transient 409s.

**Context:** server rejects at `handler/session.go` (project mismatch between API key and stored session); SDK side is the browser package's session-init path. Workaround: clear site storage / incognito window.

**Depends on / blocked by:** nothing; SDK-side change.

## Shorten the scrubber's 30-second eligibility grace

**What:** Reduce the 30s grace in `ClaimUnscrubbedChunks` (`packages/ingestion/db/sessions.go:310`) now that no presigned upload policy exists.

**Why:** The number was chosen to outlive `chunkUploadPolicyTTL` so a replayed presigned POST could not overwrite an already-redacted chunk with raw bytes. Issue #194's fix deletes presigned chunk uploads entirely — the browser now posts to ingestion, which writes to storage itself — so that race cannot happen. Until the grace shrinks, every chunk sits unredacted in storage for 30 seconds longer than it needs to.

**Pros:** raw user input spends measurably less time unscrubbed in the bucket — a real privacy improvement, and the mechanism it guarded against no longer exists. **Cons:** privacy-sensitive timing; deserves its own change with its own verification rather than riding along in a delivery-path rewrite.

**Context:** Surfaced during the 2026-07-24 /plan-eng-review of #194. The reasoning is restated in three places (`main.go:206-210`, `scrubber/scrubber.go:34`, `scrubber/interval_test.go:9`); the #194 PR corrects those comments to describe the real invariant but deliberately leaves the number alone. Start by confirming nothing else depends on the 30s value.

**Depends on / blocked by:** #194 landing.

## Decide the fate of ReplayInit and the legacy /api/v1/replays route

**What:** Either exercise `ReplayInit`'s presigned PUT path against a real browser and R2, or delete it along with the legacy one-shot replay route.

**Why:** `handler/replay.go:155` hands the browser a presigned PUT URL, and the current SDK never calls `/api/v1/replays` — grep of `packages/sdk/src` finds no reference. After #194 it is the last direct browser-to-storage upload in the product, and the only one whose browser CORS behaviour against R2 is unverified. `replay.go:231` already carries a comment conceding the browser often cannot PUT directly, with an inline fallback. This is the same shape as #194: a storage path that works everywhere it is tested and fails only in a real browser against real R2.

**Pros:** removes the last untested storage path, or proves it works before a customer finds out. **Cons:** `test-e2e/replay-contract.test.ts:164` pins "keeps the legacy one-shot init route alive for older SDKs", so deleting it means deciding that contract is over.

**Context:** Surfaced during the 2026-07-24 /plan-eng-review of #194. With no SDK builds deployed to real users, "older SDKs" may mean nobody at all — check before assuming the contract has consumers. R2 bucket CORS is also unconfigured as far as this repo can tell; if the path is kept, that is a prerequisite.

**Depends on / blocked by:** nothing.

## Give the ingestion HTTP server read/write/idle timeouts

**What:** Replace the bare `http.ListenAndServe` at `packages/ingestion/main.go:237` with a configured `http.Server` carrying `ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout` and `IdleTimeout`.

**Why:** Without timeouts a slow or stalled client holds a connection and its goroutine indefinitely, which is a cheap way to exhaust a replica. Standard hardening that protects every endpoint at once.

**Pros:** small diff, no behaviour change for well-behaved clients, removes a whole class of resource exhaustion. **Cons:** timeouts sized too tightly break legitimate slow uploads — and #194 raises the largest accepted body to 5MB, so the write timeout must accommodate that over a bad mobile connection.

**Context:** Raised by the Codex outside voice during the 2026-07-24 /plan-eng-review of #194. Pre-existing and unrelated to that bug, but #194 increases the largest body ingestion accepts, so pick the numbers after that lands. `ReadHeaderTimeout` is the safe one to set aggressively; `ReadTimeout` needs headroom for chunk uploads.

**Depends on / blocked by:** size `ReadTimeout` after #194 lands.

---

## Consume a pre-existing `//# debugId` stamped by another build plugin

**What:** Teach the Opslane Vite plugin to detect a debug ID already stamped into a chunk and its map by `@sentry/vite-plugin` (or `sentry-cli sourcemaps inject`) and use that ID as the join key instead of stamping its own.

**Why:** "Already running Sentry" is the most likely state of a qualified prospect. Today they must add a second build plugin, mint a second credential, and wire a second CI secret before Opslane resolves a single frame. Reading the ID they already have turns onboarding into "no build changes at all," which is a materially better story than editing `vite.config.ts` and minting a key.

**Pros:**
- Removes the entire build-configuration step for anyone already emitting debug IDs.
- Costs roughly one branch in the plugin, not a new subsystem.
- Makes Opslane composable with the incumbent rather than mutually exclusive with it.

**Cons:**
- Contract-incompatible as frozen. S0 §6 requires the claimed ID to equal the server's recomputed canonical hash, and Sentry's IDs are random UUIDs, so every upload would return `409 debug_id_mismatch`. Adopting this needs a deliberate contract change: a second, non-content-derived ID class with its own uniqueness and conflict rules.
- Two ID classes means two code paths in the server's immutability logic, which is exactly where the design's `409` guarantees live.

**Context:** Surfaced by the Claude CEO voice (finding F9) during `/autoplan` review of `docs/plans/2026-07-30-s2a-debug-ids-implementation.md` on 2026-07-30. The frozen algorithm is `docs/design/2026-07-29-keys-sourcemaps-s0-contracts.md` §6; the conflict rules are §6 and §8. Start by deciding whether a `debug_id_source` discriminator (`content_hash` vs `external`) is worth the branching in the conflict path — if it is, the plugin change is small.

**Depends on / blocked by:** S2b (the upload and conflict path this would have to branch). Requires reopening the S0 §6 contract, so it cannot land inside S2a.

---

## Verify no SRI or integrity manifest disagrees with post-`generateBundle` bytes

**What:** Confirm that nothing in the build pipeline — Vite's `build.manifest`, an SRI plugin, or a downstream consumer — computes a hash or byte length before `generateBundle` that the debug-ID prelude then invalidates.

**Why:** Measured during the `/autoplan` review: Rollup does not recompute a chunk's content hash after `generateBundle` mutates `chunk.code` (verified on Vite 6.4.3, 7.3.6, 8.1.5). The filename stays honest because the prelude is a pure function of the chunk, but any *other* pre-computed integrity value would not. A wrong SRI hash is a hard load failure in the customer's browser, with no Opslane error to report it because the page never runs.

**Pros:**
- Rules out a failure mode that is invisible in our own fixtures and fatal in a customer's app.
- Cheap: it is a check, not a build.

**Cons:**
- Cannot be proven exhaustively for every downstream consumer; the check bounds the risk rather than eliminating it.

**Context:** Raised as a sub-point of Codex's blocking finding 1 during `/autoplan` on 2026-07-30, and folded into V0's exit criteria in `docs/plans/2026-07-30-s2a-debug-ids-implementation.md`. Related consequence worth recording: the map's root `file` member carries the content-hashed filename and participates in the debug-ID hash, so an unrelated filename change moves the debug ID even when `mappings` are byte-identical.

**Depends on / blocked by:** Nothing; it is part of V0. Listed here so it survives if V0 is compressed.

## Give contributors a command that allocates worktree stack ports instead of a checklist

**What:** `scripts/worktree-stack.sh` — derive a deterministic port triple from the
worktree directory name, write `.env`, and print the export block a smoke needs.
The runnable block added to `AGENTS.md` under `## Verification` is its spec;
extracting it is mechanical.

**Why:** issue #268 made collision avoidance *possible* but left allocation manual.
Two agents working in parallel can still pick the same ports, and a contributor who
forgets the block hits the original failure. Both the CEO and DX reviews (2026-08-04
`/autoplan`) independently called the documented block "unenforceable ritual" versus a
mechanism; it was kept as a block because the script needs the env vars as substrate
and the block doubles as the spec.

**Context:** The block must stay in sync with the script — host-side tests read the
URLs (`DATABASE_URL`, `INGESTION_URL`, `MINIO_ENDPOINT`, `REPLAY_STORE_*`), not the
ports, and Go DB tests `t.Skipf` rather than failing when the DSN is unreachable
(`packages/ingestion/db/testhelper_test.go:11`). Setting a port without its URL is a
green test run that tested nothing.

## Stop publishing Postgres to the host by default

**What:** Move the `postgres` published port behind a dev/CI profile or an override
file, so `docker compose up` for a self-hoster publishes only ingestion.

**Why:** `docs/quickstart/self-host.md` routes every psql through
`docker compose exec -T postgres`, so a self-hoster never uses the published 5434.
It exists for host-run Go tests and `test-e2e` only — a contributor need billed to
the user's port budget and prerequisites list. Removing it deletes a port from the
quickstart rather than adding a variable to work around it.

**Context:** Raised by both voices during the 2026-08-04 `/autoplan` review and
deferred as a topology change, not a port fix. It breaks two CI jobs as written:
`ingestion-go` (host `go test` against `localhost:5434`, `ci.yml:119-133`) and
`e2e-keyless` (`ci.yml:361`). Those need a profile opt-in before the default can
change. `scripts/check-compose-ports.mjs` encodes the current contract and would
need its `PUBLIC_SERVICES` set revisited.

## Document the remote self-host story for REPLAY_STORE_PUBLIC_ENDPOINT

**What:** `docker-compose.yml` now lets `REPLAY_STORE_PUBLIC_ENDPOINT` be set
explicitly (it otherwise follows `OPSLANE_MINIO_HOST_PORT`). Nothing tells a
self-hoster running on a VPS or LAN box that they must set it.

**Why:** ingestion signs browser-facing presigned replay uploads against this origin
(`packages/ingestion/main.go:48`). The default names `localhost`, which is the
*user's own machine* when the browser is not on the Docker host — so replay upload
fails for every remote self-host install, silently, with no Opslane error because the
request never reaches Opslane.

**Context:** Found during the 2026-08-04 `/autoplan` review by both CEO voices. That
review made the value overridable, which is the prerequisite; the docs and a MinIO
CORS/origin story are the remaining work. Note MinIO must also be reachable from the
browser, which interacts with the loopback bind added at the same time
(`OPSLANE_INFRA_BIND_ADDR`).
