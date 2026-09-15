const SECRET_KEY_PARTS = ['secret', 'password', 'passwd', 'apikey', 'api_key', 'api-key', 'private_key', 'privatekey', 'credential', 'authorization'];

/** Whether a field or variable name carries a secret value. */
export function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_PARTS.some((part) => lower.includes(part)) || /token$/.test(lower);
}

// A key starts where no key character precedes it and is at most 64 characters,
// so each run of key characters is tried once. With a plain \b every `.` or `-`
// restarted the scan, which was quadratic on text such as `a.b.c.d…`.
const KEY = String.raw`(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]{0,63})`;
const RAW_JSON_PAIR = /("([A-Za-z0-9_.-]{1,64})"\s*:\s*")((?:[^"\\]|\\.)*)(")/g;
const ESCAPED_JSON_PAIR = /(\\"([A-Za-z0-9_.-]{1,64})\\"\s*:\s*\\")((?:[^"\\]|\\(?!"))*)(\\")/g;
const SINGLE_QUOTED_PAIR = /('([A-Za-z0-9_.-]{1,64})'\s*:\s*')((?:[^'\\]|\\.)*)(')/g;
const QUOTED_ASSIGNMENT = new RegExp(String.raw`${KEY}(\s*[=:]\s*)(["'])((?:(?!\3)[^\\\r\n]|\\.)*)\3`, 'g');
const BARE_ASSIGNMENT = new RegExp(String.raw`${KEY}(\s*[=:]\s*)(["']?)([^\s"',;&]+)\3`, 'g');

function redactNamedPairs(text: string): string {
  return text
    // "key": "value" (raw JSON)
    .replace(RAW_JSON_PAIR, (match, open: string, key: string, _value: string, close: string) =>
      (isSecretKey(key) ? `${open}[REDACTED]${close}` : match))
    // \"key\": \"value\" (JSON escaped inside another JSON string)
    .replace(ESCAPED_JSON_PAIR, (match, open: string, key: string, _value: string, close: string) =>
      (isSecretKey(key) ? `${open}[REDACTED]${close}` : match))
    // 'key': 'value' (JavaScript and Python literals)
    .replace(SINGLE_QUOTED_PAIR, (match, open: string, key: string, _value: string, close: string) =>
      (isSecretKey(key) ? `${open}[REDACTED]${close}` : match))
    // KEY="quoted value" and key: 'quoted value'
    .replace(QUOTED_ASSIGNMENT, (match, key: string, sep: string, quote: string) =>
      (isSecretKey(key) ? `${key}${sep}${quote}[REDACTED]${quote}` : match))
    // KEY=value and key: value (env files, logs, shell)
    .replace(BARE_ASSIGNMENT, (match, key: string, sep: string, quote: string, value: string) =>
      (isSecretKey(key) && value !== '[REDACTED]' && !value.startsWith('[REDACTED') ? `${key}${sep}${quote}[REDACTED]${quote}` : match));
}

// An Authorization credential: an optional scheme, then either comma-separated
// auth-params (quoted values may be JSON-escaped inside another string) or one
// token. Only the credential is replaced, so the rest of the line survives.
const AUTH_PARAM = String.raw`[\w.-]+\s*=\s*(?:\\?"(?:[^"\\\r\n]|\\(?!"))*\\?"|[^\s,"\\]+)`;
const AUTHORIZATION_CREDENTIAL = new RegExp(
  String.raw`(authorization\s*:\s*)(?:[A-Za-z][\w.-]*\s+)?(?:${AUTH_PARAM}(?:\s*,\s*${AUTH_PARAM})*|[\w.~+/=-]+)`,
  'gi',
);
// A whole private key block, or one whose END line was cut off by an output cap
// (then everything after the header goes). The second branch keeps it linear.
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]{0,40}PRIVATE KEY-----|[\s\S]*$)/g;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
// A password in any URL (postgres://user:pass@host, redis://:pass@host).
const URL_PASSWORD = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)[^\s/@:]*:[^\s/@]+@/g;
const IMAGE_DATA_URL = /(data:image\/[A-Za-z0-9.+-]{1,32};base64,)[A-Za-z0-9+/=]+/g;

/**
 * Scrub credential-shaped values: token prefixes, netrc credentials, registry
 * and authorization headers. Every rule keys on a shape or a `key=`/`key:`
 * spelling, never on a bare word, so ordinary prose survives.
 * Never truncates — callers bound length themselves.
 */
