import type { CheckOutcome } from '@opslane/shared';
import { logger } from '../logger.js';
import {
  buildGitNetrc,
  CloneResolutionError,
  resolveClonedBranch,
  type GitRunner,
} from '../repo-clone.js';
import { redactCloneDetail, scrubSecrets } from './redact.js';
import { createSandboxRuntime, SandboxUnavailableError, type SandboxRuntime } from './sandbox-runtime.js';
import type { Platform } from '../platform.js';
import { sanitizeRuntimeValue, type RuntimeInfo } from '../runtime-info.js';
import { TRAVERSAL_EXCLUSIONS } from './traversal-exclusions.js';

const SANDBOX_REPO = '/home/user/repo';

interface PackageJsonLike {
  scripts?: Record<string, string>;
}

/** Pick the build/typecheck command. tsconfigExists enables the tsc fallback. */
export function selectBuildCommand(
  pkg: PackageJsonLike,
  tsconfigExists: boolean,
  pm: 'npm' | 'pnpm' | 'yarn' = 'npm',
): string | null {
  if (pkg.scripts?.['build']) {
    return pm === 'npm' ? 'npm run build' : `${pm} run build`;
  }
  if (tsconfigExists) return 'npx tsc --noEmit';
  return null;
}

export function parseAffectedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      const file = line.slice(6);
      if (file !== '/dev/null') files.add(file);
    }
  }
  return [...files];
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pick one install command for a Python repo, covering the managers real
 * projects use. Returns null when no dependency manifest exists at all.
 */
async function selectPythonInstall(
  sandbox: SandboxRuntime,
  pyproject: string,
): Promise<string | null> {
  if (await fileExists(sandbox, `${SANDBOX_REPO}/requirements.txt`)) {
    return 'python -m pip install -r requirements.txt --no-cache-dir';
  }
  if (/^\s*\[project\]\s*$/m.test(pyproject)) {
    return 'python -m pip install -e . --no-cache-dir';
  }
  // Poetry and setuptools-style pyproject files declare no [project] table but
  // are still pip-installable via their build backend.
  if (/^\s*\[tool\.(?:poetry|setuptools)\]/m.test(pyproject) || /^\s*\[build-system\]\s*$/m.test(pyproject)) {
    return 'python -m pip install -e . --no-cache-dir';
  }
  if (await fileExists(sandbox, `${SANDBOX_REPO}/setup.py`)) {
    return 'python -m pip install -e . --no-cache-dir';
  }
  if (await fileExists(sandbox, `${SANDBOX_REPO}/Pipfile`)) {
    return 'python -m pip install pipenv --no-cache-dir && python -m pipenv install --deploy --system';
  }
  return null;
}

export interface RepoSandbox {
  sandbox: SandboxRuntime;
  installOutcome: 'installed' | 'not_applicable' | 'failed';
  sandboxRuntime: RuntimeInfo | null;
}

const SANDBOX_NODE_VERSION = '22.17.0';

/**
 * The default E2B image ships Node 20.9, which predates crypto.hash() and
 * breaks modern Vite plugins (they require >= 20.12). Install a user-space
 * Node when the sandbox's Node is too old; later command shells pick it up
 * through ~/.profile and ~/.bashrc.
 */
async function ensureModernNode(sandbox: SandboxRuntime): Promise<void> {
  try {
    await sandbox.commands.run(
      `node -e "if (typeof require('crypto').hash !== 'function') process.exit(1)"`,
    );
    return;
  } catch {
    // Node is missing or too old — install below.
  }
  const url = `https://nodejs.org/dist/v${SANDBOX_NODE_VERSION}/node-v${SANDBOX_NODE_VERSION}-linux-x64.tar.xz`;
  await sandbox.commands.run(
    `curl -fsSL ${url} -o /tmp/node.tar.xz` +
      ' && mkdir -p ~/.opslane-node && tar -xJf /tmp/node.tar.xz -C ~/.opslane-node --strip-components=1' +
      ` && echo 'export PATH="$HOME/.opslane-node/bin:$PATH"' >> ~/.profile` +
      ` && echo 'export PATH="$HOME/.opslane-node/bin:$PATH"' >> ~/.bashrc`,
    { timeoutMs: 180_000 },
  );
}

/**
 * Create an E2B sandbox, clone the repo via .netrc auth, install deps, and
 * commit a baseline so a later diff captures only the agent's work.
 */
