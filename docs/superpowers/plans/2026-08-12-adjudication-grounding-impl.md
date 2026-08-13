# Adjudication Grounding and Alert Delivery Policy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Authority:** `docs/superpowers/plans/2026-08-12-adjudication-grounding-and-alert-policy.md` (the reviewed design addendum) wins over this plan on any conflict.

**Goal:** ground the external-cause routing gate in repository content so fabricated candidates can't veto a correct conclusion, map external causes to the priority-capped `unfixable_third_party` reason code, and add a per-destination `post_triage` delivery policy so zero-impact first-sightings stop paging humans.

**Architecture:** Phase A hardens the worker's pure routing (`deriveOutcome`) with content-anchored grounding predicates, additive contract fields, and forensic dispositions. Phase C adds a delivery-policy column plus an `issue.triaged` outbound event emitted transactionally from one worker status-write choke point, formatted by the existing Go dispatcher.

**Tech Stack:** TypeScript (Node 22, vitest) in `packages/worker` and `shared`; Go 1.24 (chi, pgx) in `packages/ingestion`; append-only SQL migrations.

## Global Constraints

- Postgres queue only; wire contract (`POST /api/v1/events`, `test-fixtures/wire/`) untouched.
- Lease and terminal-status contracts preserved; every terminal `needs_human` keeps non-empty `reason_code`, `reason_message`, `remediation`.
- Migrations append-only from `050`, guarded (`IF NOT EXISTS`), idempotent on re-run.
- No model prose in templated copy; `reason_message`/`root_cause` never enter notification payloads.
- `unknown` + narrowing, never `any`; no type-escape casts (`as unknown as`) in contract tests.
- Vitest tests colocated in `__tests__`; DB-gated suites skip (not fail) without `DATABASE_URL`.
- `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test` green after every worker task; `go build ./... && go test ./...` (from `packages/ingestion`) green after every Go task.

---

## Phase A — grounded candidates, structural rejection, capped reason code

### Task 1: Shared contract — `GroundedQuote`, candidate ids/citations, `rejected_candidates`, dispositions

**Files:**
- Modify: `shared/src/diagnosis.ts`
- Test: `packages/worker/src/__tests__/contracts/adjudication-grounding.test.ts` (new; sibling of the existing `contracts/` consumer tests)

**Interfaces (Produces):**
```ts
export interface GroundedQuote { path: string; line: number; quote: string; }
// candidates_considered items gain: id?: string; citation?: GroundedQuote;
// Adjudication gains: rejected_candidates?: Array<{ id: string; evidence: string; citation: GroundedQuote }>;
export type CandidateDisposition = 'rejected' | 'ungrounded' | 'live';
```

- [ ] **Step 1: Write the failing contract tests**

Vitest transpiles without type-checking, so the compile-level halves of these
assertions gate on the **package build** (`tsc`), not the test runner: the file
must be included in `pnpm --filter @opslane/worker build`'s program (it is —
`__tests__` is inside the worker `tsconfig` include). The runtime halves
(round-trip through the real decoder) run under vitest. Step 2 verifies the
build fails on base; a red vitest run alone proves nothing here.

```ts
// packages/worker/src/__tests__/contracts/adjudication-grounding.test.ts
import { describe, expect, it } from 'vitest';
import type { Adjudication } from '@opslane/shared';
import { parseAdjudication } from '../../diagnose-schema.js';

describe('adjudication grounding contract', () => {
  it('accepts the new grounded shape (fails on base: fields missing)', () => {
    const adj: Adjudication = {
      best_supported: 'External bridge failure',
      evidence_check: 'checked',
      candidates_considered: [
        { id: 'c1', statement: 'afterEach calls changeWindowTitle', kind: 'local_code',
          citation: { path: 'src/router/index.ts', line: 12, quote: 'router.afterEach' } },
      ],
      rejected: [],
      rejected_candidates: [
        { id: 'c1', evidence: 'The hook only tracks page views',
          citation: { path: 'src/router/index.ts', line: 12, quote: 'router.afterEach' } },
      ],
      evidence_strength: 'suggestive',
      cause_kind: 'external_system',
      cause_locations: [],
      reasoning: 'r',
      why_chain: [],
      reproduction_steps: [],
    };
    expect(adj.rejected_candidates?.[0]?.citation.line).toBe(12);
  });

  it('still accepts an unchanged old-shape literal (additivity for producers)', () => {
    const legacy: Adjudication = {
      best_supported: 'x', evidence_check: '', candidates_considered: [{ statement: 's', kind: 'local_code' }],
      rejected: ['s: ruled out'], evidence_strength: 'insufficient', cause_kind: 'unknown',
      cause_locations: [], reasoning: '', why_chain: [], reproduction_steps: [],
    };
    expect(legacy.rejected).toHaveLength(1);
  });

  it('a persisted old-JSON row survives the real decoder (additivity for rows)', () => {
    // parseAdjudication is the narrowing function every stored submission went
    // through; no casts — the decoder itself is under test.
    const adj = parseAdjudication(JSON.parse(
      '{"best_supported":"x","evidence_check":"","candidates_considered":[{"statement":"s","kind":"local_code"}],' +
      '"rejected":["s: ruled out"],"evidence_strength":"insufficient","cause_kind":"unknown","cause_locations":[],' +
      '"reasoning":"","why_chain":[],"reproduction_steps":[],"evidence":[{"path":"a","detail":"d","symptomLink":"l"}],' +
      '"agent_task_brief":""}') as Record<string, unknown>);
    expect(adj?.candidates_considered[0]?.id).toBeUndefined();
    expect(adj?.candidates_considered[0]?.statement).toBe('s');
    expect(adj?.rejected_candidates).toBeUndefined();
    expect(adj?.rejected).toEqual(['s: ruled out']);
  });
});
```

- [ ] **Step 2: Run to verify the compile gate fails on base**

Run: `pnpm --filter @opslane/worker build`
Expected: FAIL — TS errors: `citation`/`rejected_candidates`/`id` do not exist on the types. (The vitest run also fails, but only because the build does — vitest alone does not type-check.)

- [ ] **Step 3: Add the fields to `shared/src/diagnosis.ts`**

After the `EvidenceCitation` interface, add:

```ts
/**
 * A quote anchored to a place in the repository. The grounding predicate is:
 * `path` resolves inside the clone AND `quote` appears within ±5 lines of
 * `line` at the investigated commit. Quote-anywhere-in-file is NOT grounding —
 * a fabricated hypothesis can quote an unrelated real line.
 */
export interface GroundedQuote {
  /** Repository-relative path, undecorated (same rule as CauseLocation.path). */
  path: string;
  /** 1-based line the quote lives at. */
  line: number;
  /** Verbatim excerpt, 1–300 chars after trim, non-whitespace. */
  quote: string;
}

/** How routing disposed of one local candidate. Persisted for forensics. */
export type CandidateDisposition = 'rejected' | 'ungrounded' | 'live';
```

Change `candidates_considered` and add `rejected_candidates` inside `Adjudication` (all new fields optional — strictness lives at the submission boundary, so every persisted row and old producer stays valid):

```ts
  candidates_considered: Array<{
    statement: string;
    kind: HypothesisKind;
    /** Unique within this adjudication, format `c<n>`. Required at submission. */
    id?: string;
    /** Required at submission for kinds local_code/configuration. */
    citation?: GroundedQuote;
  }>;
  /** Other hypotheses with the specific evidence that rules each one out. Legacy prose; display-only. */
  rejected: string[];
  /**
   * Structural rejections. A rejection converts a candidate only if its own
   * citation passes the grounding predicate — prose alone converts nothing.
   */
  rejected_candidates?: Array<{ id: string; evidence: string; citation: GroundedQuote }>;
```

