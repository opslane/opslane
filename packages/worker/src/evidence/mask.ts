import { scrubCredentialShapes } from '../harness/redact.js';

/**
 * Mask personal data and credentials in customer-captured error text before it
 * reaches a model prompt.
 *
 * Ingestion stores error messages as sent and keeps emails on purpose (B2B
 * identity relies on them), so the prompt boundary is where they go. Values are
 * masked by shape or by an unambiguous key, never by a bare word, because the
 * model searches the repository for the words that remain. The placeholders
 * are words the inquiry prompt tells the model never to search for.
 *
 * The text is attacker-controlled. Every pattern here is linear in its input or
 * runs on input already bounded by MAX_MASK_INPUT.
 */

export const MASKED_EMAIL = '[email]';
export const MASKED_TOKEN = '[token]';
export const MASKED_NUMBER = '[number]';
export const MASKED_OMITTED = '[omitted]';

/** Backstop only; callers bound each field far below this. */
const MAX_MASK_INPUT = 8_192;
/**
 * Characters that end a value: whitespace and the punctuation around values in
 * JSON, URLs, query strings and key=value text. `@` and `.` are not here, so a
 * cut never keeps the local part of an email.
 */
const VALUE_DELIMITER = /[\s"'`,;()<>{}[\]=:?&#]/;

// Only the escapes that can hide a masked shape: `jane%40acme.com`,
// `access%5Ftoken=`. Decoding everything would rewrite ordinary message text.
const MASK_RELEVANT_ESCAPE = /%(40|5F|3D|26|3F|23|3A|2F|2E|2D|2B)/gi;
// The credential shapes below mirror packages/ingestion/masking/masking.go.
// urlCredRe: its classes stop at `/`, so an `@` in a URL path (`/npm/@vue/…`,
// an email) is not a credential. Length-bounded so a long scheme-like run
// cannot go quadratic.
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^/@\s:]{1,256}(?::[^/@\s]{1,256})?@/gi;
// proseEmailPattern in packages/ingestion/narrative/narrative.go, with RFC
// length bounds for the same reason.
const EMAIL = /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,24}\b/gi;
// apiKeyPrefixRe, case-sensitive so constants such as DEF_TIMEOUT survive.
const API_KEY_PREFIX = /\b(?:sk_live_|sk_test_|AKIA|ghp_|gho_|def_|opslane_pk_|opslane_sk_|opslane_ak_)[A-Za-z0-9_-]+/g;
// jwtRe; the signature may be empty for an unsigned token.
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
// Case-sensitive with a credential-length value, so "Basic subscription" stays.
const BEARER = /\b(Bearer|Basic) [A-Za-z0-9._~+/=-]{16,}/g;
const SECRET_KEY_NAME = 'password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|credential';
// passwordFieldRe, widened: any quoted key naming a secret (`"accessToken"`,
// `"X-Auth-Token"`), whose value is an escape-aware string that may end at end
// of input (its closing quote cut away), a flat array or object, or a scalar.
const SECRET_JSON_FIELD = new RegExp(
  `("[^"\\\\\\n]{0,64}?(?:${SECRET_KEY_NAME})[^"\\\\\\n]{0,64}"\\s*:\\s*)`
    + '(?:"(?:[^"\\\\]|\\\\[\\s\\S])*(?:"|\\\\?$)|\\[[^\\]]*(?:\\]|$)|\\{[^}]*(?:\\}|$)|[^,}\\]\\s]+)',
  'gi',
);
const SENSITIVE_KEY = /password|passwd|pwd|secret|token|apikey|authorization|cookie|credential/;
// urlSecretQueryRe, plus the OAuth names tokenFragmentRe drops, in a query or
// a fragment.
const SECRET_QUERY_PARAM = /([?&#;](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|password|pwd|session|sig|signature|code)=)[^&\s"'#;]+/gi;
// A plain run; whether it is a token is decided in the replacer, so there is no
// lookahead to rescan the run from every starting position.
const OPAQUE_RUN = /[A-Za-z0-9_-]{20,}/g;
const OPAQUE_SEGMENT_CHARS = 20;
const OPAQUE_SEGMENT_DIGITS = 3;
const LONG_DIGITS = /\d{6,}/g;
const LONG_DIGIT_RUN = /\d{6,}/;

const MAX_STRUCTURED_DEPTH = 4;
const MAX_STRUCTURED_ENTRIES = 20;
const MAX_STRUCTURED_LEAF = 1_024;
const MAX_STRUCTURED_NODES = 200;

const V8_FRAME = /^\s*at\s/;
const GECKO_FRAME = /^[^\s@]*@\S/;
// `:line` or `:line:column`, optionally closed by `)`, at the end of a frame.
const FRAME_POSITION = /(?::\d+){1,2}\)?\s*$/;
const TOKEN_FRAGMENT = /(access_token|id_token|refresh_token|token|code)=/i;

/**
 * A run is a token when one of its `_`/`-` segments is long and digit-heavy:
 * random keys and hashes are, while error codes (`ERR_CODE_4001_RETRY`) and
 * identifiers (`renderV2Component`) are not.
 */
function maskOpaqueRun(run: string): string {
  const isToken = run.split(/[_-]/).some((segment) => (
    segment.length >= OPAQUE_SEGMENT_CHARS
    && /[A-Za-z]/.test(segment)
    && (segment.match(/\d/g)?.length ?? 0) >= OPAQUE_SEGMENT_DIGITS
  ));
  return isToken ? MASKED_TOKEN : run;
}

function decodeMaskRelevantEscapes(text: string): string {
  return text.replace(MASK_RELEVANT_ESCAPE, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * After a length cut, drop the value the cut went through. A severed email or
 * key no longer matches its pattern, so masking it would show half of it.
 * The whole severed value goes, however long: `https://user:` followed by part
 * of a credential has no `@` left to match. A text with no delimiter at all is
 * one value, and nothing of it is kept.
 * A backward scan, not `/\S+$/`: that regex rescans the run from every start
 * and is quadratic on a long run ending in whitespace.
 */
export function dropCutToken(text: string): string {
  for (let end = text.length; end > 0; end -= 1) {
    if (VALUE_DELIMITER.test(text.charAt(end - 1))) return text.slice(0, end);
  }
  return '';
}

/** Mask emails, credentials, long mixed tokens and runs of six or more digits. */
export function maskText(text: string): string {
  const bounded = text.length > MAX_MASK_INPUT ? dropCutToken(text.slice(0, MAX_MASK_INPUT)) : text;
  const withoutIdentity = decodeMaskRelevantEscapes(bounded)
    .replace(URL_CREDENTIALS, `$1${MASKED_TOKEN}@`)
    .replace(EMAIL, MASKED_EMAIL);
  return scrubCredentialShapes(withoutIdentity)
    .replace(API_KEY_PREFIX, MASKED_TOKEN)
    .replace(JWT, MASKED_TOKEN)
    .replace(BEARER, `$1 ${MASKED_TOKEN}`)
    .replace(SECRET_JSON_FIELD, `$1"${MASKED_TOKEN}"`)
    .replace(SECRET_QUERY_PARAM, `$1${MASKED_TOKEN}`)
    .replace(OPAQUE_RUN, maskOpaqueRun)
    .replace(LONG_DIGITS, MASKED_NUMBER);
}

/** Mask a raw stack line; a real frame keeps its trailing line and column. */
export function maskStackLine(line: string): string {
  if (!V8_FRAME.test(line) && !GECKO_FRAME.test(line)) return maskText(line);
  const position = FRAME_POSITION.exec(line);
  if (!position) return maskText(line);
  return `${maskText(line.slice(0, position.index))}${position[0]}`;
}

/**
 * Percent-decode a URL for masking. A malformed escape makes decodeURIComponent
 * throw; falling back to the raw text would let `access_%74oken=` or
 * `jane%40acme.com` slip past the patterns, so decode the ASCII escapes alone.
 */
function decodeLoose(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%([0-7][0-9A-Fa-f])/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
}

/**
 * Keep origin, path and a hash route; drop credentials, the whole query string
 * (including one inside a hash route) and any token-bearing fragment (checked
 * after decoding), the same fields RedactRequestURL drops in
 * packages/ingestion/masking/masking.go. Then mask what remains.
 */
export function maskPageUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    const cut = raw.search(/[?#]/);
    return maskText(decodeLoose(cut >= 0 ? raw.slice(0, cut) : raw));
  }
  url.username = '';
  url.password = '';
  url.search = '';
  if (TOKEN_FRAGMENT.test(decodeLoose(url.hash))) {
    url.hash = '';
  } else if (url.hash.includes('?')) {
    url.hash = url.hash.slice(0, url.hash.indexOf('?'));
  }
  return maskText(decodeLoose(url.toString()));
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.toLowerCase().replace(/[-_\s]/g, ''));
}

function boundLeaf(text: string): string {
  return text.length > MAX_STRUCTURED_LEAF ? dropCutToken(text.slice(0, MAX_STRUCTURED_LEAF)) : text;
}

interface WalkBudget {
  nodes: number;
}

/** JSON held in a string, such as a captured request body, is masked as structure. */
function maskLeaf(text: string, depth: number, budget: WalkBudget): string {
  const trimmed = text.trim();
  if (text.length <= MAX_STRUCTURED_LEAF && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      return JSON.stringify(walk(JSON.parse(trimmed) as unknown, depth + 1, budget));
    } catch {
      // Not JSON after all; mask it as text.
    }
  }
  return maskText(boundLeaf(text));
}

function walk(value: unknown, depth: number, budget: WalkBudget): unknown {
  if (budget.nodes <= 0) return MASKED_OMITTED;
  budget.nodes -= 1;
  if (typeof value === 'string') return maskLeaf(value, depth, budget);
  if (typeof value === 'number') return LONG_DIGIT_RUN.test(String(value)) ? MASKED_NUMBER : value;
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_STRUCTURED_DEPTH) return MASKED_OMITTED;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_STRUCTURED_ENTRIES).map((child) => walk(child, depth + 1, budget));
  }
  // Null prototype, so a `__proto__` key is kept as data rather than dropped.
  const masked: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value).slice(0, MAX_STRUCTURED_ENTRIES)) {
    masked[maskText(boundLeaf(key))] = isSensitiveKey(key) ? MASKED_TOKEN : walk(child, depth + 1, budget);
  }
  return masked;
}

/**
 * Mask a parsed JSON value before it is serialized. Values under a key naming a
 * secret go whatever their type; string leaves (including JSON held in a
 * string), keys and long numbers are masked. The walk is bounded in depth,
 * width and total nodes because the value is arbitrary customer JSON and only
 * a few hundred characters of it are kept.
 */
export function maskStructured(value: unknown): unknown {
  return walk(value, 0, { nodes: MAX_STRUCTURED_NODES });
}
