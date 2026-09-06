import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Anthropic SDK
const { mockCreate, mockRecordJobUsage } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockRecordJobUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));
vi.mock('../db.js', () => ({ recordJobUsage: mockRecordJobUsage }));

import { runVisualAnalysis, type VisualAnalysisInput } from '../visual-analysis.js';

function makeInput(overrides?: Partial<VisualAnalysisInput>): VisualAnalysisInput {
  return {
    screenshots: [
      {
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
        contentType: 'image/png',
        kind: 'screenshot',
      },
    ],
    signals: { clicks: 3, scrollDepth: 0.5 },
    errorType: 'TypeError',
    errorMessage: 'Cannot read property of undefined',
    ...overrides,
  };
}

describe('runVisualAnalysis', () => {
  const originalEnv = process.env['ANTHROPIC_API_KEY'];

  beforeEach(() => {
    mockCreate.mockReset();
    mockRecordJobUsage.mockClear();
    process.env['ANTHROPIC_API_KEY'] = 'test-key-123';
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['ANTHROPIC_API_KEY'] = originalEnv;
    } else {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });

  it('returns null when no screenshots provided', async () => {
    const result = await runVisualAnalysis(makeInput({ screenshots: [] }));
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns null when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const result = await runVisualAnalysis(makeInput());
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns analysis output on successful LLM response', async () => {
    const analysisResult = {
      whatUserSaw: 'A blank white screen with no content rendered',
      failureMoment: 'After clicking the submit button',
      uxImpact: 'Complete loss of functionality',
      confidence: 'high',
    };

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(analysisResult) }],
    });

    const result = await runVisualAnalysis(makeInput());
    expect(result).toEqual(analysisResult);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('records visual-analysis usage when job context is supplied', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({
        whatUserSaw: 'A blank page', failureMoment: 'On submit',
        uxImpact: 'The task stopped', confidence: 'high',
      }) }],
      usage: { input_tokens: 90, output_tokens: 15 },
    });

    await runVisualAnalysis(makeInput({
      jobContext: { jobId: 'visual-job', execution: 2 },
    }));

    expect(mockRecordJobUsage).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'visual-job', execution: 2, phase: 'visual_analysis',
      model: 'claude-sonnet-4-5-20250929',
      usage: { input: 90, output: 15, cacheRead: 0, cacheWrite: 0 },
    }));
  });

  it('handles LLM response wrapped in code fences', async () => {
    const analysisResult = {
      whatUserSaw: 'Error modal displayed',
      failureMoment: 'On page load',
      uxImpact: 'Users cannot access the dashboard',
      confidence: 'medium',
    };

    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: '```json\n' + JSON.stringify(analysisResult) + '\n```',
      }],
    });

    const result = await runVisualAnalysis(makeInput());
    expect(result).toEqual(analysisResult);
  });

  it('returns null on JSON parse failure', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'This is not valid JSON at all.' }],
    });

    const result = await runVisualAnalysis(makeInput());
    expect(result).toBeNull();
  });

  it('returns null when response has no text block', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [],
    });

    const result = await runVisualAnalysis(makeInput());
    expect(result).toBeNull();
  });

  it('sends untrusted_user_data tags in the prompt', async () => {
    const analysisResult = {
      whatUserSaw: 'test',
      failureMoment: 'test',
      uxImpact: 'test',
      confidence: 'low',
    };

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(analysisResult) }],
    });

    await runVisualAnalysis(makeInput());

    const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;

    // Verify system prompt mentions untrusted_user_data
    expect(callArgs['system']).toContain('<untrusted_user_data>');

    // Verify the user message text block contains the tags
    const messages = callArgs['messages'] as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;
    const userContent = messages[0]!.content;
    const textBlock = userContent.find((b) => b.type === 'text');
    expect(textBlock?.text).toContain('<untrusted_user_data>');
    expect(textBlock?.text).toContain('</untrusted_user_data>');
  });

  it('includes image blocks for each screenshot', async () => {
    const input = makeInput({
      screenshots: [
        { base64: 'img1data', contentType: 'image/png', kind: 'before' },
        { base64: 'img2data', contentType: 'image/jpeg', kind: 'after' },
      ],
    });

    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({
          whatUserSaw: 'test',
          failureMoment: 'test',
          uxImpact: 'test',
          confidence: 'low',
        }),
      }],
    });

    await runVisualAnalysis(input);

    const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const messages = callArgs['messages'] as Array<{
      role: string;
      content: Array<{ type: string; source?: { data: string } }>;
    }>;
    const userContent = messages[0]!.content;
    const imageBlocks = userContent.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(2);
    expect(imageBlocks[0]!.source?.data).toBe('img1data');
    expect(imageBlocks[1]!.source?.data).toBe('img2data');
  });
});