- [ ] **Step 4: Rebuild shared, build worker (the compile gate), run the tests**

Run: `pnpm --filter @opslane/shared build && pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test -- adjudication-grounding`
Expected: build green, tests PASS (3/3). Note: the decoder test needs Task 2's parser changes to carry the new fields; until then it passes for the legacy row only — which is exactly what it asserts.

- [ ] **Step 5: Commit**

```bash
git add shared/src/diagnosis.ts packages/worker/src/__tests__/contracts/adjudication-grounding.test.ts
git commit -m "feat(shared): grounded-quote candidate citations and structural rejections (additive)"
```

### Task 2: Submission schema + parser — `diagnose-schema.ts`

**Files:**
- Modify: `packages/worker/src/diagnose-schema.ts` (the `candidates` helper ~line 23, `submitDiagnosisTool` schema ~line 95-110, `parseAdjudication` ~line 247)
- Test: `packages/worker/src/__tests__/diagnose-schema.test.ts` (append)

**Interfaces:**
- Consumes: `GroundedQuote` from Task 1.
- Produces: `parseAdjudication` now carries `id`/`citation`/`rejected_candidates` through; malformed grounding sub-fields are dropped (the validator in Task 3, not the parser, decides sufficiency).

- [ ] **Step 1: Write the failing parser tests** (append to `diagnose-schema.test.ts`)

```ts
describe('grounded candidate parsing', () => {
  it('carries id, citation, and rejected_candidates through', () => {
    const adj = parseAdjudication({
      best_supported: 'x', evidence_check: '', cause_kind: 'external_system',
      candidates_considered: [{ statement: 's', kind: 'local_code', id: 'c1',
        citation: { path: 'src/a.ts', line: 3, quote: 'const a' } }],
      rejected: [],
      rejected_candidates: [{ id: 'c1', evidence: 'not the cause',
        citation: { path: 'src/a.ts', line: 3, quote: 'const a' } }],
      evidence_strength: 'suggestive', cause_locations: [], reasoning: '',
      evidence: [{ path: 'src/a.ts', detail: 'd', symptomLink: 'l' }], agent_task_brief: '',
    });
    expect(adj?.candidates_considered[0]).toMatchObject({ id: 'c1', citation: { line: 3 } });
    expect(adj?.rejected_candidates).toHaveLength(1);
  });

  it('normalizes malformed candidate grounding to undefined (validator judges sufficiency)', () => {
    const adj = parseAdjudication({
      best_supported: 'x', evidence_check: '', cause_kind: 'unknown',
      candidates_considered: [{ statement: 's', kind: 'local_code', id: 42,
        citation: { path: 'src/a.ts', line: 'three', quote: '' } }],
      rejected: [], evidence_strength: 'insufficient', cause_locations: [], reasoning: '',
      why_chain: [], reproduction_steps: [],
      evidence: [], agent_task_brief: '',
    });
    expect(adj?.candidates_considered[0]?.id).toBeUndefined();
    expect(adj?.candidates_considered[0]?.citation).toBeUndefined();
  });

  it('preserves malformed rejections as empty-field entries the validator can reject', () => {
    // Silently dropping a malformed rejection would turn an invalid submission
    // into a valid empty rejection list — invalidity must survive parsing.
    const adj = parseAdjudication({
      best_supported: 'x', evidence_check: '', cause_kind: 'external_system',
      candidates_considered: [{ statement: 's', kind: 'local_code', id: 'c1',
        citation: { path: 'src/a.ts', line: 3, quote: 'const a' } }],
      rejected: [], rejected_candidates: [{ id: 'not-an-id', evidence: 'e', citation: null }],
      evidence_strength: 'suggestive', cause_locations: [], reasoning: '',
      why_chain: [], reproduction_steps: [], evidence: [], agent_task_brief: '',
    });
    expect(adj?.rejected_candidates).toHaveLength(1);
    expect(adj?.rejected_candidates?.[0]).toEqual({ id: '', evidence: 'e', citation: { path: '', line: 1, quote: '' } });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @opslane/worker test -- diagnose-schema` → FAIL (fields dropped by the current `candidates()` helper).

- [ ] **Step 3: Implement parsing**

In `diagnose-schema.ts`, add above `candidates()`:

```ts
import type { GroundedQuote } from '@opslane/shared';

export const QUOTE_MAX_CHARS = 300;
const CANDIDATE_ID = /^c[1-9]\d*$/;

function groundedQuote(value: unknown): GroundedQuote | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const path = typeof record['path'] === 'string' ? record['path'].trim() : '';
  const line = typeof record['line'] === 'number' && record['line'] > 0 ? Math.trunc(record['line']) : 0;
  const quote = typeof record['quote'] === 'string' ? record['quote'].trim() : '';
  if (!path || !line || !quote || quote.length > QUOTE_MAX_CHARS) return undefined;
  return { path, line, quote };
}

function candidateId(value: unknown): string | undefined {
  return typeof value === 'string' && CANDIDATE_ID.test(value) ? value : undefined;
}
```

Extend `candidates()` to emit `id`/`citation` when present, and add:

```ts
const MALFORMED_REJECTION = { id: '', evidence: '', citation: { path: '', line: 1, quote: '' } };

function rejectedCandidates(raw: Record<string, unknown>): Adjudication['rejected_candidates'] {
  // Key ABSENT → legacy row/submission → undefined. Key present in ANY form
  // (the strict schema always sends it) → an array, so the new-shape marker in
  // the validator cannot be evaded by malforming the field itself.
  if (!('rejected_candidates' in raw)) return undefined;
  const value = raw['rejected_candidates'];
  if (!Array.isArray(value)) return [MALFORMED_REJECTION];
  const out: NonNullable<Adjudication['rejected_candidates']> = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      // null / array / primitive entries become sentinels too — every entry
      // shape preserves invalidity; nothing is silently dropped.
      out.push(MALFORMED_REJECTION);
      continue;
    }
    const record = entry as Record<string, unknown>;
    out.push({
      id: candidateId(record['id']) ?? '',
      evidence: typeof record['evidence'] === 'string' ? record['evidence'].trim() : '',
      citation: groundedQuote(record['citation']) ?? { path: '', line: 1, quote: '' },
    });
  }
  return out;
}
```

Sentinel contract note: the empty `GroundedQuote` violates that type's documented non-empty invariant on purpose — it is the parser's malformed marker, it exists only between `parseAdjudication` and `validateAdjudicationShape` (which rejects it before anything persists, see the `investigate.ts` ordering in Task 3), and no persisted row can contain it. Document exactly this on `GroundedQuote` in Task 1's jsdoc.

Wire `rejected_candidates: rejectedCandidates(raw)` into `parseAdjudication` (the whole raw record — the helper needs key-presence, not just the value). Update the Task 2 malformed-candidate test accordingly: it must include `rejected_candidates: []` in its input (the strict schema always sends the key), and its expectation grows a second assertion — with the key present, `validateAdjudicationShape` classifies the submission as new-shape and rejects the candidate whose `id`/`citation` the parser dropped (`candidate_missing_id`). The evasion path (malformed candidate AND absent key) is unreachable from the API by schema and lands in the legacy branch harmlessly for non-API callers, whose only producer (`adjudicationFromDecline`) emits no candidates at all.

