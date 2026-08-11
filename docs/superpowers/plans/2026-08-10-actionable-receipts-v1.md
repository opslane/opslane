# Actionable Receipts v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every issue a customer sees arrives as a receipt — a verified fix PR link, a saved-diff failure report, or an agent-ready investigation report with evidence — instead of a truncated error dump with no action.

**Architecture:** The fix attempt moves from click-triggered to policy-triggered: the authorization rule (not a bypass) widens to accept a persisted medium-confidence `code_fix` decision that carries a recorded impact justification, so the digest ships outcomes. Impact is computed mechanically from session recordings by the existing priority sweeper (no model calls). The digest payload is restructured into receipt items; the issue page and PR body re-order around the same four questions: what happened to users, how bad, why, what got done. Design/acceptance references: the digest mock and three-surfaces artifacts from 2026-08-10 (see References).

**Tech Stack:** Go 1.24 (ingestion: sweeper, digest, migrations), Node 22 + TypeScript (worker: policy, schema, PR body), Vue 3 (dashboard issue page), Vitest + Go tests, Postgres job queue (no new infra).

## Global Constraints

- No Redis/BullMQ or any new queue — Postgres `error_group_jobs` only (AGENTS.md guardrail).
- `POST /api/v1/events` wire contract is append-only; no fixture edits under `test-fixtures/wire/`.
- Preserve terminal-status and lease contracts; the claim-order invariant (route_map behind incident lanes) must keep passing. Where this plan touches terminal writes (A3 step 4) it makes them *more* atomic, never weaker.
- Server-side packages stay `AGPL-3.0-only`.
- Customer-visible copy rule: no sentence in digest/issue-page/PR copy may assert a fact that is not computed from a query or stored field. Titles stay the stored technical title until a real plain-title source exists — never invent one.
- Publishing rule: nothing reaches a customer surface without at least one action. Actions are: a fix PR link, a saved-diff failure report, a copyable agent report built from a **validated** diagnosis, or a watchable recording. Verdicts matching `/placeholder|to be determined|tbd/i` or < 40 chars are not validated and never publish.
- The fix pipeline's checks (baseline suite, diff judge, precision gate — `agent-fix.ts:1151`) are never weakened. The authorization *rule* changes (A3); the verification gates do not.
- The human-trigger bypass of `diagnosis_decisions` stays exactly as-is and is never extended to any automated trigger.
- Sensitive content: outbox payloads store excerpts, not full untrusted text (C1 keeps the existing excerpt+sanitize discipline).
- Verification per package AGENTS.md; pipeline changes require the live smoke (seed, send event, confirm terminal state).

## Phase order and why

A (worker: fix-before-digest policy) → B (ingestion: impact computation + session pointers) → C (digest receipts) → D (issue page + PR body) → E (grouping splinter). C consumes A's outcomes and B's numbers. D and E are independent of C after B. Each phase ships alone.

---

### Task A1: Unsuccessful fix runs surface their working diff (issue #73)

The receipt for a failed attempt is "here's how far it got." Today `extractDiff` runs only after `result.success`, so budget/turn exhaustion exits with **no diff ever extracted** — there is nothing to persist. The failure paths with no diff at all (clone failure, authorization refusal, missing key, infra exhaustion) stay diff-less and must render honestly (see C2 receipt states).

**Files:**
- Modify: `packages/worker/src/agent-fix.ts` (on unsuccessful terminal exit, extract the working-tree diff from the sandbox **before** cleanup and attach it to the returned result as `candidateDiff`; reuse the existing `extractDiff` helper)
- Modify: `packages/worker/src/index.ts:1239-1275` (fix-result persistence: thread `candidateDiff` + partial evidence into the terminal `needs_human` update, as the `low_confidence_fix` path already does)
- Test: `packages/worker/src/__tests__/agent-fix-budget.test.ts` (new)

