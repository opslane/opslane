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
  candidates_considered: Array<{ statement: string; kind: HypothesisKind }>;
  /** Other hypotheses with the specific evidence that rules each one out. */
  rejected: string[];
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
}

export type DiagnosisOutcome = 'code_fix' | 'not_actionable' | 'needs_more_context';
