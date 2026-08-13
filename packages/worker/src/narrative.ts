import type { EvidenceRecord } from '@opslane/shared';
import { scrubSecrets } from './harness/redact.js';
import { scrubDevPaths } from './harness/stack-trace-utils.js';

export interface FixNarrative {
  /** Imperative, 50 characters preferred and 72 characters maximum. */
  subject: string;
  /** What the end user experienced. */
  whatHappened: string;
  /** The technical cause in plain terms. */
  whyItBroke: string;
  /** What the change does and why it is safe. */
  fixApproach: string;
}

export interface NarrativeFallbackInput {
  errorType: string;
  errorMessage: string;
  primaryFile?: string;
}

export interface PRNarrativeSections {
  title: string;
  whatHappened: string;
  whyItBroke: string;
  fixApproach: string;
}

const SUBJECT_HARD_LIMIT = 72;
const PROSE_LIMITS = {
  whatHappened: 700,
  whyItBroke: 700,
  fixApproach: 500,
} as const;

const IMPERATIVE_VERBS = new Set([
  'add', 'align', 'avoid', 'catch', 'clamp', 'clear', 'correct', 'default',
  'disable', 'enable', 'ensure', 'escape', 'fix', 'guard', 'handle', 'honor',
  'keep', 'limit', 'normalize', 'prevent', 'preserve', 'propagate', 'reconcile',
  'reject', 'remove', 'resolve', 'restore', 'retain', 'retry', 'return', 'route',
  'sanitize', 'skip', 'stop', 'track', 'update', 'use', 'validate', 'wrap',
]);

function cleanMarkdown(text: string): string {
  return scrubDevPaths(scrubSecrets(text))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/```[^\s`]*/g, '')
    .replace(/```/g, '')
    .replace(/`+/g, '')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/[<>]/g, '');
}

function truncateAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;

  const sentenceWindow = text.slice(0, max + 1);
  let sentenceEnd = -1;
  for (const match of sentenceWindow.matchAll(/[.!?](?=\s|$)/g)) {
    sentenceEnd = match.index + 1;
  }
  if (sentenceEnd > 0) return sentenceWindow.slice(0, sentenceEnd).trim();

  const room = Math.max(1, max - 1);
  const wordWindow = text.slice(0, room + 1);
  const wordEnd = wordWindow.search(/\s+\S*$/);
  const cut = wordEnd > 0 ? wordEnd : room;
  return `${wordWindow.slice(0, cut).trimEnd()}…`;
}