**Interfaces:**
- Consumes: existing `extractDiff`, the **existing** `AgentFixResult` contract (`agent-fix.ts:116`): `status: 'needs_human' | ...`, `diff`, `reason.reason_code`. No new result fields — on unsuccessful terminal exits the extracted working diff is returned in the existing `diff` field, which `pipeline.ts:138` already maps into `candidate_diff`.
- Produces: `result.diff` populated on `budget_exhausted` / `tests_failed` exits when the sandbox holds edits; `error_groups.candidate_diff` / `verification_evidence` written by the existing `updateGroupStatus` call at `index.ts:1274` (snake_case field `candidate_diff`).

- [ ] **Step 1: Write the failing tests** — one at the `runAgentFix` boundary, one against the real persistence call:

```ts
it('returns the working diff when the budget runs out after edits exist', async () => {
  const result = await runAgentFixHarness({
    agentScript: [editFileTurn(SAMPLE_EDIT), exhaustBudgetTurn()],
  });
  expect(result.status).toBe('needs_human');
  expect(result.reason?.reason_code).toBe('budget_exhausted');
  expect(result.diff).toContain('SAMPLE_EDIT_MARKER');
});

it('persists candidate_diff on the terminal needs_human write', async () => {
  const calls = spyOn(db, 'updateGroupStatus');
  await processFixJobWith(resultWithDiff('budget_exhausted'));
  expect(calls.at(-1)?.fields).toMatchObject({ candidate_diff: expect.stringContaining('SAMPLE_EDIT_MARKER') });
});
```

- [ ] **Step 2: Run both, verify both fail** (diff is absent on this path today).
- [ ] **Step 3: Implement.** In `agent-fix.ts`, on the unsuccessful terminal exits that follow agent edits, call `extractDiff` before sandbox teardown, guarded with try/catch (a dead sandbox yields `null`, never an exception), and return it in `diff`. Confirm the `index.ts:1274` / `pipeline.ts:138` path forwards it into `candidate_diff` for these reason codes (adjust only if a branch drops it). Status/reason semantics unchanged.
- [ ] **Step 4: Worker suite green.**
- [ ] **Step 5: Commit** `fix(worker): keep the working diff on budget_exhausted and tests_failed (#73)`.

### Task A2: Optional fix direction in the diagnosis output

**Files:**
- Modify: `packages/worker/src/diagnose-schema.ts` (tool schema + `parseAdjudication` at `:216`)
- Modify: `shared/src/diagnosis.ts` (the home of `Adjudication` / `Diagnosis` — `types.ts` only re-exports): `Adjudication` gains `suggested_direction?: string`; `Diagnosis` gains `suggestedDirection: string | null`
- Modify: `packages/worker/src/diagnosis-schema.ts:12` (persisted-payload `parseDiagnosis` round-trips the field)
- Modify: `packages/worker/src/investigate.ts:287` area (adjudication→result conversion) and `packages/worker/src/index.ts` (persist via the `suggestedMitigation` field of `updateGroupInvestigation`)
- Test: `packages/worker/src/__tests__/diagnose-schema.test.ts`

**Interfaces:**
- Produces: `submit_diagnosis.suggested_direction?: string` (≤ 600 chars after clamp, NOT in `required`). Flows: tool call → `parseAdjudication` → `Adjudication` → conversion → `Diagnosis.suggestedDirection` → persisted job payload (`parseDiagnosis` round-trip) → `error_groups.suggested_mitigation`. The column is already selected and rendered by the read API and dashboard — only production of it is missing since the single-tool rewrite. Consumed by C2 and D2.

- [ ] **Step 1: Failing tests:** `parseAdjudication` carries and clamps the field; absence → `null`; `parseDiagnosis` round-trips it from a persisted payload.

```ts
it('carries suggested_direction through adjudication parsing and clamps it', () => {
  const adj = parseAdjudication({ ...VALID_ADJUDICATION, suggested_direction: 'x'.repeat(1000) });
  expect(adj.suggested_direction).toHaveLength(600);
  expect(parseAdjudication(VALID_ADJUDICATION).suggested_direction).toBeUndefined();
});
it('round-trips suggestedDirection through the persisted diagnosis payload', () => {
  // Persisted shape is the raw JSON the job payload stores — no serialize helper exists.
  const persisted = parseDiagnosis({ ...VALID_PERSISTED_DIAGNOSIS_JSON, suggested_direction: 'guard the branch chain' });
  expect(persisted.suggestedDirection).toBe('guard the branch chain');
});
```

