import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { agentEventToTranscript, modelResponseEvent, sdkResultTotals, SdkStreamTranscriber, usageFromProvider } from '../adapters.js';

const stream = JSON.parse(readFileSync(new URL('./fixtures/toy-agent-stream.json', import.meta.url), 'utf8')) as unknown[];

describe('SdkStreamTranscriber', () => {
  it('aggregates frames per message, names out-of-order tool results by id, and takes the outer request id', () => {
    const transcriber = new SdkStreamTranscriber();
    const events = [...stream.flatMap((message) => transcriber.push(message)), ...transcriber.flush()];
    expect(events.map((event) => event.type)).toEqual([
      'sdk_message', 'response', 'tool_call', 'tool_call', 'tool_result', 'tool_result', 'response', 'sdk_message',
    ]);
    expect(events[1]).toEqual({
      type: 'response', model: 'claude-sonnet-5', messageId: 'msg_1', requestId: 'req_1', stopReason: 'tool_use',
      usage: { input: 10, output: 9, cacheRead: 0, cacheWrite: 0, thinking: 3 },
      content: [
        { type: 'thinking', text: '', redacted: true },
        { type: 'tool_use', id: 'toolu_a', name: 'mcp__weather__lookup_weather', input: { city: 'Lisbon' } },
        { type: 'tool_use', id: 'toolu_b', name: 'mcp__weather__lookup_time', input: { city: 'Lisbon' } },
      ],
    });
    expect(events[4]).toEqual({ type: 'tool_result', id: 'toolu_b', name: 'mcp__weather__lookup_time', output: '14:05', isError: false });
    expect(events[5]).toEqual({ type: 'tool_result', id: 'toolu_a', name: 'mcp__weather__lookup_weather', output: 'Sunny, 21C', isError: false });
    expect(events[6]).toMatchObject({ type: 'response', messageId: 'msg_2', requestId: 'req_2', stopReason: 'end_turn' });
  });

  it('keeps one response per message when system notices and tool results interleave its frames', () => {
    const transcriber = new SdkStreamTranscriber();
    const frames = [
      { type: 'assistant', request_id: 'req_1', message: { id: 'msg_1', model: 'm', stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 }, content: [{ type: 'thinking', thinking: 'plan' }] } },
      { type: 'system', subtype: 'thinking_tokens' },
      { type: 'assistant', message: { id: 'msg_1', model: 'm', stop_reason: null, usage: { input_tokens: 3, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'tu_a', name: 'read', input: { path: 'a' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'A' }] } },
      { type: 'assistant', message: { id: 'msg_1', model: 'm', stop_reason: null, usage: { input_tokens: 3, output_tokens: 7 }, content: [{ type: 'tool_use', id: 'tu_b', name: 'read', input: { path: 'b' } }] } },
      { type: 'system', subtype: 'thinking_tokens' },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_b', content: 'B' }] } },
      { type: 'assistant', request_id: 'req_2', message: { id: 'msg_2', model: 'm', stop_reason: null, usage: { input_tokens: 9, output_tokens: 2 }, content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success', stop_reason: 'end_turn', num_turns: 5 },
    ];
    const events = [...frames.flatMap((frame) => transcriber.push(frame)), ...transcriber.flush()];
    expect(events.map((event) => event.type)).toEqual([
      'response', 'tool_call', 'tool_call', 'sdk_message', 'tool_result', 'sdk_message', 'tool_result', 'response', 'sdk_message',
    ]);
    expect(events.filter((event) => event.type === 'response')).toMatchObject([
      { messageId: 'msg_1', requestId: 'req_1', stopReason: 'tool_use', usage: { input: 3, output: 7 } },
      { messageId: 'msg_2', requestId: 'req_2', stopReason: 'end_turn' },
    ]);
  });

  it('marks a response cut by the output limit, and leaves a response the stream never finished without a stop', () => {
    const transcriber = new SdkStreamTranscriber();
    transcriber.push({ type: 'assistant', error: 'max_output_tokens', message: { id: 'msg_1', model: 'm', stop_reason: null, content: [{ type: 'text', text: 'par' }] } });
    expect(transcriber.flush()).toMatchObject([{ type: 'response', stopReason: 'max_tokens' }]);
    transcriber.push({ type: 'assistant', message: { id: 'msg_2', model: 'm', stop_reason: null, content: [{ type: 'tool_use', id: 'u', name: 'read', input: {} }] } });
    expect(transcriber.flush()[0]).toMatchObject({ type: 'response', stopReason: null });
  });

  it('flushes a pending response when the stream ends without a result', () => {
    const transcriber = new SdkStreamTranscriber();
    expect(transcriber.push(stream[1])).toEqual([]);
    expect(transcriber.flush().map((event) => event.type)).toEqual(['response']);
    expect(transcriber.flush()).toEqual([]);
  });
});

describe('sdkResultTotals', () => {
  it('reads per-model usage from a result message and ignores other messages', () => {
    expect(sdkResultTotals(stream.at(-1))).toEqual({
      usage: {
        'claude-sonnet-5': { input: 40, output: 17, cacheRead: 5, cacheWrite: 2 },
        'claude-haiku-4-5-20251001': { input: 7, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    });
    expect(sdkResultTotals(stream[0])).toBeNull();
  });
});

describe('modelResponseEvent and usageFromProvider', () => {
  it('keeps text, tool use, stop reason, usage with thinking tokens and request id', () => {
    const usage = usageFromProvider({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, output_tokens_details: { thinking_tokens: 1 } });
    expect(usage).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, thinking: 1 });
    expect(modelResponseEvent('m', {
      content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'u', name: 'read', input: { path: 'a' } }],
      usage, stopReason: 'tool_use', requestId: 'req_1',
    })).toEqual({
      type: 'response', model: 'm',
      content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'u', name: 'read', input: { path: 'a' } }],
      stopReason: 'tool_use', usage, requestId: 'req_1',
    });
  });
});

describe('agentEventToTranscript', () => {
  it('maps tool calls, tool results, errors and injected feedback, and ignores the rest', () => {
    expect(agentEventToTranscript({ type: 'tool_call', id: 'c', name: 'bash', input: { cmd: 'ls' } }))
      .toEqual({ type: 'tool_call', id: 'c', name: 'bash', input: { cmd: 'ls' } });
    expect(agentEventToTranscript({ type: 'tool_result', id: 'c', name: 'bash', output: 'ok' }))
      .toEqual({ type: 'tool_result', id: 'c', name: 'bash', output: 'ok', isError: false });
    expect(agentEventToTranscript({ type: 'error', code: 'TIMEOUT', message: 'slow' }))
      .toEqual({ type: 'error', errorClass: 'TIMEOUT', message: 'slow', stack: [] });
    expect(agentEventToTranscript({ type: 'injected', content: 'Run the tests before finishing.' }))
      .toEqual({ type: 'request', request: { role: 'user', content: 'Run the tests before finishing.' } });
    expect(agentEventToTranscript({ type: 'turn_start', turnNumber: 1 })).toBeNull();
  });
});
