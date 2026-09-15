import { describe, expect, it } from 'vitest';
import { formatRunLog, parseTranscript } from '../run-logs/format.js';

const bundle = {
  schemaVersion: 1, runId: 'r1', phase: 'investigation', entryPoint: 'friction/investigate-friction#investigateFriction',
  workerBuildSha: 'sha', repository: { provider: 'github' as const, fullName: 'acme/web', commitSha: 'abc' },
  settings: { model: 'claude-sonnet-4-6', maxTurns: 30 }, structuredInput: {}, images: [],
  request: { systemPrompt: 'You investigate.', firstMessage: 'Inspect the repository.' },
};
const jsonl = [
  { type: 'response', at: 't', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'u', name: 'search', input: { pattern: 'useUser', include: '*.ts,*.tsx' } }], stopReason: 'tool_use', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
  { type: 'tool_result', at: 't', id: '', name: 'search', output: 'No matches found.' + 'x'.repeat(5000), isError: false },
  { type: 'validator_rejection', at: 't', message: 'cite a file you read', payload: {} },
  { type: 'stop', at: 't', stop: 'turns_exhausted' },
].map((event) => JSON.stringify(event)).join('\n');

describe('formatRunLog', () => {
  it('prints the header, first request, each event and the stop', () => {
    const text = formatRunLog(bundle, parseTranscript(jsonl));
    expect(text).toContain('investigation  friction/investigate-friction#investigateFriction');
    expect(text).toContain('acme/web@abc');
    expect(text).toContain('Inspect the repository.');
    expect(text).toContain('search {"pattern":"useUser","include":"*.ts,*.tsx"}');
    expect(text).toContain('No matches found.');
    expect(text).toContain('[truncated for display');
    expect(text).toContain('REJECTED: cite a file you read');
    expect(text).toContain('STOP turns_exhausted');
  });

  it('rejects a malformed transcript line', () => {
    expect(() => parseTranscript('{"type":"tool_result","at":"t","id":"u","name":"n","output":1,"isError":false}')).toThrow(/line 1/);
  });

  it('reports physical line numbers even after blank lines', () => {
    expect(() => parseTranscript('\n  \n{"type":"unknown","at":"t"}')).toThrow(/line 3/);
  });

  it('prints rejection payloads and error stack frames', () => {
    const events = parseTranscript([
      { type: 'validator_rejection', at: 't', message: 'missing signal', payload: { signalIds: [] }, rule: 'evidence' },
      { type: 'error', at: 't', errorClass: 'Error', message: 'failed', stack: ['at investigate (agent.ts:10)'] },
    ].map((event) => JSON.stringify(event)).join('\n'));
    const text = formatRunLog(bundle, events, { full: true });
    expect(text).toContain('REJECTED: missing signal (evidence)');
    expect(text).toContain('payload: {"signalIds":[]}');
    expect(text).toContain('at investigate (agent.ts:10)');
  });

  it('prints tool results in full on request, and says when a run is unfinished', () => {
    expect(formatRunLog(bundle, parseTranscript(jsonl), { full: true })).not.toContain('[truncated for display');
    expect(formatRunLog(bundle, null)).toContain('No transcript: the run is unfinished');
  });
});