- [ ] **Step 2: Verify both fail.**
- [ ] **Step 3: Implement** across the listed files. Prompt addition (`investigationSystemPrompt`): "If you can name the change that would fix the cause, put one or two sentences in `suggested_direction`. Skip it rather than guess."
- [ ] **Step 4: Worker + shared builds green** (`pnpm -r build` — shared types changed).
- [ ] **Step 5: Commit** `feat(worker): investigator may propose a fix direction`.

### Task A3: Policy — widen the authorization rule, never bypass it

Fix jobs stay `triggered_by='auto'`; **no new trigger value** (the `'auto'|'human'|null` typing in `db.ts:173` and the hard-coded `'auto'` in `updateGroupAndCreateFixJob` at `db.ts:1953` stay as they are). What changes is the *decision rule*, evaluated where the decision is recorded and re-checked where it is enforced.

**Files:**
- Modify: `packages/worker/src/index.ts` (investigate completion, the medium-confidence branch that today parks at `investigated`)
- Modify: `packages/worker/src/db.ts` — five changes:
  (a) `claimJob` selects `source_id` and `ClaimedJob` exposes it (`sourceId: string | null`) — authorization identity travels explicitly, never through `usageContext`;
  (b) decision loading for automated jobs: `loadDiagnosisDecisionForSource(projectId, groupId, sourceJobId)`; when `sourceJobId` is NULL (legacy in-flight jobs) fall back to newest-for-group with a test pinning that fallback;
  (c) live impact query `getGroupImpactBar(projectId, groupId)` (below) — **project-scoped**, per repo DB contract;
  (d) policy columns written where decisions are actually inserted: extend `DecisionRow`, `PersistedDecision`, the private `insertDiagnosisDecision` (`db.ts:32` area), and **both transactional callers** — not the exported `recordDiagnosisDecision` convenience wrapper alone;
  (e) `updateGroupAndCreateFixJob` (`db.ts:1905`): on reuse of an existing pending fix job, **overwrite** `payload` and `source_job_id` (newest decision owns the job) instead of `COALESCE`-preserving stale linkage, atomically in the existing transaction.
- Create: `packages/ingestion/db/migrations/044_policy_decision.sql` — on `diagnosis_decisions`: `policy_eligible BOOLEAN`, `policy_basis JSONB` (versioned shape `{"v":1,"identified_users":N,"recent_anon_sessions":N}`); on `error_groups`: `terminal_fix_job_id UUID` (adoption marker, step 4).
- Modify: `packages/worker/src/agent-fix.ts:429-489` (authorization: human bypass unchanged; automated jobs load the decision for their `sourceId` and accept `outcome='code_fix' AND (confidence='high' OR (confidence='medium' AND policy_eligible))`); `AgentFixInput` gains a required `sourceJobId: string | null`.
- Test: `packages/worker/src/__tests__/fix-policy.test.ts`

**Interfaces:**
- Consumes: `deriveOutcome` (`classify.ts:59`), diagnosis decision rows, `ClaimedJob.sourceId`.
- Produces: `getGroupImpactBar(projectId, groupId): Promise<{identifiedUsers: number; recentAnonSessions: number; eligible: boolean}>` computed **live** at investigation completion (not from `priority_inputs` — the sweeper runs every ~30 min and a brand-new group has no stamp). Anonymous semantics match the sweeper: a session counts as anonymous only when **all** its events are anonymous:

```sql
SELECT
  (SELECT count(*) FROM error_group_affected_users
    WHERE project_id = $1 AND error_group_id = $2) AS identified_users,
  (SELECT count(*) FROM (
     SELECT session_id FROM error_events
     WHERE project_id = $1 AND error_group_id = $2
       AND session_id IS NOT NULL AND timestamp > now() - interval '7 days'
     GROUP BY session_id HAVING bool_and(end_user_id IS NULL)
   ) anon) AS recent_anon_sessions;
-- eligible := identified_users >= 1 OR recent_anon_sessions >= 3
```

