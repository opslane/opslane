import { createHash } from 'node:crypto';
import type { NarrativeObservation } from '@opslane/shared';
import { normalizePageUrl } from '../friction/fingerprint.js';
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

/** Use created_at::text from Postgres so microseconds survive every read path. */
export function deriveNarrativeId(sessionId: string, createdAt: string, promptVersion: number): string {
  const hex = createHash('sha256').update(`${sessionId}|${promptVersion}|${createdAt}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildSignalRows(
  timeline: CompactTimeline,
  observations: NarrativeObservation[],
  sessionId: string,
  narrativeId: string,
): ObservationSignalRow[] {
  return observations.map((observation) => {
    const { route, selector } = resolveAnchor(observation.evidenceLines, timeline);
    const firstLine = observation.evidenceLines
      .map((evidenceLine) => timeline.lines[Number(evidenceLine.slice(1)) - 1])
      .find((line) => line !== undefined && line.k !== 'idle');
    const occurredAt = firstLine?.a ?? timeline.startTs;
    return {
      signalType: 'other',
      fingerprint: createHash('sha256').update(`${sessionId}|${narrativeId}|${observation.id}`).digest('hex').slice(0, 32),
      observationId: observation.id,
      narrativeId,
      evidenceLines: observation.evidenceLines,
      elementSelector: selector,
      pageUrlNormalized: normalizePageUrl(route),
      occurredAts: [occurredAt],
      occurrenceCount: 1,
      what: observation.what,
      ...(observation.severity === undefined ? {} : { severity: observation.severity }),
    };
  });
}
