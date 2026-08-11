# Design: every digest line is actionable

Date: 2026-08-10 · Status: for review · Author: pipeline investigation session (Abhishek + Claude)
Companion: `docs/plans/2026-08-10-actionable-pipeline.md` (task plan, v3, two adversarial review rounds) · `docs/research/2026-08-09-session-bucketing-competitive-notes.md` (competitive evidence)

## 1. The problem

On Aug 10 we shipped a customer digest whose flagship line read: "/assets/:id — 7 customers clicked and nothing happened (9 occurrences)." The customer could do nothing with it. Behind that line, every friction investigation in production had failed the same way: all 7 stored root causes are the literal string `placeholder` (one reads `placeholder while I continue reading`). The incident page renders that string to the customer as "Root cause: placeholder."

The cause is confirmed, not guessed. The investigation agent (`packages/worker/src/friction/investigate-friction.ts`) gets 8 turns (`MAX_TURNS`, line 9) to investigate an unfamiliar repo. The Langfuse trace for incident `cfaa3eb9` (trace `f928f7f6f9b850849b615d37cc82775c`) shows it spending all 8 turns on directory listings, never reading a file. On the final turn the code forces a verdict (`tool_choice: {type: 'tool', name: 'classify_friction'}`, lines 116-118), and the model, mid-exploration, emits filler. `parseResult` (line 164) accepts any non-empty string. The honest fallback at line 156 is unreachable because the forced call always returns something.

