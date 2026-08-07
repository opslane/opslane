import type { Diagnosis } from '@opslane/shared';
import { strings } from './diagnose-schema.js';

/**
 * Reconstitutes a persisted Diagnosis when a fix job is claimed.
 *
 * The investigation no longer produces this shape directly. It is built in code
 * from the adjudicated winner (see investigate.ts) and stored on the fix job
 * payload; this is the read-back for that payload, so it stays permissive about
 * fields the writer may not have set.
 */
export function parseDiagnosis(raw: Record<string, unknown>): Diagnosis | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const description = typeof raw['one_line_description'] === 'string' ? raw['one_line_description'].trim() : '';
  const location = typeof raw['cause_location'] === 'string' ? raw['cause_location'].trim() : '';
  if (!description || !location) return null;

  return {
    one_line_description: description,
    why_chain: strings(raw['why_chain']),
    reproduction_steps: strings(raw['reproduction_steps']),
    cause_location: location,
  };
}
