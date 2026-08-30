import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { NeedsHumanReason } from '@opslane/shared';
import { redactCloneDetail } from './harness/redact.js';
import { DEFAULT_REMEDIATION } from './reason-codes.js';
import { buildGitNetrc, buildRepoUrl } from './repo-url.js';

const execFile = promisify(execFileCb);

export interface CloneOptions {
  githubRepo: string;   // "owner/repo"
  jobId: string;
  timeoutMs?: number;
  githubToken?: string;
  /** Test/local transport override. Production callers use buildRepoUrl. */
  repoUrl?: string;
  /** Preferred observation commit. Falls back to default HEAD when unreachable. */
  commitSha?: string | null;
}

export interface CloneResult {
  repoDir: string;
  /** Resolved from the clone itself; authoritative for this job. */
  defaultBranch: string;
  /** Commit checked out by the clone and investigated by this job. */
  headSha: string;
  cleanup: () => Promise<void>;
}

/** Result of a git invocation that is allowed to fail without throwing. */
export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitRunner = (args: string[]) => Promise<GitResult>;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

/** Check out a requested commit only when the remote can prove it reachable.
 * Any fetch/checkout failure leaves the clone on its authoritative default
 * HEAD, whose sha is returned and persisted by the caller. */
export async function checkoutReachableCommit(
  run: GitRunner,
  requestedCommit: string | null | undefined,
  defaultHeadSha: string,
): Promise<string> {
  if (!requestedCommit || !COMMIT_SHA_PATTERN.test(requestedCommit)) return defaultHeadSha;
  if (requestedCommit.toLowerCase() === defaultHeadSha.toLowerCase()) return defaultHeadSha;

  const fetched = await run(['fetch', '--depth', '1', 'origin', requestedCommit]);
  if (fetched.exitCode !== 0) return defaultHeadSha;
  const checkedOut = await run(['checkout', '--detach', 'FETCH_HEAD']);
  if (checkedOut.exitCode !== 0) {
    await run(['checkout', '--detach', defaultHeadSha]);
    return defaultHeadSha;
  }
  const head = await run(['rev-parse', '--verify', 'HEAD']);
  if (head.exitCode !== 0 || !COMMIT_SHA_PATTERN.test(head.stdout.trim())) {
    await run(['checkout', '--detach', defaultHeadSha]);
    return defaultHeadSha;
  }
  return head.stdout.trim();
}

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
): Promise<{ branch: string; headSha: string }> {
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
  return { branch, headSha: head.stdout.trim() };
}

/** Failure signatures that a retry of the durable job can plausibly fix:
 * network faults, remote hiccups, and leftover-path collisions. Everything
 * else (missing token, denied access, repository state) is deterministic and
 * deserves the actionable terminal reason instead of a wasted retry. */
const RETRIABLE_CLONE_PATTERN = new RegExp(
  [
    'could not resolve host',
    'connection (timed out|reset|refused)',
    'operation timed out',
    'timed?out',
    'early EOF',
    'RPC failed',
    'remote end hung up',
    'destination path .* already exists',
    'HTTP (429|500|502|503|504)',
    'ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN',
  ].join('|'),
  'i',
);

/** True when a clone failure looks transient: the caller should fail the
 * durable job (which retries and dead-letters into the operator's view)
 * instead of writing a customer-facing terminal for a network blip. */
export function isRetriableCloneFailure(err: unknown): boolean {
  if (err instanceof CloneResolutionError) return false;
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('GITHUB_TOKEN')) return false;
  return RETRIABLE_CLONE_PATTERN.test(raw);
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

/** Abandoned checkouts older than this are certainly not in use: no job phase
 * legitimately runs this long, and a shorter window could sweep a live clone
 * out from under a long fix run. */
const ABANDONED_CLONE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Remove clone directories orphaned by a crashed worker. Age-gated, never
 * keyed by job ID: a reclaimed job's original worker may still be alive inside
 * its checkout, so only directories old enough that no legitimate run can
 * still own them are removed. Run at worker startup; a normally-completing run
 * removes its own directory through the cleanup handle.
 */
export async function sweepAbandonedClones(
  maxAgeMs = ABANDONED_CLONE_MAX_AGE_MS,
  root = tmpdir(),
): Promise<number> {
  let swept = 0;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.startsWith('opslane-repo-')) continue;
    const path = join(root, entry);
    try {
      const info = await stat(path);
      if (!info.isDirectory() || info.mtimeMs > cutoff) continue;
      await rm(path, { recursive: true, force: true });
      swept += 1;
    } catch {
      // Another process may have removed it between readdir and rm.
    }
  }
  return swept;
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

  // Attempt-unique, not job-keyed: after a lease lapses, the old worker can
  // still be alive inside its checkout, so a fixed job-ID path would either
  // collide ("destination path exists" poisoned every reclaimed retry) or
  // invite a pre-clone rm -rf that deletes a directory a zombie worker is
  // still using. Abandoned directories are removed by the age-gated sweep.
  const repoDir = await mkdtemp(join(tmpdir(), `opslane-repo-${jobId}-`));
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

  let resolved: { branch: string; headSha: string };
  try {
    resolved = await resolveClonedBranch(
      execFileGitRunner(repoDir),
      githubRepo,
    );
    resolved.headSha = await checkoutReachableCommit(
      execFileGitRunner(repoDir),
      options.commitSha,
      resolved.headSha,
    );
  } catch (err: unknown) {
    // Resolution failures happen after clone, before the caller receives its
    // cleanup handle. Remove the token-bearing checkout before propagating.
    await execFile('rm', ['-rf', repoDir]).catch(() => {});
    throw err;
  }
  return {
    repoDir,
    defaultBranch: resolved.branch,
    headSha: resolved.headSha,
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
