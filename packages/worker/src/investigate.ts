import type { Adjudication, Diagnosis, DiagnosisOutcome, EvidenceCitation } from '@opslane/shared';
import { deriveOutcome, type DerivedDecision } from './classify.js';
import { parseAdjudication, submitDiagnosisTool } from './diagnose-schema.js';
import { MachineUnavailableError } from './harness/errors.js';
import { extractStackTraceFiles } from './harness/stack-trace-utils.js';
import type { RepoReader } from './investigate-tools.js';
import { logger } from './logger.js';
import { fenced } from './prompt-fence.js';
import type { Platform } from './platform.js';
import { runReadOnlyAgentSdk, type ReadOnlyStop, type TokenUsage } from './harness/sdk-agent.js';
import type { RuntimeInfo } from './runtime-info.js';
import { traceSpan } from './tracing.js';
import type { TriageResult } from './agent-fix.js';
import { calculateCost } from '@opslane/agent-core';
import { resubmitGuidance, validateAdjudicationShape, validateVerdict } from './verdict-validation.js';
import { quoteWithinWindow } from './quote-at.js';

/**
 * The model the investigation actually runs on.
 *
 * Exported because the decision row records which model produced the decision,
 * and that row is immutable. index.ts previously re-derived it with its own
 * default, so an unset INVESTIGATION_MODEL wrote a permanent claim that a
 * different model ran than the one that did.
 */
export const INVESTIGATION_MODEL = process.env['INVESTIGATION_MODEL'] ?? 'claude-sonnet-5';

/**
 * Files above this size are never quote-grounded. Mirrors executeReadFile's
 * bounded-read rationale: the model picks the cited path, and a minified
 * vendor bundle can be hundreds of megabytes.
 */
const QUOTE_CHECK_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Ceiling on paths probed for existence in one submission. */
const MAX_PROBED_CITATIONS = 100;
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
// Sized for the compact frozen-evidence summary (top-N'd lists, clamped
// fields), not for raw session JSON; at 500 the summary's tail was cut.
const MAX_SESSION_CONTEXT = 2000;
const MAX_INVESTIGATION_BRIEF = 1000;

export const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  // Sonnet 5's introductory rate, $2/$10, runs through 2026-08-31. List is
  // $3/$15. Every eval cost figure is computed from this table, so the list
  // price overstated what the runs actually cost by half.
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.50, cacheRead: 0.20 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
};
export const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };

