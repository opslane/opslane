import { writeFileSync } from 'node:fs';

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');
const raw = (bytes) => Buffer.from(bytes).toString('base64');

const BASIC =
  '{"debugId":"ffffffff-ffff-ffff-ffff-ffffffffffff","version":3,"sources":["src/a.ts"],"names":[],"mappings":"AAAA","sourcesContent":["export const x = 1;\\n"]}';
const BASIC_CANONICAL =
  '{"mappings":"AAAA","names":[],"sources":["src/a.ts"],"sourcesContent":["export const x = 1;\\n"],"version":3}';

const UNICODE =
  '{"version":3,"names":["render"],"sourcesContent":["const 雪 = \\"☃\\";"],"sources":["src/雪.ts"],"mappings":"AAAAA","x_opslane":{"z":1,"a":{"beta":"雪","quote":"\\""}},"x_google_ignoreList":[0]}';
const UNICODE_CANONICAL =
  '{"mappings":"AAAAA","names":["render"],"sources":["src/雪.ts"],"sourcesContent":["const 雪 = \\"☃\\";"],"version":3,"x_google_ignoreList":[0],"x_opslane":{"a":{"beta":"雪","quote":"\\""},"z":1}}';

const ESCAPES =
  '{"version":3,"sources":["src/escape.ts"],"sourcesContent":["line 1\\nline 2\\t\\"quoted\\"\\\\slash\\u0001"],"names":[],"mappings":";AACA","sourceRoot":"https://example.com/雪/"}';
const ESCAPES_CANONICAL =
  '{"mappings":";AACA","names":[],"sourceRoot":"https://example.com/雪/","sources":["src/escape.ts"],"sourcesContent":["line 1\\nline 2\\t\\"quoted\\"\\\\slash\\u0001"],"version":3}';

const cases = [
  {
    name: 'basic-debugid-excluded',
    input_b64: b64(BASIC),
    outcome: 'ok',
    canonical_b64: b64(BASIC_CANONICAL),
    sha256: '158399f31dad138635b298c34317d52e058db2d329438e3161b0c04bcd82b9df',
    debug_id: '158399f3-1dad-1386-35b2-98c34317d52e',
  },
  {
    name: 'nested-unicode-extensions',
    input_b64: b64(UNICODE),
    outcome: 'ok',
    canonical_b64: b64(UNICODE_CANONICAL),
    sha256: '34dcf2e100be435f745532f705ad545ccbf6dc9dbc607f4cbe8dab72d63f364d',
    debug_id: '34dcf2e1-00be-435f-7455-32f705ad545c',
  },
  {
    name: 'escapes-control-characters',
    input_b64: b64(ESCAPES),
    outcome: 'ok',
    canonical_b64: b64(ESCAPES_CANONICAL),
    sha256: '197a3f87a4f5fd89cb796c4004b834972ee5912d60fdd8676811fab0dd031b66',
    debug_id: '197a3f87-a4f5-fd89-cb79-6c4004b83497',
  },
  {
    name: 'stamped-map-stability',
    input_b64: b64(
      BASIC.replace(
        'ffffffff-ffff-ffff-ffff-ffffffffffff',
        '158399f3-1dad-1386-35b2-98c34317d52e',
      ),
    ),
    outcome: 'ok',
    canonical_b64: b64(BASIC_CANONICAL),
    sha256: '158399f31dad138635b298c34317d52e058db2d329438e3161b0c04bcd82b9df',
    debug_id: '158399f3-1dad-1386-35b2-98c34317d52e',
  },
];

const MIN = '{"version":3,"sources":[],"names":[],"mappings":"","sourcesContent":[]}';
const rejects = [
  ['reject-bom', 'bom', raw([0xef, 0xbb, 0xbf, ...Buffer.from(MIN, 'utf8')])],
  [
    'reject-duplicate-key',
    'duplicate_key',
    b64(
      '{"version":3,"\\u0076ersion":3,"sources":[],"names":[],"mappings":"","sourcesContent":[]}',
    ),
  ],
  [
    'reject-invalid-utf8',
    'invalid_utf8',
    raw([
      ...Buffer.from('{"version":3,"mappings":"', 'utf8'),
      0xff,
      ...Buffer.from('"}', 'utf8'),
    ]),
  ],
  ['reject-trailing-data', 'trailing_data', b64(MIN + '{}')],
  ['reject-depth', 'depth_exceeded', b64('['.repeat(65) + ']'.repeat(65))],
  [
    'reject-lone-surrogate',
    'invalid_unicode',
    b64(
      '{"version":3,"names":["\\ud800"],"sources":[],"mappings":"","sourcesContent":[]}',
    ),
  ],
  [
    'reject-non-finite',
    'non_finite_number',
    b64(
      '{"version":3,"x":1e400,"sources":[],"names":[],"mappings":"","sourcesContent":[]}',
    ),
  ],
  [
    'reject-bad-version',
    'bad_version',
    b64('{"version":2,"sources":[],"names":[],"mappings":"","sourcesContent":[]}'),
  ],
  [
    'reject-indexed-map',
    'indexed_map',
    b64(
      '{"version":3,"sections":[],"sources":[],"names":[],"mappings":"","sourcesContent":[]}',
    ),
  ],
  [
    'reject-bad-field-type',
    'bad_field_type',
    b64(
      '{"version":3,"sources":"src/a.ts","names":[],"mappings":"","sourcesContent":[]}',
    ),
  ],
  [
    'reject-sources-content-mismatch',
    'sources_content_mismatch',
    b64(
      '{"version":3,"sources":["src/a.ts"],"names":[],"mappings":"","sourcesContent":[]}',
    ),
  ],
];

for (const [name, reject_reason, input_b64] of rejects) {
  cases.push({ name, input_b64, outcome: 'reject', reject_reason });
}

writeFileSync(
  new URL('./vectors.json', import.meta.url),
  `${JSON.stringify({ version: 1, cases }, null, 2)}\n`,
);
console.log(`wrote ${cases.length} cases`);
