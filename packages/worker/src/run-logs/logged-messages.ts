import type Anthropic from '@anthropic-ai/sdk';
import { modelResponseEvent, usageFromProvider } from '@opslane/agent-runs';
import { createAnthropicClient } from '../anthropic-client.js';
import type { RunHandle } from './handle.js';
import { countRunLogFailure } from './sink.js';

function stripImages(value: unknown, ancestors = new Set<object>()): unknown {
  if (typeof value === 'string' && /^data:image\//i.test(value)) return '[image]';
  if (value !== null && typeof value === 'object') {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[image]';
    if (ancestors.has(value)) return '[Circular]';
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((child) => stripImages(child, ancestors));
      const record = value as Record<string, unknown>;
      if (record['type'] === 'base64' && typeof record['data'] === 'string') return { ...record, data: '[image]' };
      return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, stripImages(child, ancestors)]));
    } finally { ancestors.delete(value); }
  }
  return value;
}

/** The serializable request, with image bytes replaced (they are logged as references). */
export function messageRequestDto(params: Anthropic.MessageCreateParamsNonStreaming): unknown {
  try { return stripImages(params); } catch {
    countRunLogFailure('transcript');
    return '[Request unavailable]';
  }
}

/**
 * The client a phase passes to loggedMessagesCreate. Phases get it here, never
 * from the client factory, so raw clients are only created beside the gateway.
 */
export function messagesClient(apiKey: string): Anthropic {
  return createAnthropicClient(apiKey);
}

/** The only place worker code outside NarrativeClient may call messages.create. */
export async function loggedMessagesCreate(
  client: Anthropic,
  run: RunHandle,
  params: Anthropic.MessageCreateParamsNonStreaming,
  options: { signal?: AbortSignal; logRequest?: boolean } = {},
): Promise<Anthropic.Message> {
  // Multi-turn callers pass logRequest: false and log only what they append; every call is counted.
  try {
    if (options.logRequest === false) run.countRequest();
    else run.noteRequest(messageRequestDto(params));
  } catch { countRunLogFailure('transcript'); }
  const response = await (options.signal
    ? client.messages.create(params, { signal: options.signal })
    : client.messages.create(params));
  try {
    const usage = usageFromProvider(response.usage);
    const requestId = (response as { _request_id?: unknown })._request_id;
    run.event(modelResponseEvent(params.model, {
      content: response.content,
      usage,
      stopReason: response.stop_reason ?? null,
      ...(typeof requestId === 'string' ? { requestId } : {}),
    }));
  } catch { countRunLogFailure('transcript'); }
  return response;
}
