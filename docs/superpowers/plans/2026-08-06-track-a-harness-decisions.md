# Track A: Harness Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the unjustified two-agent investigation split, close four known authorization defects, replace a stale shape-based triage rule with the persisted decision, and repair the eval harness so future measurements can be trusted.

**Architecture:** The investigation collapses from two model passes (`submit_dossier` then `adjudicate`) to one that submits an adjudication directly, carrying the candidate list the routing needs. Routing stays pure in `classify.ts` and is tightened so authorization keys off the first citation and off a real candidate/rejection comparison. Write authorization moves to the point of mutation. The fix job stops re-triaging by error shape and loads the decision the investigation persisted. The eval stops leaking ground truth through git history and stops rewarding padded citation lists.

**Tech Stack:** Node 22, TypeScript (strict, ESM), Vitest, Anthropic SDK, Postgres, Go 1.24 (ingestion only).

## Global Constraints

- Use ESM and strict TypeScript. Use `unknown` plus narrowing instead of `any`.
- Keep Vitest tests colocated in `__tests__`.
- Preserve terminal-status and lease contracts; fix the implementation or test setup rather than weakening them.
- Every terminal `needs_human` result must include a non-empty `reason_code`, `reason_message`, and `remediation`.
- Fence untrusted error text and repository content before including it in model prompts.
- **Every commit step runs `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test` first, and does not commit if either fails.** The tree must build and pass at every commit point.
- No task in this plan may call a paid model API except Task 10, which has an explicit approval gate.
- Do not plan or implement the Agent SDK migration or the two-cell loop comparison.

## Reference

- Decision document: `docs/design/2026-08-06-harness-decision.md`
- Design reference: `docs/design/incident-conclusions.md`

## Starting state

`investigateError` (`investigate.ts:220`) runs two `runReadOnlyAgent` passes:
`submit_dossier`, then `adjudicate` over the fenced dossier. `deriveOutcome`
(`classify.ts:48`) routes the adjudication. Only `confidence === 'high'` reaches
the fix path (`index.ts:597`, `index.ts:706`).

The fix agent's mutation surface is four tools in
`packages/worker/src/harness/tool-bridge.ts`: `write` (line 41), `edit` (line
57), `patch` (line 149) and `bash` (line 82).

`db.ts:72` has `recordDiagnosisDecision`. There is **no read counterpart**;
Task 7 adds one.

## File Structure

| File | Responsibility after this plan |
| --- | --- |
| `packages/worker/src/diagnose-schema.ts` (new) | `submit_diagnosis` tool and parser. Replaces `dossier-schema.ts`. |
| `packages/worker/src/dossier-schema.ts` | **Deleted.** Recoverable from git history. |
| `packages/worker/src/investigate.ts` | One-pass orchestration. |
| `packages/worker/src/classify.ts` | Pure routing. Policy arrives as an argument, never from `process.env`. |
| `packages/worker/src/fix-surface.ts` | Path resolution plus the write-time gate. |
| `packages/worker/src/harness/tool-bridge.ts` | Every mutation tool passes the gate. |
| `packages/worker/src/db.ts` | Gains `loadDiagnosisDecision`. |
| `packages/worker/src/agent-fix.ts` | Loads the persisted decision. `triageError` removed. |
| `eval/github-cases/clone.mjs` (new) | Single-commit clone. |
| `eval/github-cases/score.mjs` (new) | Primary-citation scoring and honest reporting. |
| `eval/github-cases/holdout.json` (new) | Frozen split, **read and enforced** by the runners. |

---

## Task 1: Collapse the investigation to a single agent

**Files:**
- Create: `packages/worker/src/diagnose-schema.ts`, `packages/worker/src/__tests__/diagnose-schema.test.ts`
- Modify: `packages/worker/src/investigate.ts`, `shared/src/diagnosis.ts`, `packages/worker/src/__tests__/investigate.test.ts`
- Delete: `packages/worker/src/dossier-schema.ts` and its test

**Interfaces:**
- Consumes: `Adjudication`, `EvidenceStrength`, `HypothesisKind` from `@opslane/shared`; `runReadOnlyAgent` from `./readonly-agent.js`.
- Produces: `submitDiagnosisTool(): Anthropic.Tool`; `parseAdjudication(raw: Record<string, unknown>): Adjudication | null`; `parseLocations(value: unknown): string[]`. `Adjudication` gains `candidates_considered: Array<{ statement: string; kind: HypothesisKind }>`. `InvestigationResult` gains `costUsd: number` and drops `dossier`.

- [ ] **Step 1: Extend the `Adjudication` contract**

Task 3 must check that *each supported local candidate* was rejected. With one
agent there is no dossier to count, so the submission has to carry the candidate
list itself. In `shared/src/diagnosis.ts`, add to `Adjudication`:

```ts
  /**
   * Every cause the investigation weighed, including the winner.
   *
   * Routing needs this to check that an "external system" conclusion was
   * reached *against* the local candidates rather than instead of them. The
   * two-agent version counted local hypotheses in the dossier; with one agent
   * the submission is the only record that the alternatives were considered.
   */
  candidates_considered: Array<{ statement: string; kind: HypothesisKind }>;
```

- [ ] **Step 2: Write the failing parser test**

Create `packages/worker/src/__tests__/diagnose-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseAdjudication, parseLocations, submitDiagnosisTool } from '../diagnose-schema.js';

const valid = {
  best_supported: 'The retry loop never resets its counter',
  evidence_check: 'Read the loop and confirmed no reset',
  candidates_considered: [
    { statement: 'The retry loop never resets', kind: 'local_code' },
    { statement: 'The server rate limits', kind: 'external_system' },
  ],
  rejected: ['Server rate limiting: breadcrumb gaps are 2m+, not burst-shaped'],
  evidence_strength: 'suggestive',
  cause_kind: 'local_code',
  cause_locations: ['src/retry.ts:42'],
  reasoning: 'The counter is declared outside the loop body',
  why_chain: ['Request fails', 'Retry fires', 'Counter never resets'],
  reproduction_steps: ['Trigger one failure', 'Observe unbounded retries'],
};

describe('submitDiagnosisTool', () => {
  it('requires every field routing depends on', () => {
    const required = (submitDiagnosisTool().input_schema as { required?: string[] }).required ?? [];
    expect(required).toEqual(expect.arrayContaining([
      'best_supported', 'evidence_strength', 'cause_kind', 'cause_locations',
      'candidates_considered', 'rejected',
    ]));
  });
});

describe('parseLocations', () => {
  it('keeps an external citation intact and still extracts embedded paths', () => {
    expect(parseLocations(['GET /api/assets/search (remote service)'])).toEqual([
      'GET /api/assets/search (remote service)',
      'api/assets/search',
    ]);
  });

  it('preserves order, because the first entry is the claim', () => {
    expect(parseLocations(['a/one.ts', 'b/two.ts'])[0]).toBe('a/one.ts');
  });

  it('accepts a bare string and drops empties', () => {
    expect(parseLocations('src/App.tsx')).toEqual(['src/App.tsx']);
    expect(parseLocations(['', '  ', null])).toEqual([]);
  });
});

describe('parseAdjudication', () => {
  it('parses a complete submission', () => {
    expect(parseAdjudication(valid)).toMatchObject({
      evidence_strength: 'suggestive',
      cause_kind: 'local_code',
      cause_locations: ['src/retry.ts:42'],
    });
  });

  it('parses the candidate list, dropping malformed entries', () => {
    const parsed = parseAdjudication({
      ...valid,
      candidates_considered: [
        { statement: 'good', kind: 'local_code' },
        { statement: '', kind: 'local_code' },
        { kind: 'local_code' },
        'not an object',
      ],
    });

    expect(parsed?.candidates_considered).toEqual([{ statement: 'good', kind: 'local_code' }]);
  });

  it('defaults an unrecognised candidate kind to unknown', () => {
    const parsed = parseAdjudication({
      ...valid,
      candidates_considered: [{ statement: 'x', kind: 'gremlins' }],
    });

    expect(parsed?.candidates_considered[0]?.kind).toBe('unknown');
  });

  it('returns null without a best_supported claim', () => {
    expect(parseAdjudication({ ...valid, best_supported: '   ' })).toBeNull();
  });

  it('falls back to unknown and insufficient on unrecognised enums', () => {
    expect(parseAdjudication({ ...valid, cause_kind: 'gremlins' })?.cause_kind).toBe('unknown');
    expect(parseAdjudication({ ...valid, evidence_strength: 'certain' })?.evidence_strength).toBe('insufficient');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @opslane/worker test -- diagnose-schema`
Expected: FAIL — `Cannot find module '../diagnose-schema.js'`.

- [ ] **Step 4: Create the schema module**

