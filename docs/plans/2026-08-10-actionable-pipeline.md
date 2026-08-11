# Plan: every digest line is actionable

Date: 2026-08-10
Status: v3 — final after two adversarial review rounds (Codex; 22 findings round 1, 16 round 2, all dispositioned in the revision log)
Evidence base: read-only prod spikes (Aug 9–10), the placeholder-investigation diagnosis (Langfuse trace `f928f7f6f9b850849b615d37cc82775c`), a live fix-leg spike against `conelike/asset-management-jira` (root cause verified red/green, 669/669 tests), competitive research (`docs/research/2026-08-09-session-bucketing-competitive-notes.md`), and Mobbin-referenced design mocks.

## The bar

If a line appears in a customer's digest, it carries either a verified fix or an investigation report the customer can hand to their coding agent. A replay link is supplementary and never a row's only action. Eligibility is enforced at the data boundary: one persisted **digest-readiness projection** with a single owner (the worker persistence layer), derived from investigation state + verification state; the digest query selects on it, formatters never judge. Today's digest fails the bar three ways: friction lines carry no diagnosis (7/7 prod friction investigations returned the literal "placeholder"), diagnosed error lines have no action path (medium/low confidence parks forever), and internal adjudication prose leaks to the customer.

## Workstreams

### WS1 — Identity and grouping contract (epic)

1. **T1: #308 + #309 + route_map canonicalization (#310's migration half), one release boundary, expand/contract deployment.**
   Content: Go normalizer rules ported to TS (hashbang, `:token`, byte cap); origin dropped from friction keys; shared golden fixture file tested by both languages; `RULE_VERSION` bump; no in-place fingerprint rewrite (version cutover; bucket state is version-namespaced — verified).
   Deployment sequence (rolling-deploy safe): (1) dual-read compatibility ships first — route lookups try path-only then origin-full; (2) canonical-writing code deploys everywhere and old workers drain; (3) idempotent route_map migration + reconciliation runs; (4) friction `RULE_VERSION` cutover; (5) canonical-writes-only enforcement.
   Collision policy, deterministic for every shape, with a durable audit: equal names merge; named beats unnamed; origin-full twin vs path-only row → path-only row's name wins; **two+ origin-full rows collapsing with no path-only row** → highest-reach tier survives, earliest `created_at`, name conflicts quarantined to a `route_map_migration_conflicts` audit table for manual resolution (not just logged); tier always keeps the higher reach.
   Acceptance: deterministic CI fixture simulating rotated Forge origins proves single-bucket accumulation; zero `^https?://` route patterns post-migration; friction and error incidents on the same route string-match **for current-rule-version incidents** (aged-out origin-full history exempt); prod Forge canary observed post-deploy as validation, not gate.
2. **T2: #312 after T1.** Incident titles from `route_map.name`, snapshotted at promotion; templated path as fallback and metadata.
3. **Decisions:** #311 (recommendation: age out the 521 origin-full groups). #30/#77/#247 absorbed — closed when T1 lands, narrow follow-ups for anything uncovered.

### WS2 — AI stages grade their own work (epic)

Contracts first, then parallel: **T4.0 defines the shared evidence/state/readiness contracts** (schemas for `evidence[]`, investigation state, fix-verification state, digest-readiness projection). T3/T3b, T4, T5, T6 then implement against them in parallel; T7's deterministic checks land inside each task, not after all of them. **T4–T6 apply to both lanes (friction and error) explicitly.**

1. **T3: #316.** Fixed investigator harness (validated by spike, 3/3 real cited root causes): raised exploration budget; repo file tree + route name in the system prompt, delimited as untrusted; a **dedicated classification turn outside the exploration budget**, requested only after minimum evidence (≥1 file read, ≥1 citation) — otherwise a structured `incomplete` outcome, digest-ineligible. Schema-level verdict validation (outcome enum, root-cause structure, ≥1 citation per diagnosis, brief fields, explicit uncertainty). **Mechanical citation verification** against the checkout at its commit before persistence; failures degrade to `incomplete`. Prompt caching on. `classify_friction` gains `evidence[]` (each citation carries a structured symptom-linkage statement) and `agentTaskBrief`.
   **Ships with a minimal eligibility gate**: the 7 existing placeholder artifacts (and any persisted degenerate root_cause) are marked digest-ineligible in the same release — quarantining old garbage is T3's job, not T5's. Re-enqueue of the 7 runs **report-only**; the fix/autonomy path stays closed to them until T4–T6 exist.
   Honesty note: shape validation (persistence safety) and eligibility are different bars — digest eligibility additionally requires verified citations plus the symptom-linkage fields; linkage quality is rubric-sampled (T7), not fully mechanical. Stated, not hidden.
