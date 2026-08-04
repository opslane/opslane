import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { NeedsHumanReason } from '@opslane/shared';
import { redactCloneDetail } from './harness/redact.js';
import { DEFAULT_REMEDIATION } from './reason-codes.js';

const execFile = promisify(execFileCb);

export interface CloneOptions {
  githubRepo: string;   // "owner/repo"
  jobId: string;
  timeoutMs?: number;
  githubToken?: string;
  /** Test/local transport override. Production callers use buildRepoUrl. */
  repoUrl?: string;
}

export interface CloneResult {
  repoDir: string;
  /** Resolved from the clone itself; authoritative for this job. */
  defaultBranch: string;
  cleanup: () => Promise<void>;
}

/** Result of a git invocation that is allowed to fail without throwing. */
export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitRunner = (args: string[]) => Promise<GitResult>;

export type CloneResolutionKind =
  | 'empty_repository'
  | 'invalid_default_branch'
  | 'unresolvable_head';

export class CloneResolutionError extends Error {
  readonly kind: CloneResolutionKind;
  readonly repo: string;
  readonly discoveredBranch?: string;

  constructor(kind: CloneResolutionKind, repo: string, discoveredBranch?: string) {
    super(CloneResolutionError.describe(kind, repo, discoveredBranch));
    this.name = 'CloneResolutionError';
    this.kind = kind;
    this.repo = repo;
    this.discoveredBranch = discoveredBranch;
  }

  private static describe(
    kind: CloneResolutionKind,
    repo: string,
    branch?: string,
  ): string {
    switch (kind) {
      case 'empty_repository':
        return `${repo} has no commits yet, so there is no branch to work from`;
      case 'invalid_default_branch':
        return `default branch '${branch}' does not exist in ${repo}`;
      case 'unresolvable_head':
        return `could not determine the default branch of ${repo}`;
    }
  }
}

/** A GitRunner backed by execFile against an already-cloned working directory. */
export function execFileGitRunner(repoDir: string): GitRunner {
  return async (args) => {
    try {
      const { stdout, stderr } = await execFile('git', args, {
        cwd: repoDir,
        timeout: 15_000,
        env: scrubbedEnv(),
      });
      return {
        stdout: String(stdout),
        stderr: String(stderr),
        exitCode: 0,
      };
    } catch (err: unknown) {
      const detail = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: String(detail.stdout ?? ''),
        stderr: String(detail.stderr ?? ''),
        exitCode: typeof detail.code === 'number' ? detail.code : 1,
      };
    }
  };
}

/**
 * Resolve the branch checked out by a plain clone.
 *
 * ls-remote must run first: both an empty repository and a repository whose
 * HEAD points at a missing ref fail rev-parse, while only the empty repository
 * has no remote heads.
 */
export async function resolveClonedBranch(
  run: GitRunner,
  repo: string,
): Promise<string> {
  const heads = await run(['ls-remote', '--heads', 'origin']);
  if (heads.exitCode !== 0) {
    throw new Error(
      `could not inspect remote branches for ${repo}: ${redactCloneDetail(heads.stderr)}`,
    );
  }
  if (heads.stdout.trim() === '') {
    throw new CloneResolutionError('empty_repository', repo);
  }

  const symbolic = await run(['symbolic-ref', '--short', 'HEAD']);
  if (symbolic.exitCode !== 0 || symbolic.stdout.trim() === '') {
    throw new CloneResolutionError('unresolvable_head', repo);
  }
  const branch = symbolic.stdout.trim();

  const head = await run(['rev-parse', '--verify', 'HEAD']);
  if (head.exitCode !== 0) {
    throw new CloneResolutionError('invalid_default_branch', repo, branch);
  }
  return branch;
}

/** Turn clone failures into actionable terminal reasons. */
export function cloneFailureReason(err: unknown): NeedsHumanReason {
  if (err instanceof CloneResolutionError) {
    return {
      reason_code: err.kind,
      reason_message: err.message,
      remediation: DEFAULT_REMEDIATION[err.kind],
    };
  }
  const raw = err instanceof Error ? err.message : String(err);
  const reasonCode = raw.includes('GITHUB_TOKEN')
    ? 'missing_github_token'
    : 'repo_access_denied';
  return {
    reason_code: reasonCode,
    reason_message: redactCloneDetail(raw),
    remediation: DEFAULT_REMEDIATION[reasonCode],
  };
}

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