- Behavior: on a medium-confidence `code_fix`, insert the decision with `policy_eligible` + basis; when eligible, `updateGroupAndCreateFixJob` (still `triggered_by='auto'`); otherwise park at `investigated` exactly as today. Friction incidents excluded (`group.kind === 'error'` guard). Note: switching authorization lookup to source-linked decisions intentionally touches high-confidence jobs too; the NULL-source fallback plus tests covers legacy in-flight jobs. **Known v1 limitation (accepted, documented in code):** a group parked with `policy_eligible=false` is not re-evaluated when later events cross the bar; re-evaluation rides the existing requeue rules only.

- [ ] **Step 1: Failing tests** (seven):

```ts
it('queues a fix job for a medium code_fix meeting the live impact bar', ...);
it('parks without a fix job when the impact bar fails, and records policy_eligible=false', ...);
it('authorization accepts a medium decision only when its own row says policy_eligible', ...);
it('authorization loads the decision for the job\'s sourceId, not the newest for the group', ...);
it('falls back to newest-for-group when sourceId is NULL (legacy jobs)', ...);
it('reusing a pending fix job re-points payload and source_job_id at the new decision', ...);
it('never queues for friction incidents', ...);
```

- [ ] **Step 2: Verify all fail.**
- [ ] **Step 3: Implement** (migration → db.ts (a)–(e) → index.ts branch → agent-fix gate).
- [ ] **Step 4: Terminal adoption marker.** `needs_human` today stores no fix-job identity (`pr_fix_job_id` is only written on PR delivery), and job completion happens in the poller, outside `processFixJob` (`poller.ts:130`) — so "wrap it in one transaction" is not a local tweak and is **not** the chosen design. Instead: the terminal `needs_human` group write sets `terminal_fix_job_id = <this job id>` in the same UPDATE; the adoption branch in `processFixJob` (`index.ts:999` area) treats `group.terminal_fix_job_id === job.id` exactly like the existing `pr_created`/`pr_draft` adoption (complete without re-executing). A later human retry clears the marker when it enqueues. Failing test: simulate lease loss after the group write and before completion; the requeued run adopts.
- [ ] **Step 5: Worker suite green including existing authorization tests (human bypass untouched).**
- [ ] **Step 6: Live smoke:** medium-confidence fixture → `investigate → fix` with no click → terminal `pr_created`, or `needs_human` carrying `candidate_diff` **when the agent produced edits** (diff-less failure classes from A1 terminate honestly without one).
- [ ] **Step 7: Commit** `feat(worker): policy-widened fix authorization for substantive diagnoses`.

### Task B1: Impact computation in the priority sweeper

**Files:**
- Create: `packages/ingestion/db/migrations/045_issue_impact.sql`
- Modify: `packages/ingestion/priority/sweeper.go` (new stamp pass on the existing cadence/advisory lock, `sweeper.go:221` area)
- Test: `packages/ingestion/priority/impact_test.go` (DB-gated like existing sweeper tests)

**Interfaces:**
- Produces columns on `error_groups`: `impact_class TEXT CHECK (impact_class IN ('blocked','degraded','invisible'))`, `impact_visits INT`, `impact_visits_recovered INT`, `impact_computed_at TIMESTAMPTZ` (all nullable; NULL = unknown). Consumed by C1/C2, D1, D2.
- Semantics: a **visit** is a distinct session among the group's events *with usable chunk evidence* (`last_event_ms IS NOT NULL`). Recovered = last recorded activity ≥ 60s after that session's last crash of this group. Sessions with only NULL-bounded chunks are **excluded** (unknown evidence is not proof of death). Unknown means **all four columns NULL** (including `impact_computed_at`) — one representation, used both for never-computed and computed-found-nothing. The event window is its own named contract, `IMPACT_WINDOW_DAYS = 30` (it is deliberately wider than the priority 7d/24h windows; it is not "the retention window").

