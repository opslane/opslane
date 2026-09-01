import type { NarrativeObservation } from '@opslane/shared';
import { normalizePageUrl, observationFingerprint } from '../friction/fingerprint.js';
import type { ObservationSignalRow } from '../friction/persist.js';

export const NARRATIVE_RULE_VERSION = 7;

export interface CompactTimeline {
  startTs: number;
  lines: Array<{ t: string; s: string | null; r: string; a: number | null; k?: 'idle' }>;
}

export function resolveAnchor(
  evidenceLines: string[],
  timeline: CompactTimeline,
): { route: string; selector: string | null } {
  let route = '';
  let selector: string | null = null;
  for (const evidenceLine of evidenceLines) {
    const index = Number(evidenceLine.slice(1)) - 1;
    const line = timeline.lines[index];
    if (!line || line.k === 'idle') continue;
    if (!route) route = line.r;
    if (!selector && line.s) selector = line.s;
    if (route && selector) break;
  }
  return { route, selector };
}

export function buildSignalRows(
  timeline: CompactTimeline,
  observations: NarrativeObservation[],
): ObservationSignalRow[] {
  const rows = new Map<string, ObservationSignalRow>();
  const severityRank = { low: 0, medium: 1, high: 2 } as const;
  for (const observation of observations) {
    const { route, selector } = resolveAnchor(observation.evidenceLines, timeline);
    const normalizedRoute = normalizePageUrl(route);
    const fingerprint = observationFingerprint(observation.category, selector, normalizedRoute);
    const firstLine = observation.evidenceLines
      .map((evidenceLine) => timeline.lines[Number(evidenceLine.slice(1)) - 1])
      .find((line) => line !== undefined && line.k !== 'idle');
    const occurredAt = firstLine?.a ?? timeline.startTs;
    const existing = rows.get(fingerprint);
    if (existing) {
      existing.occurrenceCount += 1;
      existing.occurredAts.push(occurredAt);
      if (severityRank[observation.severity] > severityRank[existing.severity]) {
        existing.severity = observation.severity;
        existing.what = observation.what;
      }
      continue;
    }
    rows.set(fingerprint, {
      signalType: observation.category,
      fingerprint,
      elementSelector: selector,
      pageUrlNormalized: normalizedRoute,
      occurredAts: [occurredAt],
      occurrenceCount: 1,
      what: observation.what,
      severity: observation.severity,
    });
  }
  return [...rows.values()];
}
