import type { Adjudication, EvidenceCitation } from '@opslane/shared';
import { CANDIDATE_ID, isMalformedRejection } from './diagnose-schema.js';

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
export function validateAdjudicationShape(
  adjudication: Adjudication,
  options?: {
    /**
     * Refuse legacy shapes outright. The live investigation sets this: its
     * strict tool schema always requires the structural fields, so a legacy
     * shape arriving there means the submission dodged the schema — and
     * letting it fall through to the weaker substring-rejection path would
     * quietly disable the grounding gate. Legacy shapes stay valid for the
     * decline adapter and for replaying stored rows.
     */
    requireStructuralShape?: boolean;
  },
): VerdictValidation {
  const isNewShape =
    adjudication.rejected_candidates !== undefined ||
    adjudication.candidates_considered.some((candidate) =>
      candidate.id !== undefined || candidate.citation !== undefined);
  if (!isNewShape) {
    if (options?.requireStructuralShape) {
      return incomplete('legacy_shape: submission omitted rejected_candidates and candidate ids');
    }
    return { status: 'valid' };
  }

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
    if (isMalformedRejection(rejection)) {
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

  // Checked after the per-candidate rules so the most specific defect reports
  // first. A submission carrying ids/citations but no rejected_candidates
  // array would otherwise pass here and still route down classify.ts's legacy
  // substring path — quietly erasing the grounding gate. Half a new shape is
  // not a shape.
  if (adjudication.rejected_candidates === undefined) {
    return incomplete('missing_rejected_candidates: structural candidates require a rejected_candidates array');
  }

  return { status: 'valid' };
}

/**
 * Turn a validator reason code into an instruction the model can act on when
 * the submission is handed back for correction. The reason strings above are
 * forensic labels; alone they tell the model what failed but not what a
 * passing submission looks like.
 */
export function resubmitGuidance(reason: string): string {
  const code = reason.split(':')[0]?.trim() ?? '';
  const citationShape =
    'a citation is {path, line, quote} where quote is 8-300 characters copied verbatim from near that line ' +
    'in a file you actually read';
  switch (code) {
    case 'candidate_missing_citation':
      return `${reason} — every local_code or configuration candidate must carry a valid citation (${citationShape}). ` +
        'A citation whose quote is too short, too long, or not verbatim is dropped and counts as missing. ' +
        'Add a real citation to that candidate, or change its kind if it does not point at local code.';
    case 'candidate_missing_id':
    case 'duplicate_candidate_id':
      return `${reason} — give every candidate a unique id matching "c1", "c2", … and reference those ids in rejected_candidates.`;
    case 'missing_rejected_candidates':
      return `${reason} — include a rejected_candidates array; pass [] if you reject nothing.`;
    case 'rejection_malformed':
    case 'rejection_unknown_id':
    case 'duplicate_rejection_id':
    case 'empty_rejection_evidence':
      return `${reason} — each rejection must name an existing candidate id exactly once, with non-empty evidence and a valid citation (${citationShape}).`;
    case 'legacy_shape':
      return `${reason} — resubmit with candidate ids and a rejected_candidates array.`;
    case 'no_citations':
    case 'citation_malformed':
    case 'citation_missing_link':
    case 'citation_unresolvable':
    case 'citation_not_read':
      return `${reason} — the evidence array must cite at least one file you read with read_file, using its exact repository path, and each entry needs a non-empty detail and symptomLink.`;
    case 'missing_brief':
      return `${reason} — a local code cause needs agent_task_brief: a self-contained markdown brief (symptom, files, cause, change, verification).`;
    case 'empty_verdict':
    case 'filler_verdict':
    case 'filler_brief':
      return `${reason} — state the actual cause; placeholder text is rejected.`;
    default:
      return reason;
  }
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
