import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildEnvelope, RESOLVER_VERSION } from '../resolve/envelope.js';

interface EnvelopeFixture {
  version: number;
  frames: Parameters<typeof buildEnvelope>[0];
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../test-fixtures/grouping/resolved-envelope-v2.json', import.meta.url),
    'utf8',
  ),
) as EnvelopeFixture;

describe('resolved envelope v2', () => {
  it('pins RESOLVER_VERSION to the fixture contract', () => {
    // Bumping RESOLVER_VERSION without regenerating the fixture (or vice
    // versa) must fail here, or Go and TypeScript drift silently.
    expect(RESOLVER_VERSION).toBe(fixture.version);
    expect(RESOLVER_VERSION).toBe(2);
  });

  it('produces exactly the shape Go expects', () => {
    const built = buildEnvelope(fixture.frames);

    expect(built.version).toBe(fixture.version);
    expect(built.frames).toEqual(fixture.frames);
    expect(Object.keys(built.frames[0]!)).toEqual([
      'original_file',
      'original_function',
      'original_line',
      'generated',
    ]);
  });

  it('normalizes what the fixture cannot show: backslashes and empty functions', () => {
    // The fixture's frames are already normalized, so the equality test above
    // would pass for an identity function. These inputs would not.
    const built = buildEnvelope([
      {
        original_file: 'src\\shared\\http\\client.ts',
        original_function: '',
        original_line: 61,
        generated: { line: 17, column: 9120 },
      },
    ]);

    expect(built.frames[0]!.original_file).toBe('src/shared/http/client.ts');
    expect(built.frames[0]!.original_function).toBe('<anonymous>');
  });
});
