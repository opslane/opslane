import type { Adjudication, EvidenceCitation } from '@opslane/shared';
import { CANDIDATE_ID, isMalformedRejection } from './diagnose-schema.js';

// Anchored like migration 045's SQL regex: a verdict that OPENS with a
// degenerate token is filler; one that merely mentions "placeholder" mid-prose
// (UI placeholder text is ordinary vocabulary for friction incidents) is not.
// The 2026-08-11 prod-copy rehearsal lost 1 of 8 real verdicts to the earlier
// unanchored form.
export const FILLER_VERDICT = /^\s*(placeholder|tbd|to be determined)\b/i;

/**
 * Machine codes for every way a submission can be incomplete. Typed so the
 * guidance map below is compile-time exhaustive — recovering the code by
 * splitting the prose reason is the substring-matching mistake this repo has
 * already paid for twice (see reason-codes.ts and classify.ts).
 */
export type IncompleteCode =
  | 'legacy_shape'
  | 'candidate_missing_id'
  | 'duplicate_candidate_id'
  | 'candidate_missing_citation'
  | 'rejection_malformed'
  | 'rejection_unknown_id'
  | 'duplicate_rejection_id'
  | 'empty_rejection_evidence'
  | 'missing_rejected_candidates'
  | 'no_files_read'
  | 'empty_verdict'
  | 'filler_verdict'
  | 'no_citations'
  | 'missing_brief'
  | 'filler_brief'
  | 'citation_malformed'
  | 'citation_missing_link'
  | 'citation_unresolvable'
  | 'citation_not_read';

export type VerdictValidation =
  | { status: 'valid' }
  | { status: 'incomplete'; code: IncompleteCode; reason: string };

export interface VerdictForValidation {
  causeText: string;
  claimsCodeCause: boolean;
  evidence: EvidenceCitation[];
  agentTaskBrief: string | null;
  filesRead: string[];
}

function incomplete(code: IncompleteCode, detail: string): VerdictValidation {
  return { status: 'incomplete', code, reason: `${code}: ${detail}` };
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
      return incomplete('legacy_shape', 'submission omitted rejected_candidates and candidate ids');
    }
    return { status: 'valid' };
  }

  const ids = new Set<string>();
  for (const candidate of adjudication.candidates_considered) {
    if (!candidate.id || !CANDIDATE_ID.test(candidate.id)) {
      return incomplete('candidate_missing_id', `${candidate.statement.slice(0, 80)}`);
    }
    if (ids.has(candidate.id)) return incomplete('duplicate_candidate_id', `${candidate.id}`);
    ids.add(candidate.id);

    const local = candidate.kind === 'local_code' || candidate.kind === 'configuration';
    if (local && !candidate.citation) {
      return incomplete('candidate_missing_citation', `${candidate.id}`);
    }
  }

  const seenRejections = new Set<string>();
  for (const rejection of adjudication.rejected_candidates ?? []) {
    if (isMalformedRejection(rejection)) {
      return incomplete('rejection_malformed', 'entry with empty id or citation');
    }
    if (!ids.has(rejection.id)) return incomplete('rejection_unknown_id', `${rejection.id}`);
    if (seenRejections.has(rejection.id)) {
      return incomplete('duplicate_rejection_id', `${rejection.id}`);
    }
    seenRejections.add(rejection.id);
    if (!rejection.evidence.trim()) {
      return incomplete('empty_rejection_evidence', `${rejection.id}`);
    }
  }

  // Checked after the per-candidate rules so the most specific defect reports
  // first. A submission carrying ids/citations but no rejected_candidates
  // array would otherwise pass here and still route down classify.ts's legacy
  // substring path — quietly erasing the grounding gate. Half a new shape is
  // not a shape.
  if (adjudication.rejected_candidates === undefined) {
    return incomplete('missing_rejected_candidates', 'structural candidates require a rejected_candidates array');
  }

  return { status: 'valid' };
}

const CITATION_SHAPE =
  'a citation is {path, line, quote} where quote is 8-300 characters copied verbatim from near that line ' +
  'in a file you actually read';

const CANDIDATE_ID_GUIDANCE =
  'give every candidate a unique id matching "c1", "c2", … and reference those ids in rejected_candidates.';
const REJECTION_GUIDANCE =
  `each rejection must name an existing candidate id exactly once, with non-empty evidence and a valid citation (${CITATION_SHAPE}).`;
