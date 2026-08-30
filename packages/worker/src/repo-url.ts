/**
 * How a repository is addressed, with no way to reach a repository.
 *
 * Split out of `repo-clone.ts` because that module imports `node:child_process`
 * and `node:fs/promises` at load. The isolated read-only jobs need to name a
 * repository, and importing the name-builder used to pull the whole host clone
 * implementation into their module graph — `readonly-isolation.test.ts` walks
 * the import graph and refuses that. Nothing here touches the filesystem, spawns
 * a process, or performs I/O.
 */

/** Strict `owner/repo` grammar — no traversal segments, no extra path parts. */
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Build the repository transport URL used by both host and sandbox clones. */
export function buildRepoUrl(githubRepo: string, token?: string): string {
  if (!GITHUB_REPO_PATTERN.test(githubRepo) || githubRepo.split('/').includes('..')) {
    throw new Error(`Invalid github_repo (expected owner/repo): ${githubRepo}`);
  }
  const configuredBaseUrl = process.env['OPSLANE_GITHUB_URL']?.trim();
  const baseUrl = new URL(configuredBaseUrl || 'https://github.com');
  if (token && (baseUrl.protocol === 'http:' || baseUrl.protocol === 'https:')) {
    baseUrl.username = 'x-access-token';
    baseUrl.password = token;
  }
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, '')}/${githubRepo}.git`;
  return baseUrl.toString();
}

/** Build credentials for a sandbox clone without exposing the token in argv. */
export function buildGitNetrc(repoUrl: string, token: string): string | null {
  const url = new URL(repoUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (/\s/.test(token)) {
    throw new Error('Invalid Git credential: token must not contain whitespace');
  }
  return [
    `machine ${url.hostname}`,
    'login x-access-token',
    `password ${token}`,
    '',
  ].join('\n');
}
