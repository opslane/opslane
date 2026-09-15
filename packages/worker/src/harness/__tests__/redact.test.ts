import { describe, expect, it } from 'vitest';
import { scrubSecrets, isSecretKey, scrubValue } from '../redact.js';

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

describe('run log secret scrubbing', () => {
  it('classifies secret-bearing key names and leaves token counts alone', () => {
    for (const key of ['GITHUB_TOKEN', 'accessToken', 'client_secret', 'client_secret_value', 'password_hash', 'db_passwd', 'STRIPE_API_KEY', 'apiKey', 'private_key', 'Authorization', 'aws_credentials']) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ['max_tokens', 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'tokenizer', 'token_count', 'author', 'keyboard']) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it('redacts PEM private keys and AWS access key ids', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----';
    expect(scrubSecrets(`key:\n${pem}\nafter`)).toBe('key:\n[REDACTED PRIVATE KEY]\nafter');
    expect(scrubSecrets('id AKIAABCDEFGHIJKLMNOP end')).toBe('id [REDACTED] end');
  });

  it('redacts Authorization values of any scheme, including multi-word ones', () => {
    expect(scrubSecrets('Authorization: Digest username="a", response="abc123"\nnext')).toBe('Authorization: [REDACTED]\nnext');
    expect(scrubSecrets('authorization: Signature keyId="k",signature="s"')).toBe('authorization: [REDACTED]');
  });

  it('replaces only the Authorization credential and keeps the rest of the line', () => {
    expect(scrubSecrets('Authorization: Bearer abc.def-123 status=ok next')).toBe('Authorization: [REDACTED] status=ok next');
    expect(scrubSecrets('authorization: Basic dXNlcjpwYXNz== then more')).toBe('authorization: [REDACTED] then more');
    const reply = JSON.stringify({ narrative: 'Clicked Save. Authorization: Bearer tok123 status=unchanged', observations: [{ what: 'dead click' }] });
    expect(JSON.parse(scrubSecrets(reply))).toEqual({
      narrative: 'Clicked Save. Authorization: [REDACTED] status=unchanged',
      observations: [{ what: 'dead click' }],
    });
    const escaped = '{\\"h\\": \\"Authorization: Digest username=\\"a\\", response=\\"r1\\"\\", \\"n\\": 1}';
    expect(scrubSecrets(escaped)).toBe('{\\"h\\": \\"Authorization: [REDACTED]\\", \\"n\\": 1}');
  });

  it('redacts secret-named assignments in text', () => {
    expect(scrubSecrets('GITHUB_TOKEN=ghx123 client_secret_value: abc password_hash=xyz max_tokens=16384'))
      .toBe('GITHUB_TOKEN=[REDACTED] client_secret_value: [REDACTED] password_hash=[REDACTED] max_tokens=16384');
    expect(scrubSecrets(`PASSWORD="two words" api_key='also two' note="kept here"`))
      .toBe(`PASSWORD="[REDACTED]" api_key='[REDACTED]' note="kept here"`);
  });

  it('redacts secret-named JSON pairs, raw and escaped inside another string', () => {
    expect(scrubSecrets('{"db_password": "hunter2", "client_secret":"s3", "input_tokens": 12}'))
      .toBe('{"db_password": "[REDACTED]", "client_secret":"[REDACTED]", "input_tokens": 12}');
    expect(scrubSecrets('{\\"db_password\\": \\"hunter2\\"}')).toBe('{\\"db_password\\": \\"[REDACTED]\\"}');
  });

  it('scrubs structured values by key and by text, without mutating the input', () => {
    const input = {
      client_secret: 'synthetic123',
      nested: [{ apiKey: 'k-1', note: 'ok' }],
      prompt: 'config {"db_password":"hunter2"} and GITHUB_TOKEN=ghx9',
      max_tokens: 5,
      credentials: ['synthetic123'],
      authorization: { scheme: 'Bearer', value: 'synthetic123' },
    };
    const scrubbed = scrubValue(input) as Record<string, unknown>;
    expect(scrubbed).toEqual({
      client_secret: '[REDACTED]',
      nested: [{ apiKey: '[REDACTED]', note: 'ok' }],
      prompt: 'config {"db_password":"[REDACTED]"} and GITHUB_TOKEN=[REDACTED]',
      max_tokens: 5,
      credentials: '[REDACTED]',
      authorization: '[REDACTED]',
    });
    expect(input.client_secret).toBe('synthetic123');
    expect(JSON.stringify(scrubbed)).not.toContain('synthetic123');
  });

  it('does not mistake a shared object for a cycle', () => {
    const shared = { maxOffsets: 3 };
    expect(scrubValue({ images: [{ captureSettings: shared }, { captureSettings: shared }] }))
      .toEqual({ images: [{ captureSettings: { maxOffsets: 3 } }, { captureSettings: { maxOffsets: 3 } }] });
  });

  it('survives cycles and unusual values', () => {
    const circular: Record<string, unknown> = { a: 1n };
    circular['self'] = circular;
    expect(() => scrubValue(circular)).not.toThrow();
    expect(scrubValue(circular)).toEqual({ a: '1', self: '[Circular]' });
  });
});

it('omits binary bytes before they can become numeric object properties', () => {
  const result = scrubValue({ buffer: Buffer.from('image-secret'), bytes: new Uint8Array([1, 2, 3]), raw: new ArrayBuffer(4) });
  expect(result).toEqual({ buffer: '[Binary omitted]', bytes: '[Binary omitted]', raw: '[Binary omitted]' });
});
