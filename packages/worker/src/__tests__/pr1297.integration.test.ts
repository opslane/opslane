import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mockMessagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } })),
}));

import { investigateError } from '../investigate.js';

// Vitest runs with cwd at packages/worker, and __dirname does not exist under
// ESM, so anchor to the repository root through import.meta.url.
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const USAGE = { input_tokens: 900, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(`${REPO_ROOT}/eval/cases/${name}/case.json`, 'utf8'));
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

function dossier(hypotheses: Array<Record<string, unknown>>) {
  return { content: [{ type: 'tool_use', id: 'd', name: 'submit_dossier', input: { hypotheses } }], usage: USAGE };
}

function adjudication(input: Record<string, unknown>) {
  return { content: [{ type: 'tool_use', id: 'a', name: 'adjudicate', input }], usage: USAGE };
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
      .mockResolvedValueOnce(dossier([
        {
          statement: 'The search endpoint exceeds the 10 second client budget',
          kind: 'external_system',
          location: 'GET /issue-context/api/assets/search (remote service)',
          supports: ['Breadcrumb error "signal timed out" on GET /issue-context/api/assets/search'],
          contradicts: ['none found'],
          would_be_settled_by: 'Server-side latency for that endpoint',
        },
        {
          statement: 'FETCH_TIMEOUT of 10000ms is too short for this endpoint',
          kind: 'configuration',
          location: 'client/asset-panel/src/api/fetcher/constants.ts:1',
          supports: ['constants.ts:1 sets FETCH_TIMEOUT to 10000'],
          contradicts: ['10s is a generous budget for a search call'],
          would_be_settled_by: 'Whether the endpoint ever responds under 10s',
        },
      ]))
      .mockResolvedValueOnce(adjudication({
        best_supported: 'The search endpoint did not respond within the 10 second budget',
        why_chain: [
          'User types a query in the asset panel',
          'Client calls GET /issue-context/api/assets/search',
          'The server does not respond within 10 seconds',
        ],
        reproduction_steps: ['Search a term matching many assets'],
        evidence_check: 'Confirmed constants.ts:1. The timeout bounds the failure but does not cause it.',
        rejected: ['FETCH_TIMEOUT: raising it hides the symptom and the server latency is unexplained'],
        evidence_strength: 'suggestive',
        cause_kind: 'external_system',
        cause_location: 'GET /issue-context/api/assets/search (remote service)',
        reasoning: 'The server never responded; the client timeout only bounds the wait.',
      }));

    const result = await investigateError('key', inputFrom(fixture('hard-h1-timeout')), REPO_ROOT, {
      globs: ['client/**'],
    });

    expect(result.outcome).toBe('not_actionable');
    expect(result.fixable).toBe(false);
    expect(result.decisionReason).toContain('/issue-context/api/assets/search');
  });

  // The specific regression: constants.ts is a real file inside the frontend
  // surface, so naming it used to be sufficient to open a PR. Suggestive
  // evidence must now park for a human rather than act.
  it('does not open an unattended fix when the evidence is only suggestive', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(dossier([{
        statement: 'FETCH_TIMEOUT of 10000ms is too short',
        kind: 'configuration',
        location: 'packages/worker/src/investigate.ts:1',
        supports: ['investigate.ts:1 exists in the checkout'],
        contradicts: ['The server latency is unexplained'],
        would_be_settled_by: 'Server-side timings',
      }]))
      .mockResolvedValueOnce(adjudication({
        best_supported: 'The configured timeout is too short',
        why_chain: ['The budget is 10 seconds', 'The call exceeded it'],
        reproduction_steps: ['Trigger a slow search'],
        evidence_check: 'The constant exists, but why the server was slow is unverified.',
        rejected: [],
        evidence_strength: 'suggestive',
        cause_kind: 'configuration',
        cause_location: 'packages/worker/src/investigate.ts:1',
        reasoning: 'Cannot establish that the timeout, rather than the server, is the cause.',
      }));

    const result = await investigateError('key', inputFrom(fixture('hard-h1-timeout')), REPO_ROOT, {
      globs: ['packages/**'],
    });

    expect(result.outcome).toBe('code_fix');
    expect(result.confidence).toBe('medium');
  });
});
