import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxRuntime } from '../harness/sandbox-runtime.js';

const { messagesCreate } = vi.hoisted(() => ({ messagesCreate: vi.fn() }));
vi.mock('../anthropic-client.js', () => ({
  createAnthropicClient: vi.fn(() => ({ messages: { create: messagesCreate } })),
}));

import { JUDGE_PROBE_BUDGET, judgeFixAttempt } from '../harness/fix-judge.js';

function response(content: Array<Record<string, unknown>>) {
  return {
    content,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as never;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: 'test-key',
    diagnosis: null,
    diff: 'diff --git a/src/a.ts b/src/a.ts',
    testSource: 'it("regresses", () => expect(value).toBe(true))',
    ledger: [],
    tierRecord: {
      tier: 'reproduced' as const,
      declaredTest: { identifier: 'regresses', expectedAssertion: 'expected true' },
      reproductionImpossibleReason: null,
    },
    anomalies: [],
    sandbox: null,
    errorTitle: 'TypeError in a.ts',
    ...overrides,
  };
}

describe('judgeFixAttempt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts one sealed, structured verdict from an independent session', async () => {
    messagesCreate.mockResolvedValue(response([{
      type: 'tool_use', id: 'verdict-1', name: 'submit_judge_verdict',
      input: { approved: true, assessment: 'Distinctive regression and narrow fix.' },
    }]));

    const verdict = await judgeFixAttempt(input());

    expect(verdict).toMatchObject({
      approved: true,
      assessment: 'Distinctive regression and narrow fix.',
      vetoReason: null,
      probesUsed: 0,
    });
    expect(verdict.sessionId).toBeTruthy();
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      tools: [expect.objectContaining({
        name: 'submit_judge_verdict',
        input_schema: expect.objectContaining({ additionalProperties: false }),
      })],
    }));
  });

  it('allows one malformed-verdict retry and then fails closed', async () => {
    messagesCreate.mockResolvedValue(response([{
      type: 'tool_use', id: 'bad', name: 'submit_judge_verdict',
      input: { approved: false, assessment: '' },
    }]));

    const verdict = await judgeFixAttempt(input());

    expect(messagesCreate).toHaveBeenCalledTimes(2);
    expect(verdict).toMatchObject({
      approved: false,
      vetoReason: expect.stringContaining('judge_no_verdict'),
    });
  });

  it('returns a model veto with its reason', async () => {
    messagesCreate.mockResolvedValue(response([{
      type: 'tool_use', id: 'veto', name: 'submit_judge_verdict',
      input: {
        approved: false,
        assessment: 'The assertion is generic and does not distinguish the incident.',
        veto_reason: 'generic regression test',
      },
    }]));

    await expect(judgeFixAttempt(input())).resolves.toMatchObject({
      approved: false,
      vetoReason: 'generic regression test',
    });
  });

  it('runs no more than the three-command probe budget', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: 'probe output', stderr: '' }));
    const sandbox = { commands: { run } } as unknown as SandboxRuntime;
    for (let index = 0; index < JUDGE_PROBE_BUDGET + 1; index++) {
      messagesCreate.mockResolvedValueOnce(response([{
        type: 'tool_use', id: `probe-${index}`, name: 'run_probe',
        input: { command: `git show probe-${index}` },
      }]));
    }
    messagesCreate.mockResolvedValueOnce(response([{
      type: 'tool_use', id: 'verdict', name: 'submit_judge_verdict',
      input: { approved: true, assessment: 'Probe results resolve the anomaly.' },
    }]));

    const verdict = await judgeFixAttempt(input({
      anomalies: ['ledger_output_truncated'],
      sandbox,
    }));

    expect(run).toHaveBeenCalledTimes(JUDGE_PROBE_BUDGET);
    expect(verdict.probesUsed).toBe(JUDGE_PROBE_BUDGET);
    expect(verdict.approved).toBe(true);
  });
});
