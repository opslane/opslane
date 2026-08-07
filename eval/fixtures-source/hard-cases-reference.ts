/**
 * Two synthetic cases survive the real-bug corpus.
 *
 * hard-h1-timeout is the PR #1297 regression control: a request timeout that
 * must never be routed to a code fix. hard-h4-control-server-ratelimit is the
 * non-actionable control. Everything else was deleted because calibrations made
 * against four-file toy repositories were wrong on every real one: the turn
 * budget, the claim nothing reaches "conclusive", and the H4 case that had to be
 * rebuilt. See docs/design/2026-08-06-harness-decision.md.
 *
 * Reference only: this file is the source data for eval/cases/hard-*, kept so
 * the surviving fixtures can be regenerated. It is not built or tested.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { investigateError, type InvestigationVariant } from './src/investigate.js';

const apiKey = process.env['ANTHROPIC_API_KEY'];
if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

const REPO =
  '/tmp/claude-1000/-home-claude-dev-orca-workspaces-opslane-oss-agent-improvement/a931964d-15eb-4c99-9d73-a5608dc18034/scratchpad/customer-repo';
const RUNS = Number(process.env['RUNS'] ?? 3);
const CONCURRENCY = 6;
const HOST = 'https://api.assetmanagementforjira.com/issue-context';

const crumb = (m: string, d: Record<string, unknown>, level = 'error') =>
  ({ type: 'fetch', category: 'fetch', level, message: m, data: d });

interface Case {
  key: string; want: 'code_fix' | 'conclusion'; wantStep: 'internal_code' | 'external_system';
  why: string; input: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    key: 'H1-timeout-slow-backend', want: 'conclusion', wantStep: 'external_system',
    why: 'PR #1297. Frontend timeout is doing its job; the server is slow.',
    input: {
      errorType: 'TimeoutError', errorMessage: 'signal timed out',
      title: 'TimeoutError: signal timed out',
      stackTrace: 'TimeoutError: signal timed out\n    --- synthetic caller stack ---\n    at Be (https://api.assetmanagementforjira.com/issue-context/assets/index-B6qDSk_y.js:5:194)',
      breadcrumbs: JSON.stringify([
        crumb(`GET ${HOST}/api/assets/search?projectId=10042`, { method: 'GET', url: `${HOST}/api/assets/search?projectId=10042`, error: 'signal timed out' }),
      ]),
    },
  },
];

const OUTCOME = {
  outcome: {
    type: 'string', enum: ['code_fix', 'needs_human_investigation', 'not_actionable'],
    description:
      'code_fix = changing code in THIS repository would remove the cause. needs_human_investigation = the cause is real and identified but lies outside this repository (a slow or failing service, infrastructure, a third party), so a human should act on the diagnosis. This is a SUCCESSFUL, valuable outcome, not a failure. not_actionable = no real problem here (a deliberate test throw, noise).',
  },
} as const;

const TIMELINE = {
  root_cause_timeline: {
    type: 'array',
    description: 'The causal chain from the entry point of the code to the error. Build this BEFORE deciding the classification.',
    items: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What happened at this step, as a complete sentence.' },
        step_type: { type: 'string', enum: ['internal_code', 'external_system', 'human_action'],
          description: 'internal_code = logic in this repository. external_system = something outside this repository behaved a certain way. human_action = a user did something.' },
        evidence: { type: 'string', description: 'File/line or data supporting this step.' },
        is_most_important: { type: 'boolean', description: 'True for the ONE step that actually produced the failure.' },
      },
      required: ['title', 'step_type', 'evidence', 'is_most_important'],
    },
  },
} as const;

const BASE = {
  confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Confidence based on codebase evidence found' },
  reason: { type: 'string', description: 'Brief explanation citing specific files/code found' },
  reason_code: { type: 'string', enum: ['unfixable_no_app_frames', 'unfixable_test_error', 'unfixable_third_party', 'unfixable_infra', 'unfixable_no_sourcemap'], description: 'Machine-readable code when not fixable' },
  remediation: { type: 'string', description: 'What the human should do. Be specific.' },
} as const;

const tool = (props: Record<string, unknown>, req: string[]): Anthropic.Tool => ({
  name: 'classify_error',
  description: 'Submit your investigation classification. Call this when you have enough evidence.',
  input_schema: { type: 'object' as const, properties: props, required: req },
});

const OUTCOME_V5 = {
  outcome: {
    type: 'string', enum: ['code_fix', 'needs_human_investigation', 'not_actionable'],
    description:
      'Decide by CAUSE, not by where the error surfaced. code_fix = changing code in THIS repository would remove the cause. This includes cases where the immediate symptom is an error returned by an external service but the behaviour of code in this repository provoked it. needs_human_investigation = the cause itself lies outside this repository and no change here would remove it (a service is genuinely slow or failing on its own, infrastructure, a third party), so a human should act on the diagnosis. This is a SUCCESSFUL, valuable outcome, not a failure. not_actionable = no real problem here (a deliberate test throw, noise).',
  },
} as const;

// V6 = V4 plus the two ideas from Seer/PostHog: tell the model its budget, and
// give it an honest place to land when it runs out (PostHog's "mark it unverified
// and move on"). The escape hatch is scored separately so we can see if it gets abused.
const OUTCOME_V6 = {
  outcome: {
    type: 'string', enum: ['code_fix', 'needs_human_investigation', 'not_actionable', 'insufficient_evidence'],
    description:
      'code_fix = changing code in THIS repository would remove the cause. needs_human_investigation = the cause is real and identified but lies outside this repository (a slow or failing service, infrastructure, a third party), so a human should act on the diagnosis. This is a SUCCESSFUL, valuable outcome, not a failure. not_actionable = no real problem here (a deliberate test throw, noise). insufficient_evidence = you could not establish what caused the error within your budget. Say plainly what you were unable to determine. Prefer this over guessing.',
  },
} as const;

const V6_BUDGET_STEP = `4. Budget: you have a limited number of tool calls. Aim to finish well inside it.
   If you cannot establish what caused the error within your budget, call classify_error
   with outcome "insufficient_evidence" and state plainly what you could not determine.
   Do not guess.
`;

// ---- V7: steer, don't just budget ----------------------------------------
// Three things Seer and PostHog have in their prompts that ours does not:
//
//  1. A STOP CONDITION. Seer: "Once you can see evidence of the true root cause
//     that would satisfy the USER, you may stop." Ours never says when to stop,
//     so at 40 turns it keeps surveying and keeps finding new candidate causes.
//  2. An EVIDENCE BAR. PostHog names the evidence types required (code + data,
//     cross-referenced). Ours asks a yes/no: "does it originate from app code".
//  3. REPO ORIENTATION. Seer passes <available_repos>; PostHog states what is on
//     disk. Ours says nothing, so the agent discovers the monorepo at turn 25 and
//     re-frames its answer around whatever it found last.
//
// (3) is deterministic — we can just read the top-level layout and tell it.
import { readdirSync as _rd } from 'node:fs';
function repoOrientation(root: string): string {
  const tops = _rd(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => e.name).sort();
  return `## What is in this repository

Top-level directories: ${tops.join(', ')}

This repository may contain more than one deployable component (for example a
frontend and the backend it calls). Establish which component the failing code
belongs to before you classify. Do not assume the repository is only the component
the stack trace points at, and do not assume a service named in a URL is external
until you have checked whether its source is here.`;
}

const V7_STEP = `4. Stop when you have evidence, not when you run out of places to look. You are
   done when you can name the single thing that produced this error and point at the
   evidence for it. The moment you can, call classify_error. Do not keep surveying for
   alternative explanations you have no evidence for.
5. Before classifying you need: (a) the failing call site, (b) what it was doing when
   it failed, (c) the one step in the chain that produced the failure, and (d) if the
   breadcrumbs name a request, which endpoint it was. If you have those, you are done.
`;

// ---- V8: V7 plus the repo's own for-agents docs ---------------------------
// The customer already wrote the architecture down for agents: AGENTS.md and
// CLAUDE.md at the root, plus a CLAUDE.md per component. Their root AGENTS.md
// names the Flask backend at server/ and each frontend by path. We clone the repo
// and never open them. PostHog's setup agent reads exactly this set
// (AGENTS.md, CLAUDE.md, ARCHITECTURE.md, .cursor/rules) as "for-agents context".
import { readFileSync as _rf, existsSync as _ex } from 'node:fs';
import { join as _join } from 'node:path';

const AGENT_DOC_NAMES = ['AGENTS.md', 'CLAUDE.md', 'ARCHITECTURE.md', '.cursorrules'];
const AGENT_DOC_BUDGET = 12_000;

function agentDocs(root: string): string {
  const parts: string[] = [];
  let spent = 0;
  for (const name of AGENT_DOC_NAMES) {
    const full = _join(root, name);
    if (!_ex(full)) continue;
    let body = '';
    try { body = _rf(full, 'utf8'); } catch { continue; }
    const room = AGENT_DOC_BUDGET - spent;
    if (room <= 0) break;
    const slice = body.length > room ? body.slice(0, room) + '\n... [truncated]' : body;
    spent += slice.length;
    parts.push(`### ${name}\n${slice}`);
  }
  // Point at the per-component docs without paying for their contents.
  const nested = _rd(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .flatMap((d) => AGENT_DOC_NAMES
      .filter((n) => _ex(_join(root, d.name, n)))
      .map((n) => `${d.name}/${n}`));
  if (nested.length) parts.push(`### Per-component docs available to read\n${nested.join('\n')}`);
  if (!parts.length) return '';
  return `## The repository's own documentation for agents

The maintainers wrote these for tools like you. Treat them as authoritative about how
this repository is laid out, which components exist, and which one owns what.

${parts.join('\n\n')}`;
}

const ARMS: { key: string; variant?: InvestigationVariant }[] = [
  { key: 'V0-baseline' },
  { key: 'V3-outcome', variant: { classifyTool: tool({ ...OUTCOME, ...BASE }, ['outcome', 'confidence', 'reason', 'remediation']) } },
  { key: 'V4-outcome+timeline', variant: { classifyTool: tool({ ...TIMELINE, ...OUTCOME, ...BASE }, ['root_cause_timeline', 'outcome', 'confidence', 'reason', 'remediation']) } },
  { key: 'V5-cause-direction', variant: { classifyTool: tool({ ...TIMELINE, ...OUTCOME_V5, ...BASE }, ['root_cause_timeline', 'outcome', 'confidence', 'reason', 'remediation']) } },
  { key: 'V6-budget+landing', variant: { extraStrategyStep: V6_BUDGET_STEP, classifyTool: tool({ ...TIMELINE, ...OUTCOME_V6, ...BASE }, ['root_cause_timeline', 'outcome', 'confidence', 'reason', 'remediation']) } },
  { key: 'V7-steered', variant: {
      extraStrategyStep: V7_STEP,
      classificationRules: `${repoOrientation(REPO)}

## Classification Rules
Set the outcome by asking what would have to change for this error to stop happening.
- If that change is to code in this repository, outcome is code_fix. This includes code
  in any component of this repository, not only the one the stack trace names.
- If that change is outside this repository (a third party, a service whose source is not
  here, infrastructure), outcome is needs_human_investigation. That is a successful result.
- A deliberate test throw is not_actionable.`,
      classifyTool: tool({ ...TIMELINE, ...OUTCOME, ...BASE }, ['root_cause_timeline', 'outcome', 'confidence', 'reason', 'remediation']) } },
  { key: 'V8-steered+docs', variant: {
      extraStrategyStep: V7_STEP,
      classificationRules: `${agentDocs(REPO)}

${repoOrientation(REPO)}

## Classification Rules
Set the outcome by asking what would have to change for this error to stop happening.
- If that change is to code in this repository, outcome is code_fix. This includes code
  in any component of this repository, not only the one the stack trace names.
- If that change is outside this repository (a third party, a service whose source is not
  here, infrastructure), outcome is needs_human_investigation. That is a successful result.
- A deliberate test throw is not_actionable.`,
      classifyTool: tool({ ...TIMELINE, ...OUTCOME, ...BASE }, ['root_cause_timeline', 'outcome', 'confidence', 'reason', 'remediation']) } },
];

// Band-aid language in the investigation's OWN remediation. That field is forwarded
// into the fix agent's prompt, so a band-aid here becomes an instruction downstream.
const BANDAID = /increase the timeout|raise the timeout|longer timeout|bump the timeout|increase FETCH_TIMEOUT|add a try\/catch|wrap .{0,20}in a try|catch (the |and )?(TimeoutError|DOMException|the error).{0,40}(swallow|ignore|suppress|show)|swallow|suppress the error|silently/i;

interface Row { arm: string; key: string; want: string; got: string; ok: boolean; step: string; stepOk: boolean | null; bandaid: boolean; rem: string }
const jobs: (() => Promise<Row>)[] = [];
const ONLY_C = process.env['ONLY_CASES']?.split(',');
const ONLY_A = process.env['ONLY_ARMS']?.split(',');
for (const arm of ARMS.filter(a=>!ONLY_A||ONLY_A.includes(a.key))) for (const c of CASES.filter(x=>!ONLY_C||ONLY_C.includes(x.key))) for (let i = 0; i < RUNS; i++) jobs.push(async () => {
  const base = { arm: arm.key, key: c.key, want: c.want };
  try {
    const r = await investigateError(apiKey!, c.input as never, REPO, arm.variant);
    if (['Investigation budget exceeded', 'Investigation did not produce classification', 'Investigation API call failed'].includes(r.reason ?? '')) {
      return { ...base, got: 'INVALID', ok: false, step: '', stepOk: null, bandaid: false, rem: r.reason ?? '' };
    }
    const raw = r.raw;
    const oc = raw?.['outcome'];
    const got = !arm.variant
      ? (r.fixable ? 'code_fix' : 'conclusion')
      : oc === 'code_fix' ? 'code_fix'
      : oc === 'insufficient_evidence' ? 'insufficient'
      : 'conclusion';
    const rawTl = raw?.['root_cause_timeline'];
    const tl = (Array.isArray(rawTl) ? rawTl : []) as { step_type: string; is_most_important: boolean; title: string }[];
    const key = tl.find((e) => e.is_most_important) ?? tl[tl.length - 1];
    const rem = r.remediation ?? '';
    return {
      ...base, got, ok: got === c.want,
      step: key?.step_type ?? '', stepOk: key ? key.step_type === c.wantStep : null,
      bandaid: BANDAID.test(rem), rem: rem.slice(0, 190),
    };
  } catch (e) {
    return { ...base, got: 'ERROR', ok: false, step: '', stepOk: null, bandaid: false, rem: e instanceof Error ? e.message.slice(0, 100) : String(e) };
  }
});

const rows: Row[] = [];
let cur = 0;
async function w(): Promise<void> {
  while (cur < jobs.length) {
    const r = await jobs[cur++]();
    rows.push(r);
    process.stdout.write(`  [${rows.length}/${jobs.length}] ${r.arm.padEnd(20)} ${r.key.padEnd(26)} ${r.got.padEnd(11)} ${r.ok ? 'ok ' : 'MISS'}${r.bandaid ? ' BANDAID' : ''}\n`);
  }
}
console.log(`${jobs.length} investigations: ${ARMS.length} arms x ${CASES.length} cases x ${RUNS} runs\n`);
await Promise.all(Array.from({ length: CONCURRENCY }, () => w()));

const pad = (s: string, n: number) => s.padEnd(n);
console.log('\n\n============ VERDICT ============\n');
const AC = CASES.filter(x=>!ONLY_C||ONLY_C.includes(x.key)), AA = ARMS.filter(a=>!ONLY_A||ONLY_A.includes(a.key));
console.log(pad('arm', 22) + AC.map((c) => pad(c.key.split('-')[0], 7)).join('') + 'total');
for (const a of AA) {
  let l = pad(a.key, 22), t = 0;
  for (const c of AC) {
    const m = rows.filter((r) => r.arm === a.key && r.key === c.key);
    const g = m.filter((r) => r.ok).length; t += g;
    l += pad(`${g}/${m.length}`, 7);
  }
  console.log(l + `${t}/${AC.length * RUNS}`);
}

console.log('\n============ ESCAPE-HATCH USE (insufficient_evidence) ============\n');
for (const a of AA) {
  const m = rows.filter((r) => r.arm === a.key && r.got !== 'INVALID' && r.got !== 'ERROR');
  const n = m.filter((r) => r.got === 'insufficient').length;
  console.log(`${pad(a.key, 22)} ${n}/${m.length}`);
}

console.log('\n============ DIAGNOSIS: decisive step typed correctly (V4 only) ============\n');
for (const c of CASES) {
  const m = rows.filter((r) => r.arm === 'V4-outcome+timeline' && r.key === c.key && r.stepOk !== null);
  console.log(`${pad(c.key, 26)} want ${pad(c.wantStep, 16)} ${m.filter((r) => r.stepOk).length}/${m.length}`);
}

console.log('\n============ BAND-AID IN THE INVESTIGATION\'S OWN REMEDIATION ============');
console.log('(this text is forwarded to the fix agent as "Suggested mitigation")\n');
for (const a of ARMS) {
  const m = rows.filter((r) => r.arm === a.key && r.got !== 'INVALID' && r.got !== 'ERROR');
  console.log(`${pad(a.key, 22)} ${m.filter((r) => r.bandaid).length}/${m.length}`);
}

console.log('\n============ MISSES + BAND-AID SAMPLES ============');
for (const r of rows.filter((x) => !x.ok || x.bandaid)) {
  console.log(`\n${r.arm} | ${r.key} want=${r.want} got=${r.got}${r.bandaid ? ' [BANDAID]' : ''}${r.step ? ` step=${r.step}` : ''}`);
  console.log(`   ${r.rem}`);
}