**Schema changes in `submitDiagnosisTool()` — strict-mode rules apply.** Anthropic strict schemas require every listed property in `required` and `additionalProperties: false` on every object (the existing `seal()` helper walks `properties` and `items` recursively, so the new nested citation objects are sealed for free — but verify with the schema unit test below). Because `required` cannot be conditional:

- `candidates_considered` items: add `id: { type: 'string' }` and `citation: { type: ['object','null'], properties: { path: …, line: …, quote: … }, required: ['path','line','quote'] }`; item `required` becomes `['statement','kind','id','citation']`. Non-local candidates pass `citation: null` (the description says so); the validator only demands a real citation for `local_code`/`configuration`.
- Add top-level `rejected_candidates` array (items `{ id, evidence, citation }`, all in `required`, citation non-nullable here) and append `'rejected_candidates'` to the **top-level `required` list** — strict mode demands it.
- Descriptions:

```
candidates_considered: '… Give each candidate an id ("c1", "c2", …). For local_code and
configuration candidates, citation is MANDATORY and must be real: {path, line, quote} with a
verbatim quote from within 5 lines of `line` in that file. Pass citation: null for other kinds.
Candidates whose citation does not check out against the repository are discarded as ungrounded.'
rejected_candidates: 'Reject candidates BY ID. Each rejection needs its own citation
{path, line, quote} anchoring the evidence in a file you read — prose alone rejects nothing.
Pass [] when you reject nothing.'
```

Add a schema unit test (append to `diagnose-schema.test.ts`): walk the sealed `submitDiagnosisTool().input_schema` and assert every object node has `additionalProperties === false` and every property key appears in its parent's `required` — this is what makes a strict-mode 400 a test failure instead of a prod incident. The walker cannot prove Anthropic *accepts* the `type: ['object','null']` citation encoding, so add a live canary: `scripts/validate-tool-schema.ts` sends one minimal message with the tool attached (no tool_choice force needed — a 400 on the schema arrives regardless of the model's reply) and exits nonzero on an API schema rejection. Run it in this task's verification when `ANTHROPIC_API_KEY` is available; if it is not, say so in the PR and treat the first Task 7 live run as the canary.

- [ ] **Step 4: Run tests** — `pnpm --filter @opslane/worker test -- diagnose-schema` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(worker): submission schema and parser for grounded candidates"`

### Task 3: Adjudication-level validation (extends `validateVerdict`)

**Files:**
- Modify: `packages/worker/src/verdict-validation.ts`
- Modify: `packages/worker/src/investigate.ts:302-310` (pass the adjudication in)
- Test: `packages/worker/src/__tests__/verdict-validation.test.ts` (append; create if absent)

**Interfaces:**
- Produces: `validateAdjudicationShape(adjudication: Adjudication): VerdictValidation` — pure, cross-field rules the JSON schema cannot express. Called from `investigate.ts` immediately before `validateVerdict`; an `incomplete` result routes exactly like today's (`basis: 'invalid_verdict'`).

- [ ] **Step 1: Write failing tests, one per rule**

```ts
import { validateAdjudicationShape } from '../verdict-validation.js';

const base = {
  best_supported: 'x', evidence_check: '', rejected: [], evidence_strength: 'suggestive' as const,
  cause_kind: 'external_system' as const, cause_locations: [], reasoning: '', why_chain: [],
  reproduction_steps: [],
};
const cite = { path: 'src/a.ts', line: 3, quote: 'const a' };

describe('validateAdjudicationShape', () => {
  it.each([
    ['duplicate candidate ids', { candidates_considered: [
      { statement: 'a', kind: 'local_code' as const, id: 'c1', citation: cite },
      { statement: 'b', kind: 'local_code' as const, id: 'c1', citation: cite }] }, 'duplicate_candidate_id'],
    ['local candidate missing id', { candidates_considered: [
      { statement: 'a', kind: 'local_code' as const, citation: cite }] }, 'candidate_missing_id'],
    ['local candidate missing citation', { candidates_considered: [
      { statement: 'a', kind: 'local_code' as const, id: 'c1' }] }, 'candidate_missing_citation'],
    ['rejection id matches no candidate', { candidates_considered: [
      { statement: 'a', kind: 'local_code' as const, id: 'c1', citation: cite }],
      rejected_candidates: [{ id: 'c9', evidence: 'e', citation: cite }] }, 'rejection_unknown_id'],
    ['duplicate rejection ids', { candidates_considered: [
      { statement: 'a', kind: 'local_code' as const, id: 'c1', citation: cite }],
      rejected_candidates: [
        { id: 'c1', evidence: 'e', citation: cite },
        { id: 'c1', evidence: 'f', citation: cite }] }, 'duplicate_rejection_id'],
    ['whitespace rejection evidence survives parser but fails here', { candidates_considered: [
      { statement: 'a', kind: 'local_code' as const, id: 'c1', citation: cite }],
      rejected_candidates: [{ id: 'c1', evidence: '   ', citation: cite }] }, 'empty_rejection_evidence'],
    ['parser empty-sentinel rejection (was malformed JSON)', { candidates_considered: [
      { statement: 'a', kind: 'local_code' as const, id: 'c1', citation: cite }],
      rejected_candidates: [{ id: '', evidence: 'e', citation: { path: '', line: 1, quote: '' } }] }, 'rejection_malformed'],
  ])('%s → incomplete', (_name, patch, code) => {
    const result = validateAdjudicationShape({ ...base, ...patch } as Adjudication);
    expect(result.status).toBe('incomplete');
    expect(result.status === 'incomplete' && result.reason.startsWith(code)).toBe(true);
  });

  it('passes a well-formed grounded adjudication and a legacy shape (no ids anywhere)', () => {
    expect(validateAdjudicationShape({ ...base, candidates_considered: [
      { statement: 'a', kind: 'local_code', id: 'c1', citation: cite }],
      rejected_candidates: [{ id: 'c1', evidence: 'e', citation: cite }] } as Adjudication).status).toBe('valid');
    expect(validateAdjudicationShape({ ...base, cause_kind: 'unknown',
      candidates_considered: [{ statement: 'a', kind: 'external_system' }] } as Adjudication).status).toBe('valid');
  });
});
```

Note the legacy case: non-local candidates never require ids/citations, so `adjudicationFromDecline` (which emits `candidates_considered: []`) and old fixtures stay valid.

- [ ] **Step 2: Run to verify failure** — function does not exist.

- [ ] **Step 3: Implement in `verdict-validation.ts`**

```ts
import type { Adjudication } from '@opslane/shared';

/**
 * Cross-field rules the submission JSON schema cannot express. Local candidates
 * must be identifiable and grounded; rejections must reference real candidates.
 * Non-local candidates and legacy shapes (no ids) pass untouched.
 */
export function validateAdjudicationShape(adjudication: Adjudication): VerdictValidation {
  // New-shape marker: ANY structural field present. Gating on rejected_candidates
  // alone would let a submission with ids but no rejections skip every rule.
  const isNewShape =
    adjudication.rejected_candidates !== undefined ||
    adjudication.candidates_considered.some((c) => c.id !== undefined || c.citation !== undefined);
  if (!isNewShape) return { status: 'valid' }; // legacy shape (decline adapter, old fixtures)

  const ids = new Set<string>();
  for (const candidate of adjudication.candidates_considered) {
    // Every candidate on a new-shape submission needs a well-formed id — the
    // strict schema demands one for all kinds, and direct callers get the same
    // rule (the parser normalizes bad ids to undefined; re-check format here
    // for callers that bypass the parser).
    if (!candidate.id || !CANDIDATE_ID.test(candidate.id)) {
      return incomplete(`candidate_missing_id: ${candidate.statement.slice(0, 80)}`);
    }
    if (ids.has(candidate.id)) return incomplete(`duplicate_candidate_id: ${candidate.id}`);
    ids.add(candidate.id);
    const local = candidate.kind === 'local_code' || candidate.kind === 'configuration';
    if (local && !candidate.citation) return incomplete(`candidate_missing_citation: ${candidate.id}`);
  }
  const seenRejections = new Set<string>();
  for (const rejection of adjudication.rejected_candidates ?? []) {
    if (!rejection.id || !rejection.citation.path || !rejection.citation.quote) {
      return incomplete(`rejection_malformed: entry with empty id or citation`);
    }
    if (!ids.has(rejection.id)) return incomplete(`rejection_unknown_id: ${rejection.id}`);
    if (seenRejections.has(rejection.id)) return incomplete(`duplicate_rejection_id: ${rejection.id}`);
    seenRejections.add(rejection.id);
    if (!rejection.evidence.trim()) return incomplete(`empty_rejection_evidence: ${rejection.id}`);
  }
  return { status: 'valid' };
}
```

