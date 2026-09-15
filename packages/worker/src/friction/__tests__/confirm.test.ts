import { describe, expect, it, vi } from 'vitest';
import {
  confirmRead,
  PROVENANCE_IN_NOTE,
  ticketSteps,
  unavailableCheck,
} from '../confirm.js';
import { judgeOneFix } from '../one-fix.js';
const ticket = {
  name: 'Save',
  control: 'Save',
  what_happened: 'An error appeared',
};
const textReply = (text: string, stopReason = 'end_turn') => ({
  text,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  stopReason,
});
const response = (value: unknown, stopReason = 'end_turn') =>
  textReply(JSON.stringify(value), stopReason);
const valid = {
  outcome: 'confirmed',
  evidenceLines: ['L1'],
  signalIds: ['s1'],
  note: 'Click Save; an error appeared.',
  costToUser: 'lost_time',
};
const frame = {
  offsetMs: 0,
  pair: 'a' as const,
  png: Buffer.from('png'),
  modelPng: Buffer.from('png'),
};
const readInput = (overrides: Partial<Parameters<typeof confirmRead>[1]> = {}) => ({
  ticket, timelineText: 'L1: Click Save\nL2: Error toast', frames: [frame], framesOk: true,
  signals: [{ id: 's1', what: 'Error' }], ...overrides,
});
const textClient = (...replies: ReturnType<typeof textReply>[]) => {
  const complete = vi.fn();
  for (const reply of replies) complete.mockResolvedValueOnce(reply);
  return { modelName: 'test', complete };
};
const ASSETS_MISSING_SENTENCE =
  " The replay could not load this app's external stylesheets, fonts or images, so the screenshots show the recorded DOM without them: do not treat missing styling or images as evidence of a problem, and lean on the timeline for what appeared.";
