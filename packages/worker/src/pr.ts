import type {
  CheckOutcome,
  ConfidenceLevel,
  EvidenceCheck,
  EvidenceRecord,
  EvidenceTier,
  NeedsHumanReason,
} from '@opslane/shared';
import { Octokit } from '@octokit/rest';
import { scrubDevPaths } from './harness/stack-trace-utils.js';
import {
  buildFallbackNarrative,
  buildIncidentUrl,
  escapeInlineCode,
  normalizeProse,
  renderPRSections,
  storyLine,
  type FixNarrative,
  type StoryImpact,
} from './narrative.js';
import { formatRuntime, type RuntimeInfo } from './runtime-info.js';
import type { LedgerEntry, LedgerRecorder, TierRecord } from './verification-ledger.js';
/** Extract file paths from +++ headers in a unified diff. */
function extractFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      let filePath = line.slice(4).trim();
      if (filePath.startsWith('b/')) filePath = filePath.slice(2);
      if (filePath !== '/dev/null') files.push(filePath);
    }
  }
  return files;
}

// === Public types ===

export interface ReplaySignals {
  eventTypeCounts?: Record<string, number>;
  consoleErrorCount?: number;
  consoleWarningCount?: number;
  consoleErrorMessages?: string[];
  consoleWarningMessages?: string[];
  networkAnomalyCount?: number;
  networkAnomalies?: Array<{
    type?: string;
    method?: string;
    url?: string;
    statusCode?: number;
    message?: string;
  }>;
  lastUserActions?: Array<{
    timestamp: string;
    type: string;
    detail: string;
  }>;
}

export interface ReplayInput {
  id: string;
  sessionId: string;
  triggerType: string | null;
  pageUrl: string | null;
  startedAt: string | null;
  endedAt: string | null;
  status: string;
  sizeBytes: number | null;
  signals: ReplaySignals | null;
}

export interface PRInput {
  customerRuntime?: RuntimeInfo | null;
  sandboxRuntime?: RuntimeInfo | null;
  projectId: string;
  errorGroupId: string;
  githubRepo: string; // "owner/repo"
  defaultBranch: string;
  branchName: string;
  diff: string;
  title: string;
  confidence: ConfidenceLevel;
  narrative?: FixNarrative;
  /** Precomputed once by the pipeline so commit and PR render the same link. */
  incidentUrl?: string | null;
  rootCause?: string;
  humanSummary?: string;
  // Evidence
  stackTrace?: string;
  replay?: ReplayInput | null;
  visualAnalysis?: {
    whatUserSaw: string;
    failureMoment: string;
    uxImpact: string;
    confidence: string;
  } | null;
  errorType?: string;
  errorMessage?: string;
  environmentNames?: string[];
  environmentTotal?: number;
  kind?: 'error' | 'friction';
  evidence?: EvidenceRecord | null;
  draft?: boolean;
  ledger?: LedgerEntry[];
  ledgerRoles?: ReturnType<LedgerRecorder['roles']>;
  tierRecord?: TierRecord;
  judge?: EvidenceRecord['judge'];
  occurrenceCount?: number | null;
  impact?: StoryImpact | null;
  watchUrl?: string | null;
}

export type PRResult =
  | { status: 'created'; prUrl: string; prNumber: number }
  | { status: 'failed'; reason: NeedsHumanReason };

// === Sanitization ===

/** Strip potential XSS/injection vectors from text going into GitHub markdown. */
export function sanitize(text: string): string {
  return text
    .replace(/[<>]/g, '')                 // HTML tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // markdown images ![alt](url)
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')  // markdown links [text](url)
    .slice(0, 2000);
}

// === Helpers ===

const MAX_LEDE_LENGTH = 700;
const MAX_FIX_LINE_LENGTH = 500;

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'n/a';
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString();
}

/**
 * Dashboard link to the incident, where the session replay plays. The reader-
 * facing DASHBOARD_URL must be configured explicitly; DASHBOARD_ORIGIN is a
 * CORS setting and is intentionally not a fallback.
 */
export function buildReplayLink(errorGroupId: string, projectId: string): string | null {
  return buildIncidentUrl(process.env['DASHBOARD_URL'], errorGroupId, projectId);
}

// === Section builders ===

