/**
 * Where a candidate cause lives. `local_code` does not mean fixable: the code
 * that observes a failure is rarely the code that caused it, and the fix
 * surface decides what we may change.
 */
export type HypothesisKind =
  | 'local_code'
  | 'external_system'
  | 'data_or_input'
  | 'configuration'
  | 'unknown';

/** One candidate cause, with the evidence for and against it. */
export interface Hypothesis {
  /** Under 25 words. */
  statement: string;
  kind: HypothesisKind;
  /** A repository file and line when the cause is code, otherwise the system responsible. */
  location: string;
  /**
   * Each entry quotes observed evidence: a breadcrumb field and value, a span
   * between timestamps, a stack frame, or a file and line actually opened.
   */
  supports: string[];
  /** Evidence arguing against this hypothesis. Written only after looking for it. */
  contradicts: string[];
  /** The observation that would confirm or kill this candidate. */
  would_be_settled_by: string;
}

/**
 * What the first agent produces. Every cause the evidence is consistent with,
 * with no choice made between them. Choosing is the adjudicator's job.
 */
export interface Dossier {
  hypotheses: Hypothesis[];
}

/**
 * How well the evidence supports the winning hypothesis. This gates what the
 * pipeline is allowed to do, so it is judged by a second agent against evidence
 * it verified itself rather than counted from field lengths.
 */
export type EvidenceStrength = 'conclusive' | 'suggestive' | 'insufficient';

/** What the second agent produces after checking the dossier's citations. */
export interface Adjudication {
  /** The statement of the hypothesis the evidence best supports. */
  best_supported: string;
  /** Which cited evidence was verified, and anything that did not check out. */
  evidence_check: string;
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
   */
  cause_locations: string[];
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
  /** Extracted in code from breadcrumbs, never written by the model. */
  failing_request?: FailingRequest | null;
}

export interface FailingRequest {
  method: string;
  url: string;
  status?: number;
  /** How many matching requests were seen after collapsing repeats. */
  count: number;
}

export type DiagnosisOutcome = 'code_fix' | 'not_actionable' | 'needs_more_context';
