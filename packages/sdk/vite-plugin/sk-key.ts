/**
 * Source-map key decoder — the TypeScript half of one validation contract.
 *
 * A source-map key is `opslane_sk_<keyid:26>_<secret:43>_<payload>`, where the
 * payload is unpadded base64url JSON `{v:1, iat, url}` carrying the upload
 * destination. The server's decoder lives in `packages/ingestion/db/sk_payload.go`
 * and both are pinned to `test-fixtures/sourcemap-key/vectors.json`: if the two
 * ever drift, one of the two vector suites goes red.
 *
 * Failures return a stable reason token, never key material — the reason is
 * printed in a build warning that developers paste into issues.
 */

export type ParsedSourceMapKey =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/** Caps the whole raw key, enforced before any base64 or JSON work. */
const MAX_RAW_KEY_LEN = 4096;
/** Caps the embedded endpoint. */
const MAX_URL_LEN = 2048;

// Grammar widths: "opslane_sk_" + keyid(26) + "_" + secret(43) [+ "_" + payload].
const PREFIX_LEN = 'opslane_sk_'.length; // 11; pk is the same width
const KEY_ID_LEN = 26;
const SECRET_LEN = 43;
/**
 * One past the secret: the full length of a bare key, and where a source-map
 * key's "_" + payload begins.
 */
const SECRET_END = PREFIX_LEN + KEY_ID_LEN + 1 + SECRET_LEN; // 81

const KEY_ID_RE = /^[a-z2-7]{26}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const INTEGER_LITERAL_RE = /^-?(?:0|[1-9][0-9]*)$/;
const IAT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

const fail = (reason: string): ParsedSourceMapKey => ({ ok: false, reason });

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

/**
 * Recognise a raw source-map key and return the upload URL sealed into it.
 *
 * Order matters and mirrors the Go parser exactly: length cap, then grammar at
 * fixed offsets (the secret and the payload are both base64url and may contain
 * '_', so nothing here splits on the separator), then the payload.
 */
export function parseSourceMapKey(raw: string): ParsedSourceMapKey {
  if (typeof raw !== 'string') return fail('bad_grammar');
  if (byteLength(raw) > MAX_RAW_KEY_LEN) return fail('too_long');

  const prefix = raw.slice(0, PREFIX_LEN);
  if (prefix !== 'opslane_sk_' && prefix !== 'opslane_pk_') return fail('bad_grammar');
  if (raw.length < SECRET_END) return fail('bad_grammar');
  if (!KEY_ID_RE.test(raw.slice(PREFIX_LEN, PREFIX_LEN + KEY_ID_LEN))) {
    return fail('bad_grammar');
  }
  if (raw[PREFIX_LEN + KEY_ID_LEN] !== '_') return fail('bad_grammar');
  if (!SECRET_RE.test(raw.slice(PREFIX_LEN + KEY_ID_LEN + 1, SECRET_END))) {
    return fail('bad_grammar');
  }

  if (prefix === 'opslane_pk_') {
    // A public key never carries routing data, and it is not an upload
    // credential either way.
    return fail(raw.length > SECRET_END ? 'payload_on_pk' : 'bad_grammar');
  }
  if (raw.length === SECRET_END) {
    // Grammatically fine and still accepted by the server, but there is
    // nowhere to upload to.
    return fail('legacy_format');
  }
  if (raw[SECRET_END] !== '_') return fail('bad_grammar');
  const segment = raw.slice(SECRET_END + 1);
  if (segment === '') return fail('empty_payload');
  return parsePayload(segment);
}

/**
 * Strictly decode a payload segment: exactly {v:1, iat, url}, with unknown,
 * duplicate, and missing fields rejected and the URL policy enforced.
 */
function parsePayload(segment: string): ParsedSourceMapKey {
  const bytes = decodeBase64Url(segment);
  if (bytes === null) return fail('bad_base64');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('bad_json');
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('bad_json');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('bad_json');
  }
  const object = value as Record<string, unknown>;

  // JSON.parse collapses duplicates and erases the difference between `1` and
  // `1.0`; a rescan of the decoded text recovers both facts.
  const scanned = scanTopLevelObject(text);
  if (scanned === null) return fail('bad_json');
  if (scanned.duplicate !== undefined) return fail('duplicate_field');

  for (const field of ['v', 'iat', 'url']) {
    if (!Object.prototype.hasOwnProperty.call(object, field)) {
      return fail('missing_field');
    }
  }
  if (Object.keys(object).length !== 3) return fail('unknown_field');

  // Go unmarshals v into an int, so `1.0`, `1e0`, and `"1"` are all type
  // errors there; the raw token is what makes the same true here.
  const vToken = scanned.values.get('v') ?? '';
  if (!INTEGER_LITERAL_RE.test(vToken) || !Number.isSafeInteger(Number(vToken))) {
    return fail('bad_field_type');
  }
  if (typeof object['iat'] !== 'string') return fail('bad_field_type');
  if (typeof object['url'] !== 'string') return fail('bad_field_type');
  if (Number(vToken) !== 1) return fail('bad_version');
  if (!isRFC3339UTC(object['iat'])) return fail('bad_iat');

  const canonical = canonicalIngestURL(object['url']);
  if (!canonical.ok) return canonical;
  if (canonical.url !== object['url']) return fail('url_not_canonical');
  return canonical;
}

