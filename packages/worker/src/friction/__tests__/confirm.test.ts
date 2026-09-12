import { describe, expect, it, vi } from 'vitest';
import { confirmRead } from '../confirm.js';
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
