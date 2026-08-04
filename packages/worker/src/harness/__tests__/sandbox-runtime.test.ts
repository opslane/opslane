import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createE2BSandbox } = vi.hoisted(() => ({
  createE2BSandbox: vi.fn(),
}));

vi.mock('e2b', async (importOriginal) => ({
  ...(await importOriginal<typeof import('e2b')>()),
  Sandbox: { create: createE2BSandbox },
}));

import { createSandboxRuntime, SandboxUnavailableError } from '../sandbox-runtime.js';

const ENV_KEYS = [
  'OPSLANE_SANDBOX_BACKEND',
  'OPSLANE_RELIABILITY_HARNESS',
  'SANDBOX_LIFETIME_MS',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'DATABASE_URL',
  'MINIO_SECRET_KEY',
  'E2B_API_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
] as const;

/** Worker secrets that must never reach a sandbox command environment. */
const SECRET_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'DATABASE_URL',
  'MINIO_SECRET_KEY',
  'E2B_API_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe('createSandboxRuntime', () => {
  it('uses E2B by default', async () => {
    delete process.env['OPSLANE_SANDBOX_BACKEND'];
    createE2BSandbox.mockResolvedValue({
      sandboxId: 'sbx-default',
      commands: { run: vi.fn() },
      files: { read: vi.fn(), write: vi.fn() },
      kill: vi.fn(),
    });

    const runtime = await createSandboxRuntime();
    expect(runtime.id).toBe('sbx-default');
    expect(createE2BSandbox).toHaveBeenCalledOnce();
  });

  it('exports SandboxNotFoundError from the installed E2B version', async () => {
    const e2b = await vi.importActual<typeof import('e2b')>('e2b');
    expect(typeof e2b.SandboxNotFoundError).toBe('function');
  });

  it('latches unavailable and throws SandboxUnavailableError when E2B reports the sandbox is gone', async () => {
    delete process.env['OPSLANE_SANDBOX_BACKEND'];
    const { SandboxNotFoundError } = await vi.importActual<typeof import('e2b')>('e2b');
    const dead = new SandboxNotFoundError('Sandbox is probably not running anymore');
    createE2BSandbox.mockResolvedValue({
      sandboxId: 'sbx-test-1',
      commands: { run: vi.fn().mockRejectedValue(dead) },
      files: { read: vi.fn().mockRejectedValue(dead), write: vi.fn() },
      kill: vi.fn(),
    });

    const runtime = await createSandboxRuntime();
    expect(runtime.id).toBe('sbx-test-1');
    expect(runtime.unavailable).toBe(false);

    await expect(runtime.commands.run('echo hi')).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(runtime.unavailable).toBe(true);
  });

  it('does not latch unavailable for an ordinary command failure', async () => {
    delete process.env['OPSLANE_SANDBOX_BACKEND'];
    createE2BSandbox.mockResolvedValue({
      sandboxId: 'sbx-test-2',
      commands: { run: vi.fn().mockRejectedValue(new Error('Command exited with code 1')) },
      files: { read: vi.fn(), write: vi.fn() },
      kill: vi.fn(),
    });

    const runtime = await createSandboxRuntime();
    await expect(runtime.commands.run('false')).rejects.toThrow('Command exited with code 1');
    expect(runtime.unavailable).toBe(false);
  });

  it('provisions the JavaScript sandbox with an explicit lifetime, not the SDK default', async () => {
    delete process.env['OPSLANE_SANDBOX_BACKEND'];
    delete process.env['SANDBOX_LIFETIME_MS'];
    createE2BSandbox.mockResolvedValue({
      sandboxId: 'sbx-life', commands: { run: vi.fn() },
      files: { read: vi.fn(), write: vi.fn() }, kill: vi.fn(),
    });

    const runtime = await createSandboxRuntime('javascript');
    expect(runtime.lifetimeMs).toBe(1_800_000);
    expect(createE2BSandbox).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1_800_000 }));
  });

  it('clamps a lifetime below the floor back to the default', async () => {
    delete process.env['OPSLANE_SANDBOX_BACKEND'];
    process.env['SANDBOX_LIFETIME_MS'] = '60000';
    createE2BSandbox.mockResolvedValue({
      sandboxId: 'sbx-low', commands: { run: vi.fn() },
      files: { read: vi.fn(), write: vi.fn() }, kill: vi.fn(),
    });

    const runtime = await createSandboxRuntime('javascript');
    expect(runtime.lifetimeMs).toBe(1_800_000);
  });

  it('honours a lifetime at or above the floor', async () => {
    delete process.env['OPSLANE_SANDBOX_BACKEND'];
    process.env['SANDBOX_LIFETIME_MS'] = '900000';
    createE2BSandbox.mockResolvedValue({
      sandboxId: 'sbx-ok', commands: { run: vi.fn() },
      files: { read: vi.fn(), write: vi.fn() }, kill: vi.fn(),
    });

    const runtime = await createSandboxRuntime('javascript');
    expect(runtime.lifetimeMs).toBe(900_000);
    // Assert the provisioning argument, not just the metadata: the two could
    // disagree and the sandbox would still be created with the wrong ceiling.
    expect(createE2BSandbox).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 900_000 }));
  });

  it('clamps a lifetime above the account ceiling', async () => {
    delete process.env['OPSLANE_SANDBOX_BACKEND'];
    process.env['SANDBOX_LIFETIME_MS'] = '999999999';
    createE2BSandbox.mockResolvedValue({
      sandboxId: 'sbx-high', commands: { run: vi.fn() },
      files: { read: vi.fn(), write: vi.fn() }, kill: vi.fn(),
    });

    const runtime = await createSandboxRuntime('javascript');
    expect(runtime.lifetimeMs).toBe(1_800_000);
  });

  it('provisions the Python sandbox with its template AND the resolved lifetime', async () => {
    // The Python path moved off a hardcoded PYTHON_SANDBOX_LIFETIME_MS onto the
    // shared resolver. Without this, a regression there is invisible: every
    // other lifetime test drives the JavaScript branch.
    delete process.env['OPSLANE_SANDBOX_BACKEND'];
    process.env['SANDBOX_LIFETIME_MS'] = '900000';
    createE2BSandbox.mockResolvedValue({
      sandboxId: 'sbx-py', commands: { run: vi.fn() },
      files: { read: vi.fn(), write: vi.fn() }, kill: vi.fn(),
    });

    const runtime = await createSandboxRuntime('python');
    expect(runtime.lifetimeMs).toBe(900_000);
    expect(createE2BSandbox).toHaveBeenCalledWith(
      'opslane-python',
      expect.objectContaining({ timeoutMs: 900_000 }),
    );
  });

  it('raises SandboxUnavailableError from the local backend after kill', async () => {
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    process.env['OPSLANE_RELIABILITY_HARNESS'] = '1';
    const sandbox = await createSandboxRuntime();
    await sandbox.kill();
    await expect(sandbox.commands.run('echo hi')).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(sandbox.unavailable).toBe(true);
  });

  it('maps virtual paths and commands into a disposable local filesystem', async () => {
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    process.env['OPSLANE_RELIABILITY_HARNESS'] = '1';
    const sandbox = await createSandboxRuntime();

    await sandbox.files.write('/home/user/repo/input.txt', 'hello\n');
    const result = await sandbox.commands.run(
      'cd /home/user/repo && tr a-z A-Z < input.txt > output.txt && pwd',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/opslane-local-sandbox-.+\/home\/user\/repo/);
    await expect(sandbox.files.read('/home/user/repo/output.txt')).resolves.toBe('HELLO\n');

    await sandbox.kill();
    await expect(sandbox.files.read('/home/user/repo/output.txt')).rejects.toThrow('killed');
  });

  it('isolates temporary files and removes worker secrets from command environments', async () => {
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    process.env['OPSLANE_RELIABILITY_HARNESS'] = '1';
    for (const key of SECRET_ENV_KEYS) process.env[key] = `secret-${key}`;
    const sandbox = await createSandboxRuntime();

    await sandbox.files.write('/tmp/provider.patch', 'fixture');
    const tmpResult = await sandbox.commands.run('cat /tmp/provider.patch');
    expect(tmpResult.stdout).toBe('fixture');

    const envResult = await sandbox.commands.run(
      `node -e 'console.log(["ANTHROPIC_API_KEY","GITHUB_TOKEN","DATABASE_URL","MINIO_SECRET_KEY","E2B_API_KEY","LANGFUSE_PUBLIC_KEY","LANGFUSE_SECRET_KEY"].map(k => process.env[k] || "").join("|"))'`,
    );
    expect(envResult.stdout.trim()).toBe('||||||');

    await sandbox.kill();
  });

  it('preserves host file URLs when virtual temporary paths are rewritten', async () => {
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    process.env['OPSLANE_RELIABILITY_HARNESS'] = '1';
    const hostTmp = await mkdtemp('/tmp/opslane-host-fixture-');
    const fixturePath = join(hostTmp, 'fixture.txt');
    await writeFile(fixturePath, 'host fixture\n', 'utf8');
    const fixtureUrl = pathToFileURL(fixturePath).href;
    const sandbox = await createSandboxRuntime();

    try {
      const result = await sandbox.commands.run(
        `node -e 'const { readFileSync } = require("node:fs"); process.stdout.write(readFileSync(new URL(process.argv[1]), "utf8"))' '${fixtureUrl}'`,
      );

      expect(result.stdout).toBe('host fixture\n');
    } finally {
      await sandbox.kill();
      await rm(hostTmp, { recursive: true, force: true });
    }
  });

  it('rejects non-zero exits and timeouts like the remote command transport', async () => {
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    process.env['OPSLANE_RELIABILITY_HARNESS'] = '1';
    const sandbox = await createSandboxRuntime();

    await expect(sandbox.commands.run('echo failed >&2; exit 7')).rejects.toMatchObject({
      exitCode: 7,
      stderr: 'failed\n',
    });
    await expect(sandbox.commands.run('sleep 1', { timeoutMs: 10 })).rejects.toThrow(/timed out/i);

    await sandbox.kill();
  });

  it('rejects unknown backends instead of silently falling back', async () => {
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'elsewhere';
    await expect(createSandboxRuntime()).rejects.toThrow(
      'Unsupported OPSLANE_SANDBOX_BACKEND: elsewhere',
    );
    expect(createE2BSandbox).not.toHaveBeenCalled();
  });

  it('requires an explicit harness guard before running commands on the host', async () => {
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    delete process.env['OPSLANE_RELIABILITY_HARNESS'];
    await expect(createSandboxRuntime()).rejects.toThrow(
      'Local sandbox backend requires OPSLANE_RELIABILITY_HARNESS=1',
    );
  });
});