/**
 * Clone a repo using token-in-URL. execFile doesn't use a shell,
 * so the token is only visible in /proc/PID/environ (same process),
 * not in /proc/PID/cmdline or shell history.
 */
export async function cloneRepo(options: CloneOptions): Promise<CloneResult> {
  const { githubRepo, jobId, timeoutMs = 30_000 } = options;
  const token = options.githubToken ?? process.env['GITHUB_TOKEN'];
  if (!token && !options.repoUrl) {
    throw new Error('GITHUB_TOKEN is not set');
  }

  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(githubRepo)) {
    throw new Error('Refusing to clone: unsafe repository name');
  }

  const repoDir = `/tmp/opslane-repo-${jobId}`;
  const cloneUrl = options.repoUrl ?? buildRepoUrl(githubRepo, token);

  try {
    // A plain clone checks out remote HEAD, the repository's current default.
    await execFile('git', [
      'clone', '--depth', '1',
      '--', cloneUrl, repoDir,
    ], { timeout: timeoutMs, env: scrubbedEnv() });
  } catch (err: unknown) {
    const detail = err as { message?: string; stderr?: string };
    throw new Error(redactCloneDetail([
      detail.message ?? String(err),
      detail.stderr,
    ].filter(Boolean).join('\n')));
  }

  let defaultBranch: string;
  try {
    defaultBranch = await resolveClonedBranch(
      execFileGitRunner(repoDir),
      githubRepo,
    );
  } catch (err: unknown) {
    // Resolution failures happen after clone, before the caller receives its
    // cleanup handle. Remove the token-bearing checkout before propagating.
    await execFile('rm', ['-rf', repoDir]).catch(() => {});
    throw err;
  }
  return {
    repoDir,
    defaultBranch,
    cleanup: async () => {
      await execFile('rm', ['-rf', repoDir]).catch(() => {});
    },
  };
}

/**
 * Create branch, re-apply diff, commit, and push.
 * Called after verification passes (which rolls back the diff).
 */
export async function gitCommitAndPush(
  repoDir: string,
  branchName: string,
  commitMessage: string,
  diff: string,
): Promise<string> {
  const opts = {
    cwd: repoDir,
    timeout: 30_000,
    env: {
      ...scrubbedEnv(),
      GIT_AUTHOR_NAME: 'Opslane Bot',
      GIT_AUTHOR_EMAIL: 'opslane-bot@opslane.com',
      GIT_COMMITTER_NAME: 'Opslane Bot',
      GIT_COMMITTER_EMAIL: 'opslane-bot@opslane.com',
    },
  };
  // Re-apply the diff (verify.ts rolls it back after testing)
  await gitApplyStdin(repoDir, diff, 30_000);
  await execFile('git', ['checkout', '-b', branchName], opts);
  await execFile('git', ['add', '-A'], opts);
  await execFile('git', ['commit', '-m', commitMessage], opts);
  await execFile('git', ['push', 'origin', branchName], opts);
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], opts);
  return stdout.trim();
}

/** Apply a diff via stdin to git apply. */
function gitApplyStdin(cwd: string, diff: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFileCb('git', ['apply', '-'], { cwd, timeout: timeoutMs, env: scrubbedEnv() }, (error) => {
      if (error) {
        reject(new Error(`git apply failed: ${error.message}`));
        return;
      }
      resolve();
    });
    if (child.stdin) {
      child.stdin.write(diff);
      child.stdin.end();
    }
  });
}

/**
 * Validate that all diff paths are safe -- no path traversal, within repo.
 */
export function validateDiffPaths(diff: string): { valid: boolean; error?: string } {
  const pathRegex = /^(?:---|\+\+\+) [ab]\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(diff)) !== null) {
    const filePath = match[1];
    if (filePath.includes('..') || filePath.startsWith('/') || filePath.includes('\0')) {
      return { valid: false, error: `Unsafe diff path: ${filePath}` };
    }
  }
  return { valid: true };
}

/**
 * Build a scrubbed env for running customer test scripts.
 * Removes secrets so they can't leak via malicious package.json scripts.
 */
export function scrubbedEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'MINIO_SECRET_KEY', 'REPLAY_STORE_SECRET_KEY', 'ENCRYPTION_KEY', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_CLIENT_SECRET', 'OPSLANE_SOURCEMAP_KEY']) {
    delete env[key];
  }
  return env;
}