export function scrubCredentialShapes(raw: string): string {
  return raw
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    // Opslane API and project keys. The greedy tail must span the endpoint
    // payload an sk carries after its secret, so the whole credential goes.
    .replace(/opslane_(?:ak|pk|sk)_[A-Za-z0-9_-]+/g, '[REDACTED]')
    // Non-GitHub forge tokens. OPSLANE_GITHUB_URL points self-hosted installs at
    // their own forge, and that token is written verbatim into the sandbox
    // .netrc, so it can appear in any command output this scrubs.
    .replace(/glpat-[A-Za-z0-9_-]+/g, '[REDACTED]')
    // E2B sandbox keys can surface in machine-provisioning errors that now
    // travel to the operator Slack channel.
    .replace(/\be2b_[A-Za-z0-9_-]+/g, '[REDACTED]')
    // The clone credential as git spells it in a URL or a netrc line.
    .replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@')
    // Registry auth an install script can echo on failure.
    .replace(/(_authToken\s*=\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, '$1[REDACTED]');
}

/**
 * Scrub credentials and API tokens from text before storage, logging, or
 * prompt injection. Never truncates — callers bound length themselves.
 *
 * Adds two broad rules to the credential shapes. `https://…@` reaches across
 * `/`, so it also eats a URL path holding an `@` (`/npm/@vue/…`), and the netrc
 * `password <value>` rule rewrites prose such as "Invalid password format".
 * Both are acceptable for command output and logs, not for error text a model
 * reads and searches for.
 */
export function scrubSecrets(raw: string): string {
  return scrubCredentialShapes(raw.replace(/https:\/\/[^@\s]+@/g, 'https://***@'))
    .replace(/(password\s+)\S+/gi, '$1[REDACTED]');
}

/**
 * Scrub text stored in agent run logs. On top of scrubSecrets it removes whole
 * private key blocks, AWS key ids, the credential after any Authorization
 * scheme, passwords in any URL, inline base64 images, and the values of
 * secret-named keys. Those rules would change code and output that a model or a
 * reviewer acts on (`const apiKey = process.env.API_KEY`), so they apply only to
 * stored diagnostics. Every rule scans in linear time.
 */
export function scrubRunLogText(raw: string): string {
  return scrubSecrets(redactNamedPairs(raw
    .replace(PRIVATE_KEY_BLOCK, '[REDACTED PRIVATE KEY]')
    .replace(AWS_ACCESS_KEY_ID, '[REDACTED]')
    .replace(AUTHORIZATION_CREDENTIAL, '$1[REDACTED]')
    .replace(URL_PASSWORD, '$1***@')
    .replace(IMAGE_DATA_URL, '$1[image]')));
}

const CLONE_DETAIL_LIMIT = 2_000;

/** Scrub clone credentials and bound detail before persistence or display. */
export function redactCloneDetail(detail: string): string {
  const scrubbed = scrubSecrets(detail)
    .replace(/x-access-token:[^@\s]{1,512}@/g, 'x-access-token:***@');
  return scrubbed.length > CLONE_DETAIL_LIMIT
    ? `${scrubbed.slice(0, CLONE_DETAIL_LIMIT)}… (truncated)`
    : scrubbed;
}

/** Recursively scrub a structured value for a run log, by key and by text. Returns a copy; never throws. */
export function scrubValue(value: unknown): unknown {
  // Only ancestors count as cycles: a shared (but acyclic) object must serialize normally.
  const ancestors = new Set<object>();
  const walk = (node: unknown): unknown => {
    try {
      if (typeof node === 'string') return scrubRunLogText(node);
      if (typeof node === 'bigint') return node.toString();
      if (typeof node === 'function' || typeof node === 'symbol') return undefined;
      if (node === null || typeof node !== 'object') return node;
      if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) return '[Binary omitted]';
      if (node instanceof Date) return new Date(Date.prototype.getTime.call(node));
      if (ancestors.has(node)) return '[Circular]';
      ancestors.add(node);
      try {
        if (Array.isArray(node)) return node.map(walk);
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(node)) {
          // A secret-named key hides its whole value, whatever its type.
          Object.defineProperty(out, key, {
            value: isSecretKey(key) && child !== null && child !== undefined ? '[REDACTED]' : walk(child),
            enumerable: true, configurable: true, writable: true,
          });
        }
        return out;
      } finally {
        ancestors.delete(node);
      }
    } catch {
      return '[Unserializable]';
    }
  };
  return walk(value);
}
