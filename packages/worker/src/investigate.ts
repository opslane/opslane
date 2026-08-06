import type { Adjudication, Diagnosis, DiagnosisOutcome, Dossier } from '@opslane/shared';
import { deriveOutcome, type DerivedDecision } from './classify.js';
import { adjudicateTool, parseAdjudication, parseDossier, submitDossierTool } from './dossier-schema.js';
import { resolveInsideRepo, type FixSurface } from './fix-surface.js';
import { extractStackTraceFiles } from './harness/stack-trace-utils.js';
import { logger } from './logger.js';
import type { Platform } from './platform.js';
import { runReadOnlyAgent, type ReadOnlyStop } from './readonly-agent.js';
import type { RuntimeInfo } from './runtime-info.js';
import { traceSpan } from './tracing.js';
import type { TriageResult } from './agent-fix.js';

export { executeListFiles, executeReadFile, executeSearch, safePath } from './investigate-tools.js';

const INVESTIGATION_MODEL = process.env['INVESTIGATION_MODEL'] ?? 'claude-sonnet-5';
const MAX_TURNS = Number(process.env['INVESTIGATION_MAX_TURNS'] ?? 10);
const ADJUDICATION_MAX_TURNS = Number(process.env['ADJUDICATION_MAX_TURNS'] ?? 8);
/**
 * Turns are the budget the agents work against, and the number is stated to
 * them in the prompt so they can pace themselves. PostHog does the same thing
 * and it is the one an agent can actually count.
 *
 * The dollar figure below is a runaway backstop, not the operating limit. It
 * was the binding constraint before, calibrated against a four-file fixture,
 * and it fired on real monorepos: dub and formbricks runs died with "exceeded
 * its budget" while the agents were still reading files they needed. A cap
 * that stops correct work is not a safety feature.
 */
const DEFAULT_SPEND_CEILING_USD = 2.0;
const MAX_ERROR_MESSAGE = 500;
const MAX_STACK_TRACE = 3000;
const MAX_BREADCRUMBS = 4000;

const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-sonnet-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
};
const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };

export interface InvestigateInput {
  platform?: Platform;
  customerRuntime?: RuntimeInfo | null;
  errorType: string;
  title: string;
  errorMessage: string;
  stackTrace: string;
  resolvedStackTrace: unknown;
  breadcrumbs: string;
}

export interface InvestigationResult extends TriageResult {
  /** Every candidate the first agent found. Null when it produced nothing usable. */
  dossier: Dossier | null;
  /** The second agent's verdict on that dossier. Null when adjudication failed. */
  adjudication: Adjudication | null;
  /** Built in code from the adjudicated winner, for the fix agent and the incident. */
  diagnosis: Diagnosis | null;
  outcome: DiagnosisOutcome;
  decisionReason: string;
  /** Why the outcome was reached, as a value. Callers pick reason codes from it. */
  decisionBasis: DerivedDecision['basis'];
  /** Files opened by either agent. May contain duplicates. */
  filesRead: string[];
  /** Last model text before the terminal call. Best-effort diagnostic. */
  findings: string;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}... [truncated]` : text;
}

/**
 * Neutralise fence-closing tags before text goes inside one.
 *
 * JSON.stringify escapes quotes and backslashes but not the literal
 * `</untrusted_data>`, so a crafted error message quoted into a dossier's
 * supporting evidence would terminate the adjudicator's fence early and the
 * rest would read as instructions. The adjudicator is the component that
 * authorises code changes, so this is the boundary that matters.
 */
function fenced(text: string, max: number): string {
  return truncate(text, max).replace(/<\/?untrusted_(data|user_data)>/gi, '[fence]');
}

function runtimeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._+\- ]/g, '').trim().slice(0, 64) || 'unknown';
}

/** The error, its stack and its breadcrumbs, fenced. Both agents see the same block. */
function evidenceBlock(input: InvestigateInput): string {
  const python = input.platform === 'python';
  const resolved = input.resolvedStackTrace
    ? `\n\nResolved Stack Trace (source-mapped):\n<untrusted_data>\n${fenced(JSON.stringify(input.resolvedStackTrace), MAX_STACK_TRACE)}\n</untrusted_data>`
    : '';
  return `## Error
Type: ${input.errorType}
Title: ${input.title}

Customer runtime (untrusted metadata):
<untrusted_data>
${input.customerRuntime ? `${runtimeLabel(input.customerRuntime.name)} ${runtimeLabel(input.customerRuntime.version)}` : 'unknown'}
</untrusted_data>

Message:
<untrusted_data>
${fenced(input.errorMessage, MAX_ERROR_MESSAGE)}
</untrusted_data>

Stack Trace:
<untrusted_data>
${fenced(input.stackTrace, MAX_STACK_TRACE)}
</untrusted_data>${resolved}

Breadcrumbs, every one, with timestamps:
<untrusted_data>
${fenced(input.breadcrumbs || '[]', MAX_BREADCRUMBS)}
</untrusted_data>