Export `CANDIDATE_ID` from `diagnose-schema.ts` and import it here (one definition). Add a validator test row for a non-local candidate with id `'x'` → `candidate_missing_id` (format enforced for every kind). An ungrounded-but-present citation is judged by routing (Task 4), not here; this validator is the defense for shapes the parser normalized (empty sentinels) plus cross-field rules the strict API schema cannot express. The end-to-end proof that an `incomplete` result from this function actually reaches the terminal `needs_human`/`insufficient_context` state (and is not overwritten later in `processInvestigateJob`) lives in Task 6 Step 1b. In `investigate.ts`, before the existing `validateVerdict` call:

```ts
const shape = adjudication ? validateAdjudicationShape(adjudication) : { status: 'valid' as const };
if (shape.status === 'incomplete') {
  decision = { outcome: 'incomplete', basis: 'invalid_verdict', reason: shape.reason, confidence: 'low' };
}
```

(then only run `validateVerdict` when `shape.status === 'valid'`).

- [ ] **Step 4: Run** — `pnpm --filter @opslane/worker test -- verdict-validation` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(worker): adjudication shape validation at the submission boundary"`

### Task 4: `deriveOutcome` rework — grounding predicate, dispositions, structural rejection

**Files:**
- Modify: `packages/worker/src/classify.ts` (the external branch, lines 105-134; `DerivedDecision`)
- Modify: `packages/worker/src/investigate.ts:300` and `packages/worker/src/agent-fix.ts:959` (new argument)
- Create: `packages/worker/src/quote-at.ts`
- Test: `packages/worker/src/__tests__/classify.test.ts` (append), `packages/worker/src/__tests__/quote-at.test.ts`

**Interfaces:**
- Produces:
```ts
// quote-at.ts
export function quoteWithinWindow(fileText: string, line: number, quote: string): boolean;
// classify.ts — new third parameter and new decision field
export function deriveOutcome(
  adjudication: Adjudication | null,
  resolvePath: (cited: string) => string | null,
  quoteAt: (resolvedPath: string, line: number, quote: string) => boolean,
): DerivedDecision;
export interface DerivedDecision { /* existing fields */ dispositions?: Array<{ id: string; disposition: CandidateDisposition }>; }
```

- [ ] **Step 1: Write `quote-at.test.ts` (failing)**

```ts
import { quoteWithinWindow } from '../quote-at.js';

const file = ['line one  ', 'line two', 'line three', 'line four', 'line five',
  'line six', 'line seven', 'line eight', 'line nine', 'needle here', 'line eleven'].join('\n');

describe('quoteWithinWindow', () => {
  it('finds a quote at its anchored line', () => expect(quoteWithinWindow(file, 10, 'needle here')).toBe(true));
  it('finds a quote within ±5 lines', () => expect(quoteWithinWindow(file, 6, 'needle here')).toBe(true));
  it('rejects a quote outside the window', () => expect(quoteWithinWindow(file, 1, 'needle here')).toBe(false));
  it('normalizes trailing whitespace per line', () => expect(quoteWithinWindow(file, 1, 'line one')).toBe(true));
  it('rejects whitespace-only quotes', () => expect(quoteWithinWindow(file, 1, '   ')).toBe(false));
});
```

- [ ] **Step 2: Implement `quote-at.ts`**

```ts
/** ±5-line window around a 1-based anchor, per-line trailing whitespace trimmed. */
const WINDOW = 5;

export function quoteWithinWindow(fileText: string, line: number, quote: string): boolean {
  const needle = quote.trim();
  if (!needle) return false;
  const lines = fileText.split(/\r?\n/).map((entry) => entry.replace(/\s+$/u, ''));
  const start = Math.max(0, line - 1 - WINDOW);
  const window = lines.slice(start, line + WINDOW).join('\n');
  return window.includes(needle);
}
```

Run: `pnpm --filter @opslane/worker test -- quote-at` → PASS. Commit: `git commit -m "feat(worker): line-anchored quote grounding predicate"`

- [ ] **Step 3: Write the failing `classify.test.ts` cases** (append; build inputs through a `groundedExternal()` helper in the test file so each case is a one-line patch)

```ts
const cite = (line: number, quote: string) => ({ path: 'src/app.ts', line, quote });
const resolveAll = (cited: string) => cited;               // every path exists
const fileHas = (text: string) => (_p: string, line: number, quote: string) =>
  quoteWithinWindow(text, line, quote);
const appFile = 'a\nb\nconst hook = true\nd\ne';

function groundedExternal(patch: Partial<Adjudication>): Adjudication {
  return {
    best_supported: 'External platform code', evidence_check: 'checked',
    candidates_considered: [], rejected: [], rejected_candidates: [],
    evidence_strength: 'suggestive', cause_kind: 'external_system',
    // External conclusions may cite no location; reason falls back to best_supported.
    cause_locations: [],
    reasoning: 'r', why_chain: [], reproduction_steps: [], ...patch,
  };
}

describe('deriveOutcome grounding', () => {
  it('AC-A.2: fabricated candidate (quote absent from window) cannot veto — ungrounded', () => {
    const decision = deriveOutcome(groundedExternal({
      candidates_considered: [{ statement: 'phantom hook', kind: 'local_code', id: 'c1',
        citation: cite(3, 'router.afterEach(sendTitle)') }],
    }), resolveAll, fileHas(appFile));
    expect(decision.outcome).toBe('not_actionable');
    expect(decision.basis).toBe('cause_outside_codebase');
    expect(decision.dispositions).toEqual([{ id: 'c1', disposition: 'ungrounded' }]);
  });

  it('AC-A.2 variant: quote exists elsewhere in the file but outside ±5 of the anchor → ungrounded', () => {
    const longFile = ['const hook = true', ...Array.from({ length: 20 }, (_v, i) => `filler ${i}`)].join('\n');
    const decision = deriveOutcome(groundedExternal({
      candidates_considered: [{ statement: 's', kind: 'local_code', id: 'c1',
        citation: cite(20, 'const hook = true') }],
    }), resolveAll, fileHas(longFile));
    expect(decision.dispositions?.[0]?.disposition).toBe('ungrounded');
  });

  it('AC-A.3: grounded, unrejected candidate still gates', () => {
    const decision = deriveOutcome(groundedExternal({
      candidates_considered: [{ statement: 'real hook', kind: 'local_code', id: 'c1',
        citation: cite(3, 'const hook = true') }],
    }), resolveAll, fileHas(appFile));
    expect(decision.outcome).toBe('needs_more_context');
    expect(decision.basis).toBe('unrejected_local_candidates');
  });

  it('AC-A.3 variant: rejection whose own citation fails grounding converts nothing', () => {
    const decision = deriveOutcome(groundedExternal({
      candidates_considered: [{ statement: 'real hook', kind: 'local_code', id: 'c1',
        citation: cite(3, 'const hook = true') }],
      rejected_candidates: [{ id: 'c1', evidence: 'not it', citation: cite(3, 'no such text') }],
    }), resolveAll, fileHas(appFile));
    expect(decision.basis).toBe('unrejected_local_candidates');
  });

  it('AC-A.4: grounded candidate + grounded rejection by id, rephrased prose → external accepted', () => {
    const decision = deriveOutcome(groundedExternal({
      candidates_considered: [{ statement: 'real hook', kind: 'local_code', id: 'c1',
        citation: cite(3, 'const hook = true') }],
      rejected_candidates: [{ id: 'c1', evidence: 'entirely different words than the statement',
        citation: cite(3, 'const hook = true') }],
    }), resolveAll, fileHas(appFile));
    expect(decision.outcome).toBe('not_actionable');
  });

  it('AC-A.8: fabricated candidate that is also "rejected" records ungrounded, not rejected', () => {
    const decision = deriveOutcome(groundedExternal({
      candidates_considered: [{ statement: 'phantom', kind: 'local_code', id: 'c1',
        citation: cite(3, 'nonexistent text') }],
      rejected_candidates: [{ id: 'c1', evidence: 'e', citation: cite(3, 'const hook = true') }],
    }), resolveAll, fileHas(appFile));
    expect(decision.dispositions).toEqual([{ id: 'c1', disposition: 'ungrounded' }]);
  });

  it('legacy shape (no rejected_candidates, prose rejected only) keeps the old substring behavior', () => {
    const decision = deriveOutcome(groundedExternal({
      rejected_candidates: undefined,
      candidates_considered: [{ statement: 'real hook', kind: 'local_code' }],
      rejected: ['real hook: ruled out because …'],
    }), resolveAll, fileHas(appFile));
    expect(decision.outcome).toBe('not_actionable'); // substring path, unchanged for legacy callers
  });
});
```