export async function createRepoSandbox(opts: {
  repoUrl: string;
  githubRepo?: string;
  githubToken?: string;
  /** Commands applied after the baseline commit and committed separately. */
  setupCommands?: string[];
  platform?: Platform;
  customerRuntime?: RuntimeInfo | null;
}): Promise<RepoSandbox> {
  const sandbox = await createSandboxRuntime(opts.platform);
  try {
    await sandbox.commands.run('git config --global user.email "opslane-agent@opslane.com" && git config --global user.name "Opslane Agent"');

    const token = opts.githubToken ?? process.env['GITHUB_TOKEN'] ?? '';
    const gitNetrc = token ? buildGitNetrc(opts.repoUrl, token) : null;
    if (gitNetrc) {
      await sandbox.files.write('/home/user/.netrc', gitNetrc);
      await sandbox.commands.run('chmod 600 /home/user/.netrc');
    }

    const runner: GitRunner = async (args) => {
      try {
        const result = await sandbox.commands.run(
          `git -C ${SANDBOX_REPO} ${args.map(shellEscape).join(' ')}`,
          { timeoutMs: 30_000 },
        );
        return {
          stdout: String(result.stdout ?? ''),
          stderr: String(result.stderr ?? ''),
          exitCode: 0,
        };
      } catch (err: unknown) {
        // A dead sandbox is not "git exited 1". Synthesizing a failed git result
        // here erases the class before the catch below can preserve it: the
        // failure resurfaces as CloneResolutionError and terminalizes as a
        // customer-facing clone failure with no infra retry.
        if (err instanceof SandboxUnavailableError) throw err;
        const detail = err as { message?: string; stdout?: string; stderr?: string };
        return {
          stdout: String(detail.stdout ?? ''),
          stderr: String(detail.stderr ?? detail.message ?? err),
          exitCode: 1,
        };
      }
    };

    try {
      await sandbox.commands.run(
        `git clone --depth 1 ${shellEscape(opts.repoUrl)} ${SANDBOX_REPO}`,
        { timeoutMs: 120_000 },
      );
      // ls-remote needs the private-repo credential, so resolve before .netrc
      // is removed. This result validates the sandbox only; the host clone is
      // the PR-base authority.
      await resolveClonedBranch(runner, opts.githubRepo ?? 'repo');
    } catch (err: unknown) {
      // Preserve both typed classes. Wrapping a dead sandbox in `clone failed:`
      // erases the class, and agent-fix.ts matches that string and RETURNS a
      // needs_human clone failure — so it never reaches the outer catch that
      // raises VerificationInfraError. The customer would see "we couldn't
      // clone your repo" for a provider outage, with no infra retry.
      if (err instanceof CloneResolutionError || err instanceof SandboxUnavailableError) throw err;
      const detail = err as { message?: string; stderr?: string };
      const message = [
        detail.message ?? String(err),
        detail.stderr,
      ].filter(Boolean).join('\n');
      throw new Error(`clone failed: ${redactCloneDetail(message)}`);
    } finally {
      if (gitNetrc) {
        await sandbox.commands.run('rm -f /home/user/.netrc').catch(() => {});
      }
    }

    const platform = opts.platform ?? 'javascript';
    const hasPackageJson = await fileExists(sandbox, `${SANDBOX_REPO}/package.json`);
    if (hasPackageJson) await ensureModernNode(sandbox);

    await sandbox.commands.run(
      platform === 'python'
        ? `cd ${SANDBOX_REPO} && printf "\\nnode_modules\\n.cache\\ncoverage\\n__pycache__/\\n*.pyc\\n.pytest_cache/\\n.coverage\\nhtmlcov/\\n*.egg-info/\\nbuild/\\ndist/\\n" >> .git/info/exclude`
        : `cd ${SANDBOX_REPO} && printf "\\nnode_modules\\n.cache\\ncoverage\\n" >> .gitignore`,
      { timeoutMs: 10_000 },
    );

    const installCommands: string[] = [];
    let pythonManifestFound = false;
    if (platform === 'python') {
      const pyproject = await sandbox.files.read(`${SANDBOX_REPO}/pyproject.toml`).catch(() => '');
      const pythonInstall = await selectPythonInstall(sandbox, pyproject);
      pythonManifestFound = pythonInstall !== null;
      if (pythonInstall) installCommands.push(pythonInstall);
    }
    if (hasPackageJson) {
      installCommands.push('if [ -f pnpm-lock.yaml ]; then pnpm install; elif [ -f yarn.lock ]; then yarn install; else npm install; fi');
    }

    // A Python repo with no recognised manifest is an install FAILURE, not a
    // no-op: pytest would run against an uninstalled tree and the resulting
    // import errors would be reported as ordinary test failures, hiding the
    // real cause from the incident.
    let installOutcome: RepoSandbox['installOutcome'] =
      platform === 'python' && !pythonManifestFound ? 'failed'
        : installCommands.length > 0 ? 'installed'
          : 'not_applicable';
    if (platform === 'python' && !pythonManifestFound) {
      logger.warn('no recognised Python dependency manifest; dependencies unavailable', {
        looked_for: 'requirements.txt, pyproject.toml, setup.py, Pipfile',
      });
    }
    for (const command of installCommands) {
      try {
        await sandbox.commands.run(`cd ${SANDBOX_REPO} && ${command}`, { timeoutMs: 300_000 });
      } catch (err: unknown) {
        installOutcome = 'failed';
        logger.warn('setup install failed; continuing', { error: err instanceof Error ? err.message : String(err) });
        break;
      }
    }

    let sandboxRuntime: RuntimeInfo | null = null;
    if (platform === 'python') {
      try {
        const result = await sandbox.commands.run('python -c "import platform; print(platform.python_implementation(), platform.python_version())"');
        const [rawName, rawVersion] = result.stdout.trim().split(/\s+/, 2);
        // Repo setup code (setup.py, build backends) has already executed by
        // now, so this stdout is not trusted. Sanitize it the same way the
        // customer-supplied twin is before it reaches the PR body.
        const name = sanitizeRuntimeValue(rawName);
        const version = sanitizeRuntimeValue(rawVersion);
        if (name && version) sandboxRuntime = { name, version };
      } catch { /* runtime disclosure remains unknown */ }
    }

    await sandbox.commands.run(
      `cd ${SANDBOX_REPO} && git add -A && git commit -m "baseline: setup" --allow-empty`,
      { timeoutMs: 30_000 },
    );

    if (opts.setupCommands && opts.setupCommands.length > 0) {
      for (const command of opts.setupCommands) {
        await sandbox.commands.run(`cd ${SANDBOX_REPO} && ${command}`, { timeoutMs: 60_000 });
      }
      await sandbox.commands.run(
        `cd ${SANDBOX_REPO} && git add -A && git commit -m "eval: setup" --allow-empty`,
        { timeoutMs: 30_000 },
      );
    }

    return { sandbox, installOutcome, sandboxRuntime };
  } catch (err: unknown) {
    await sandbox.kill().catch(() => {});
    throw err;
  }
}

