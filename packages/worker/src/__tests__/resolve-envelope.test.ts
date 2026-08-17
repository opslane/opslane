import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildEnvelope } from '../resolve/envelope.js';

interface EnvelopeFixture {
  frames: Parameters<typeof buildEnvelope>[0];
}

describe('resolved envelope v2', () => {
  it('produces exactly the shape Go expects', () => {
    const fixture = JSON.parse(
      readFileSync('../../test-fixtures/grouping/resolved-envelope-v2.json', 'utf8'),
    ) as EnvelopeFixture;

    const built = buildEnvelope(fixture.frames);

    expect(built.version).toBe(2);
    expect(built.frames).toEqual(fixture.frames);
    expect(Object.keys(built.frames[0]!)).toEqual([
      'original_file',
      'original_function',
      'original_line',
      'generated',
    ]);
  });
});