- [ ] **Step 4: Implement in `classify.ts`**

Replace the body of the `external_system || data_or_input` branch (lines 105-134):

```ts
  if (adjudication.cause_kind === 'external_system' || adjudication.cause_kind === 'data_or_input') {
    const locals = adjudication.candidates_considered.filter(
      (candidate) => candidate.kind === 'local_code' || candidate.kind === 'configuration',
    );

    // New-shape submissions (structural rejections present) get the grounded
    // path. Legacy shapes keep the substring behavior verbatim — routing never
    // re-runs on stored rows, but the decline adapter still produces them live.
    if (adjudication.rejected_candidates !== undefined) {
      const grounded = (quoteRef: GroundedQuote | undefined): boolean => {
        if (!quoteRef) return false;
        const resolved = resolvePath(quoteRef.path);
        return resolved !== null && quoteAt(resolved, quoteRef.line, quoteRef.quote);
      };
      const validRejections = new Set(
        adjudication.rejected_candidates
          .filter((rejection) => rejection.evidence.trim() && grounded(rejection.citation))
          .map((rejection) => rejection.id),
      );
      // Grounding evaluated FIRST: a fabricated candidate that is also
      // "rejected" must show as fabricated in the forensics.
      const dispositions = locals.map((candidate) => ({
        id: candidate.id ?? candidate.statement.slice(0, 40),
        disposition: !grounded(candidate.citation)
          ? ('ungrounded' as const)
          : candidate.id !== undefined && validRejections.has(candidate.id)
            ? ('rejected' as const)
            : ('live' as const),
      }));
      const live = dispositions.filter((entry) => entry.disposition === 'live');
      if (live.length > 0) {
        return {
          outcome: 'needs_more_context',
          reason:
            `The investigation concluded the cause is external without rejecting ` +
            `${live.map((entry) => JSON.stringify(entry.id)).join(', ')}`,
          basis: 'unrejected_local_candidates',
          confidence: 'low',
          dispositions,
        };
      }
      return {
        outcome: 'not_actionable',
        reason: `The cause is outside this codebase: ${adjudication.cause_locations[0]?.path ?? adjudication.best_supported}`,
        basis: 'cause_outside_codebase',
        confidence: confidenceFor(adjudication.evidence_strength),
        dispositions,
      };
    }

    // Legacy path — existing substring check, byte-for-byte.
    const rejectedText = adjudication.rejected.join('\n').toLowerCase();
    const unrejected = locals.filter((candidate) => !rejectedText.includes(candidate.statement.toLowerCase()));
    if (unrejected.length > 0) { /* … existing return, unchanged … */ }
    return { /* … existing not_actionable return, unchanged … */ };
  }
```

Add `dispositions?: Array<{ id: string; disposition: CandidateDisposition }>` to `DerivedDecision`. Update the two call sites: `investigate.ts:300` passes `(resolved, line, quote) => quoteWithinWindow(fs.readFileSync(path.join(repoPath, resolved), 'utf8'), line, quote)` wrapped in try/catch returning `false` (an unreadable file grounds nothing); `agent-fix.ts:959` passes `() => false` (declines carry no candidates — see `adjudicationFromDecline`, which emits `candidates_considered: []` and no `rejected_candidates`, so the predicate is unreachable there).

- [ ] **Step 5: Run the full worker suite** — `pnpm --filter @opslane/worker test` → PASS (existing classify tests must stay green: the legacy path is untouched).
- [ ] **Step 6: Commit** — `git commit -m "feat(worker): grounded dispositions replace prose-substring veto for new submissions"`

### Task 5: Cause-kind-aware reason code + persisted dispositions

**Files:**
- Modify: `packages/worker/src/reason-codes.ts:15-20`, `packages/worker/src/db.ts` (`PersistedDecision`, `DecisionRow`, `insertDiagnosisDecision`), `packages/worker/src/index.ts` (~632, the `decision` literal — add `causeKind`, `dispositions`)
- Create: `packages/ingestion/db/migrations/050_decision_dispositions.sql`
- Test: `packages/worker/src/__tests__/reason-codes.test.ts` (append or create), `packages/worker/src/__tests__/c0-contracts.test.ts` (append the old-row parse case)

- [ ] **Step 1: Migration**

```sql
-- 050_decision_dispositions.sql
-- Forensic candidate dispositions and the cause kind that drove routing.
-- Both nullable: every existing row and every legacy-shape decision stays valid.
ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS candidate_dispositions jsonb;
ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS cause_kind text;
```

Apply to a disposable DB, re-run to confirm idempotency.

- [ ] **Step 2: Failing test for the mapping**

```ts
describe('reasonCodeForDecision cause kinds', () => {
  // `satisfies` keeps the literal honest against the full PersistedDecision
  // shape without a cast; add any fields the interface requires at build time.
  const base = {
    outcome: 'not_actionable', basis: 'cause_outside_codebase', confidence: 'low',
  } as const satisfies PersistedDecision;
  it('external_system → unfixable_third_party', () =>
    expect(reasonCodeForDecision({ ...base, causeKind: 'external_system' })).toBe('unfixable_third_party'));
  it('data_or_input → unfixable_infra (unchanged)', () =>
    expect(reasonCodeForDecision({ ...base, causeKind: 'data_or_input' })).toBe('unfixable_infra'));
  it('absent causeKind (legacy row) → unfixable_infra (unchanged)', () =>
    expect(reasonCodeForDecision(base)).toBe('unfixable_infra'));
});
```