/** Extract the agent's change as a unified diff. */
export async function extractDiff(
  sandbox: SandboxRuntime,
  platform: Platform = 'javascript',
): Promise<{ diff: string; affectedFiles: string[] }> {
  await sandbox.commands.run(`cd ${SANDBOX_REPO} && git add -A`, { timeoutMs: 30_000 });
  if (platform === 'python') {
    await sandbox.commands.run(
      // Deliberately excludes build/ and dist/: those are legitimate package
      // names in some Python repos, and unstaging them would ship a patch that
      // differs from the one pytest just verified. Untracked build artifacts
      // are already kept out of `git add -A` by .git/info/exclude above.
      `cd ${SANDBOX_REPO} && git reset --quiet -- ':(glob)**/__pycache__/**'`
        + ` ':(glob)**/.pytest_cache/**' ':(glob)**/htmlcov/**' ':(glob)**/*.egg-info/**'`
        + ` ':(glob)**/*.pyc' ':(glob)**/.coverage'`,
      { timeoutMs: 30_000 },
    );
  }
  const res = await sandbox.commands.run(`cd ${SANDBOX_REPO} && git diff --cached`, { timeoutMs: 30_000 });
  const raw = (res.stdout ?? '').replace(/\r\n/g, '\n');
  const diff = raw.endsWith('\n') ? raw : raw + '\n';
  return { diff, affectedFiles: parseAffectedFiles(diff) };
}

export interface BuildGateResult {
  outcome: CheckOutcome;
  exitCode?: number;
  output: string;
}

interface BuildFailureLike {
  message?: string;
  exitCode?: number | null;
  stdout?: unknown;
  stderr?: unknown;
}

