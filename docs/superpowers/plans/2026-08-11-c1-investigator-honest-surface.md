# C1: Investigator Fix, Quarantine, and the Honest Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No degenerate or unverified investigation verdict ever reaches a customer surface again: the investigation harnesses stop forcing verdicts from unoriented agents, every verdict is mechanically validated before persistence, the 7 existing placeholder incidents are quarantined and re-investigated report-only, and the incident page and digest render an honest not-verified state instead of stored garbage.

**Architecture:** Both investigation lanes converge on the error lane's `runReadOnlyAgent` harness, extended with a split exploration/classification budget and a minimum-evidence gate. A new pure `verdict-validation` module rejects filler, uncited claims, and citations of files the agent never read, degrading to the C0-frozen `outcome='incomplete'`. Worker persistence writes the `digest_readiness` projection in the same transaction as group/decision updates. The Go read API and digest builder consume the projection; the dashboard renders the honest state. Surfaces merge **before** the quarantine so the release that quarantines also stops rendering.

**Tech Stack:** TypeScript (worker, Vitest), Go 1.24 (ingestion, plain `testing`), Postgres migrations (plain SQL under `packages/ingestion/db/migrations/`), Vue 3 + @vue/test-utils (dashboard).

**Parent:** `docs/superpowers/plans/2026-08-10-unified-actionable-program-plan.md` §C1. Authority: `docs/design/2026-08-10-unified-actionable-program.md`; harness detail carried forward from `docs/design/2026-08-10-actionable-pipeline-design.md` §6.2/§6.4.

## Dependency on C0 (hard prerequisite)

C1 consumes, and never edits, the C0-frozen contracts (`docs/superpowers/plans/2026-08-11-c0-interface-freeze.md`). C0 has **not merged yet**; C1 branches from the C0 stack and rebases when C0 lands. Specifically consumed:

- `shared/src/diagnosis.ts`: `EvidenceCitation {path, detail, symptomLink}`; `Adjudication.evidence?: EvidenceCitation[]`, `Adjudication.agent_task_brief?: string` (snake_case: tool-call wire shape); `Diagnosis.evidence`/`Diagnosis.agentTaskBrief` (camelCase mirrors); `DiagnosisOutcome` including `'incomplete'`.
- **Case rule, applied throughout this plan:** snake_case (`agent_task_brief`, `evidence` items with `symptomLink`) exists only on the tool-call wire (`submit_diagnosis`/`classify_friction` inputs and `Adjudication`). Everything persisted into `diagnosis_decisions.diagnosis` JSONB uses the `Diagnosis`-side camelCase keys (`agentTaskBrief`, `investigatedCommit`, `evidence`), and Go queries read the camelCase keys.
- Migration `044`: `diagnosis_decisions_outcome_check` admitting `'incomplete'`; `digest_readiness (incident_id PK → error_groups ON DELETE CASCADE, project_id, status IN ('eligible','ineligible','pending'), reason, updated_at)`; `error_group_jobs_triggered_by_check` admitting `'reinvestigate_report_only'`.

One known C0 gap to absorb here (verify first): `shared/src/types.ts:414-421` re-exports diagnosis symbols; `shared/package.json` has `"main": "dist/types.js"` and no `exports` map, so if C0 did not add `EvidenceCitation` to that re-export block, Task 4 adds the type-only re-export.

## Global Constraints

- Postgres queue only; wire contract append-only (`test-fixtures/wire/` untouched); lease and terminal-status contracts preserved; human-trigger bypass untouched.
- Copy rule: Opslane-authored surface copy is templates over stored fields; no model prose. `root_cause` and `agentTaskBrief` are model-authored technical reports: they render only where labeled as investigation output, only when their verdict validated, never inside templated copy. **C1's slice of that rule:** the validation gate guarantees only validated verdicts can render anywhere, the brief renders only under the Task 10 label, and readiness-ineligible incidents render nothing. Relabeling the digest's pre-existing root-cause excerpt lines and the issue-page section order is C4/C5's owned scope (program §C4/§C5) — deferred there deliberately, not forgotten.
- No `suggested_direction` anywhere. No judgment-based impact labels.
- Confidence self-grades stay out of *new* routing decisions; C1 does not remove existing confidence routing (that is C2/AC2.13), it only adds the `incomplete` stop.
- The interim digest predicate is explicit and temporary: readiness `ineligible`/`pending` rows are excluded; **absent-row incidents (the legacy book) render exactly as today**. C3's backfill + C4's eligible-only gate replace it.
- **Deploy order:** the honest surface (Tasks 9–11) merges before the quarantine (Task 13); the release that creates `quarantined_degenerate` rows must already contain the code that reads them, or the quarantine changes nothing on screens. Quarantine ships in the same release as the harness rewrite (design constraint); the whole train is one release. Within that release the migrate service runs before the new API/dashboard instances finish rolling — that window is **safe-degraded, not broken**: readiness rows are invisible to the old readers (their queries never join the table), so the old placeholder rendering persists for the minutes until the roll completes, which is exactly today's behavior, never a crash or a worse state. AC1.2 is evaluated after the roll.
- Fix-job creation for `triggered_by='reinvestigate_report_only'` must be structurally unreachable: a guard at the **entry** of `updateGroupAndCreateFixJob`, before any group mutation or job reuse, plus the handler branch.
- Worker DB tests follow the existing gate: `const describeDb = process.env['DATABASE_URL'] ? describe : describe.skip`. Go DB tests use `testPool(t)`/`disposableDB(t, …)` from `packages/ingestion/db/`.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/worker/src/repo-clone.ts` (modify) | `CloneResult` gains `headSha` — the `investigatedCommit` |
| `packages/worker/src/verdict-validation.ts` (create) | Pure verdict validator: filler rejection, read-set citation checking, brief presence |
| `packages/worker/src/readonly-agent.ts` (modify) | Opt-in split exploration/classification budget, nudge suppression, `no_evidence` stop, truncated-cost fix |
| `packages/worker/src/diagnose-schema.ts` (modify) | `submit_diagnosis` gains `evidence[]` + `agent_task_brief`; parsing; `seal` exported |
| `packages/worker/src/classify.ts` (modify) | `DerivedDecision.basis` gains `'invalid_verdict'`/`'no_evidence'` |
| `packages/worker/src/db.ts` (modify) | Readiness upsert/demote inside the two group-update transactions; report-only guard at `updateGroupAndCreateFixJob` entry |
| `packages/worker/src/investigate.ts` (modify) | Error lane: validation wiring, `incomplete` result, `investigatedCommit` threading |
| `packages/worker/src/friction/investigate-friction.ts` (rewrite) | Friction lane on `runReadOnlyAgent`: v2 tool + runtime parser, fenced prompt with file tree, caching, cost |
| `packages/worker/src/index.ts` (modify) | Both job handlers: `incomplete` persistence, readiness writes, report-only branch, friction decision rows |
| `packages/ingestion/db/queries.go` (modify) | Readiness → `pending` on requeue; `ErrorGroup.InvestigationReadiness` via LEFT JOIN; brief loader |
| `packages/ingestion/handler/read_api.go` (modify) | DTO gains `investigation_readiness` + `agent_task_brief`; cause nulled when not verified |
| `packages/ingestion/digest/build.go` (modify) | Interim readiness predicate on every group-derived section |
| `shared/src/types.ts` (modify) | `Incident` mirror fields (append-only, optional) |
| `packages/dashboard/src/types/api.ts`, `views/IncidentDetail.vue`, `components/incidents/IncidentConclusion.vue` (modify) | Honest state + labeled investigation output |
| `packages/ingestion/db/migrations/045_quarantine_degenerate_verdicts.sql` (create) | One-shot quarantine of degenerate verdicts |
| `scripts/reinvestigate-quarantined.sql` (create) | One-shot report-only re-enqueue of quarantined incidents |

**PR train** (each PR = consecutive tasks, merged in order, deployed as one release; task order = merge order): PR1 = Tasks 1–2 · PR2 = Tasks 3–6 · PR3 = Tasks 7–8 · PR4 = Tasks 9–11 (surfaces) · PR5 = Tasks 12–13 (report-only + quarantine) · CP1 = Task 14.

---

### Task 1: `investigated_commit` — record the clone HEAD

**Files:**
- Modify: `packages/worker/src/repo-clone.ts` (`CloneResult` at :18-23; `resolveClonedBranch` at :100-125 already runs `rev-parse --verify HEAD` at :120 and discards stdout)
- Test: `packages/worker/src/__tests__/repo-clone-headsha.test.ts` (create)

**Interfaces:**
- Produces: `CloneResult { repoDir: string; defaultBranch: string; headSha: string; cleanup(): Promise<void> }` — consumed by Tasks 6/8 (persisted as `investigatedCommit` in the decision row's `diagnosis` JSONB and as a trace attribute) and by C2's commit-drift check later.

- [ ] **Step 1: Write the failing test.** Build a throwaway git repo and resolve against it:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resolveClonedBranch } from '../repo-clone.js';

const exec = promisify(execFile);

describe('clone head sha', () => {
  it('resolveClonedBranch returns the checked-out HEAD sha', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clone-sha-'));
    await exec('git', ['init', '-b', 'main'], { cwd: dir });
    await writeFile(join(dir, 'a.txt'), 'x');
    await exec('git', ['add', '.'], { cwd: dir });
    await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'one'], { cwd: dir });
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: dir });

    const resolved = await resolveClonedBranch(dir, 'main');
    expect(resolved.headSha).toBe(stdout.trim());
    expect(resolved.branch).toBe('main');
  });
});
```

