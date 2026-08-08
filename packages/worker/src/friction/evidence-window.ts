import type { SessionChunkEnvelope } from '@opslane/shared';
import { extractTelemetryEvents } from './analyzer.js';

export const EVIDENCE_WINDOW_MS = 15_000;
export const EVIDENCE_WINDOW_MAX_EVENTS = 40;

export interface WindowEvent {
  t: number;
  kind: 'page' | 'click' | 'request_start' | 'request_end' | 'form_submit';
  selector?: string;
  cursor?: string;
  url?: string;
  method?: string;
  status?: number;
  requestId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildEvidenceWindows(
  chunks: SessionChunkEnvelope[],
  occurredAts: number[],
): WindowEvent[][] {
  const all: WindowEvent[] = [];
  for (const chunk of chunks) {
    if (!Array.isArray(chunk.events)) continue;
    for (const value of chunk.events) {
      if (!isRecord(value) || typeof value['timestamp'] !== 'number') continue;
      const data = value['data'];
      if (value['type'] === 4 && isRecord(data) && typeof data['href'] === 'string') {
        all.push({ t: value['timestamp'], kind: 'page', url: data['href'].slice(0, 160) });
      }
    }
  }
  for (const { event, timestamp } of extractTelemetryEvents(chunks)) {
    if (event.kind === 'click') {
      all.push({
        t: event.at || timestamp,
        kind: 'click',
        selector: event.selector.slice(0, 120),
        cursor: event.cursor,
      });
    } else if (event.kind === 'request_start') {
      all.push({
        t: event.at,
        kind: 'request_start',
        requestId: event.requestId,
        method: event.method,
        url: event.url.slice(0, 160),
      });
    } else if (event.kind === 'request_end') {
      all.push({ t: event.at, kind: 'request_end', requestId: event.requestId, status: event.status });
    } else if (event.kind === 'form_submit') {
      all.push({ t: event.at, kind: 'form_submit', selector: event.selector.slice(0, 120) });
    }
  }
  all.sort((a, b) => a.t - b.t);

  return occurredAts.map((at) => {
    const inSpan = all.filter((event) => Math.abs(event.t - at) <= EVIDENCE_WINDOW_MS);
    const priority = inSpan
      .filter((event) => event.kind === 'click' || event.kind === 'form_submit')
      .sort((a, b) => Math.abs(a.t - at) - Math.abs(b.t - at))
      .slice(0, 24)
      .sort((a, b) => a.t - b.t);
    const rest = inSpan.filter((event) => event.kind !== 'click' && event.kind !== 'form_submit');
    const units = new Map<string, WindowEvent[]>();
    for (const event of rest) {
      const key = event.requestId ? `req:${event.requestId}` : `solo:${event.t}:${event.kind}`;
      const unit = units.get(key) ?? [];
      unit.push(event);
      units.set(key, unit);
    }
    const distance = (unit: WindowEvent[]): number =>
      Math.min(...unit.map((event) => Math.abs(event.t - at)));
    const kept: WindowEvent[] = [];
    let budget = EVIDENCE_WINDOW_MAX_EVENTS - priority.length;
    for (const unit of [...units.values()].sort((a, b) => distance(a) - distance(b))) {
      if (unit.length > budget) continue;
      kept.push(...unit);
      budget -= unit.length;
    }
    return [...priority, ...kept].sort((a, b) => a.t - b.t);
  });
}
