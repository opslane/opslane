import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractJsonObject, narrativeClientFromEnv, NarrativeClient } from '../client.js';

const create = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create }; },
}));

describe('NarrativeClient.complete', () => {
  beforeEach(() => { create.mockReset(); });

  it.each([
    [{ cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, 30, 40],
    [{}, 0, 0],
  ])('preserves cache accounting from provider usage %j', async (cacheUsage, read, write) => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 10, ...cacheUsage } });
    const client = new NarrativeClient({ model: 'claude-sonnet-5', apiKey: 'test-key', maxTokens: 8192, reasoning: 'off' });
    expect(await client.complete({ system: 'instructions', user: 'timeline' })).toEqual({
      text: '{}', stopReason: 'end_turn', inputTokens: 20, outputTokens: 10,
      cacheReadTokens: read, cacheWriteTokens: write,
    });
  });

  it('forwards job cancellation to the provider', async () => {
    create.mockResolvedValue({content:[],usage:{},stop_reason:'end_turn'});
    const client = new NarrativeClient({model:'claude-sonnet-5',apiKey:'test',maxTokens:8192,reasoning:'off'});
    const signal = new AbortController().signal;
    await client.complete({system:'instructions',user:'evidence',signal});
    expect(create.mock.calls[0]?.[1]).toEqual({signal});
  });

  // The narrate and verify prompts are both under Sonnet 5's 1024-token
  // minimum cacheable prefix, so no cache_control is sent and these two
  // counts are structurally zero in production. They are plumbed through so
  // the ledger reports whatever the provider returns, not so anyone reads a
  // zero as evidence of a cache miss. Enabling caching here without first
  // growing the prefix past 1024 tokens would cache nothing and change no
  // number in this test.
  it('sends no cache_control, so the counts above are zero against the real API', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 10 } });
    const client = new NarrativeClient({ model: 'claude-sonnet-5', apiKey: 'test-key', maxTokens: 8192, reasoning: 'off' });
    await client.complete({ system: 'instructions', user: 'timeline' });
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain('cache_control');
  });
});

describe('extractJsonObject', () => {
  it.each([
    ['{"a":1}', '{"a":1}'],
    ['```json\n{"a":1}\n```', '{"a":1}'],
    ['Here you go: {"a":{"b":2}} done', '{"a":{"b":2}}'],
    ['no json here', ''],
  ])('extracts a complete outer object from %s', (input, expected) => {
    expect(extractJsonObject(input)).toBe(expected);
  });

  it('handles braces inside JSON strings', () => {
    expect(extractJsonObject('before {"a":"}"} after')).toBe('{"a":"}"}');
  });
});


describe('narrativeClientFromEnv', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('uses the Anthropic key when Compose supplies a blank narrative override', () => {
    vi.stubEnv('NARRATIVE_API_KEY','');
    vi.stubEnv('ANTHROPIC_API_KEY','test-key');
    expect(narrativeClientFromEnv()).toBeInstanceOf(NarrativeClient);
  });
});