Two adjacent failures compound it. Error investigations produce real diagnoses (the same digest correctly blamed a race in `AuthWrapper.vue`), but medium and low confidence results park at `investigated` forever with no action path (issue #257), so the digest says "106 older issues still awaiting your review" with no way to act. And the digest renders internal adjudication text to customers: `classify.ts:119` writes "The investigation concluded the cause is external without rejecting …" into `reason_message`, and `slack_digest.go:176` prints `reason_message` verbatim.

A separate defect silently starves the friction pipeline of evidence. The friction bucket key is `sha256(signalType | selector | pageUrlNormalized)` where the TS normalizer (`fingerprint.ts`) keeps the URL origin. Atlassian Forge rotates its CDN subdomain on every customer deploy, so in production one page produced 14 buckets in 10 days, each capped at 1 identified user, while the merged page had 11 distinct users. Promotion requires 5 identified users in 7 days (`promotion.ts:25`), so this class of friction can never surface. The Go normalizer (`ingestion/priority/urlnorm.go`) is already host-free; prod shows the split: 521/524 friction groups keyed origin-full, 0/164 error groups.

## 2. What we know works (spike evidence)

We did not design this from theory. Three spikes on real production data:

1. **Fixed investigator.** Same model, changed harness (20-turn budget, repo file tree and route name in the prompt, an explicit out-of-turns instruction, filler rejection): 3 of 3 prod friction incidents got real, file-cited root causes (for example: the bridged React select in `AtlasSelect.vue:99` is keyed on an object, so options refreshes force a full remount and clicks land on a detached node).
2. **Fix leg.** We applied that diagnosis by hand to the customer repo: a 2-line fix plus a regression test. The test fails on the base commit (the select's DOM node detaches on an options rebuild) and passes with the fix; the full suite runs 669/669. The first version of that test passed on broken code because it probed the wrong DOM element; only the fail-first discipline caught it. That mistake is the strongest argument in this doc.
3. **Prod verification of the cutover machinery.** `041_friction_bucket_state.sql` keys bucket state by `(project, environment, fingerprint, rule_version, prompt_version)`, and `persist.ts` (lines 67-87) already supersedes or retracts old-version signals. A `RULE_VERSION` bump therefore isolates old from new buckets without rewriting history. This was checked against source after an external review claimed otherwise.

## 3. Goals and non-goals

**Goal (the bar):** if a line appears in a customer's digest, it carries either a verified fix or an investigation report the customer can hand to their coding agent. A replay link is supplementary, never the only action.

**Non-goals, deliberate:**
- No new signal types, no queue technology changes, no rewriting of historical friction incidents (the 521 origin-full groups age out; decision issue #311).
- No systemic-event correlation layer (mass silent breakage collapsing hundreds of buckets). The adjudication budget cap (`adjudication_call_budget`, upsert in `promotion-db.ts:6`) is the accepted backstop.
- No origin-aware grouping dimension unless a multi-domain-single-project customer appears. Every surveyed vendor keys groupings host-free (research doc, §3).

## 4. Requirements

| # | Requirement | Verified by |
|---|---|---|
| R1 | No degenerate verdict is ever persisted or rendered; investigations that cannot conclude persist a structured `incomplete` that is digest-ineligible | Unit test on verdict validation; prod query shows zero `placeholder`-class root causes after re-enqueue |
| R2 | Friction evidence accumulates across customer deploys (host-free keys) | CI fixture simulating rotated Forge origins yields one bucket; post-deploy, the prod Forge canary page accumulates across ≥2 rotations |
| R3 | Every investigation verdict carries mechanically verified file citations | Citation checker rejects a fabricated path/snippet in tests; unverifiable citations degrade the verdict to `incomplete` |
| R4 | A friction or error fix PR carries red/green proof: a declared failing test that fails on base and passes with the fix, compared by the harness, not prose | Harness test: a fix without the expected-failure contract cannot reach auto-merge |
| R5 | PR verification sections and incident evidence are generated from executed commands with not-run items listed at equal prominence | Golden PR-body fixture; grep proves no model prose in the verification section |
| R6 | Digest rows come only from a persisted readiness projection with a single writer | Formatter reads a `digest_ready` projection; test renders a digest from a DB with one ineligible and one eligible incident |
| R7 | Parked medium/low error investigations become "send to your agent" rows | #257's named cases produce validated briefs in the dev set |
| R8 | Customer copy contains no CSS selectors, no origin-full URLs, and no internal reasoning; templated paths are permitted only as fallback titles for unnamed routes | Golden rendered-digest fixture in CI |

## 5. System overview

The pipeline today, with the four intervention points (◆):

```mermaid
sequenceDiagram
    participant B as Browser SDK
    participant I as Ingestion (Go)
    participant W as Worker (TS)
    participant L as LLM stages
    participant D as Digest / Dashboard

    B->>I: rrweb chunks + telemetry + errors
    I->>I: group errors; store sessions; enqueue jobs (Postgres queue)
    W->>W: session_analysis: facts + friction signals ◆T1 host-free keys
    W->>L: adjudicate (fold or 5-users bucket)
    L-->>W: verdict (budget-capped, generation-locked)
    W->>W: promote -> error_groups(kind=friction) + one investigate job
    W->>L: investigate (repo clone) ◆T3 harness + validation
    L-->>W: verdict + evidence[] + agentTaskBrief
    W->>W: fix agent ◆T4 red/green contract
    W->>W: persist ledger + readiness ◆T5/T6 single-owner projection
    D->>W: SELECT digest-ready rows only
```

Two adjudication branches exist today and both are kept: the **fold path** (a friction signal within ±30 seconds of a same-session error is judged as that error's symptom and attaches to the error's incident; matching is by session and time, so T1's key change does not affect it) and the **bucket path** (standalone signals accumulate per fingerprint until 5 identified users in 7 days trigger one bucket-level judgment). This design's `evidence[]`/ledger contracts apply to the parent error investigation in the fold case. Everything asynchronous rides the existing Postgres job queue (`FOR UPDATE SKIP LOCKED`); nothing here adds infrastructure.

## 6. Component design

### 6.1 Identity contract (T1): the riskiest change

**What:** one versioned URL-normalization algorithm, Go behavior as the spec (hashbang routes, `:token` templating, 512-byte cap), origin dropped from the TS output, one golden fixture file (`test-fixtures/` JSON of `url → normalized`) consumed by both a Go test and a Vitest suite. `RULE_VERSION` bumps from 3.

**Why this way:** the alternative (rewriting stored fingerprints in place) breaks bucket history: watermarks, generation evidence, and incident attachments are fingerprint-keyed (`041_friction_bucket_state.sql`). Version cutover costs nothing because the schema already namespaces by `rule_version`.

**Why it is risky:** the route table (`route_map`, PK `(project_id, pattern)`) currently holds both dialects (38 of 50 prod patterns are origin-full), and a rolling deploy can have old workers writing origin-full rows while the migration runs. The deployment is therefore expand/contract: (1) dual-read lookups ship first (try path-only, then origin-full); (2) canonical-writing code deploys and old workers drain; (3) an idempotent migration canonicalizes `route_map`, with every collision shape handled deterministically and name conflicts quarantined to a `route_map_migration_conflicts` audit table (two origin-full twins with no path-only row: higher tier wins, earliest `created_at`, conflict recorded); (4) the friction `RULE_VERSION` cutover; (5) canonical-writes-only enforcement.

### 6.2 Investigation harness (T3/T3b)

**What:** the spike harness, productionized. Exploration budget separate from a dedicated classification turn; classification is requested only after minimum evidence (≥1 file read, ≥1 citation), otherwise the run persists `incomplete`. The system prompt carries the repo file tree and the route name, fenced as untrusted data. Verdict validation is schema-level: outcome enum, root-cause structure, ≥1 citation per diagnosis, brief fields, explicit uncertainty. Citations are checked mechanically against the checkout at its exact commit (path inside repo, snippet matches) before persistence. `classify_friction` gains:

```ts
evidence: Array<{ path: string; detail: string; symptomLink: string }>;
agentTaskBrief: string; // self-contained markdown: symptom, files, cause, change, verification
```

Prompt caching goes on (the trace shows `cache_read_input_tokens: 0` on all 8 calls today, ~170k uncached tokens per investigation). The investigation records `investigated_commit` (the clone's HEAD); citations are verified against exactly that commit. The model is `claude-sonnet-4-6` (`investigate-friction.ts:8`), the same model the spikes used; the design claims harness-dependence, not model-dependence, but names the model so cost and behavior are reproducible.

**Why this way:** the failure was not model quality; it was a harness that forced a verdict from an agent that had not finished orienting, then accepted anything. The spike shows the same model producing cited diagnoses when the harness stops doing that. The error lane (T3b) gets the same `evidence[]`/brief contract because the bar covers both lanes.

**Ships with quarantine:** the 7 existing placeholder artifacts are marked digest-ineligible in the same release, and their re-investigation runs report-only. Report-only is a job attribute, not timing: the re-enqueued jobs carry `triggered_by = 'reinvestigate_report_only'`, and the investigate handler never calls the fix-job creation path for that attribution. This is enforced in code, so the guarantee survives T4-T6 shipping later.

### 6.3 Fix verification (T4) and the ledger (T5)

**What:** the fix agent must prove the bug before fixing it, in isolated commits (never stash/pop): a test-only patch on the exact base commit, whose failure matches a declared expected-failure contract (test identifier, expected assertion) compared by the harness; the same test passes with the fix; the suite discovered and ran a non-zero test count. The ledger records executed facts only: command, commit identity, dirty flag, discovered/passed/failed/skipped counts, truncation/timeout flags, and not-run items at equal prominence. Behavior-coverage statements are labeled asserted (model-claimed) unless tied to test identifiers.

**Commit drift:** the fix agent starts from the repo's current default-branch HEAD, which may be newer than `investigated_commit`. Before writing any fix it re-verifies the diagnosis citations against its own HEAD; if any citation no longer matches, the fix job stops and re-enqueues an investigation instead of patching against a stale diagnosis. The ledger records both commits, and the red/green base is always the fix-time HEAD.

**Why this way:** in the spike, a plausible regression test passed on broken code. "Tests pass" is not evidence a bug existed or was fixed; a reproduced failure is. And the verification section of the Aug 10 digest leaked internal reasoning precisely because prose and record were the same field; the ledger separates them (extends #273).

### 6.4 Readiness and gating (T6)

**What:** two separate records, never one score. Investigation state (symptom reproduced? citations verified? evidence coverage) and fix state (red/green passed? suite scope? environment fidelity? pre-existing-failure deltas?). Auto-merge requires hard predicates: citations verified AND red/green passed AND full suite green AND zero unexplained pre-existing-failure deltas AND the project's `auto_fix` opt-in. Everything else (environment fidelity, asserted coverage, breadth) is explicitly informational, feeding display tiers and human review only. A single `digest_ready` projection, owned by the worker persistence layer, is the only thing formatters read.

**Why this way:** a single ordinal confidence score is gameable (an artificial test that toggles with the patch would outrank broad verification) and collapses dimensions reviewers need separately. Both external review rounds converged on this.

**The projection, concretely:** a table `digest_readiness (incident_id PK, project_id, status, reason, updated_at)` where `status IN ('eligible','ineligible','pending')`. Three writers only, all in the worker persistence layer, at defined moments: investigation persist (verdict validated and citations verified → `eligible` for report rows; `incomplete` → `ineligible` with reason), verification persist (red/green recorded → fix-row eligibility), and the T3 quarantine migration (existing degenerate artifacts → `ineligible`). The digest query joins this table; the dashboard incident page reads the same status: an `ineligible`/`pending` incident renders an honest state ("Investigation has not verified a cause yet" plus replay links and signal counts) and never renders `root_cause`. That covers both customer surfaces, including the one that displayed "placeholder".

**Pre-existing-failure predicate, machine-evaluable:** the ledger records failing-test identities on the base run and the fix run. The auto-merge predicate is set containment: every test failing with the fix also failed on base (zero new failures). There is no "explained delta" path in v1; a new failure blocks auto-merge, full stop.

### 6.5 Digest v1.1 (T9a/b/c) and convergence (T10)

**What:** three slices so value ships as it becomes true. T9a (after T3/T3b + quarantine): summary card, plain-language rows, one substantive action per row, reach-ranked queue. T9b (after T2): route-name titles ("Edit asset", from `route_map.name`, snapshotted at promotion); a pattern the classifier has not named yet falls back to the templated path (`/assets/:id/edit`) until the next route-map sweep names it. T9c (after T4-T6): "Review fix" rows backed by red/green records only. Impact labels render as judgment-based until session-facts coverage exists (backfill, T8b), then cite completion data. Copy register is enforced by a golden rendered-digest fixture, not review vigilance.

Convergence (T10) is internal-first: overlap of root-cause citations only, one repo and commit lineage, low-information files excluded (lockfiles, manifests, barrels, generated code), ≥3 distinct incidents and ≥3 distinct users in 14 days, no transitive expansion. A cluster reaches customers only after human precision review, and as a synthesized cluster brief. The known false-negative (a Vue↔React bridge failure citing disjoint files per side) is a stretch case, not acceptance.

### 6.6 Session facts (T8a/T8b)

Filters for `activity_class` / `coverage` / failed requests (the query already returns these; `SessionFilters` in `sessions_read.go` just cannot filter on them), with "not analyzed" as a distinct state. Backfill hardening is parallel work; only the production run is gated (closed cohort, terminal reason codes, idempotent re-run, cost extrapolated from a 1k-session batch first). Today 2,822 of 131,453 sessions have facts; 3,518 of 3,527 active friction signals have none, which is why impact labels start as judgment-based.

## 7. Milestones

| M | Delivers | Exit criterion (testable) |
|---|---|---|
| M1 | T3 + quarantine + report-only re-enqueue | Prod has zero digest-eligible degenerate root causes; ≥5 of 7 re-investigated incidents produce validated, cited reports |
| M2 | T4.0 contracts; T3b/T4/T5/T6 in parallel | Contract schemas merged; error-lane briefs validate on #257's cases; red/green harness rejects a fix lacking the expected-failure contract |
| M3 | T1 expand/contract release | CI origin-rotation fixture green in both languages; zero `^https?://` route patterns; conflicts present in audit table, none silently dropped |
| M4 | T9a report-row digest | Golden digest fixture green; a rendered prod digest shows an action on every row and no internal prose |
| M5 | T2 + T9b; T9c when M2 lands | Titles from route names on new incidents; "Review fix" rows appear only with red/green records |
| M6 | T8a filters; T8b run on explicit go | Closed-cohort backfill report: 100% analyzed or terminally classified with reason codes; filters answer "active sessions with failed requests this week" |
| M7 | T7 eval loop; T10 internal | Paired baseline/candidate run + human sign-off required on prompt change (enforced by process doc + CI check on eval artifact); convergence clusters visible internally |

## 8. Testing and validation

- **CI:** golden normalizer fixtures (both languages); verdict-validation unit tests; citation-checker tests; origin-rotation bucket fixture; golden PR-body and rendered-digest fixtures; readiness-projection query tests.
- **Live (bounded):** report-only re-enqueue of the 7 incidents (M1); prod Forge canary observation post-M3; the 1k-session backfill cost batch pre-M6.
- **Eval (T7):** deterministic checks in CI catch malformed output, degeneracy, and invalid citations. They do not catch semantic quality regressions; that is what the paired dev-set runs with human sign-off are for, and they are a smoke test, not statistics, until the blind holdout triggers (dev set ≥30 incidents or 2026-10-01).

## 9. Risks

| Risk | Mitigation | Residual |
|---|---|---|
| T1 rolling-deploy write races recreate origin-full rows | Expand/contract sequence; dual-read window; drain before migrate; idempotent migration | Highest-risk task in the plan; both review rounds agree |
| Collision policy loses customer-visible route names | Deterministic policy per shape + durable conflict audit table | Manual resolution queue can accumulate |
| Investigation cost grows with bigger budgets | Prompt caching (currently zero hits); existing daily adjudication caps; investigations are per-promotion, bounded by the 5-user threshold | Cost per investigation rises even so; tracked in T7 metrics |
| Model games the red/green contract with an artificial test | Harness-compared expected-failure contract; symptom-linkage fields; human review before merge outside `auto_fix` | Linkage quality is rubric-sampled, not mechanical; accepted gap |
| Convergence detector clusters junk | Root-cause-citations-only, exclusion list, no transitive expansion, internal-first with human review | Detector precision unevaluated until internal runs accumulate |
| Backfill vs retention: expired chunks | Terminal classification with reason codes; never infinite retry | Some sessions permanently unanalyzable; counted, not hidden |

**The honest caveat:** this design cannot make verification fully mechanical. Whether a citation truly explains the symptom, and whether an agent brief can be executed as written, are judged by sampled human rubric (T7), not by code. Until the blind holdout exists, our evaluation of the LLM stages is a disciplined smoke test. We consider shipping with that stated better than implying a guarantee the system does not have.

## 10. Alternatives considered

- **Fingerprint on selector only (Sentry's model).** Rejected: survives deploys by construction but collapses identical selectors across different pages (`button.btn-primary` everywhere becomes one issue) and forks on CSS-module churn. Our `type|selector|path` key keeps page identity; the research doc (§2) documents Sentry's trade-off.
- **In-place rewrite of stored fingerprints and groups.** Rejected: bucket state, generation evidence, and incident attachments are fingerprint-keyed; rewrite risks orphaned watermarks and detached incidents. Version cutover is free because the schema already namespaces by rule version.
- **Single confidence score driving autonomy.** Rejected after review round 1: collapses diagnosis correctness, test relevance, and verification scope into one gameable number. Hard predicates + separated states instead.
- **Ship the digest redesign first (it demos well).** Rejected: formatting over ungraded work. The digest's claims must be produced by the verification stack, so report rows ship first (T9a) and fix rows wait for red/green (T9c).
- **Full evaluation program (blind holdout, paired stats) from day one.** Rejected as right-sizing: at ~10 usable incidents the holdout is theater. Layered instead, with a dated trigger so deferral cannot be permanent.
- **Bigger model / more turns as the whole investigation fix.** Rejected: the trace shows a harness defect (forced verdict + accept-anything parsing), and the spike proves the same model succeeds under a corrected harness.

## 11. Review asks

The single riskiest decision is T1's expand/contract cutover; attack that first. Second: whether report-only re-enqueue (M1) is acceptable to run before the ledger (T5) exists, given quarantine ships in the same release. Third: whether the auto-merge predicate list in 6.4 is complete.
