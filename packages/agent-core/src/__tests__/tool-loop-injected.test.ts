import { describe, expect, it } from 'vitest';
import { toolLoop, type AgentEvent } from '../tool-loop.js';

describe('toolLoop injected feedback', () => {
  it('emits an injected event when preCompletion adds a message', async () => {
    const events: AgentEvent[] = [];
    let checks = 0;
    await toolLoop({
      generate: async () => ({ content: [{ type: 'text', text: 'done' }], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end_turn' }),
    }, {
      model: 'm', systemPrompt: 's', userMessage: 'u', maxTurns: 4, tools: [],
      pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      middleware: { preCompletion: async () => (checks++ === 0 ? { inject: 'Run the tests before finishing.' } : undefined) },
      onEvent: (event) => events.push(event),
    });
    expect(events).toContainEqual({ type: 'injected', content: 'Run the tests before finishing.' });
  });
});