- [ ] **Step 3: Implement**

`db.ts`: `PersistedDecision` gains `causeKind?: HypothesisKind; dispositions?: Array<{ id: string; disposition: CandidateDisposition }>;` — thread both through `DecisionRow`, add the two columns to `insertDiagnosisDecision`'s INSERT (jsonb-stringified dispositions, plain text cause kind), and include them when `index.ts` builds `decision` (`causeKind: adjudication?.cause_kind`, `dispositions: triage.dispositions`). `reason-codes.ts`:

```ts
export function reasonCodeForDecision(decision: PersistedDecision | null): ReasonCode {
  if (!decision) return 'insufficient_context';
  if (decision.outcome === 'not_actionable') {
    return decision.causeKind === 'external_system' ? 'unfixable_third_party' : 'unfixable_infra';
  }
  if (decision.outcome === 'code_fix') return 'low_confidence_fix';
  return 'insufficient_context';
}
```

- [ ] **Step 4: Run worker suite + the c0 contract test with a dispositions-free old row** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(worker): cause-kind-aware reason codes; persist candidate dispositions (migration 050)"`

### Task 6: W-B pipeline fixture + sweeper cap proof (AC-A.5, AC-A.7)

**Files:**
- Test: `packages/worker/src/__tests__/grounded-external-pipeline.test.ts` (new, DB-gated — follow the `describe.skipIf(!process.env.DATABASE_URL)` pattern used by the existing db-gated suites)
- Test: `packages/ingestion/priority/sweeper_test.go` (append)

- [ ] **Step 1: Worker pipeline test.** Stub the harness the way `agent-loop.test.ts` stubs terminal runs: a fixed `submit_diagnosis` input with `cause_kind: 'external_system'`, `c1` fabricated (quote not in the cited window of a real fixture file), `c2` grounded + rejected by id with rephrased prose and a grounded rejection citation. Drive `processInvestigateJob` against a seeded group with 2 identified users (insert into `error_group_affected_users` with `last_seen = now()`), then assert on the DB: `status = 'insight'`, `reason_code = 'unfixable_third_party'`, `diagnosis_decisions.candidate_dispositions = [{"id":"c1","disposition":"ungrounded"},{"id":"c2","disposition":"rejected"}]`, `cause_kind = 'external_system'`.
- [ ] **Step 1b: Invalid-shape terminal proof.** Same harness stub, but the submission carries duplicate candidate ids. Drive `processInvestigateJob` end to end and assert the *persisted* terminal state: group `needs_human`, `reason_code = 'insufficient_context'`, decision row `basis = 'invalid_verdict'` with the `duplicate_candidate_id` reason, no fix job created. This is what proves the Task 3 `decision` assignment survives to the terminal write instead of being overwritten later in `processInvestigateJob`.
- [ ] **Step 2: Sweeper Go test.** Seed the same shape (group with `reason_code = 'unfixable_third_party'`, 2 affected users in-window), run `RunOnce`, assert `priority_inputs->>'cap_applied' = 'true'`, `priority_inputs->>'reason_code' = 'unfixable_third_party'`, impact `= 2 + 2*users_24h`, and `priority_score` = impact × route_weight × 0.1 — also compute the uncapped product in the test and assert `priority_score` is exactly one tenth of it (zero-impact would make cap and no-cap indistinguishable, hence the seeded users).
- [ ] **Step 3: Legacy-reader entry points (AC-A.7).** Insert a `diagnosis_decisions` row whose `diagnosis` JSON is the pre-branch shape (no ids/citations/dispositions, NULL `candidate_dispositions`/`cause_kind` columns), then exercise the real readers, not raw SQL: (a) worker: the fix-job authorization loader (`db` decision loader used by the fix gate) returns the row and the fix path behaves as before; (b) worker: drive a report-only re-enqueue (`triggered_by='reinvestigate_report_only'`) on that group and assert it runs a *fresh* investigation rather than routing from the stored row — the behavioral proof that persisted adjudications are never re-routed; (c) ingestion: a Go `handler` test hits the incident read API for that group and gets a 200 with the legacy fields rendered. Arity alone proves nothing about data flow; these three entry points are the claim's actual surface.
- [ ] **Step 4: Run** — `DATABASE_URL=… pnpm --filter @opslane/worker test -- grounded-external` and `(cd packages/ingestion && go test ./priority/... ./handler/...)` (the handler package carries Step 3c) → PASS, zero skips with the env exported.
- [ ] **Step 5: Commit** — `git commit -m "test(worker,ingestion): end-to-end grounded external outcome with priority cap arithmetic"`

### Task 7: Prompt/eval note

**Files:** Modify: the investigation prompt text in `packages/worker/src/investigate.ts` (grounding rule stated near the candidate instructions) — the schema descriptions from Task 2 carry most of the weight.

