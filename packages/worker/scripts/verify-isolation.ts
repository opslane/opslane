/**
 * Live verification of read-only sandbox isolation, against real E2B.
 *
 * The unit tests prove the code agrees with our reading of the library. This
 * proves the library behaves as read. It is a script rather than a CI test
 * because it rents real sandboxes and costs real money.
 *
 * It deliberately does NOT go through `createReadOnlyCheckout`, which exposes
 * no command runner and no kill: checks 4 and 5 need to plant a symlink and to
 * destroy the machine mid-run. It creates its own `Sandbox` with the same
 * network policy and wraps it with the same `createSandboxReader`.
 *
 *   E2B_API_KEY=... ANTHROPIC_API_KEY=... \
 *     pnpm --filter @opslane/worker exec tsx scripts/verify-isolation.ts
 *
 * Exits 0 only when all five checks print PASS.
 */
import { Sandbox } from 'e2b';
import { MachineUnavailableError } from '../src/harness/errors.js';
import { buildReadOnlyNetwork } from '../src/harness/sandbox-network.js';
import { createSandboxReader } from '../src/harness/readonly-sandbox.js';

const SANDBOX_REPO = '/home/user/repo';
/** Any small public repository; only its existence matters. */
const CLONE_URL = 'https://github.com/e2b-dev/e2b';
const SANDBOX_LIFETIME_MS = 600_000;

let failures = 0;

function report(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Run a command and return its parts whatever the exit code, so a check can assert on failure. */
async function attempt(
  sbx: Sandbox,
  command: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await sbx.commands.run(command, { timeoutMs });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? String(err) };
  }
}

async function main(): Promise<void> {
  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  if (!anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is required');
  if (!process.env['E2B_API_KEY']) throw new Error('E2B_API_KEY is required');

  const sbx = await Sandbox.create({
    timeoutMs: SANDBOX_LIFETIME_MS,
    network: buildReadOnlyNetwork(anthropicApiKey),
  });
  console.log(`sandbox ${sbx.sandboxId}\n`);

  let killed = false;
  try {
    // 1. The egress proxy attaches the key. Nothing inside supplies one.
    const models = await attempt(
      sbx,
      "curl -s -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/models",
    );
    report(
      'anthropic reachable with no key inside the machine',
      models.stdout.trim() === '200',
      `HTTP ${models.stdout.trim() || 'none'}${models.stderr ? ` ${models.stderr}` : ''}`,
    );

    // 2. ...and the key really is not in the machine.
    const env = await attempt(sbx, 'env | grep -i anthropic || true');
    report(
      'no ANTHROPIC variable in the sandbox environment',
      env.stdout.trim() === '',
      env.stdout.trim() || 'env is clean',
    );

    // 3. Everything outside the allowlist is denied.
    const blocked = await attempt(
      sbx,
      "curl -s -m 10 -o /dev/null -w '%{http_code}' https://example.com",
    );
    const blockedCode = blocked.stdout.trim();
    report(
      'a host outside the allowlist is blocked',
      !blocked.ok || blockedCode === '' || blockedCode === '000',
      blocked.ok ? `HTTP ${blockedCode || 'none'}` : 'request failed',
    );

    // 4. Containment is enforced in the machine, against a real symlink.
    await sbx.commands.run(`git clone --depth 1 -- ${CLONE_URL} ${SANDBOX_REPO}`, { timeoutMs: 180_000 });
    await sbx.commands.run(
      `mkdir -p ${SANDBOX_REPO}/src && ln -sf /etc/hostname ${SANDBOX_REPO}/src/evil.ts`,
      { timeoutMs: 30_000 },
    );
    const reader = createSandboxReader(sbx, SANDBOX_REPO);
    let symlinkRefusal = '';
    try {
      const leaked = await reader.readFile('src/evil.ts');
      symlinkRefusal = `read succeeded and returned ${JSON.stringify(leaked.slice(0, 60))}`;
    } catch (err: unknown) {
      symlinkRefusal = err instanceof Error ? err.message : String(err);
    }
    report(
      'a symlink out of the checkout is refused',
      symlinkRefusal.includes('path escapes the repository'),
      symlinkRefusal,
    );

    // 5. A machine that dies mid-run is reported as death, not as file content.
    await sbx.kill();
    killed = true;
    let deathState = '';
    try {
      await reader.readFile('README.md');
      deathState = 'read succeeded against a killed sandbox';
    } catch (err: unknown) {
      deathState = err instanceof MachineUnavailableError
        ? `MachineUnavailableError state=${err.state}`
        : `${(err as Error)?.name ?? 'unknown'}: ${(err as Error)?.message ?? String(err)}`;
    }
    report(
      'a killed machine raises MachineUnavailableError with state gone',
      deathState === 'MachineUnavailableError state=gone',
      deathState,
    );
  } finally {
    if (!killed) await sbx.kill().catch(() => undefined);
  }
}

main().then(
  () => {
    console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (err: unknown) => {
    console.error('verification could not run:', err instanceof Error ? err.stack : String(err));
    process.exit(1);
  },
);
