/**
 * Scrub credentials and API tokens from text before storage, logging, or
 * prompt injection. Never truncates — callers bound length themselves.
 */
export function scrubSecrets(raw: string): string {
  return raw
    .replace(/https:\/\/[^@\s]+@/g, 'https://***@')
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
    // The clone credential as git spells it in a URL or a netrc line.
    .replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@')
    .replace(/(password\s+)\S+/gi, '$1[REDACTED]')
    // Registry auth an install script can echo on failure.
    .replace(/(_authToken\s*=\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, '$1[REDACTED]');
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