const EVIDENCE_GUIDANCE =
  'the evidence array must cite at least one file you read with read_file, using its exact repository path, ' +
  'and each entry needs a non-empty detail and symptomLink.';
const FILLER_GUIDANCE = 'state the actual cause; placeholder text is rejected.';

/**
 * Per-code instruction the model can act on when its submission is handed back
 * for correction. The reason strings are forensic labels; alone they tell the
 * model what failed but not what a passing submission looks like. A Record so
 * adding an IncompleteCode without guidance is a compile error, not a silent
 * fall-through to an instruction the model cannot follow.
 */
const RESUBMIT_GUIDANCE: Record<IncompleteCode, string> = {
  candidate_missing_citation:
    `every local_code or configuration candidate must carry a valid citation (${CITATION_SHAPE}). ` +
    'A citation whose quote is too short, too long, or not verbatim is dropped and counts as missing. ' +
    'Add a real citation to that candidate, or change its kind if it does not point at local code.',
  candidate_missing_id: CANDIDATE_ID_GUIDANCE,
  duplicate_candidate_id: CANDIDATE_ID_GUIDANCE,
  missing_rejected_candidates: 'include a rejected_candidates array; pass [] if you reject nothing.',
  rejection_malformed: REJECTION_GUIDANCE,
  rejection_unknown_id: REJECTION_GUIDANCE,
  duplicate_rejection_id: REJECTION_GUIDANCE,
  empty_rejection_evidence: REJECTION_GUIDANCE,
  legacy_shape: 'resubmit with candidate ids and a rejected_candidates array.',
  no_files_read:
    'read the files that support your conclusion with read_file first — only files opened with read_file ' +
    'count as read — then resubmit citing them.',
  no_citations: EVIDENCE_GUIDANCE,
  citation_malformed: EVIDENCE_GUIDANCE,
  citation_missing_link: EVIDENCE_GUIDANCE,
  citation_unresolvable: EVIDENCE_GUIDANCE,
  citation_not_read: EVIDENCE_GUIDANCE,
  missing_brief:
    'a local code cause needs agent_task_brief: a self-contained markdown brief (symptom, files, cause, change, verification).',
  empty_verdict: FILLER_GUIDANCE,
  filler_verdict: FILLER_GUIDANCE,
  filler_brief: FILLER_GUIDANCE,
};

/** The full corrective message for one rejected-submission defect. */
export function resubmitGuidance(code: IncompleteCode, reason: string): string {
  return `${reason} — ${RESUBMIT_GUIDANCE[code]}`;
}

export function validateVerdict(
  verdict: VerdictForValidation,
  resolvePath: (path: string) => string | null,
): VerdictValidation {
  if (verdict.filesRead.length < 1) {
    return incomplete('no_files_read', 'the investigation read no repository files');
  }
  if (!verdict.causeText.trim()) {
    return incomplete('empty_verdict', 'cause text is empty');
  }
  if (FILLER_VERDICT.test(verdict.causeText)) {
    return incomplete('filler_verdict', 'cause text matches a placeholder pattern');
  }
  if (verdict.evidence.length === 0) {
    return incomplete('no_citations', 'the verdict contains no evidence citations');
  }
  if (verdict.claimsCodeCause && !verdict.agentTaskBrief?.trim()) {
    return incomplete('missing_brief', 'a code cause requires an agent task brief');
  }
  if (verdict.agentTaskBrief && FILLER_VERDICT.test(verdict.agentTaskBrief)) {
    return incomplete('filler_brief', 'the agent task brief matches a placeholder pattern');
  }

  const resolvedReads = new Set(
    verdict.filesRead
      .map((path) => resolvePath(path))
      .filter((path): path is string => path !== null),
  );
  for (const citation of verdict.evidence) {
    const path = citation.path.trim();
    if (!path) {
      return incomplete('citation_malformed', 'citation path is empty');
    }
    if (!citation.detail.trim() || !citation.symptomLink.trim()) {
      return incomplete('citation_missing_link', `${path} must include detail and symptom link`);
    }
    const resolved = resolvePath(path);
    if (resolved === null) {
      return incomplete('citation_unresolvable', `${path} does not resolve to a repository file`);
    }
    if (!resolvedReads.has(resolved)) {
      return incomplete('citation_not_read', `${path} was not read during the investigation`);
    }
  }

  return { status: 'valid' };
}
