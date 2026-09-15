import { canonicalJson } from '@opslane/agent-runs';
import { describe, expect, it } from 'vitest';
import { buildFixRunRequest, buildSystemPrompt, classifyFixLoop, fixPromptInput, fixRunLogOptions, type AgentFixInput, type FixRunStructuredInput } from '../agent-fix.js';
import { recordedBundle } from './helpers/run-log-memory-sink.js';
import { loggedModelPort } from '../run-logs/logged-model-port.js';
import { capturedRun } from './helpers/run-log-memory-sink.js';

const input = {
  errorGroupId: 'g', projectId: 'p', title: 'x is null', errorType: 'TypeError', errorMessage: 'Cannot read x',
  stackTrace: 'at load (src/load.ts:1:1)', resolvedStackTrace: null, breadcrumbs: '[]', context: '{}', sourceFiles: [],
  visualAnalysis: null, repoUrl: 'https://github.com/acme/web', githubRepo: 'acme/web', githubToken: 'ghs_secret',
  investigation: { rootCause: 'load() reads before fetch resolves', guidance: 'check load.ts' },
} as AgentFixInput;

describe('fix run logs', () => {
  it('rebuilds the system prompt and user message from the persisted bundle', async () => {
    const structured = {
      promptInput: fixPromptInput(input),
      preloadedFiles: [{ path: 'src/load.ts', content: 'export const load = 1;' }],
      tierIndex: 1, attempt: 1, priorTierSummary: 'searched load.ts', lastTestOutput: 'FAIL load.test.ts',
    };
    const { options, firstRequest } = fixRunLogOptions({
      runContext: null, structured, tier: { model: 'claude-sonnet-4-6', maxTurns: 30 }, githubRepo: 'acme/web', baseSha: 'abcdef1',
      tools: [{ name: 'read', description: 'Read a file.', inputSchema: { type: 'object' } }],
    });
    const bundle = await recordedBundle(options);
    const rebuilt = buildFixRunRequest(bundle.structuredInput as FixRunStructuredInput);
    const stored = bundle.request as { systemPrompt: string; userMessage: string };
    expect(canonicalJson({ systemPrompt: stored.systemPrompt, userMessage: stored.userMessage })).toBe(canonicalJson(rebuilt));
    expect(rebuilt.systemPrompt).toBe(buildSystemPrompt(input, structured.preloadedFiles));
    expect(firstRequest.userMessage).toContain('FAIL load.test.ts');
    expect(bundle.repository).toEqual({ provider: 'github', fullName: 'acme/web', commitSha: 'abcdef1' });
    expect(JSON.stringify(bundle)).not.toContain('ghs_secret');
  });

  it('logs every model response with its own usage', async () => {
    const recorded = capturedRun();
    const port = loggedModelPort({
      generate: async () => ({
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: { path: 'a' } }],
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0 },
        stopReason: 'tool_use',
        requestId: 'req_1',
      }),
    }, recorded.run);
    await port.generate({ model: 'claude-haiku-4-5-20251001', system: [], messages: [], tools: [] });
    expect(recorded.events).toEqual([{
      type: 'response', model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'tool_use', id: 'u1', name: 'read', input: { path: 'a' } }],
      stopReason: 'tool_use', usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0 }, requestId: 'req_1',
    }]);
    expect(recorded.requests).toEqual([]);
    expect(recorded.counted).toBe(1);
  });

  it('classifies loop outcomes', () => {
    const base = { toolCallCount: 0, turnCount: 3, testsRan: false, tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolHistory: [] };
    expect(classifyFixLoop({ ...base, success: true, summary: 'done' }, 15)).toBe('completed');
    expect(classifyFixLoop({ ...base, success: false, summary: 'Cancelled' }, 15)).toBe('aborted');
    expect(classifyFixLoop({ ...base, success: false, summary: 'Max turns', turnCount: 15 }, 15)).toBe('turns_exhausted');
    expect(classifyFixLoop({ ...base, success: false, summary: 'Budget exceeded: $1.20' }, 15)).toBe('budget');
    expect(classifyFixLoop({ ...base, success: false, summary: '529 overloaded' }, 15)).toBe('api_error');
  });
});