Create `packages/worker/src/diagnose-schema.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { Adjudication, EvidenceStrength, HypothesisKind } from '@opslane/shared';

const KINDS: HypothesisKind[] = ['local_code', 'external_system', 'data_or_input', 'configuration', 'unknown'];
const STRENGTHS: EvidenceStrength[] = ['conclusive', 'suggestive', 'insufficient'];

function isKind(value: unknown): value is HypothesisKind {
  return typeof value === 'string' && (KINDS as string[]).includes(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((i): i is string => typeof i === 'string' && i.trim().length > 0).map((i) => i.trim())
    : [];
}

function candidates(value: unknown): Adjudication['candidates_considered'] {
  if (!Array.isArray(value)) return [];
  const out: Adjudication['candidates_considered'] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const statement = typeof record['statement'] === 'string' ? record['statement'].trim() : '';
    if (!statement) continue;
    out.push({ statement, kind: isKind(record['kind']) ? record['kind'] : 'unknown' });
  }
  return out;
}

/**
 * The one terminal tool the investigation may call.
 *
 * Replaces the dossier/adjudicate pair. The split was justified by tracing a
 * single fixture whose family was later found broken, never demonstrated a
 * safety benefit, and produced the refusal surface behind two of six no-answer
 * runs. See docs/design/2026-08-06-harness-decision.md.
 */
export function submitDiagnosisTool(): Anthropic.Tool {
  return {
    name: 'submit_diagnosis',
    description: 'Submit the cause you can best support from evidence you read. Call this exactly once.',
    input_schema: {
      type: 'object',
      properties: {
        best_supported: { type: 'string', description: 'The cause, in one sentence.' },
        evidence_check: { type: 'string', description: 'Which files and evidence you checked.' },
        candidates_considered: {
          type: 'array',
          description: 'Every cause you weighed, including the winner. Routing needs this.',
          items: {
            type: 'object',
            properties: { statement: { type: 'string' }, kind: { type: 'string', enum: KINDS } },
            required: ['statement', 'kind'],
          },
        },
        rejected: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Each candidate you ruled out and what ruled it out. If you conclude the cause is ' +
            'outside this codebase, you must reject every local candidate here by name.',
        },
        evidence_strength: {
          type: 'string',
          enum: STRENGTHS,
          description:
            '"conclusive" only when every premise was verified from evidence you read. ' +
            '"insufficient" means you cannot rank your candidates, not that you are less than certain.',
        },
        cause_kind: { type: 'string', enum: KINDS },
        cause_locations: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Every place the cause lives, MOST IMPORTANT FIRST. The FIRST entry is your claim and ' +
            'is the only one we act on; the rest are advisory. Adding extra entries does not help you.',
        },
        reasoning: { type: 'string' },
        why_chain: { type: 'array', items: { type: 'string' } },
        reproduction_steps: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'best_supported', 'evidence_check', 'candidates_considered', 'rejected',
        'evidence_strength', 'cause_kind', 'cause_locations', 'reasoning',
      ],
    },
  };
}

export function parseLocations(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Keep the entry exactly as written FIRST: an external cause like
    // "GET /api/assets/search (remote service)" must survive intact, and
    // extracting a path out of it would mangle the URL. Order is load-bearing:
    // routing acts on out[0].
    out.push(trimmed);
    for (const path of trimmed.match(/[\w.@+-]+(?:\/[\w.@+-]+)+(?::\d+(?:[-:]\d+)?)?/g) ?? []) {
      if (path !== trimmed) out.push(path);
    }
  }
  return [...new Set(out)];
}

export function parseAdjudication(raw: Record<string, unknown>): Adjudication | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const best = typeof raw['best_supported'] === 'string' ? raw['best_supported'].trim() : '';
  if (!best) return null;

  const strength = raw['evidence_strength'];
  return {
    best_supported: best,
    evidence_check: typeof raw['evidence_check'] === 'string' ? raw['evidence_check'].trim() : '',
    candidates_considered: candidates(raw['candidates_considered']),
    rejected: strings(raw['rejected']),
    evidence_strength:
      typeof strength === 'string' && (STRENGTHS as string[]).includes(strength)
        ? (strength as EvidenceStrength)
        : 'insufficient',
    cause_kind: isKind(raw['cause_kind']) ? raw['cause_kind'] : 'unknown',
    cause_locations: parseLocations(raw['cause_locations']),
    reasoning: typeof raw['reasoning'] === 'string' ? raw['reasoning'].trim() : '',
    why_chain: strings(raw['why_chain']),
    reproduction_steps: strings(raw['reproduction_steps']),
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @opslane/worker test -- diagnose-schema`
Expected: PASS, 10 tests.

- [ ] **Step 6: Rewrite `investigateError` as one pass**

In `investigate.ts`: replace the line 3 import with
`import { parseAdjudication, submitDiagnosisTool } from './diagnose-schema.js';`.
Delete `ADJUDICATION_MAX_TURNS` (line 17) and `adjudicationSystemPrompt` (line
161). Rename `dossierSystemPrompt` to `investigationSystemPrompt` and give it
both jobs:

```ts
function investigationSystemPrompt(input: InvestigateInput): string {
  return `You are diagnosing a production error in a codebase you can read.

Find the cause. The code that observes a failure is rarely the code that caused it.

Enumerate the causes that could produce this error, then settle between them from
evidence you actually read. Rules:

- Check every claim about repetition, retries or bursts against the actual timestamps in the breadcrumbs. If the timing does not support the claim, reject it and say so.
- "insufficient" means the evidence cannot separate your candidates: two or more are equally supported and you cannot rank them. It does not mean you are less than certain. If one is better supported than the rest, name it and rate the evidence "suggestive". Refusing to choose when you can choose sends a human a list instead of an answer.
- Distinguish the cause from a code smell. Code that handles a failure badly is not the reason the failure occurred.
- Rate the evidence honestly. Reserve "conclusive" for a conclusion whose every premise you verified from evidence you read. If a decisive premise rests on runtime state you cannot observe, such as a query plan, index, table size, deployed configuration or backend load, the most you may answer is "suggestive".
- List every cause you weighed in candidates_considered, including the one you chose.
- If you conclude the cause is outside this codebase, reject every local candidate by name in "rejected". A conclusion reached instead of the local candidates rather than against them will not be acted on.
- In cause_locations, the FIRST entry is your claim and the only one we act on. Put the file you are most confident about first. Extra entries do not improve your answer.

${evidenceBlock(input)}`;
}
```

Replace the two-pass body with:

```ts
  const run = await traceSpan('investigation.diagnose', { 'investigation.stage': 'diagnose' }, () =>
    runReadOnlyAgent({
      apiKey,
      model: INVESTIGATION_MODEL,
      maxTurns: MAX_TURNS,
      budgetUsd: spendCeilingUsd,
      pricing,
      systemPrompt: investigationSystemPrompt(input),
      firstMessage:
        `Diagnose this error, then call submit_diagnosis. You have about ${MAX_TURNS} tool ` +
        `calls. Spend them on the files that decide between your candidates, and submit what ` +
        `the evidence supports rather than running out.${hints}`,
      terminalTool: submitDiagnosisTool(),
      repoPath,
      spanPrefix: 'diagnose',
    }));

  const filesRead = run.filesRead;
  const costUsd = Number(run.costUsd.toFixed(4));

  if (run.stop !== 'terminal') {
    // Cost is carried on EVERY return path. Dropping it here would undercount
    // exactly the failed and retried runs the eval most needs to price.
    return { ...failed(stopReason(run.stop, 'Investigation'), filesRead, run.lastModelText), costUsd };
  }

  const adjudication = parseAdjudication(run.terminalInput ?? {});
  if (!adjudication) {
    // Log the payload. Without it there is no way to tell a model that answered
    // badly from a schema the model could not satisfy.
    logger.warn('Investigation submitted no usable diagnosis', {
      submitted: JSON.stringify(run.terminalInput ?? {}).slice(0, 2000),
      filesRead: filesRead.length,
    });
  }
```

For `findings`, prefer the model's prose but fall back to the structured
reasoning, because a terminal tool call may carry no accompanying text:

```ts
    findings: run.lastModelText || adjudication?.reasoning || '',
```

Add `costUsd` to `InvestigationResult`, set it on every return, drop
`investigation.hypotheses` from the trace span, and use
`'investigation.cost_usd': costUsd`.

- [ ] **Step 7: Make `dossier` optional, then remove it from the result**

In `InvestigationResult`, delete the `dossier` field entirely. It has no
remaining producer, and keeping it optional would be a shim for a contract this
plan retires. Fix the resulting type errors at every reader; `index.ts` and the
eval runners are the expected sites.

- [ ] **Step 8: Delete the retired module**

```bash
git rm packages/worker/src/dossier-schema.ts
git rm -f packages/worker/src/__tests__/dossier-schema.test.ts 2>/dev/null || true
```

- [ ] **Step 9: Update the investigation tests**

In `__tests__/investigate.test.ts`, every test stubbing two model passes now
stubs one, with a `submit_diagnosis` payload including `candidates_considered`.
Delete tests asserting dossier-then-adjudicate ordering. **Keep** every test
asserting routing, fence escaping, and failure handling. Add one asserting
`costUsd` is non-zero on a non-terminal stop.

- [ ] **Step 10: Build, test, commit**

```bash
pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test
git add -A packages/worker/src shared/src
git commit -m "refactor(worker): retire the two-agent split for a single diagnosis pass

The split was justified by tracing one fixture whose family was later found
broken. It never demonstrated a safety benefit, cost a second model pass, and
produced the refusal surface behind two of six no-answer runs.

The submission now carries candidates_considered, because routing has to check
that an external conclusion rejected the local alternatives and the dossier was
previously the only record that they existed."
```

