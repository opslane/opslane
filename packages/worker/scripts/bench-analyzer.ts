import { performance } from 'node:perf_hooks';
import type { SessionChunkEnvelope, SessionTelemetryEvent } from '@opslane/shared';
import { analyzeSession } from '../src/friction/analyzer.js';
import { extractSessionFacts } from '../src/friction/facts.js';

const CHUNK_COUNT = 40;
const NOISE_EVENTS_PER_CHUNK = 920;
const RUN_COUNT = 10;
const P95_BUDGET_MS = 5_000;
const BASE_TIME = 1_720_000_000_000;
const padding = 'x'.repeat(475);

function telemetry(event: SessionTelemetryEvent): unknown {
  return {
    type: 5,
    data: { tag: 'opslane.telemetry', payload: event },
    timestamp: event.at,
  };
}

function makeChunks(): SessionChunkEnvelope[] {
  const chunks: SessionChunkEnvelope[] = [];
  for (let chunkIndex = 0; chunkIndex < CHUNK_COUNT; chunkIndex += 1) {
    const chunkStart = BASE_TIME + chunkIndex * 30_000;
    const events: unknown[] = [
      { type: 2, data: {}, timestamp: chunkStart },
      {
        type: 4,
        data: { href: `https://app.example.com/catalog/${chunkIndex}?bench=1` },
        timestamp: chunkStart + 1,
      },
    ];

    for (let index = 0; index < NOISE_EVENTS_PER_CHUNK; index += 1) {
      const source = index % 3 === 0 ? 0 : index % 3 === 1 ? 3 : 1;
      events.push({
        type: 3,
        data: { source, id: index, x: index % 1280, y: index % 720, payload: padding },
        timestamp: chunkStart + 10 + index,
      });
    }

    chunks.push({
      events,
      meta: { sdk_version: 'bench', has_full_snapshot: true, chunked_at: chunkStart + 30_000 },
    });
  }

  const finalEvents = chunks[chunks.length - 1]?.events;
  if (!finalEvents) throw new Error('benchmark failed to create its final chunk');
  const signalStart = BASE_TIME + CHUNK_COUNT * 30_000 + 5_000;
  finalEvents.push(
    telemetry({ kind: 'click', clickId: 'rage-1', selector: '[data-testid="save"]', cursor: 'pointer', at: signalStart }),
    telemetry({ kind: 'click', clickId: 'rage-2', selector: '[data-testid="save"]', cursor: 'pointer', at: signalStart + 200 }),
    telemetry({ kind: 'click', clickId: 'rage-3', selector: '[data-testid="save"]', cursor: 'pointer', at: signalStart + 400 }),
    telemetry({ kind: 'click', clickId: 'dead-1', selector: '[data-testid="continue"]', cursor: 'pointer', at: signalStart + 3_000 }),
    { type: 3, data: { source: 5, id: 9001 }, timestamp: signalStart + 5_000 },
    { type: 3, data: { source: 5, id: 9002 }, timestamp: signalStart + 16_000 },
  );

  for (let index = 0; index < 195; index += 1) {
    finalEvents.push(
      telemetry({
        kind: 'request_end',
        requestId: `background-${index}`,
        status: 200,
        at: signalStart + 20_000 + index,
      }),
    );
  }
  return chunks;
}

const chunks = makeChunks();
const totalBytes = Buffer.byteLength(JSON.stringify(chunks));
const durations: number[] = [];
let correct = true;

for (let run = 0; run < RUN_COUNT; run += 1) {
  const startedAt = performance.now();
  const signals = analyzeSession(chunks);
  extractSessionFacts(chunks);
  durations.push(performance.now() - startedAt);
  const types = new Set(signals.map((signal) => signal.signalType));
  correct &&= types.has('rage_click') && types.has('dead_click') && !types.has('form_abandon');
}

durations.sort((a, b) => a - b);
const percentile = (fraction: number): number =>
  durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)] ?? Number.POSITIVE_INFINITY;
const p50 = percentile(0.5);
const p95 = percentile(0.95);
const passed = correct && p95 <= P95_BUDGET_MS;

console.log(
  `analyzer bench: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms over ${(totalBytes / 1024 / 1024).toFixed(1)}MB/${CHUNK_COUNT} chunks — ${passed ? 'PASS' : 'FAIL'}`,
);
if (!passed) process.exitCode = 1;
