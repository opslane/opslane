import type { Diagnosis, DiagnosisOutcome } from '@opslane/shared';
import { isInsideFixSurface, parseCauseLocation, type FixSurface } from './fix-surface.js';

export interface DerivedDecision {
  outcome: DiagnosisOutcome;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

export const HIGH_CONFIDENCE_MIN_CHAIN = 3;

function deriveConfidence(diagnosis: Diagnosis, line: number | undefined): 'high' | 'medium' {
  return diagnosis.why_chain.length >= HIGH_CONFIDENCE_MIN_CHAIN &&
    diagnosis.reproduction_steps.length >= 1 &&
    line !== undefined
    ? 'high'
    : 'medium';
}

/** Purely derive routing from diagnosis facts and the configured fix surface. */
export function deriveOutcome(
  diagnosis: Diagnosis | null,
  surface: FixSurface,
  fileExists: (path: string) => boolean,
): DerivedDecision {
  if (!diagnosis) {
    return {
      outcome: 'needs_more_context',
      reason: 'The investigation produced no usable diagnosis',
      confidence: 'low',
    };
  }

  const location = parseCauseLocation(diagnosis.cause_location);
  if (location.kind === 'vague') {
    return {
      outcome: 'needs_more_context',
      reason: `The diagnosis did not name a checkable location: ${JSON.stringify(diagnosis.cause_location)}`,
      confidence: 'low',
    };
  }

  if (location.kind === 'external_system') {
    return {
      outcome: 'not_actionable',
      reason: `The cause is outside this codebase: ${diagnosis.cause_location}`,
      confidence: deriveConfidence(diagnosis, undefined),
    };
  }

  if (!fileExists(location.path)) {
    return {
      outcome: 'needs_more_context',
      reason: `The diagnosis cites ${location.path}, which does not exist in the checked-out repository`,
      confidence: 'low',
    };
  }

  if (!isInsideFixSurface(location.path, surface)) {
    return {
      outcome: 'not_actionable',
      reason: `The cause is at ${diagnosis.cause_location}, which is outside the configured fix surface`,
      confidence: deriveConfidence(diagnosis, location.line),
    };
  }

  return {
    outcome: 'code_fix',
    reason: `The cause is at ${diagnosis.cause_location}`,
    confidence: deriveConfidence(diagnosis, location.line),
  };
}