---

## Task 2: Delete the obsolete synthetic fixtures

**Files:**
- Delete: `eval/cases/hard-h2-500-reported/`, `hard-h4-retry-storm/`, `hard-h5-malformed-url/`, `hard-h6-null-deref/`
- Keep: `hard-h1-timeout/` (PR #1297 regression control, used by `pr1297.integration.test.ts:89,123`), `hard-h4-control-server-ratelimit/` (non-actionable control)
- Modify: `eval/fixtures-source/hard-cases-reference.ts`

**Interfaces:** Consumes nothing. Produces nothing.

- [ ] **Step 1: Check for code references only**

```bash
grep -rn "hard-h2-500-reported\|hard-h4-retry-storm\|hard-h5-malformed-url\|hard-h6-null-deref" \
  --include=*.ts --include=*.mjs --include=*.json . | grep -v node_modules | grep -v "^./eval/cases/"
```

Documentation mentions are fine and expected — this plan and the decision
document both name these fixtures. **Stop only if a `.ts`, `.mjs` or `.json`
file outside `eval/cases/` references them**, since that means a runner or test
depends on them.

- [ ] **Step 2: Delete**

```bash
git rm -r eval/cases/hard-h2-500-reported eval/cases/hard-h4-retry-storm \
         eval/cases/hard-h5-malformed-url eval/cases/hard-h6-null-deref
```

- [ ] **Step 3: Trim the reference file**

In `eval/fixtures-source/hard-cases-reference.ts`, delete the four removed
blocks, keep `hard-h1-timeout` and `hard-h4-control-server-ratelimit`, and add:

```ts
/**
 * Two synthetic cases survive the real-bug corpus.
 *
 * hard-h1-timeout is the PR #1297 regression control: a request timeout that
 * must never be routed to a code fix. hard-h4-control-server-ratelimit is the
 * non-actionable control. Everything else was deleted because calibrations made
 * against four-file toy repositories were wrong on every real one: the turn
 * budget, the claim nothing reaches "conclusive", and the H4 case that had to be
 * rebuilt. See docs/design/2026-08-06-harness-decision.md.
 */
```

- [ ] **Step 4: Build, test, commit**

```bash
pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test
cd eval && npx vitest run && cd ..
git add -A eval/
git commit -m "test(eval): delete the synthetic fixtures the real corpus replaced

Keeps hard-h1-timeout, the PR #1297 regression control, and
hard-h4-control-server-ratelimit, the non-actionable control. The other four
calibrated us wrong on every real repository we later tried."
```

---

## Task 3: Route on the first citation, and check rejections against candidates

**Files:**
- Modify: `packages/worker/src/classify.ts`, `packages/worker/src/__tests__/classify.test.ts`, `packages/worker/src/investigate.ts`, `packages/worker/src/index.ts`

**Interfaces:**
- Consumes: `Adjudication.candidates_considered` from Task 1.
- Produces: `deriveOutcome(adjudication, surface, resolvePath, policy)` where `policy: { allowUnrestrictedSurface: boolean }`. New basis values `'primary_outside_fix_surface'` and `'no_fix_surface_configured'`. The old `'outside_fix_surface'` is **removed**, not kept alongside.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/classify.test.ts`:

```ts
const POLICY = { allowUnrestrictedSurface: true };

const localBase = {
  best_supported: 'A null deref in the panel',
  evidence_check: 'read both files',
  candidates_considered: [{ statement: 'null deref', kind: 'local_code' as const }],
  rejected: [],
  evidence_strength: 'suggestive' as const,
  cause_kind: 'local_code' as const,
  reasoning: 'r',
  why_chain: [],
  reproduction_steps: [],
};

describe('the first citation is the claim', () => {
  it('refuses when the first citation is outside the surface, even if a later one is inside', () => {
    const d = deriveOutcome(
      { ...localBase, cause_locations: ['server/app.py', 'client/App.tsx'] },
      { globs: ['client/**'] }, (c) => c, POLICY,
    );

    expect(d.outcome).toBe('not_actionable');
    expect(d.basis).toBe('primary_outside_fix_surface');
  });

  it('authorizes when the first citation is inside the surface', () => {
    const d = deriveOutcome(
      { ...localBase, cause_locations: ['client/App.tsx', 'server/app.py'] },
      { globs: ['client/**'] }, (c) => c, POLICY,
    );

    expect(d.outcome).toBe('code_fix');
    expect(d.basis).toBe('in_surface_defect');
  });

  // A vague or external first entry must not fall through to a later citation:
  // that is the "any citation authorises" hole wearing a different shape.
  it('does not skip past an unparseable first citation to authorize a later one', () => {
    const d = deriveOutcome(
      { ...localBase, cause_locations: ['somewhere in the render path', 'client/App.tsx'] },
      { globs: ['client/**'] }, (c) => c, POLICY,
    );

    expect(d.outcome).toBe('needs_more_context');
    expect(d.basis).toBe('uncitable_local_claim');
  });
});

describe('external conclusions must reject every local candidate', () => {
  const external = {
    best_supported: 'The upstream gateway timed out',
    evidence_check: 'checked breadcrumb timings',
    evidence_strength: 'suggestive' as const,
    cause_kind: 'external_system' as const,
    cause_locations: ['GET /api/search (remote service)'],
    reasoning: 'r',
    why_chain: [],
    reproduction_steps: [],
  };

  it('accepts when every local candidate is named in the rejections', () => {
    const d = deriveOutcome({
      ...external,
      candidates_considered: [
        { statement: 'A client retry loop', kind: 'local_code' },
        { statement: 'Gateway timeout', kind: 'external_system' },
      ],
      rejected: ['A client retry loop: the counter does reset, verified in src/retry.ts'],
    }, { globs: null }, () => null, POLICY);

    expect(d.outcome).toBe('not_actionable');
    expect(d.basis).toBe('cause_outside_codebase');
  });

  // This is the defect: previously ANY one string in `rejected` satisfied the
  // check, so a model could reject an irrelevant candidate and escape the work.
  it('refuses when a local candidate is left unrejected', () => {
    const d = deriveOutcome({
      ...external,
      candidates_considered: [
        { statement: 'A client retry loop', kind: 'local_code' },
        { statement: 'A stale cache key', kind: 'configuration' },
      ],
      rejected: ['A client retry loop: the counter does reset'],
    }, { globs: null }, () => null, POLICY);

    expect(d.outcome).toBe('needs_more_context');
    expect(d.basis).toBe('unrejected_local_candidates');
    expect(d.reason).toContain('A stale cache key');
  });

  it('accepts when there were no local candidates to reject', () => {
    const d = deriveOutcome({
      ...external,
      candidates_considered: [{ statement: 'Gateway timeout', kind: 'external_system' }],
      rejected: [],
    }, { globs: null }, () => null, POLICY);

    expect(d.outcome).toBe('not_actionable');
  });
});

describe('unconfigured fix surface', () => {
  it('refuses a fix when no surface is configured and policy does not allow it', () => {
    const d = deriveOutcome(
      { ...localBase, cause_locations: ['client/App.tsx'] },
      { globs: null }, (c) => c, { allowUnrestrictedSurface: false },
    );

    expect(d.outcome).toBe('needs_more_context');
    expect(d.basis).toBe('no_fix_surface_configured');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @opslane/worker test -- classify`
Expected: FAIL — `deriveOutcome` takes a different fourth argument and the
basis values do not exist.

- [ ] **Step 3: Change the signature and basis union**

In `classify.ts`, replace `'outside_fix_surface'` in the union with
`'primary_outside_fix_surface'`, and add `'no_fix_surface_configured'`. Then:

```ts
/** Routing policy, passed in so this function stays pure and testable. */
export interface RoutingPolicy {
  /**
   * Whether a project with no configured fix surface may still be fixed. A null
   * glob list makes the whole repository writable, so this defaults to false at
   * the call site and exists as an explicit escape hatch, not an accident.
   */
  allowUnrestrictedSurface: boolean;
}

export function deriveOutcome(
  adjudication: Adjudication | null,
  surface: FixSurface,
  resolvePath: (cited: string) => string | null,
  policy: RoutingPolicy,
): DerivedDecision {
```

- [ ] **Step 4: Implement the per-candidate rejection check**

Replace the external/data branch with a real comparison. A local candidate
counts as rejected when its statement appears in one of the rejection strings:

```ts
  if (adjudication.cause_kind === 'external_system' || adjudication.cause_kind === 'data_or_input') {
    // We cannot verify from the repository that a remote service was slow. What
    // we can require is that the conclusion was reached against the local
    // alternatives rather than instead of them.
    //
    // The previous version only checked `rejected` was non-empty, so rejecting
    // one irrelevant candidate satisfied it. Check each local candidate by name.
    const locals = adjudication.candidates_considered.filter(
      (candidate) => candidate.kind === 'local_code' || candidate.kind === 'configuration',
    );
    const rejectedText = adjudication.rejected.join('\n').toLowerCase();
    const unrejected = locals.filter((candidate) => !rejectedText.includes(candidate.statement.toLowerCase()));

    if (unrejected.length > 0) {
      return {
        outcome: 'needs_more_context',
        reason:
          `The investigation concluded the cause is external without rejecting ` +
          `${unrejected.map((c) => JSON.stringify(c.statement)).join(', ')}`,
        basis: 'unrejected_local_candidates',
        confidence: 'low',
      };
    }
    return {
      outcome: 'not_actionable',
      reason: `The cause is outside this codebase: ${adjudication.cause_locations[0] ?? adjudication.best_supported}`,
      basis: 'cause_outside_codebase',
      confidence: confidenceFor(adjudication.evidence_strength),
    };
  }
```

- [ ] **Step 5: Gate the unconfigured surface, then route on the first citation**

```ts
  // A project with no configured surface makes the whole repository writable.
  // That was previously a log line standing next to an authorised fix.
  if (surface.globs === null && !policy.allowUnrestrictedSurface) {
    return {
      outcome: 'needs_more_context',
      reason: 'No fix surface is configured for this project, so no path is authorised for writing',
      basis: 'no_fix_surface_configured',
      confidence: 'low',
    };
  }

  // The FIRST citation is the claim. Do not search the list for one that
  // happens to parse or happens to land in-surface: "any citation authorises"
  // is the hole this replaces, and scanning past an unparseable first entry
  // reopens it in a different shape.
  const primary = parseCauseLocation(adjudication.cause_locations[0] ?? '');

  if (primary.kind !== 'repo_path') {
    return {
      outcome: 'needs_more_context',
      reason:
        `The investigation claims a ${adjudication.cause_kind} cause but its first citation ` +
        `is not a checkable file: ${JSON.stringify(adjudication.cause_locations[0] ?? null)}`,
      basis: 'uncitable_local_claim',
      confidence: 'low',
    };
  }

  const resolved = resolvePath(primary.path);
  if (resolved === null) {
    return {
      outcome: 'needs_more_context',
      reason: `The investigation cites ${primary.path}, which does not resolve to a file in the checked-out repository`,
      basis: 'citation_unresolvable',
      confidence: 'low',
    };
  }

  // Match the glob against the RESOLVED path, never the cited string: a symlink
  // inside the surface pointing outside it would otherwise authorise the write.
  if (!isInsideFixSurface(resolved, surface)) {
    return {
      outcome: 'not_actionable',
      reason: `The primary cause is at ${resolved}, outside the configured fix surface`,
      basis: 'primary_outside_fix_surface',
      confidence: confidenceFor(adjudication.evidence_strength),
    };
  }

  return {
    outcome: 'code_fix',
    reason: `The cause is at ${resolved}`,
    basis: 'in_surface_defect',
    confidence: confidenceFor(adjudication.evidence_strength),
  };
```

- [ ] **Step 6: Update the call site and document the escape hatch**

In `investigate.ts`:

```ts
  const decision = deriveOutcome(adjudication, surface, (cited) => resolveInsideRepo(repoPath, cited), {
    allowUnrestrictedSurface: process.env['ALLOW_UNRESTRICTED_FIX_SURFACE'] === '1',
  });
```

Delete the `code_fix && surface.globs === null` warning block — `deriveOutcome`
now refuses that combination unless the policy allows it. Append to
`docs/reference/environment-variables.md`:

```markdown
| `ALLOW_UNRESTRICTED_FIX_SURFACE` | unset | Set to `1` to authorise fixes for projects with no `fix_surface_globs` configured, which makes the entire repository writable. Unset, such projects route to `needs_more_context`. |
```

- [ ] **Step 7: Update `index.ts`**

```bash
grep -n "outside_fix_surface" packages/worker/src/index.ts
```

Replace any `'outside_fix_surface'` comparison with
`'primary_outside_fix_surface'`. The old value is removed, so a stale
comparison is now a type error rather than a silent behaviour change.

- [ ] **Step 8: Build, test, commit**

```bash
pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test
git add -A packages/worker/src docs/
git commit -m "fix(worker): route on the first citation, and check rejections per candidate

Three authorization defects. code_fix was granted when ANY citation resolved
in-surface, so a diagnosis whose real cause was in the backend could authorise a
frontend write by also naming a frontend file. An external conclusion was
accepted whenever `rejected` held any one string, so rejecting an irrelevant
candidate escaped the work; it is now checked against candidates_considered by
name. And an unconfigured fix surface made the whole repository writable behind
a warning log, which now fails closed behind an explicit policy flag.

deriveOutcome takes that policy as an argument rather than reading process.env,
so it stays pure."
```

---

## Task 4: Gate every mutation on the fix surface

`resolveInsideRepo` validates the path the *diagnosis* cited. Nothing checks the
path the fix agent writes.

**Scope, stated honestly.** The fix agent's mutation surface is four tools in
`tool-bridge.ts`: `write` (line 41), `edit` (line 57), `patch` (line 149) and
`bash` (line 82). **This task gates the first three. `bash` can write anywhere
and no tool-level check can cover it** — its containment is the E2B sandbox, not
the fix surface. That gap is real, is not closed here, and is recorded in "Known
gaps".

**Files:**
- Modify: `packages/worker/src/fix-surface.ts`, `packages/worker/src/__tests__/fix-surface-boundary.test.ts`, `packages/worker/src/harness/tool-bridge.ts`, `packages/worker/src/harness/__tests__/tool-bridge.test.ts`

**Interfaces:**
- Consumes: `resolveInsideRepo`, `isInsideFixSurface`, `FixSurface`.
- Produces: `assertWritable(repoPath: string, cited: string, surface: FixSurface): string` returning the **repository-relative resolved path**, throwing `FixSurfaceViolation`. Callers must write through the returned path.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/fix-surface-boundary.test.ts`:

```ts
import { assertWritable, FixSurfaceViolation } from '../fix-surface.js';

describe('assertWritable', () => {
  it('returns the resolved path for an existing file inside the surface', () => {
    expect(assertWritable(repo, 'client/src/AssetList.tsx', { globs: ['client/**'] }))
      .toBe('client/src/AssetList.tsx');
  });

  it('throws for an existing file outside the surface', () => {
    expect(() => assertWritable(repo, 'server/app/asset.py', { globs: ['client/**'] }))
      .toThrow(FixSurfaceViolation);
  });

  // Fixes create files. Gating only existing files would reject every new test
  // file the fix agent writes, so a create resolves through its parent.
  it('allows creating a new file whose parent directory is inside the surface', () => {
    expect(assertWritable(repo, 'client/src/NewPanel.tsx', { globs: ['client/**'] }))
      .toBe('client/src/NewPanel.tsx');
  });

  it('refuses creating a new file whose parent is outside the surface', () => {
    expect(() => assertWritable(repo, 'server/app/new.py', { globs: ['client/**'] }))
      .toThrow(FixSurfaceViolation);
  });

  it('refuses a create whose parent directory does not exist', () => {
    expect(() => assertWritable(repo, 'client/nope/deep/New.tsx', { globs: ['client/**'] }))
      .toThrow(FixSurfaceViolation);
  });

  it('throws when a symlinked directory inside the surface resolves outside it', async () => {
    await symlink(join(repo, 'server'), join(repo, 'client/vendor'));

    expect(() => assertWritable(repo, 'client/vendor/app/asset.py', { globs: ['client/**'] }))
      .toThrow(FixSurfaceViolation);
    // And the create path through the same symlink.
    expect(() => assertWritable(repo, 'client/vendor/app/new.py', { globs: ['client/**'] }))
      .toThrow(FixSurfaceViolation);
  });

  it('throws for a path escaping the repository', () => {
    expect(() => assertWritable(repo, '../../etc/passwd', { globs: null })).toThrow(FixSurfaceViolation);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @opslane/worker test -- fix-surface-boundary`
Expected: FAIL — `assertWritable` is not exported.

- [ ] **Step 3: Implement the gate**

Append to `fix-surface.ts`:

```ts
import { dirname, basename } from 'node:path';

/** Thrown when a write is attempted outside the configured fix surface. */
export class FixSurfaceViolation extends Error {
  constructor(readonly cited: string, readonly resolved: string | null) {
    super(
      resolved === null
        ? `Refusing to write ${cited}: it does not resolve inside the repository`
        : `Refusing to write ${cited}: it resolves to ${resolved}, outside the configured fix surface`,
    );
    this.name = 'FixSurfaceViolation';
  }
}

/**
 * The authorization check that guards a write, run immediately before it.
 *
 * resolveInsideRepo answers a different question at a different time: whether a
 * path the *diagnosis* cited exists. This answers whether the path about to be
 * written is inside the surface, and fails closed on anything it cannot resolve.
 *
 * Creates resolve through the parent directory, because resolveInsideRepo
 * requires an existing regular file and fixes legitimately add files.
 *
 * This narrows the window; it does not eliminate it. A symlink swapped between
 * this call and the write would still win. Closing that fully needs the write
 * to go through a descriptor opened with O_NOFOLLOW rather than a path, which
 * is out of scope here and recorded in the plan's known gaps.
 */
export function assertWritable(repoPath: string, cited: string, surface: FixSurface): string {
  const existing = resolveInsideRepo(repoPath, cited);
  if (existing !== null) {
    if (!isInsideFixSurface(existing, surface)) throw new FixSurfaceViolation(cited, existing);
    return existing;
  }

  // Not an existing file: treat it as a create and authorize via the parent.
  const parent = dirname(cited);
  const name = basename(cited);
  if (!name || name === '.' || name === '..') throw new FixSurfaceViolation(cited, null);

  const parentReal = resolveDirInsideRepo(repoPath, parent);
  if (parentReal === null) throw new FixSurfaceViolation(cited, null);

  const target = parentReal === '' ? name : `${parentReal}/${name}`;
  if (!isInsideFixSurface(target, surface)) throw new FixSurfaceViolation(cited, target);
  return target;
}
```

`resolveInsideRepo` rejects directories, so add a sibling that accepts them:

```ts
/** As resolveInsideRepo, but for a directory. Returns '' for the repo root. */
function resolveDirInsideRepo(repoPath: string, cited: string): string | null {
  let repoReal: string;
  let target: string;
  try {
    repoReal = realpathSync(repoPath);
    target = realpathSync(join(repoReal, cited));
  } catch {
    return null;
  }
  if (target !== repoReal && !target.startsWith(`${repoReal}/`)) return null;
  try {
    if (!statSync(target).isDirectory()) return null;
  } catch {
    return null;
  }
  return relative(repoReal, target);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @opslane/worker test -- fix-surface-boundary`
Expected: PASS.

- [ ] **Step 5: Write the failing bridge test**

The helper passing proves nothing about the bridge. Append to
`packages/worker/src/harness/__tests__/tool-bridge.test.ts` one case per gated
tool:

```ts
describe('mutation tools are gated on the fix surface', () => {
  for (const tool of ['write', 'edit', 'patch'] as const) {
    it(`refuses ${tool} outside the surface, and does not touch the file`, async () => {
      const bridge = makeBridge({ repoPath: repo, surface: { globs: ['client/**'] } });

      const result = await bridge.execute(tool, argsFor(tool, 'server/app/asset.py'));

      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain('outside the configured fix surface');
      expect(readFileSync(join(repo, 'server/app/asset.py'), 'utf8')).toBe('def get(): pass\n');
    });

    it(`allows ${tool} inside the surface`, async () => {
      const bridge = makeBridge({ repoPath: repo, surface: { globs: ['client/**'] } });

      const result = await bridge.execute(tool, argsFor(tool, 'client/src/AssetList.tsx'));

      expect(result.isError).toBeFalsy();
    });
  }
});
```

Adapt `makeBridge`/`argsFor`/`execute` to the construction and dispatch this
test file already uses.

- [ ] **Step 6: Thread the surface and gate the three tools**

Read `tool-bridge.ts` before editing. Add `surface: FixSurface` to the bridge's
construction options, thread it from the fix job, and at the top of the `write`,
`edit` and `patch` handlers replace the caller-supplied path with the gated one:

```ts
      // Write through the resolved path, not the string the model supplied.
      const target = assertWritable(repoPath, input.path, surface);
```

Let `FixSurfaceViolation` surface as a tool error the model sees rather than
crashing the job.

- [ ] **Step 7: Build, test, commit**

```bash
pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test
git add -A packages/worker/src
git commit -m "fix(worker): gate write, edit and patch on the fix surface

resolveInsideRepo validated the path the diagnosis cited, minutes earlier and
against a different question. Nothing checked the path actually written.
assertWritable runs immediately before the write, authorizes creates through
their parent directory, and fails closed.

bash is deliberately NOT gated: it can write anywhere and no tool-level check
covers it. Its containment is the E2B sandbox."
```

---

## Task 5: Enforce decision immutability in the schema

**Files:**
- Create: `packages/ingestion/db/migrations/034_diagnosis_decisions_immutable.sql`
- Modify: `packages/ingestion/db/queries_test.go`

**Interfaces:** Consumes the table from migration `033`. Produces a
database-level insert-only guarantee.

- [ ] **Step 1: Confirm the table name**

```bash
cat packages/ingestion/db/migrations/033_diagnosis_decisions.sql
```

Use the actual table name below wherever this plan writes
`diagnosis_decisions`.

- [ ] **Step 2: Write the failing Go test**

Append to `queries_test.go`. Assert the specific SQLSTATE, not merely that some
error occurred:

```go
func TestDiagnosisDecisionsAreImmutable(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	id := seedDiagnosisDecision(t, pool)

	for _, tc := range []struct {
		name string
		sql  string
	}{
		{"update", `UPDATE diagnosis_decisions SET outcome = 'not_actionable' WHERE id = $1`},
		{"delete", `DELETE FROM diagnosis_decisions WHERE id = $1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, tc.sql, id)
			if err == nil {
				t.Fatalf("expected %s to be rejected, but it succeeded", tc.name)
			}
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.Code != "2F004" {
				t.Fatalf("expected SQLSTATE 2F004 (reading_sql_data_not_permitted family), got %v", err)
			}
		})
	}

	// TRUNCATE bypasses row triggers entirely, so it needs its own statement trigger.
	t.Run("truncate", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `TRUNCATE diagnosis_decisions`); err == nil {
			t.Fatal("expected TRUNCATE to be rejected, but it succeeded")
		}
	})
}
```

Write `seedDiagnosisDecision` following the seeding pattern the neighbouring
tests already use, returning the inserted row's id.

- [ ] **Step 3: Run to verify it fails**

```bash
cd packages/ingestion && go test ./db/ -run TestDiagnosisDecisionsAreImmutable -v
```

Expected: FAIL — "expected update to be rejected, but it succeeded".

- [ ] **Step 4: Write the migration**

Create `packages/ingestion/db/migrations/034_diagnosis_decisions_immutable.sql`:

```sql
-- A diagnosis decision records what was decided and why, at a moment. It was
-- documented as immutable with nothing enforcing it, so an UPDATE could
-- silently rewrite the justification for a fix that had already shipped.

