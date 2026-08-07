import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mockMessagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } })),
}));

import { investigateError } from '../investigate.js';

// These two cases are the regression controls for PR #1297: a request timeout
// that must never route to a code fix, and a rate limit that must not either.
// They used to be read out of the eval workspace, which has moved to a private
// repository — so they live beside the test that depends on them rather than
// making this suite depend on a directory that is no longer here.
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
// The repository the investigation reads while resolving citations. Vitest runs
// with cwd at packages/worker and __dirname does not exist under ESM, so this
// anchors through import.meta.url.
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const USAGE = { input_tokens: 900, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(`${FIXTURES}/${name}.json`, 'utf8'));
}

function inputFrom(f: Record<string, any>) {
  return {
    errorType: f['error_event'].error.type,
    title: f['error_event'].error.message,
    errorMessage: f['error_event'].error.message,
    stackTrace: f['error_event'].error.stack,
    resolvedStackTrace: null,
    breadcrumbs: JSON.stringify(f['error_event'].breadcrumbs),
  };
}

function diagnosis(input: Record<string, unknown>) {
  return { content: [{ type: 'tool_use', id: 'a', name: 'submit_diagnosis', input }], usage: USAGE };
}

beforeEach(() => mockMessagesCreate.mockReset());

/**
 * The incident this design exists for. The pipeline raised a customer's fetch
 * timeout from 10s to 30s because the agent, allowed one answer, named the
 * timeout constant.
 *
 * These assert the routing, not the model: the model is mocked. What they pin
 * down is that a backend cause can no longer become a frontend code change, and
 * that the timeout constant being a real in-surface file is not enough on its
 * own to authorise one.
 */
describe('PR #1297: a slow backend never becomes a frontend code change', () => {
  it('routes a backend cause to a conclusion when the surface is the frontend', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(diagnosis({
        best_supported: 'The search endpoint did not respond within the 10 second budget',
        why_chain: [
          'User types a query in the asset panel',
          'Client calls GET /issue-context/api/assets/search',
          'The server does not respond within 10 seconds',
        ],
        reproduction_steps: ['Search a term matching many assets'],
        evidence_check: 'Confirmed constants.ts:1. The timeout bounds the failure but does not cause it.',
        candidates_considered: [
          { statement: 'The search endpoint exceeds the 10 second client budget', kind: 'external_system' },
          { statement: 'FETCH_TIMEOUT of 10000ms is too short for this endpoint', kind: 'configuration' },
        ],
        rejected: [
          'FETCH_TIMEOUT of 10000ms is too short for this endpoint: raising it hides the symptom ' +
          'and the server latency is unexplained',
        ],
        evidence_strength: 'suggestive',
        cause_kind: 'external_system',
        cause_locations: [{ path: 'GET /issue-context/api/assets/search', note: 'remote service' }],
        reasoning: 'The server never responded; the client timeout only bounds the wait.',
      }));

    const result = await investigateError('key', inputFrom(fixture('hard-h1-timeout')), REPO_ROOT);

    expect(result.outcome).toBe('not_actionable');
    expect(result.fixable).toBe(false);
    expect(result.decisionReason).toContain('/issue-context/api/assets/search');
  });

  // The specific regression: constants.ts is a real file, so naming it used to
  // be sufficient to open a PR. Suggestive evidence must now park for a human
  // rather than act.
  it('does not open an unattended fix when the evidence is only suggestive', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(diagnosis({
        best_supported: 'The configured timeout is too short',
        why_chain: ['The budget is 10 seconds', 'The call exceeded it'],
        reproduction_steps: ['Trigger a slow search'],
        evidence_check: 'The constant exists, but why the server was slow is unverified.',
        candidates_considered: [
          { statement: 'FETCH_TIMEOUT of 10000ms is too short', kind: 'configuration' },
        ],
        rejected: [],
        evidence_strength: 'suggestive',
        cause_kind: 'configuration',
        cause_locations: [{ path: 'packages/worker/src/investigate.ts', line: 1 }],
        reasoning: 'Cannot establish that the timeout, rather than the server, is the cause.',
      }));

    const result = await investigateError('key', inputFrom(fixture('hard-h1-timeout')), REPO_ROOT);

    expect(result.outcome).toBe('code_fix');
    expect(result.confidence).toBe('medium');
  });
});
