import type { Adjudication, EvidenceCitation } from '@opslane/shared';
import { CANDIDATE_ID } from './diagnose-schema.js';

// Anchored like migration 045's SQL regex: a verdict that OPENS with a
// degenerate token is filler; one that merely mentions "placeholder" mid-prose
// (UI placeholder text is ordinary vocabulary for friction incidents) is not.
// The 2026-08-11 prod-copy rehearsal lost 1 of 8 real verdicts to the earlier
// unanchored form.
export const FILLER_VERDICT = /^\s*(placeholder|tbd|to be determined)\b/i;

export type VerdictValidation =
  | { status: 'valid' }
  | { status: 'incomplete'; reason: string };

export interface VerdictForValidation {
  causeText: string;
  claimsCodeCause: boolean;
  evidence: EvidenceCitation[];
  agentTaskBrief: string | null;
  filesRead: string[];
}

function incomplete(reason: string): VerdictValidation {
  return { status: 'incomplete', reason };
}

/**
 * Cross-field rules the submission JSON schema cannot express. Local candidates
 * must be identifiable and grounded; rejections must reference real candidates.
 * Non-local candidates and legacy shapes (no ids) pass untouched.
 */
export function validateAdjudicationShape(adjudication: Adjudication): VerdictValidation {
  const isNewShape =
    adjudication.rejected_candidates !== undefined ||
    adjudication.candidates_considered.some((candidate) =>
      candidate.id !== undefined || candidate.citation !== undefined);
  if (!isNewShape) return { status: 'valid' };

  const ids = new Set<string>();
  for (const candidate of adjudication.candidates_considered) {
    if (!candidate.id || !CANDIDATE_ID.test(candidate.id)) {
      return incomplete(`candidate_missing_id: ${candidate.statement.slice(0, 80)}`);
    }
    if (ids.has(candidate.id)) return incomplete(`duplicate_candidate_id: ${candidate.id}`);
    ids.add(candidate.id);

    const local = candidate.kind === 'local_code' || candidate.kind === 'configuration';
    if (local && !candidate.citation) {
      return incomplete(`candidate_missing_citation: ${candidate.id}`);
    }
  }

  const seenRejections = new Set<string>();
  for (const rejection of adjudication.rejected_candidates ?? []) {
    if (!rejection.id || !rejection.citation.path || !rejection.citation.quote) {
      return incomplete('rejection_malformed: entry with empty id or citation');
    }
    if (!ids.has(rejection.id)) return incomplete(`rejection_unknown_id: ${rejection.id}`);
    if (seenRejections.has(rejection.id)) {
      return incomplete(`duplicate_rejection_id: ${rejection.id}`);
    }
    seenRejections.add(rejection.id);
    if (!rejection.evidence.trim()) {
      return incomplete(`empty_rejection_evidence: ${rejection.id}`);
    }
  }

  return { status: 'valid' };
}

export function validateVerdict(
  verdict: VerdictForValidation,
  resolvePath: (path: string) => string | null,
): VerdictValidation {
  if (verdict.filesRead.length < 1) {
    return incomplete('no_files_read: the investigation read no repository files');
  }
  if (!verdict.causeText.trim()) {
    return incomplete('empty_verdict: cause text is empty');
  }
  if (FILLER_VERDICT.test(verdict.causeText)) {
    return incomplete('filler_verdict: cause text matches a placeholder pattern');
  }
  if (verdict.evidence.length === 0) {
    return incomplete('no_citations: the verdict contains no evidence citations');
  }
  if (verdict.claimsCodeCause && !verdict.agentTaskBrief?.trim()) {
    return incomplete('missing_brief: a code cause requires an agent task brief');
  }
  if (verdict.agentTaskBrief && FILLER_VERDICT.test(verdict.agentTaskBrief)) {
    return incomplete('filler_brief: the agent task brief matches a placeholder pattern');
  }

  const resolvedReads = new Set(
    verdict.filesRead
      .map((path) => resolvePath(path))
      .filter((path): path is string => path !== null),
  );
  for (const citation of verdict.evidence) {
    const path = citation.path.trim();
    if (!path) {
      return incomplete('citation_malformed: citation path is empty');
    }
    if (!citation.detail.trim() || !citation.symptomLink.trim()) {
      return incomplete(`citation_missing_link: ${path} must include detail and symptom link`);
    }
    const resolved = resolvePath(path);
    if (resolved === null) {
      return incomplete(`citation_unresolvable: ${path} does not resolve to a repository file`);
    }
    if (!resolvedReads.has(resolved)) {
      return incomplete(`citation_not_read: ${path} was not read during the investigation`);
    }
  }

  return { status: 'valid' };
}
