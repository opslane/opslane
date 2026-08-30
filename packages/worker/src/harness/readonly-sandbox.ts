import { CommandExitError, Sandbox } from 'e2b';
import { classifyFailure, isCommandFailure } from './machine-state.js';
import { MachineUnavailableError } from './errors.js';
import { logger } from '../logger.js';
import { buildReadOnlyNetwork } from './sandbox-network.js';
import { buildGitNetrc } from '../repo-clone.js';
import { redactCloneDetail } from './redact.js';
import { MAX_LIST_ENTRIES, type RepoReader } from '../investigate-tools.js';
import { TRAVERSAL_EXCLUSIONS } from './traversal-exclusions.js';

export { MachineUnavailableError } from './errors.js';

const SANDBOX_REPO = '/home/user/repo';
/** One byte past the host's 50KB cap, so the caller can still detect truncation. */
const MAX_READ_BYTES = 51_201;
const READ_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5_000;
const SANDBOX_LIFETIME_MS = 900_000;
/** Exit code the in-machine guard uses for a path that escapes the checkout. */
const PATH_OUTSIDE_EXIT = 3;
/** Exit code the in-machine guard uses for a path that does not resolve at all. */
const PATH_MISSING_EXIT = 4;

/**
 * The slice of the E2B `Sandbox` surface the reader uses.
 *
 * Narrow on purpose: the reader must be constructible from a stub in tests
 * without standing up a machine, and a narrow surface documents exactly what
 * a read costs.
 */
export interface MinimalSandbox {
  sandboxId: string;
  isRunning(opts?: { requestTimeoutMs?: number }): Promise<boolean>;
  commands: { run(cmd: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string }> };
  kill(): Promise<unknown>;
}

/** Single-quote one argument. Every string here is chosen by the model. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Resolve inside the machine and refuse anything outside the checkout. */
function guardedPath(root: string, path: string): string {
  return `p=$(realpath -e -- ${q(path)} 2>/dev/null) || exit ${PATH_MISSING_EXIT}; ` +
    `case "$p" in ${q(root)}/*|${q(root)}) ;; *) exit ${PATH_OUTSIDE_EXIT};; esac; `;
}

/**
 * `find` expression that skips the directories the host reader also skipped.
 * `-prune` drops them from the output as well as the descent, which is what the
 * host's `isExcludedTraversalDirectory` did.
 */
function pruneExpression(): string {
  const names = TRAVERSAL_EXCLUSIONS.map((entry) => `-name ${q(entry)}`).join(' -o ');
  return `\\( ${names} \\) -prune -o`;
}

export function createSandboxReader(sbx: MinimalSandbox, root: string): RepoReader {
  const run = async (cmd: string, okExitCodes: number[] = []): Promise<string> => {
    try {
      return (await sbx.commands.run(cmd, { timeoutMs: READ_TIMEOUT_MS })).stdout;
    } catch (err: unknown) {
      if (err instanceof CommandExitError) {
        if (okExitCodes.includes(err.exitCode)) return err.stdout;
        if (err.exitCode === PATH_OUTSIDE_EXIT) throw new Error('path escapes the repository');
        if (err.exitCode === PATH_MISSING_EXIT) throw new Error('No such file or directory');
        throw err;
      }
      // `alive` is unreachable here: classifyFailure only returns it for a
      // CommandExitError, which the branch above already consumed. Collapsing it
      // into `unknown` keeps the claim honest rather than asserting the
      // impossible case away.
      const classified = await classifyFailure(err, () => sbx.isRunning({ requestTimeoutMs: PROBE_TIMEOUT_MS }));
      const state = classified === 'gone' ? 'gone' : 'unknown';
      throw new MachineUnavailableError(
        state === 'gone' ? 'The work machine is no longer running.' : 'The work machine state could not be determined.',
        state,
      );
    }
  };

  return {
    // `head -c` rather than `cat`, so a multi-gigabyte or special file cannot
    // exhaust the command output or the deadline.
    readFile: (path) => run(`cd ${q(root)} && ${guardedPath(root, path)} head -c ${MAX_READ_BYTES} -- "$p"`),

    // grep exits 1 for "no matches", which is not a failure.
    grep: (args) => run(`cd ${q(root)} && grep ${args.map(q).join(' ')}`, [1]),

    // One command for the whole batch: grounding a submission can ask about a
    // dozen citations, and a round trip each would cost more than the read that
    // produced them.
    exists: async (paths) => {
      if (paths.length === 0) return [];
      const loop = paths.map(q).join(' ');
      const stdout = await run(
        `cd ${q(root)} && for p in ${loop}; do ` +
        `r=$(realpath -e -- "$p" 2>/dev/null) || continue; ` +
        `case "$r" in ${q(root)}/*|${q(root)}) ;; *) continue;; esac; ` +
        `[ -f "$r" ] || continue; printf '%s\\n' "$p"; done`,
      );
      const found = new Set(stdout.split('\n').filter(Boolean));
      return paths.filter((path) => found.has(path));
    },

    // Must present the same shape the host reader produced: one entry per line,
    // directories marked with a trailing slash, prefixed by the requested path,
    // vendored directories skipped, bounded at MAX_LIST_ENTRIES.
    //
    // The machine emits `type<TAB>relative-path` and the prefixing, marking and
    // truncation happen here, because building them into the shell pipeline
    // would mean interpolating a model-chosen path into a `sed` script.
    list: async (path, recursive) => {
      const stdout = await run(
        `cd ${q(root)} && ${guardedPath(root, path)} cd "$p" && ` +
        `find . -mindepth 1 -maxdepth ${recursive ? 2 : 1} ${pruneExpression()} ` +
        `-printf '%y\\t%P\\n' | LC_ALL=C sort -k2`,
      );
      const prefix = path === '.' ? '' : `${path.replace(/\/+$/, '')}/`;
      const results: string[] = [];
      for (const line of stdout.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        if (results.length >= MAX_LIST_ENTRIES) {
          results.push(`... [truncated at ${MAX_LIST_ENTRIES} entries]`);
          break;
        }
        results.push(`${prefix}${line.slice(tab + 1)}${line.slice(0, tab) === 'd' ? '/' : ''}`);
      }
      if (results.length === 0) return 'Empty directory.';
      return results.join('\n');
    },
  };
}