export interface InvestigateInput {
  platform?: Platform;
  customerRuntime?: RuntimeInfo | null;
  errorType: string;
  title: string;
  errorMessage: string;
  stackTrace: string;
  resolvedStackTrace: unknown;
  breadcrumbs: string;
  /**
   * One-line session facts from the analyzer, or null when the session was
   * never analyzed. Its own field, not appended to `breadcrumbs`: the
   * breadcrumb budget truncates head-first, so a concatenated context line is
   * silently dropped on exactly the busy sessions it exists to explain.
   */
  sessionContext?: string | null;
  /** Inquiry-authored starting point carried on the durable work-round job. */
  investigationBrief?: string | null;
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
  /** Grounded routing disposition for each local candidate, when using the new shape. */
  dispositions?: DerivedDecision['dispositions'];
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
  /**
   * Token counts for the run, cache reads and writes separated. Carried so the
   * cache-hit rate is observable: `costUsd` alone cannot say whether prompt
   * caching is working.
   */
  usage: TokenUsage;
  /**
   * How the agent loop ended. `terminal` is the only one that produced an
   * answer; the rest are execution failures.
   *
   * Exposed because the caller cannot otherwise tell a rate limit from a
   * refusal: the loop catches transport errors and returns `api_error`, which
   * this function converts to `needs_more_context`. The eval runners retried
   * only on a thrown exception, so a 429 was scored as the agent declining to
   * answer, and the retry policy that is supposed to match the arms never fired
   * on ours.
   */
  stop: ReadOnlyStop;
  /** HTTP status of the failed model call when stop is 'api_error', when known.
   * 4xx (except 408/429) marks a deterministic request-construction failure —
   * an operator bug retries cannot fix; the rest are transient. */
  apiErrorStatus?: number;
  /** Failure message of the model call when stop is 'api_error'. */
  apiErrorDetail?: string;
  evidence: EvidenceCitation[];
  agentTaskBrief: string | null;
  investigatedCommit: string;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}... [truncated]` : text;
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
  const sessionContext = input.sessionContext
    ? `\n\nSession context (analyzer facts for the recorded session):\n<untrusted_data>\n${fenced(input.sessionContext, MAX_SESSION_CONTEXT)}\n</untrusted_data>`
    : '';
  const investigationBrief = input.investigationBrief
    ? `\n\nInquiry brief (untrusted starting point, verify against evidence and code):\n<untrusted_data>\n${fenced(input.investigationBrief, MAX_INVESTIGATION_BRIEF)}\n</untrusted_data>`
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
</untrusted_data>${sessionContext}${investigationBrief}

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
- Candidates and rejections are checked mechanically against the repository: cite the exact file, line, and a verbatim quote for every local candidate and every rejection, or the submission is discarded.
- If you conclude the cause is outside this codebase, reject every grounded local candidate by ID in "rejected_candidates". A conclusion reached instead of the local candidates rather than against them will not be acted on. Keep "rejected" as a legacy prose summary only.
- In cause_locations, the FIRST entry is your claim and the only one we act on. Put the file you are most confident about first. path is the bare repository path with no line numbers and no parentheses; put line numbers in the line field and any explanation in the note field. Extra entries do not improve your answer.
- Your verdict is machine-checked: the evidence field must cite at least one file you actually read, with what you found there (detail) and how it links to the customer-visible symptom (symptomLink). A verdict with no citations is discarded as incomplete, whatever its prose says.
- Only files you opened with read_file count as read. A file you have only seen in search results does not count — read it before citing it.

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
    case 'truncated':
      return `${stage} hit the output token ceiling mid-answer`;
    case 'no_evidence':
      return 'no_files_read: the investigation read no repository files';
    default:
      return `${stage} did not complete`;
  }
}

const NO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function failed(
  reason: string,
  filesRead: string[],
  findings: string,
  stop: ReadOnlyStop,
  investigatedCommit: string,
): InvestigationResult {
  const noEvidence = stop === 'no_evidence';
  return {
    fixable: false,
    confidence: 'low',
    reason,
    adjudication: null,
    diagnosis: null,
    outcome: noEvidence ? 'incomplete' : 'needs_more_context',
    decisionReason: reason,
    decisionBasis: noEvidence ? 'no_evidence' : 'no_adjudication',
    filesRead,
    findings,
    costUsd: 0,
    usage: NO_USAGE,
    stop,
    evidence: [],
    agentTaskBrief: null,
    investigatedCommit,
  };
}

/**
 * One agent over one repository clone: enumerate the candidate causes and
 * submit the one the evidence supports. Routing is derived in code from the
 * submitted location and the evidence strength, so the agent never names an
 * outcome.
 */
export async function investigateError(
  apiKey: string,
  input: InvestigateInput,
  reader: RepoReader,
  investigatedCommit = 'unknown',
): Promise<InvestigationResult> {
  const pricing = MODEL_PRICING[INVESTIGATION_MODEL] ?? DEFAULT_PRICING;
  const spendCeilingUsd = Number(process.env['INVESTIGATION_BUDGET_USD'] ?? DEFAULT_SPEND_CEILING_USD);
  const stackFiles = extractStackTraceFiles(input.stackTrace, input.platform);
  const hints = stackFiles.length > 0
    ? `\n\nFiles named by the stack trace, as a starting point only: ${stackFiles.slice(0, 5).join(', ')}`
    : '';

  // The verbatim-quote check stays synchronous. Making it async would cascade
  // into deriveOutcome, whose resolvePath and quoteAt parameters are
  // synchronous, and deriveOutcome is also called from agent-fix.ts in the fix
  // pipeline, which this change does not touch.
  //
  // So the cache is filled by the agent's own reads rather than by a separate
  // fetch: every successful read_file lands here on its way to the model. That
  // also keeps the check honest across the pre-acceptance validator, which runs
  // mid-run and could not await a fetch of its own.
  const quoteFileCache = new Map<string, string>();
  /**
   * Paths proven absent from the checkout.
   *
   * Grounding must separate "not in the repository" (citation_unresolvable)
   * from "here, but you never opened it" (citation_not_read), and those send
   * different corrections back to the model. Absence is only ever recorded from
   * evidence — a failed read, or the probe below — never assumed.
   */
  const knownMissing = new Set<string>();
  /** One repository-relative POSIX form, so './src/a.ts' and 'src/a.ts' agree. */
  const norm = (path: string): string =>
    path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const recordingReader: RepoReader = {
    readFile: async (path: string): Promise<string> => {
      let content: string;
      try {
        content = await reader.readFile(path);
      } catch (err: unknown) {
        if (/ENOENT|No such file|not found/i.test(err instanceof Error ? err.message : String(err))) {
          knownMissing.add(norm(path));
        }
        throw err;
      }
      knownMissing.delete(norm(path));
      // Already bounded by the reader, so this cannot hold a whole minified
      // bundle; the ceiling is belt-and-braces against a future looser reader.
      if (content.length <= QUOTE_CHECK_MAX_FILE_BYTES) quoteFileCache.set(norm(path), content);
      return content;
    },
    grep: (args: string[]) => reader.grep(args),
    list: (path: string, recursive: boolean) => reader.list(path, recursive),
    exists: (paths: string[]) => reader.exists(paths),
  };
  const resolveCited = (cited: string): string | null => {
    const key = norm(cited);
    return knownMissing.has(key) ? null : key;
  };
  /**
   * Prove which cited paths are actually in the checkout, in one round trip,
   * before the authoritative validation runs. Without this every citation would
   * resolve and a hallucinated path would be reported as merely unread.
   */
  const probeCitedPaths = async (submitted: unknown): Promise<void> => {
    const cited = new Set<string>();
    const walk = (node: unknown, depth: number): void => {
      if (depth > 6 || cited.size >= MAX_PROBED_CITATIONS) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'path' && typeof value === 'string' && value.length > 0) cited.add(value);
        else walk(value, depth + 1);
      }
    };
    walk(submitted, 0);
    const unknownPaths = [...cited].filter((path) => !quoteFileCache.has(norm(path)));
    if (unknownPaths.length === 0) return;
    try {
      const present = new Set((await reader.exists(unknownPaths)).map(norm));
      for (const path of unknownPaths) {
        if (!present.has(norm(path))) knownMissing.add(norm(path));
      }
    } catch (err: unknown) {
      // A dead machine is not a hallucinated citation. Leave the paths
      // unclassified and let the failure reach the job.
      if (err instanceof MachineUnavailableError) throw err;
    }
  };
  const quoteAt = (resolved: string, line: number, quote: string): boolean => {
    const text = quoteFileCache.get(norm(resolved));
    return text !== undefined && quoteWithinWindow(text, line, quote);
  };

  // Pre-acceptance mirror of the post-run checks below. A defect the model can
  // repair in one turn — a candidate missing its citation, an unread file in
  // the evidence — goes back as feedback instead of voiding the whole paid run.
  // The post-run validation stays authoritative: a submission still broken
  // after the resubmit budget lands there and terminalizes exactly as before.
  const validateSubmission = (
    raw: Record<string, unknown>,
    context: { filesRead: string[] },
  ): { ok: true } | { ok: false; feedback: string } => {
    const submitted = parseAdjudication(raw);
    if (!submitted) {
      return { ok: false, feedback: 'best_supported was empty — state the cause in one sentence.' };
    }
    const shape = validateAdjudicationShape(submitted, { requireStructuralShape: true });
    if (shape.status === 'incomplete') {
      return { ok: false, feedback: resubmitGuidance(shape.code, shape.reason) };
    }
    const derived = deriveOutcome(submitted, resolveCited, quoteAt);
    // Mechanically repairable derivation failures also go back for correction.
    // Substantive judgments (insufficient evidence, an unplaced cause) do not:
    // those are the model's honest answer, not a format defect.
    if (derived.basis === 'citation_unresolvable') {
      return {
        ok: false,
        feedback: `${derived.reason}. cause_locations[0].path must be the bare repository-relative path of a file that exists in the checkout.`,
      };
    }
    if (derived.basis === 'uncitable_local_claim') {
      return {
        ok: false,
        feedback: `${derived.reason}. A local cause requires at least one cause_locations entry naming the file.`,
      };
    }
    if (derived.basis === 'unrejected_local_candidates') {
      // Name the actual defect per candidate: "ungrounded" means the model DID
      // reject the candidate but the rejection's quote failed the verbatim
      // check — telling it only to "reject by id" would ask for the thing it
      // already did.
      const rejectedIds = new Set((submitted.rejected_candidates ?? []).map((rejection) => rejection.id));
      const perCandidate = (derived.dispositions ?? [])
        .filter((entry) => entry.disposition !== 'rejected')
        .map((entry) => rejectedIds.has(entry.id)
          ? `${entry.id}: its rejection citation did not check out — the quote must be 8-300 characters copied verbatim from within a few lines of the cited line, in a file you read`
          : `${entry.id}: not rejected in rejected_candidates`)
        .join('; ');
      return {
        ok: false,
        feedback: `${derived.reason}. ${perCandidate}. Fix each rejection's grounded citation {path, line, quote}, or — only if the evidence genuinely supports it — change your conclusion to a local cause.`,
      };
    }
    const verdict = validateVerdict({
      causeText: submitted.best_supported,
      claimsCodeCause: derived.outcome === 'code_fix',
      evidence: submitted.evidence ?? [],
      agentTaskBrief: submitted.agent_task_brief ?? null,
      filesRead: context.filesRead,
    }, resolveCited);
    if (verdict.status === 'incomplete') {
      return { ok: false, feedback: resubmitGuidance(verdict.code, verdict.reason) };
    }
    return { ok: true };
  };

  const run = await traceSpan('investigation.diagnose', { 'investigation.stage': 'diagnose' }, () =>
    runReadOnlyAgentSdk({
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
      reader: recordingReader,
      classification: { minFilesRead: 1 },
      validateTerminal: validateSubmission,
    }));

  const filesRead = run.filesRead;
  const costUsd = Number(calculateCost(run.usage, pricing).toFixed(4));

  if (run.stop !== 'terminal') {
    // Cost is carried on EVERY return path. Dropping it here would undercount
    // exactly the failed and retried runs the eval most needs to price.
    return {
      ...failed(stopReason(run.stop, 'Investigation'), filesRead, run.lastModelText, run.stop, investigatedCommit),
      ...(run.apiErrorStatus !== undefined ? { apiErrorStatus: run.apiErrorStatus } : {}),
      ...(run.apiErrorDetail !== undefined ? { apiErrorDetail: run.apiErrorDetail } : {}),
      costUsd,
      usage: run.usage,
    };
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

  await probeCitedPaths(run.terminalInput ?? {});

  // The authoritative acceptance pipeline. validateSubmission above is its
  // pre-acceptance mirror — a rule added here without a matching (or
  // deliberately omitted) counterpart there silently exempts that rule from
  // the correction loop. Keep the two in step.
  let decision = deriveOutcome(adjudication, resolveCited, quoteAt);
  if (adjudication) {
    const shape = validateAdjudicationShape(adjudication, { requireStructuralShape: true });
    if (shape.status === 'incomplete') {
      decision = {
        outcome: 'incomplete',
        basis: 'invalid_verdict',
        reason: shape.reason,
        confidence: 'low',
      };
    } else {
      const validation = validateVerdict({
        causeText: adjudication.best_supported,
        claimsCodeCause: decision.outcome === 'code_fix',
        evidence: adjudication.evidence ?? [],
        agentTaskBrief: adjudication.agent_task_brief ?? null,
        filesRead,
      }, resolveCited);
      if (validation.status === 'incomplete') {
        decision = {
          outcome: 'incomplete',
          basis: 'invalid_verdict',
          reason: validation.reason,
          confidence: 'low',
        };
      }
    }
  }

  const diagnosis: Diagnosis | null = buildDiagnosis(adjudication);

  await traceSpan('investigation.decision', {
    'investigation.outcome': decision.outcome,
    'investigation.confidence': decision.confidence,
    'investigation.strength': adjudication?.evidence_strength ?? 'none',
    'investigation.cause_location': adjudication?.cause_locations.map((l) => l.path).join(', ') ?? '',
    'investigation.files_read': filesRead.join(','),
    'investigation.cost_usd': costUsd,
    'investigation.stop': run.stop,
    'investigation.investigated_commit': investigatedCommit,
    // The cache figures, not just the dollar total. A cost number cannot answer
    // whether prompt caching is working — these were computed on every run and
    // then dropped, so the one measurement that would catch a broken cache
    // prefix was invisible. Reads well below input after the first turn means
    // the prefix is being rewritten rather than hit.
    'investigation.input_tokens': run.usage.input,
    'investigation.output_tokens': run.usage.output,
    'investigation.cache_read_tokens': run.usage.cacheRead,
    'investigation.cache_write_tokens': run.usage.cacheWrite,
  }, async () => undefined);

  return {
    fixable: decision.outcome === 'code_fix',
    confidence: decision.confidence,
    reason: decision.reason,
    adjudication,
    diagnosis,
    outcome: decision.outcome,
    decisionReason: decision.reason,
    decisionBasis: decision.basis,
    dispositions: decision.dispositions,
    filesRead,
    // Prefer the model's prose, but fall back to the structured reasoning: a
    // terminal tool call may carry no accompanying text at all.
    findings: run.lastModelText || adjudication?.reasoning || '',
    costUsd,
    usage: run.usage,
    stop: run.stop,
    evidence: adjudication?.evidence ?? [],
    agentTaskBrief: adjudication?.agent_task_brief ?? null,
    investigatedCommit,
  };
}

/** Exported for tests: the one place a diagnosis is assembled from an adjudication. */
export function buildDiagnosis(
  adjudication: {
    best_supported: string;
    why_chain: string[];
    reproduction_steps: string[];
    cause_locations: { path: string }[];
    evidence?: EvidenceCitation[];
    agent_task_brief?: string;
  } | null,
): Diagnosis | null {
  if (!adjudication) return null;
  const paths = adjudication.cause_locations.map((location) => location.path);
  return {
    one_line_description: adjudication.best_supported,
    why_chain: adjudication.why_chain,
    reproduction_steps: adjudication.reproduction_steps,
    cause_location: paths.join(', '),
    cause_locations: paths,
    evidence: adjudication.evidence,
    agentTaskBrief: adjudication.agent_task_brief,
  };
}
