import type { Adjudication, DiagnosisOutcome } from '@opslane/shared';
import { isInsideFixSurface, parseCauseLocation, type FixSurface } from './fix-surface.js';

export interface DerivedDecision {
  outcome: DiagnosisOutcome;
  reason: string;
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
  /**
   * How many hypotheses in the dossier claimed a cause in code we hold. Used to
   * require that an external conclusion was reached against them, not instead
   * of them.
   */
  localCandidates = 0,
): DerivedDecision {
  if (!adjudication) {
    return {
      outcome: 'needs_more_context',
      reason: 'The investigation produced no adjudicated cause',
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
      confidence: 'low',
    };
  }

  if (adjudication.cause_kind === 'external_system' || adjudication.cause_kind === 'data_or_input') {
    // A conclusion cannot be verified from the repository: we cannot prove a
    // remote service was slow. What we can require is that it was reached
    // against the alternatives rather than instead of them. Concluding
    // "external" while the dossier held a supported local candidate that was
    // never rejected is how a model escapes the work of reading the code.
    if (localCandidates > 0 && adjudication.rejected.length === 0) {
      return {
        outcome: 'needs_more_context',
        reason:
          `The adjudication concluded the cause is external without rejecting ` +
          `${localCandidates} local candidate(s) the dossier raised`,
        confidence: 'low',
      };
    }
    return {
      outcome: 'not_actionable',
      reason: `The cause is outside this codebase: ${adjudication.cause_location || adjudication.best_supported}`,
      confidence: confidenceFor(adjudication.evidence_strength),
    };
  }

  // local_code and configuration claim a defect we hold, so the citation has to
  // resolve to a real file inside the surface before it authorises anything.
  const location = parseCauseLocation(adjudication.cause_location);

  if (location.kind !== 'repo_path') {
    return {
      outcome: 'needs_more_context',
      reason:
        `The adjudication claims a ${adjudication.cause_kind} cause but did not cite a checkable ` +
        `file: ${JSON.stringify(adjudication.cause_location)}`,
      confidence: 'low',
    };
  }

  const resolved = resolvePath(location.path);
  if (resolved === null) {
    return {
      outcome: 'needs_more_context',
      reason: `The adjudication cites ${location.path}, which does not resolve to a file in the checked-out repository`,
      confidence: 'low',
    };
  }

  // Match the glob against the RESOLVED path. Matching the cited string is what
  // let a symlink inside the surface authorise a write outside it.
  if (!isInsideFixSurface(resolved, surface)) {
    const via = resolved === location.path ? '' : ` (resolves to ${resolved})`;
    return {
      outcome: 'not_actionable',
      reason: `The cause is at ${adjudication.cause_location}${via}, which is outside the configured fix surface`,
      confidence: confidenceFor(adjudication.evidence_strength),
    };
  }

  return {
    outcome: 'code_fix',
    reason: `The cause is at ${resolved}`,
    confidence: confidenceFor(adjudication.evidence_strength),
  };
}