- [ ] **Step 1: Migration** (columns above; no backfill — next sweep fills).
- [ ] **Step 2: Failing Go tests:** (a) schippers shape → `degraded`, visits 2, recovered 1; (b) both loops die → `blocked`; (c) NULL `last_event_ms` chunks only → impact stays NULL; (d) group whose sessions age out → previously stamped impact cleared.
- [ ] **Step 3: Implement** — bounded and scoped, not an all-history join. Go implementation: explicit transaction in the sweeper pass (`RunOnce` has none today — add `BeginTx`/commit/rollback around the two statements), with the rollup materialized into a `CREATE TEMPORARY TABLE ... ON COMMIT DROP` so both statements can read it (a CTE cannot span statements). Open groups use the established open predicate — `archived_at IS NULL AND status NOT IN ('resolved','merged')` — not `archived_at` alone:

```sql
WITH open_groups AS (
  SELECT id, project_id FROM error_groups
  WHERE archived_at IS NULL AND status NOT IN ('resolved','merged') AND kind = 'error'
), ev AS (
  SELECT g.id AS group_id, e.project_id, e.session_id,
         max(extract(epoch FROM e.timestamp)*1000) AS last_crash_ms
  FROM open_groups g
  JOIN error_events e ON e.error_group_id = g.id AND e.project_id = g.project_id
  WHERE e.session_id IS NOT NULL AND e.timestamp > now() - interval '30 days'
  GROUP BY 1, 2, 3
), chunks AS (
  SELECT c.project_id, c.session_id, max(c.last_event_ms) AS last_activity_ms
  FROM session_chunks c
  WHERE c.scrubbed_at IS NOT NULL AND c.last_event_ms IS NOT NULL
    AND c.session_id IN (SELECT session_id FROM ev)
  GROUP BY 1, 2
), rollup AS (
  SELECT ev.group_id,
         count(*) AS visits,
         count(*) FILTER (WHERE ch.last_activity_ms >= ev.last_crash_ms + 60000) AS recovered
  FROM ev JOIN chunks ch ON ch.project_id = ev.project_id AND ch.session_id = ev.session_id
  GROUP BY 1
)
UPDATE error_groups g SET
  impact_visits = r.visits,
  impact_visits_recovered = r.recovered,
  impact_class = CASE WHEN r.recovered = 0 THEN 'blocked'
                      WHEN r.recovered < r.visits THEN 'degraded'
                      ELSE 'invisible' END,
  impact_computed_at = now()
FROM rollup r WHERE g.id = r.group_id;
-- second statement (same tx, rollup = temp table): clear ONLY stale non-NULL stamps
UPDATE error_groups g SET impact_class = NULL, impact_visits = NULL,
  impact_visits_recovered = NULL, impact_computed_at = NULL
WHERE g.archived_at IS NULL AND g.status NOT IN ('resolved','merged') AND g.kind = 'error'
  AND g.impact_class IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM impact_rollup r WHERE r.group_id = g.id);
```

  The `impact_class IS NOT NULL` guard means unknown groups are never rewritten sweep after sweep (no WAL/dead-tuple churn). Acceptance includes `EXPLAIN (ANALYZE, BUFFERS)` on a seeded 100k-event dataset. The 30-day bound uses `timestamp`; note the existing `idx_error_events_group_created` is on `created_at`, so the index review must either prove the group-scoped scan is cheap or add an index on `(error_group_id, timestamp)` — do not claim the `created_at` index covers this.
- [ ] **Step 4: Go tests green, zero skips.**
- [ ] **Step 5: Commit** `feat(ingestion): compute issue impact from session recordings`.

### Task B2: Watchable session pointers for digest and friction incidents

