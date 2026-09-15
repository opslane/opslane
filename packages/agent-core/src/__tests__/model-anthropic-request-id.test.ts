import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicModelPort } from '../model-anthropic.js';

describe('createAnthropicModelPort', () => {
  it('passes the provider request id through', async () => {
    const response = {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 2 },
      stop_reason: 'end_turn',
    };
    Object.defineProperty(response, '_request_id', { value: 'req_123', enumerable: false });
    const client = { messages: { create: async () => response } } as unknown as Anthropic;
    const result = await createAnthropicModelPort(client).generate({ model: 'm', system: [], messages: [], tools: [] });
    expect(result.requestId).toBe('req_123');
    expect(result.stopReason).toBe('end_turn');
  });
});
