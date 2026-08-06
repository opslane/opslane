import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const mockMessagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

import { investigateError } from '../investigate.js';

describe('PR #1297: a slow backend never becomes a code change', () => {
  beforeEach(() => mockMessagesCreate.mockReset());

  it('terminates as a conclusion naming the endpoint', async () => {
    const fixture = JSON.parse(readFileSync(
      resolve(REPO_ROOT, 'eval/cases/hard-h1-timeout/case.json'),
      'utf8',
    )) as {
      error_event: {
        error: { type: string; message: string; stack: string };
        breadcrumbs: unknown[];
      };
    };

    mockMessagesCreate.mockResolvedValueOnce({
      content: [{
        type: 'tool_use',
        id: 'd1',
        name: 'submit_diagnosis',
        input: {
          one_line_description: 'The asset search endpoint exceeded its 10 second budget',
          why_chain: [
            'User types a query in the asset panel',
            'Client calls GET /issue-context/api/assets/search',
            'The server does not respond within 10 seconds',
            'AbortSignal.timeout fires and rejects the fetch',
          ],
          reproduction_steps: ['Open the asset panel', 'Search a term matching many assets'],
          cause_location: 'GET /issue-context/api/assets/search (remote service)',
        },
      }],
      usage: {
        input_tokens: 900,
        output_tokens: 200,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    const result = await investigateError('test-key', {
      errorType: fixture.error_event.error.type,
      title: fixture.error_event.error.message,
      errorMessage: fixture.error_event.error.message,
      stackTrace: fixture.error_event.error.stack,
      resolvedStackTrace: null,
      breadcrumbs: JSON.stringify(fixture.error_event.breadcrumbs),
    }, REPO_ROOT, { globs: ['client/**'] });

    expect(result.outcome).toBe('not_actionable');
    expect(result.fixable).toBe(false);
    expect(result.decisionReason).toContain('/issue-context/api/assets/search');
    expect(result.diagnosis?.why_chain.length).toBeGreaterThanOrEqual(3);
  });

  it('still opens a fix for a real local defect', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{
        type: 'tool_use',
        id: 'd2',
        name: 'submit_diagnosis',
        input: {
          one_line_description: 'Null dereference rendering the asset list',
          why_chain: ['Render runs before the fetch resolves', 'assets is null', 'map throws'],
          reproduction_steps: ['Open the panel on a throttled connection'],
          cause_location: 'packages/worker/src/investigate.ts:1',
        },
      }],
      usage: {
        input_tokens: 900,
        output_tokens: 200,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    const result = await investigateError('test-key', {
      errorType: 'TypeError',
      title: 'Null dereference',
      errorMessage: 'Cannot read properties of null',
      stackTrace: 'at render (packages/worker/src/investigate.ts:1:1)',
      resolvedStackTrace: null,
      breadcrumbs: '[]',
    }, REPO_ROOT, { globs: ['packages/**'] });

    expect(result.outcome).toBe('code_fix');
  });
});
