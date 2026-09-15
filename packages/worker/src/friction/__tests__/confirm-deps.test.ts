import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
const constructed = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
    constructor(options: unknown) { constructed(options); }
  },
}));

const { frictionConfirmDepsFromEnv } = await import('../confirm-job.js');
const { confirmRead } = await import('../confirm.js');
const { judgeOneFix } = await import('../one-fix.js');
const { NOOP_RUN } = await import('../../run-logs/handle.js');

const ticket = { name: 'Save', control: 'Save', what_happened: 'An error appeared' };
const frame = { offsetMs: 0, pair: 'a' as const, png: Buffer.from('png'), modelPng: Buffer.from('png') };
const textReply = (value: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }], stop_reason: 'end_turn', usage: {},
});

function expectFreeTextRequest() {
  const body = create.mock.calls[0]![0] as Record<string, unknown>;
  expect(body).not.toHaveProperty('thinking');
  expect(body['max_tokens']).toBe(16_000);
  expect(body).not.toHaveProperty('tools');
  expect(body).not.toHaveProperty('tool_choice');
  expect(JSON.stringify(body)).not.toContain('budget_tokens');
  expect(constructed).toHaveBeenCalledWith(expect.objectContaining({ timeout: 300_000 }));
}

describe('frictionConfirmDepsFromEnv request settings', () => {
  beforeEach(() => {
    create.mockReset();
    constructed.mockReset();
    vi.stubEnv('NARRATIVE_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('NARRATIVE_BASE_URL', '');
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('sends a recording check as free text with the model thinking default, a 16,000-token limit and a 300 s timeout', async () => {
    create.mockResolvedValue(textReply({
      outcome: 'refuted', evidenceLines: ['L1'], signalIds: [], note: 'The save completed and the list updated.', costToUser: 'none',
    }));
    const result = await confirmRead(frictionConfirmDepsFromEnv().client, {
      ticket, timelineText: 'L1: Click Save', frames: [frame], framesOk: true, signals: [],
    }, { add: vi.fn() }, NOOP_RUN);
    expect(result).toMatchObject({ outcome: 'refuted' });
    expectFreeTextRequest();
  });

  it('sends the one-fix gate with the same settings', async () => {
    create.mockResolvedValue(textReply({ oneFix: false, reason: 'Different controls.' }));
    expect(await judgeOneFix(frictionConfirmDepsFromEnv().client, ticket, ticket, { add: vi.fn() }, NOOP_RUN))
      .toEqual({ oneFix: false, reason: 'Different controls.' });
    expectFreeTextRequest();
  });
});
