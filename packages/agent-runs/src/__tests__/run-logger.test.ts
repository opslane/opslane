import { describe, expect, it } from 'vitest';
import { RunLogger } from '../run-logger.js';

const at = () => new Date('2026-09-15T00:00:00Z');
const usage = (n: number) => ({ input: n, output: n, cacheRead: 0, cacheWrite: 0 });

describe('RunLogger', () => {
  it('sums response usage per model, and replaceUsage swaps in authoritative totals', () => {
    const logger = new RunLogger({ now: at });
    logger.add({ type: 'response', model: 'a', content: [], stopReason: 'end_turn', usage: usage(2) });
    logger.add({ type: 'response', model: 'a', content: [], stopReason: 'end_turn', usage: usage(3) });
    logger.add({ type: 'response', model: 'a-2026', content: [], stopReason: 'end_turn', usage: usage(1) });
    expect(logger.usage()).toEqual({ a: usage(5), 'a-2026': usage(1) });
    logger.replaceUsage({ a: usage(9) });
    expect(logger.usage()).toEqual({ a: usage(9) });
    expect(logger.responseCount()).toBe(3);
  });

  it('applies the injected scrubber to the structured event before serializing', () => {
    const scrub = (value: unknown): unknown => JSON.parse(JSON.stringify(value), (key, child) => (key === 'client_secret' ? '[REDACTED]' : child));
    const logger = new RunLogger({ now: at, scrub });
    logger.add({ type: 'tool_call', id: 't', name: 'x', input: { client_secret: 'synthetic123', note: 'kept' } });
    const { jsonl } = logger.serialize('completed');
    expect(jsonl).not.toContain('synthetic123');
    expect(jsonl).toContain('kept');
  });

  it('stores tool results in full', () => {
    const logger = new RunLogger({ now: at });
    const big = 'x'.repeat(200_000);
    logger.add({ type: 'tool_result', id: 't', name: 'read_file', output: big, isError: false });
    expect(logger.serialize('completed').jsonl).toContain(big);
  });

  it('keeps the whole transcript, stop line included, within the byte cap', () => {
    const maxBytes = 5_000;
    const logger = new RunLogger({ now: at, maxBytes });
    for (let i = 0; i < 100; i++) {
      logger.add({ type: 'tool_result', id: `t${i}`, name: 'n', output: 'y'.repeat(50), isError: false });
    }
    const { jsonl, bytes, droppedEvents } = logger.serialize('completed');
    expect(bytes).toBeLessThanOrEqual(maxBytes);
    expect(Buffer.byteLength(jsonl, 'utf8')).toBe(bytes);
    expect(droppedEvents).toBeGreaterThan(0);
    expect(JSON.parse(jsonl.trim().split('\n').at(-1)!)).toMatchObject({ type: 'stop', stop: 'completed', transcriptTruncated: { droppedEvents } });
  });

  it('raises a tiny configured cap to the minimum and still honours it', () => {
    const logger = new RunLogger({ now: at, maxBytes: 1 });
    for (let i = 0; i < 100; i++) logger.add({ type: 'tool_result', id: `t${i}`, name: 'n', output: 'z'.repeat(80), isError: false });
    expect(logger.serialize('completed').bytes).toBeLessThanOrEqual(4096);
  });

  it('never throws on unserializable input', () => {
    const logger = new RunLogger({ now: at });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => logger.add({ type: 'tool_call', id: 't', name: 'x', input: circular })).not.toThrow();
    expect(() => logger.add({ type: 'tool_call', id: 't', name: 'x', input: { n: 10n } })).not.toThrow();
    expect(logger.serialize('completed').droppedEvents).toBe(2);
  });
});


describe('logger failure boundaries', () => {
  it('keeps the stop within the cap after an expanding scrubber and counts UTF-8 bytes', () => {
    const logger = new RunLogger({ now: at, maxBytes: 4096, scrub: (value) => {
      const event = value as { type: string };
      return event.type === 'stop' ? { ...event, at: 'é'.repeat(1200) } : value;
    } });
    for (let i = 0; i < 10; i++) logger.add({ type: 'tool_result', id: `${i}`, name: 'read', output: 'é'.repeat(150), isError: false });
    const result = logger.serialize('completed');
    expect(result.bytes).toBeLessThanOrEqual(4096);
    expect(result.bytes).toBe(Buffer.byteLength(result.jsonl));
    expect(JSON.parse(result.jsonl.trim().split('\n').at(-1)!)).toMatchObject({ type: 'stop' });
    expect(result.droppedEvents).toBeGreaterThan(0);
  });

  it('contains failures in caller callbacks and provider usage getters', () => {
    const logger = new RunLogger({ now: () => { throw new Error('clock'); } });
    logger.add({ type: 'response', model: 'm', content: [], stopReason: null, usage: usage(2) });
    const totals = Object.defineProperty({}, 'm', { enumerable: true, get: () => { throw new Error('getter'); } });
    expect(() => logger.replaceUsage(totals)).not.toThrow();
    expect(logger.usage()).toEqual({ m: usage(2) });
    expect(() => logger.serialize('completed')).not.toThrow();
    const broken = new RunLogger({ scrub: () => { throw new Error('scrub'); } });
    broken.add({ type: 'request', request: 'secret' });
    expect(broken.serialize('completed')).toMatchObject({ jsonl: '', bytes: 0 });
  });

  it('drops all subsequent events after hitting the cap but still counts usage', () => {
    const logger = new RunLogger({ maxBytes: 4096 });
    logger.add({ type: 'tool_result', id: 'x', name: 'read', output: 'x'.repeat(5000), isError: false });
    logger.add({ type: 'response', model: 'm', content: [], stopReason: null, usage: usage(3) });
    expect(logger.serialize('completed').droppedEvents).toBe(2);
    expect(logger.responseCount()).toBe(1);
    expect(logger.usage()).toEqual({ m: usage(3) });
  });
});


it('never persists image bytes hidden in arbitrary transcript payloads', () => {
  const logger = new RunLogger({ now: at });
  for (const payload of [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PRIVATE_IMAGE_BYTES' } },
    { image: 'Here is data:image/png;base64,PRIVATE_IMAGE_BYTES' },
    { binary: new Uint8Array([71, 72, 73]) },
  ]) logger.add({ type: 'sdk_message', message: payload });
  const result = logger.serialize('completed');
  expect(result.droppedEvents).toBe(3);
  expect(result.jsonl).not.toContain('PRIVATE_IMAGE_BYTES');
  expect(result.jsonl.trim().split('\n')).toHaveLength(1);
});
