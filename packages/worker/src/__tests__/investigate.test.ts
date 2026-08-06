import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock Anthropic SDK
const mockMessagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

import { safePath, investigateError } from '../investigate.js';
import type { InvestigateInput } from '../investigate.js';

let tempDir: string;

function makeInput(overrides?: Partial<InvestigateInput>): InvestigateInput {
  return {
    errorType: 'TypeError',
    title: 'Cannot read property of null',
    errorMessage: "Cannot read properties of null (reading 'map')",
    stackTrace: 'TypeError: Cannot read properties of null\n    at App.vue:42:10\n    at renderList (vue.js:1234)',
    resolvedStackTrace: null,
    breadcrumbs: '[]',
    ...overrides,
  };
}

/** Helper: create a classify_error tool_use response */
function classifyResponse(input: Record<string, unknown>, extraBlocks: Anthropic.ContentBlock[] = []) {
  return {
    content: [
      ...extraBlocks,
      { type: 'tool_use', id: 'cls-1', name: 'classify_error', input },
    ],
    usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

/** Helper: create a tool_use response for read-only tools */
function toolUseResponse(calls: Array<{ name: string; input: Record<string, unknown> }>) {
  return {
    content: calls.map((c, i) => ({
      type: 'tool_use' as const,
      id: `tool-${i}`,
      name: c.name,
      input: c.input,
    })),
    usage: { input_tokens: 300, output_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
  };
}

// Need Anthropic type for the extraBlocks parameter
import type Anthropic from '@anthropic-ai/sdk';

beforeEach(async () => {
  vi.clearAllMocks();
  tempDir = await mkdtemp(join(tmpdir(), 'investigate-test-'));
  // Create a sample repo structure
  await mkdir(join(tempDir, 'src', 'components'), { recursive: true });
  await writeFile(join(tempDir, 'src', 'App.vue'), '<template><div>{{ items.map(i => i.name) }}</div></template>\n<script>\nexport default { data() { return { items: null } } }\n</script>');
  await writeFile(join(tempDir, 'src', 'components', 'Header.vue'), '<template><header>Header</header></template>');
  await writeFile(join(tempDir, 'package.json'), '{"name": "test-app"}');
  // Create dirs that should be excluded
  await mkdir(join(tempDir, 'node_modules', 'vue'), { recursive: true });
  await writeFile(join(tempDir, 'node_modules', 'vue', 'index.js'), 'module.exports = {}');
  await mkdir(join(tempDir, '.git'), { recursive: true });
  await mkdir(join(tempDir, 'dist'), { recursive: true });
});

afterEach(async () => {
  delete process.env['INVESTIGATION_BUDGET_USD'];
  await rm(tempDir, { recursive: true, force: true });
});

describe('safePath', () => {
  it('allows paths within the repo', () => {
    expect(safePath(tempDir, 'src/App.vue')).toBe(join(tempDir, 'src/App.vue'));
  });

  it('allows the repo root itself', () => {
    expect(safePath(tempDir, '.')).toBe(tempDir);
  });

  it('blocks path traversal with ../', () => {
    expect(safePath(tempDir, '../../../etc/passwd')).toBeNull();
  });

  it('blocks traversal via nested ../', () => {
    expect(safePath(tempDir, 'src/../../etc/passwd')).toBeNull();
  });

  it('blocks absolute paths outside the repo', () => {
    expect(safePath(tempDir, '/etc/passwd')).toBeNull();
  });
});

describe('investigateError', () => {
  it('returns classification when model calls classify_error immediately', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      classifyResponse({ fixable: true, confidence: 'high', reason: 'Found App.vue with null items' }),
    );

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.fixable).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.reason).toContain('App.vue');
  });

  it('executes read_file tool and then classifies', async () => {
    // Turn 1: model asks to read a file
    mockMessagesCreate
      .mockResolvedValueOnce(
        toolUseResponse([{ name: 'read_file', input: { path: 'src/App.vue' } }]),
      )
      // Turn 2: model classifies based on file content
      .mockResolvedValueOnce(
        classifyResponse({ fixable: true, confidence: 'high', reason: 'Found null items in App.vue' }),
      );

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.fixable).toBe(true);
    expect(result.confidence).toBe('high');

    // Verify the file content was returned to the model (check the second API call's messages)
    // Note: messages array is mutated in-place, so after classify the assistant response is appended.
    // The user message with tool results is at length-2 (before the final assistant message).
    const secondCall = mockMessagesCreate.mock.calls[1];
    const messages = secondCall[0].messages;
    const toolResultMsg = messages.find(
      (m: { role: string; content?: unknown }) => m.role === 'user' && Array.isArray(m.content) && m.content.length > 0 && (m.content as Array<{ type: string }>)[0]?.type === 'tool_result',
    );
    expect(toolResultMsg).toBeDefined();
    const toolResult = (toolResultMsg!.content as Array<{ type: string; content: string }>)[0];
    expect(toolResult.content).toContain('items');
    expect(toolResult.content).toContain('1 |'); // line numbers
  });

  it('executes search tool and returns results', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(
        toolUseResponse([{ name: 'search', input: { pattern: 'items.map' } }]),
      )
      .mockResolvedValueOnce(
        classifyResponse({ fixable: true, confidence: 'high', reason: 'Found items.map in App.vue' }),
      );

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.fixable).toBe(true);

    // Verify search results were returned
    const secondCall = mockMessagesCreate.mock.calls[1];
    const messages = secondCall[0].messages;
    const toolResultMsg = messages.find(
      (m: { role: string; content?: unknown }) => m.role === 'user' && Array.isArray(m.content) && m.content.length > 0 && (m.content as Array<{ type: string }>)[0]?.type === 'tool_result',
    );
    expect(toolResultMsg).toBeDefined();
    const toolResult = (toolResultMsg!.content as Array<{ type: string; content: string }>)[0];
    expect(toolResult.content).toContain('App.vue');
  });

  it('executes list_files tool', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(
        toolUseResponse([{ name: 'list_files', input: { path: 'src' } }]),
      )
      .mockResolvedValueOnce(
        classifyResponse({ fixable: true, confidence: 'medium', reason: 'Found source files' }),
      );

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.fixable).toBe(true);

    const secondCall = mockMessagesCreate.mock.calls[1];
    const messages = secondCall[0].messages;
    const toolResultMsg = messages.find(
      (m: { role: string; content?: unknown }) => m.role === 'user' && Array.isArray(m.content) && m.content.length > 0 && (m.content as Array<{ type: string }>)[0]?.type === 'tool_result',
    );
    expect(toolResultMsg).toBeDefined();
    const toolResult = (toolResultMsg!.content as Array<{ type: string; content: string }>)[0];
    expect(toolResult.content).toContain('App.vue');
    expect(toolResult.content).toContain('components/');
  });

  it('blocks path traversal in read_file', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(
        toolUseResponse([{ name: 'read_file', input: { path: '../../../etc/passwd' } }]),
      )
      .mockResolvedValueOnce(
        classifyResponse({ fixable: true, confidence: 'low', reason: 'Could not read files' }),
      );

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.fixable).toBe(true);

    // Verify the error was returned
    const secondCall = mockMessagesCreate.mock.calls[1];
    const messages = secondCall[0].messages;
    const toolResultMsg = messages.find(
      (m: { role: string; content?: unknown }) => m.role === 'user' && Array.isArray(m.content) && m.content.length > 0 && (m.content as Array<{ type: string }>)[0]?.type === 'tool_result',
    );
    expect(toolResultMsg).toBeDefined();
    const toolResult = (toolResultMsg!.content as Array<{ type: string; content: string }>)[0];
    expect(toolResult.content).toContain('path traversal blocked');
  });

  it('fails closed when the budget is exhausted before any classification', async () => {
    process.env['INVESTIGATION_BUDGET_USD'] = '0.0000001';
    mockMessagesCreate.mockResolvedValueOnce(
      toolUseResponse([{ name: 'read_file', input: { path: 'src/App.vue' } }]),
    );

    const result = await investigateError('test-key', makeInput(), tempDir);

    expect(result.fixable).toBe(false);
    expect(result.reason).toBe('Investigation budget exceeded');
    delete process.env['INVESTIGATION_BUDGET_USD'];
  });

  it('keeps a classification that arrives in the same response that blows the budget', async () => {
    process.env['INVESTIGATION_BUDGET_USD'] = '0.0000001';
    mockMessagesCreate.mockResolvedValueOnce(
      classifyResponse({ fixable: true, confidence: 'high', reason: 'null deref in App.vue:42' }),
    );

    const result = await investigateError('test-key', makeInput(), tempDir);

    expect(result.fixable).toBe(true);
    expect(result.reason).toBe('null deref in App.vue:42');
    delete process.env['INVESTIGATION_BUDGET_USD'];
  });

  it('fails closed with low confidence when budget exceeded', async () => {
    // Return a tool call that generates tokens, and make usage huge
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'tool-0', name: 'read_file', input: { path: 'src/App.vue' } }],
      usage: {
        input_tokens: 500_000,
        output_tokens: 100_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.fixable).toBe(false);
    expect(result.confidence).toBe('low');
    expect(result.reason).toContain('budget');
  });

  it('forces classification even when model would exhaust turns', async () => {
    // 9 turns of read_file, then forced classify on turn 10 (MAX_TURNS-1)
    for (let i = 0; i < 9; i++) {
      mockMessagesCreate.mockResolvedValueOnce(
        toolUseResponse([{ name: 'read_file', input: { path: 'src/App.vue' } }]),
      );
    }
    // Turn 10: forced tool_choice means the model must classify
    mockMessagesCreate.mockResolvedValueOnce(
      classifyResponse({ fixable: true, confidence: 'low', reason: 'Could not determine root cause' }),
    );

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.fixable).toBe(true);
    expect(result.confidence).toBe('low');
    // Should NOT return "Investigation reached maximum turns" anymore
    expect(result.reason).not.toContain('maximum turns');
  });

  it('returns fixable=true with low confidence when API call fails', async () => {
    mockMessagesCreate.mockRejectedValue(new Error('API rate limited'));

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.fixable).toBe(true);
    expect(result.confidence).toBe('low');
    expect(result.reason).toContain('failed');
  });

  it('fails closed with low confidence when model ends without classifying', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I need more context but cannot determine fixability' }],
      usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.fixable).toBe(false);
    expect(result.confidence).toBe('low');
  });

  it('normalizes invalid confidence to low', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      classifyResponse({ fixable: false, confidence: 'very_high', reason: 'Test error' }),
    );

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.confidence).toBe('low');
  });

  it('returns unfixable classification with valid reason_code', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      classifyResponse({
        fixable: false,
        confidence: 'high',
        reason: 'Error is from browser console, no source files found',
        reason_code: 'unfixable_no_app_frames',
        remediation: 'This error was thrown from the browser console',
      }),
    );

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.fixable).toBe(false);
    expect(result.reason_code).toBe('unfixable_no_app_frames');
    expect(result.remediation).toContain('browser console');
  });

  it('includes stack trace file hints in the first user message', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      classifyResponse({ fixable: true, confidence: 'high', reason: 'Found source' }),
    );

    await investigateError('test-key', makeInput({
      stackTrace: 'TypeError: null\n    at src/components/Header.vue:10:5\n    at src/App.vue:42:10',
    }), tempDir);

    const firstCall = mockMessagesCreate.mock.calls[0];
    const firstMsg = firstCall[0].messages[0].content;
    // The first message should mention stack trace files
    const msgText = typeof firstMsg === 'string' ? firstMsg : (firstMsg as Array<{ text: string }>)[0].text;
    expect(msgText).toContain('src/components/Header.vue');
  });

  it('handles read_file for non-existent files gracefully', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(
        toolUseResponse([{ name: 'read_file', input: { path: 'src/NonExistent.vue' } }]),
      )
      .mockResolvedValueOnce(
        classifyResponse({ fixable: false, confidence: 'high', reason: 'File not found', reason_code: 'unfixable_no_app_frames', remediation: 'Check' }),
      );

    await investigateError('test-key', makeInput(), tempDir);

    const secondCall = mockMessagesCreate.mock.calls[1];
    const messages = secondCall[0].messages;
    const toolResultMsg = messages.find(
      (m: { role: string; content?: unknown }) => m.role === 'user' && Array.isArray(m.content) && m.content.length > 0 && (m.content as Array<{ type: string }>)[0]?.type === 'tool_result',
    );
    expect(toolResultMsg).toBeDefined();
    const toolResult = (toolResultMsg!.content as Array<{ type: string; content: string }>)[0];
    expect(toolResult.content).toContain('file not found');
  });

  it('search returns no matches for absent patterns', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(
        toolUseResponse([{ name: 'search', input: { pattern: 'TOTALLY_ABSENT_PATTERN_XYZ' } }]),
      )
      .mockResolvedValueOnce(
        classifyResponse({ fixable: false, confidence: 'high', reason: 'Pattern not found', reason_code: 'unfixable_no_app_frames', remediation: 'Manual review' }),
      );

    await investigateError('test-key', makeInput(), tempDir);

    const secondCall = mockMessagesCreate.mock.calls[1];
    const messages = secondCall[0].messages;
    const toolResultMsg = messages.find(
      (m: { role: string; content?: unknown }) => m.role === 'user' && Array.isArray(m.content) && m.content.length > 0 && (m.content as Array<{ type: string }>)[0]?.type === 'tool_result',
    );
    expect(toolResultMsg).toBeDefined();
    const toolResult = (toolResultMsg!.content as Array<{ type: string; content: string }>)[0];
    expect(toolResult.content).toContain('No matches found');
  });

  it('list_files excludes node_modules, .git, dist', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(
        toolUseResponse([{ name: 'list_files', input: { path: '.' } }]),
      )
      .mockResolvedValueOnce(
        classifyResponse({ fixable: true, confidence: 'medium', reason: 'Source found' }),
      );

    await investigateError('test-key', makeInput(), tempDir);

    const secondCall = mockMessagesCreate.mock.calls[1];
    const messages = secondCall[0].messages;
    const toolResultMsg = messages.find(
      (m: { role: string; content?: unknown }) => m.role === 'user' && Array.isArray(m.content) && m.content.length > 0 && (m.content as Array<{ type: string }>)[0]?.type === 'tool_result',
    );
    expect(toolResultMsg).toBeDefined();
    const toolResult = (toolResultMsg!.content as Array<{ type: string; content: string }>)[0];
    expect(toolResult.content).not.toContain('node_modules');
    expect(toolResult.content).not.toContain('.git');
    expect(toolResult.content).not.toContain('dist');
    expect(toolResult.content).toContain('src/');
    expect(toolResult.content).toContain('package.json');
  });

  it('returns filesRead and findings in the result', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(
        toolUseResponse([{ name: 'read_file', input: { path: 'src/App.vue' } }]),
      )
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Found null reference in App.vue line 42' },
          { type: 'tool_use', id: 'cls-1', name: 'classify_error', input: {
            fixable: true, confidence: 'high', reason: 'Null ref in App.vue',
          }},
        ],
        usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.filesRead).toContain('src/App.vue');
    expect(result.findings).toContain('Found null reference');
  });

  it('injects turn-budget pressure on turn MAX_TURNS - 2', async () => {
    // Respond with read_file for 8 turns, then classify on turn 9
    for (let i = 0; i < 8; i++) {
      mockMessagesCreate.mockResolvedValueOnce(
        toolUseResponse([{ name: 'read_file', input: { path: 'src/App.vue' } }]),
      );
    }
    mockMessagesCreate.mockResolvedValueOnce(
      classifyResponse({ fixable: true, confidence: 'medium', reason: 'Classified under pressure' }),
    );

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.fixable).toBe(true);

    // On the 9th API call (turn index 8), a user message should contain budget pressure
    // Note: messages array is shared by reference and mutated after the call, so find last user msg
    const ninthCall = mockMessagesCreate.mock.calls[8];
    const messages = ninthCall[0].messages;
    const userMessages = messages.filter((m: { role: string }) => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1];
    const content = Array.isArray(lastUserMsg.content) ? lastUserMsg.content : [];
    const hasWarning = content.some(
      (b: { type: string; text?: string }) => b.type === 'text' && b.text?.includes('MUST'),
    );
    expect(hasWarning).toBe(true);
  });

  it('forces tool_choice=classify_error on the final turn', async () => {
    // Respond with read_file for all turns - on the last one, tool_choice should force classify
    for (let i = 0; i < 9; i++) {
      mockMessagesCreate.mockResolvedValueOnce(
        toolUseResponse([{ name: 'read_file', input: { path: 'src/App.vue' } }]),
      );
    }
    // Final turn: model is forced to call classify_error
    mockMessagesCreate.mockResolvedValueOnce(
      classifyResponse({ fixable: true, confidence: 'low', reason: 'Forced classification' }),
    );

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.reason).toContain('Forced classification');

    // The last API call should have tool_choice forcing classify_error
    const lastCall = mockMessagesCreate.mock.calls[9];
    expect(lastCall[0].tool_choice).toEqual({ type: 'tool', name: 'classify_error' });
  });

  it('multi-turn investigation with read then search then classify', async () => {
    mockMessagesCreate
      // Turn 1: read a file
      .mockResolvedValueOnce(
        toolUseResponse([{ name: 'read_file', input: { path: 'src/App.vue' } }]),
      )
      // Turn 2: search for a pattern
      .mockResolvedValueOnce(
        toolUseResponse([{ name: 'search', input: { pattern: 'null' } }]),
      )
      // Turn 3: classify
      .mockResolvedValueOnce(
        classifyResponse({ fixable: true, confidence: 'high', reason: 'items is null in App.vue, needs default value' }),
      );

    const result = await investigateError('test-key', makeInput(), tempDir);
    expect(result.fixable).toBe(true);
    expect(result.confidence).toBe('high');
    expect(mockMessagesCreate).toHaveBeenCalledTimes(3);
  });
});
