// TypeScript half of the URL-normalization contract. The Go implementation
// (packages/ingestion/priority/urlnorm.go) is the spec; both sides are pinned
// by test-fixtures/url-normalization/vectors.json. Port faithfully: WHATWG URL
// behavior yields where it disagrees with Go net/url on a fixture row.

const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const JWT = /^eyJ[A-Za-z0-9_-]+\./;
const HEX = /^[0-9a-fA-F]{16,}$/;
const MIXED = /^(?:[A-Za-z0-9+/=_]*\d[A-Za-z0-9+/=_]*[A-Za-z][A-Za-z0-9+/=_]*|[A-Za-z0-9+/=_]*[A-Za-z][A-Za-z0-9+/=_]*\d[A-Za-z0-9+/=_]*)$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const MAX_PATTERN_BYTES = 512;

export function normalizePageUrl(raw: string): string {
  if (raw === '') return '';

  let path: string;
  let frag = '';
  if (raw.startsWith('/')) {
    path = raw;
    const fragmentAt = path.indexOf('#');
    if (fragmentAt >= 0) {
      frag = path.slice(fragmentAt + 1);
      path = path.slice(0, fragmentAt);
    }
  } else {
    let host = '';
    try {
      host = new URL(raw).host;
    } catch {
      return '/not-parseable';
    }
    if (host === '') return '/not-parseable';

    const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(raw);
    if (match === null) return '/not-parseable';
    const authority = match[1] ?? '';
    const rest = raw.slice(match[0].length);
    const fragmentAt = rest.indexOf('#');
    const rawFragment = fragmentAt >= 0 ? rest.slice(fragmentAt + 1) : '';
    const pathAndQuery = fragmentAt >= 0 ? rest.slice(0, fragmentAt) : rest;
    const queryAt = pathAndQuery.indexOf('?');
    path = queryAt >= 0 ? pathAndQuery.slice(0, queryAt) : pathAndQuery;

    if (authority.includes('\\')) return '/not-parseable';
    if (hasInvalidEscape(authority) || hasInvalidEscape(path) || hasInvalidEscape(rawFragment)) {
      return '/not-parseable';
    }
    try {
      frag = decodeURIComponent(rawFragment);
    } catch {
      frag = rawFragment;
    }
  }

  if (frag.startsWith('!')) path = frag.slice(1);
  const delimiterAt = path.search(/[?#]/);
  if (delimiterAt >= 0) path = path.slice(0, delimiterAt);

  const out: string[] = [];
  for (const segment of trimSlashes(path).split('/')) {
    if (segment === '' || segment.startsWith('_ctx_')) continue;
    out.push(templateSegment(segment));
  }
  return boundPattern('/' + out.join('/'));
}

// Patterns reaching route_map are already normalized identity keys. Only the
// origin dialect differs, so canonicalization deliberately does not re-template.
export function canonicalPattern(pattern: string): string {
  const stripped = pattern.replace(/^https?:\/\/[^/]*/i, '');
  return stripped === '' ? '/' : stripped;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

function hasInvalidEscape(value: string): boolean {
  for (let i = value.indexOf('%'); i >= 0; i = value.indexOf('%', i + 1)) {
    if (!/^[0-9a-fA-F]{2}/.test(value.slice(i + 1))) return true;
  }
  return false;
}

function templateSegment(raw: string): string {
  let segment = raw;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    // Go leaves the original segment in place when PathUnescape fails.
  }
  const bytes = Buffer.byteLength(segment, 'utf8');
  if (NUMERIC.test(segment) || UUID.test(segment)) return ':id';
  if (
    JWT.test(segment) ||
    HEX.test(segment) ||
    (bytes >= 16 && !segment.includes('-') && MIXED.test(segment)) ||
    (bytes >= 25 && !/[-_]/.test(segment)) ||
    (bytes >= 22 &&
      BASE64URL.test(segment) &&
      (/\d/.test(segment) || segment !== segment.toLowerCase()))
  ) {
    return ':token';
  }
  return segment;
}

function boundPattern(pattern: string): string {
  return Buffer.byteLength(pattern, 'utf8') > MAX_PATTERN_BYTES ? '/too-long' : pattern;
}
