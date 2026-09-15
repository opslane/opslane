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
    // Opslane project keys. The greedy tail must span the endpoint payload an
    // sk carries after its secret, so the whole credential goes, not its head.
    .replace(/opslane_(?:pk|sk)_[A-Za-z0-9_-]+/g, '[REDACTED]')
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

const CLONE_DETAIL_LIMIT = 2_000;

/** Scrub clone credentials and bound detail before persistence or display. */
export function redactCloneDetail(detail: string): string {
  const scrubbed = scrubSecrets(detail)
    .replace(/x-access-token:[^@\s]{1,512}@/g, 'x-access-token:***@');
  return scrubbed.length > CLONE_DETAIL_LIMIT
    ? `${scrubbed.slice(0, CLONE_DETAIL_LIMIT)}… (truncated)`
    : scrubbed;
}
