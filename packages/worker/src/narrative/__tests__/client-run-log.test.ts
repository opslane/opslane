import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mocks.create } })),
}));

import { NarrativeClient } from '../client.js';
import { capturedRun } from '../../__tests__/helpers/run-log-memory-sink.js';

describe('NarrativeClient run logging', () => {
  it('logs the full response including thinking, and re-asks after the first request', async () => {
    const response = {
      content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: '{"a":1}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 3 },
    };
    Object.defineProperty(response, '_request_id', { value: 'req_9', enumerable: false });
    mocks.create.mockResolvedValue(response);
    const client = new NarrativeClient({ model: 'claude-sonnet-5', apiKey: 'k', maxTokens: 8192, reasoning: 'on' });
    const recorded = capturedRun();
    await client.complete({ system: 's', user: 'u', run: recorded.run });
    await client.complete({ system: 's', user: 'u2', run: recorded.run });
    expect(recorded.requests).toHaveLength(2);
    expect(recorded.events[0]).toEqual({
      type: 'response', model: 'claude-sonnet-5',
      content: [{ type: 'thinking', text: '', redacted: true }, { type: 'text', text: '{"a":1}' }],
      stopReason: 'end_turn', usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }, requestId: 'req_9',
    });
    expect(client.settings()).toEqual({ model: 'claude-sonnet-5', maxTokens: 8192, reasoning: 'on', timeoutMs: 120000 });
  });
});


it('preserves the narrative result when provider log metadata or handle methods throw', async () => {
  const response = { content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } };
  Object.defineProperty(response, '_request_id', { get: () => { throw new Error('metadata'); } });
  mocks.create.mockResolvedValue(response);
  const client = new NarrativeClient({ model: 'm', apiKey: 'k', maxTokens: 1024, reasoning: 'off' });
  const captured = capturedRun();
  const run = { ...captured.run, noteRequest: () => { throw new Error('log request'); }, event: () => { throw new Error('log event'); } };
  await expect(client.complete({ system: 's', user: 'u', run })).resolves.toMatchObject({ text: '{}', inputTokens: 7, outputTokens: 3 });
});
