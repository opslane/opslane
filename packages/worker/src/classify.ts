import type { Adjudication, DiagnosisOutcome } from '@opslane/shared';

export interface DerivedDecision {
  outcome: DiagnosisOutcome;
  reason: string;
  /**
   * Why this outcome, as a value rather than prose. An earlier version matched
   * substrings of `reason`, so rewording a message silently changed the reason
   * code written to the incident.
   *
   * This is a forensic label, not a routing input: callers branch on `outcome`.
   */
  basis:
    | 'no_adjudication'
    | 'insufficient_evidence'
    | 'unplaced_cause'
    | 'cause_outside_codebase'
    | 'unrejected_local_candidates'
    | 'uncitable_local_claim'
    | 'citation_unresolvable'
    | 'local_defect';
  /**
   * Only `high` opens a pull request unattended. It comes from the model's
   * judgement of verified evidence, not from counting fields: an earlier version
   * scored `high` for three repeated sentences plus any line number, which made
   * the gate cosmetic.
   */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Evidence strength decides what the pipeline may do, deterministically.
 * `suggestive` never acts alone: it lands at medium, which parks the incident
 * for a human to approve rather than opening a pull request.
 */
function confidenceFor(strength: Adjudication['evidence_strength']): 'high' | 'medium' | 'low' {
  if (strength === 'conclusive') return 'high';
  if (strength === 'suggestive') return 'medium';
  return 'low';
}

/**
 * Decide whether the diagnosis is good enough to act on, and where the cause is.
 * Pure: same inputs, same answer, no model and no I/O.
 *
 * This deliberately does NOT decide what the fix agent may write. That is
 * enforced at the point of mutation, because a check here would be a second,
 * weaker copy of the same boundary made minutes earlier.
 *
 * The gate that actually runs is `assertWritableSandboxPath`, called from
 * harness/tool-bridge.ts. It normalises lexically, which stops `..` traversal
 * out of the clone but cannot follow a symlink — a link inside the clone
 * pointing outside it still authorises the write, and containment for that case
 * is the sandbox itself. Naming it here rather than the realpath-based
 * `assertWritable` matters: that one is symlink-safe but has no caller, so
 * pointing a reader at it described a guarantee the shipped path does not make.
 */
export function deriveOutcome(
  adjudication: Adjudication | null,
  /**
   * Resolves a cited path to its canonical repository-relative path, or null if
   * it does not exist, is not a regular file, or escapes the clone. A citation
   * that resolves to nothing is an evidence defect: the model named a file that
   * is not there.
   */
  resolvePath: (cited: string) => string | null,
): DerivedDecision {
  if (!adjudication) {
    return {
      outcome: 'needs_more_context',
      reason: 'The investigation produced no adjudicated cause',
      basis: 'no_adjudication',
      confidence: 'low',
    };
  }

  // Insufficient evidence is a failure whatever the location says. Checked
  // before the location so a confident-looking path cannot rescue a run that
  // could not separate its own candidates.
  if (adjudication.evidence_strength === 'insufficient') {
    return {
      outcome: 'needs_more_context',
      reason: `The evidence did not separate the candidates: ${adjudication.reasoning}`,
      basis: 'insufficient_evidence',
      confidence: 'low',
    };
  }

  // Read the typed kind, do not pattern-match the prose. An earlier version
  // tested cause_location for URLs and hostnames, and discarded a correct
  // answer phrased "upstream API gateway / reverse proxy (not present in
  // repository)" because it matched no regex.
  if (adjudication.cause_kind === 'unknown') {
    return {
      outcome: 'needs_more_context',
      reason: `The adjudication did not place the cause: ${adjudication.reasoning}`,
      basis: 'unplaced_cause',
      confidence: 'low',
    };
  }

  if (adjudication.cause_kind === 'external_system' || adjudication.cause_kind === 'data_or_input') {
    // We cannot verify from the repository that a remote service was slow. What
    // we can require is that the conclusion was reached against the local
    // alternatives rather than instead of them.
    //
    // An earlier version only checked `rejected` was non-empty, so rejecting one
    // irrelevant candidate satisfied it. Check each local candidate by name.
    const locals = adjudication.candidates_considered.filter(
      (candidate) => candidate.kind === 'local_code' || candidate.kind === 'configuration',
    );
    const rejectedText = adjudication.rejected.join('\n').toLowerCase();
    const unrejected = locals.filter((candidate) => !rejectedText.includes(candidate.statement.toLowerCase()));

    if (unrejected.length > 0) {
      return {
        outcome: 'needs_more_context',
        reason:
          `The investigation concluded the cause is external without rejecting ` +
          `${unrejected.map((c) => JSON.stringify(c.statement)).join(', ')}`,
        basis: 'unrejected_local_candidates',
        confidence: 'low',
      };
    }
    return {
      outcome: 'not_actionable',
      reason: `The cause is outside this codebase: ${adjudication.cause_locations[0]?.path ?? adjudication.best_supported}`,
      basis: 'cause_outside_codebase',
      confidence: confidenceFor(adjudication.evidence_strength),
    };
  }

  // The FIRST citation is the claim. Do not search the list for one that happens
  // to resolve: "any citation counts" was a real hole, and scanning past a bad
  // first entry reopens it in a different shape.
  //
  // `path` arrives structured and undecorated — the model puts explanations in
  // `note`. Regexing a path back out of free text discarded four correct
  // answers before the schema changed.
  const primary = adjudication.cause_locations[0];

  if (!primary) {
    return {
      outcome: 'needs_more_context',
      reason: `The investigation claims a ${adjudication.cause_kind} cause but cited no location`,
      basis: 'uncitable_local_claim',
      confidence: 'low',
    };
  }

  const resolved = resolvePath(primary.path);
  if (resolved === null) {
    return {
      outcome: 'needs_more_context',
      reason: `The investigation cites ${primary.path}, which does not resolve to a file in the checked-out repository`,
      basis: 'citation_unresolvable',
      confidence: 'low',
    };
  }

  return {
    outcome: 'code_fix',
    reason: `The cause is at ${resolved}`,
    basis: 'local_defect',
    confidence: confidenceFor(adjudication.evidence_strength),
  };
}