${python
    ? 'Follow the traceback newest-first and use exact repository paths. Python runs do not use browser source maps.'
    : 'If a Resolved Stack Trace is present, prefer it: it carries source-mapped paths.'}`;
}

/**
 * Agent 1. Compiles candidates, chooses nothing.
 *
 * The instruction that does the work is "list every cause", not any framework
 * knowledge. Allowed a single answer, the model reliably names the nearest
 * suspicious line of local code and stops looking: on the PR #1297 timeout it
 * blamed the timeout constant, and on a server-side rate limit it blamed an
 * unconfigured QueryClient. Forced to produce several candidates it goes and
 * reads the backend instead.
 */
function dossierSystemPrompt(input: InvestigateInput): string {
  const python = input.platform === 'python';
  return `You are a diagnostician compiling an evidence dossier for a production ${python ? 'Python' : 'JavaScript/browser'} error.

You are NOT fixing anything, and you are NOT deciding what happens next. Another reviewer does that.
Your only job is to list every cause the evidence is consistent with, and the evidence for and against each.

Rules:
- List every plausible cause, not the first one you find. Include causes outside this codebase: a slow or failing remote service, a rate limiter, bad input data, an infrastructure fault.
- Code being involved in producing the error does not make it the cause. The code that observes a failure is rarely the code that caused it. A configuration value that bounds a failure is not the reason the failure happened.
- Every entry in "supports" must quote evidence you actually observed: a breadcrumb field and its value, the span between two timestamps, a stack frame, or a file and line you opened. Never write supporting evidence you did not see.
- Look for evidence that contradicts each hypothesis, hardest against the one you find most convincing. Check timestamps before claiming anything about repetition, retries or bursts: requests minutes apart are not a retry loop.
- Reading is not fixing. Open code anywhere in the repository that helps you explain what happened, including code you would never change.
- If two causes explain the evidence equally well, list both. Separating them is not your job.
- Do not pad the list. A hypothesis you cannot support with observed evidence is worse than one fewer hypothesis.

${evidenceBlock(input)}`;
}

/**
 * Agent 2. Judges the dossier against evidence it re-opens itself.
 *
 * Separate from agent 1 so the check is not performed by the author of the
 * claim. It is the only component that verifies a citation before the pipeline
 * acts on it.
 */
function adjudicationSystemPrompt(input: InvestigateInput, dossier: Dossier): string {
  return `You are adjudicating an evidence dossier compiled by a diagnostician for a production error.

Decide which hypothesis the evidence actually supports, and how strong that evidence is. Do not decide what the pipeline should do about it.

Rules:
- Check the citations. You can read the repository. When a hypothesis cites a file and line, open it and confirm it says what the dossier claims. Name anything that does not check out.
- Check every claim about repetition, retries or bursts against the actual timestamps in the breadcrumbs. If the timing does not support the claim, reject it and say so.
- "insufficient" means the evidence cannot separate your candidates: two or more are equally supported and you cannot rank them. It does not mean you are less than certain. If one hypothesis is better supported than the rest, name it and rate the evidence "suggestive". Refusing to choose when you can choose sends a human a list instead of an answer.
- Distinguish the cause from a code smell. Code that handles a failure badly is not the reason the failure occurred.
- Rate the evidence honestly. Reserve "conclusive" for a conclusion whose every premise you verified from evidence you read. If a decisive premise rests on runtime state you cannot observe, such as a query plan, index, table size, deployed configuration or backend load, the most you may answer is "suggestive".
- Report every place the cause lives. A fix often touches more than one file; list each one you would expect to change, most important first. Do not decide whether we are allowed to change them.

${evidenceBlock(input)}