describe('confirmation read', () => {
  it('returns a valid free-text JSON answer and asks for JSON with the recording as evidence', async () => {
    const client = textClient(response(valid));
    const meter = { add: vi.fn() };
    expect(await confirmRead(client, readInput(), meter)).toEqual(valid);
    const args = client.complete.mock.calls[0]![0];
    expect(args.system).toContain(
      'Return JSON only: {"outcome":"confirmed|refuted|inconclusive","evidenceLines":["L1"],"signalIds":["..."],"note":"...","costToUser":"none|annoyance|lost_time|abandoned_task"}.',
    );
    expect(args).not.toHaveProperty('tool');
    for (const label of ['TICKET', 'TIMELINE', 'SIGNALS', 'FRAMES'])
      expect(args.user).toContain(`${label}_START\n<untrusted_data>`);
    expect(args.images).toEqual([{ mediaType: 'image/png', base64: frame.modelPng.toString('base64') }]);
    expect(meter.add).toHaveBeenCalledOnce();
  });

  it('extracts the answer from prose or a fenced block around the JSON', async () => {
    for (const text of [
      `Here is my answer:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
      `After reviewing: ${JSON.stringify(valid)} That is all.`,
    ])
      expect(await confirmRead(textClient(textReply(text)), readInput(), { add: vi.fn() })).toEqual(valid);
  });

  it.each([
    [{ ...valid, outcome: 'maybe' }, 'shape'],
    [{ ...valid, costToUser: undefined }, 'shape'],
    [{ ...valid, signalIds: ['s1', 's1'] }, 'duplicate_id'],
    [{ ...valid, evidenceLines: ['L9'] }, 'unknown_line'],
    [{ ...valid, signalIds: ['other'] }, 'unknown_signal'],
    [{ ...valid, note: '  ' }, 'empty_note'],
    [{ ...valid, note: 'See L1 for the error.' }, 'note_mentions_provenance'],
    [{ ...valid, note: 'x'.repeat(301) }, 'note_too_long'],
    [{ ...valid, signalIds: [] }, 'confirmed_without_signal'],
    [{ ...valid, evidenceLines: [] }, 'confirmed_without_line'],
  ] as const)('rejects %j as %s', async (answer, rule) => {
    const meter = { add: vi.fn() };
    expect(await confirmRead(textClient(response(answer)), readInput(), meter))
      .toEqual({ invalid: rule, stopReason: 'end_turn' });
    expect(meter.add).toHaveBeenCalledOnce();
  });

  it.each([
    { outcome: ['confirmed'] },
    { outcome: { value: 'confirmed' } },
    { costToUser: ['lost_time'] },
    { costToUser: { value: 'lost_time' } },
    { outcome: ['confirmed'], costToUser: ['lost_time'], evidenceLines: [], signalIds: [] },
  ])('rejects non-string enum fields as shape before accepting evidence: %j', async (malformed) => {
    const meter = { add: vi.fn() };
    expect(await confirmRead(textClient(response({ ...valid, ...malformed })), readInput(), meter))
      .toMatchObject({ invalid: 'shape' });
    expect(meter.add).toHaveBeenCalledOnce();
  });

  it.each([
    'I cannot tell from this recording.',
    '{"outcome":"confirmed","evidenceLines":["L1"]',
    '{"outcome": confirmed}',
    '',
  ])('reports a reply with no parsable JSON object as shape: %j', async (text) => {
    expect(await confirmRead(textClient(textReply(text)), readInput(), { add: vi.fn() }))
      .toEqual({ invalid: 'shape', stopReason: 'end_turn' });
  });

  it('measures the note in code points: 300 ASCII or 300 astral characters pass', async () => {
    for (const note of ['x'.repeat(300), '😀'.repeat(300)])
      expect(await confirmRead(textClient(response({ ...valid, note })), readInput(), { add: vi.fn() }))
        .toEqual({ ...valid, note });
    expect(await confirmRead(textClient(response({ ...valid, note: '😀'.repeat(301) })), readInput(), { add: vi.fn() }))
      .toMatchObject({ invalid: 'note_too_long' });
  });

  it('accepts a refutation that cites no signal', async () => {
    const refuted = { ...valid, outcome: 'refuted', signalIds: [], evidenceLines: [] };
    expect(await confirmRead(textClient(response(refuted)), readInput(), { add: vi.fn() })).toEqual(refuted);
  });

  it('rejects a reply cut off at the output limit even when its text parses', async () => {
    const meter = { add: vi.fn() };
    expect(await confirmRead(textClient(response(valid, 'max_tokens')), readInput(), meter))
      .toEqual({ invalid: 'truncated', stopReason: 'max_tokens' });
    expect(meter.add).toHaveBeenCalledOnce();
  });

  it.each([
    ['with no text', textReply('', 'refusal')],
    ['even when valid-looking JSON came back', response(valid, 'refusal')],
  ])('reports a refusal %s as its own rule', async (_case, reply) => {
    const meter = { add: vi.fn() };
    expect(await confirmRead(textClient(reply), readInput(), meter))
      .toEqual({ invalid: 'refusal', stopReason: 'refusal' });
    expect(meter.add).toHaveBeenCalledOnce();
  });

  it('treats missing frames as unavailable without calling the model', async () => {
    const client = textClient();
    for (const [framesOk, frames] of [[false, []], [true, []], [false, [frame]]] as const)
      expect(await confirmRead(client, readInput({ framesOk, frames: [...frames] }), { add: vi.fn() }))
        .toEqual(unavailableCheck('no_frames'));
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('rejects a note that leaks line ids or verification material, keeps citations in evidenceLines', async () => {
    const meter = { add: vi.fn() };
    for (const note of [
      'Timeline and screenshots confirm the repetitive multi-step edit cycle (L23-24).',
      'User edited the Loanee field (L29-L38: click field, select, click checkmark).',
      'The frames show the button did nothing after the click.',
      'At line 12 the user clicked Save.',
      'Both timelines agree the save failed.',
    ]) {
      expect(
        await confirmRead(textClient(response({ ...valid, note })), readInput({ timelineText: 'L1: Click' }), meter),
      ).toMatchObject({ invalid: 'note_mentions_provenance' });
    }
    expect(
      await confirmRead(
        textClient(response({ ...valid, note: 'The user clicked Save and the form stayed unchanged with no message.' })),
        readInput({ timelineText: 'L1: Click' }),
        meter,
      ),
    ).toMatchObject({ outcome: 'confirmed', evidenceLines: ['L1'] });
  });
  it('shares one provenance pattern with the Go digest validator', () => {
    expect(PROVENANCE_IN_NOTE.source).toBe(
      String.raw`\bL\d+(?:\s*[-–]\s*L?\d+)?\b|\b(?:timelines?|screenshots?|frames?)\b|\bline\s+\d+\b`,
    );
    expect(PROVENANCE_IN_NOTE.flags).toBe('i');
  });
  it('builds ticket steps from whole notes within 600 code points', () => {
    expect(ticketSteps(['Open settings.', 'Click Save.'])).toBe('Open settings.\nClick Save.');
    const note = 'x'.repeat(250);
    expect(ticketSteps([note, note, note, 'Short.'])).toBe(`${note}\n${note}`);
    const wide = '💾'.repeat(199);
    expect(ticketSteps([wide, wide, wide])).toBe([wide, wide, wide].join('\n'));
  });
  it('tells the model when the replay rendered without external assets, and still reads', async () => {
    const meter = { add: vi.fn() };
    const refuted = {
      outcome: 'refuted', evidenceLines: ['L1'], signalIds: [], note: 'The save completed and the list updated.', costToUser: 'none',
    };
    const client = textClient(response(refuted), response(refuted));
    const base = { ticket, timelineText: 'L1: Click', frames: [frame], framesOk: true, signals: [] };
    expect(await confirmRead(client, { ...base, assetsMissing: true }, meter)).toMatchObject({ outcome: 'refuted' });
    expect(await confirmRead(client, base, meter)).toMatchObject({ outcome: 'refuted' });
    const [withAssetsMissing, withAssets] = client.complete.mock.calls.map(([call]) => (call as { system: string }).system);
    expect(withAssetsMissing).toContain(`evidenceLines.${ASSETS_MISSING_SENTENCE} Return JSON only:`);
    expect(withAssets).not.toContain('external stylesheets');
    expect(withAssets).toContain('evidenceLines. Return JSON only:');
  });
});
describe('one fix classification', () => {
  it('accepts only a boolean with a nonempty reason and meters invalid responses', async () => {
    const client = {
      modelName: 'test',
      complete: vi
        .fn()
        .mockResolvedValue(
          response({ oneFix: true, reason: 'Same failing handler' }),
        ),
    };
    const meter = { add: vi.fn() };
    expect(await judgeOneFix(client, ticket, ticket, meter)).toEqual({
      oneFix: true,
      reason: 'Same failing handler',
    });
    client.complete.mockResolvedValue(response({ oneFix: 'yes', reason: '' }));
    expect(await judgeOneFix(client, ticket, ticket, meter)).toHaveProperty(
      'invalid',
    );
    expect(meter.add).toHaveBeenCalledTimes(2);
  });
});
