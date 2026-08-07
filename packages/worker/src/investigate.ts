import type { Adjudication, Diagnosis, DiagnosisOutcome } from '@opslane/shared';
import { deriveOutcome, type DerivedDecision } from './classify.js';
import { parseAdjudication, submitDiagnosisTool } from './diagnose-schema.js';
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
/**
 * Turns are the budget the agent works against, and the number is stated to it
 * in the prompt so it can pace itself. PostHog does the same thing and it is
 * the one an agent can actually count.
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
  /** What the investigation submitted. Null when it submitted nothing usable. */
  adjudication: Adjudication | null;
  /** Built in code from the submitted winner, for the fix agent and the incident. */
  diagnosis: Diagnosis | null;
  outcome: DiagnosisOutcome;
  decisionReason: string;
  /** Why the outcome was reached, as a value. Callers pick reason codes from it. */
  decisionBasis: DerivedDecision['basis'];
  /** Files the agent opened. May contain duplicates. */
  filesRead: string[];
  /** Last model text before the terminal call. Best-effort diagnostic. */
  findings: string;
  /**
   * Model spend for this investigation, including a run that failed before
   * submitting. Carried on every return path: dropping it on failure would
   * undercount exactly the runs the eval most needs to price.
   */
  costUsd: number;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}... [truncated]` : text;
}

/**
 * Neutralise fence-closing tags before text goes inside one.
 *
 * JSON.stringify escapes quotes and backslashes but not the literal
 * `</untrusted_data>`, so a crafted error message quoted into the evidence
 * block would terminate the fence early and the rest would read as
 * instructions. This prompt is what authorises code changes downstream, so
 * this is the boundary that matters.
 */
function fenced(text: string, max: number): string {
  return truncate(text, max).replace(/<\/?untrusted_(data|user_data)>/gi, '[fence]');
}

function runtimeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._+\- ]/g, '').trim().slice(0, 64) || 'unknown';
}

/** The error, its stack and its breadcrumbs, fenced. */
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
 * The one investigation prompt.
 *
 * It carries both jobs the two-agent split used to divide: enumerate the
 * candidate causes, then settle between them from evidence actually read. The
 * instruction that does the work is "enumerate, then settle", not the second
 * model pass. Allowed a single unenumerated answer, the model reliably names
 * the nearest suspicious line of local code and stops looking: on the PR #1297
 * timeout it blamed the timeout constant, and on a server-side rate limit it
 * blamed an unconfigured QueryClient.
 */
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
    adjudication: null,
    diagnosis: null,
    outcome: 'needs_more_context',
    decisionReason: reason,
    decisionBasis: 'no_adjudication',
    filesRead,
    findings,
    costUsd: 0,
  };
}

/**
 * One agent over one repository clone: enumerate the candidate causes and
 * submit the one the evidence supports. Routing is derived in code from the
 * submitted location, the evidence strength and the project's fix surface, so
 * the agent never names an outcome.
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

  const localCandidates = (adjudication?.candidates_considered ?? []).filter(
    (candidate) => candidate.kind === 'local_code' || candidate.kind === 'configuration',
  ).length;
  const decision = deriveOutcome(
    adjudication,
    surface,
    (cited) => resolveInsideRepo(repoPath, cited),
    localCandidates,
  );

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
    'investigation.files_read': filesRead.join(','),
    'investigation.cost_usd': costUsd,
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
    adjudication,
    diagnosis,
    outcome: decision.outcome,
    decisionReason: decision.reason,
    decisionBasis: decision.basis,
    filesRead,
    // Prefer the model's prose, but fall back to the structured reasoning: a
    // terminal tool call may carry no accompanying text at all.
    findings: run.lastModelText || adjudication?.reasoning || '',
    costUsd,
  };
}