export interface ReadOnlyCheckout {
  reader: RepoReader;
  sandboxId: string;
  createdAt: number;
  /** Commit actually checked out, for `recordInvestigatedCommit`. */
  headSha: string;
  /** Repository default branch, for `cacheProjectDefaultBranch`. */
  defaultBranch: string;
  /**
   * `git ls-files` output, bounded. Friction puts a repository tree in its
   * system prompt and used to shell out to git on the host to get it.
   *
   * A named field rather than a general "run this command" escape: an escape
   * hatch would let any future caller reach back into the machine with an
   * arbitrary string and recreate exactly the hole this module closes. If a
   * fourth thing needs raw output, add a fourth named field.
   */
  tree: string;
  close(): Promise<void>;
}

/** Bounds `git ls-files` output; friction truncates further for its prompt. */
const MAX_TREE_BYTES = 65_536;

export interface ReadOnlyCheckoutOpts {
  /**
   * Clone URL **without** an embedded credential. A token in the URL survives
   * in `.git/config` inside the machine, which would defeat the netrc removal
   * below; pass `githubToken` instead and the credential is written, used, and
   * deleted before the model gets a turn.
   */
  repoUrl: string;
  commitSha?: string | undefined;
  githubToken?: string | undefined;
  anthropicApiKey: string;
}

/** Run one git query inside the machine and return its trimmed stdout. */
async function readGitFact(
  sbx: { commands: { run(cmd: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string }> } },
  command: string,
  fallback = '',
): Promise<string> {
  try {
    const { stdout } = await sbx.commands.run(`cd ${q(SANDBOX_REPO)} && ${command}`, { timeoutMs: 30_000 });
    return stdout.trim();
  } catch {
    return fallback;
  }
}

/**
 * Translate a setup failure into the shape the caller can already classify.
 *
 * `cloneFailureReason` and `isRetriableCloneFailure` read `err.message`, but a
 * `CommandExitError` puts git's diagnosis in `stderr` and leaves the message as
 * a bare exit status. Without this every sandbox clone failure would look
 * identical: never retriable, always `repo_access_denied`.
 *
 * A transport failure is not a clone failure at all, so it becomes a
 * `MachineUnavailableError` and reaches the durable retry lane instead of a
 * customer-facing terminal.
 */
async function asSetupFailure(sbx: MinimalSandbox, err: unknown): Promise<unknown> {
  if (err instanceof CommandExitError) {
    const detail = [err.message, err.stderr, err.stdout].filter(Boolean).join('\n');
    return new Error(redactCloneDetail(detail));
  }
  const classified = await classifyFailure(err, () => sbx.isRunning({ requestTimeoutMs: PROBE_TIMEOUT_MS }));
  if (classified === 'alive') return err;
  return new MachineUnavailableError(
    classified === 'gone' ? 'The work machine is no longer running.' : 'The work machine state could not be determined.',
    classified,
  );
}