2. **T3b: error lane parity.** Error investigations emit the same validated `evidence[]` + `agentTaskBrief`; parked medium/low investigations (#257) become "send to your agent" rows once briefs validate.
3. **T4: red/green protocol with a structured expected-failure contract.** Isolated commits (never stash/pop): test-only patch on the exact base commit; the harness — not model prose — compares a declared contract (test identifier, expected failing assertion/message) against the observed failure and its phase (assertion vs compile vs setup vs infra); same test passes with the fix; base run contains no fix code; suite discovered and ran a non-zero test count with skips reported. No red/green record → never auto-merges. (Spike evidence: the first spike test passed on broken code — wrong DOM probe; red/green caught it.)
4. **T5: verification ledger (extends #273).** PR verification and incident evidence generated from executed facts: command, commit/tree identity, dirty flag, discovered/passed/failed/skipped counts, truncation/timeout flags, not-run items at equal prominence. Behavior-coverage statements are labeled **asserted coverage** (model-claimed) unless mechanically tied to test identifiers. No model prose may claim verification. Internal adjudication text never renders on customer surfaces.
5. **T6: verification state, hard predicates, no ordinal score.** Investigation state and fix state recorded separately. Every recorded dimension is either an explicit gate or explicitly informational: **gates for auto-merge** = citations mechanically verified AND red/green contract passed AND full suite green AND zero unexplained pre-existing-failure deltas AND `auto_fix` opt-in; **informational** = environment fidelity, asserted coverage, evidence breadth (these feed display tiers and human review, never automation).
6. **T7: evaluation with an explicit rollout gate and bounded claims.** (a) Deterministic CI checks (schema, degeneracy, citation verification) — these catch malformed output, **not** semantic quality regressions; the plan claims no more than that. (b) Rubric-scored dev set of real incidents (several distinct root causes can be valid); **every prompt/model change requires a paired baseline-vs-candidate dev-set run plus human sign-off** — a smoke test, not statistics, and labeled so. (c) Blind holdout created at a concrete trigger: dev set ≥30 incidents or 2026-10-01, whichever comes first. Quality metrics: citation-validity rate, unsupported-claim rate, brief-completeness, verified-fix rate, reopened/failed-fix rate, human-override rate. #256/#257/#259/#242 become named dev-set cases.

### WS3 — Session facts become usable

**T8a (#313 filters)** and **T8b (#314 backfill hardening)** develop in **parallel** — they share the facts schema, not each other. Only the **production backfill run** is gated: explicit go + 1k-session cost extrapolation. T8b acceptance over a closed cohort (sessions started before a cutoff): every cohort session ends analyzed or terminally classified with a reason code (no_replay / chunks_expired / unreadable) and per-reason counts; re-run is a no-op. "Not analyzed" is a distinct filter state, never conflated with idle.

### WS4 — Digest v1.1, sliced so value ships as it becomes true

- **T9a — report rows** (after T3/T3b + the T3 eligibility gate): summary card, plain-language rows (avoid-ai-writing register, golden rendered-digest fixture in CI), one substantive action per row (send brief; replay supplementary), reach-ranked queue, accounts named. Templated-path titles are acceptable at this slice. Impact labels render as judgment-based ("likely blocked") until facts coverage exists (T8b), then cite completion data.
- **T9b — route-name enrichment** (after T2).
- **T9c — verified-fix rows** ("Review fix", after T4–T6): rows may claim a fix only from a red/green-passing verification record.
- **T10 — convergence, internal-first** (after T3/T3b): overlap of root-cause citations only; one repo + commit lineage; low-information-file exclusion list (lockfiles, manifests, routers, barrels, generated, test setup); `N ≥ 3` distinct incidents with `≥ 3` distinct users in a 14-day window; repeated investigations of one incident count once; no transitive expansion; renames not tracked in v1 (path-at-current-commit, stated limitation). Internal digest twin first; customer exposure only after human precision review, and only as a synthesized cluster brief (supporting incidents, suggested owner/action, stated limits). The Vue↔React bridge cluster is a stretch validation case (known false-negative mode: disjoint files per side), not acceptance.

### WS5 — Experiments and standing decisions

- **#315 dead-click shadow eval**: candidate detector (2.5–3s window + element exclusions) against ≥1k stored sessions; compare counts, verdicts, cost per accepted signal; rollout separate and gated, own `RULE_VERSION` bump.
- **Deferred, deliberately:** systemic-event correlation (budget cap is the backstop); adjudication job-type decoupling (revisit when analysis latency trails session close); origin as an optional grouping dimension if a multi-domain-single-project customer appears.

## Sequencing

```
T3 (#316 + eligibility quarantine, report-only re-enqueue) ──► first
T4.0 (contracts) immediately after T3 starts
then in parallel:  T3b │ T4 │ T5 │ T6        (both lanes)
                   T1 (expand/contract release) │ T8a ∥ T8b (code)
T9a after T3/T3b ── customers get actionable reports early
T2 after T1;  T9b after T2
T9c after T4–T6;  T7 gates every prompt/model change from T3 onward
T8b prod run after explicit go;  T10 after T3/T3b, internal-first
#315 anytime, independent
```

Epic filing: "Identity & grouping contract" and "AI stages grade their own work", children as above; #30/#77 closed as absorbed when T1 lands.

## Risks

- **T1 is the highest-risk task** (both reviews agree): rolling-deploy write races and collision handling. Mitigations are structural: expand/contract sequence, dual-read window, drained writers before migration, idempotent migration, durable conflict audit table.
- **Model cost:** larger budgets offset by prompt caching (currently zero cache hits) and existing adjudication caps; eval cost bounded by the small dev set.
- **Autonomy safety:** hard predicates only; report-only re-enqueue; red/green required; `auto_fix` opt-in unchanged; the `awaiting_approval`-on-filler path dies with T3 validation.
- **Backfill vs retention:** terminal classification with reason codes, never infinite retry.
- **Convergence precision:** internal-first, human-reviewed, evaluable via defined N/window before any customer exposure.
- **Readiness races:** single-owner readiness projection; T3's quarantine gate is its first writer.

## Explicitly out of scope

New signal types, Redis/queue changes, multi-region anything, rewriting historical friction incidents (#311 default: age out).

## Revision log

**v2 after round 1 (22 findings):** accepted all three P0s (report-only re-enqueue; T9 gated on grading machinery; T6 rebuilt from ordinal score to separated states + hard predicates) and 16 P1/P2s: red/green specification, ledger meaningfulness, dedicated classification turn + structured `incomplete`, schema-level validation, mechanical citation verification, error-lane briefs (T3b), gaming-resistant metrics, convergence restrictions + internal-first + cluster briefs, T1/route_map release-boundary merge, #313/#314 split, closed-cohort backfill, judgment-based impact fallback, replay demoted, origin-rotation CI fixture, persisted eligibility. Pushed back once: day-one blind holdout right-sized to layered evaluation.

**v3 after round 2 (16 findings; 14 of round 1 confirmed resolved):** accepted both P0s — T1 expand/contract deployment sequence and a deterministic, audited collision policy covering the no-path-only-row shape. Accepted: T3 quarantines existing placeholder artifacts itself (eligibility gate moved ahead of re-enqueue); T6 dimensions each explicitly gate or explicitly informational; T4 expected-failure contract compared by the harness, not prose; T5 asserted-coverage labeling; T7 stripped of any CI-quality-regression claim, given a paired-run + human sign-off rollout gate and a concrete holdout trigger (≥30 incidents or 2026-10-01); T9 sliced (T9a/b/c) so report rows ship early instead of waiting for the verification stack; T4–T6 parallelized behind a contracts task (T4.0) and applied to both lanes; T8a/T8b parallelized with only the prod run gated; single-owner readiness projection; T10 given N/window/dedup semantics and a stated rename limitation; T1 acceptance scoped to current-rule-version incidents. Residual accepted risks, stated: symptom-linkage quality is rubric-sampled rather than mechanical; dev-set evaluation is a smoke test until the holdout trigger fires.
