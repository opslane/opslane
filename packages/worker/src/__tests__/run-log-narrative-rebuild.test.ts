import { createHash } from 'node:crypto';
import { canonicalJson } from '@opslane/agent-runs';
import { describe, expect, it } from 'vitest';
import { narrateRunOptions } from '../narrative/job.js';
import { buildNarrativePrompt } from '../narrative/prompt.js';
import { buildVerifyRequest, captureImageRefs, verifyRunOptions, type VerifyPromptInput } from '../narrative/verify.js';
import { recordedBundle } from './helpers/run-log-memory-sink.js';

const client = { modelName: 'claude-sonnet-5', complete: async () => { throw new Error('unused'); } };

describe('narrative run logs rebuild from persisted bundles', () => {
  it('narrate: rebuilds the request from the stored structured input', async () => {
    const structured = { appContext: 'Asset tracker', projectName: 'AMFJ', timelineText: 'L1 click Save' };
    const bundle = await recordedBundle(narrateRunOptions(null, client as never, structured));
    expect(canonicalJson(buildNarrativePrompt(bundle.structuredInput as typeof structured))).toBe(canonicalJson(bundle.request));
    expect(bundle.settings).toEqual({ model: 'claude-sonnet-5' });
  });

  it('verify: rebuilds the request and keeps every frame reference valid', async () => {
    const promptInput: VerifyPromptInput = { observations: [{ id: 'o1', what: 'Save did nothing', evidenceLines: ['L1'] }] as never, timelineLines: ['click Save', 'idle'] };
    const frames = [
      { offsetMs: 1200, pair: 'a', png: Buffer.from('full-a'), modelPng: Buffer.from('small-a') },
      { offsetMs: 3200, pair: 'b', png: Buffer.from('full-b'), modelPng: Buffer.from('small-b') },
    ];
    const bundle = await recordedBundle(verifyRunOptions({ context: null, client: client as never, promptInput, sessionId: 'sess_1', frames: frames as never, moments: [1200] }));
    expect(canonicalJson(buildVerifyRequest(bundle.structuredInput as VerifyPromptInput))).toBe(canonicalJson(bundle.request));
    expect(bundle.images).toEqual(captureImageRefs('sess_1', frames as never, { moments: [1200] }));
    expect(bundle.images[1]).toMatchObject({ captureSettings: { moments: [1200] }, sha256: createHash('sha256').update(Buffer.from('small-b')).digest('hex') });
  });
});