CREATE OR REPLACE FUNCTION reject_diagnosis_decision_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'diagnosis_decisions is insert-only: % rejected', TG_OP
    USING ERRCODE = '2F004';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER diagnosis_decisions_immutable_row
  BEFORE UPDATE OR DELETE ON diagnosis_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_diagnosis_decision_mutation();

-- TRUNCATE does not fire row-level triggers, so it needs a statement trigger.
CREATE TRIGGER diagnosis_decisions_immutable_truncate
  BEFORE TRUNCATE ON diagnosis_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_diagnosis_decision_mutation();
```

- [ ] **Step 5: Apply and re-run**

```bash
cd packages/ingestion && go run ./cmd/migrate up && go test ./db/ -run TestDiagnosisDecisionsAreImmutable -v
```

Expected: PASS, three subtests.

- [ ] **Step 6: Run the Go suite and count skips explicitly**

`go test ./...` prints `ok` for a package whose tests all skipped, which is the
false green `AGENTS.md` warns about. Count them:

```bash
cd packages/ingestion && go build ./... && go test ./... -v 2>&1 | grep -c -- "--- SKIP"
```

Expected: `0`. A non-zero count means `DATABASE_URL` or the storage credentials
are unset; export the block from the root `AGENTS.md` and re-run before trusting
anything.

- [ ] **Step 7: Commit**

```bash
git add -A packages/ingestion/db
git commit -m "feat(ingestion): make diagnosis decisions insert-only in the schema

