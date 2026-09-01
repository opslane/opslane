import { createHash } from 'node:crypto';
import type { FrictionCategory, NarrativeObservation, SessionNarrative } from '@opslane/shared';
import { FRICTION_CATEGORIES } from './categories.js';
import { extractJsonObject } from './client.js';
import type { RenderedTimeline } from './renderer.js';

export type ValidationResult =
  | { ok: true; narrative: SessionNarrative; droppedCitations: number }
  | { ok: false; reason: string };

const CATEGORY_SET: ReadonlySet<string> = new Set(FRICTION_CATEGORIES);
const SEVERITIES = new Set(['low', 'medium', 'high']);

export function validateNarrative(rawText: string, timeline: RenderedTimeline): ValidationResult {
  const extracted = extractJsonObject(rawText);
  if (!extracted) return { ok: false, reason: 'no JSON object in response' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch {
    return { ok: false, reason: 'invalid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not an object' };
  }
  const object = parsed as Record<string, unknown>;
  if (
    typeof object['user_goal'] !== 'string'
    || typeof object['narrative'] !== 'string'
    || !Array.isArray(object['observations'])
  ) {
    return { ok: false, reason: 'missing required fields' };
  }
  if (typeof object['notable'] !== 'boolean') return { ok: false, reason: 'notable must be boolean' };

  let droppedCitations = 0;
  const observations: NarrativeObservation[] = [];
  for (const [index, rawObservation] of object['observations'].entries()) {
    if (typeof rawObservation !== 'object' || rawObservation === null || Array.isArray(rawObservation)) {
      return { ok: false, reason: `observation ${index} not an object` };
    }
    const observation = rawObservation as Record<string, unknown>;
    const category = observation['category'];
    const what = observation['what'];
    const severity = observation['severity'];
    if (typeof category !== 'string' || !CATEGORY_SET.has(category)) {
      return { ok: false, reason: `observation ${index}: unknown category` };
    }
    if (typeof what !== 'string' || what.length === 0 || what.length > 400) {
      return { ok: false, reason: `observation ${index}: bad what` };
    }
    if (typeof severity !== 'string' || !SEVERITIES.has(severity)) {
      return { ok: false, reason: `observation ${index}: bad severity` };
    }
    // Citation lists are never a rejection reason: the model's token budget is
    // the real size bound, and a thorough response legitimately cites every
    // occurrence (a wall clicked 22 times has 22 relevant lines). Dedupe and
    // keep membership-valid ids; everything downstream uses only the first.
    const rawLines = Array.isArray(observation['evidence_lines'])
      ? observation['evidence_lines']
      : [];
    const evidenceLines: string[] = [];
    const seenLines = new Set<string>();
    for (const lineId of rawLines) {
      const match = typeof lineId === 'string' ? /^L(\d+)$/.exec(lineId) : null;
      const lineNumber = match ? Number(match[1]) : Number.NaN;
      if (Number.isInteger(lineNumber) && lineNumber >= 1 && lineNumber <= timeline.lines.length) {
        const canonical = `L${lineNumber}`;
        if (!seenLines.has(canonical)) {
          seenLines.add(canonical);
          evidenceLines.push(canonical);
        }
      } else {
        droppedCitations += 1;
      }
    }
    if (evidenceLines.length === 0) {
      if (rawLines.length === 0) droppedCitations += 1;
      continue;
    }
    observations.push({
      id: `${index}-${createHash('sha256').update(`${category}|${what}`).digest('hex').slice(0, 4)}`,
      category: category as FrictionCategory,
      what,
      evidenceLines,
      severity: severity as NarrativeObservation['severity'],
    });
  }

  return {
    ok: true,
    droppedCitations,
    narrative: {
      userGoal: object['user_goal'].slice(0, 400),
      narrative: object['narrative'].slice(0, 1_200),
      observations,
      notable: object['notable'],
    },
  };
}
