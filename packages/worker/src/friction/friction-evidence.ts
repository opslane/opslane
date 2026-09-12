import type { SessionTelemetryEvent } from '@opslane/shared';
import * as db from '../db.js';
import { logger } from '../logger.js';
import { ChunkReadError, readChunksBounded } from './chunk-reader.js';

const EVIDENCE_WINDOW_MS = 15_000;

export interface FrictionEvidence {
  signals: db.FrictionSignalRow[];
  timeline: string;
  truncated: boolean;
}

export async function gatherFrictionEvidence(
  groupId: string,
  projectId: string,
  confirmedSignalIds?: string[],
): Promise<FrictionEvidence | null> {
  const signals = await db.getFrictionSignalsForGroup(groupId, projectId, confirmedSignalIds);
  if (signals.length === 0) return null;

  const lines: string[] = [];
  let truncated = false;
  const sessionIds = [...new Set(signals.map((signal) => signal.session_id))];

  for (const sessionId of sessionIds) {
    try {
      const chunks = await db.getScrubbedChunksForSession(sessionId, projectId);
      const read = await readChunksBounded(chunks);
      truncated ||= read.truncated;
      const signalTimes = signals
        .filter((signal) => signal.session_id === sessionId)
        .map((signal) => Date.parse(signal.occurred_at))
        .filter(Number.isFinite);
      const events = read.envelopes
        .flatMap((envelope) => envelope.events)
        .map(readTelemetry)
        .filter((event): event is SessionTelemetryEvent => event !== null)
        .filter((event) => signalTimes.some((at) => Math.abs(event.at - at) <= EVIDENCE_WINDOW_MS))
        .sort((a, b) => a.at - b.at);

      const origin = signalTimes.length > 0 ? Math.min(...signalTimes) : 0;
      for (const event of events) {
        lines.push(`[session ${sessionId}] t${formatOffset(event.at - origin)} ${formatEvent(event)}`);
      }
    } catch (error: unknown) {
      if (!(error instanceof ChunkReadError)) throw error;
      truncated = true;
      logger.warn('Friction timeline unavailable; continuing with signal metadata', {
        group_id: groupId,
        session_id: sessionId,
        error: error.message,
      });
    }
  }

  return { signals, timeline: lines.join('\n'), truncated };
}

function readTelemetry(value: unknown): SessionTelemetryEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (event['type'] !== 5 || !event['data'] || typeof event['data'] !== 'object') return null;
  const data = event['data'] as Record<string, unknown>;
  if (data['tag'] !== 'opslane.telemetry' || !data['payload'] || typeof data['payload'] !== 'object') return null;
  const payload = data['payload'] as Record<string, unknown>;
  if (typeof payload['kind'] !== 'string' || typeof payload['at'] !== 'number') return null;
  switch (payload['kind']) {
    case 'click':
      return typeof payload['clickId'] === 'string'
        && typeof payload['selector'] === 'string'
        && typeof payload['cursor'] === 'string'
        ? payload as SessionTelemetryEvent
        : null;
    case 'request_start':
      return typeof payload['requestId'] === 'string'
        && (typeof payload['clickId'] === 'string' || payload['clickId'] === null)
        && typeof payload['method'] === 'string'
        && typeof payload['url'] === 'string'
        ? payload as SessionTelemetryEvent
        : null;
    case 'request_end':
      return typeof payload['requestId'] === 'string' && typeof payload['status'] === 'number'
        ? payload as SessionTelemetryEvent
        : null;
    case 'form_submit':
      return typeof payload['selector'] === 'string' ? payload as SessionTelemetryEvent : null;
    default:
      return null;
  }
}

function formatOffset(ms: number): string {
  const seconds = ms / 1000;
  return `${seconds >= 0 ? '+' : ''}${seconds.toFixed(2)}s`;
}

function formatEvent(event: SessionTelemetryEvent): string {
  switch (event.kind) {
    case 'click': return `click ${event.selector} (cursor: ${event.cursor})`;
    case 'request_start': return `request ${event.method} ${event.url} (click: ${event.clickId ?? 'none'})`;
    case 'request_end': return `response ${event.requestId} (${event.status})`;
    case 'form_submit': return `form submit ${event.selector}`;
  }
}
