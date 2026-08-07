import type { Adjudication, DiagnosisOutcome } from '@opslane/shared';
import { isInsideFixSurface, parseCauseLocation, type FixSurface } from './fix-surface.js';

export interface DerivedDecision {
  outcome: DiagnosisOutcome;
  reason: string;
  /**
   * Why this outcome, as a value rather than prose. Callers pick reason codes
   * from this. An earlier version matched substrings of `reason`, so rewording
   * a message silently changed the reason code written to the incident.
   */
  basis:
    | 'no_adjudication'
    | 'insufficient_evidence'
    | 'unplaced_cause'
    | 'cause_outside_codebase'
    | 'unrejected_local_candidates'
    | 'uncitable_local_claim'
    | 'citation_unresolvable'
    | 'no_fix_surface_configured'
    | 'primary_outside_fix_surface'
    | 'in_surface_defect';
  /**
   * Only `high` opens a pull request unattended. It now comes from the
   * adjudicator's judgement of verified evidence, not from counting fields: an
   * earlier version scored `high` for three repeated sentences plus any line
   * number, which made the gate cosmetic.
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

/** Routing policy, passed in so this function stays pure and testable. */
export interface RoutingPolicy {
  /**
   * Whether a project with no configured fix surface may still be fixed. A null
   * glob list makes the whole repository writable, so this defaults to false at
   * the call site and exists as an explicit escape hatch, not an accident.
   */
  allowUnrestrictedSurface: boolean;
}

/**
 * Derive routing from the adjudicated cause and the configured fix surface.
 * Pure: same inputs, same answer, no model and no I/O. `fileExists` is injected
 * so the citation check stays testable, and it must resolve symlinks before
 * answering, or a link inside the surface authorises writes outside it.
 */
export function deriveOutcome(
  adjudication: Adjudication | null,
  surface: FixSurface,
  /**
   * Resolves a cited path to its canonical repository-relative path, or null if
   * it does not exist, is not a regular file, or escapes the clone.
   *
   * It returns the path rather than a boolean on purpose. An earlier version
   * used it only for existence and then matched the glob against the string the
   * model supplied, which left the symlink hole open: `client/vendor/app.py`
   * resolved to `server/app.py` and still matched a `client/**` surface.
   */
  resolvePath: (cited: string) => string | null,
  policy: RoutingPolicy,
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
    // The previous version only checked `rejected` was non-empty, so rejecting
    // one irrelevant candidate satisfied it. Check each local candidate by name.
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
      reason: `The cause is outside this codebase: ${adjudication.cause_locations[0] ?? adjudication.best_supported}`,
      basis: 'cause_outside_codebase',
      confidence: confidenceFor(adjudication.evidence_strength),
    };
  }

  // A project with no configured surface makes the whole repository writable.
  // That was previously a log line standing next to an authorised fix.
  if (surface.globs === null && !policy.allowUnrestrictedSurface) {
    return {
      outcome: 'needs_more_context',
      reason: 'No fix surface is configured for this project, so no path is authorised for writing',
      basis: 'no_fix_surface_configured',
      confidence: 'low',
    };
  }

  // The FIRST citation is the claim. Do not search the list for one that
  // happens to parse or happens to land in-surface: "any citation authorises"
  // is the hole this replaces, and scanning past an unparseable first entry
  // reopens it in a different shape.
  const primary = parseCauseLocation(adjudication.cause_locations[0] ?? '');

  if (primary.kind !== 'repo_path') {
    return {
      outcome: 'needs_more_context',
      reason:
        `The investigation claims a ${adjudication.cause_kind} cause but its first citation ` +
        `is not a checkable file: ${JSON.stringify(adjudication.cause_locations[0] ?? null)}`,
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

  // Match the glob against the RESOLVED path, never the cited string: a symlink
  // inside the surface pointing outside it would otherwise authorise the write.
  if (!isInsideFixSurface(resolved, surface)) {
    return {
      outcome: 'not_actionable',
      reason: `The primary cause is at ${resolved}, outside the configured fix surface`,
      basis: 'primary_outside_fix_surface',
      confidence: confidenceFor(adjudication.evidence_strength),
    };
  }

  return {
    outcome: 'code_fix',
    reason: `The cause is at ${resolved}`,
    basis: 'in_surface_defect',
    confidence: confidenceFor(adjudication.evidence_strength),
  };
}