## Dossier
<untrusted_data>
${fenced(JSON.stringify(dossier, null, 1), 12_000)}
</untrusted_data>`;
}

/** Every non-terminal exit is an execution failure, never a finding. */
function stopReason(stop: ReadOnlyStop, stage: string): string {
  switch (stop) {
    case 'budget':
      return `${stage} exceeded its budget`;
    case 'api_error':
      return `${stage} could not reach the model`;
    case 'no_tool_call':
      return `${stage} ended without submitting`;
    case 'turns_exhausted':
      return `${stage} ran out of turns`;
    default:
      return `${stage} did not complete`;
  }
}

function failed(reason: string, filesRead: string[], findings: string): InvestigationResult {
  return {
    fixable: false,
    confidence: 'low',
    reason,
    dossier: null,
    adjudication: null,
    diagnosis: null,
    outcome: 'needs_more_context',
    decisionReason: reason,
    decisionBasis: 'no_adjudication',
    filesRead,
    findings,
  };
}

/**
 * Two agents over one repository clone: compile every candidate cause, then
 * adjudicate them against re-verified evidence. Routing is derived in code from
 * the adjudicated location, the evidence strength and the project's fix
 * surface, so neither agent names an outcome.
 */
export async function investigateError(
  apiKey: string,
  input: InvestigateInput,
  repoPath: string,
  surface: FixSurface,
): Promise<InvestigationResult> {
  const pricing = MODEL_PRICING[INVESTIGATION_MODEL] ?? DEFAULT_PRICING;
  const spendCeilingUsd = Number(process.env['INVESTIGATION_BUDGET_USD'] ?? DEFAULT_SPEND_CEILING_USD);
  const stackFiles = extractStackTraceFiles(input.stackTrace, input.platform);
  const hints = stackFiles.length > 0
    ? `\n\nFiles named by the stack trace, as a starting point only: ${stackFiles.slice(0, 5).join(', ')}`
    : '';

  const first = await traceSpan('investigation.dossier', { 'investigation.stage': 'dossier' }, () =>
    runReadOnlyAgent({
      apiKey,
      model: INVESTIGATION_MODEL,
      maxTurns: MAX_TURNS,
      budgetUsd: spendCeilingUsd,
      pricing,
      systemPrompt: dossierSystemPrompt(input),
      firstMessage:
        `Compile the dossier for this error, then call submit_dossier. You have about ` +
        `${MAX_TURNS} tool calls. Spend them on the files that decide between your ` +
        `candidates, and submit what the evidence supports rather than running out.${hints}`,
      terminalTool: submitDossierTool(),
      repoPath,
      spanPrefix: 'dossier',
    }));

  if (first.stop !== 'terminal') {
    return failed(stopReason(first.stop, 'Dossier compilation'), first.filesRead, first.lastModelText);
  }
  const dossier = parseDossier(first.terminalInput ?? {});
  if (!dossier) {
    // Log what was actually submitted. This failure means every hypothesis was
    // dropped for want of a statement or supporting evidence, and without the
    // payload there is no way to tell a model that answered badly from a schema
    // the model could not satisfy. Runs were flapping between this and a good
    // answer with nothing recorded to distinguish them.
    logger.warn('Dossier held no supported hypothesis', {
      submitted: JSON.stringify(first.terminalInput ?? {}).slice(0, 2000),
      filesRead: first.filesRead.length,
    });
    return failed('The dossier contained no supported hypothesis', first.filesRead, first.lastModelText);
  }

  const second = await traceSpan(
    'investigation.adjudicate',
    { 'investigation.stage': 'adjudicate', 'dossier.hypotheses': dossier.hypotheses.length },
    () =>
      runReadOnlyAgent({
        apiKey,
        model: INVESTIGATION_MODEL,
        maxTurns: ADJUDICATION_MAX_TURNS,
        budgetUsd: Math.max(spendCeilingUsd - first.costUsd, spendCeilingUsd * 0.3),
        pricing,
        systemPrompt: adjudicationSystemPrompt(input, dossier),
        firstMessage:
          `Adjudicate the dossier. Verify the citations before you trust them, and check any ` +
          `claim about repetition against the timestamps. You have about ${ADJUDICATION_MAX_TURNS} ` +
          `tool calls: open the files the winning hypothesis rests on first. Then call adjudicate.`,
        terminalTool: adjudicateTool(),
        repoPath,
        spanPrefix: 'adjudicate',
      }));

  const filesRead = [...first.filesRead, ...second.filesRead];
  if (second.stop !== 'terminal') {
    const result = failed(stopReason(second.stop, 'Adjudication'), filesRead, second.lastModelText || first.lastModelText);
    return { ...result, dossier };
  }

  const adjudication = parseAdjudication(second.terminalInput ?? {});
  const localCandidates = dossier.hypotheses.filter(
    (hypothesis) => hypothesis.kind === 'local_code' || hypothesis.kind === 'configuration',
  ).length;
  const decision = deriveOutcome(
    adjudication,
    surface,
    (cited) => resolveInsideRepo(repoPath, cited),
    localCandidates,
  );

  // Match the glob against the resolved path, never the cited string: a symlink
  // inside the surface pointing outside it would otherwise authorise the write.
  const diagnosis: Diagnosis | null = adjudication
    ? {
      one_line_description: adjudication.best_supported,
      why_chain: adjudication.why_chain,
      reproduction_steps: adjudication.reproduction_steps,
      cause_location: adjudication.cause_locations.join(', '),
    }
    : null;

  await traceSpan('investigation.decision', {
    'investigation.outcome': decision.outcome,
    'investigation.confidence': decision.confidence,
    'investigation.strength': adjudication?.evidence_strength ?? 'none',
    'investigation.cause_location': adjudication?.cause_locations.join(', ') ?? '',
    'investigation.hypotheses': dossier.hypotheses.length,
    'investigation.files_read': filesRead.join(','),
    'investigation.cost_usd': Number((first.costUsd + second.costUsd).toFixed(4)),
  }, async () => undefined);

  if (decision.outcome === 'code_fix' && surface.globs === null) {
    logger.warn('Fix authorised with no fix surface configured: the whole repository is writable', {
      cause_location: adjudication?.cause_locations.join(', '),
    });
  }

  return {
    fixable: decision.outcome === 'code_fix',
    confidence: decision.confidence,
    reason: decision.reason,
    dossier,
    adjudication,
    diagnosis,
    outcome: decision.outcome,
    decisionReason: decision.reason,
    decisionBasis: decision.basis,
    filesRead,
    findings: second.lastModelText || first.lastModelText,
  };
}
