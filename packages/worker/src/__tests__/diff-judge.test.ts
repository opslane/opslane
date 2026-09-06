import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Anthropic SDK
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { judgeDiff, type DiffJudgeInput } from '../harness/diff-judge.js';

function makeInput(overrides?: Partial<DiffJudgeInput>): DiffJudgeInput {
  return {
    errorType: 'TypeError',
    errorMessage: "Cannot read properties of null (reading 'name')",
    stackTrace: 'at UserCard (src/components/UserCard.vue:12:5)',
    diff: '--- a/src/components/UserCard.vue\n+++ b/src/components/UserCard.vue\n@@ -12 +12 @@\n-user.name\n+user?.name',
    stackTraceFiles: ['src/components/UserCard.vue'],
    ...overrides,
  };
}

function mockJudgeResponse(input: Record<string, unknown>): void {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'tool_use', id: 'tu_1', name: 'score_diff', input }],
    usage: { input_tokens: 40, output_tokens: 12 },
  });
}

describe('judgeDiff', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns scores and passes when all dimensions are 2', async () => {
    mockJudgeResponse({ scope: 2, correctness: 2, preservation: 2, explanation: 'Minimal targeted fix.' });
    const result = await judgeDiff('test-key', makeInput());
    expect(result).toEqual({
      scope: 2,
      correctness: 2,
      preservation: 2,
      total: 6,
      qualityPassed: true,
      explanation: 'Minimal targeted fix.',
    });
  });

  it('throws when the response has no tool_use block', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I cannot score this.' }],
    });
    await expect(judgeDiff('test-key', makeInput())).rejects.toThrow('Judge returned no tool_use block');
  });

  it('reports paid usage before rejecting a malformed response', async () => {
    const onUsage = vi.fn();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I cannot score this.' }],
      usage: { input_tokens: 40, output_tokens: 12 },
    });

    await expect(judgeDiff('test-key', makeInput(), onUsage))
      .rejects.toThrow('Judge returned no tool_use block');
    expect(onUsage).toHaveBeenCalledWith({
      input: 40, output: 12, cacheRead: 0, cacheWrite: 0,
    });
  });

  it('throws when a score is missing', async () => {
    mockJudgeResponse({ scope: 2, correctness: 2, explanation: 'missing preservation' });
    await expect(judgeDiff('test-key', makeInput())).rejects.toThrow('Judge returned invalid scores');
  });

  it('throws when a score is a non-numeric type', async () => {
    mockJudgeResponse({ scope: '2', correctness: 2, preservation: 2, explanation: 'string score' });
    await expect(judgeDiff('test-key', makeInput())).rejects.toThrow('Judge returned invalid scores');
  });

  it('clamps out-of-range scores into 0..2', async () => {
    mockJudgeResponse({ scope: 5, correctness: -1, preservation: 2, explanation: 'wild scores' });
    const result = await judgeDiff('test-key', makeInput());
    expect(result.scope).toBe(2);
    expect(result.correctness).toBe(0);
    expect(result.preservation).toBe(2);
    expect(result.total).toBe(4);
    // correctness clamped to 0 fails the each>=1 requirement
    expect(result.qualityPassed).toBe(false);
  });

  it('rounds fractional scores', async () => {
    mockJudgeResponse({ scope: 1.6, correctness: 1.4, preservation: 0.5, explanation: 'fractional' });
    const result = await judgeDiff('test-key', makeInput());
    expect(result.scope).toBe(2);
    expect(result.correctness).toBe(1);
    expect(result.preservation).toBe(1); // 0.5 rounds up
    expect(result.total).toBe(4);
    expect(result.qualityPassed).toBe(true);
  });

  describe('qualityPassed boundary', () => {
    it.each([
      // [scope, correctness, preservation, expected]
      [2, 1, 1, true],   // total 4, all >= 1 — minimum pass
      [1, 1, 1, false],  // total 3 < 4
      [2, 2, 0, false],  // total 4 but preservation 0
      [0, 2, 2, false],  // total 4 but scope 0
      [2, 0, 2, false],  // total 4 but correctness 0
      [1, 2, 1, true],   // total 4, all >= 1
      [2, 2, 2, true],   // total 6
    ])('scope=%i correctness=%i preservation=%i → passed=%s', async (scope, correctness, preservation, expected) => {
      mockJudgeResponse({ scope, correctness, preservation, explanation: 'boundary' });
      const result = await judgeDiff('test-key', makeInput());
      expect(result.qualityPassed).toBe(expected);
      expect(result.total).toBe(scope + correctness + preservation);
    });
  });

  it('falls back to empty explanation when it is not a string', async () => {
    mockJudgeResponse({ scope: 2, correctness: 2, preservation: 2, explanation: 42 });
    const result = await judgeDiff('test-key', makeInput());
    expect(result.explanation).toBe('');
  });

  it('forces the score_diff tool choice on the judge model', async () => {
    mockJudgeResponse({ scope: 2, correctness: 2, preservation: 2, explanation: 'ok' });
    await judgeDiff('test-key', makeInput());
    const call = mockCreate.mock.calls[0][0];
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'score_diff' });
    expect(call.tools).toHaveLength(1);
    expect(call.tools[0].name).toBe('score_diff');
  });

  it('truncates the stack trace to 3000 chars and the diff to 10000 chars in the prompt', async () => {
    mockJudgeResponse({ scope: 2, correctness: 2, preservation: 2, explanation: 'ok' });
    const longStack = 'S'.repeat(5000);
    const longDiff = 'D'.repeat(20000);
    await judgeDiff('test-key', makeInput({ stackTrace: longStack, diff: longDiff }));
    const prompt: string = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('S'.repeat(3000));
    expect(prompt).not.toContain('S'.repeat(3001));
    expect(prompt).toContain('D'.repeat(10000));
    expect(prompt).not.toContain('D'.repeat(10001));
  });

  it("reports 'none detected' when no stack trace files were found", async () => {
    mockJudgeResponse({ scope: 2, correctness: 2, preservation: 2, explanation: 'ok' });
    await judgeDiff('test-key', makeInput({ stackTraceFiles: [] }));
    const prompt: string = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('none detected');
  });
});
