// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSourceMapKey } from '../sk-key.js';

// The same bytes the Go suite reads: one fixture proves both decoders agree.
const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../test-fixtures/sourcemap-key/vectors.json', import.meta.url),
    ),
    'utf8',
  ),
) as SKVectors;

interface ValidVector {
  name: string;
  keyid: string;
  secret: string;
  endpoint: string;
  canonical?: string;
  iat: string;
  raw: string;
}

/** Every construction field a decoderInvalid vector may set; exactly one wins. */
interface InvalidVector {
  name: string;
  reason: string;
  acceptedByServer?: boolean;
  raw?: string;
  rawSuffix?: string;
  payload?: string;
  payloadOf?: string;
  padded?: boolean;
  payloadJson?: Record<string, unknown>;
  payloadRawJson?: string;
  oversizeTo?: number;
  urlOfLength?: number;
}

interface SKVectors {
  valid: ValidVector[];
  decoderInvalid: InvalidVector[];
}

/**
 * Prefix + keyid + secret every constructed vector builds on — the frozen
 * fixture pair allowlisted in .gitleaks.toml.
 */
const BARE_KEY =
  'opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA';

const encodeRaw = (text: string): string =>
  Buffer.from(text, 'utf8').toString('base64url');

const encodePadded = (text: string): string =>
  Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

/**
 * Mirrors the Go suite's buildSKVector, except that the plugin always parses a
 * whole raw key: payload-only vectors are appended to the fixture bare key.
 */
function buildRawFromVector(vec: InvalidVector): string {
  if (vec.raw !== undefined) return vec.raw;
  if (vec.rawSuffix !== undefined) return BARE_KEY + vec.rawSuffix;
  if (vec.oversizeTo !== undefined) {
    const pad = vec.oversizeTo - BARE_KEY.length - 1;
    if (pad < 1) throw new Error(`${vec.name}: oversizeTo is not longer than the bare key`);
    return `${BARE_KEY}_${'A'.repeat(pad)}`;
  }
  if (vec.payload !== undefined) return `${BARE_KEY}_${vec.payload}`;
  if (vec.payloadOf !== undefined) {
    return `${BARE_KEY}_${vec.padded ? encodePadded(vec.payloadOf) : encodeRaw(vec.payloadOf)}`;
  }
  // Verbatim: minifying would collapse the duplicate keys under test.
  if (vec.payloadRawJson !== undefined) return `${BARE_KEY}_${encodeRaw(vec.payloadRawJson)}`;
  if (vec.payloadJson !== undefined) {
    return `${BARE_KEY}_${encodeRaw(JSON.stringify(vec.payloadJson))}`;
  }
  if (vec.urlOfLength !== undefined) {
    // Must exceed the 2048-byte url cap while the whole key stays under the
    // 4096-byte raw cap: the plugin only ever sees a whole key, so a longer
    // url would trip `too_long` first and leave `url_too_long` unproven here.
    const scheme = 'https://';
    const tld = '.example';
    const fill = vec.urlOfLength - scheme.length - tld.length;
    if (fill < 1) throw new Error(`${vec.name}: urlOfLength is too short`);
    const url = scheme + 'a'.repeat(fill) + tld;
    return `${BARE_KEY}_${encodeRaw(
      JSON.stringify({ v: 1, iat: '2026-08-04T00:00:00Z', url }),
    )}`;
  }
  throw new Error(`${vec.name}: vector has no construction field`);
}

describe('parseSourceMapKey', () => {
  it('loads a fixture with both suites populated', () => {
    expect(vectors.valid.length).toBeGreaterThan(0);
    expect(vectors.decoderInvalid.length).toBeGreaterThan(0);
  });

  it('accepts every valid vector and extracts the canonical url', () => {
    for (const vec of vectors.valid) {
      expect(parseSourceMapKey(vec.raw), vec.name).toEqual({
        ok: true,
        url: vec.canonical ?? vec.endpoint,
      });
    }
  });

  it("rejects every invalid vector with the vector's exact reason", () => {
    for (const vec of vectors.decoderInvalid) {
      const parsed = parseSourceMapKey(buildRawFromVector(vec));
      // The bare key is the one deliberate divergence: the server accepts it,
      // the plugin cannot route it anywhere, so it must fail here too.
      expect(parsed.ok, vec.name).toBe(false);
      if (!parsed.ok) {
        // Stable reasons ARE the contract: the warning text names them, and
        // Go's ParseSKPayload errors carry the same strings.
        expect(parsed.reason, vec.name).toBe(vec.reason);
      }
    }
  });

  it('never includes key material in reasons', () => {
    const parsed = parseSourceMapKey('opslane_sk_x');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).not.toContain('opslane_sk_x');
      expect(parsed.reason).toBe('bad_grammar');
    }
    const long = `${BARE_KEY}_${'A'.repeat(5000)}`;
    const oversize = parseSourceMapKey(long);
    if (!oversize.ok) expect(oversize.reason).not.toContain('AAAA');
  });

  it('rejects a public key even without a payload', () => {
    const pk =
      'opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';
    expect(parseSourceMapKey(pk)).toEqual({ ok: false, reason: 'bad_grammar' });
  });

  it('detects duplicate top-level keys through nesting and escapes', () => {
    // A repeated key inside a nested value must not be mistaken for a
    // top-level duplicate, and an escaped spelling of a real key must be.
    const nested = `${BARE_KEY}_${encodeRaw(
      '{"v":1,"iat":"2026-08-04T00:00:00Z","url":"https://a.example","x":{"v":1,"v":2}}',
    )}`;
    expect(parseSourceMapKey(nested)).toEqual({ ok: false, reason: 'unknown_field' });

    const escapedUrl = `${BARE_KEY}_${encodeRaw(
      '{"v":1,"iat":"2026-08-04T00:00:00Z","\\u0075rl":"https://a.example","url":"https://a.example"}',
    )}`;
    expect(parseSourceMapKey(escapedUrl)).toEqual({
      ok: false,
      reason: 'duplicate_field',
    });
  });

  it('splits at fixed offsets, not at underscores in the secret', () => {
    // base64url includes '_', so roughly half of all real secrets contain one;
    // a naive split on '_' would misread the secret and the payload alike.
    const first = vectors.valid[0]!;
    const secret = 'E2E_SOURCEMAP_SECRET_AAAAAAAAAAAAAAAAAAAAAA';
    expect(secret).toHaveLength(43);
    const payload = first.raw.slice(82);
    const raw = `opslane_sk_${first.keyid}_${secret}_${payload}`;
    expect(parseSourceMapKey(raw)).toEqual({
      ok: true,
      url: first.canonical ?? first.endpoint,
    });
  });
});
