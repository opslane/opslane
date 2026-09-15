import type { LoggedEvent } from './run-logger.js';
import type { ContentBlock, RunUsage } from './schema.js';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Anthropic usage block to RunUsage, keeping thinking tokens when reported. */
export function usageFromProvider(raw: unknown): RunUsage {
  const usage = record(raw);
  const thinking = record(usage['output_tokens_details'])['thinking_tokens'];
  return {
    input: num(usage['input_tokens']),
    output: num(usage['output_tokens']),
    cacheRead: num(usage['cache_read_input_tokens']),
    cacheWrite: num(usage['cache_creation_input_tokens']),
    ...(typeof thinking === 'number' ? { thinking: num(thinking) } : {}),
  };
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((raw): ContentBlock[] => {
    const block = record(raw);
    if (block['type'] === 'text') return [{ type: 'text', text: String(block['text'] ?? '') }];
    if (block['type'] === 'tool_use') {
      return [{ type: 'tool_use', id: String(block['id'] ?? ''), name: String(block['name'] ?? ''), input: block['input'] ?? {} }];
    }
    if (block['type'] === 'thinking') {
      const text = typeof block['thinking'] === 'string' ? block['thinking'] : '';
      return [{ type: 'thinking', text, redacted: text === '' }];
    }
    if (block['type'] === 'redacted_thinking') return [{ type: 'thinking', text: '', redacted: true }];
    return [];
  });
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => String(record(part)['text'] ?? '')).join('');
}

function maxUsage(a: RunUsage, b: RunUsage): RunUsage {
  const thinking = Math.max(a.thinking ?? -1, b.thinking ?? -1);
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    ...(thinking >= 0 ? { thinking } : {}),
  };
}

interface PendingResponse {
  messageId: string;
  model: string;
  content: ContentBlock[];
  stopReason: string | null;
  usage: RunUsage;
  requestId?: string;
}

/**
 * Turn a Claude Agent SDK message stream into transcript events. The SDK streams
 * one assistant message as several frames sharing `message.id`, each carrying
 * one content block and cumulative usage; they become one response. System
 * notices and tool results arrive between those frames, so they are held and
 * emitted after the response they interleave with.
 *
 * Streamed frames carry no stop reason. The final response takes the result
 * message's stop_reason, and an earlier response that asked for tools stopped on
 * tool_use: the SDK sends a follow-up request only after that stop.
 */
export class SdkStreamTranscriber {
  private pending: PendingResponse | null = null;
  private held: LoggedEvent[] = [];
  private readonly toolNames = new Map<string, string>();

  push(message: unknown): LoggedEvent[] {
    const m = record(message);
    if (m['type'] === 'assistant') {
      const inner = record(m['message']);
      const messageId = String(inner['id'] ?? '');
      const out = this.pending && this.pending.messageId !== messageId ? this.emit(true) : [];
      this.pending ??= { messageId, model: String(inner['model'] ?? ''), content: [], stopReason: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const blocks = contentBlocks(inner['content']);
      this.pending.content.push(...blocks);
      for (const block of blocks) if (block.type === 'tool_use') this.toolNames.set(block.id, block.name);
      if (typeof inner['stop_reason'] === 'string') this.pending.stopReason = inner['stop_reason'];
      else if (m['error'] === 'max_output_tokens') this.pending.stopReason = 'max_tokens';
      this.pending.usage = maxUsage(this.pending.usage, usageFromProvider(inner['usage']));
      if (this.pending.requestId === undefined && typeof m['request_id'] === 'string') this.pending.requestId = m['request_id'];
      return out;
    }
    if (m['type'] === 'result') {
      if (this.pending && this.pending.stopReason === null && typeof m['stop_reason'] === 'string') {
        this.pending.stopReason = m['stop_reason'];
      }
      return [...this.flush(), { type: 'sdk_message', message }];
    }
    const events: LoggedEvent[] = [];
    if (m['type'] === 'user') {
      const content = record(m['message'])['content'];
      if (Array.isArray(content)) {
        for (const raw of content) {
          const block = record(raw);
          if (block['type'] !== 'tool_result') continue;
          const id = String(block['tool_use_id'] ?? '');
          events.push({ type: 'tool_result', id, name: this.toolNames.get(id) ?? '', output: toolResultText(block['content']), isError: block['is_error'] === true });
        }
      }
    } else {
      events.push({ type: 'sdk_message', message });
    }
    if (!this.pending) return events;
    this.held.push(...events);
    return [];
  }

  /** Emit the pending response and everything held behind it. Call when the stream ends. */
  flush(): LoggedEvent[] {
    return this.emit(false);
  }

  private emit(followedByResponse: boolean): LoggedEvent[] {
    const pending = this.pending;
    const held = this.held;
    this.pending = null;
    this.held = [];
    if (!pending) return held;
    const stopReason = pending.stopReason
      ?? (followedByResponse && pending.content.some((block) => block.type === 'tool_use') ? 'tool_use' : null);
    return [
      {
        type: 'response',
        model: pending.model,
        content: pending.content,
        stopReason,
        usage: pending.usage,
        messageId: pending.messageId,
        ...(pending.requestId === undefined ? {} : { requestId: pending.requestId }),
      },
      ...pending.content.flatMap((block): LoggedEvent[] => (block.type === 'tool_use'
        ? [{ type: 'tool_call', id: block.id, name: block.name, input: block.input }]
        : [])),
      ...held,
    ];
  }
}

/** Authoritative per-model usage from an SDK result message; null for other messages. */
export function sdkResultTotals(message: unknown): { usage: Record<string, RunUsage> | null } | null {
  const m = record(message);
  if (m['type'] !== 'result') return null;
  const modelUsage = m['modelUsage'];
  const usage = typeof modelUsage === 'object' && modelUsage !== null
    ? Object.fromEntries(Object.entries(modelUsage as Record<string, unknown>).map(([model, raw]) => {
      const entry = record(raw);
      return [model, {
        input: num(entry['inputTokens']),
        output: num(entry['outputTokens']),
        cacheRead: num(entry['cacheReadInputTokens']),
        cacheWrite: num(entry['cacheCreationInputTokens']),
      }];
    }))
    : null;
  return { usage };
}

export function modelResponseEvent(
  model: string,
  response: { content: ReadonlyArray<object>; usage: RunUsage; stopReason: string | null; requestId?: string },
): LoggedEvent {
  return {
    type: 'response',
    model,
    content: contentBlocks(response.content),
    stopReason: response.stopReason,
    usage: { ...response.usage },
    ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
  };
}

/** Convert an agent-core tool-loop event. Responses come from the ModelPort decorator instead. */
export function agentEventToTranscript(event: { type: string; [k: string]: unknown }): LoggedEvent | null {
  switch (event.type) {
    case 'tool_call':
      return { type: 'tool_call', id: String(event['id'] ?? ''), name: String(event['name'] ?? ''), input: event['input'] ?? {} };
    case 'tool_result':
      return { type: 'tool_result', id: String(event['id'] ?? ''), name: String(event['name'] ?? ''), output: String(event['output'] ?? ''), isError: event['isError'] === true };
    case 'error':
      return { type: 'error', errorClass: String(event['code'] ?? 'error'), message: String(event['message'] ?? ''), stack: [] };
    case 'injected':
      return { type: 'request', request: { role: 'user', content: String(event['content'] ?? '') } };
    default:
      return null;
  }
}