function buildFailureExitCode(error: unknown): number | undefined {
  const failure = error as BuildFailureLike;
  if (typeof failure.exitCode === 'number') return failure.exitCode;
  const match = String(failure.message ?? '').match(/exited with code (\d+)/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

/** Byte-compile every tracked Python file; a SyntaxError anywhere fails the gate. */
async function runPythonSyntaxGate(sandbox: SandboxRuntime): Promise<BuildGateResult> {
  const excludes = TRAVERSAL_EXCLUSIONS
    .map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const cmd = `python -m compileall -q -x '(^|/)(${excludes})(/|$)' .`;
  try {
    const res = await sandbox.commands.run(`cd ${SANDBOX_REPO} && ${cmd}`, { timeoutMs: 240_000 });
    const output = scrubSecrets(`${res.stdout ?? ''}${res.stderr ? `\n${res.stderr}` : ''}`).slice(-2000);
    return res.exitCode === 0
      ? { outcome: 'passed', exitCode: 0, output }
      : { outcome: 'failed', exitCode: res.exitCode, output };
  } catch (err: unknown) {
    if (err instanceof SandboxUnavailableError) {
      return { outcome: 'infra_error', output: scrubSecrets(err.message) };
    }
    const failure = err as BuildFailureLike;
    const rawMessage = err instanceof Error ? err.message : String(err);
    const detail = [failure.stderr, failure.stdout]
      .map((part) => String(part ?? '').trim())
      .filter(Boolean)
      .join('\n');
    const output = scrubSecrets(detail || rawMessage).slice(-2000);
    if (/timed out|timeout/i.test(rawMessage)) return { outcome: 'infra_error', output };
    const exitCode = buildFailureExitCode(err);
    return { outcome: 'failed', exitCode, output };
  }
}

/** Run the build/typecheck gate using the verification outcome taxonomy. */
export async function runBuildGate(
  sandbox: SandboxRuntime,
  platform: Platform = 'javascript',
): Promise<BuildGateResult> {
  // Python has no typechecker to lean on, and pytest only imports the modules
  // its tests reach. Byte-compiling every file is the equivalent syntax gate:
  // without it an agent can write a SyntaxError into an unimported module and
  // still be marked verified.
  if (platform === 'python') return runPythonSyntaxGate(sandbox);
  let pkg: PackageJsonLike = {};
  try {
    const raw = await sandbox.files.read(`${SANDBOX_REPO}/package.json`);
    pkg = JSON.parse(raw) as PackageJsonLike;
  } catch (err: unknown) {
    if (err instanceof SandboxUnavailableError) {
      return { outcome: 'infra_error', output: scrubSecrets(err.message) };
    }
    // no package.json
  }

  let tsconfigExists: boolean;
  let pm: 'npm' | 'pnpm' | 'yarn';
  try {
    tsconfigExists = await fileExists(sandbox, `${SANDBOX_REPO}/tsconfig.json`);
    pm = (await fileExists(sandbox, `${SANDBOX_REPO}/pnpm-lock.yaml`)) ? 'pnpm'
      : (await fileExists(sandbox, `${SANDBOX_REPO}/yarn.lock`)) ? 'yarn'
        : 'npm';
  } catch (err: unknown) {
    if (err instanceof SandboxUnavailableError) {
      return { outcome: 'infra_error', output: scrubSecrets(err.message) };
    }
    throw err;
  }

  const cmd = selectBuildCommand(pkg, tsconfigExists, pm);
  if (!cmd) return { outcome: 'skipped_no_runner', output: 'no build script or tsconfig' };

  try {
    const res = await sandbox.commands.run(`cd ${SANDBOX_REPO} && ${cmd}`, { timeoutMs: 240_000 });
    const output = scrubSecrets(`${res.stdout ?? ''}${res.stderr ? `\n${res.stderr}` : ''}`).slice(-2000);
    return res.exitCode === 0
      ? { outcome: 'passed', exitCode: 0, output }
      : { outcome: 'failed', exitCode: res.exitCode, output };
  } catch (err: unknown) {
    if (err instanceof SandboxUnavailableError) {
      return { outcome: 'infra_error', output: scrubSecrets(err.message) };
    }
    const failure = err as BuildFailureLike;
    const rawMessage = err instanceof Error ? err.message : String(err);
    const detail = [failure.stderr, failure.stdout]
      .map((part) => String(part ?? '').trim())
      .filter(Boolean)
      .join('\n');
    const output = scrubSecrets(detail || rawMessage).slice(-2000);
    if (/timed out|timeout/i.test(rawMessage)) {
      return { outcome: 'infra_error', output };
    }
    return { outcome: 'failed', exitCode: buildFailureExitCode(err), output };
  }
}

/**
 * Note the deliberate asymmetry: a vanished sandbox must not read as "file
 * absent", because runBuildGate would then report skipped_no_runner and
 * computeTier accepts that as a satisfied build gate. Other read failures
 * (permissions, transport) still return false — this narrows the hole, it does
 * not close it.
 */
async function fileExists(sandbox: SandboxRuntime, path: string): Promise<boolean> {
  try {
    await sandbox.files.read(path);
    return true;
  } catch (err: unknown) {
    if (err instanceof SandboxUnavailableError) throw err;
    return false;
  }
}