/**
 * Rent a machine, clone into it, and hand back a reader.
 *
 * The credential is written for the clone and removed in a finally, so it is
 * gone before the model can ask for anything. On any setup failure the machine
 * is destroyed and the error propagates; a half-built checkout is never returned.
 */
export async function createReadOnlyCheckout(opts: ReadOnlyCheckoutOpts): Promise<ReadOnlyCheckout> {
  const createdAt = Date.now();
  const sbx = await Sandbox.create({
    timeoutMs: SANDBOX_LIFETIME_MS,
    network: buildReadOnlyNetwork(opts.anthropicApiKey),
  });
  try {
    const netrc = opts.githubToken ? buildGitNetrc(opts.repoUrl, opts.githubToken) : null;
    try {
      if (netrc) {
        await sbx.files.write('/home/user/.netrc', netrc);
        await sbx.commands.run('chmod 600 /home/user/.netrc', { timeoutMs: 10_000 });
      }
      try {
        await sbx.commands.run(
          `git clone --depth 1 -- ${q(opts.repoUrl)} ${q(SANDBOX_REPO)}`,
          { timeoutMs: CLONE_TIMEOUT_MS },
        );
      } catch (err: unknown) {
        throw await asSetupFailure(sbx, err);
      }
      if (opts.commitSha) {
        // Best effort: an error group can name a commit that has since been
        // force-pushed away. Falling back to the cloned head matches the host
        // clone's existing behaviour rather than failing the job.
        try {
          await sbx.commands.run(
            `cd ${q(SANDBOX_REPO)} && git fetch --depth 1 origin ${q(opts.commitSha)} && git checkout ${q(opts.commitSha)}`,
            { timeoutMs: CLONE_TIMEOUT_MS },
          );
        } catch (err: unknown) {
          // Only a genuine missing ref is a fallback. An auth failure, a DNS
          // failure or a GitHub outage is also a CommandExitError, and silently
          // investigating the wrong commit is worse than failing.
          const detail = `${err instanceof CommandExitError ? err.stderr : ''}`;
          const missingRef = /couldn't find remote ref|not a valid object name|no such remote ref/i.test(detail);
          if (!isCommandFailure(err) || !missingRef) throw await asSetupFailure(sbx, err);
          logger.warn('requested commit unavailable; using cloned head', {
            requested_commit: opts.commitSha, sandbox_id: sbx.sandboxId,
          });
        }
      }
    } finally {
      // The credential must be gone before the model can ask for anything. If
      // removal cannot be proven, destroy the machine rather than hand back a
      // checkout that still contains it.
      if (netrc) {
        try {
          await sbx.commands.run('rm -f /home/user/.netrc && test ! -e /home/user/.netrc', { timeoutMs: 10_000 });
        } catch {
          await sbx.kill().catch(() => undefined);
          throw new Error('Could not remove the clone credential from the sandbox; machine destroyed.');
        }
      }
    }

    // Read after the credential is gone: none of these need it, and the host
    // clone produced the same three facts that callers still depend on.
    const [headSha, defaultBranch, tree] = await Promise.all([
      readGitFact(sbx, 'git rev-parse HEAD'),
      // A plain clone checks out remote HEAD, so the checked-out branch IS the
      // repository default. `symbolic-ref refs/remotes/origin/HEAD` is not set
      // by every shallow clone, which is why the local branch name is used.
      readGitFact(sbx, 'git rev-parse --abbrev-ref HEAD'),
      readGitFact(sbx, `git ls-files | head -c ${MAX_TREE_BYTES}`, ''),
    ]);
    if (!headSha) throw new Error('Could not resolve the checked-out commit inside the sandbox');

    return {
      reader: createSandboxReader(sbx, SANDBOX_REPO),
      sandboxId: sbx.sandboxId,
      createdAt,
      headSha,
      defaultBranch,
      tree,
      // close must never throw: it runs in a finally and would otherwise
      // replace the job's real result with a teardown error.
      close: async () => { await sbx.kill().catch(() => undefined); },
    };
  } catch (err: unknown) {
    // Log before killing: this is exactly the identity both August incidents
    // lost, because the old code discarded the machine before anything could
    // record it.
    logger.error('read-only checkout setup failed', {
      'sandbox.id': sbx.sandboxId,
      'sandbox.age_at_error_ms': Date.now() - createdAt,
      'error.message': err instanceof Error ? err.message : String(err),
    });
    await sbx.kill().catch(() => undefined);
    throw err;
  }
}