/** Decode unpadded base64url. Padding, whitespace, and stray characters fail. */
function decodeBase64Url(segment: string): Uint8Array | null {
  if (!BASE64URL_RE.test(segment)) return null;
  if (segment.length % 4 === 1) return null;
  const padded =
    segment.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (segment.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** RFC 3339 with a literal Z: the only spelling the minter produces. */
function isRFC3339UTC(iat: string): boolean {
  const match = IAT_RE.exec(iat);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((part) => Number(part));
  if (month! < 1 || month! > 12 || day! < 1) return false;
  if (hour! > 23 || minute! > 59 || second! > 59) return false;
  // Round-tripping through Date.UTC rejects impossible days such as 02-30.
  const stamp = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  return stamp.getUTCFullYear() === year && stamp.getUTCMonth() === month! - 1
    && stamp.getUTCDate() === day;
}

/**
 * Enforce the frozen URL policy and return the canonical origin: lowercase
 * scheme and host, default ports stripped, no trailing slash, https (http for
 * loopback hosts only), nothing but the origin.
 *
 * Hand-parsed rather than handed to `URL`, because `URL` silently normalizes
 * exactly the inputs this policy exists to refuse — `:0443` becomes `:443` and
 * then disappears as a default port, so a key minted against one origin would
 * validate as another.
 */
function canonicalIngestURL(raw: string): ParsedSourceMapKey {
  if (byteLength(raw) > MAX_URL_LEN) return fail('url_too_long');
  const trimmed = raw.trim();
  const split = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([\s\S]*)$/.exec(trimmed);
  if (!split) return fail('url_invalid');
  const scheme = split[1]!.toLowerCase();

  const rest = split[2]!;
  const cut = rest.search(/[/?#]/);
  const tail = cut < 0 ? '' : rest.slice(cut);
  let authority = cut < 0 ? rest : rest.slice(0, cut);

  const at = authority.lastIndexOf('@');
  const hasUserinfo = at >= 0;
  if (hasUserinfo) authority = authority.slice(at + 1);

  let host: string;
  let port = '';
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return fail('url_invalid');
    host = authority.slice(1, close);
    const after = authority.slice(close + 1);
    if (after !== '') {
      if (!after.startsWith(':')) return fail('url_invalid');
      port = after.slice(1);
    }
  } else {
    const colon = authority.indexOf(':');
    if (colon < 0) {
      host = authority;
    } else {
      host = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    }
  }
  if (!/^\d*$/.test(port)) return fail('url_invalid');
  host = host.toLowerCase();
  if (host === '') return fail('url_invalid');

  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (scheme === 'http') {
    if (!loopback) return fail('url_scheme');
  } else if (scheme !== 'https') {
    return fail('url_scheme');
  }
  if (hasUserinfo || (tail !== '' && tail !== '/')) return fail('url_not_origin');
  // ASCII-only hostnames: sidesteps Go-vs-JS IDNA divergence entirely.
  for (let i = 0; i < host.length; i += 1) {
    if (host.charCodeAt(i) >= 0x80) return fail('url_host_ascii');
  }
  if (port !== '') {
    const parsed = Number(port);
    if (parsed < 1 || parsed > 65535 || (port.length > 1 && port.startsWith('0'))) {
      return fail('url_port');
    }
  }
  if ((scheme === 'https' && port === '443') || (scheme === 'http' && port === '80')) {
    port = '';
  }
  const hostport = host.includes(':') ? `[${host}]` : host; // IPv6 literal
  return { ok: true, url: `${scheme}://${hostport}${port === '' ? '' : `:${port}`}` };
}

/**
 * Re-walk decoded JSON text to recover what `JSON.parse` throws away: the
 * top-level key order (so repeats are visible) and each value's raw token.
 *
 * Only ever runs on text `JSON.parse` already accepted, so it can assume
 * well-formedness and stay small: skip strings honouring backslash escapes,
 * track bracket depth outside strings, and decode each key token with
 * `JSON.parse` so an escaped spelling like "v" is seen as `v`.
 */
function scanTopLevelObject(
  text: string,
): { duplicate?: string; values: Map<string, string> } | null {
  let i = 0;
  const skipWhitespace = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
  };
  const readString = (): boolean => {
    i += 1; // opening quote
    while (i < text.length) {
      const char = text[i]!;
      if (char === '\\') {
        i += 2;
        continue;
      }
      i += 1;
      if (char === '"') return true;
    }
    return false;
  };
  const readValue = (): string | null => {
    skipWhitespace();
    const start = i;
    let depth = 0;
    while (i < text.length) {
      const char = text[i]!;
      if (char === '"') {
        if (!readString()) return null;
        continue;
      }
      if (char === '{' || char === '[') {
        depth += 1;
      } else if (char === '}' || char === ']') {
        if (depth === 0) break;
        depth -= 1;
      } else if (char === ',' && depth === 0) {
        break;
      }
      i += 1;
    }
    return text.slice(start, i).trim();
  };

  skipWhitespace();
  if (text[i] !== '{') return null;
  i += 1;
  const values = new Map<string, string>();
  let duplicate: string | undefined;
  skipWhitespace();
  if (text[i] === '}') return { values };
  for (;;) {
    skipWhitespace();
    if (text[i] !== '"') return null;
    const start = i;
    if (!readString()) return null;
    let key: unknown;
    try {
      key = JSON.parse(text.slice(start, i));
    } catch {
      return null;
    }
    if (typeof key !== 'string') return null;
    skipWhitespace();
    if (text[i] !== ':') return null;
    i += 1;
    const value = readValue();
    if (value === null) return null;
    if (values.has(key)) duplicate = key;
    else values.set(key, value);
    skipWhitespace();
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    if (text[i] === '}') break;
    return null;
  }
  return { duplicate, values };
}