- [ ] **Step 1:** Add one prompt sentence: "Candidates and rejections are checked mechanically against the repository: cite the exact file, line, and a verbatim quote for every local candidate and every rejection, or the submission is discarded."
- [ ] **Step 2 (deploy gate, decided 2026-08-12): prod-replay eval.** A stubbed-verdict run is independent of prompt text, so it cannot measure the prompt change; the deploy gate is a replay eval on real prod incidents instead (see the design doc's "Deploy gate for W-A" section for the settled criteria). Procedure: via `~/deploy/scripts/prod-sql.sh` (read-only), export the sample events of ~14 AMFJ 2 `needs_human`/`insufficient_context` groups and ~6 `resolved`/`pr_created` controls; seed them into a disposable worktree stack; run each investigation twice (baseline arm = pre-branch worker image, grounded arm = this branch) with a live key. Ship criteria: grounded-arm `incomplete` rate ≤ baseline + 10pp; external-cause misfires (window-title incident included) land `insight`/`unfixable_third_party`; every control still reaches its code cause. Attach both outcome tables to the PR. The stubbed-fixture suite results go in the PR as pipeline regression evidence only.
- [ ] **Step 3:** Commit — `git commit -m "feat(worker): grounding rule in investigation prompt"`

---

## Phase C — delivery policy and `issue.triaged`

> **DEFERRED (decided 2026-08-12): do not start Phase C until C4/C5 have merged.** The design is settled and the tasks below stay accurate; the hold exists because Task 11's status-write refactor collides with files C4/C5 actively edit. Phase A ships alone.

### Task 8: Migration 047 — `delivery_policy`

**Files:**
- Create: `packages/ingestion/db/migrations/047_delivery_policy.sql`
- Test: `packages/ingestion/db/migrations_test.go` (append partial-apply case if a harness exists; otherwise the disposable-DB procedure below is the gate)

- [ ] **Step 1: Write the migration**

```sql
-- 047_delivery_policy.sql
-- Per-destination alert timing. 'immediate' preserves today's behavior exactly;
-- 'post_triage' transforms the issue.created subscription into an issue.triaged
-- delivery at the triage terminal. Column and constraint are separate guarded
-- statements so a partial apply stopped between them recovers on re-run.
ALTER TABLE notification_destinations
  ADD COLUMN IF NOT EXISTS delivery_policy text NOT NULL DEFAULT 'immediate';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notification_destinations_delivery_policy_check'
      AND conrelid = 'notification_destinations'::regclass
  ) THEN
    ALTER TABLE notification_destinations
      ADD CONSTRAINT notification_destinations_delivery_policy_check
      CHECK (delivery_policy IN ('immediate','post_triage'));
  END IF;
END $$;
```

- [ ] **Step 2: Verify on a disposable DB:** apply fully; re-run (no-op); apply only the first statement, then re-run the whole file — constraint exists and rejects `INSERT … delivery_policy = 'bogus'` after every path.
- [ ] **Step 3: Commit** — `git commit -m "feat(ingestion): notification delivery_policy column (migration 047)"`

### Task 9: Gate `issue.created` on `delivery_policy = 'immediate'`

**Files:**
- Modify: `packages/ingestion/db/notifications.go` (the `publishIssueCreated` destinations CTE, ~line 249) and the `HasEnabledIssueCreatedDestination` query at ~line 215
- Test: `packages/ingestion/db/notifications_test.go` (append)

- [ ] **Step 1: Failing Go test:** two destinations subscribed to `issue.created` (one per policy); call `publishIssueCreated`; assert exactly one `outbound_deliveries` row and it belongs to the `immediate` destination.
- [ ] **Step 2: Implement:** add `AND delivery_policy = 'immediate'` to BOTH the destinations CTE and the line-215 existence check (`HasEnabledIssueCreatedDestination`). That check only gates `issue.created` payload work in ingestion; the `issue.triaged` path is worker-side (Task 11) and never consults it, so a post-triage-only project correctly returns false here and skips `issue.created` entirely. Add a Go test asserting exactly that: post-triage-only project → existence check false, zero `issue.created` outbox rows.
- [ ] **Step 3: Run** — `(cd packages/ingestion && go test ./db/...)` → PASS. Commit: `git commit -m "feat(ingestion): issue.created delivers only to immediate destinations"`

### Task 10: Go payload type, formatter, allowlist, fixture

**Files:**
- Modify: `packages/ingestion/notify/event.go` (add `Outcome`), `packages/ingestion/notify/slack.go` (`FormatSlack` switch + `formatSlackTriaged`), `packages/ingestion/handler/notifications.go:23` (allowlist map — dispatch validation only; destination create/update must **reject** `issue.triaged` as a subscription)
- Create: `test-fixtures/notifications/issue-triaged-v1.json`
- Test: `packages/ingestion/notify/slack_test.go`, `packages/ingestion/notify/event_test.go` (append)

**Interfaces (Produces — the cross-runtime JSON contract, exact field names):**

```json
{
  "version": 1,
  "event_type": "issue.triaged",
  "issue": { "id": "<uuid>", "title": "<sanitized>", "first_seen": "<RFC3339>" },
  "project": { "id": "<uuid>", "name": "<name>" },
  "environment": "production",
  "dashboard_url": "https://…",
  "outcome": {
    "status": "needs_human",
    "reason_code": "insufficient_context",
    "label": "Needs human review — no verified cause",
    "impact": { "users_7d": 0, "anon_sessions_7d": 1 }
  }
}
```

- [ ] **Step 1:** Save exactly that JSON (concrete values, no placeholders — pick fixed UUIDs) as the fixture. It is NOT under `test-fixtures/wire/` (that directory is frozen; this is a new, unfrozen catalog).
- [ ] **Step 2: Failing Go tests:** `event_test.go` decodes the fixture into `EventPayload` and asserts every field round-trips (including `Outcome.Label`); `Validate()` accepts it and rejects `issue.triaged` without an `Outcome` body. Allowlist proof is structural, not sentinel-only: unmarshal the fixture into `map[string]any` and assert its key set (recursively) equals exactly the documented field set — Go's decoder silently discards unknown JSON fields, so decoding into the struct proves nothing about extra persisted fields; the worker-side half (no `reason_message`/`root_cause` ever *written*) is AC-C.6 in Task 11. `slack_test.go` formats it and asserts the header contains the project name, the outcome label renders, and a sentinel in `Issue.Title` is escaped/sanitized like `issue.created`.
- [ ] **Step 3: Implement:**

```go
// event.go
type OutcomeImpact struct {
	Users7d        int `json:"users_7d"`
	AnonSessions7d int `json:"anon_sessions_7d"`
}
type OutcomePayload struct {
	Status     string        `json:"status"`
	ReasonCode string        `json:"reason_code"`
	Label      string        `json:"label"`
	Impact     OutcomeImpact `json:"impact"`
}
// EventPayload gains: Outcome *OutcomePayload `json:"outcome,omitempty"`
// Validate(): "issue.triaged" requires Issue != nil && Outcome != nil; every other type requires Outcome == nil.
```

`slack.go`: `case "issue.triaged": return formatSlackTriaged(payload)` — header `"Issue triaged in "+payload.Project.Name`, section with the backticked sanitized title, fields `*Outcome:*\n<label>` and `*Impact (7d):*\n<users> users, <anon> anon sessions`, same dashboard button block as `formatSlackIssue`. `handler/notifications.go`: add `"issue.triaged": {}` to the payload-validation allowlist; in the destination create/update path, explicitly reject `issue.triaged` inside `event_types` with a 400 (`"issue.triaged is delivered by delivery_policy, not subscribed"`).
- [ ] **Step 4: Run** — `(cd packages/ingestion && go build ./... && go test ./notify/... ./handler/...)` → PASS. Commit: `git commit -m "feat(ingestion): issue.triaged payload, formatter, and fixture"`

### Task 11: Worker emission — one choke point in `db.ts`

**Files:**
- Modify: `packages/worker/src/db.ts` — extract the shared status-UPDATE from `updateGroupStatus` (~line 1948) and `updateGroupInvestigation` (~line 2160) into one private `applyGroupStatusUpdate(client, …)`; add `publishIssueTriaged`
- Test: `packages/worker/src/__tests__/issue-triaged-emission.test.ts` (new, DB-gated), TS fixture assertion against `test-fixtures/notifications/issue-triaged-v1.json`

**Interfaces:**
- Produces (internal): `applyGroupStatusUpdate(client: pg.PoolClient, errorGroupId, projectId, status, fields, lease)` — the ONLY code that writes `error_groups.status`; returns `{ previousStatus: string }` via `WITH prev AS (SELECT status FROM error_groups WHERE id = $1 AND project_id = $2 FOR UPDATE) UPDATE … RETURNING (SELECT status FROM prev) AS previous_status`. When `previousStatus !== status` and `status ∈ {'needs_human','pr_created'}`, it calls `publishIssueTriaged` on the same client before returning.
- **Transaction ownership is unchanged and explicit:** both existing wrappers already run `BEGIN … COMMIT/ROLLBACK` on a dedicated `PoolClient` (see `db.ts:1947` and the `updateGroupInvestigation` block); `applyGroupStatusUpdate` takes that already-begun client and never begins/commits itself. The parameter type is `pg.PoolClient` (not the pool) precisely so an autocommitting pool handle cannot be passed — status write and outbox insert commit or roll back together, and a lease failure (`LeaseLostError`, thrown on zero rows exactly as today) aborts the transaction before any outbox insert runs.
- `publishIssueTriaged(client, groupId, projectId, status, reasonCode, jobId)` — builds the Task 10 JSON (label from `triageLabel`), reads project/environment names and 7-day impact counts inside the transaction, inserts `outbound_events` (`dedup_key = 'issue.triaged:' + groupId + ':' + (jobId ?? 'manual')`, `ON CONFLICT DO NOTHING`) and `outbound_deliveries` for destinations `WHERE project_id = $1 AND enabled AND delivery_policy = 'post_triage' AND 'issue.created' = ANY(event_types)`.
- `triageLabel(status: string, reasonCode: string | null): string` — fixed table: `pr_created:* → 'Fix PR opened'`; `needs_human:unfixable_third_party → 'Third-party cause — review suggested'`; `needs_human:unfixable_infra → 'External cause — review suggested'`; `needs_human:* → 'Needs human review — no verified cause'`. Keyed on status first so a successful PR can never render a reason-code label like "low confidence fix".

- [ ] **Step 1: Failing DB-gated tests** — seed a project with one `post_triage` destination subscribed to `issue.created`; drive each writer path and assert `outbound_events` rows:
  - `updateGroupStatus(... 'needs_human' ...)` (the runtime-error path index.ts:426 uses) → exactly one event (AC-C.7);
  - `updateGroupInvestigation(... 'needs_human' ...)` → exactly one event;
  - `updateGroupInvestigation(... 'insight' ...)` → zero events (AC-C.4's outbox half);
  - `pr_created` transition → one event whose payload `outcome.label = 'Fix PR opened'` (AC-C.9);
  - same-status rewrite (`needs_human` → `needs_human`) → no second event (transition predicate — this path never reaches the dedup insert);
  - dedup actually exercised (AC-C.5a): `needs_human` → `queued` → `needs_human` again under the **same** job id (requeue-in-place keeps job ids — see the `insertDiagnosisDecision` comment about `requeueStaleJobs`) → the second transition runs the outbox insert and `ON CONFLICT (project_id, dedup_key) DO NOTHING` suppresses it: exactly one event row;
  - regression reopen (AC-C.5b): `needs_human` → `queued` → `needs_human` under a **new** job id → second event row. Emission is transition-gated, dedup is job-gated; the three cases above separate the two mechanisms;
  - `missing_llm_key` path proof (feeds Task 13): run `processInvestigateJob` with `ANTHROPIC_API_KEY` unset against a seeded group → group lands `needs_human`/`missing_llm_key` **through the choke point** and exactly one `issue.triaged` outbox row exists — this is the test that licenses the smoke's deterministic trigger;
  - stale lease: attempt the transition with a superseded lease → `LeaseLostError`, status unchanged, **zero** outbox rows (the transaction rolled back as a unit);
  - payload of the first event deep-equals the checked-in fixture after substituting the dynamic fields — ids, `first_seen`, `dashboard_url`, environment name, and impact counts are all seeded to the fixture's exact values by the test setup, so the comparison is total, not partial (AC-C.6, TS half: also assert the `reason_message`/`root_cause` sentinel is absent).
- [ ] **Step 2: Implement** the extraction + the two functions. The choke-point claim is proven repo-wide, not per-file: `rg -n "SET status" packages/worker/src --type ts` (and `rg -n "error_groups\s+SET"` for formatting variants) must show status writes only inside `applyGroupStatusUpdate`; every production caller found by that sweep (`updateGroupStatus`, `updateGroupInvestigation`, `updateGroupAndCreateFixJob`, the PR path) is refactored through it and each appears in the Step 1 test matrix.
- [ ] **Step 3: Run** — `DATABASE_URL=… pnpm --filter @opslane/worker test` → PASS, existing lease/terminal tests untouched (they are the regression net for the extraction). Commit: `git commit -m "feat(worker): issue.triaged emitted transactionally from the single status choke point"`

### Task 12: Settings surface + dashboard types

**Files:**
- Modify: `packages/ingestion/handler/notifications.go` (create/update accept + return `delivery_policy`), `packages/ingestion/db/notifications.go` (CRUD columns), `packages/dashboard/src/types/api.ts` (destination type gains `delivery_policy: 'immediate' | 'post_triage'`), the dashboard settings form component that edits destinations (locate via `grep -rn "event_types" packages/dashboard/src`)
- Test: `packages/ingestion/handler/notifications_test.go` (append)

- [ ] **Step 1: Failing handler tests:** create a destination with `delivery_policy: 'post_triage'` → persisted and echoed; omit it → defaults `'immediate'`; send `'bogus'` → 400; send `event_types: ['issue.triaged']` → 400 with the Task 10 message.
- [ ] **Step 2: Implement** column in CRUD queries (`INSERT`, `UPDATE … COALESCE`, `SELECT` lists), request/response structs, validation; dashboard type + a select control (`Immediate` / `After triage`) next to the existing event-types editor.
- [ ] **Step 3: Run** — Go handler tests + `pnpm --filter @opslane/dashboard build` → PASS. Commit: `git commit -m "feat: delivery_policy on notification destination settings"`

### Task 13: Live smoke + docs

**Files:**
- Modify: `docs/contracts/` notification event catalog (add `issue.triaged`, its payload JSON, the delivery-policy semantics — "policy transforms when the issue.created subscription delivers; issue.triaged is not subscribable")
- Test: live smoke per root `AGENTS.md`

- [ ] **Step 1: Live smoke (AC-C.2/C.3):** bring up the worktree stack (port-triple block from root `AGENTS.md`), apply migrations, seed `scripts/seed-e2e.sql`, create two Slack-webhook destinations (one per policy) pointed at a request-capture endpoint, send one browser event. Force a deterministic terminal: run the worker with `ANTHROPIC_API_KEY` unset, which lands `needs_human`/`missing_llm_key` on the first investigation — no model, no nondeterminism. Assert: immediate endpoint got exactly one `issue.created` (its Slack body shape is covered by the Go formatter unit tests, which is the regression gate — no unverifiable "pre-branch capture" comparison here), post-triage endpoint got exactly zero `issue.created` and one `issue.triaged` whose label is the `needs_human:*` fallback.
- [ ] **Step 2: Full gate:** `pnpm -r build && pnpm test` (with `DATABASE_URL` and the MinIO env from root `AGENTS.md` exported; read the skip counts in the vitest summary, not the pass count). Go's default output hides skips, so prove "zero skips" explicitly: `(cd packages/ingestion && go build ./... && go test ./... -v 2>&1 | grep -c -- '--- SKIP')` must print `0`. Then `docker compose config --quiet`.
- [ ] **Step 3: Commit** — `git commit -m "docs(contracts): issue.triaged event and delivery policy"`

---

## Self-review notes

- Every design AC maps to a task: AC-A.1→T1, AC-A.2/3/4/8→T4, AC-A.5→T6, AC-A.6→T3, AC-A.7→T6, AC-C.1→T8, AC-C.2/3→T13, AC-C.4/5/7/9→T11, AC-C.6→T10+T11, AC-C.8→T11.
- Type names cross-checked: `GroundedQuote`, `CandidateDisposition`, `quoteWithinWindow`, `validateAdjudicationShape`, `applyGroupStatusUpdate`, `publishIssueTriaged`, `triageLabel`, `OutcomePayload` are each defined once and consumed by name.
- The legacy substring path in Task 4 is deliberately preserved for `rejected_candidates === undefined` (the decline adapter and any mid-deploy old submission), so no existing classify test changes.

## Review record

| Review | Trigger | Runs | Status | Findings |
|--------|---------|------|--------|----------|
| Codex Review | `/codex` (impl plan; session `019ff75e`) | 2 | issues_found → addressed | R1: 13 P1 / 10 P2 — compile gate moved to `tsc` (vitest doesn't type-check); real-decoder old-row test; strict-schema sealing + nullable citation + top-level required; new-shape validator marker fixed; malformed rejections preserved as sentinels; `as never` removed; Task 9 contradiction resolved; transactionality + stale-lease + reopen semantics specified; structural payload allowlist test; deterministic smoke via unset LLM key. R2: 3 P1 / 7 P2 — key-presence-based rejected_candidates parsing (marker unevadable); dedup exercised via terminal→queued→terminal with same job id; missing_llm_key choke-point test licenses the smoke trigger; id format enforced for all kinds; every entry shape preserves invalidity; live strict-schema canary; handler package in Task 6 run; explicit zero-skip Go command |