(Read `resolveClonedBranch`'s current signature first: if it is not exported, export it; if its parameters differ from `(repoDir, branch)`, adapt the call but keep the assertion shape.)

- [ ] **Step 2: Run it.** `pnpm --filter @opslane/worker test -- repo-clone-headsha`. Expected: FAIL (returns a `string`, not `{ branch, headSha }`).
- [ ] **Step 3: Implement.** Change `resolveClonedBranch` to return `{ branch: string; headSha: string }`, capturing the trimmed stdout of the existing `rev-parse --verify HEAD` call at :120 instead of discarding it. Update `cloneRepo` (:185-232) to set `headSha` on `CloneResult`. Fix the one other caller inside `repo-clone.ts` if any (search `resolveClonedBranch(`).
- [ ] **Step 4: Prove `cloneRepo` threads the sha.** Read `cloneRepo` (:185-232): if it can clone from a local directory path in a test (git accepts local paths as remotes), add a second test case asserting `(await cloneRepo(…)).headSha` equals the fixture's `rev-parse HEAD`; if its URL construction makes that impractical, assert the mapping line itself is exercised by extending whatever existing `cloneRepo` test exists — the `CloneResult.headSha` field must be covered by a test, not just by compilation.
- [ ] **Step 5: Verify.** `pnpm --filter @opslane/worker test -- repo-clone` and `pnpm --filter @opslane/worker build`. Expected: PASS, clean build.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(worker): record the investigated commit on every clone (C1/W1.1)"`

### Task 2: Verdict validation module

**Files:**
- Create: `packages/worker/src/verdict-validation.ts`
- Test: `packages/worker/src/__tests__/verdict-validation.test.ts` (create)

**Interfaces:**
- Consumes: `EvidenceCitation` from `@opslane/shared` (C0); `resolveInsideRepo` from `./repo-paths.js` (existing — read it first; it resolves a cited path inside the checkout and returns `null` when the file does not exist there. If its return type is not `string | null`, adapt the guard, not the semantics).
- Produces (consumed by Tasks 6 and 8):

```ts
export const FILLER_VERDICT = /\b(placeholder|tbd|to be determined)\b/i;

export type VerdictValidation =
  | { status: 'valid' }
  | { status: 'incomplete'; reason: string };

export interface VerdictForValidation {
  /** The model's cause prose (error lane: adjudication.best_supported; friction: verdict.reason). */
  causeText: string;
  /** True when the verdict claims a local code cause (error: derived outcome 'code_fix'; friction: codeCause === true). */
  claimsCodeCause: boolean;
  evidence: EvidenceCitation[];
  agentTaskBrief: string | null;
  /** ReadOnlyRunResult.filesRead — repo-relative paths successfully read during the run. */
  filesRead: string[];
}

export function validateVerdict(
  v: VerdictForValidation,
  resolvePath: (path: string) => string | null,
): VerdictValidation;
```

Checks, in order (first failure wins; reason strings are a frozen mini-contract, persisted to `diagnosis_decisions.decision_reason` and `digest_readiness.reason`, asserted by tests here and in Tasks 6/8/14). Each reason is `<code>: <human sentence>` computed in code:

1. `filesRead.length < 1` → `no_files_read`
2. empty `causeText` → `empty_verdict`
3. `FILLER_VERDICT.test(causeText)` → `filler_verdict`
4. `evidence.length === 0` → `no_citations` — **every** verdict needs ≥1 citation (design: "≥1 citation per diagnosis"; an external-cause verdict cites the local code that proves externality)
5. `claimsCodeCause && !agentTaskBrief?.trim()` → `missing_brief`
6. `agentTaskBrief && FILLER_VERDICT.test(agentTaskBrief)` → `filler_brief`
7. per citation, in order: empty/whitespace `path` → `citation_malformed`; empty `detail` or `symptomLink` → `citation_missing_link:<path>`; `resolvePath(path) === null` → `citation_unresolvable:<path>`; resolved path not in `filesRead` (compare repo-relative, after resolving both sides the same way) → `citation_not_read:<path>` — a citation must name a file the agent actually read, not merely one that exists

- [ ] **Step 1: Write the failing tests** (one per check plus ordering):

```ts
import { describe, expect, it } from 'vitest';
import { validateVerdict, FILLER_VERDICT } from '../verdict-validation.js';

const CITE = { path: 'src/a.ts', detail: 'unkeyed v-for remounts the select', symptomLink: 'clicks land on a detached node' };
const BASE = {
  causeText: 'The select remounts because options are rebuilt.',
  claimsCodeCause: true,
  evidence: [CITE],
  agentTaskBrief: '## Symptom\n…',
  filesRead: ['src/a.ts', 'src/b.ts'],
};
const resolveAll = (p: string) => p; // identity: resolved form is the repo-relative path
const resolveNone = () => null;

describe('validateVerdict', () => {
  it('accepts a cited, briefed code-cause verdict whose citations were read', () => {
    expect(validateVerdict(BASE, resolveAll)).toEqual({ status: 'valid' });
  });
  it('rejects a run that read no files, before any other check', () => {
    const r = validateVerdict({ ...BASE, filesRead: [], causeText: 'placeholder' }, resolveAll);
    expect(r).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^no_files_read/) });
  });
  it('rejects filler prose', () => {
    const r = validateVerdict({ ...BASE, causeText: 'placeholder while I continue reading' }, resolveAll);
    expect(r).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^filler_verdict/) });
  });
  it('rejects empty cause text', () => {
    expect(validateVerdict({ ...BASE, causeText: '  ' }, resolveAll)).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^empty_verdict/) });
  });
  it('rejects any verdict with zero citations, code-cause or not', () => {
    expect(validateVerdict({ ...BASE, evidence: [] }, resolveAll)).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^no_citations/) });
    expect(validateVerdict({ ...BASE, claimsCodeCause: false, agentTaskBrief: null, evidence: [] }, resolveAll)).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^no_citations/) });
  });
  it('rejects a code-cause claim with no brief', () => {
    expect(validateVerdict({ ...BASE, agentTaskBrief: null }, resolveAll)).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^missing_brief/) });
  });
  it('rejects a filler brief', () => {
    expect(validateVerdict({ ...BASE, agentTaskBrief: 'tbd' }, resolveAll)).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^filler_brief/) });
  });
  it('rejects a citation whose path is absent from the checkout (AC1.7)', () => {
    expect(validateVerdict(BASE, resolveNone)).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^citation_unresolvable: src\/a\.ts/) });
  });
  it('rejects a citation of an existing file the agent never read', () => {
    const r = validateVerdict({ ...BASE, evidence: [{ ...CITE, path: 'src/never-read.ts' }] }, resolveAll);
    expect(r).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^citation_not_read: src\/never-read\.ts/) });
  });
  it('rejects a citation with an empty path', () => {
    const r = validateVerdict({ ...BASE, evidence: [{ ...CITE, path: '  ' }] }, resolveAll);
    expect(r).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^citation_malformed/) });
  });
  it('rejects a citation missing its symptom link', () => {
    const r = validateVerdict({ ...BASE, evidence: [{ ...CITE, symptomLink: '' }] }, resolveAll);
    expect(r).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^citation_missing_link/) });
  });
  it('checks citations on non-code-cause verdicts too', () => {
    const r = validateVerdict({ ...BASE, claimsCodeCause: false, agentTaskBrief: null }, resolveNone);
    expect(r).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^citation_unresolvable/) });
  });
  it('the filler regex matches the prod artifacts', () => {
    expect(FILLER_VERDICT.test('placeholder')).toBe(true);
    expect(FILLER_VERDICT.test('placeholder while I continue reading')).toBe(true);
    expect(FILLER_VERDICT.test('The placeholder text in the input is misrendered')).toBe(true); // known over-match, accepted for NEW verdicts: a real cause about placeholder text re-runs as incomplete; the one-shot quarantine migration uses an anchored regex instead (Task 13)
  });
});
```

- [ ] **Step 2: Run → FAIL** (module absent). `pnpm --filter @opslane/worker test -- verdict-validation`
- [ ] **Step 3: Implement** exactly the ordered checks above. No I/O in this module.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(worker): mechanical verdict validation with structured incomplete reasons (C1/W1.2)`

### Task 3: Split exploration/classification budgets in the read-only harness

**Files:**
- Modify: `packages/worker/src/readonly-agent.ts` (loop :126-235 region; final-turn `tool_choice` at :180-182; stop union at :74-81)
- Test: `packages/worker/src/__tests__/readonly-agent-classification.test.ts` (create)

**Interfaces:**
- Consumes: existing `ReadOnlyRunInput`/`runReadOnlyAgent`.
- Produces (consumed by Tasks 6/7):
  - `ReadOnlyRunInput` gains `classification?: { minFilesRead: number }` — **opt-in**; when absent, behavior is exactly today's (route-map.ts:188-197 and any other caller unaffected).
  - `ReadOnlyStop` gains `'no_evidence'`.
  - **`ReadOnlyRunResult.filesRead: string[]` already exists** (:87; successful `read_file` paths, deduplicated via the Set at :140) — reuse it, no new field, no rename.
- Semantics with `classification` set: the exploration loop runs up to `maxTurns` **without** any forced `tool_choice` (delete the final-turn forcing at :180-182 for this mode), **and both terminal-tool nudges are suppressed for the exploration phase** — the `remaining <= 2` message at :154-161 says "Call {terminalTool.name} now", and the one-shot prose nudge at :237-262 does the same; in classification mode replace the :155 message with a plain "You have N exploration turn(s) remaining." and let the prose-nudge path fall through to ending exploration (classification decides next). The model may still call the terminal tool voluntarily at any point (unchanged). When exploration ends without a terminal call: if `filesRead.length >= minFilesRead`, issue **one additional** request — a user message `Exploration is over. Submit your verdict now using only evidence you actually gathered.` with `tool_choice: { type: 'tool', name: terminalTool.name }` — a dedicated classification turn outside the exploration budget; if that response still lacks the terminal call, stop `'no_tool_call'`. If `filesRead.length < minFilesRead` (including `maxTurns === 0`), skip classification entirely and stop `'no_evidence'`. Budget (`budgetUsd`) still covers the classification call.
- **Bug fix while here:** the `'truncated'` exit at :206 returns `costUsd` computed *before* that call's usage is added at :213 — reorder so every exit path returns cost that includes the final call's usage (truncated friction runs currently underreport cost).

- [ ] **Step 1: Write the failing tests.** Follow the mocking pattern of `__tests__/investigate.test.ts` / `friction/__tests__/investigate-friction.test.ts` (module-scope `vi.mock('@anthropic-ai/sdk')` returning scripted `messages.create` responses). Cases:

```ts
// 1. Exploration reads a file, never classifies → one extra forced-classification call is made;
//    assert the last create() call has tool_choice {type:'tool', name: terminalTool} and the run stops 'terminal'.
// 2. maxTurns=0 with classification {minFilesRead:1} → zero exploration calls, zero classification
//    calls, stop 'no_evidence', filesRead [].
// 3. Exploration calls list_files only (no read_file) → no classification call, stop 'no_evidence'.
// 4. classification undefined → final exploration turn carries tool_choice (today's behavior preserved);
//    assert create() call count === maxTurns and the last call is forced.
// 5. In classification mode, a 3-turn run's exploration requests contain NO instruction to call the
//    terminal tool (the :155 nudge is neutralized) and never carry tool_choice before the dedicated turn.
// 6. The truncated exit's costUsd includes the truncated call's own usage (regression test for the
//    :206-before-:213 ordering bug).
// 7. AC1.6 prefix stability: run a 3-turn script; capture every create() call, DEEP-CLONING the request
//    object at call time (the harness mutates one shared messages array between calls — comparing live
//    references would pass vacuously); assert the system parameter is deeply identical across calls, and
//    for each call i>0 the first (2i-1) messages equal the previous call's messages with cache_control
//    keys stripped (the moving cache marker is the only difference).
```

Write these as real tests with scripted responses, asserting on the captured `create` arguments.

- [ ] **Step 2: Run → FAIL** (`classification` unknown).
- [ ] **Step 3: Implement.** Keep `markLastUserMessageForCaching` (:100-123) untouched — prefix stability comes from never rebuilding `system` or earlier messages; the test proves it. `filesRead` collection at :140/:303 stays as-is.
- [ ] **Step 4: Run the new tests and the existing harness tests → PASS.** `pnpm --filter @opslane/worker test -- readonly-agent && pnpm --filter @opslane/worker test -- route-map` (route-map must be untouched behaviorally).
- [ ] **Step 5: Commit.** `feat(worker): dedicated classification turn gated on minimum evidence (C1/W1.1)`

### Task 4: Error-lane contract — `submit_diagnosis` gains `evidence[]` and `agent_task_brief`

**Files:**
- Modify: `packages/worker/src/diagnose-schema.ts` (tool schema :60-132, required list :126-129; `parseAdjudication` :205-226; **export `seal`** at :41-50 — Task 7 reuses it)
- Modify (only if C0 missed it): `shared/src/types.ts:414-421` re-export block gains `EvidenceCitation`
- Test: extend `packages/worker/src/__tests__/diagnose-schema.test.ts`

**Interfaces:**
- Consumes: C0's `Adjudication.evidence?: EvidenceCitation[]` and `agent_task_brief?: string` (wire shape uses `symptomLink` inside evidence items — frozen by C0's contract test; follow it exactly).
- Produces: `seal` exported. `submitDiagnosisTool()` schema gains, inside `properties` and appended to `required`:

```ts
evidence: {
  type: 'array',
  description: 'Citations that will be mechanically checked against the checkout. Only cite files you actually read.',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repository-relative path, undecorated.' },
      detail: { type: 'string', description: 'What was found at this path.' },
      symptomLink: { type: 'string', description: 'How that finding links to the customer-visible symptom.' },
    },
    required: ['path', 'detail', 'symptomLink'],
  },
},
agent_task_brief: {
  type: 'string',
  description: 'Self-contained markdown brief a coding agent can execute: symptom, files, cause, change, verification. Empty string if you cannot support one.',
},
```

  (`seal()` already forces `additionalProperties: false` recursively — no change there.) `parseAdjudication` maps `evidence` (keeping only entries where all three fields are non-empty strings; malformed entries dropped — the validator judges sufficiency) and `agent_task_brief` (`string` or absent → `undefined`).

- [ ] **Step 1: Failing tests** in `diagnose-schema.test.ts`: (a) `submitDiagnosisTool().input_schema` includes `evidence` and `agent_task_brief` in `required`; (b) `parseAdjudication` round-trips a full input with two citations and a brief; (c) a malformed evidence entry (`{path: 'x'}` only) is dropped while a valid sibling survives; (d) absent fields parse to `undefined` (legacy tool replays still parse); (e) `seal` is importable.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**; check the `shared` re-export (grep `EvidenceCitation` in `shared/src/types.ts`; add to the :414 block if missing).
- [ ] **Step 4:** `pnpm -r build && pnpm --filter @opslane/worker test -- diagnose-schema` → PASS.
- [ ] **Step 5: Commit.** `feat(worker): submit_diagnosis carries checkable evidence and an agent task brief (C1/W1.1)`

### Task 5: Readiness writes in worker persistence

**Files:**
- Modify: `packages/worker/src/db.ts` — `updateGroupInvestigation` (:1727-1816) and `updateGroupAndCreateFixJob` (:1833-1979) gain an optional `readiness` argument; new private helper
- Test: `packages/worker/src/__tests__/digest-readiness.integration.test.ts` (create, DB-gated)

**Interfaces:**
- Produces (consumed by Tasks 6/8/12 and read by Tasks 9/11):

```ts
export type ReadinessStatus = 'eligible' | 'ineligible' | 'pending';
export interface ReadinessWrite { status: ReadinessStatus; reason: string; }
// Both group-update entry points gain: readiness?: ReadinessWrite
```

  Inside each function's existing transaction (immediately after the decision insert at :1807 / :1927 / :1968 respectively), when `readiness` is set (upsert):

```sql
INSERT INTO digest_readiness (incident_id, project_id, status, reason, updated_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (incident_id) DO UPDATE
SET status = EXCLUDED.status, reason = EXCLUDED.reason, updated_at = now()
```

  Single-writer rule: this helper is the **only** TS writer of `digest_readiness`; the only other writers anywhere are migration 045 (Task 13) and the Go requeue transition (Task 13 — that one is UPDATE-only by design). No readiness write when the argument is absent — untouched legacy paths stay absent-row.

- [ ] **Step 1: Failing DB-gated test** (pattern from `__tests__/db.test.ts:27-30`): seed org/project/group (reuse that file's seed helpers), claim a lease the way existing db tests do, then call `updateGroupInvestigation(…, { …, readiness: { status: 'ineligible', reason: 'filler_verdict: x' } })`; SELECT the row and assert. Second case: call again with `eligible`/`validated_cause` → row updated in place (still one row). Third: omit `readiness` → no row for a fresh group.
- [ ] **Step 2: Run with `DATABASE_URL` exported → FAIL.**
- [ ] **Step 3: Implement; run → PASS.** Also run the full worker DB suite: `pnpm --filter @opslane/worker test` with `DATABASE_URL` set.
- [ ] **Step 4: Commit.** `feat(worker): digest_readiness written inside the investigation persistence transactions (C1/W1.2)`

### Task 6: Error lane — validation wired in, `incomplete` persisted

**Files:**
- Modify: `packages/worker/src/investigate.ts` (:234-332; run call :246-260; decision assembly :275-294)
- Modify: `packages/worker/src/classify.ts` (`DerivedDecision.basis` union :13-21 gains `'invalid_verdict' | 'no_evidence'`)
- Modify: `packages/worker/src/index.ts` `processInvestigateJob` (:457-747; branch ladder :637-714)
- Test: extend `packages/worker/src/__tests__/investigate.test.ts`; extend `packages/worker/src/__tests__/classify.test.ts`; new handler-level cases in `packages/worker/src/__tests__/digest-readiness.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `investigateError(apiKey, input, repoPath, investigatedCommit: string)` — the new fourth parameter; index.ts passes `clone.headSha`. `InvestigationResult` gains `evidence: EvidenceCitation[]`, `agentTaskBrief: string | null`, `investigatedCommit: string`.
  - The decision object built at `index.ts:619-631` carries `outcome: 'incomplete'` with `basis: 'invalid_verdict' | 'no_evidence'` when validation fails; its `diagnosis` JSONB gains the **camelCase** keys `investigatedCommit`, `evidence`, `agentTaskBrief` (the `Diagnosis`-side shape — the case rule in the C0 dependency section).
- Persistence contract for `incomplete` (AC1.4, AC1.7): group → `needs_human` with `reason_code: 'insufficient_context'`, `reason_message: <validator reason>`, `remediation: 'Re-run the investigation after more evidence accumulates; the previous run could not verify a cause.'` (computed copy); **`rootCause: null`** (the UPDATE at db.ts:1767 writes NULL through); decision row `outcome='incomplete'`; `readiness: { status: 'ineligible', reason: <validator reason> }`. No fix job (the `code_fix`+`high` branch at index.ts:672-691 is unreachable for `incomplete`).
- Persistence contract for validated verdicts: existing status routing unchanged, plus `readiness: { status: 'eligible', reason: 'validated_cause' }` on the `code_fix` and `not_actionable` branches.
- Persistence contract for `needs_more_context` (no adjudication / insufficient strength / non-terminal stops other than `api_error`): `readiness: { status: 'pending', reason: 'reinvestigating' }` — a full upsert. A previously-eligible incident whose re-investigation failed to conclude is demoted (its stale cause must not stay customer-visible), and an absent-row group that C1's pipeline has now touched enters the projection as `pending` — once an investigation has run under C1, the group is no longer the untouched legacy book, and an inconclusive run must not leave it advertising anything. C2 replaces this with `('ineligible','no_usable_diagnosis')`.

- [ ] **Step 1: Failing unit tests** in `investigate.test.ts` (reuse its temp-repo fixtures at :92-271):
  - a scripted run whose adjudication cites a file the script also read via `read_file`, with brief → result outcome unchanged, `evidence` populated, `investigatedCommit` equals the passed-in sha.
  - a scripted run citing `does/not/exist.ts` → result outcome `'incomplete'`, `basis: 'invalid_verdict'`, decision reason starts `citation_unresolvable:` (AC1.7 unit half).
  - a scripted run citing an existing file it never read → `'incomplete'`, reason starts `citation_not_read:`.
  - a run whose stop is `'no_evidence'` (script: no read_file) → outcome `'incomplete'`, `basis: 'no_evidence'`, reason starts `no_files_read` (AC1.4 unit half).
  - filler `best_supported` → `'incomplete'`, reason starts `filler_verdict` (AC1.3 unit half).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement in `investigate.ts`:** pass `classification: { minFilesRead: 1 }` to `runReadOnlyAgent`; after `deriveOutcome`, call `validateVerdict({ causeText: adjudication.best_supported, claimsCodeCause: decision.outcome === 'code_fix', evidence: adjudication.evidence ?? [], agentTaskBrief: adjudication.agent_task_brief ?? null, filesRead: run.filesRead }, (p) => resolveInsideRepo(repoPath, p))`; on `'incomplete'`, replace the decision with `{ outcome: 'incomplete', basis: 'invalid_verdict', decisionReason: validation.reason }`. Map stop `'no_evidence'` to `{ outcome: 'incomplete', basis: 'no_evidence', … }` in `failed()`/`stopReason()` (:185-226) instead of `needs_more_context`.
- [ ] **Step 4: Implement in `index.ts`:** new first branch in the ladder — `triage.outcome === 'incomplete'` → `updateGroupInvestigation(job.errorGroupId, job.projectId, 'needs_human', { rootCause: null, confidence: triage.confidence, reason: { reason_code: 'insufficient_context', reason_message: triage.decisionReason, remediation: <the computed sentence above> }, decision, readiness: { status: 'ineligible', reason: triage.decisionReason } })`. Add `readiness: { status: 'eligible', reason: 'validated_cause' }` to the `code_fix`-fix-job call (:672-691), the parked-`investigated` call (:692-714), and the `not_actionable`→`insight` call (:653-668). Give :637-651 (`needs_more_context`) the pending upsert above.
- [ ] **Step 5: Failing-then-passing handler-level DB-gated tests** in `digest-readiness.integration.test.ts`: mock the `investigate.js` module (`vi.mock`) to return a scripted `InvestigationResult`, use the real DB, and drive **`processInvestigateJob` itself** (claim a seeded job the way `pr1297.integration.test.ts` does — read it first and copy its harness): (a) incomplete result → group `needs_human`, `root_cause IS NULL`, decision row `outcome='incomplete'` with camelCase `diagnosis` keys, readiness `('ineligible', reason)`, zero fix jobs; (b) validated `code_fix`/`high` result → fix job exists, readiness `('eligible','validated_cause')`; (c) `needs_more_context` on a group with a pre-seeded `eligible` row → row demoted to `pending`; (d) `needs_more_context` on an absent-row group → a `('pending','reinvestigating')` row now exists. Testing only the db functions is NOT sufficient for this task — the handler branch wiring is the deliverable.
- [ ] **Step 6: Run everything.** `pnpm --filter @opslane/worker test` (with and without `DATABASE_URL`), `pnpm -r build`. PASS, zero unexpected skips with the URL set.
- [ ] **Step 7: Commit.** `feat(worker): error-lane verdicts validate or persist incomplete, never prose (C1/W1.2)`

### Task 7: Friction harness rewrite

**Files:**
- Rewrite: `packages/worker/src/friction/investigate-friction.ts` (169 lines today; hand-rolled loop at :107-158 dies)
- Modify: `packages/worker/src/investigate.ts` (export `MODEL_PRICING` and `DEFAULT_PRICING` from :42-50 for reuse — do not copy a fourth pricing table)
- Test: rewrite `packages/worker/src/friction/__tests__/investigate-friction.test.ts`

**Interfaces:**
- Consumes: `runReadOnlyAgent` + `classification` (Task 3), `validateVerdict` (Task 2), `fenced` from `../prompt-fence.ts:19`, `seal` from `../diagnose-schema.ts` (exported in Task 4), `EvidenceCitation` from `@opslane/shared`.
- Produces (consumed by Task 8):

```ts
export const FRICTION_INVESTIGATION_MODEL = process.env['FRICTION_INVESTIGATION_MODEL'] ?? 'claude-sonnet-4-6'; // spike model, named for reproducibility
const MAX_TURNS = Number(process.env['FRICTION_INVESTIGATION_MAX_TURNS'] ?? 20);   // spike budget
const BUDGET_USD = Number(process.env['FRICTION_INVESTIGATION_BUDGET_USD'] ?? 2.0);

export interface FrictionInvestigateInput {
  /** Exactly the current function's inputs, preserved: */
  group: /* current group row parameter type — keep it */;
  evidence: FrictionEvidence | null;   // current second parameter, unchanged
  repoPath: string;                    // current third parameter, unchanged
  sessionContext: /* current fourth parameter type, unchanged */;
  /** New: clone.headSha — echoed on the result and into the decision row. */
  investigatedCommit: string;
}

export interface FrictionVerdict {
  codeCause: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  remediation?: string;
  evidence: EvidenceCitation[];
  agentTaskBrief: string | null;
}

export type FrictionInvestigationResult =
  | { status: 'verdict'; verdict: FrictionVerdict; investigatedCommit: string; usage: ReadOnlyRunResult['usage']; costUsd: number }
  | { status: 'incomplete'; reason: string; investigatedCommit: string; usage: ReadOnlyRunResult['usage']; costUsd: number };
// ReadOnlyRunResult is readonly-agent.ts's existing result type. costUsd = run.costUsd —
// the harness already computes it (:89, :213); do NOT recompute from pricing tables.
// (Task 3 fixes the truncated-exit cost ordering bug so this value is right on every path.)
```

- Terminal tool `classify_friction` v2 (sealed, `strict: true` like `submit_diagnosis`): properties `codeCause` (boolean), `confidence` (enum), `reason` (string), `remediation` (string, optional), `evidence` (same array schema as Task 4), `agent_task_brief` (string); required: `codeCause, confidence, reason, evidence, agent_task_brief`.
- **Runtime parser `parseFrictionVerdict(input: unknown): FrictionVerdict | null`** — `strict: true` is a request-time schema, not a runtime guarantee. Full narrowing table, no clamping (the old clamp-anything `parseResult` is the defect being killed): `codeCause` must be `boolean` else `null`; `confidence` must be exactly `'high'|'medium'|'low'` else `null` (never coerced to `'low'`); `reason` must be a non-empty string else `null`; `evidence` must be an array else `null`, then entries filtered like Task 4's parser (all three fields non-empty strings; malformed entries dropped); `agent_task_brief` non-string or empty → `null` field value (validator judges); `remediation` non-string → `undefined`. A `null` parse becomes `{ status: 'incomplete', reason: 'malformed_verdict: terminal tool input failed to parse' }` — never a throw, never partial persistence.
- System prompt: **one string** (`ReadOnlyRunInput.systemPrompt` is `string`; the harness builds and cache-marks the text-block array internally at :146-148 — do not change that interface), built once per run by concatenating: instruction paragraph (keep the current honesty instruction, add: *"Only classify after reading files. Cite only files you actually read. If you cannot verify a cause, say so plainly — an unverified guess is worse than no answer."*), untrusted-data warning, then `fenced()` blocks for: the incident JSON (title, signalType, elementSelector, pageUrlNormalized — the route identity), the friction evidence (signals/timeline/sessionContext as today), and the **repo file tree**: `git ls-files` output from the clone (reuse the `execFile` pattern of `repo-clone.ts`), truncated to the first 8192 **characters** with a trailing `…truncated` marker line. Prompt caching comes free from `runReadOnlyAgent` — the old harness's uncached plain-string `system` parameter dies with it.
- **Stop mapping, exhaustive** — every `ReadOnlyStop` value has a defined outcome; nothing falls through:
  - `'terminal'` → parse + validate as below.
  - `'api_error'` → **throw** (today's rethrow semantics preserved — the poller retries; :120-128 of the old file).
  - `'no_evidence'` → `{ status: 'incomplete', reason: 'no_files_read: the investigation read no repository files' }`.
  - `'budget'` → `{ status: 'incomplete', reason: 'budget_exhausted: spend ceiling reached before a verdict' }`.
  - `'no_tool_call'` → `{ status: 'incomplete', reason: 'no_verdict_submitted: the model never called classify_friction' }`.
  - `'truncated'` → `{ status: 'incomplete', reason: 'truncated_response: output token limit hit before a verdict' }`.
  - `'turns_exhausted'` → unreachable in classification mode (the dedicated turn intercepts it), but map defensively to `no_verdict_submitted`.
- Validation on `'terminal'`: `parseFrictionVerdict`, then `validateVerdict({ causeText: verdict.reason, claimsCodeCause: verdict.codeCause, evidence, agentTaskBrief, filesRead: run.filesRead }, (p) => resolveInsideRepo(input.repoPath, p))`; validation failure → `{ status: 'incomplete', reason }`.

- [ ] **Step 1: Failing tests** (rewrite the test file; keep the SDK module-mock pattern): (a) happy path — script one `read_file` turn then a classify with evidence citing the file that was read → `status: 'verdict'` with parsed evidence and `costUsd > 0`; (b) filler reason → `status: 'incomplete'`, reason `filler_verdict…`; (c) no read_file before classify-forcing → `'incomplete'`, `no_files_read…`, and **zero** classification calls made (assert call count); (d) evidence citing an absent path → `'incomplete'`, `citation_unresolvable:…`; (e) malformed terminal input — `codeCause` as a string, and separately `confidence: 'certain'` → `'incomplete'`, `malformed_verdict…`, no throw, no clamping; (f) 429 on turn one → throws (poller-retry contract preserved); (g) budget-stop script → `'incomplete'`, `budget_exhausted…`; (h) the system prompt contains the fenced file tree and is identical across turns.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement the rewrite.**
- [ ] **Step 4: Run → PASS**, plus `pnpm --filter @opslane/worker build`.
- [ ] **Step 5: Commit.** `feat(worker): friction investigator on the shared harness — evidence-gated, cached, validated (C1/W1.1)`

### Task 8: Friction pipeline integration — decision rows, readiness, incomplete

**Files:**
- Modify: `packages/worker/src/index.ts` `processFrictionInvestigateJob` (:749-870; result branches :812-858)
- Test: handler-level cases in `packages/worker/src/__tests__/digest-readiness.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 5/7. The friction lane starts writing `diagnosis_decisions` rows (it writes none today) — decision object shape (camelCase `diagnosis` keys, per the case rule):

```ts
{
  outcome: verdict.codeCause ? 'code_fix' : 'not_actionable',   // or 'incomplete'
  decisionReason: verdict.reason /* or the incomplete reason */,
  causeLocation: evidence.map(e => e.path).join(', ') || null,
  diagnosis: { evidence, agentTaskBrief: verdict.agentTaskBrief, investigatedCommit: result.investigatedCommit, verdict },
  model: FRICTION_INVESTIGATION_MODEL,
  promptVersion: 'friction-diagnosis-v2',
  jobId: job.id,
  basis: 'friction_classify',   // basis is TEXT, unconstrained; loadDiagnosisDecision requires non-null
  confidence: verdict.confidence,
}
```

- Branch mapping (replacing :822-858, statuses unchanged for valid verdicts):
  - `incomplete` → `updateGroupInvestigation(…, 'needs_human', { rootCause: null, confidence: 'low', reason: { reason_code: 'insufficient_context', reason_message: <reason>, remediation: <Task 6's computed sentence> }, decision, readiness: { status: 'ineligible', reason } })`. (`needs_human` is legal for friction groups; the friction fix gate at queries.go:1251-1264 requires `awaiting_approval`, so fix stays unreachable.)
  - valid + `codeCause` + `high` + autonomy allows (and **not** report-only — Task 12) → `updateGroupAndCreateFixJob(…, { …, decision, readiness: { status: 'eligible', reason: 'validated_cause' } }, job, { allowFriction: true })`
  - valid + `codeCause` otherwise → `'awaiting_approval'` with decision + readiness eligible
  - valid + `!codeCause` → `'insight'` with decision + readiness eligible
- Also: `recordJobUsage({ phase: 'investigation', model: FRICTION_INVESTIGATION_MODEL, usage: result.usage, costUsd: result.costUsd })` — parity with the error lane at index.ts:601-608. The handler builds `FrictionInvestigateInput` with `investigatedCommit: clone.headSha`.

- [ ] **Step 1: Failing handler-level DB-gated tests** (same harness as Task 6 Step 5 — mock `investigate-friction.js`, real DB, drive `processFrictionInvestigateJob`): (a) incomplete result → group `needs_human`, `root_cause IS NULL`, decision `outcome='incomplete'`, readiness ineligible, zero fix jobs; (b) valid insight result → `insight` status, decision `not_actionable` with camelCase `diagnosis` keys and `investigatedCommit`, readiness eligible; (c) valid `codeCause`/`high` with autonomy → fix job created, readiness eligible.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS** (`pnpm --filter @opslane/worker test` with `DATABASE_URL`).
- [ ] **Step 5: Commit.** `feat(worker): friction verdicts persist decisions and readiness, incomplete parks honest (C1/W1.2)`

### Task 9: Incident DTO — readiness, gated cause, labeled brief

**Files:**
- Modify: `packages/ingestion/db/queries.go` (`ErrorGroup` struct :379-413; `GetErrorGroup` :1094-1130; `ListErrorGroups` :759+; new `GetLatestAgentTaskBrief`)
- Modify: `packages/ingestion/handler/read_api.go` (`incidentJSON` :22-53; `toIncidentJSON` :96-136; `GetIncident` :288-342)
- Modify: `shared/src/types.ts` (`Incident` :273-316, append-only)
- Modify: `packages/dashboard/src/types/api.ts` (`Incident` :148-185, mirror)
- Test: `packages/ingestion/handler/read_api_readiness_test.go` (create — pure mapper test) + DB-gated query test in `packages/ingestion/db/queries_test.go`

**Interfaces:**
- Produces (consumed by Tasks 10/11 and every later surface checkpoint):
  - `db.ErrorGroup` gains `InvestigationReadiness *string`. Both loaders add `LEFT JOIN digest_readiness dr ON dr.incident_id = g.id` and select `dr.status`. `GetErrorGroup`'s query has no alias today (`FROM error_groups`) — alias it `g` and qualify the existing columns; `ListErrorGroups` builds SQL dynamically — add the join and column to its select the same way (read the full function before editing; the WHERE-builder must not be disturbed).
  - New query — bound to validated decisions, not just the newest row:

```go
// GetLatestAgentTaskBrief returns the newest eligible-marked decision's brief for the
// group, or nil. Served only when readiness is 'eligible' (handler-enforced); the
// outcome predicate names exactly the outcomes C1 marks eligible — not merely
// "not incomplete" (needs_more_context is also not validated) — as belt-and-braces
// against readiness/decision skew.
func (q *Queries) GetLatestAgentTaskBrief(ctx context.Context, projectID, groupID string) (*string, error)
// SELECT NULLIF(btrim(diagnosis->>'agentTaskBrief'), '') FROM diagnosis_decisions
// WHERE error_group_id = $2 AND project_id = $1 AND outcome IN ('code_fix','not_actionable')
// ORDER BY decided_at DESC, id DESC LIMIT 1
```

  - `incidentJSON` gains `InvestigationReadiness *string \`json:"investigation_readiness,omitempty"\`` and `AgentTaskBrief *string \`json:"agent_task_brief,omitempty"\``.
  - `toIncidentJSON` gains the gate — the server is the enforcement point, the dashboard is defense-in-depth:

```go
if g.InvestigationReadiness != nil &&
    (*g.InvestigationReadiness == "ineligible" || *g.InvestigationReadiness == "pending") {
    inc.RootCause = nil
    inc.SuggestedMitigation = nil
}
inc.InvestigationReadiness = g.InvestigationReadiness
```

  - `GetIncident` attaches the brief best-effort (like the trace URL at :324-328) **only when** readiness is `eligible`. `ListIncidents` never carries the brief.
  - `shared/src/types.ts` `Incident` gains `investigation_readiness?: 'eligible' | 'ineligible' | 'pending';` and `agent_task_brief?: string;` (with a doc comment: *model-authored technical report; render only under an investigation-output label*). Dashboard `types/api.ts` mirrors both.

- [ ] **Step 1: Failing mapper test** (no DB): construct `db.ErrorGroup{RootCause: ptr("placeholder"), SuggestedMitigation: ptr("x"), InvestigationReadiness: ptr("ineligible")}` → JSON has no `root_cause`, no `suggested_mitigation`, has `investigation_readiness: "ineligible"`; readiness nil → `root_cause` present, no `investigation_readiness` key; readiness `pending` → cause absent; readiness `eligible` → cause present.
- [ ] **Step 2: Failing DB-gated query test:** seed group + readiness row → `GetErrorGroup` returns the status and `ListErrorGroups` carries it; seed three decision rows — an older `code_fix` one with `diagnosis: {"agentTaskBrief": "## brief"}`, a newer `outcome='incomplete'` one, and a newer `needs_more_context` one → `GetLatestAgentTaskBrief` returns the `code_fix` brief (both non-validated outcomes skipped); empty/whitespace brief → nil.
- [ ] **Step 3: Implement. Step 4:** `(cd packages/ingestion && go build ./... && go test ./...)` (zero skips with DB up) and `pnpm -r build` (shared + dashboard types compile). Confirm `git diff -- test-fixtures/wire/` is empty. PASS.
- [ ] **Step 5: Commit.** `feat(ingestion): incident DTO gates unverified causes behind the readiness projection (C1/W1.5)`

### Task 10: Dashboard honest state

**Files:**
- Modify: `packages/dashboard/src/views/IncidentDetail.vue` (investigation card gate :507-530; insight card :532-558)
- Modify: `packages/dashboard/src/components/incidents/IncidentConclusion.vue` (:28-49 — every cause/confidence/mitigation section)
- Test: `packages/dashboard/src/views/__tests__/incident-detail-honest-state.test.ts` (create — copy the harness of `incident-detail-sample-event.test.ts`: `// @vitest-environment jsdom`, `vi.mock('../../api')`, `vi.mock('vue-router')`); `packages/dashboard/src/components/incidents/__tests__/incident-conclusion.test.ts` (create — first test for this component)

**Interfaces:**
- Consumes: Task 9's DTO fields.
- Produces the honest surface (AC1.2/AC1.3 drivable halves):
  - A computed in both components: `const causeHidden = computed(() => incident.investigation_readiness === 'ineligible' || incident.investigation_readiness === 'pending')`.
  - `IncidentDetail.vue`: the :509 gate and the :532 insight gate each gain `&& !causeHidden`. In their place, when `causeHidden`, render the honest card (exact copy, templated, no model prose):

```html
<div v-if="causeHidden" class="…existing card classes on the :507 card, reused verbatim…" data-testid="honest-state">
  <h2 class="…same heading classes…">Investigation</h2>
  <p class="text-sm">Investigation has not verified a cause yet.</p>
</div>
```

  (Replay links and occurrence/user counts already render unconditionally at :366-403 and :284-292 — the honest state is the card plus those existing surfaces, per W1.5.)
  - Brief rendering under the label (AC1.5 drivable half): inside the investigation-results card (only reachable when not hidden), after the Root Cause block:

```html
<div v-if="incident.agent_task_brief" class="mt-4">
  <h3 class="…existing subheading classes…">Investigation output — agent task brief</h3>
  <pre class="whitespace-pre-wrap text-sm" v-text="incident.agent_task_brief"></pre>
</div>
```

  (`v-text`/`pre` — never `v-html`; the brief is model prose rendered only under this label.)
  - `IncidentConclusion.vue`: accepts the same `Incident` prop; wrap the confidence (:28-33), root cause (:35-38), and mitigation (:40-43) sections in `v-if="!causeHidden"`; when hidden, render the single line `Investigation has not verified a cause yet.`
- [ ] **Step 1: Failing component tests:** (a) incident with `root_cause: 'placeholder'` + `investigation_readiness: 'ineligible'` → `[data-testid="honest-state"]` present, text `placeholder` absent from the rendered HTML; (b) no `investigation_readiness` field → root cause rendered (legacy unchanged); (c) `eligible` + `agent_task_brief` → brief text present under a heading containing `Investigation output`; (d) same trio for `IncidentConclusion`.
- [ ] **Step 2: Run → FAIL.** `pnpm --filter @opslane/dashboard test`
- [ ] **Step 3: Implement. Step 4: Run → PASS**, plus `pnpm --filter @opslane/dashboard build`.
- [ ] **Step 5: Commit.** `feat(dashboard): honest not-verified state; brief renders only as labeled investigation output (C1/W1.5)`

### Task 11: Digest interim predicate

**Files:**
- Modify: `packages/ingestion/digest/build.go` — every group-derived section query: `buildTopNewIssues` (:195-240), `buildInsights` (:96-146), `buildNeedsHuman` (:302-339), `buildPRsOpened` (:242-271), `buildPRsMerged` (:273-300)
- Test: extend `packages/ingestion/digest/build_test.go`

**Interfaces:**
- Consumes: `digest_readiness` rows written by Tasks 5–8 and 13.
- Produces the interim gate (program §C1 W1.5, replaced at C4): each section's WHERE gains, uniformly:

```sql
AND NOT EXISTS (
  SELECT 1 FROM digest_readiness dr
  WHERE dr.incident_id = g.id AND dr.status IN ('ineligible', 'pending')
)
```

  Absent-row incidents keep rendering — **the explicit, temporary legacy policy**. Add one comment at the first occurrence: `-- C1 interim readiness gate: ineligible/pending excluded; absent rows are the legacy book and render as today. C4 flips to eligible-only after the C3 backfill.`

- [ ] **Step 1: Failing tests** in `build_test.go` (it seeds groups already — follow its fixtures), a full matrix: for **each of the five sections** (new issue, insight, needs-human, PR-opened, PR-merged), one seeded group with an `('ineligible','x')` row and one with a `('pending','x')` row are excluded, and a readiness-row-free sibling in the same section appears exactly as before (assert against the existing expected payloads — they must not change otherwise).
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4:** `(cd packages/ingestion && go test ./digest/...)` → PASS, and the pre-existing digest tests still pass unmodified (byte-stable legacy payloads).
- [ ] **Step 5: Commit.** `feat(digest): exclude readiness-ineligible incidents — interim gate until C4 (C1/W1.5)`

### Task 12: Report-only attribution — structurally unreachable fix path

**Files:**
- Modify: `packages/worker/src/db.ts` (`ClaimedJob.triggeredBy` type at :200 if narrowed; guard at the **entry** of `updateGroupAndCreateFixJob`)
- Modify: `packages/worker/src/index.ts` (both investigate handlers)
- Create: `scripts/reinvestigate-quarantined.sql`
- Test: `packages/worker/src/__tests__/report-only.integration.test.ts` (create, DB-gated)

**Interfaces:**
- Consumes: 044's widened `triggered_by` CHECK; Task 13's `quarantined_degenerate` readiness rows (Task 13 merges after this — the script selects zero rows until then, which is safe; it runs manually at CP1 anyway).
- Produces:
  - Guard as the **first statement of `updateGroupAndCreateFixJob`, before the transaction opens and before any group mutation or pending-job reuse** (the :1891-1931 reuse branch and the :1933-1948 group UPDATE must both be unreachable — a late guard would strand the group in `fixing` with no job):

```ts
if (job.triggeredBy === 'reinvestigate_report_only') {
  return { created: false, reason: 'report_only' };
}
```

  - Handler branch: in both `processInvestigateJob` and `processFrictionInvestigateJob`, `const reportOnly = job.triggeredBy === 'reinvestigate_report_only';` — when true, the fix-eligible branch routes to the parked status instead (`'investigated'` for errors, `'awaiting_approval'` for friction), decision + readiness written exactly as in Tasks 6/8. The db.ts guard is the backstop, not the mechanism.
  - The re-enqueue script (run manually against prod for AC1.1). Semantics: **idempotent over success, retryable over infra failure** — a prior report-only job that is `pending`, `claimed`, or `completed` blocks a re-insert; a run whose report-only jobs all landed `failed`/`dead_letter` can be re-run to retry them. Concurrency-safe via an advisory lock (it is an ops script; two operators must not double-enqueue):

```sql
-- C1/W1.4: report-only re-investigation of quarantined incidents.
-- Idempotent over success; re-runnable to retry failed/dead-letter attempts.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('reinvestigate-quarantined'));
INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
SELECT r.incident_id, r.project_id, 'investigate', 'reinvestigate_report_only'
FROM digest_readiness r
WHERE r.reason = 'quarantined_degenerate'
  AND NOT EXISTS (
    SELECT 1 FROM error_group_jobs j
    WHERE j.error_group_id = r.incident_id
      AND j.triggered_by = 'reinvestigate_report_only'
      AND j.status IN ('pending', 'claimed', 'completed')
  );
COMMIT;
```

- [ ] **Step 1: Failing tests:** (a) `updateGroupAndCreateFixJob` called with a claimed job whose `triggeredBy` is `'reinvestigate_report_only'` and a `code_fix`/`high` decision → `{ created: false, reason: 'report_only' }`, zero rows in `error_group_jobs` with `job_type='fix'` for the group, **and the group's status is unchanged** (not `fixing` — proves the guard ran before any mutation); (b) handler-level: report-only friction job with a validated `codeCause`/`high` verdict → group `awaiting_approval`, readiness eligible, zero fix jobs; (c) script semantics, three assertions: fresh `quarantined_degenerate` row → run inserts one job; flip that job to `completed` and re-run → still one job; flip it to `failed` and re-run → a second job appears (retry path open).
- [ ] **Step 2: Run → FAIL** (guard absent; script file read by the test via `fs.readFile`).
- [ ] **Step 3: Implement. Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(worker): report-only reinvestigation can never create a fix job (C1/W1.4)`

### Task 13: Quarantine migration 045 + requeue readiness transition

**Files:**
- Create: `packages/ingestion/db/migrations/045_quarantine_degenerate_verdicts.sql`
- Modify: `packages/ingestion/db/queries.go` (requeue UPDATE at :709-721)
- Test: `packages/ingestion/db/migration_045_test.go` (create); extend `packages/ingestion/db/error_group_ingestion_test.go` for the requeue transition

**Interfaces:**
- Consumes: 044's `digest_readiness` and `applied_data_migrations` (exists since 038 — read `038_daily_digest.sql:18-26` and copy its guard shape exactly).
- Produces: the `'quarantined_degenerate'` reason consumed by Task 12's script and AC1.2.

**The migration** (one-shot: the runner re-applies every file on every boot — `scripts/run-migrations.sh:11-15` — and a re-run must NOT re-quarantine an incident that a later validated investigation marked eligible; hence the marker, not an upsert). The regex is **anchored** — the prod artifacts all start with the degenerate token (`placeholder`, `placeholder while I continue reading`), and anchoring keeps a legitimate cause that merely mentions placeholder text (e.g. "The placeholder text in the input is misrendered") out of a one-shot data migration; the validator's broader regex only ever affects *new* verdicts, which re-run:

```sql
-- 045_quarantine_degenerate_verdicts.sql
-- C1/W1.3: persisted degenerate investigation verdicts become digest-ineligible.
-- Content-driven, anchored (7 rows in prod on 2026-08-10; 0 in fresh databases).
-- One-shot via applied_data_migrations: boot re-runs must not undo later
-- re-investigation results.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM applied_data_migrations WHERE name = '045_quarantine_degenerate_verdicts') THEN
    INSERT INTO digest_readiness (incident_id, project_id, status, reason)
    SELECT g.id, g.project_id, 'ineligible', 'quarantined_degenerate'
    FROM error_groups g
    WHERE g.root_cause ~* '^\s*(placeholder|tbd|to be determined)\M'
    ON CONFLICT (incident_id) DO UPDATE
      SET status = 'ineligible', reason = 'quarantined_degenerate', updated_at = now();
    INSERT INTO applied_data_migrations (name) VALUES ('045_quarantine_degenerate_verdicts');
  END IF;
END
$$;
```

  (Verify the `applied_data_migrations` column is `name` by reading 038; if it differs, follow 038.) The migration does **not** null `error_groups.root_cause` (the stored string stays as forensic data; surfaces gate on readiness) and does **not** touch `diagnosis_decisions` (trigger-immutable since 034). **Before the prod release:** run the SELECT alone against a prod copy and confirm the count is exactly the expected 7 (record the count and IDs in the PR); a surprise match set stops the release. The pre-count is deliberately advisory rather than an in-migration assertion: the predicate is content-driven by design ("the 7 existing placeholder artifacts *and any persisted degenerate root_cause*", design §6.2) — if an old worker persists one more placeholder between rehearsal and migration, quarantining it is the correct outcome, not a defect; the runbook records the actual post-run set (Task 14 Step 6).

**The requeue transition** (queries.go:709-721 clears `root_cause` when new events requeue a group; a stale `eligible` row would then vouch for a cause that no longer exists): in the same transaction, after the group UPDATE:

```sql
UPDATE digest_readiness
SET status = 'pending', reason = 'reinvestigating', updated_at = now()
WHERE incident_id = $1
```

  **UPDATE, not upsert** — a legacy group with no readiness row must stay absent-row (writing `pending` would silently remove legacy incidents from the digest, which is C3/C4's decision, not C1's).

- [ ] **Step 1: Failing migration test** (reuse `migrationFiles`/`findPsql`/`disposableDB`/`applyMigration` from `db/migrations_test.go:18-100`): apply migrations through 044; seed a project + three groups: `root_cause='placeholder while I continue reading'`, `root_cause='NPE in checkout when coupon is stale'`, and `root_cause='The placeholder text in the input is misrendered'`; apply 045 → exactly one readiness row (the first group), `('ineligible','quarantined_degenerate')` — the anchored regex spares the third; apply 045 again after flipping that row to `eligible` → still `eligible` (marker respected). Note in the PR: `TestMigrations_RollForwardFromPreviousSchema` (:199) now rolls forward 045 instead of 044 by construction — expected.
- [ ] **Step 2: Failing requeue test** in `error_group_ingestion_test.go`: group with an `eligible` readiness row receives a new event that requeues it → readiness `('pending','reinvestigating')`; group with no row → still no row.
- [ ] **Step 3: Implement both. Step 4:** `(cd packages/ingestion && go build ./... && go test ./db/...)` with `DATABASE_URL` exported → PASS, zero skips.
- [ ] **Step 5: Commit.** `feat(db): quarantine degenerate verdicts; requeue resets readiness to pending (C1/W1.3)`

### Task 14: CP1 verification run

No new **production** code. The one checked-in artifact is the model stub below (test support, versioned so the checkpoint is reproducible). Prove the checkpoint criteria from the program plan (§CP1), then the repository gate.

- [ ] **Step 1: Full gate.** `pnpm install --frozen-lockfile && pnpm -r build && pnpm test` with `DATABASE_URL` exported (read skip counts, not pass counts); `(cd packages/ingestion && go build ./... && go test ./...)` → **zero skips**; `docker compose config --quiet`.
- [ ] **Step 2: AC1.6 [gate] live half.** Stack up (worktree port block from root `AGENTS.md` if defaults are taken). Run one friction investigation twice against a fixture repo (use `test-fixtures/vue-app`); open the Langfuse trace for the second run: `cache_read_input_tokens >= 1024` (the minimum cacheable block — a bare nonzero could be a trivial prefix; the system prompt with the file tree is far larger, so record the actual number and sanity-check it against the run-1 input size); the persisted decision's `diagnosis->>'investigatedCommit'` equals the fixture clone's HEAD (`git rev-parse HEAD`). The byte-stable-prefix unit assertion already ran in Step 1 (Task 3's test).
- [ ] **Step 3: AC1.3/AC1.4 drivable — through the real pipeline, no worker-code mocks.** Force the *model*, not the worker: the Anthropic SDK honors `ANTHROPIC_BASE_URL`, so point the worker at a local stub HTTP server that speaks the Messages API shape and returns a scripted `classify_friction`/`submit_diagnosis` filler verdict. **Check the stub in** at `test-e2e/support/anthropic-stub.mjs` (versioned — the checkpoint must be reproducible from the tree, not from a scratchpad) and have it count requests; after each scenario assert the stub's request count is > 0 (proves the worker actually went through it, not through a cached path or the real API). The worker binary, queue, persistence, API, dashboard, and digest are all real. (AC1.3) send an event / seed a friction promotion → job runs against the stub → assert `SELECT status, reason FROM digest_readiness WHERE incident_id = …` → `('ineligible','filler_verdict…')` **written by the pipeline**; load the incident page → honest card, no cause text; build a digest → no row. (AC1.4) restart the worker with `FRICTION_INVESTIGATION_MAX_TURNS=0` (and once with `INVESTIGATION_MAX_TURNS=0` for the error lane) → decision `outcome='incomplete'` with reason `no_files_read…`, `root_cause IS NULL`, readiness ineligible, zero fix jobs.
- [ ] **Step 4: AC1.5 drivable.** Seed a crash through `test-fixtures/vue-app` whose planted cause file is known; wait for the error-lane investigation (real model); assert the decision's `evidence` cites the planted file with a non-empty `symptomLink`, and the incident page shows the brief under the "Investigation output" label.
- [ ] **Step 5: AC1.2 pre-prod rehearsal.** On a prod-shaped copy (or the dev stack seeded with a `root_cause='placeholder'` group), apply 045, open the incident page (honest state), build a digest (no row for it). Run the Task 13 pre-count SELECT against the prod copy and record the 7 IDs.
- [ ] **Step 6: AC1.1 prod runbook** (the live criterion; run after the full PR1–PR5 release deploys): apply migrations (044+045 via the normal migrate service); run `scripts/reinvestigate-quarantined.sql`; wait, then assert with read-only SQL, recording every output in the CP1 note on the PR. Note on regexes: the persisted `decision_reason` for a rejected filler verdict legitimately *contains* the word "placeholder" (`filler_verdict: cause text matches a placeholder pattern`), so the degeneracy checks below run against **cause fields only** — `error_groups.root_cause` and the decision's cause prose (`diagnosis->>'agentTaskBrief'`, `diagnosis->'verdict'->>'reason'`) — never against `decision_reason`:
  1. All 7 jobs terminal: `SELECT count(*) FROM error_group_jobs WHERE triggered_by='reinvestigate_report_only' AND status IN ('completed','failed','dead_letter')` → 7, and `SELECT count(*) … WHERE triggered_by='reinvestigate_report_only'` → 7 (none stuck pending/claimed).
  2. Zero fresh degenerate causes on the 7: for each recorded ID, `root_cause IS NULL OR root_cause !~* '\m(placeholder|tbd|to be determined)\M'`, and the latest decision's `diagnosis->>'agentTaskBrief'` and `diagnosis->'verdict'->>'reason'` (when present) fail the same regex.
  3. ≥5 validated: for ≥5 of the 7 IDs, the latest decision has `outcome IN ('code_fix','not_actionable')`, `jsonb_array_length(diagnosis->'evidence') >= 1`, and the group's readiness row is `('eligible','validated_cause')`.
  4. **Independent citation re-verification** (the checkpoint must not trust the worker's own checker — nothing grades its own work): for each of the ≥5, a small checked-in script (`scripts/verify-citations.sh <repo> <commit> <paths…>`, plain git: `git fetch && git cat-file -e <commit>:<path>` per citation) checks out nothing and confirms every cited path exists at that decision's `diagnosis->>'investigatedCommit'`. Every citation resolves → pass; any miss is a CP1 failure regardless of what the readiness row says.
  5. The rest are structured: every remaining ID's latest decision is `outcome='incomplete'` with a reason-code-prefixed `decision_reason`, readiness `ineligible`.
  6. Zero fix jobs: `SELECT count(*) FROM error_group_jobs WHERE job_type IN ('fix','error_fix') AND error_group_id = ANY(<the 7 recorded IDs>) AND created_at > <release timestamp>` → 0.
- [ ] **Step 7:** Run `/opslane-verify:verify` with the CP1 drivable criteria (AC1.1–AC1.5) as the pre-drafted half, per the program's verification method.

## CP1 criteria → task map

| AC | Covered by |
|---|---|
| AC1.1 (7 re-investigated report-only, no fix jobs) | Tasks 7–8, 12–13; run in Task 14 Step 6 |
| AC1.2 (quarantined page honest, digest silent) | Tasks 9, 10, 11, 13; Task 14 Step 5 |
| AC1.3 (filler → pipeline-written ineligible) | Tasks 2, 6, 8; Task 14 Step 3 (real pipeline + model stub) |
| AC1.4 (zero exploration budget → incomplete) | Tasks 3, 6, 8; Task 14 Step 3 |
| AC1.5 (planted cause cited; brief labeled) | Tasks 4, 6, 9, 10; Task 14 Step 4 |
| AC1.6 [gate] (stable prefix, cache hit, investigatedCommit) | Tasks 1, 3 (unit); Task 14 Step 2 (trace) |
| AC1.7 [gate] (absent-file citation → incomplete) | Tasks 2, 6 (unit) |

## Execution notes

- Tasks 1–4 are pure-worker and independent of C0's migration; Tasks 5+ need 044 applied to the dev database.
- The friction lane keeps `confidence` in its verdict and routing (C2 removes confidence from routing; C1 only adds the `incomplete` stop). The friction autonomy gate at index.ts:1008-1019 is untouched.
- `packages/worker/src/pipeline.ts:170` (`root_cause` 200-char slice) is the fix path, not the investigation path — out of scope.
- Deliberate C1 non-goals: no route_map name lookup in the friction prompt (`page_url_normalized` is the route identity until T2/C6-adjacent work); relabeling pre-existing digest excerpt lines and issue-page section order (C4/C5's owned scope — see the copy-rule constraint above); no backfill of readiness for the legacy book (C3).

## Revision log

**v2 after Codex round 1 (21 findings: 16 P1, 5 P2).** Accepted: camelCase `diagnosis` JSONB keys per the C0 case rule (was snake_case — contract violation); ≥1 citation required for every verdict, not just code-cause; citations must name files the agent actually read (`filesReadPaths` set, new `citation_not_read` reason); malformed-citation guards (`citation_malformed`); stale-eligible demotion on `needs_more_context` (`updateOnly` pending write); PR train reordered so surfaces (now Tasks 9–11) merge before quarantine (now Task 13) — the quarantining release must already render the honest state; one-shot re-enqueue script (any prior report-only job blocks re-insert; old version re-inserted after jobs went terminal); report-only guard moved to `updateGroupAndCreateFixJob` entry before any mutation; `FrictionInvestigateInput`/`investigatedCommit` ownership pinned (handler passes `clone.headSha`); `costUsd` computed in the harness and threaded to `recordJobUsage`; `seal` export added to Task 4; runtime `parseFrictionVerdict` with `malformed_verdict` degradation; handler-level integration tests made mandatory in Tasks 6/8/12 (db-function-only testing ruled out); AC1.1 runbook SQL tightened (terminal-state count, per-ID latest-decision checks, eligible-readiness proof for the ≥5); AC1.3/AC1.4 driven through the real pipeline via an `ANTHROPIC_BASE_URL` model stub instead of worker mocks; filler check extended to the brief (`filler_brief`); `GetLatestAgentTaskBrief` excludes `incomplete` decisions; digest test matrix covers all five sections × both excluded statuses; quarantine regex anchored + prod pre-count step; file-tree cap specified in characters. Partially accepted: full copy-rule labeling of digest excerpt lines and issue-page ordering stays C4/C5 scope, now stated explicitly as a documented deferral in Global Constraints. Codex note: its sandbox could not read repo files (bwrap bootstrap failure), so round 1 findings are plan-internal consistency checks; round 2 re-verified source-anchored claims with the two load-bearing files inlined.

**v3 after Codex round 2 (22 findings: 13 P1, 8 P2, 1 P3 confirming the plan's source claims; round-1 resolutions verified — 14 of 16 P1s confirmed resolved, 2 re-raised).** Accepted (source-confirmed by direct grep before folding): reuse the **existing** `ReadOnlyRunResult.filesRead: string[]` (:87) instead of inventing `filesReadPaths` — no rename, existing callers untouched; suppress both terminal-tool nudges (:154-161 "Call {tool} now", :237-262 prose nudge) during exploration in classification mode — they were a second forced-verdict path; keep `systemPrompt` a `string` (the harness cache-marks internally; Task 7's block-array wording was wrong); fix the `'truncated'` exit returning `costUsd` computed before that call's usage (:206 vs :213) and use `run.costUsd` in the friction result instead of recomputing; `FrictionInvestigateInput` preserves the current function's real parameters (`evidence: FrictionEvidence | null`, `sessionContext`); exhaustive stop→outcome mapping for every `ReadOnlyStop` value; full `parseFrictionVerdict` narrowing table with no confidence clamping; `needs_more_context` writes a full `('pending','reinvestigating')` upsert — a C1-era inconclusive run takes the group out of customer surfaces even if it was absent-row (it is no longer untouched legacy); re-enqueue script made idempotent-over-success and retryable-over-failure (`status IN ('pending','claimed','completed')` blocks; failed/dead-letter reopens) with an advisory lock; CP1 Step 6 regex moved off `decision_reason` (whose filler-rejection strings legitimately contain "placeholder") onto cause fields only; **independent citation re-verification** added to the AC1.1 runbook (`git cat-file -e` per citation at `investigatedCommit` — the checkpoint no longer trusts the worker's own checker); `GetLatestAgentTaskBrief` filters to `outcome IN ('code_fix','not_actionable')`; model stub checked in at `test-e2e/support/anthropic-stub.mjs` with a request-count assertion; cache assertion floored at 1024 tokens and recorded; prefix-stability test deep-clones captured requests (the harness mutates a shared messages array); `cloneRepo`-level `headSha` test coverage required; deploy-window semantics documented (migration-before-readers is safe-degraded — old readers ignore readiness rows, behavior equals today until the roll completes). Rejected, with rationale recorded: (R2#1) relabeling digest excerpt lines/issue-page order stays C4/C5 — the parent program plan itself assigns those surfaces to C4/C5 and scopes C1's W1.5 to the readiness gate, honest state, and labeled brief; C1 guarantees no *unvalidated* model prose can render anywhere, which is the checkpoint's slice of the copy rule. (R2#11) the quarantine predicate stays content-driven rather than ID-pinned or count-asserted — design §6.2 explicitly covers "any persisted degenerate root_cause", and a late-arriving placeholder from an old worker *should* be quarantined; the pre-count is advisory by design. (R2#19) mechanical brief-structure validation beyond non-empty/non-filler is out — the design's honesty note states brief/linkage quality is rubric-sampled (T7), not mechanical, and pretending otherwise would be a fake gate.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found → addressed | R1: 16 P1 / 5 P2; R2: 13 P1 / 8 P2 / 1 P3; 40 accepted, 3 rejected with recorded rationale |
| Eng Review | `/plan-eng-review` | Architecture & tests | 0 | not run | — |

**CODEX:** Two consult-mode iterations (session `019fee8c`, continued across rounds). Round 1 (sandboxed from source; plan-internal): the C0 camelCase/snake_case JSONB contract violation, citations required per-diagnosis not per-code-cause, read-set citation checking, stale-eligible demotion, PR-train reorder so surfaces precede quarantine, one-shot script semantics, guard placement before mutation, handler-level test mandates, pipeline-real AC1.3 via a model stub. Round 2 (two load-bearing sources inlined; verified 14/16 round-1 P1 resolutions): reuse of the existing `filesRead`/`costUsd` result fields, the second forced-verdict path in the turn nudges, the truncated-exit cost bug, exhaustive stop mapping, script retry-after-failure semantics, decision_reason regex self-collision in the runbook, and independent citation re-verification at CP1. All P1/P2s folded into v2/v3 except three rejected with rationale in the revision log (copy-rule surface relabeling = C4/C5 ownership; content-driven quarantine = design intent; mechanical brief-structure validation = rubric-sampled per the design's honesty note).

**VERDICT:** CODEX CLEARED after two iterations — eng review not yet run (recommended before execution, matching the parent program plan's own review posture).

NO UNRESOLVED DECISIONS
