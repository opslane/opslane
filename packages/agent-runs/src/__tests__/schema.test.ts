import { describe, expect, it } from 'vitest';
import { parseInputBundle, parseTranscriptEvent, RUN_LOG_SCHEMA_VERSION, RUN_STOPS } from '../schema.js';

const sha = 'a'.repeat(64);
const bundle = {
  schemaVersion: RUN_LOG_SCHEMA_VERSION,
  runId: 'r1',
  phase: 'verify',
  entryPoint: 'narrative/verify#processFrameVerification',
  workerBuildSha: 'abc',
  repository: { provider: 'github', fullName: 'acme/web', commitSha: 'abcdef1' },
  settings: { model: 'claude-sonnet-5' },
  structuredInput: { timelineLines: ['click'] },
  request: { system: 's', user: 'u' },
  images: [
    { kind: 'capture', sessionId: 's1', offsetMs: 0, pair: 'a', captureSettings: {}, sha256: sha },
    { kind: 'object', objectKey: 'replays/p/r/artifacts/1', sha256: sha },
  ],
};

describe('parseInputBundle', () => {
  it('accepts a well-formed bundle', () => {
    expect(parseInputBundle(bundle)).toEqual(bundle);
  });

  it('rejects other schema versions, unknown keys and a missing request', () => {
    expect(() => parseInputBundle({ ...bundle, schemaVersion: 2 })).toThrow(/schema version/);
    expect(() => parseInputBundle({ ...bundle, extra: 1 })).toThrow(/unknown field extra/);
    const { request: _request, ...noRequest } = bundle;
    expect(() => parseInputBundle(noRequest)).toThrow(/request/);
  });

  it('rejects image bytes and malformed references', () => {
    expect(() => parseInputBundle({ ...bundle, images: [{ ...bundle.images[1], base64: 'AAAA' }] })).toThrow(/unknown field base64/);
    expect(() => parseInputBundle({ ...bundle, images: [{ ...bundle.images[1], sha256: 'nothex' }] })).toThrow(/sha256/);
    expect(() => parseInputBundle({ ...bundle, repository: { provider: 'github', fullName: '', commitSha: 'x' } })).toThrow(/repository/);
  });

  it('lists every stop the finished table accepts', () => {
    expect(RUN_STOPS).toEqual([
      'completed', 'terminal_tool', 'invalid_output', 'turns_exhausted', 'budget', 'truncated',
      'no_tool_call', 'no_evidence', 'api_error', 'machine_lost', 'aborted', 'threw',
    ]);
  });
});

describe('parseTranscriptEvent', () => {
  it('accepts each event type and rejects malformed ones', () => {
    const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, thinking: 1 };
    for (const event of [
      { type: 'response', at: 't', model: 'm', content: [{ type: 'thinking', text: '', redacted: true }], stopReason: null, usage, requestId: 'req_1', messageId: 'msg_1' },
      { type: 'request', at: 't', request: { role: 'user', content: 'again' } },
      { type: 'tool_call', at: 't', id: 'u', name: 'read_file', input: {} },
      { type: 'tool_result', at: 't', id: 'u', name: 'read_file', output: 'x', isError: false },
      { type: 'validator_rejection', at: 't', message: 'no', payload: null },
      { type: 'sdk_message', at: 't', message: { type: 'system' } },
      { type: 'error', at: 't', errorClass: 'Error', message: 'boom', stack: [] },
      { type: 'stop', at: 't', stop: 'completed' },
    ]) {
      expect(parseTranscriptEvent(event)).toEqual(event);
    }
    expect(() => parseTranscriptEvent({ type: 'tool_result', at: 't', id: 'u', name: 'n', output: 1, isError: false })).toThrow(/output/);
    expect(() => parseTranscriptEvent({ type: 'stop', at: 't', stop: 'exploded' })).toThrow(/stop/);
    expect(() => parseTranscriptEvent({ type: 'mystery', at: 't' })).toThrow(/type/);
    expect(() => parseTranscriptEvent({ type: 'response', at: 't', model: 'm', content: [null], stopReason: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })).toThrow(/content 0/);
    expect(() => parseTranscriptEvent({ type: 'request', at: 't' })).toThrow(/request is missing/);
    expect(() => parseTranscriptEvent({ type: 'error', at: 't', errorClass: 'E', message: 'm', stack: [1] })).toThrow(/stack/);
    expect(() => parseTranscriptEvent({ type: 'stop', at: 't', stop: 'completed', transcriptTruncated: { droppedEvents: -1 } })).toThrow(/droppedEvents/);
  });
});


describe('payload safety and completeness', () => {
  it('rejects image bytes nested in arbitrary request fields while accepting DTO placeholders', () => {
    const source = { type: 'base64', media_type: 'image/png', data: 'AAAA' };
    expect(() => parseInputBundle({ ...bundle, request: { content: [{ type: 'image', source }] } })).toThrow(/image bytes/);
    expect(() => parseInputBundle({ ...bundle, request: { image_url: 'data:image/png;base64,AAAA' } })).toThrow(/image bytes/);
    expect(() => parseInputBundle({ ...bundle, request: { source: { ...source, data: '[image]' } } })).not.toThrow();
    expect(() => parseTranscriptEvent({ type: 'sdk_message', at: 't', message: { image: source } })).toThrow(/image bytes/);
  });

  it('requires event payloads and validates optional rule names', () => {
    for (const event of [
      { type: 'tool_call', at: 't', id: 'u', name: 'read' },
      { type: 'validator_rejection', at: 't', message: 'bad' },
      { type: 'validator_rejection', at: 't', message: 'bad', payload: null, rule: 1 },
      { type: 'sdk_message', at: 't' },
      { type: 'request', at: 't', request: undefined },
      { type: 'stop', at: 't', stop: 'completed', transcriptTruncated: { droppedEvents: 0.5 } },
    ]) expect(() => parseTranscriptEvent(event)).toThrow();
  });
});
