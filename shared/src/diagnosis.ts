/** The primary artifact of an investigation. Routing is derived from it in code. */
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
