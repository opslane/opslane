import { canonicalJson } from '@opslane/agent-runs';
import { describe, expect, it } from 'vitest';
import { buildMatchRequest, matchPromptInput, matchRunOptions, type MatchPromptInput } from '../match.js';
import { buildFirstLookRequest, firstLookPromptInput, firstLookRunOptions, type FirstLookPromptInput } from '../first-look.js';
import { buildConfirmRequest, confirmRead, confirmRunOptions, type ConfirmPromptInput } from '../confirm.js';
import { buildOneFixRequest, oneFixRunOptions } from '../one-fix.js';
import { recordedBundle, capturedRun } from '../../__tests__/helpers/run-log-memory-sink.js';

const client = { modelName: 'claude-sonnet-5', settings: () => ({ model: 'claude-sonnet-5', maxTokens: 8192, reasoning: 'off' }), complete: async () => { throw new Error('unused'); } };
const ticket = { id: 't1', name: 'Save', control: 'Save button', what_happened: 'nothing', steps: '', screens_confirmed: ['/assets'], screens_proposed: [], kind: 'defect', embedding: [0.1, 0.2] };

describe('friction run logs rebuild from persisted bundles', () => {
  it('match: stores a projection without embeddings and rebuilds from it', async () => {
    const prompt = matchPromptInput({
      projectName: 'AMFJ', screens: ['/assets'], timelineText: 'L1: click',
      observations: [{ id: 'o1', what: 'Save did nothing' }] as never, candidates: [ticket] as never,
    });
    const bundle = await recordedBundle(matchRunOptions(null, client as never, 'friction_match', prompt));
    expect(JSON.stringify(bundle)).not.toContain('embedding');
    expect(canonicalJson(buildMatchRequest(bundle.structuredInput as MatchPromptInput))).toBe(canonicalJson(bundle.request));
    expect(bundle.settings).toMatchObject({ maxTokens: 8192 });
  });

  it('first look: rebuilds from the stored projection', async () => {
    const prompt = firstLookPromptInput({
      projectName: 'AMFJ', screens: ['/assets'], timelineText: 'L1: click',
      drafts: [{ observationId: 'o1', observationWhat: 'x', draft: { name: 'n', control: 'c', what_happened: 'w', kind: 'defect' } }] as never,
      nearestPerDraft: { o1: [ticket] } as never,
    });
    const bundle = await recordedBundle(firstLookRunOptions(null, client as never, prompt));
    expect(JSON.stringify(bundle)).not.toContain('embedding');
    expect(canonicalJson(buildFirstLookRequest(bundle.structuredInput as FirstLookPromptInput))).toBe(canonicalJson(bundle.request));
  });

  it('confirm: rebuilds from the stored prompt input with valid frame references, and a re-ask stays in one run', async () => {
    const frames = [
      { offsetMs: 0, pair: 'a', png: Buffer.from('p1'), modelPng: Buffer.from('m1') },
      { offsetMs: 2000, pair: 'b', png: Buffer.from('p2'), modelPng: Buffer.from('m2') },
    ];
    const input = {
      ticket: { name: 'Save', control: 'Save button', what_happened: 'nothing', kind: 'defect' as const },
      timelineText: 'L1: click Save', frames: frames as never, framesOk: true, assetsMissing: false, signals: [{ id: 's1', what: 'dead click' }],
    };
    const bundle = await recordedBundle(confirmRunOptions({ context: null, client: client as never, input, sessionId: 'sess_1', offsetsMs: [0, 2000] }));
    expect(canonicalJson(buildConfirmRequest(bundle.structuredInput as ConfirmPromptInput))).toBe(canonicalJson(bundle.request));
    expect(bundle.images).toHaveLength(2);

    const recorded = capturedRun();
    const reply = { text: '{"outcome":"confirmed","evidenceLines":["L1"],"signalIds":[],"note":"n","costToUser":"none"}', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn' };
    const talking = { modelName: 'claude-sonnet-5', complete: async (args: { run: { noteRequest: (r: unknown) => void } }) => { args.run.noteRequest({}); return reply; } };
    expect(await confirmRead(talking as never, input, { add: () => undefined }, recorded.run)).toEqual({
      invalid: 'Malformed confirmation or evidence outside the recording',
      payload: { outcome: 'confirmed', evidenceLines: ['L1'], signalIds: [], note: 'n', costToUser: 'none' },
    });
    expect(recorded.requests).toHaveLength(1);
  });

  it('one-fix: rebuilds from the stored definitions', async () => {
    const a = { name: 'A', control: 'c', what_happened: 'w', kind: 'defect' as const };
    const b = { name: 'B', control: 'c', what_happened: 'w', kind: 'ux_insight' as const };
    const bundle = await recordedBundle(oneFixRunOptions({ context: null, client: client as never, phase: 'friction_confirm:batch', a: { ...a, id: 'x', embedding: [1] } as never, b }));
    const stored = bundle.structuredInput as { a: typeof a; b: typeof b };
    expect(JSON.stringify(bundle)).not.toContain('embedding');
    expect(canonicalJson(buildOneFixRequest(stored.a, stored.b))).toBe(canonicalJson(bundle.request));
  });
});
