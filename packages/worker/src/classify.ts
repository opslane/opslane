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
  fileExists: (path: string) => boolean,
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

  if (!fileExists(location.path)) {
    return {
      outcome: 'needs_more_context',
      reason: `The adjudication cites ${location.path}, which does not exist in the checked-out repository`,
      confidence: 'low',
    };
  }

  if (!isInsideFixSurface(location.path, surface)) {
    return {
      outcome: 'not_actionable',
      reason: `The cause is at ${adjudication.cause_location}, which is outside the configured fix surface`,
      confidence: confidenceFor(adjudication.evidence_strength),
    };
  }

  return {
    outcome: 'code_fix',
    reason: `The cause is at ${adjudication.cause_location}`,
    confidence: confidenceFor(adjudication.evidence_strength),
  };
}
