import { CommandExitError, TimeoutError } from 'e2b';
import { createSandboxRuntime, type SandboxRuntime } from './sandbox-runtime.js';
import { classifyFailure, isCommandFailure } from './machine-state.js';
import { MachineUnavailableError, VerificationInfraError } from './errors.js';
import { logger } from '../logger.js';
import { buildReadOnlyNetwork } from './sandbox-network.js';
import type { EvidenceRecord } from '@opslane/shared';
import { buildGitNetrc } from '../repo-url.js';
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
/** Exit code the in-machine guard uses for a path that escapes the checkout. */
const PATH_OUTSIDE_EXIT = 3;
/** Exit code the in-machine guard uses for a path that does not resolve at all. */
const PATH_MISSING_EXIT = 4;
/**
 * Cap on one read's stdout, matching the 512KB `maxBuffer` the host reader gave
 * `execFile`. Without it a `grep -r` over a large checkout, or a directory with a
 * wide fanout, materialises its whole result set in the worker process that also
 * runs sandbox and PR work — the truncation in `investigate-tools.ts` only
 * applies after the bytes have already crossed the wire.
 */
const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024;
/**
 * Paths probed per `exists` command, and in total.
 *
 * The citation list is chosen by the model and the tool schema cannot bound it
 * (the Anthropic API rejects array bounds in custom tool schemas), so one
 * submission could interpolate thousands of paths into a single shell command.
 * That overruns the command-length limit and fails as a *transport* error, which
 * `run` reads as machine death and the caller retries as infrastructure — a
 * model-chosen input laundered into the durable retry lane.
 */
const EXISTS_BATCH = 100;
const MAX_EXISTS_PATHS = 1_000;
/**
 * The shape ingestion already enforces, re-checked here.
 *
 * `q()` stops shell injection but not *git argument* injection: git parses
 * options interspersed with positionals, so a value starting with `-` is
 * consumed as a flag by `git fetch`, and this runs while the clone credential is
 * still in the machine. The host path this replaced validated the same way
 * before using the value; containment should not depend on a regex in another
 * package and another language.
 */
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * The slice of the machine surface the reader uses.
 *
 * Narrow on purpose: the reader must be constructible from a stub in tests
 * without standing up a machine, and a narrow surface documents exactly what
 * a read costs. Both a raw E2B `Sandbox` (which `scripts/verify-isolation.ts`
 * hands it) and a `SandboxRuntime` satisfy it, which is why it names neither
 * `sandboxId` nor `id`: the reader needs neither.
 */
