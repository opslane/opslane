/**
 * Where a candidate cause lives. `local_code` does not mean fixable: the code
 * that observes a failure is rarely the code that caused it.
 */
export type HypothesisKind =
  | 'local_code'
  | 'external_system'
  | 'data_or_input'
  | 'configuration'
  | 'unknown';

/**
 * How well the evidence supports the winning hypothesis. This gates what the
 * pipeline is allowed to do, so it is judged against evidence the investigation
 * verified itself rather than counted from field lengths.
 */
export type EvidenceStrength = 'conclusive' | 'suggestive' | 'insufficient';

/**
 * One place a cause lives.
 *
 * `path` is repository-relative and carries no decoration: no line suffix, no
 * parenthetical, no prose. Anything the model wants to say about the location
 * goes in `note`, which routing ignores.
 */
export interface CauseLocation {
  /** Repository-relative path, e.g. "packages/ui/src/nav/nav-mobile.tsx". */
  path: string;
  /** 1-based line, when the model can name one. */
  line?: number;
  /** Why this location matters. Never parsed. */
  note?: string;
}

export interface EvidenceCitation {
  /** Repository-relative path, undecorated (same rule as CauseLocation.path). */
  path: string;
  /** What was found at this path. */
  detail: string;
  /** How that finding links to the customer-visible symptom. */
  symptomLink: string;
}

/**
 * A quote anchored to a place in the repository. The grounding predicate is:
 * `path` resolves inside the clone AND `quote` appears within ±5 lines of
 * `line` at the investigated commit. Quote-anywhere-in-file is NOT grounding —
 * a fabricated hypothesis can quote an unrelated real line.
 *
 * The submission parser may temporarily create an empty sentinel for a
 * malformed rejection. It is rejected by `validateAdjudicationShape` before
 * persistence and is not a valid stored `GroundedQuote`.
 */
export interface GroundedQuote {
  /** Repository-relative path, undecorated (same rule as CauseLocation.path). */
  path: string;
  /** 1-based line the quote lives at. */
  line: number;
  /** Verbatim excerpt, 1–300 chars after trim, non-whitespace. */
  quote: string;
}

/** How routing disposed of one local candidate. Persisted for forensics. */
export type CandidateDisposition = 'rejected' | 'ungrounded' | 'live';

/** What the investigation submits after checking its own citations. */
export interface Adjudication {
  /** The statement of the hypothesis the evidence best supports. */
  best_supported: string;
  /** Which cited evidence was verified, and anything that did not check out. */
  evidence_check: string;
  /**
   * Every cause the investigation weighed, including the winner.
   *
   * Routing needs this to check that an "external system" conclusion was
   * reached *against* the local candidates rather than instead of them. The
   * submission is the only record that the alternatives were considered.
   */
  candidates_considered: Array<{
    statement: string;
    kind: HypothesisKind;
    /** Unique within this adjudication, format `c<n>`. Required at submission. */
    id?: string;
    /** Required at submission for kinds local_code/configuration. */
    citation?: GroundedQuote;
  }>;
  /** Other hypotheses with the specific evidence that rules each one out. Legacy prose; display-only. */
  rejected: string[];
  /**
   * Structural rejections. A rejection converts a candidate only if its own
   * citation passes the grounding predicate — prose alone converts nothing.
   */
  rejected_candidates?: Array<{ id: string; evidence: string; citation: GroundedQuote }>;
  evidence_strength: EvidenceStrength;
  /**
   * Where the winning cause lives, as a typed value rather than prose.
   * Routing reads this: an earlier version pattern-matched cause_location for
   * URLs and hostnames, and threw away a correct answer that happened to be
   * phrased "upstream API gateway / reverse proxy (not present in repository)".
   */
  cause_kind: HypothesisKind;
  /**
   * Every place the cause lives, most important first. A list because real
   * fixes touch more than one file, and because a single string kept
   * discarding correct answers that named two.
   *
   * Structured, not free text. Four separate correct answers were thrown away
   * by regexing a path back out of a string the model was free to decorate:
   * prose with no recognisable path, a line range, two files in one string, and
   * a trailing parenthetical. `note` exists because the model keeps appending
   * an explanation, and it needed somewhere to put it that is not the path.
   */
  cause_locations: CauseLocation[];
  /** Under 40 words. */
  reasoning: string;
  /** The why-chain of the winning hypothesis, carried through for the fix agent. */
  why_chain: string[];
  /** Steps reproducing the winning cause. What a human acts on when we open no PR. */
  reproduction_steps: string[];
  evidence?: EvidenceCitation[];
  agent_task_brief?: string;
}

/** The artifact handed to the fix agent. Built in code from the adjudication. */
export interface Diagnosis {
  /** Under 30 words. */
  one_line_description: string;
  /** Cause to effect, each entry under 15 words. */
  why_chain: string[];
  /** Each entry under 15 words. */
  reproduction_steps: string[];
  /** A repository file and line, or a description of the external system. */
  cause_location: string;
  evidence?: EvidenceCitation[];
  agentTaskBrief?: string;
  /** Commit whose repository contents were inspected for this diagnosis. */
  investigatedCommit?: string;
}

export type DiagnosisOutcome =
  | 'code_fix'
  | 'not_actionable'
  | 'needs_more_context'
  | 'incomplete';
