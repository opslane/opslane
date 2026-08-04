import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../redact.js';

// vectors.valid[0].raw from test-fixtures/sourcemap-key/vectors.json: a full
// endpoint-bearing sk. The key id is the frozen fixture id allowlisted in
// .gitleaks.toml, so this canary authenticates nothing.
const SK_CANARY =
  'opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA'
  + '_eyJ2IjoxLCJpYXQiOiIyMDI2LTA4LTA0VDAwOjAwOjAwWiIsInVybCI6Imh0dHBzOi8vaW5nZXN0Lm9wc2xhbmUuY29tIn0';
const SK_SECRET = 'E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA';
const SK_PAYLOAD = 'eyJ2IjoxLCJpYXQiOiIyMDI2LTA4LTA0VDAwOjAwOjAwWiIsInVybCI6Imh0dHBzOi8vaW5nZXN0Lm9wc2xhbmUuY29tIn0';

describe('scrubSecrets', () => {
  it('scrubs credentials embedded in URLs', () => {
    expect(scrubSecrets('cloning https://x-access-token:ghs_abc@github.com/o/r.git'))
      .toBe('cloning https://***@github.com/o/r.git');
  });

  it('scrubs GitHub and Anthropic tokens', () => {
    expect(scrubSecrets('ghp_abc123 and github_pat_11AAA_bb and sk-ant-api03-xyz'))
      .toBe('[REDACTED] and [REDACTED] and [REDACTED]');
  });

  it('swallows an endpoint-bearing project key whole, payload included', () => {
    const got = scrubSecrets(`clone failed for ${SK_CANARY}`);
    expect(got).not.toContain(SK_SECRET);
    expect(got).not.toContain(SK_PAYLOAD);
    expect(got).not.toContain('opslane_sk_');
    expect(got).toBe('clone failed for [REDACTED]');
  });

  it('leaves clean text alone and does not truncate', () => {
    const long = 'a'.repeat(10_000);
    expect(scrubSecrets(long)).toBe(long);
  });
});