export interface MinimalSandbox {
  isRunning(opts?: { requestTimeoutMs?: number }): Promise<boolean>;
  commands: { run(cmd: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string }> };
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

/**
 * Run a command with its stdout capped, without losing its exit status.
 *
 * `cmd | head -c N` would report head's status, hiding both grep's "no matches"
 * 1 and any genuine error behind a 0. Spooling to a temp file, saving `$?`, and
 * re-raising it keeps the status exact and is portable to plain `sh`.
 *
 * `cd` is applied here rather than by the caller so the redirect happens after
 * it, keeping the whole thing one statement.
 */
function bounded(cmd: string, cdTo: string | null): string {
  const prefix = cdTo === null ? '' : `cd ${q(cdTo)} && `;
  return `${prefix}o=$(mktemp); { ${cmd}; } > "$o"; s=$?; ` +
    `head -c ${MAX_COMMAND_OUTPUT_BYTES} "$o"; rm -f "$o"; exit $s`;
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
      // A read that outran its own deadline is a bad tool call, not a dead
      // machine. `classifyFailure` calls it `unknown` — correct for a
      // verification suite, which should retry the whole job — but here it made
      // one slow model-chosen `grep` on a large checkout raise
      // MachineUnavailableError, kill the investigation, and send it round the
      // infra-retry lane, where the model would plausibly issue the same search
      // again. The host reader capped grep at 10s and handed the message back to
      // the model, which could then narrow the search. Keep that.
      if (err instanceof TimeoutError) {
        throw new Error(
          `The read did not finish within ${READ_TIMEOUT_MS / 1000}s. Narrow the search or the directory.`,
        );
      }
      // `alive` is unreachable below: classifyFailure only returns it for a
      // CommandExitError, which the branch above already consumed.
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

    // grep exits 1 for "no matches", which is not a failure — so the output cap
    // cannot be a `| head -c`: a pipeline reports the LAST command's status, which
    // would mask both that 1 and a genuine grep error as success. Spooling to a
    // file and re-raising the saved status keeps the exit code exact.
    grep: (args) => run(bounded(`grep ${args.map(q).join(' ')}`, root), [1]),

    // One command for the whole batch: grounding a submission can ask about a
    // dozen citations, and a round trip each would cost more than the read that
    // produced them.
    exists: async (paths) => {
      if (paths.length === 0) return [];
      if (paths.length > MAX_EXISTS_PATHS) {
        logger.warn('citation list exceeded the probe ceiling; the tail is reported as missing', {
          requested: paths.length, probed: MAX_EXISTS_PATHS,
        });
      }
      const probed = paths.slice(0, MAX_EXISTS_PATHS);
      const found = new Set<string>();
      for (let i = 0; i < probed.length; i += EXISTS_BATCH) {
        const loop = probed.slice(i, i + EXISTS_BATCH).map(q).join(' ');
        const stdout = await run(
          `cd ${q(root)} && for p in ${loop}; do ` +
          `r=$(realpath -e -- "$p" 2>/dev/null) || continue; ` +
          `case "$r" in ${q(root)}/*|${q(root)}) ;; *) continue;; esac; ` +
          `[ -f "$r" ] || continue; printf '%s\\n' "$p"; done`,
        );
        for (const line of stdout.split('\n')) if (line) found.add(line);
      }
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
        `cd ${q(root)} && ${guardedPath(root, path)} ` +
        bounded(
          `cd "$p" && find . -mindepth 1 -maxdepth ${recursive ? 2 : 1} ${pruneExpression()} ` +
          `-printf '%y\\t%P\\n' | LC_ALL=C sort -k2`,
          null,
        ),
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
 * As `readGitFact`, but a failure is the machine's, not an empty answer.
 *
 * The tolerant version turns a dead machine into a fallback string. For a fact
 * the caller cannot proceed without, that laundered a machine death into a
 * plain `Error`, which `processInvestigateJob` then read through
 * `cloneFailureReason` and reported to the customer as `repo_access_denied` —
 * their repository blamed for our infrastructure, terminally.
 */
async function readGitFactStrict(sbx: MinimalSandbox, command: string): Promise<string> {
  try {
    const { stdout } = await sbx.commands.run(`cd ${q(SANDBOX_REPO)} && ${command}`, { timeoutMs: 30_000 });
    return stdout.trim();
  } catch (err: unknown) {
    throw await asSetupFailure(sbx, err);
  }
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
  const requestedCommit = opts.commitSha && COMMIT_SHA_PATTERN.test(opts.commitSha) ? opts.commitSha : null;
  if (opts.commitSha && !requestedCommit) {
    logger.warn('ignoring a commit that is not a plain SHA; investigating the cloned head', {
      requested_commit: opts.commitSha.slice(0, 64),
    });
  }

  let sbx: SandboxRuntime;
  try {
    // Through the shared factory, not `Sandbox.create`. The factory is what
    // reads `OPSLANE_SANDBOX_BACKEND`, so calling the provider directly meant
    // the fix path honoured the deterministic reliability harness's local
    // backend and this path did not — every read-only job in that harness died
    // demanding an E2B key. The egress policy still travels with the request;
    // only the E2B backend can apply it.
    //
    // The machine lifetime now comes from the factory (`SANDBOX_LIFETIME_MS`,
    // default 1_800_000) rather than a 900_000 constant here. It is a ceiling,
    // not a reservation: `close` kills the machine and E2B bills actual uptime,
    // so the only cost is that a crashed worker leaks an orphan for longer.
    // Both machine-renting paths now answer to one setting.
    sbx = await createSandboxRuntime(
      'javascript',
      buildReadOnlyNetwork(opts.anthropicApiKey, opts.repoUrl),
    );
  } catch (err: unknown) {
    // No machine exists yet, so there is nothing to probe or kill. It still has
    // to be typed as infrastructure: a provider rate limit, quota or auth
    // failure otherwise reaches `cloneFailureReason`, which has only git
    // vocabulary and terminalizes the incident as `repo_access_denied`. Hitting
    // the concurrent-sandbox cap would tell every customer their repository is
    // inaccessible.
    throw new MachineUnavailableError(
      `Could not start a work machine: ${redactCloneDetail(err instanceof Error ? err.message : String(err))}`,
      'unknown',
    );
  }
  let clonedBranch = '';
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
      // Read the branch HERE, before any checkout. `git checkout <sha>` detaches
      // HEAD, and `git rev-parse --abbrev-ref HEAD` then prints the literal
      // string "HEAD" — which this handed to `cacheProjectDefaultBranch`, so
      // every investigation carrying a commit SHA overwrote the project's real
      // default branch with "HEAD". A plain clone has not detached yet, so the
      // checked-out branch here genuinely is the repository default.
      clonedBranch = await readGitFact(sbx, 'git rev-parse --abbrev-ref HEAD');
      if (requestedCommit) {
        // Best effort: an error group can name a commit that has since been
        // force-pushed away. Falling back to the cloned head matches the host
        // clone's existing behaviour rather than failing the job.
        try {
          await sbx.commands.run(
            `cd ${q(SANDBOX_REPO)} && git fetch --depth 1 origin ${q(requestedCommit)} && git checkout ${q(requestedCommit)}`,
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
            requested_commit: requestedCommit, sandbox_id: sbx.id,
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
    const [headSha, tree] = await Promise.all([
      // Strict: the run cannot proceed without it, so a failed read is the
      // machine's fault and must stay typed as such.
      readGitFactStrict(sbx, 'git rev-parse HEAD'),
      readGitFact(sbx, `git ls-files | head -c ${MAX_TREE_BYTES}`, ''),
    ]);
    if (!headSha) throw new Error('Could not resolve the checked-out commit inside the sandbox');

    return {
      reader: createSandboxReader(sbx, SANDBOX_REPO),
      sandboxId: sbx.id,
      createdAt,
      headSha,
      // Empty rather than a guess when the read failed or HEAD was already
      // detached. The caller must not cache a branch we cannot name.
      defaultBranch: clonedBranch === 'HEAD' ? '' : clonedBranch,
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
      'sandbox.id': sbx.id,
      'sandbox.age_at_error_ms': Date.now() - createdAt,
      'error.message': err instanceof Error ? err.message : String(err),
    });
    await sbx.kill().catch(() => undefined);
    throw err;
  }
}

/**
 * The evidence field `VerificationInfraError` requires when the failing job
 * type has none. A read-only job never runs verification checks, so there is
 * nothing truthful to put here, and the retry lane does not read it. Stated
 * once rather than invented per call site.
 */
export const NO_VERIFICATION_EVIDENCE: EvidenceRecord = { version: 1, tier: null, checks: [] };

/**
 * Route a dead-machine failure into the retry lane that already exists, and
 * record the machine identity that both August incidents lacked.
 *
 * Anything else is returned untouched: laundering a programming defect into an
 * infrastructure error would retry it three times and then blame the provider.
 */
export function toInfraError(
  err: unknown,
  checkout: { sandboxId: string; createdAt: number },
  evidence: EvidenceRecord,
): unknown {
  if (!(err instanceof MachineUnavailableError)) return err;
  logger.error('read-only machine unavailable', {
    'sandbox.id': checkout.sandboxId,
    'sandbox.age_at_error_ms': Date.now() - checkout.createdAt,
    'machine.state': err.state,
  });
  return new VerificationInfraError(err.message, evidence);
}