**Files:**
- Modify: `packages/ingestion/db/sessions_read.go:331` (`SessionPointerForGroup` — exported name — gains a friction branch: `representative_session_id` for identity, the representative signal's `occurred_at` for the offset)
- Modify: `packages/ingestion/digest/build.go` (per-issue watchable session selection)
- Test: extend `packages/ingestion/db/sessions_read_test.go`, `digest/build_test.go`

**Interfaces:**
- Produces: `DigestIssue.SessionURL string` using the **existing digest route shape** (`digest/digest.go:32` emits `/sessions/{id}` today — extend with `?t={offsetMs}` only after confirming the dashboard router accepts it; if it doesn't, ship identity-only links and file the offset as dashboard work). Empty string when no covered recording exists.
- Coverage definition (used in SQL and tests): over the session's scrubbed, non-NULL-bounded chunks, `min(first_event_ms) <= ts - 15000 AND max(last_event_ms) >= ts + 15000` — the stitched span covers the full ±15s window, not merely overlaps it (a 1ms chunk at the crash is not coverage; intra-span gaps are accepted in v1 and documented). Ties broken by newest event. Playability requires `has_full_snapshot` on some chunk starting at-or-before the window. "Representative signal" = the incident's `representative_signal_id` row, which must be accepted and not retracted/superseded; if it is retracted, fall back to the earliest accepted signal for the incident (`ORDER BY occurred_at ASC, id ASC`).

- [ ] Steps: failing tests (friction incident → pointer from representative signal; retracted representative → earliest accepted fallback; error issue → covered session; 1ms-overlap chunk → NOT covered; no coverage → empty; no-full-snapshot session → empty) → implement → green → commit `feat(ingestion): watchable session pointers for digest and friction incidents`.

### Task C1: Digest payload becomes receipt items

The digest payload today is **three collections** (`TopNewIssues`, `PRsOpened`, `NeedsHuman` — `notify/event.go:27`), and `buildTopNewIssues` excludes groups that transitioned to PR/needs_human in the window. Receipt cards need one unified list, so this is a payload redesign, not a field addition.

**Files:**
- Modify: `packages/ingestion/notify/event.go:27` (payload gains `SchemaVersion int` + `ReceiptItems []ReceiptItem`; legacy collections stay populated during transition; the formatter branches on `SchemaVersion >= 2`, so absent/NULL/empty receipt lists are never conflated)
- Modify: `packages/ingestion/digest/build.go` (receipt query: **window semantics kept deliberately** — receipt items are groups whose receipt state *changed in the digest window* (PR opened, attempt failed, investigation completed), ranked `COALESCE(priority_score,0) DESC`, capped at 10 items (Slack block budget); the same open receipt does not reappear daily. Fields: title, `occurrence_count`, `root_cause` **excerpt** (first 300 chars, sanitize-at-render preserved), `suggested_mitigation` excerpt, `impact_class/impact_visits/impact_visits_recovered`, `pr_url/pr_number`, `status`, `reason_code`, `NULLIF(btrim(candidate_diff),'') IS NOT NULL AS has_saved_diff`, `SessionURL`, `has_usable_diagnosis` — a join to the group's latest `diagnosis_decisions` row with a usable outcome, because prose length does not validate a diagnosis)
- Modify: same file — publishing gate `publishable(item) bool`: `has_usable_diagnosis` AND root-cause excerpt passes the placeholder regex (belt and suspenders) AND ≥1 action present (pr_url, saved diff, agent report from a usable diagnosis, or SessionURL). Failing items are counted, not rendered.
- Test: `packages/ingestion/digest/build_test.go`

**Interfaces:**
- Produces `ReceiptItem` + `HeldBackCount int` + `TriageCounts{PRsAwaitingReview, NeedsDecision int}` with **defined queries**: PRs awaiting review = open groups in `pr_created`/`pr_draft` (point-in-time); needs decision = open groups in `needs_human` plus `investigated` with a usable diagnosis (point-in-time); held back = groups in **surfaced-eligible states only** (`needs_human`, `investigated`, `insight`) failing `publishable` — queued/analyzing/fixing work is in-flight, not "pending internal review". Consumed by C2.

- [ ] Steps: failing tests (priority order vs old formula using the rank-1↔74 shape; placeholder-cause item counted as held back; group without a usable diagnosis held back even with long prose; empty-string diff not a saved diff; **raw legacy JSON** (a captured v1 outbox payload string, unmarshalled) still renders via the fallback) → implement → green → commit `feat(digest): receipt items with publishing gate`.

### Task C2: Digest receipt cards (Slack formatter)

**Files:**
- Modify: `packages/ingestion/notify/slack_digest.go` (render `ReceiptItems` when `SchemaVersion >= 2`; legacy layout otherwise)
- Create: `packages/ingestion/narrative/narrative.go` — a **neutral package**: `digest` already imports `notify`, so the templates cannot live in `digest` and be imported by `notify` without a cycle; `narrative` is imported by `digest`, `notify`, and `handler` (D1)
- Test: golden-block tests in `notify/slack_digest_test.go`; `narrative/narrative_test.go`

**Interfaces:**
- Consumes `ReceiptItem`. Card layout (digest mock is the acceptance spec):
  1. Header: the stored technical title (no invented plain titles — the plain-language layer is the story line).
  2. Story line from `narrative.Story(occurrenceCount, impact)`: `"N crashes across M visits"` (N = `occurrence_count`, M = `impact_visits`) + one of `", no visit recovered"` / `", K of M visits recovered"` / `"; recording impact unavailable"` (the honest phrase — NULL impact has several causes, "no recordings" is only one of them).
  3. Receipt line, exactly one of: `Fix PR ready for review: <pr_url>` · `Fix attempt failed its checks; saved diff and report attached` (needs_human + has_saved_diff) · `Fix attempt failed before producing a change; report attached` (needs_human, no diff) · `Investigation report ready` (validated cause, no attempt yet — pre-policy backlog).
  4. Buttons: Review fix PR (pr_url), Watch recording (SessionURL), Issue page (always).
- Digest header: triage line from `TriageCounts`; footer: `"Held back: N low-signal item(s) pending internal review."` — replaces the backlog counter.

- [ ] Steps: golden test per receipt state + triage/footer lines + legacy-payload fallback → implement → green → **manual gate (outward-facing):** render one full digest from prod-shaped seed and review it before enabling → commit `feat(digest): receipt cards with computed impact copy`.

### Task D1: Issue page reading order

**Files:**
- Modify: `packages/ingestion/handler/read_api.go:22` area (incident detail DTO adds: `impact_class`, `impact_visits`, `impact_visits_recovered`, `story` — server-rendered via the `narrative` package from C2, single source of copy — and `recordings: [{session_id, started_at, duration_ms, crash_count, url}]`)
- Modify: `shared/src/types.ts` and `packages/dashboard/src/types/api.ts` (the `Incident` contract and dashboard API typing gain the same fields — the DTO change alone does not compile the dashboard)
- Modify: `packages/ingestion/db/sessions_read.go` (recordings-list query: per-session crash counts computed from `error_events` **before** joining chunk coverage — coverage via `EXISTS`, never a chunk join that multiplies `count(e.id)`)
- Modify: `packages/dashboard/src/views/IncidentDetail.vue` (section order: impact badge + title → What happened (renders `story` verbatim) → recordings list → Why it crashed (`root_cause`) → The fix receipt (`pr_url` / saved diff / report) → forensic detail in the right rail)
- Test: Go handler test for DTO fields; dashboard component test for the three receipt states and the unknown-impact state. (`suggested_mitigation` is already in the DTO — no change claimed there.)

- [ ] Steps: failing DTO test → API + query → failing component test → implement → green → commit `feat(dashboard): impact-first incident page`.

### Task D2: PR body reads impact-first

**Files:**
- Modify: `packages/worker/src/db.ts:1155` area (`getErrorGroup` selects `impact_class`, `impact_visits`, `impact_visits_recovered`, `suggested_mitigation`; type `ErrorGroupData` extends accordingly)
- Modify: `packages/worker/src/pipeline.ts` (thread the fields into `PRInput`)
- Modify: `packages/worker/src/pr.ts:388` (`buildPRBody`: What users hit (impact numbers + session link when present) → Root cause (stored text, quoted) → The change (narrative + `suggested_mitigation` when present) → How it was verified (existing evidence tiers, rendered as check lines — however many exist, not a fixed three) → collapsed detail unchanged)
- Test: `packages/worker/src/__tests__/pr-body.test.ts` — snapshots for: full impact data, NULL impact (unknown branch), no session link. (PR bodies exist only for delivered PRs; no "receipt state" snapshots — that concept lives in the digest.)

- [ ] Steps: failing snapshots → db.ts select + types → pipeline threading → body reorder → green → commit `feat(worker): impact-first PR body`.

### Task E1: Diagnose and close the minified-identifier splinter (issue #77 subset)

**Files:**
- Create: `packages/ingestion/grouping/testdata/splinter/*.json` (sanitized fixtures — **materialized first**: pull the 8 splinter groups' sample messages + stacks from prod via the debug-ro runner, strip account/URL specifics, commit as fixtures; the plan's external artifacts are not implementable references)
- Create: `packages/ingestion/grouping/splinter_diag_test.go`
- Modify: `packages/ingestion/grouping/fingerprint.go` (only what the diagnosis names)

- [ ] **Step 1: Materialize fixtures** (one-time prod read, sanitized, committed).
- [ ] **Step 2: Diagnosis test:** run `Fingerprint()` over the fixtures and assert which component differs (message vs frames). Do not assume the message is the cause.
- [ ] **Step 3: Failing golden test:** the two `bum` variants collapse to one fingerprint; a genuinely different error does not.
- [ ] **Step 4: Implement the narrowest normalization the diagnosis supports** (e.g. strip 1–2 char quoted identifiers) — frame hashing untouched unless proven. Forward-only; existing groups never rewritten.
- [ ] **Step 5: Go tests green (suppression/family untouched). Commit** `fix(grouping): collapse minified-identifier message splinters`.

---

## Explicitly out of scope

- Friction pipeline repairs (#316, promotion funnel) — C1's gate keeps invalid friction verdicts off customer surfaces meanwhile; friction receipt cards wait for that fix.
- Priority-ordered job claiming, reach-scaled budgets, network-timing M2, replay evidence windows at diagnosis, sourcemap re-resolution triggers, plain-language titles, digest email channel.
- Any rewrite of existing groups or outbox rows.

## Verification gate (whole plan)

`pnpm -r build && pnpm test` (with `DATABASE_URL`; read skip counts), `cd packages/ingestion && go build ./... && go test ./...` (zero skips), `docker compose config --quiet`, live smoke (seed → event → `investigate → fix → pr_created|needs_human` with no click → render one digest with a receipt card per state).

## References

- Audit + spikes: "Error tracking × fixes — integration audit" artifact (2026-08-09/10).
- Acceptance mocks: "Digest mock" and "Three surfaces" artifacts — receipt states, copy rules, section orders.
- Prod facts: 163 open error groups; ~7% group / ~2% user-impact conversion; 0/163 sample sessions analyzed at diagnosis; 6/163 resolved stacks (registry recency + lazy resolution); digest-vs-priority rank divergence (1 ↔ 74); schippers incident (13/8/3 crashes; crash loops; one 17-minute recovery).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found → addressed | R1: 11 P1 / 13 P2 / 4 P3; R2: 13 P1 / 12 P2 / 3 P3; all folded into revisions 1–2 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | — |

**CODEX:** Two consult-mode iterations against the live repo (session `019fed7c-a819-7d52-a6a0-7242cfed5c27`). Round 1 killed a gate-bypassing policy design, a false premise in the saved-diff task, an unbounded impact join, and a digest payload misread; round 2 verified those resolutions and corrected result-contract names, decision-row ownership, transaction/temp-table mechanics, an import cycle, and copy honesty. Every finding from both rounds is folded into the plan text above; remaining round-2 P2 judgment calls are recorded inline as documented v1 choices.

**VERDICT:** CODEX CLEARED after two iterations — eng review not yet run (recommended before execution).

**UNRESOLVED DECISIONS:**
- A3 v1 limitation is a product call awaiting owner sign-off: a group parked below the impact bar is not re-evaluated when later events cross it (re-evaluation rides existing requeue rules only).
- C1 receipt-window semantics await owner sign-off: receipts appear when state changed in the digest window, capped at 10 by priority — an open PR unreviewed for days does not re-appear daily.