The table was documented as immutable with nothing enforcing it, so an UPDATE
could rewrite the recorded justification for a fix that had already shipped.
Covers TRUNCATE too, which does not fire row triggers."
```

---

## Task 6: Fix jobs load the persisted decision

`agent-fix.ts:271` instructs a Haiku pass to classify by error shape, which is
what this pipeline replaces. It runs in every fix job (`agent-fix.ts:581`)
*after* the investigation already routed and persisted a decision.

**Files:**
- Modify: `packages/worker/src/db.ts`, `packages/worker/src/agent-fix.ts`, `packages/worker/src/index.ts`, `packages/worker/src/__tests__/agent-fix.test.ts`, `packages/worker/src/__tests__/db.test.ts`

**Interfaces:**
- Consumes: `DerivedDecision['basis']`, `DiagnosisOutcome`, `recordDiagnosisDecision` (`db.ts:72`).
- Produces: `loadDiagnosisDecision(errorGroupId: string, projectId: string): Promise<PersistedDecision | null>` where `PersistedDecision = { outcome: DiagnosisOutcome; basis: DerivedDecision['basis']; confidence: 'high' | 'medium' | 'low' }`.

- [ ] **Step 1: Write the failing db test**

Append to `__tests__/db.test.ts`:

```ts
describe('loadDiagnosisDecision', () => {
  it('returns the most recent decision for the group', async () => {
    await recordDiagnosisDecision(groupId, projectId, {
      outcome: 'not_actionable', reason: 'external', basis: 'cause_outside_codebase', confidence: 'high',
    });

    expect(await loadDiagnosisDecision(groupId, projectId)).toMatchObject({
      outcome: 'not_actionable', basis: 'cause_outside_codebase', confidence: 'high',
    });
  });

  it('returns null when the group has no decision', async () => {
    expect(await loadDiagnosisDecision('missing-group', projectId)).toBeNull();
  });

  it('scopes by project', async () => {
    await recordDiagnosisDecision(groupId, projectId, {
      outcome: 'code_fix', reason: 'r', basis: 'in_surface_defect', confidence: 'high',
    });

    expect(await loadDiagnosisDecision(groupId, 'other-project')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `pnpm --filter @opslane/worker test -- db`
Expected: FAIL — `loadDiagnosisDecision` is not exported.

Implement it in `db.ts` mirroring `recordDiagnosisDecision`'s query style,
ordering by the insertion timestamp descending and taking one row. Scope by both
`error_group_id` and `project_id`, per the worker's contract that database
operations are scoped to the project.

- [ ] **Step 3: Write the failing fix-job test**

Append to `__tests__/agent-fix.test.ts`. Assert on an observable the
implementation controls, not on an uninjected spy:

```ts
describe('fix jobs read the persisted decision instead of re-triaging', () => {
  it('short-circuits when the persisted decision was not code_fix', async () => {
    await recordDiagnosisDecision(groupId, projectId, {
      outcome: 'not_actionable', reason: 'external', basis: 'cause_outside_codebase', confidence: 'high',
    });

    const result = await runAgentFix({ ...baseInput, errorGroupId: groupId, projectId });

    expect(result.status).toBe('needs_human');
    expect(result.reason.reason_code).toBe('cause_outside_codebase');
    expect(result.reason.reason_message).toBeTruthy();
    expect(result.reason.remediation).toBeTruthy();
    // No sandbox is provisioned on this path.
    expect(sandboxFactory).not.toHaveBeenCalled();
  });

  it('short-circuits on a code_fix decision that is not high confidence', async () => {
    await recordDiagnosisDecision(groupId, projectId, {
      outcome: 'code_fix', reason: 'r', basis: 'in_surface_defect', confidence: 'medium',
    });

    const result = await runAgentFix({ ...baseInput, errorGroupId: groupId, projectId });

    expect(result.status).toBe('needs_human');
    expect(sandboxFactory).not.toHaveBeenCalled();
  });

  it('fails closed when no decision was persisted', async () => {
    const result = await runAgentFix({ ...baseInput, errorGroupId: 'no-decision', projectId });

    expect(result.status).toBe('needs_human');
    expect(sandboxFactory).not.toHaveBeenCalled();
  });

  it('provisions a sandbox for a high-confidence code_fix', async () => {
    await recordDiagnosisDecision(groupId, projectId, {
      outcome: 'code_fix', reason: 'r', basis: 'in_surface_defect', confidence: 'high',
    });

    await runAgentFix({ ...baseInput, errorGroupId: groupId, projectId });

    expect(sandboxFactory).toHaveBeenCalled();
  });
});
```

`sandboxFactory` must be the injected sandbox constructor this test file already
stubs. If the suite has no such seam, add one rather than asserting on an
uninjected mock — a spy that is never wired in passes no matter what the code
does.

- [ ] **Step 4: Replace the triage stage**

In `agent-fix.ts`, replace the "Stage 1: Always run cheap Haiku triage" block
with a load of the persisted decision:

```ts
      // The investigation already decided this and persisted it. Re-deciding
      // here by error shape both duplicated the decision and reintroduced the
      // classification this pipeline replaced. Loading the row rather than
      // trusting an in-memory value also ties a retried or requeued job to the
      // immutable decision it was created from.
      const decision = await loadDiagnosisDecision(input.errorGroupId, input.projectId);

      if (!decision || decision.outcome !== 'code_fix' || decision.confidence !== 'high') {
        return {
          status: 'needs_human',
          reason: {
            reason_code: decision?.basis ?? 'no_persisted_decision',
            reason_message: decision
              ? `The investigation routed this to ${decision.outcome} at ${decision.confidence} confidence`
              : 'No diagnosis decision was persisted for this error group',
            remediation: 'Review the diagnosis decision for this error group',
          },
        };
      }
```

Checking `confidence !== 'high'` preserves the existing contract that only high
confidence acts (`index.ts:597`, `index.ts:706`); checking the outcome alone
would let a medium-confidence `code_fix` reach the sandbox.

- [ ] **Step 5: Delete `triageError`**

Delete `triageError` (`agent-fix.ts:249` through the end of that function,
including the rule list at line 271).

`TriageResult` stays: `InvestigationResult` extends it (`investigate.ts:52`).
Before deleting, list what only `triageError` populated:

```bash
grep -n "reason_code\|remediation" packages/worker/src/agent-fix.ts | head
```

Any `TriageResult` field with no remaining producer becomes optional or is
removed; do not leave a required field nothing sets.

Confirm no other caller depends on it:

```bash
grep -rn "triageError" --include=*.ts packages/ | grep -v node_modules
```

Expected after the edit: no matches outside deleted test code.

- [ ] **Step 6: Build, test, commit**

```bash
pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test
git add -A packages/worker/src
git commit -m "fix(worker): fix jobs load the persisted decision instead of re-triaging

triageError classified by error shape - 'infrastructure/network issue (CORS,
DNS, timeout, 502, 503)' - which is exactly what the diagnosis-first work
replaced, and it ran in every fix job after the investigation had already routed
and persisted a decision.

The job now loads the persisted row rather than trusting an in-memory value, so
a requeued or retried job is tied to the immutable decision it came from, and it
checks confidence as well as outcome so a medium-confidence code_fix cannot
reach the sandbox."
```

---

## Task 7: Stop the eval leaking ground truth through git history

**Files:**
- Create: `eval/github-cases/clone.mjs`, `eval/github-cases/__tests__/clone.test.mjs`
- Modify: `eval/github-cases/run-apps.mjs`, `run.mjs`, `run-sdk.mjs`, `cases.jsonl`, `cases-apps.jsonl`, `generate-cases.sh`

**Interfaces:**
- Produces: `cloneAtBase(repo: string, baseSha: string, fixSha: string): string` from `./clone.mjs`, returning the clone directory. `fix_sha` becomes a **required** field on every case.

- [ ] **Step 1: Record the fix SHA on every case, and require it**

Extend `generate-cases.sh` to emit `fix_sha` from
`gh pr view <n> --json mergeCommit --jq .mergeCommit.oid`, and backfill the 22
existing cases. Then add a load-time assertion in each runner:

```js
const missing = cases.filter((c) => !c.fix_sha).map((c) => `${c.repo}#${c.issue}`);
if (missing.length > 0) {
  throw new Error(`Cases missing fix_sha, so the leak assertion cannot run: ${missing.join(', ')}`);
}
```

An optional `fix_sha` would silently disable the leak check for exactly the case
that omitted it.

- [ ] **Step 2: Write the failing test against a local repository**

A test that clones from GitHub is slow, offline-hostile, and depends on external
state. Build the fixture locally. Create
`eval/github-cases/__tests__/clone.test.mjs`:

```js
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cloneAtBase } from '../clone.mjs';

let origin, baseSha, fixSha, cacheRoot;

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

beforeAll(() => {
  origin = mkdtempSync(join(tmpdir(), 'clone-origin-'));
  cacheRoot = mkdtempSync(join(tmpdir(), 'clone-cache-'));
  git(origin, 'init', '-q');
  git(origin, 'config', 'user.email', 't@example.com');
  git(origin, 'config', 'user.name', 'T');
  writeFileSync(join(origin, 'app.ts'), 'export const bug = true;\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'base');
  baseSha = git(origin, 'rev-parse', 'HEAD');
  writeFileSync(join(origin, 'app.ts'), 'export const bug = false;\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'fix: the thing');
  fixSha = git(origin, 'rev-parse', 'HEAD');
});

afterAll(() => {
  for (const dir of [origin, cacheRoot]) rmSync(dir, { recursive: true, force: true });
});

describe('cloneAtBase', () => {
  it('produces a clone from which the fix commit cannot be resolved', () => {
    const dir = cloneAtBase(origin, baseSha, fixSha, cacheRoot);

    expect(git(dir, 'rev-parse', 'HEAD')).toBe(baseSha);
    expect(git(dir, 'rev-list', '--all', '--count')).toBe('1');
    expect(() => git(dir, 'cat-file', '-e', `${fixSha}^{commit}`)).toThrow();
  });

  it('rebuilds rather than reusing a clone whose HEAD is wrong', () => {
    const dir = cloneAtBase(origin, baseSha, fixSha, cacheRoot);
    writeFileSync(join(dir, 'app.ts'), 'mutated by a previous run\n');

    const again = cloneAtBase(origin, baseSha, fixSha, cacheRoot);

    // A reused worktree must be clean, or one arm contaminates the next.
    expect(git(again, 'status', '--porcelain')).toBe('');
  });

  it('throws if the fix commit is somehow reachable', () => {
    const dir = cloneAtBase(origin, baseSha, fixSha, cacheRoot);
    execFileSync('git', ['-C', dir, 'fetch', '-q', '--depth', '1', origin, fixSha]);

    expect(() => cloneAtBase(origin, baseSha, fixSha, cacheRoot)).toThrow(/leak/i);
  });

  it('does not add files to the checked-out tree', () => {
    const dir = cloneAtBase(origin, baseSha, fixSha, cacheRoot);

    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd eval && npx vitest run github-cases/__tests__/clone.test.mjs`
Expected: FAIL — `Cannot find module '../clone.mjs'`.

- [ ] **Step 4: Implement the single-commit clone**

Create `eval/github-cases/clone.mjs`. Use `execFileSync` with an argument array
throughout — string interpolation into a shell is both an injection and a
quoting defect. Keep the marker **outside** the checkout so the tree presented
to the agent is exactly the repository:

```js
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_ROOT = '/tmp/opslane-gheval-repos';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

/**
 * Clone a repository at exactly one commit, with no other history reachable.
 *
 * The previous clone used --filter=blob:none --no-checkout and then checked out
 * base_sha, which fetches EVERY ref. The merged fix was therefore reachable:
 * for documenso#2945 one `git log --all --grep="typed signature"` returned the
 * fix commit, so any arm with a shell could read the answer it was scored on.
 *
 * The single-commit fetch is what carries the guarantee. The fixSha assertion is
 * a spot check that it held, not a proof of it.
 */
export function cloneAtBase(repoUrl, baseSha, fixSha, root = DEFAULT_ROOT) {
  const slug = repoUrl.replace(/[^\w.-]+/g, '__');
  const dir = join(root, `${slug}-${baseSha.slice(0, 12)}`);
  const marker = `${dir}.single-commit`;

  // Trust a cache only if this function built it AND the worktree is still what
  // it built: right HEAD, one commit, no local modifications. Anything else is
  // rebuilt, because a mutated worktree contaminates every later arm and repeat.
  let reusable = false;
  if (existsSync(dir) && existsSync(marker)) {
    try {
      reusable =
        readFileSync(marker, 'utf8').trim() === baseSha &&
        git(dir, 'rev-parse', 'HEAD') === baseSha &&
        git(dir, 'rev-list', '--all', '--count') === '1' &&
        git(dir, 'status', '--porcelain') === '';
    } catch { reusable = false; }
  }

  if (!reusable) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(marker, { force: true });
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    execFileSync('git', ['-C', dir, 'fetch', '-q', '--depth', '1', repoUrl, baseSha], { stdio: 'pipe' });
    git(dir, 'checkout', '-q', 'FETCH_HEAD');
    writeFileSync(marker, `${baseSha}\n`);
  }

  let reachable = false;
  try {
    git(dir, 'cat-file', '-e', `${fixSha}^{commit}`);
    reachable = true;
  } catch { /* expected: the fix must not be resolvable */ }
  if (reachable) throw new Error(`Ground-truth leak: ${fixSha} is resolvable from the clone at ${dir}`);

  return dir;
}
```

Note `git fetch --depth 1 <url> <full-sha>` requires the **full** SHA and a
server allowing by-SHA fetch; GitHub does. Abbreviated SHAs fail, which is why
Step 1 records the full `mergeCommit.oid`.

- [ ] **Step 5: Run to verify it passes**

Run: `cd eval && npx vitest run github-cases/__tests__/clone.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 6: Wipe the contaminated cache and switch the runners over**

```bash
rm -rf /tmp/opslane-gheval-repos
```

In each runner:

```js
import { cloneAtBase } from './clone.mjs';
// ...
  const dir = cloneAtBase(`https://github.com/${c.repo}.git`, c.base_sha, c.fix_sha);
```

- [ ] **Step 7: Commit**

```bash
cd eval && npx vitest run && cd ..
git add -A eval/github-cases
git commit -m "fix(eval): clone one commit, so no arm can read the fix out of git history

The clone fetched every ref then checked out the base, leaving the merged fix
reachable. For documenso#2945 one git log --all --grep returned the fix commit
the run was being scored against, so any arm with a shell had the answer.

Cached clones are reused only when HEAD, commit count and cleanliness all still
match what this function built; anything else is rebuilt, since a mutated
worktree contaminates every later arm and repeat."
```

---

## Task 8: Score the first citation, report honestly, run every case

**Files:**
- Create: `eval/github-cases/score.mjs`, `eval/github-cases/__tests__/score.test.mjs`, `eval/github-cases/holdout.json`
- Modify: `eval/github-cases/run-apps.mjs`, `run.mjs`, `run-sdk.mjs`, `packages/worker/src/investigate.ts`

**Interfaces:**
- Consumes: `cloneAtBase` from Task 7; `InvestigationResult.costUsd` from Task 1.
- Produces: `scoreCase(citations, groundTruth)`, `report(results, options)`, `splitFor(repo)` from `./score.mjs`.

- [ ] **Step 1: Write the failing test**

Create `eval/github-cases/__tests__/score.test.mjs`:

```js
import { describe, expect, it } from 'vitest';
import { report, scoreCase, splitFor } from '../score.mjs';

describe('scoreCase', () => {
  const truth = ['packages/ui/signature-render.tsx'];

  it('scores the first citation', () => {
    expect(scoreCase(['packages/ui/signature-render.tsx', 'other.ts'], truth).hit).toBe(true);
  });

  // The prompt asks for every file expected to change and the old scorer counted
  // a hit if ANY matched, so padding the list raised the score for free.
  it('does not count a match found only in a trailing citation', () => {
    expect(scoreCase(['wrong.ts', 'packages/ui/signature-render.tsx'], truth).hit).toBe(false);
  });

  it('matches on a path suffix and strips a line number', () => {
    expect(scoreCase(['signature-render.tsx:42'], truth).hit).toBe(true);
  });

  it('handles no citations', () => {
    expect(scoreCase([], truth)).toEqual({ hit: false, primary: null });
  });
});

describe('report', () => {
  const results = [
    { hit: true, answered: true, strength: 'suggestive', costUsd: 0.5 },
    { hit: false, answered: true, strength: 'insufficient', costUsd: 0.4 },
    { hit: false, answered: false, strength: null, costUsd: 0.1 },
  ];

  it('gives both denominators and separates insufficient from no answer', () => {
    const out = report(results, { total: 3 });

    expect(out).toContain('1/3');
    expect(out).toContain('1/2');
    expect(out).toContain('insufficient: 1');
    expect(out).toContain('no adjudication: 1');
    expect(out).toContain('$1.00');
  });

  // A hit can only come from an answered run; counting otherwise once produced
  // more hits than answered cases.
  it('never reports more hits than answered cases', () => {
    const out = report([{ hit: true, answered: false, strength: null, costUsd: 0 }], { total: 1 });

    expect(out).toContain('0/1 of all cases');
    expect(out).toContain('0/0 of answered');
  });

  it('marks a partial run in the report body, not just a side log', () => {
    expect(report(results, { total: 22 })).toContain('PARTIAL');
  });
});

describe('splitFor', () => {
  it('labels each repository from the frozen manifest', () => {
    expect(splitFor('documenso/documenso')).toBe('holdout');
    expect(splitFor('dubinc/dub')).toBe('tuning');
  });

  it('refuses an unknown repository rather than guessing', () => {
    expect(() => splitFor('acme/unknown')).toThrow(/holdout.json/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd eval && npx vitest run github-cases/__tests__/score.test.mjs`
Expected: FAIL — `Cannot find module '../score.mjs'`.

- [ ] **Step 3: Freeze the split**

Create `eval/github-cases/holdout.json`:

```json
{
  "comment": "Frozen 2026-08-06. Prompts are tuned against `tuning` only. Results on `holdout` are read once per candidate change and never tuned against. With three application repositories this split is weak evidence of generalisation; treat it as a guard against overfitting, not proof of it.",
  "tuning": ["dubinc/dub", "formbricks/formbricks"],
  "holdout": ["documenso/documenso"]
}
```

Add every library repository in `cases.jsonl` to one of the two lists —
`splitFor` throws on an unlisted repository by design, so an unassigned one
fails the run rather than being silently scored.

- [ ] **Step 4: Implement the scorer**

Create `eval/github-cases/score.mjs`:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPLIT = JSON.parse(readFileSync(join(HERE, 'holdout.json'), 'utf8'));

/**
 * Score the FIRST citation only.
 *
 * The prompt asks for every file the fix is expected to touch, and the previous
 * scorer counted a hit when ANY citation matched ANY ground-truth file. Those
 * shipped in the same commit, so lengthening the list raised the expected score
 * without improving diagnosis.
 */
export function scoreCase(citations, groundTruth) {
  const primary = (citations[0] ?? '').split(':')[0].replace(/^\.?\//, '') || null;
  if (!primary) return { hit: false, primary: null };
  const hit = groundTruth.some((f) => f === primary || f.endsWith(`/${primary}`) || primary.endsWith(`/${f}`));
  return { hit, primary };
}

/** Which side of the frozen split a repository is on. Throws if unlisted. */
export function splitFor(repo) {
  if (SPLIT.tuning.includes(repo)) return 'tuning';
  if (SPLIT.holdout.includes(repo)) return 'holdout';
  throw new Error(`${repo} is not assigned in holdout.json; assign it before scoring against it`);
}

/**
 * Both denominators, the failure taxonomy, and cost. Never a bare score.
 *
 * `options.total` is the size of the full corpus, so a subset run says so in the
 * report body. A side log line saying SUBSET can be scrolled past; this cannot.
 */
export function report(results, options = {}) {
  const ran = results.length;
  const total = options.total ?? ran;
  const answered = results.filter((r) => r.answered).length;
  // A hit only counts from an answered run, or hits/answered can exceed 1.
  const hits = results.filter((r) => r.hit && r.answered).length;
  const insufficient = results.filter((r) => r.strength === 'insufficient').length;
  const noAdjudication = ran - answered;
  const cost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  const lines = [];
  if (ran !== total) lines.push(`PARTIAL RUN: ${ran} of ${total} cases. This is not a corpus result.`);
  lines.push(
    `HIT RATE : ${hits}/${ran} of all cases, ${hits}/${answered} of answered`,
    `REFUSALS : insufficient: ${insufficient}  |  no adjudication: ${noAdjudication}`,
    `COST     : $${cost.toFixed(2)} across ${ran} runs, including retried attempts`,
  );
  return lines.join('\n');
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd eval && npx vitest run github-cases/__tests__/score.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 6: Default the runners to every case**

In each runner:

```js
// Default to the whole file. Defaulting to a subset made a 3-of-6 run print a
// summary indistinguishable from a full one.
const only = process.argv[2]
  ? cases.filter((c) => `${c.repo}#${c.issue}` === process.argv[2])
  : process.argv[3] ? cases.slice(0, Number(process.argv[3])) : cases;
```

and pass `{ total: cases.length }` to `report`.

- [ ] **Step 7: Equalise the retry policy across arms**

`run-apps.mjs:36-42` retries ours three times; `run-sdk.mjs` does not retry.
Give both the same policy, and state it in a comment so it is not re-diverged:

```js
// Both arms get the same policy: at most 3 attempts, retried ONLY on a
// transport or rate-limit failure, never on a substantive answer we dislike.
// The LAST attempt supplies the answer; every attempt's cost is counted.
const MAX_ATTEMPTS = 3;
const RETRYABLE = /rate.?limit|overloaded|429|5\d\d|ECONNRESET|ETIMEDOUT/i;

let attemptCost = 0;
let r;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    r = await runOnce();
  } catch (e) {
    r = { outcome: 'THREW', reason: String(e).slice(0, 200) };
  }
  attemptCost += r.costUsd ?? 0;
  const transient = r.outcome === 'THREW' && RETRYABLE.test(r.reason ?? '');
  if (!transient || attempt === MAX_ATTEMPTS) break;
  await new Promise((res) => setTimeout(res, 20_000 * attempt));
}
```

Retrying only on transient transport failures matters: retrying on a
*substantive* answer would let the harness resample until it liked the result.

- [ ] **Step 8: Score, label the split, and record cost**

```js
import { report, scoreCase, splitFor } from './score.mjs';
// ...
  const { hit, primary } = scoreCase(r.adjudication?.cause_locations ?? [], c.ground_truth);
  results.push({
    repo: c.repo, issue: c.issue, split: splitFor(c.repo),
    hit, primary,
    answered: Boolean(r.adjudication?.evidence_strength),
    strength: r.adjudication?.evidence_strength ?? null,
    costUsd: attemptCost,
  });
// ...
console.log(report(results, { total: cases.length }));
console.log(report(results.filter((x) => x.split === 'holdout'), { total: results.filter((x) => x.split === 'holdout').length }));
```

- [ ] **Step 9: Build, test, commit**

```bash
pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test
cd eval && npx vitest run && cd ..
git add -A eval/github-cases packages/worker/src
git commit -m "fix(eval): score the first citation, report both denominators, run every case

Four defects in the instrument that produced this session's numbers. The prompt
asks for every file expected to change and the scorer counted a hit if ANY
citation matched, so padding the list raised the score for free - both shipped
in one commit. The runners defaulted to 3 and 2 cases and a partial summary was
indistinguishable from a full one. Retries were unequal: ours got three attempts
per case and the SDK arm none, in a comparison reported as matched. And hits
were counted over all results rather than answered ones, so hits/answered could
exceed one."
```

---

## Task 9: Re-baseline on the repaired instrument

**This task spends real money against the Anthropic API.**

**Files:**
- Create: `eval/github-cases/baseline-2026-08-06.md`
- Modify: `eval/github-cases/README.md`

**Interfaces:** Consumes Tasks 1, 7 and 8. Produces the recorded baseline.

- [ ] **Step 1: Stop and get explicit approval**

Report to the operator before running anything:

- 22 cases × 3 repeats = **66 investigations**, and the retry policy permits up
  to 3 paid attempts each, so the worst case is **198 model runs**.
- At the observed $0.78/case that is roughly **$50 expected, up to ~$155** if
  every case exhausts its retries.
- Confirm `ANTHROPIC_API_KEY` is set and that the operator approves the spend.

**Do not proceed without an explicit yes.** If approval is withheld, stop here
and report the plan as complete through Task 8.

- [ ] **Step 2: Run three repeats over the full corpus, failing fast**

```bash
cd eval/github-cases
set -e
for i in 1 2 3; do
  node run.mjs      > "/tmp/baseline-lib-$i.log"  2>&1 || { echo "lib repeat $i FAILED"; exit 1; }
  node run-apps.mjs > "/tmp/baseline-apps-$i.log" 2>&1 || { echo "apps repeat $i FAILED"; exit 1; }
done
```

- [ ] **Step 3: Verify each repeat covered every case**

A repeat that silently dropped cases must not be averaged in:

```bash
for i in 1 2 3; do
  echo -n "repeat $i case count: "
  grep -c -E "HIT|MISS" "/tmp/baseline-lib-$i.log" "/tmp/baseline-apps-$i.log" | awk -F: '{s+=$2} END {print s}'
done
```

Expected: `22` for every repeat. Any other number invalidates that repeat;
re-run it rather than recording it.

- [ ] **Step 4: Record the baseline with its provenance**

Create `eval/github-cases/baseline-2026-08-06.md` containing:

- Per repeat and aggregated: hit rate over all cases and over answered cases,
  `insufficient` separate from no-adjudication, and cost.
- The per-case hit-or-miss across all three repeats, so the flip rate is visible.
- Tuning and holdout results reported separately, and a statement that no prompt
  was changed after the holdout numbers were read.
- **Provenance, without which the baseline cannot be reproduced:** the
  implementation commit SHA, `INVESTIGATION_MODEL`, `MAX_TURNS`,
  `INVESTIGATION_BUDGET_USD`, the `cases*.jsonl` commit SHA, and the retry
  outcome and per-attempt cost for every case.

- [ ] **Step 5: Correct the README**

Delete every score in `eval/github-cases/README.md` predating this plan; each
was produced with the leaky clone, the any-citation scorer, partial case sets
and unequal retries. Point at `baseline-2026-08-06.md`.

Record the variance honestly and without contradiction: the earlier five-hits-in-
nine observation on a single case is **not** carried forward as a measurement,
because it came from the broken instrument. State instead that this baseline's
own three repeats are the evidence of run-to-run variance, and quote the flip
rate they show.

- [ ] **Step 6: Commit**

```bash
git add -A eval/github-cases
git commit -m "test(eval): re-baseline on the repaired instrument

Every number from the previous session came from a leaky clone, a scorer that
rewarded padded citation lists, silently partial case sets and unequal retries.
None carry over. This records what the single-agent pipeline scores on 22 cases
with three repeats, with the spread and the provenance visible."
```

---

## Out of scope

- **The Agent SDK migration**, gated on the two-cell comparison.
- **The two-cell comparison** ({our loop, SDK} × single agent).
- **The safety set** (no-actionable-cause, tempting-but-wrong-local, false-authorization scoring), required before the comparison's veto criterion can be evaluated.
- **Tool breadth for the investigation**, which requires a sandbox first.
- **Rebasing onto `origin/main`.** The branch is 3 commits behind, diverged in `tracing.ts`, `logger.ts` and the e2e suite. Do this before opening a PR.

## Known gaps in this plan

- **`bash` is not gated on the fix surface (Task 4).** It can write anywhere in
  the sandbox and no tool-level check covers it. Containment is E2B isolation,
  not the fix surface. Closing this needs either removing `bash` from the fix
  agent or auditing writes after the fact; both are larger than this plan.
- **`assertWritable` narrows the check-to-write window, it does not close it
  (Task 4).** A symlink swapped between the check and the write still wins.
  Closing it needs writes through an `O_NOFOLLOW` descriptor rather than a path.
- **The per-candidate rejection check is textual (Task 3).** It asks whether a
  candidate's statement appears in the rejection text. A model that rewords a
  candidate when rejecting it will fail the check and route to
  `needs_more_context`, which is the safe direction but will produce false
  refusals. Watch the `unrejected_local_candidates` rate in Task 9's baseline.
- **Eval-repair item 2 is half done.** Task 8 equalises retries, but the decision
  document also requires budgeting in **tokens and dollars rather than turns**,
  since a turn is not comparable across differently structured systems. That only
  bites once a second arm exists, so it belongs with the comparison. `MAX_TURNS`
  remains the operating budget after this plan.
- **Whether the adjudicator was miscalibrated or correctly rejecting bad
  dossiers was never settled.** Task 1 retires the split for independent reasons,
  but reading dossiers from the failing runs is cheap and might change how the
  single prompt should be worded.
- **Task 6 Step 5 requires judgement.** Which `TriageResult` fields lose their
  only producer was not enumerated while writing this plan. Enumerate before
  deleting; do not leave a required field nothing sets.
