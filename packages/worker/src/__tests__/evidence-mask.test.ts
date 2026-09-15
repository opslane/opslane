import { describe, expect, it } from 'vitest';
import {
  dropCutToken,
  MASKED_EMAIL,
  MASKED_NUMBER,
  MASKED_TOKEN,
  maskPageUrl,
  maskStackLine,
  maskStructured,
  maskText,
} from '../evidence/mask.js';

describe('maskText', () => {
  it('masks emails', () => {
    expect(maskText('No account for jane.doe+ops@acme.co.uk here'))
      .toBe(`No account for ${MASKED_EMAIL} here`);
  });

  it('masks JWTs and bearer credentials', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(maskText(`token ${jwt} rejected`)).toBe(`token ${MASKED_TOKEN} rejected`);
    expect(maskText('Bearer abcdEFGH1234.xyz')).toBe(`Bearer ${MASKED_TOKEN}`);
  });

  it('masks credentials ingestion already recognizes', () => {
    expect(maskText('bad key sk_live_abcdefghijklmnop')).toBe(`bad key ${MASKED_TOKEN}`);
    expect(maskText('{"token":"abc","name":"Assets"}')).toBe(`{"token":"${MASKED_TOKEN}","name":"Assets"}`);
    expect(maskText('{"api_key": "k1"}')).toBe(`{"api_key": "${MASKED_TOKEN}"}`);
    expect(maskText('GET /cb?access_token=abc&page=2 failed')).toBe(`GET /cb?access_token=${MASKED_TOKEN}&page=2 failed`);
    expect(maskText('connect postgres://app:hunter2@db.internal:5432/app refused'))
      .toBe(`connect postgres://${MASKED_TOKEN}@db.internal:5432/app refused`);
  });

  it('masks JSON secret values with escaped quotes, unquoted values and a cut-off end', () => {
    expect(maskText('{"token":"abc\\"defghi"}')).toBe(`{"token":"${MASKED_TOKEN}"}`);
    expect(maskText('{"token":12345}')).toBe(`{"token":"${MASKED_TOKEN}"}`);
    expect(maskText('{"password":"top secret words')).toBe(`{"password":"${MASKED_TOKEN}"`);
  });

  it('masks secret values under camelCase and header-style keys, including arrays', () => {
    expect(maskText('{"accessToken":"abcDEF123xyz","client_secret":"s1","X-Auth-Token":"tok_abc123"}'))
      .toBe(`{"accessToken":"${MASKED_TOKEN}","client_secret":"${MASKED_TOKEN}","X-Auth-Token":"${MASKED_TOKEN}"}`);
    expect(maskText('{"token":["firstsecret","secondsecret"],"ok":1}')).toBe(`{"token":"${MASKED_TOKEN}","ok":1}`);
  });

  it('masks percent-encoded emails and credentials, and tokens in a fragment', () => {
    expect(maskText('GET https://app.example/users/jane%40acme.com?access%5Ftoken=shortsecret'))
      .toBe(`GET https://app.example/users/${MASKED_EMAIL}?access_token=${MASKED_TOKEN}`);
    expect(maskText('redirect to /callback#access_token=shortsecret'))
      .toBe(`redirect to /callback#access_token=${MASKED_TOKEN}`);
  });

  it('keeps ordinary words that name a credential', () => {
    expect(maskText('Invalid token: expired')).toBe('Invalid token: expired');
    expect(maskText('Invalid password format')).toBe('Invalid password format');
    expect(maskText('Basic subscription required')).toBe('Basic subscription required');
    expect(maskText('DEF_TIMEOUT_MS exceeded')).toBe('DEF_TIMEOUT_MS exceeded');
    expect(maskText('ERR_PAYMENT_METHOD_DECLINED_CODE_4001_RETRY_LATER'))
      .toBe('ERR_PAYMENT_METHOD_DECLINED_CODE_4001_RETRY_LATER');
  });

  it('keeps an @ in a URL path, which is not a credential', () => {
    const frame = 'at x (https://cdn.jsdelivr.net/npm/@vue/runtime-core@3.4.21/dist/runtime-core.js)';
    expect(maskText(frame)).toBe(frame);
    expect(maskText('see https://medium.com/@user/post-title')).toBe('see https://medium.com/@user/post-title');
  });

  it('stays fast on hostile email- and URL-shaped input', () => {
    const started = Date.now();
    maskText('a.'.repeat(4096));
    maskText(`a@${'b.'.repeat(4096)}`);
    maskText(`a://b:${'c'.repeat(8190)}`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('masks long opaque tokens that mix letters and digits', () => {
    expect(maskText('session sess_9f8e7d6c5b4a39281706f5e4d3c2b1a0ff expired'))
      .toBe(`session ${MASKED_TOKEN} expired`);
  });

  it('keeps long identifiers that have no digits', () => {
    const name = 'handleAssetTypeDeletionRequestFailure';
    expect(name.length).toBeGreaterThanOrEqual(32);
    expect(maskText(`${name} is not a function`)).toBe(`${name} is not a function`);
  });

  it('masks runs of six or more digits and keeps shorter numbers', () => {
    expect(maskText('Order 12345678 failed with 500 on port 8080 after 12345 ms'))
      .toBe(`Order ${MASKED_NUMBER} failed with 500 on port 8080 after 12345 ms`);
  });

  it('keeps the existing credential scrubbing', () => {
    expect(maskText('clone with ghp_abcdefghijklmnop failed')).toBe('clone with [REDACTED] failed');
  });

  it('leaves ordinary messages untouched', () => {
    const message = 'There is already a Loanee with this name.';
    expect(maskText(message)).toBe(message);
  });

  it('processes at most 8192 characters and drops a token cut at that boundary', () => {
    expect(maskText('a'.repeat(100_000))).toBe('a'.repeat(8192 - 256));
    const words = maskText('word '.repeat(5_000));
    expect(words.length).toBeLessThanOrEqual(8192);
    expect(words.endsWith('word ')).toBe(true);
  });
});

describe('dropCutToken', () => {
  it('removes a trailing partial value and keeps whole words', () => {
    expect(dropCutToken('1111 jane.doe@acm')).toBe('1111 ');
    expect(dropCutToken('whole words ')).toBe('whole words ');
  });

  it('removes at most 256 characters from text with no whitespace', () => {
    expect(dropCutToken('x'.repeat(1_000))).toBe('x'.repeat(744));
  });

  it('stays linear on long runs that end in whitespace', () => {
    const started = Date.now();
    for (let i = 0; i < 100; i += 1) maskText(`${'a'.repeat(8_191)} ${'b'.repeat(10)}`);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('maskStackLine', () => {
  it('keeps the line and column of a V8 frame', () => {
    expect(maskStackLine('    at deleteAssets (https://app.example.com/assets/index.js:1:234567)'))
      .toBe('    at deleteAssets (https://app.example.com/assets/index.js:1:234567)');
  });

  it('keeps the line and column of a Firefox frame', () => {
    expect(maskStackLine('deleteAssets@https://app.example.com/assets/index.js:1:234567'))
      .toBe('deleteAssets@https://app.example.com/assets/index.js:1:234567');
  });

  it('masks values before the frame position', () => {
    expect(maskStackLine('    at https://app.example.com/u/jane@acme.com/1234567.js:2:10'))
      .toBe(`    at https://app.example.com/u/${MASKED_EMAIL}/${MASKED_NUMBER}.js:2:10`);
  });

  it('does not exempt a numeric suffix on a line that is not a frame', () => {
    expect(maskStackLine('Error: account:12345678')).toBe(`Error: account:${MASKED_NUMBER}`);
  });
});

describe('maskPageUrl', () => {
  it('drops credentials and the query string', () => {
    expect(maskPageUrl('https://bob:secret@app.example.com/assets/42?email=jane@acme.com&tab=2'))
      .toBe('https://app.example.com/assets/42');
  });

  it('keeps a hash route and masks values in it', () => {
    expect(maskPageUrl('https://app.example.com/#/assets/12345678/edit'))
      .toBe(`https://app.example.com/#/assets/${MASKED_NUMBER}/edit`);
  });

  it('drops a fragment that carries a token, encoded or not', () => {
    expect(maskPageUrl('https://app.example.com/callback#access_token=abc'))
      .toBe('https://app.example.com/callback');
    expect(maskPageUrl('https://app.example.com/callback#access%5Ftoken=abc'))
      .toBe('https://app.example.com/callback');
  });

  it('drops a token fragment even when its percent-encoding is malformed', () => {
    expect(maskPageUrl('https://app.example.com/#access_%74oken=abc%ZZ'))
      .toBe('https://app.example.com/');
  });

  it('masks a percent-encoded email in the path, even beside a malformed escape', () => {
    expect(maskPageUrl('https://app.example.com/users/jane%40acme.com'))
      .toBe(`https://app.example.com/users/${MASKED_EMAIL}`);
    expect(maskPageUrl('https://app.example.com/users/jane%40acme.com/%ZZ'))
      .toBe(`https://app.example.com/users/${MASKED_EMAIL}/%ZZ`);
  });

  it('drops a query string inside a hash route', () => {
    expect(maskPageUrl('https://app.example.com/#/reset?email=jane@acme.com&session=abc123'))
      .toBe('https://app.example.com/#/reset');
  });

  it('cuts a malformed URL at its query and still masks it', () => {
    expect(maskPageUrl('not a url/jane@acme.com?x=1')).toBe(`not a url/${MASKED_EMAIL}`);
  });
});

describe('maskStructured', () => {
  it('replaces values under sensitive keys whatever their type', () => {
    expect(maskStructured({ token: 12345, Password: { nested: 'x' }, status: 409 }))
      .toEqual({ token: MASKED_TOKEN, Password: MASKED_TOKEN, status: 409 });
  });

  it('masks string leaves, JSON inside strings, keys and long numbers', () => {
    expect(maskStructured({
      body: '{"token":"abc"}',
      user: 'jane@acme.com',
      'jane@acme.com': true,
      orderId: 12345678,
      list: ['ok', 'call 99887766'],
    })).toEqual({
      body: `{"token":"${MASKED_TOKEN}"}`,
      user: MASKED_EMAIL,
      [MASKED_EMAIL]: true,
      orderId: MASKED_NUMBER,
      list: ['ok', `call ${MASKED_NUMBER}`],
    });
  });

  it('masks JSON held in a string as structure, whatever the value type or key spelling', () => {
    expect(maskStructured({ body: '{"token":["firstsecret","secondsecret"],"pass\\u0077ord":"hunter2","n":1}' }))
      .toEqual({ body: `{"token":"${MASKED_TOKEN}","password":"${MASKED_TOKEN}","n":1}` });
    expect(maskStructured({ accessToken: 'abc', 'x-api-key': 'k', cookie: 'session=s', status: 409 }))
      .toEqual({ accessToken: MASKED_TOKEN, 'x-api-key': MASKED_TOKEN, cookie: MASKED_TOKEN, status: 409 });
  });

  it('keeps a __proto__ key as data', () => {
    expect(JSON.stringify(maskStructured(JSON.parse('{"__proto__":{"a":1},"ok":1}'))))
      .toBe('{"__proto__":{"a":1},"ok":1}');
  });

  it('stops walking after a fixed number of nodes', () => {
    const wide = Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 'leaf'));
    const serialized = JSON.stringify(maskStructured({ rows: wide }));
    expect(serialized).toContain('[omitted]');
    expect(serialized.match(/leaf/g)?.length ?? 0).toBeLessThan(200);
  });

  it('bounds depth and width', () => {
    const deep = { a: { b: { c: { d: { e: 'x' } } } } };
    expect(maskStructured(deep)).toEqual({ a: { b: { c: { d: '[omitted]' } } } });
    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(maskStructured(wide) as Record<string, unknown>)).toHaveLength(20);
  });
});