/** Normalize free-form prose without ever cutting a token or code fence in half. */
export function normalizeProse(text: string, max: number): string {
  if (max <= 0) return '';
  const cleaned = cleanMarkdown(text)
    .replace(/^\s*(?:summary|root cause|explanation|the fix)\s*:\s*/gim, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateAtBoundary(cleaned, max);
}

/** Normalize a commit/PR subject for its single-line slot. */
export function normalizeSubject(text: string): string {
  const cleaned = cleanMarkdown(text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/g, '');
  return truncateAtBoundary(cleaned, SUBJECT_HARD_LIMIT).replace(/[.!?]+$/g, '');
}

/** Render untrusted text inside one Markdown inline-code span. */
export function escapeInlineCode(text: string): string {
  const value = normalizeProse(text.replace(/`/g, "'"), 300);
  return `\`${value}\``;
}

function codeUnit(primaryFile?: string): string {
  const fileName = primaryFile?.replace(/\\/g, '/').split('/').at(-1) ?? '';
  const withoutExtension = fileName.replace(/\.[^.]+$/, '');
  return normalizeProse(withoutExtension, 60) || 'the failing code path';
}

function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Build an honest narrative when the model output is missing or invalid. */
export function buildFallbackNarrative(input: NarrativeFallbackInput): FixNarrative {
  const unit = codeUnit(input.primaryFile);
  const errorType = normalizeProse(input.errorType, 50) || 'runtime error';
  const errorMessage = normalizeProse(input.errorMessage, 280) || 'the reported failure';

  return {
    subject: normalizeSubject(`Fix ${errorType} in ${unit}`),
    whatHappened: normalizeProse(
      ensureSentence(`The application hit a ${errorType}: ${errorMessage}`),
      PROSE_LIMITS.whatHappened,
    ),
    whyItBroke: normalizeProse(
      ensureSentence(`The failing path in ${unit} did not handle the state described by this error`),
      PROSE_LIMITS.whyItBroke,
    ),
    fixApproach: normalizeProse(
      ensureSentence(`The change updates ${unit} to handle that state before continuing`),
      PROSE_LIMITS.fixApproach,
    ),
  };
}

function isImperativeSubject(subject: string): boolean {
  const firstWord = subject.match(/^[A-Za-z]+/)?.[0].toLowerCase();
  return firstWord !== undefined && IMPERATIVE_VERBS.has(firstWord);
}

function isErrorPassthrough(subject: string, input: NarrativeFallbackInput): boolean {
  const comparable = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normalizedSubject = comparable(subject);
  const normalizedType = comparable(input.errorType);
  const normalizedMessage = comparable(input.errorMessage);
  const messagePrefix = normalizedMessage.slice(0, 32).trim();
  return (
    normalizedSubject === normalizedMessage ||
    (normalizedType.length > 0 && normalizedSubject.startsWith(`${normalizedType} `)) ||
    (messagePrefix.length >= 16 && normalizedSubject.includes(messagePrefix))
  );
}

function hasSubjectMarkup(raw: string): boolean {
  return /[\n\r]|^\s{0,3}#|```|\*\*|__|~~|\[[^\]]+\]\(/m.test(raw);
}

/** Parse at the model boundary. A single invalid field falls back the whole object. */
export function parseFixNarrative(
  value: unknown,
  fallbackInput: NarrativeFallbackInput,
): FixNarrative {
  const fallback = buildFallbackNarrative(fallbackInput);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;

  const record = value as Record<string, unknown>;
  const rawSubject = record['subject'];
  const rawWhatHappened = record['whatHappened'];
  const rawWhyItBroke = record['whyItBroke'];
  const rawFixApproach = record['fixApproach'];
  if (
    typeof rawSubject !== 'string' ||
    typeof rawWhatHappened !== 'string' ||
    typeof rawWhyItBroke !== 'string' ||
    typeof rawFixApproach !== 'string'
  ) return fallback;

  const subject = normalizeSubject(rawSubject);
  const whatHappened = normalizeProse(rawWhatHappened, PROSE_LIMITS.whatHappened);
  const whyItBroke = normalizeProse(rawWhyItBroke, PROSE_LIMITS.whyItBroke);
  const fixApproach = normalizeProse(rawFixApproach, PROSE_LIMITS.fixApproach);
  if (
    rawSubject.trim().length > SUBJECT_HARD_LIMIT ||
    hasSubjectMarkup(rawSubject) ||
    /[.!?]\s*$/.test(rawSubject) ||
    !subject ||
    !/[\p{L}\p{N}]/u.test(whatHappened) ||
    !/[\p{L}\p{N}]/u.test(whyItBroke) ||
    !/[\p{L}\p{N}]/u.test(fixApproach) ||
    !isImperativeSubject(subject) ||
    isErrorPassthrough(subject, fallbackInput)
  ) return fallback;

  return { subject, whatHappened, whyItBroke, fixApproach };
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function dashboardBaseUrl(dashboardUrl: string | undefined): URL | null {
  if (!dashboardUrl?.trim()) return null;
  try {
    const url = new URL(dashboardUrl.trim());
    if (!['http:', 'https:'].includes(url.protocol) || isLoopback(url.hostname)) return null;
    if (url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    while (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url;
  } catch {
    return null;
  }
}

/** Build the reader-facing incident URL from explicit HTTP(S) configuration only. */
export function buildIncidentUrl(
  dashboardUrl: string | undefined,
  errorGroupId: string,
  projectId: string,
): string | null {
  const url = dashboardBaseUrl(dashboardUrl);
  if (!url) return null;
  const basePath = url.pathname === '/' ? '' : url.pathname;
  url.pathname = `${basePath}/incidents/${encodeURIComponent(errorGroupId)}`;
  url.search = `?project_id=${encodeURIComponent(projectId)}`;
  return url.toString();
}

export interface StoryImpact {
  class: string | null;
  visits: number | null;
  recovered: number | null;
}

function validStoryImpact(impact: StoryImpact): boolean {
  const { visits, recovered } = impact;
  if (!Number.isSafeInteger(visits) || !Number.isSafeInteger(recovered)) return false;
  if (visits === null || recovered === null || visits < 0 || recovered < 0 || recovered > visits) return false;
  if (impact.class === 'blocked') return recovered === 0;
  if (impact.class === 'degraded') return recovered > 0 && recovered < visits;
  if (impact.class === 'invisible') return visits > 0 && recovered === visits;
  return false;
}

/** TS mirror of ingestion narrative.Story, pinned by story-vectors.json. */
export function storyLine(
  nounSingular: string,
  nounPlural: string,
  occurrences: number,
  impact: StoryImpact,
): string {
  const noun = occurrences === 1 ? nounSingular : nounPlural;
  const prefix = `${occurrences} ${noun}`;
  if (!validStoryImpact(impact)) return `${prefix}; recording impact unavailable`;
  const visits = impact.visits!;
  const recovered = impact.recovered!;
  const line = `${prefix} across ${visits} ${visits === 1 ? 'visit' : 'visits'}, `;
  if (recovered === 0) return `${line}no visit recovered`;
  if (recovered === visits) return `${line}all ${visits} ${visits === 1 ? 'visit' : 'visits'} recovered`;
  return `${line}${recovered} of ${visits} visits recovered`;
}

/** Build a coverage-proven recording URL using the dashboard URL policy.
 * project_id is required: the session page resolves its project from the
 * query (or localStorage, which an external PR reviewer will not have), so a
 * link without it opens a player that cannot load. */
export function buildSessionUrl(
  dashboardUrl: string | undefined,
  sessionId: string,
  anchorMs: number,
  projectId: string,
): string | null {
  if (!Number.isSafeInteger(anchorMs) || anchorMs < 0) return null;
  if (!projectId) return null;
  const url = dashboardBaseUrl(dashboardUrl);
  if (!url) return null;
  const basePath = url.pathname === '/' ? '' : url.pathname;
  url.pathname = `${basePath}/sessions/${encodeURIComponent(sessionId)}`;
  url.search = `?t=${anchorMs}&project_id=${encodeURIComponent(projectId)}`;
  return url.toString();
}

function latestChecks(evidence: EvidenceRecord): Map<string, EvidenceRecord['checks'][number]> {
  const latest = new Map<string, EvidenceRecord['checks'][number]>();
  for (const check of evidence.checks) latest.set(check.name, check);
  return latest;
}

/** Evidence-backed verification claims in deliberate reader-facing order. */
export function verificationClaims(evidence: EvidenceRecord | null | undefined): string[] {
  if (!evidence) return [];
  const latest = latestChecks(evidence);
  const claims: string[] = [];
  const baselineOutcome = latest.get('suite_baseline')?.outcome;
  if (
    latest.get('suite_post_patch')?.outcome === 'passed' &&
    (baselineOutcome === 'passed' || baselineOutcome === 'failed')
  ) {
    claims.push('no new test failures compared with the pre-fix baseline');
  }
  if (latest.get('build')?.outcome === 'passed') claims.push('build passed');
  if (latest.get('repro_red')?.outcome === 'passed') {
    claims.push('the reproduction failed before the fix');
  }
  if (latest.get('repro_green')?.outcome === 'passed') {
    claims.push('the reproduction passed with the fix');
  }
  if (latest.get('repro_reversal')?.outcome === 'passed') {
    claims.push('the reproduction failed again when the fix was removed');
  }
  return claims;
}

function wrapParagraph(paragraph: string, width = 72): string {
  const words = paragraph.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

export function renderCommitMessage(
  narrative: FixNarrative,
  evidence: EvidenceRecord | null | undefined,
  incidentUrl: string | null,
): string {
  const sections = [
    normalizeSubject(narrative.subject),
    wrapParagraph(normalizeProse(narrative.whatHappened, PROSE_LIMITS.whatHappened)),
    wrapParagraph(normalizeProse(narrative.whyItBroke, PROSE_LIMITS.whyItBroke)),
    wrapParagraph(normalizeProse(narrative.fixApproach, PROSE_LIMITS.fixApproach)),
  ];
  const claims = verificationClaims(evidence);
  if (claims.length > 0) sections.push(wrapParagraph(`Verified: ${claims.join('; ')}.`));
  if (incidentUrl) {
    sections.push(`Full incident, session replay, and evidence:\n${incidentUrl}`);
  }
  return sections.filter(Boolean).join('\n\n');
}

export function renderPRSections(narrative: FixNarrative): PRNarrativeSections {
  const subject = normalizeSubject(narrative.subject);
  return {
    title: `🛡️ ${subject}`,
    whatHappened: normalizeProse(narrative.whatHappened, PROSE_LIMITS.whatHappened),
    whyItBroke: normalizeProse(narrative.whyItBroke, PROSE_LIMITS.whyItBroke),
    fixApproach: normalizeProse(narrative.fixApproach, PROSE_LIMITS.fixApproach),
  };
}
