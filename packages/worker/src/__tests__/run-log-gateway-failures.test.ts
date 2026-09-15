import type Anthropic from '@anthropic-ai/sdk';
import type { ModelPort, ModelResponse } from '@opslane/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { loggedMessagesCreate, messageRequestDto } from '../run-logs/logged-messages.js';
import { loggedModelPort } from '../run-logs/logged-model-port.js';
import { NOOP_RUN } from '../run-logs/handle.js';
import { runLogFailureCounts } from '../run-logs/sink.js';

const params: Anthropic.MessageCreateParamsNonStreaming = { model: 'm', max_tokens: 10, messages: [] };

function throwingHandle() {
  const fail = () => { throw new Error('logging failed'); };
  return { ...NOOP_RUN, noteRequest: fail, countRequest: fail, event: fail };
}

describe('gateway logging failures', () => {
  it('preserves raw provider responses despite throwing handle methods and metadata', async () => {
    const response = { content: [], usage: {}, stop_reason: 'end_turn' };
    Object.defineProperty(response, '_request_id', { get: () => { throw new Error('metadata'); } });
    const create = vi.fn().mockResolvedValue(response);
    const client = { messages: { create } } as unknown as Anthropic;
    const failures = runLogFailureCounts().transcript;
    await expect(loggedMessagesCreate(client, throwingHandle(), params)).resolves.toBe(response);
    expect(create).toHaveBeenCalledWith(params);
    expect(runLogFailureCounts().transcript).toBe(failures + 2);
  });

  it('calls the provider unchanged when request DTO traversal fails', async () => {
    const hostile = Object.defineProperty({ ...params }, 'extra', { enumerable: true, get: () => { throw new Error('getter'); } });
    const response = { content: [], usage: {}, stop_reason: 'end_turn' };
    const create = vi.fn().mockResolvedValue(response);
    const client = { messages: { create } } as unknown as Anthropic;
    await expect(loggedMessagesCreate(client, NOOP_RUN, hostile)).resolves.toBe(response);
    expect(create.mock.calls[0]?.[0]).toBe(hostile);
  });

  it('preserves the exact provider rejection when request logging fails', async () => {
    const failure = { provider: 'unavailable' };
    const create = vi.fn().mockRejectedValue(failure);
    await expect(loggedMessagesCreate({ messages: { create } } as unknown as Anthropic, throwingHandle(), params)).rejects.toBe(failure);
    expect(create).toHaveBeenCalledOnce();
  });

  it('preserves model-port responses and provider errors despite logging failures', async () => {
    const response: ModelResponse = { content: [], usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: null };
    Object.defineProperty(response, 'requestId', { get: () => { throw new Error('metadata'); } });
    const port: ModelPort = { generate: vi.fn().mockResolvedValue(response) };
    const wrapped = loggedModelPort(port, throwingHandle());
    const request = { model: 'm', system: [], messages: [], tools: [] };
    await expect(wrapped.generate(request)).resolves.toBe(response);
    expect(port.generate).toHaveBeenCalledWith(request);
    const failure = new Error('provider failed');
    const failing = loggedModelPort({ generate: vi.fn().mockRejectedValue(failure) }, throwingHandle());
    await expect(failing.generate(request)).rejects.toBe(failure);
  });

  it('replaces image encodings and handles circular request values without touching the request', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PRIVATE_IMAGE_BYTES' } };
    const input = { ...params, messages: [{ role: 'user' as const, content: [image] }], extra: { bytes: new Uint8Array([1, 2]), url: 'data:image/png;base64,PRIVATE_IMAGE_BYTES' } };
    Object.assign(input.extra, { self: input.extra });
    const dto = JSON.stringify(messageRequestDto(input as Anthropic.MessageCreateParamsNonStreaming));
    expect(dto).not.toContain('PRIVATE_IMAGE_BYTES');
    expect(dto).toContain('[Circular]');
    expect(image.source.data).toBe('PRIVATE_IMAGE_BYTES');
  });
});