function sanitizeInline(text: string, max = 2000): string {
  return sanitize(scrubDevPaths(text))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function stripMarkdownHeaders(text: string): string {
  return text.replace(/^\s{0,3}#{1,6}\s*/gm, '');
}

function normalizeLede(text: string): string {
  return sanitizeInline(stripMarkdownHeaders(text), MAX_LEDE_LENGTH);
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function inlineCode(text: string): string {
  return escapeInlineCode(text);
}

function buildHumanSummary(input: PRInput): string {
  const explicit = normalizeLede(input.humanSummary ?? '');
  if (explicit) return explicit;

  if (input.visualAnalysis) {
    const whatUserSaw = sanitizeInline(input.visualAnalysis.whatUserSaw, 240);
    const failureMoment = sanitizeInline(input.visualAnalysis.failureMoment, 240);
    // Don't restate rootCause here — `buildFixLine` already surfaces it in
    // `### The fix`, so embedding it in the lede would render it twice.
    const fix = 'This change updates the failing code path so the flow can complete';
    const fallback = [
      whatUserSaw ? sentence(whatUserSaw) : '',
      failureMoment ? sentence(failureMoment) : '',
      sentence(fix),
    ].filter(Boolean).join(' ');
    const normalized = normalizeLede(fallback);
    if (normalized) return normalized;
  }

  return normalizeLede(
    `Opslane detected a ${input.errorType ?? 'runtime error'} (${input.errorMessage ?? input.title}) and generated a fix.`,
  );
}

function buildFixLine(input: PRInput, files: string[]): string {
  const rootCause = normalizeProse(input.rootCause ?? '', MAX_FIX_LINE_LENGTH);
  if (rootCause) return `Addresses ${rootCause}`;
  if (files.length > 0) {
    const namedFiles = files.slice(0, 3).map((file) => inlineCode(file)).join(', ');
    const suffix = files.length > 3 ? ` and ${files.length - 3} more files` : '';
    return `Updates ${namedFiles}${suffix} to fix the reported failure.`;
  }
  return 'Applies a focused code change for the reported failure.';
}

function buildFileLine(files: string[]): string | null {
  if (files.length === 0) return null;
  return `Changed files: ${files.map((file) => inlineCode(file)).join(', ')}`;
}

// Removes <...> tag structures completely, repeating until the string is
// stable so nested or unterminated input (e.g. "<scr<script>ipt>") cannot
// leave a live tag behind. The pattern has no nested quantifier, so the loop
// is linear, not a ReDoS.
function stripAngleTags(value: string): string {
  let current = value;
  let previous: string;
  do {
    previous = current;
    current = current.replace(/<[^>]*>/g, '');
  } while (current !== previous);
  return current;
}

function buildEnvironmentLine(
  environmentNames?: string[],
  environmentTotal?: number,
): string | null {
  const availableNames = environmentNames ?? [];
  const names = availableNames
    .slice(0, 20)
    .map((name) => sanitizeInline(
      stripAngleTags(name).replace(/[`*_~|\\]/g, ''),
      80,
    ))
    .filter(Boolean);
  if (names.length === 0) return null;

  const total = Math.max(environmentTotal ?? availableNames.length, availableNames.length);
  const omitted = Math.max(0, total - Math.min(availableNames.length, 20));
  const suffix = omitted > 0 ? ` (+${omitted} more)` : '';
  return `Environments: ${names.join(', ')}${suffix}`;
}

function buildStackTraceSection(stackTrace?: string): string {
  if (!stackTrace) return 'Not available.';
  const frames = scrubDevPaths(stackTrace)
    .split('\n')
    .map((frame) => frame.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (frames.length === 0) return 'Not available.';
  return frames.map((frame) => `- ${inlineCode(frame)}`).join('\n');
}

function buildVisualAnalysisSection(visualAnalysis?: PRInput['visualAnalysis']): string {
  if (!visualAnalysis) return '';
  const lines = [
    visualAnalysis.whatUserSaw ? `The user saw ${sanitizeInline(visualAnalysis.whatUserSaw)}.` : '',
    visualAnalysis.failureMoment ? `The failure happened around ${sanitizeInline(visualAnalysis.failureMoment)}.` : '',
    visualAnalysis.uxImpact ? `Impact: ${sanitizeInline(visualAnalysis.uxImpact)}.` : '',
  ].filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : '';
}

function buildReplaySignalSummary(signals?: ReplaySignals | null): string {
  if (!signals) return 'Signals not available.';

  const consoleErrors = signals.consoleErrorCount ?? 0;
  const consoleWarnings = signals.consoleWarningCount ?? 0;
  const networkAnomalies = signals.networkAnomalyCount ?? signals.networkAnomalies?.length ?? 0;
  const lastAction = signals.lastUserActions?.at(-1);
  const firstAnomaly = signals.networkAnomalies?.[0];

  const parts = [
    plural(consoleErrors, 'console error'),
    plural(consoleWarnings, 'warning'),
    plural(networkAnomalies, 'network anomaly', 'network anomalies'),
  ];

  if (lastAction) {
    parts.push(
      `last action: ${lastAction.type} (${lastAction.detail}) at ${formatTimestamp(lastAction.timestamp)}`,
    );
  } else {
    parts.push('no recent user action recorded');
  }

  if (firstAnomaly) {
    const method = firstAnomaly.method || 'GET';
    const status = firstAnomaly.statusCode != null ? String(firstAnomaly.statusCode) : 'n/a';
    parts.push(`first network anomaly: ${method} ${firstAnomaly.url ?? ''} (${status})`);
  }

  return sentence(sanitizeInline(parts.join(', '), 700));
}

function buildTechnicalDetails(input: PRInput): string {
  const visualAnalysis = buildVisualAnalysisSection(input.visualAnalysis);
  return [
    '<details><summary>Technical detail</summary>',
    '',
    '#### Stack trace',
    buildStackTraceSection(input.stackTrace),
    '',
    '#### What the replay showed',
    visualAnalysis || 'Visual replay analysis not available.',
    '',
    '#### Signals',
    buildReplaySignalSummary(input.replay?.signals),
    '',
    '#### Runtime',
    `Customer: ${formatRuntime(input.customerRuntime)}`,
    `Sandbox: ${formatRuntime(input.sandboxRuntime)}`,
    '',
    '</details>',
  ].join('\n');
}

const TIER_LABELS: Record<EvidenceTier, string> = {
  E0: 'build verified',
  E1: 'no new test failures compared with the pre-fix baseline',
  E2: 'reproduction verified red→green',
};

const CHECK_LABELS: Record<string, string> = {
  build: 'Build',
  suite_baseline: 'Existing suite (pre-patch baseline)',
  suite_post_patch: 'Existing suite (with fix, vs baseline)',
};

function checkIcon(outcome: CheckOutcome): string {
  if (outcome === 'passed') return '✅';
  if (outcome === 'failed') return '❌';
  if (outcome === 'infra_error') return '⚠️';
  return '⏭️';
}

function buildEvidenceLines(evidence: EvidenceRecord): string[] {
  const latest = new Map<string, EvidenceCheck>();
  for (const check of evidence.checks) latest.set(check.name, check);
  const lines = [...latest].map(([name, check]) =>
    `- ${checkIcon(check.outcome)} ${CHECK_LABELS[name] ?? sanitizeInline(name, 60)}: ${check.outcome}`,
  );
  if (evidence.suite && evidence.suite.baseline_failed_tests.length > 0) {
    lines.push(
      '- ℹ️ Pre-existing baseline failures were excluded from the gate',
    );
  }
  return lines;
}

export const VERIFICATION_START = '<!-- opslane-verification:start -->';
export const VERIFICATION_END = '<!-- opslane-verification:end -->';
export const CI_STATUS_START = '<!-- opslane-ci-status:start -->';
export const CI_STATUS_END = '<!-- opslane-ci-status:end -->';

function ciStatusLines(evidence: EvidenceRecord | null | undefined): string[] {
  if (evidence?.external_ci?.outcome === 'passed') {
    return [
      CI_STATUS_START,
      'External CI: passed for the exact published commit.',
      ...evidence.external_ci.check_names.map((name) => `- ✅ ${sanitizeInline(name, 100)}`),
      CI_STATUS_END,
    ];
  }
  return [CI_STATUS_START, 'External CI: not yet observed.', CI_STATUS_END];
}

function tierLine(record: TierRecord): string {
  if (record.tier === 'reproduced') {
    return 'Tier: reproduced — the declared test failed on the unfixed code and passed with the fix.';
  }
  if (record.tier === 'checked') {
    return 'Tier: checked — the suite, build, and quality gates passed without a mechanical reproduction.';
  }
  return 'Tier: attempted — the attempt did not satisfy the mechanical verification predicate.';
}

function buildLedgerLines(input: PRInput): string[] | null {
  if (!input.ledger || !input.ledgerRoles || !input.tierRecord) return null;
  const roles = new Map(input.ledgerRoles.map((role) => [role.entrySeq, role]));
  const entries = [...input.ledger].sort((left, right) => left.entrySeq - right.entrySeq);
  // The role phrasing describes an attempt's FINAL state, so it applies only
  // to the last entry recorded for each role: an infra-retried role records
  // twice, and rendering both with role phrasing would print contradictory
  // red/green claims for the same check.
  const lastSeqByRole = new Map<string, number>();
  for (const entry of entries) {
    const role = roles.get(entry.entrySeq);
    if (role) lastSeqByRole.set(role.role, entry.entrySeq);
  }
  const lines = ['### Verification (executed)', tierLine(input.tierRecord)];
  if (input.tierRecord.tier === 'checked' && input.tierRecord.reproductionImpossibleReason) {
    lines.push(`Agent declaration: “${sanitizeInline(input.tierRecord.reproductionImpossibleReason, 600)}”`);
  }
  for (const entry of entries) {
    const roleEntry = roles.get(entry.entrySeq);
    const superseded = roleEntry !== undefined && lastSeqByRole.get(roleEntry.role) !== entry.entrySeq;
    const role = superseded ? undefined : roleEntry;
    if (role?.role === 'suite_baseline') {
      // The baseline is an observation, never a gate: pre-existing failures
      // are the comparison point for the post-patch run, not a red mark.
      const failedPart = (entry.failed ?? 0) > 0 ? `${entry.failed} pre-existing failures` : 'no failures';
      lines.push(`- ✅ baseline suite: ${entry.passed ?? 0} passed, ${failedPart} on \`${sanitizeInline(entry.commitSha.slice(0, 12), 12)}\` (compared below)`);
      continue;
    }
    if (role?.role === 'repro_red') {
      const matched = role.assertionMatched === true;
      lines.push(`- ${entry.failed && matched ? '✅' : '❌'} \`${sanitizeInline(entry.command, 500)}\` — failed as declared on base \`${sanitizeInline(entry.commitSha.slice(0, 12), 12)}\`${matched ? ' (assertion matched)' : ''}`);
      continue;
    }
    if (role?.role === 'repro_green') {
      lines.push(`- ${entry.failed === 0 ? '✅' : '❌'} declared test green with the fix on \`${sanitizeInline(entry.commitSha.slice(0, 12), 12)}\``);
      continue;
    }
    if (role?.role === 'suite_post_patch') {
      const newFailures = input.evidence?.suite?.new_failures.length ?? entry.failed ?? 0;
      lines.push(`- ${newFailures === 0 ? '✅' : '❌'} suite: ${entry.passed ?? 0} passed, ${newFailures} new failures (baseline compared)`);
      continue;
    }
    if (role?.role === 'build') {
      lines.push(`- ${entry.failed === 0 ? '✅' : '❌'} build ${entry.failed === 0 ? 'passed' : 'failed'}`);
      continue;
    }

    const mark = entry.timedOut || entry.truncated ? '⚠️' : (entry.failed ?? 0) === 0 ? '✅' : '❌';
    const counts = [
      entry.passed === null ? null : `${entry.passed} passed`,
      entry.failed === null ? null : `${entry.failed} failed`,
      entry.skipped !== null && entry.skipped > 0 ? `${entry.skipped} skipped` : null,
    ].filter((part): part is string => part !== null);
    const countSummary = counts.length > 0
      ? counts.join(', ')
      : entry.timedOut || entry.truncated ? 'counts unavailable' : 'completed';
    let line = `- ${mark} \`${sanitizeInline(entry.command, 500)}\` — ${countSummary} on \`${sanitizeInline(entry.commitSha.slice(0, 12), 12)}\``;
    if (entry.truncated) line += ' — output truncated';
    if (entry.timedOut) line += ' — timed out';
    if (entry.workdirDirty) line += ' (dirty worktree)';
    if (superseded) line += ' — superseded by the retry below';
    lines.push(line);
  }
  const notRun = [...new Set(entries.flatMap((entry) => entry.notRun))];
  lines.push(`Not run: ${notRun.length > 0 ? notRun.join(', ') : '(none)'}`);
  lines.push(...ciStatusLines(input.evidence));
  return lines;
}

function buildImpactSection(input: PRInput): string | null {
  if (input.occurrenceCount == null) return null;
  const [noun, nouns] = input.kind === 'friction'
    ? ['friction signal', 'friction signals']
    : ['crash', 'crashes'];
  const story = storyLine(
    noun,
    nouns,
    input.occurrenceCount,
    input.impact ?? { class: null, visits: null, recovered: null },
  );
  const watch = input.watchUrl
    ? `\n▶ [Watch a recording of the failure →](${input.watchUrl})`
    : '';
  return `### What users hit\n${story}${watch}`;
}

export function buildVerificationSection(input: PRInput): string {
  const ledgerLines = buildLedgerLines(input);
  if (ledgerLines) {
    // The ledger proves the code change; for friction it cannot prove the
    // customer-visible friction is gone, so the suggestion caveat survives
    // above the executed-check lines.
    const lines = input.kind === 'friction'
      ? ['**Confidence:** Suggestion · ⚠️ The friction itself was not re-verified — review before merging', ...ledgerLines]
      : ledgerLines;
    return `${VERIFICATION_START}\n${lines.join('\n')}\n${VERIFICATION_END}`;
  }
  let content: string;
  if (input.kind === 'friction') {
    const lines = [
      '**Confidence:** Suggestion · ⚠️ The friction itself was not re-verified — review before merging',
    ];
    if (input.evidence) lines.push(...buildEvidenceLines(input.evidence));
    content = lines.join('\n');
  } else if (input.draft) {
    const tier = input.evidence?.tier ?? 'E0';
    content = [
      `**Verification: ${tier} — NOT verified for review.** Opslane could not execute enough local verification for this fix. The CI results on this draft are the verification — review them before marking it ready.`,
      ...(input.evidence ? buildEvidenceLines(input.evidence) : []),
    ].join('\n');
  } else if (!input.evidence) {
    content = '**Verification:** ⚠️ No verification evidence recorded';
  } else {
    content = [
      `**Verification:** ${input.evidence.tier
        ? `${input.evidence.tier} — ${TIER_LABELS[input.evidence.tier]}`
        : '⚠️ no tier achieved'}`,
      ...buildEvidenceLines(input.evidence),
    ].join('\n');
  }
  return `${VERIFICATION_START}\n${content}\n${ciStatusLines(input.evidence).join('\n')}\n${VERIFICATION_END}`;
}

export function buildJudgeSection(input: PRInput): string | null {
  const judge = input.judge ?? input.evidence?.judge;
  if (!judge) return null;
  return [
    '### Judge review',
    `Judge report: ${sanitize(judge.assessment).slice(0, 4000)}`,
    judge.veto_reason ? `Veto reason: ${sanitize(judge.veto_reason).slice(0, 600)}` : null,
    judge.probes_used > 0 ? `Probes used: ${judge.probes_used}` : null,
  ].filter(Boolean).join('\n');
}

// === PR body construction ===

export function buildPRBody(input: PRInput): string {
  const files = extractFiles(input.diff);
  const maxBacktickRun = (input.diff.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length), 2,
  );
  const fence = '`'.repeat(maxBacktickRun + 1);
  const replayLink = input.incidentUrl === undefined
    ? buildReplayLink(input.errorGroupId, input.projectId)
    : input.incidentUrl;

  if (input.kind !== 'friction') {
    const narrative = input.narrative ?? buildFallbackNarrative({
      errorType: input.errorType ?? 'runtime error',
      errorMessage: input.errorMessage ?? input.title,
      primaryFile: files[0],
    });
    const sections = renderPRSections(narrative);
    return [
      `## ${sections.title}`,
      buildImpactSection(input),
      buildEnvironmentLine(input.environmentNames, input.environmentTotal),
      '### What happened',
      sections.whatHappened,
      replayLink
        ? `▶ [Watch the session replay and view the full incident in Opslane →](${replayLink})`
        : null,
      '### Why it broke',
      sections.whyItBroke,
      '### The fix',
      sections.fixApproach,
      buildFileLine(files),
      `${fence}diff`,
      input.diff.trim(),
      fence,
      buildVerificationSection(input),
      buildJudgeSection(input),
      buildTechnicalDetails(input),
      '---',
      `*Generated by Opslane · Error Group: ${inlineCode(input.errorGroupId.slice(0, 8))}*`,
    ].filter(Boolean).join('\n\n');
  }

  return [
    `## 💡 Opslane suggestion: ${sanitizeInline(input.title, 120)}`,
    buildImpactSection(input),
    buildEnvironmentLine(input.environmentNames, input.environmentTotal),
    buildHumanSummary(input),
    '### The fix',
    buildFixLine(input, files),
    buildFileLine(files),
    `${fence}diff`,
    input.diff.trim(),
    fence,
    buildVerificationSection(input),
    buildJudgeSection(input),
    replayLink ? `📊 [Full investigation & session replay →](${replayLink})` : null,
    buildTechnicalDetails(input),
    '---',
    `*Generated by Opslane · Error Group: ${inlineCode(input.errorGroupId.slice(0, 8))}*`,
  ].filter(Boolean).join('\n\n');
}

// === GitHub client interface (for mocking) ===

export interface GitHubClient {
  createPullRequest(params: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<{ url: string; number: number }>;
  getFileContent(params: {
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }): Promise<string | null>;
  listOpenPullsByHead?(params: {
    owner: string;
    repo: string;
    head: string;
  }): Promise<{ url: string; number: number; headSha: string; draft: boolean; body: string } | null>;
  getBranchHead?(params: { owner: string; repo: string; branch: string }): Promise<string | null>;
  getPullRequest?(params: { owner: string; repo: string; number: number }): Promise<{
    nodeId: string;
    headSha: string;
    draft: boolean;
    body: string;
  }>;
  listCheckRuns?(params: { owner: string; repo: string; ref: string }): Promise<Array<{
    name: string;
    status: string;
    conclusion: string | null;
  }>>;
  listCommitStatuses?(params: { owner: string; repo: string; ref: string }): Promise<Array<{
    context: string;
    state: string;
  }>>;
  updatePullRequestBody?(params: { owner: string; repo: string; number: number; body: string }): Promise<void>;
  markPullRequestReady?(params: { nodeId: string }): Promise<void>;
}

export function getGitHubClientOptions(
  token: string,
  apiBaseUrl = process.env['OPSLANE_GITHUB_API_URL'],
): ConstructorParameters<typeof Octokit>[0] {
  const configuredBaseUrl = apiBaseUrl?.trim();
  return {
    auth: token,
    ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
  };
}

/**
 * Create a real GitHub client backed by Octokit.
 * Uses the provided token or falls back to GITHUB_TOKEN env. Returns null if no token available.
 */
export function createGitHubClient(
  githubToken?: string,
  apiBaseUrl = process.env['OPSLANE_GITHUB_API_URL'],
): GitHubClient | null {
  const token = githubToken ?? process.env['GITHUB_TOKEN'];
  if (!token) return null;

  const octokit = new Octokit(getGitHubClientOptions(token, apiBaseUrl));

  return {
    async createPullRequest(params) {
      const { data } = await octokit.pulls.create({
        owner: params.owner,
        repo: params.repo,
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
        draft: params.draft ?? false,
      });
      return { url: data.html_url, number: data.number };
    },

    async getFileContent(params) {
      try {
        const { data } = await octokit.repos.getContent({
          owner: params.owner,
          repo: params.repo,
          path: params.path,
          ref: params.ref,
        });
        if ('content' in data && data.encoding === 'base64') {
          return Buffer.from(data.content, 'base64').toString('utf-8');
        }
        return null;
      } catch {
        return null; // file not found or too large
      }
    },

    async listOpenPullsByHead(params) {
      const { data } = await octokit.pulls.list({
        owner: params.owner,
        repo: params.repo,
        state: 'open',
        head: `${params.owner}:${params.head}`,
      });
      const pr = data[0];
      return pr ? {
        url: pr.html_url,
        number: pr.number,
        headSha: pr.head.sha,
        draft: pr.draft ?? false,
        body: pr.body ?? '',
      } : null;
    },

    async getBranchHead(params) {
      try {
        const { data } = await octokit.git.getRef({
          owner: params.owner,
          repo: params.repo,
          ref: `heads/${params.branch}`,
        });
        return data.object.sha;
      } catch (error: unknown) {
        const status = typeof error === 'object' && error !== null && 'status' in error
          ? Number((error as { status?: unknown }).status)
          : 0;
        if (status === 404) return null;
        throw error;
      }
    },

    async getPullRequest(params) {
      const { data } = await octokit.pulls.get({
        owner: params.owner,
        repo: params.repo,
        pull_number: params.number,
      });
      return {
        nodeId: data.node_id,
        headSha: data.head.sha,
        draft: data.draft ?? false,
        body: data.body ?? '',
      };
    },

    async listCheckRuns(params) {
      const { data } = await octokit.checks.listForRef({
        ...params,
        per_page: 100,
      });
      return data.check_runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
      }));
    },

    async listCommitStatuses(params) {
      const { data } = await octokit.repos.listCommitStatusesForRef({
        ...params,
        per_page: 100,
      });
      return data.map((status) => ({ context: status.context, state: status.state }));
    },

    async updatePullRequestBody(params) {
      await octokit.pulls.update({ ...params, pull_number: params.number });
    },

    async markPullRequestReady(params) {
      await octokit.graphql(
        `mutation MarkReady($pullRequestId: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
            pullRequest { id isDraft }
          }
        }`,
        { pullRequestId: params.nodeId },
      );
    },
  };
}

export function replaceVerificationSection(body: string, replacement: string): string {
  const start = body.indexOf(VERIFICATION_START);
  const end = body.indexOf(VERIFICATION_END);
  if (start < 0 || end < start) return `${body.trim()}\n\n${replacement}`;
  return `${body.slice(0, start)}${replacement}${body.slice(end + VERIFICATION_END.length)}`;
}

export function replaceCIStatusSection(body: string, replacement: string): string {
  const start = body.indexOf(CI_STATUS_START);
  const end = body.indexOf(CI_STATUS_END);
  if (start < 0 || end < start) return body;
  return `${body.slice(0, start)}${replacement}${body.slice(end + CI_STATUS_END.length)}`;
}

// === Main function ===

export async function createPR(
  input: PRInput,
  clientFactory: () => GitHubClient | null = createGitHubClient
): Promise<PRResult> {
  const client = clientFactory();

  if (!client) {
    return {
      status: 'failed',
      reason: {
        reason_code: 'missing_github_token',
        reason_message: 'GITHUB_TOKEN environment variable is not set',
        remediation:
          'Set the GITHUB_TOKEN environment variable with a GitHub personal access token that has repo scope',
      },
    };
  }

  const [owner, repo] = input.githubRepo.split('/');
  if (!owner || !repo) {
    return {
      status: 'failed',
      reason: {
        reason_code: 'repo_access_denied',
        reason_message: `Invalid repository format: ${input.githubRepo}. Expected "owner/repo"`,
        remediation:
          'Ensure the project github_repo is in "owner/repo" format',
      },
    };
  }

  const prBody = buildPRBody(input);

  try {
    const existing = await client.listOpenPullsByHead?.({
      owner,
      repo,
      head: input.branchName,
    });
    if (existing) {
      return { status: 'created', prUrl: existing.url, prNumber: existing.number };
    }
    const pr = await client.createPullRequest({
      owner,
      repo,
      title: input.kind === 'friction'
        ? `[Opslane] Suggestion: ${input.title}`
        : renderPRSections(input.narrative ?? buildFallbackNarrative({
            errorType: input.errorType ?? 'runtime error',
            errorMessage: input.errorMessage ?? input.title,
            primaryFile: extractFiles(input.diff)[0],
          })).title,
      body: prBody,
      head: input.branchName,
      base: input.defaultBranch,
      draft: input.draft ?? false,
    });

    return {
      status: 'created',
      prUrl: pr.url,
      prNumber: pr.number,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Detect 403 / access denied
    if (message.includes('403') || message.toLowerCase().includes('forbidden')) {
      return {
        status: 'failed',
        reason: {
          reason_code: 'repo_access_denied',
          reason_message: `Access denied to repository ${input.githubRepo}: ${message}`,
          remediation:
            'Ensure the GITHUB_TOKEN has push access to the target repository',
        },
      };
    }

    return {
      status: 'failed',
      reason: {
        reason_code: 'repo_access_denied',
        reason_message: `Failed to create PR: ${message}`,
        remediation:
          'Check GitHub token permissions and repository access',
      },
    };
  }
}
