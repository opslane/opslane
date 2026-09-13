import { describe, expect, it, vi } from 'vitest';
import { confirmRead, PROVENANCE_IN_NOTE, ticketSteps } from '../confirm.js';
import { judgeOneFix } from '../one-fix.js';
const ticket = {
  name: 'Save',
  control: 'Save',
  what_happened: 'An error appeared',
};
const response = (value: unknown) => ({
  text: JSON.stringify(value),
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  stopReason: 'end_turn',
});
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
describe('confirmation read', () => {
  it('meters and validates exact evidence before accepting a confirmation', async () => {
    const client = {
      modelName: 'test',
      complete: vi.fn().mockResolvedValue(response(valid)),
    };
    const meter = { add: vi.fn() };
    expect(
      await confirmRead(
        client,
        {
          ticket,
          timelineText: 'L1: Click Save',
          frames: [frame],
          framesOk: true,
          signals: [{ id: 's1', what: 'Error' }],
        },
        meter,
      ),
    ).toEqual(valid);
    expect(meter.add).toHaveBeenCalledOnce();
    client.complete.mockResolvedValue(
      response({ ...valid, signalIds: ['other'] }),
    );
    expect(
      await confirmRead(
        client,
        {
          ticket,
          timelineText: 'L1: Click Save',
          frames: [frame],
          framesOk: true,
          signals: [{ id: 's1', what: 'Error' }],
        },
        meter,
      ),
    ).toHaveProperty('invalid');
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
      const client = {
        modelName: 'test',
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({ outcome: 'confirmed', evidenceLines: ['L1'], signalIds: ['s1'], note, costToUser: 'lost_time' }),
          inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn',
        }),
      };
      expect(
        await confirmRead(client, { ticket, timelineText: 'L1: Click', frames: [frame], framesOk: true, signals: [{ id: 's1', what: 'Error' }] }, meter),
      ).toHaveProperty('invalid');
    }
    const plain = {
      modelName: 'test',
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({ outcome: 'confirmed', evidenceLines: ['L1'], signalIds: ['s1'], note: 'The user clicked Save and the form stayed unchanged with no message.', costToUser: 'lost_time' }),
        inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn',
      }),
    };
    expect(
      await confirmRead(plain, { ticket, timelineText: 'L1: Click', frames: [frame], framesOk: true, signals: [{ id: 's1', what: 'Error' }] }, meter),
    ).toMatchObject({ outcome: 'confirmed', evidenceLines: ['L1'] });
  });
  it('shares one provenance pattern with the Go digest validator', () => {
    expect(PROVENANCE_IN_NOTE.source).toBe(
      String.raw`\bL\d+(?:\s*[-–]\s*L?\d+)?\b|\b(?:timelines?|screenshots?|frames?)\b|\bline\s+\d+\b`,
    );
    expect(PROVENANCE_IN_NOTE.flags).toBe('i');
  });
  it('rejects a note longer than 300 code points', async () => {
    const read = (note: string) =>
      confirmRead(
        { modelName: 'test', complete: vi.fn().mockResolvedValue(response({ ...valid, note })) },
        { ticket, timelineText: 'L1: Click Save', frames: [frame], framesOk: true, signals: [{ id: 's1', what: 'Error' }] },
        { add: vi.fn() },
      );
    expect(await read('a'.repeat(301))).toHaveProperty('invalid');
    expect(await read('a'.repeat(300))).toMatchObject({ outcome: 'confirmed' });
    expect(await read('💾'.repeat(300))).toMatchObject({ outcome: 'confirmed' });
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
    const client = {
      modelName: 'test',
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({ outcome: 'refuted', evidenceLines: ['L1'], signalIds: [], note: 'The save completed and the list updated.', costToUser: 'none' }),
        inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn',
      }),
    };
    const result = await confirmRead(client, { ticket, timelineText: 'L1: Click', frames: [frame], framesOk: true, assetsMissing: true, signals: [] }, meter);
    expect(result).toMatchObject({ outcome: 'refuted' });
    const call = client.complete.mock.calls[0]![0] as { system: string };
    expect(call.system).toMatch(/external stylesheets, fonts or images/);
  });
  it('treats missing assets and empty frames as unavailable without billing a model', async () => {
    const client = { modelName: 'test', complete: vi.fn() };
    for (const [framesOk, frames] of [
      [false, []],
      [true, []],
      [false, [frame]],
    ] as const)
      expect(
        await confirmRead(
          client,
          {
            ticket: { ...ticket, what_happened: 'Nothing happened' },
            timelineText: 'L1: Click',
            frames: [...frames],
            framesOk,
            signals: [],
          },
          { add: vi.fn() },
        ),
      ).toMatchObject({ outcome: 'unavailable' });
    expect(client.complete).not.toHaveBeenCalled();
  });
  it('rejects a truncated reply even when it contains a complete valid object', async () => {
    const client = {
      modelName: 'test',
      complete: vi
        .fn()
        .mockResolvedValue({ ...response(valid), stopReason: 'max_tokens' }),
    };
    const meter = { add: vi.fn() };
    expect(
      await confirmRead(
        client,
        {
          ticket,
          timelineText: 'L1: Click Save',
          frames: [frame],
          framesOk: true,
          signals: [{ id: 's1', what: 'Error' }],
        },
        meter,
      ),
    ).toHaveProperty('invalid');
    expect(meter.add).toHaveBeenCalledOnce();
  });
  it.each([
    { outcome: ['confirmed'] },
    { outcome: { value: 'confirmed' } },
    { costToUser: ['lost_time'] },
    { costToUser: { value: 'lost_time' } },
    {
      outcome: ['confirmed'],
      costToUser: ['lost_time'],
      evidenceLines: [],
      signalIds: [],
    },
  ])(
    'rejects non-string enum fields before accepting evidence: %j',
    async (malformed) => {
      const client = {
        modelName: 'test',
        complete: vi
          .fn()
          .mockResolvedValue(response({ ...valid, ...malformed })),
      };
      const meter = { add: vi.fn() };
      expect(
        await confirmRead(
          client,
          {
            ticket,
            timelineText: 'L1: Click Save',
            frames: [frame],
            framesOk: true,
            signals: [{ id: 's1', what: 'Error' }],
          },
          meter,
        ),
      ).toHaveProperty('invalid');
      expect(meter.add).toHaveBeenCalledOnce();
    },
  );
  it('rejects duplicate IDs, absent line citations, empty confirmed evidence', async () => {
    for (const bad of [
      { ...valid, signalIds: ['s1', 's1'] },
      { ...valid, evidenceLines: ['L2'] },
      { ...valid, signalIds: [] },
    ]) {
      const client = {
        modelName: 'test',
        complete: vi.fn().mockResolvedValue(response(bad)),
      };
      expect(
        await confirmRead(
          client,
          {
            ticket,
            timelineText: 'L1: Click',
            frames: [frame],
            framesOk: true,
            signals: [{ id: 's1', what: 'Error' }],
          },
          { add: vi.fn() },
        ),
      ).toHaveProperty('invalid');
    }
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
