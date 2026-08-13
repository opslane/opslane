import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { canonicalPattern, normalizePageUrl } from '../urlnorm.js';

interface Vector {
  name: string;
  in: string;
  want: string;
  quirk?: boolean;
}

const fixture = JSON.parse(
  await readFile(
    new URL('../../../../../test-fixtures/url-normalization/vectors.json', import.meta.url),
    'utf8',
  ),
) as { vectors: Vector[] };

describe('normalizePageUrl (cross-language contract)', () => {
  it('fixture is present and substantial', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(50);
  });

  it.each(fixture.vectors)('$name', ({ in: input, want }) => {
    expect(normalizePageUrl(input)).toBe(want);
  });
});

describe('canonicalPattern', () => {
  it('strips an origin prefix', () => {
    expect(canonicalPattern('https://app.example.com/assets/:id')).toBe('/assets/:id');
  });

  it('origin-only becomes root', () => {
    expect(canonicalPattern('https://app.example.com')).toBe('/');
  });

  it('path-only passes through', () => {
    expect(canonicalPattern('/assets/:id')).toBe('/assets/:id');
  });
});
