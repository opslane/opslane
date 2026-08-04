# Sandbox Death Misclassification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a verification sandbox that dies mid-run classify as retryable infrastructure failure instead of a failed patch, and give it a lifetime long enough to finish the work.

**Known gap, accepted:** a sandbox that dies during `git clone` or branch
resolution still terminates as `clone_failed`. `GitRunner`'s catch converts the
error to `exitCode: 1`, the clone catch rewraps it as `Error("clone failed…")`,
and `runAgentFix`'s setup catch returns `cloneFailureReason` before reaching the
outer translation. Fixing that means threading the type through three rewrites;
it is out of scope here and is not one of the paths in opslane-oss#255.

**Architecture:** A thin adapter wraps the E2B SDK inside `sandbox-runtime.ts` (the only file importing a provider). On `SandboxNotFoundError` it both throws a typed `SandboxUnavailableError` **and** latches an `unavailable` flag on the runtime object. The throw serves every code path outside the agent loop; the flag is required because `agent-core/tool-loop.ts:202-212` deliberately erases exception types, so no exception can escape `runAgentLoop`. The worker checks the flag immediately after the agent loop returns and translates escaping errors in its outer catch.

**Tech Stack:** Node 22, TypeScript (strict, ESM), Vitest, E2B SDK v2.35, OpenTelemetry API.

## Global Constraints

- ESM and strict TypeScript. Use `unknown` plus narrowing, never `any`.
- Tests colocated in `__tests__` directories, Vitest only.
- Preserve terminal-status and lease contracts. Fix implementation or test setup, never weaken the contract.
- Only `packages/worker/src/harness/sandbox-runtime.ts` may import from `e2b`.
- Do **not** map E2B `TimeoutError` — its variants include ordinary per-command deadlines, and mapping it would convert agent command timeouts into whole-job retries.
- Do **not** modify `packages/agent-core/` — its type erasure is deliberate and documented.
- Do **not** modify the local sandbox backend to simulate mid-command death; structural fakes cover that.
- Every terminal `needs_human` result keeps a non-empty `reason_code`, `reason_message`, and `remediation`.
- Source plan: `docs/plans/2026-08-04-sandbox-death-misclassification.md` (revision 3).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/worker/src/harness/sandbox-runtime.ts` | Provider adapter, error type, lifetime config | Modify |
| `packages/worker/src/harness/sandbox-repo.ts` | `fileExists`, `runBuildGate` classification | Modify |
| `packages/worker/src/harness/test-runner.ts` | `runSuite` classification | Modify |
| `packages/worker/src/agent-fix.ts` | Flag check, outer-catch translation, evidence ordering | Modify |
| `packages/worker/src/harness/__tests__/sandbox-runtime.test.ts` | Adapter + lifetime tests | Modify |
| `packages/worker/src/harness/__tests__/test-runner.test.ts` | Suite classification tests, fake update | Modify |
| `packages/worker/src/harness/__tests__/sandbox-repo.test.ts` | Fake update | Modify |
| `packages/worker/src/harness/__tests__/sandbox-repo-setup.test.ts` | Fake update | Modify |
| `packages/worker/src/__tests__/agent-fix.test.ts` | Path A / B classification, e2b mock repair | Modify |
| `packages/worker/src/__tests__/index.test.ts` | Evidence assertion on terminalization | Modify |
| `docs/reference/environment-variables.md` | `SANDBOX_LIFETIME_MS` entry | Modify |

---

### Task 1: Typed error, runtime metadata, and the E2B adapter

**Files:**
- Modify: `packages/worker/src/harness/sandbox-runtime.ts`
- Test: `packages/worker/src/harness/__tests__/sandbox-runtime.test.ts`

**Interfaces:**
- Consumes: nothing (foundational task).
- Produces: `export class SandboxUnavailableError extends Error`; `SandboxRuntime` gains `readonly id: string`, `readonly createdAt: number`, `readonly lifetimeMs: number`, `readonly unavailable: boolean`. Every later task depends on these exact names.

- [ ] **Step 1: Repair the E2B mocks first — they will break on import**

Two test files mock `e2b` with a factory that exports **only** `Sandbox`:
`harness/__tests__/sandbox-runtime.test.ts:10` and `__tests__/agent-fix.test.ts:4`.
Once production imports `SandboxNotFoundError`, module loading fails in both. A
plain factory also means `instanceof SandboxNotFoundError` is false against the
real class, so the adapter would never trigger under test.

In **both** files, replace the factory with a partial mock that preserves the
real exports:

```ts
vi.mock('e2b', async (importOriginal) => ({
  ...(await importOriginal<typeof import('e2b')>()),
  Sandbox: { create: createE2BSandbox },
}));
```

In `agent-fix.test.ts` the local binding is `vi.fn()` inline; hoist it first so
the factory can reference it:

```ts
const { createE2BSandbox } = vi.hoisted(() => ({ createE2BSandbox: vi.fn() }));
vi.mock('e2b', async (importOriginal) => ({
  ...(await importOriginal<typeof import('e2b')>()),
  Sandbox: { create: createE2BSandbox },
}));
```

Every `createE2BSandbox.mockResolvedValue(...)` in `agent-fix.test.ts` must now
include **`sandboxId`**. This is a *provider* field read by the adapter — it is
not the same as the four wrapper fields (`id`, `createdAt`, `lifetimeMs`,
`unavailable`) added to structural `SandboxRuntime` fakes in Step 6. A fake that
has the wrapper fields but no `sandboxId` still yields `id: undefined`.

- [ ] **Step 2: Write the failing test**

Add to `packages/worker/src/harness/__tests__/sandbox-runtime.test.ts`, inside the existing `describe('createSandboxRuntime', ...)` block:

```ts
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

  it('raises SandboxUnavailableError from the local backend after kill', async () => {
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    process.env['OPSLANE_RELIABILITY_HARNESS'] = '1';
    const sandbox = await createSandboxRuntime();
    await sandbox.kill();
    await expect(sandbox.commands.run('echo hi')).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(sandbox.unavailable).toBe(true);
  });
```

Update the import at the top of that test file:

```ts
import { createSandboxRuntime, SandboxUnavailableError } from '../sandbox-runtime.js';
```

Also **update the existing identity assertion**. The current test at
`sandbox-runtime.test.ts:45-52` asserts `resolves.toBe(e2bRuntime)` — the exact
SDK object. The adapter returns a wrapper, so identity no longer holds. Replace it:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- sandbox-runtime`
Expected: FAIL — `SandboxUnavailableError` is not exported.

- [ ] **Step 4: Write minimal implementation**

In `packages/worker/src/harness/sandbox-runtime.ts`, change the import on line 6 and add the error class plus the interface fields:

```ts
import { Sandbox, SandboxNotFoundError } from 'e2b';
```

```ts
/**
 * The verification machine is gone — expired, evicted, or never existed.
 * Distinct from a command that ran and failed: no verdict about the patch is
 * possible once this is raised. Callers must classify it as infra_error.
 */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}
```

Extend the interface (keep the existing `commands`/`files`/`kill` members exactly as they are):

```ts
export interface SandboxRuntime {
  /** Provider's sandbox identifier, for correlating an incident to the machine. */
  readonly id: string;
  /** Epoch ms at creation. Required: id and lifetimeMs alone cannot yield age-at-error. */
  readonly createdAt: number;
  /** Wall-clock ceiling this sandbox was provisioned with. */
  readonly lifetimeMs: number;
  /**
   * Latched once the provider reports the machine is gone. Never resets.
   * Exists because agent-core/tool-loop.ts converts every tool exception into
   * model-visible text, so no exception can escape runAgentLoop. State can.
   */
  readonly unavailable: boolean;
  commands: {
    run(command: string, options?: { timeoutMs?: number }): Promise<SandboxCommandResult>;
  };
  files: {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<unknown>;
  };
  kill(): Promise<unknown>;
}
```

Add the adapter above `createSandboxRuntime`:

```ts
/** The E2B object shape this adapter needs. Avoids importing SDK types wholesale. */
interface E2BSandboxLike {
  sandboxId: string;
  commands: { run(command: string, options?: { timeoutMs?: number }): Promise<SandboxCommandResult> };
  files: { read(path: string): Promise<string>; write(path: string, data: string): Promise<unknown> };
  kill(): Promise<unknown>;
}

/**
 * Wrap the provider so a vanished sandbox becomes a typed, latched signal.
 * Only SandboxNotFoundError is mapped: E2B's TimeoutError also covers ordinary
 * per-command deadlines, and mapping it would turn an agent command timeout
 * into a whole-job retry.
 */
function adaptE2BSandbox(sbx: E2BSandboxLike, lifetimeMs: number, createdAt: number): SandboxRuntime {
  let unavailable = false;

  const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (err: unknown) {
      if (err instanceof SandboxNotFoundError) {
        unavailable = true;
        throw new SandboxUnavailableError(err.message);
      }
      throw err;
    }
  };

  return {
    id: sbx.sandboxId,
    createdAt,
    lifetimeMs,
    get unavailable() { return unavailable; },
    commands: {
      run: (command, options) => guard(() => sbx.commands.run(command, options)),
    },
    files: {
      read: (path) => guard(() => sbx.files.read(path)),
      write: (path, data) => guard(() => sbx.files.write(path, data)),
    },
    kill: () => sbx.kill(),
  };
}
```

**Wire the adapter in this task.** Leaving `createSandboxRuntime` returning the
raw SDK object would break the `SandboxRuntime` return type and make Task 1
un-typecheckable on its own. Replace the `backend === 'e2b'` branch now, keeping
the *existing* lifetime behaviour — Task 2 changes only where the number comes
from:

```ts
  if (backend === 'e2b') {
    // Captured BEFORE the await: creation takes real time, and age-at-error must
    // measure from when provisioning started, not when the promise resolved.
    const createdAt = Date.now();
    if (platform !== 'python') {
      // 300_000 is E2B's default. `Sandbox.defaultSandboxTimeoutMs` is
      // `protected static` in v2.35 and will not compile. Task 2 deletes this line.
      return adaptE2BSandbox(await Sandbox.create(), 300_000, createdAt);
    }
    const template = process.env['OPSLANE_E2B_PYTHON_TEMPLATE']?.trim() || DEFAULT_PYTHON_TEMPLATE;
    return adaptE2BSandbox(
      await Sandbox.create(template, { timeoutMs: PYTHON_SANDBOX_LIFETIME_MS }),
      PYTHON_SANDBOX_LIFETIME_MS,
      createdAt,
    );
  }
```

In `createLocalSandboxRuntime`, replace the body of `ensureRunning` and add the metadata fields to the returned object:

```ts
  const ensureRunning = (): void => {
    if (killed) throw new SandboxUnavailableError('Sandbox has been killed');
  };
```

Add `ensureRunning()` as the first statement of the local `run` implementation if it is not already there, and extend the returned object:

```ts
  const createdAt = Date.now();

  return {
    id: `local-${createdAt}`,
    createdAt,
    // 0 means "no provider-imposed ceiling" — it lives until killed. Do NOT use
    // Number.POSITIVE_INFINITY: OpenTelemetry attributes must be finite and JSON
    // logging serializes it as null.
    lifetimeMs: 0,
    get unavailable() { return killed; },
    // commands, files, and kill keep their existing implementations verbatim —
    // only the four metadata members above are added to the returned object.
    commands: { async run(command, options) { /* existing body, unchanged */ } },
    files: {
      async read(path) { /* existing body, unchanged */ },
      async write(path, data) { /* existing body, unchanged */ },
    },
    async kill() { /* existing body, unchanged */ },
  };
```

Do not retype the existing bodies — add the four metadata members to the object
literal that is already there and leave `commands`, `files`, and `kill` untouched.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- sandbox-runtime`
Expected: PASS (4 new tests).

- [ ] **Step 6: Fix the broken structural fakes**

`SandboxRuntime` now has required fields, so every structural fake fails to typecheck. In each of `test-runner.test.ts`, `sandbox-repo.test.ts`, `sandbox-repo-setup.test.ts`, **and any fake inside `__tests__/agent-fix.test.ts`**, add these four properties to the object literal returned by the local `fakeSandbox` (or equivalent) helper:

```ts
    id: 'fake-sandbox',
    createdAt: 0,
    lifetimeMs: 1_800_000,
    unavailable: false,
```

Run: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`
Expected: no type errors, full worker suite green.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/harness/sandbox-runtime.ts packages/worker/src/harness/__tests__/ packages/worker/src/__tests__/agent-fix.test.ts
git commit -m "feat(worker): latch and type sandbox unavailability at the provider boundary"
```

---

### Task 2: SANDBOX_LIFETIME_MS with a validated floor

**Files:**
- Modify: `packages/worker/src/harness/sandbox-runtime.ts:11-13,40-50`
- Modify: `docs/reference/environment-variables.md`
- Test: `packages/worker/src/harness/__tests__/sandbox-runtime.test.ts`

**Interfaces:**
- Consumes: `SandboxRuntime.lifetimeMs` from Task 1.
- Produces: `SANDBOX_LIFETIME_MS` env var; both platforms provisioned with the same ceiling.

- [ ] **Step 1: Write the failing test**

```ts
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
```

Add `'SANDBOX_LIFETIME_MS'` to the `ENV_KEYS` array at the top of the test file so it is saved and restored.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- sandbox-runtime`
Expected: FAIL — `runtime.lifetimeMs` is not 1800000; `createE2BSandbox` called with no arguments.

- [ ] **Step 3: Write minimal implementation**

Replace the `PYTHON_SANDBOX_LIFETIME_MS` constant (line 13) with:

```ts
/**
 * Measured worst-case run is ~606s (Langfuse agent-loop p100 x4 attempts plus
 * gates, opslane-oss#255). The floor guards against gross misconfiguration; it
 * is not a proof of sufficiency, because the phase timeout caps are not all
 * simultaneously reachable and their sum exceeds this. The default matches the
 * Python path, which already runs 1_800_000 in production and therefore proves
 * this account's tier accepts it.
 */
const SANDBOX_LIFETIME_FLOOR_MS = 900_000;
const SANDBOX_LIFETIME_DEFAULT_MS = 1_800_000;
/**
 * E2B enforces account-tier maximums and rejects creation above them. 1_800_000
 * is the only value proven acceptable on this account (the Python path has run
 * it in production). Anything higher is clamped rather than risking a creation
 * failure that would look like an unrelated outage.
 */
const SANDBOX_LIFETIME_CEILING_MS = 1_800_000;

function resolveSandboxLifetimeMs(): number {
  const raw = parseInt(process.env['SANDBOX_LIFETIME_MS'] ?? String(SANDBOX_LIFETIME_DEFAULT_MS), 10);
  if (!Number.isInteger(raw)) return SANDBOX_LIFETIME_DEFAULT_MS;
  if (raw < SANDBOX_LIFETIME_FLOOR_MS) return SANDBOX_LIFETIME_DEFAULT_MS;
  if (raw > SANDBOX_LIFETIME_CEILING_MS) return SANDBOX_LIFETIME_CEILING_MS;
  return raw;
}
```

Replace the body of the `backend === 'e2b'` branch:

```ts
  if (backend === 'e2b') {
    // The lifetime is a ceiling, not a reservation: agent-fix.ts kills the
    // sandbox in a finally and E2B bills actual uptime, so a job finishing in
    // 60s costs 60s regardless. The accepted cost is crash exposure — if the
    // worker process dies, finally never runs and the orphan leaks for up to
    // the ceiling rather than 5 minutes. The Python path already carries this.
    const lifetimeMs = resolveSandboxLifetimeMs();
    const createdAt = Date.now();
    if (platform !== 'python') {
      return adaptE2BSandbox(await Sandbox.create({ timeoutMs: lifetimeMs }), lifetimeMs, createdAt);
    }
    const template = process.env['OPSLANE_E2B_PYTHON_TEMPLATE']?.trim() || DEFAULT_PYTHON_TEMPLATE;
    return adaptE2BSandbox(await Sandbox.create(template, { timeoutMs: lifetimeMs }), lifetimeMs, createdAt);
  }
```

Delete the stale comment block on lines 43-46 that claims raising the JavaScript lifetime has "no benefit".

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- sandbox-runtime`
Expected: PASS.

- [ ] **Step 5: Document the variable**

Add a row to the table in `docs/reference/environment-variables.md`, matching the existing column format:

```
| `SANDBOX_LIFETIME_MS` | no (`1800000`) | Wall-clock ceiling for a verification sandbox. Values below `900000` fall back to the default; values above `1800000` are clamped to it (E2B enforces account-tier maximums). The ceiling is not billed unless consumed; raising it increases orphan exposure if the worker crashes. |
```

Run: `node scripts/check-docs-drift.mjs`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/harness/sandbox-runtime.ts packages/worker/src/harness/__tests__/sandbox-runtime.test.ts docs/reference/environment-variables.md
git commit -m "feat(worker): configurable sandbox lifetime with a validated floor"
```

---

### Task 3: Stop fileExists disguising a dead sandbox (path D)

**Files:**
- Modify: `packages/worker/src/harness/sandbox-repo.ts:378-385,363-375`
- Test: `packages/worker/src/harness/__tests__/sandbox-repo.test.ts`

**Interfaces:**
- Consumes: `SandboxUnavailableError` from Task 1.
- Produces: `runBuildGate` returns `outcome: 'infra_error'` for an unavailable sandbox.

- [ ] **Step 1: Write the failing test**

Add to `packages/worker/src/harness/__tests__/sandbox-repo.test.ts`:

```ts
import { SandboxUnavailableError } from '../sandbox-runtime.js';

describe('runBuildGate against an unavailable sandbox', () => {
  const deadSandbox: SandboxRuntime = {
    id: 'dead', createdAt: 0, lifetimeMs: 1_800_000, unavailable: true,
    commands: {
      run: async () => { throw new SandboxUnavailableError('Sandbox is probably not running anymore'); },
    },
    files: {
      read: async () => { throw new SandboxUnavailableError('Sandbox is probably not running anymore'); },
      write: async () => undefined,
    },
    kill: async () => undefined,
  };

  it('reports infra_error, never skipped_no_runner', async () => {
    const result = await runBuildGate(deadSandbox, 'javascript');
    // skipped_no_runner is the dangerous answer: computeTier accepts it as
    // buildOk, so a vanished machine would satisfy the build gate.
    expect(result.outcome).not.toBe('skipped_no_runner');
    expect(result.outcome).toBe('infra_error');
  });

  it('reports infra_error when the sandbox dies AFTER package.json is read', async () => {
    // Without this case the suite passes even if fileExists still swallows
    // sandbox death: the package.json read throws first and short-circuits.
    let reads = 0;
    const diesLater: SandboxRuntime = {
      ...deadSandbox,
      files: {
        read: async (path: string) => {
          reads++;
          if (path.endsWith('package.json')) return JSON.stringify({ scripts: {} });
          throw new SandboxUnavailableError('Sandbox is probably not running anymore');
        },
        write: async () => undefined,
      },
    };

    const result = await runBuildGate(diesLater, 'javascript');
    expect(reads).toBeGreaterThan(1);
    expect(result.outcome).toBe('infra_error');
  });

  it('reports infra_error for the python syntax gate too', async () => {
    const result = await runBuildGate(deadSandbox, 'python');
    expect(result.outcome).toBe('infra_error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- sandbox-repo`
Expected: FAIL — received `'skipped_no_runner'`.

- [ ] **Step 3: Write minimal implementation**

Import the error at the top of `sandbox-repo.ts`:

```ts
import { createSandboxRuntime, SandboxUnavailableError, type SandboxRuntime } from './sandbox-runtime.js';
```

Replace `fileExists` (lines 378-385):

```ts
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
```

In `runBuildGate`, the `package.json` read at lines 341-346 also swallows the error. Change its catch:

```ts
  try {
    const raw = await sandbox.files.read(`${SANDBOX_REPO}/package.json`);
    pkg = JSON.parse(raw) as PackageJsonLike;
  } catch (err: unknown) {
    if (err instanceof SandboxUnavailableError) {
      return { outcome: 'infra_error', output: scrubSecrets(err.message) };
    }
    // no package.json
  }
```

Wrap the remaining probe calls so a rethrown `SandboxUnavailableError` becomes `infra_error` rather than propagating out of the gate. Replace the `tsconfigExists`/`pm` block:

```ts
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
```

Add a typed branch to the existing catch at lines 363-375, **before** the `/timed out|timeout/i` test:

```ts
  } catch (err: unknown) {
    if (err instanceof SandboxUnavailableError) {
      return { outcome: 'infra_error', output: scrubSecrets(err.message) };
    }
    const failure = err as BuildFailureLike;
```

Apply the **identical** branch to `runPythonSyntaxGate`'s catch at lines 316-327.
`runBuildGate` delegates to it for `platform === 'python'` before any of the
JavaScript probes run, so fixing only the JavaScript path leaves Python
classifying a dead sandbox as `failed`:

```ts
  } catch (err: unknown) {
    if (err instanceof SandboxUnavailableError) {
      return { outcome: 'infra_error', output: scrubSecrets(err.message) };
    }
    const failure = err as BuildFailureLike;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- sandbox-repo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/harness/sandbox-repo.ts packages/worker/src/harness/__tests__/sandbox-repo.test.ts
git commit -m "fix(worker): a dead sandbox no longer reads as a repo with no build runner"
```

---

### Task 4: Classify sandbox death in the suite runner (path C)

**Files:**
- Modify: `packages/worker/src/harness/test-runner.ts:204,216-227`
- Test: `packages/worker/src/harness/__tests__/test-runner.test.ts`

**Interfaces:**
- Consumes: `SandboxUnavailableError` from Task 1.
- Produces: `runSuite` returns `outcome: 'infra_error'` for an unavailable sandbox, including from the pre-run cleanup.

- [ ] **Step 1: Write the failing test**

```ts
import { SandboxUnavailableError } from '../sandbox-runtime.js';

  it('classifies a vanished sandbox during the SUITE COMMAND as infra_error', async () => {
    // Cleanup succeeds; only the suite command hits the dead machine.
    const run = await runSuite(
      fakeSandbox({
        onRun: (command) => {
          if (command.startsWith('rm -f')) return { exitCode: 0 };
          throw new SandboxUnavailableError('Sandbox is probably not running anymore');
        },
      }),
      { kind: 'vitest', command: './node_modules/.bin/vitest run' },
    );
    expect(run.outcome).toBe('infra_error');
  });

  it('classifies a vanished sandbox during PRE-RUN CLEANUP as infra_error', async () => {
    // `rm -f <results path>` used to sit outside the try, so a dead sandbox
    // threw straight past every classifier and out of runSuite entirely.
    const run = await runSuite(
      fakeSandbox({
        onRun: (command) => {
          if (command.startsWith('rm -f')) {
            throw new SandboxUnavailableError('Sandbox is probably not running anymore');
          }
          return { exitCode: 0 };
        },
      }),
      { kind: 'vitest', command: './node_modules/.bin/vitest run' },
    );
    expect(run.outcome).toBe('infra_error');
  });

  it('treats an ordinary cleanup failure as infra_error, never a failed suite', async () => {
    // A failed `rm` must never read as the customer's tests failing, and must
    // not continue — a stale results file would be parsed as this run's result.
    const run = await runSuite(
      fakeSandbox({
        onRun: (command) => {
          if (command.startsWith('rm -f')) throw new Error('rm: permission denied');
          return { exitCode: 0, stdout: '{"testResults":[],"numTotalTests":0}' };
        },
      }),
      { kind: 'npm-script', command: 'npm test' },
    );
    expect(run.outcome).toBe('infra_error');
  });
```

The existing `fakeSandbox` helper only supports `throwMsg`. Extend its `onRun` return handling so a thrown error propagates — change the helper's `run` to call `opts.onRun` outside the `throwMsg` check and let real exceptions escape:

```ts
      run: async (command: string) => {
        const behavior = opts.onRun?.(command);   // may itself throw
        if (behavior?.throwMsg) {
```

(No change needed if `onRun` already throws directly — it does, because the callback is invoked synchronously inside `run`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- test-runner`
Expected: FAIL — the suite-command test receives `'failed'`; the cleanup test rejects with `SandboxUnavailableError` instead of returning a result.

- [ ] **Step 3: Write minimal implementation**

Import the error in `test-runner.ts`:

```ts
import { SandboxUnavailableError, type SandboxRuntime } from './sandbox-runtime.js';
```

Move the cleanup **inside** the try and add the typed branch. Replace lines 204-227:

```ts
  // Cleanup gets its OWN catch. Folding it into the suite try would let an
  // ordinary `rm` failure be reported as the customer's tests failing; leaving
  // it uncaught (the current code) lets a dead sandbox throw past every
  // classifier and surface as worker_runtime_error.
  try {
    await sandbox.commands.run(
      `rm -f ${plan.kind === 'pytest' ? PYTEST_RESULTS_PATH : SUITE_RESULTS_PATH}`,
      { timeoutMs: 10_000 },
    );
  } catch (error: unknown) {
    // EVERY cleanup failure is infrastructure, not a verdict. Continuing would
    // let the parser read a results file left by a previous run and report it
    // as this patch's outcome — a stale-evidence false positive.
    const detail = error instanceof Error ? error.message : String(error);
    return {
      outcome: 'infra_error',
      command: plan.command,
      tests: null,
      total: null,
      output: bound(scrubSecrets(detail)),
    };
  }

  let rawOutput = '';
  let exitCode = 0;
  try {
    const result = await sandbox.commands.run(
      `cd ${SANDBOX_REPO} && ${plan.command}`,
      { timeoutMs: SUITE_TIMEOUT_MS },
    );
    exitCode = result.exitCode;
    rawOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  } catch (error: unknown) {
    if (error instanceof SandboxUnavailableError) {
      return {
        outcome: 'infra_error',
        command: plan.command,
        tests: null,
        total: null,
        output: bound(scrubSecrets(error.message)),
      };
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const output = failureOutput(error);
    if (/timed out|timeout/i.test(errorMessage)) {
      return {
        outcome: 'infra_error',
        command: plan.command,
        tests: null,
        total: null,
        output: bound(output),
      };
    }
    exitCode = failureExitCode(error) ?? 1;
    rawOutput = output;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- test-runner`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/harness/test-runner.ts packages/worker/src/harness/__tests__/test-runner.test.ts
git commit -m "fix(worker): classify a vanished sandbox as infra_error in the suite runner"
```

---

### Task 5: Check the flag after the agent loop and translate escaping errors (paths A and B)

**Files:**
- Modify: `packages/worker/src/agent-fix.ts:3,603-640,850,1199-1212`
- Test: `packages/worker/src/__tests__/agent-fix.test.ts` (extend the existing suite — it already mocks `e2b`, `runAgentLoop`, `sandbox-repo`, and `test-runner`)

**Interfaces:**
- Consumes: `SandboxRuntime.unavailable` and `SandboxUnavailableError` from Task 1; `VerificationInfraError` from `harness/errors.ts`.
- Produces: `runAgentFix` throws `VerificationInfraError` (carrying a non-empty `EvidenceRecord`) whenever the sandbox became unavailable, regardless of what the agent reported.

- [ ] **Step 1: Write the failing test**

This must call `runAgentFix`. A test that only constructs errors and evidence
proves nothing and would pass the moment Task 1 lands.

Three constraints the test must respect, all learned the hard way:
1. The helper in `agent-fix.test.ts` is **`makeInput()`** (line 88). Use it.
2. Setup must survive `resolveClonedBranch` — start from the E2B fake used by an
   existing **passing** `runAgentFix` test in this file and override only what
   this case needs. A hand-written fake that returns empty stdout for `ls-remote`
   fails with `empty_repository` before the agent ever runs.
3. Setting a `dead` flag does **not** latch anything. The latch flips only when an
   *adapted* sandbox operation throws. The mocked `runAgentLoop` must therefore
   invoke a tool and swallow the error the way `agent-core/tool-loop.ts` does.

```ts
import { VerificationInfraError } from '../harness/errors.js';
import { logger } from '../logger.js';

describe('sandbox unavailability outranks any agent-reported outcome', () => {
  /** Setup shared by every test here; beforeEach resets mocks, so call it per test. */
  async function arrangeDeathDuringAgentLoop(): Promise<void> {
    const { SandboxNotFoundError } = await import('e2b');
    let dead = false;

    // Start from the fake the passing tests use, then make it die on demand.
    const base = passingSandboxFake();  // reuse the existing local helper
    createE2BSandbox.mockResolvedValue({
      ...base,
      sandboxId: 'sbx-dies',
      commands: {
        run: vi.fn(async (command: string, opts?: { timeoutMs?: number }) => {
          if (dead) throw new SandboxNotFoundError('Sandbox is probably not running anymore');
          return base.commands.run(command, opts);
        }),
      },
    });

    vi.mocked(runAgentLoop).mockImplementation(async (options) => {
      dead = true;
      // Mimic tool-loop.ts:202-212 — invoke a tool, swallow the exception, and
      // report success anyway. This is exactly how the latch must be reached.
      const read = options.tools.find((t) => t.name === 'read');
      try { await read?.execute({ path: '/home/user/repo/src/index.ts' }); } catch { /* erased */ }
      return {
        success: true, summary: 'fixed it', toolCallCount: 1, toolHistory: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      } as never;
    });
  }

  it('throws VerificationInfraError even when the agent reported success', async () => {
    await arrangeDeathDuringAgentLoop();
    await expect(runAgentFix(makeInput())).rejects.toBeInstanceOf(VerificationInfraError);
  });

  it('carries a non-empty evidence record naming the failure', async () => {
    await arrangeDeathDuringAgentLoop();
    await runAgentFix(makeInput()).then(
      () => { throw new Error('expected rejection'); },
      (err: VerificationInfraError) => {
        expect(err.evidence.checks.some((c) => c.outcome === 'infra_error')).toBe(true);
      },
    );
  });
});
```

If no reusable `passingSandboxFake()` helper exists in the file, extract one from
the nearest passing `runAgentFix` test rather than inventing sandbox behaviour.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- agent-fix`
Expected: FAIL — `runAgentFix` resolves (or rejects with something else) because
the latch is not yet consulted.

- [ ] **Step 3: Move the evidence recorder above sandbox creation**

`VerificationInfraError` requires a non-optional `EvidenceRecord`, but `evidence` is currently assigned at line 640 — after `createRepoSandbox`. A death during setup therefore cannot construct the error.

In `agent-fix.ts`, move the assignment. Replace line 604:

```ts
  let sandbox: SandboxRuntime | null = null;
  // Created before the sandbox: a setup-time death must still be able to
  // construct a VerificationInfraError, which requires an evidence record.
  // Note the type is no longer nullable — it was `EvidenceRecorder | null`
  // only because assignment happened after createRepoSandbox returned.
  const evidence: EvidenceRecorder = createEvidenceRecorder();
```

Because `evidence` is now non-nullable, drop the `evidence?.` optional chaining
and the `...(evidence ? { evidence: evidence.record() } : {})` spread further
down in this function; they become dead guards and will not typecheck cleanly as
written.

Delete the later re-assignment at line 640 (`evidence = createEvidenceRecorder();`) so the setup checks are not discarded.

- [ ] **Step 4: Check the flag immediately after the agent loop**

Insert directly after the `result = await traceSpan('agent-loop', ...)` call closes (line 850), **before** the `agentState.gaveUp` check:

```ts
        // agent-core/tool-loop.ts converts every tool exception into
        // model-visible text, so a dead sandbox cannot surface as an exception
        // here — only as this latched flag. Checked before the gaveUp and
        // budget branches because no agent verdict is trustworthy once the
        // machine is gone.
        if (sandbox.unavailable) {
          evidence.addCheck('sandbox', 'infra_error', {
            command: '',
            output: 'The verification sandbox became unavailable during the fix attempt',
          });
          throw new VerificationInfraError(
            'The verification sandbox became unavailable during the fix attempt, so the fix could not be proven either way.',
            evidence.record(),
          );
        }
```

- [ ] **Step 5: Translate escaping errors in the outer catch**

Replace line 1200 in the outer catch:

```ts
  } catch (err: unknown) {
    if (err instanceof VerificationInfraError) throw err;
    // Paths that throw rather than latch: the uncaught `git checkout` resets,
    // clone/branch resolution, install, baseline cleanup, tracked-file
    // discovery, tier reset, and extractDiff. Without this they all terminate
    // as worker_runtime_error and never requeue.
    // Also consult the latch: a dead sandbox can surface as some *other* plain
    // error thrown downstream of the failure, which would otherwise terminate
    // as worker_runtime_error.
    if (err instanceof SandboxUnavailableError || sandbox?.unavailable) {
      const detail = err instanceof Error ? err.message : String(err);
      evidence.addCheck('sandbox', 'infra_error', { command: '', output: scrubSecrets(detail) });
      throw new VerificationInfraError(
        'The verification sandbox became unavailable, so the fix could not be proven either way.',
        evidence.record(),
      );
    }
    const rawMessage = err instanceof Error ? err.message : String(err);
```

**Replace** — do not add — the existing import at `agent-fix.ts:3`. It already
imports `SandboxRuntime`; adding a second import of the same module creates a
duplicate binding:

```ts
// before: import type { SandboxRuntime } from './harness/sandbox-runtime.js';
import { SandboxUnavailableError, type SandboxRuntime } from './harness/sandbox-runtime.js';
```

- [ ] **Step 6: Run the full worker suite**

Run: `pnpm --filter @opslane/worker test`
Expected: PASS. If any existing test asserted `budget_exhausted` or `worker_runtime_error` for a dead-sandbox scenario, update the expectation to `VerificationInfraError` — that is the intended behaviour change, not a regression.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/agent-fix.ts packages/worker/src/__tests__/agent-fix.test.ts
git commit -m "fix(worker): sandbox unavailability outranks agent-reported outcomes"
```

---

### Task 6: Record sandbox identity where the failure is caught

**Files:**
- Modify: `packages/worker/src/agent-fix.ts` (three sites — see Step 2)
- Test: extend `packages/worker/src/__tests__/agent-fix.test.ts` with a logger assertion.

**Interfaces:**
- Consumes: `SandboxRuntime.id`, `.createdAt`, `.lifetimeMs` from Task 1.
- Produces: span attributes `sandbox.id`, `sandbox.created_at`, `sandbox.lifetime_ms`, `sandbox.age_at_error_ms`, `error.class`, `error.phase`, plus an equivalent `logger.error` line.

- [ ] **Step 1: Add the recorder helper**

`traceSpan(name, attributes, fn)` sets attributes at span start and has no mutation
callback, and `sandbox-setup` has already ended by the time a gate runs. Use the
active span instead. Note this attaches to whichever span is active at the catch
point — in practice the job root span, **not** the `agent-loop` span, which has
already closed. That is acceptable: the job span is where an operator looks.
Add near the top of `agent-fix.ts`:

```ts
import { trace } from '@opentelemetry/api';

/**
 * Record the machine's identity at the moment it failed. sandboxId appears
 * nowhere in the worker today, so an incident cannot currently be correlated to
 * the provider's own records. Logged as well as traced, because Langfuse export
 * is a no-op when its keys are unset.
 */
function recordSandboxFailure(sandbox: SandboxRuntime, phase: string, errorClass: string): void {
  const ageAtErrorMs = Date.now() - sandbox.createdAt;
  const fields = {
    'sandbox.id': sandbox.id,
    'sandbox.created_at': sandbox.createdAt,
    'sandbox.lifetime_ms': sandbox.lifetimeMs,
    'sandbox.age_at_error_ms': ageAtErrorMs,
    'error.class': errorClass,
    'error.phase': phase,
  };
  const span = trace.getActiveSpan();
  if (span) {
    for (const [key, value] of Object.entries(fields)) span.setAttribute(key, value);
  }
  logger.error('sandbox became unavailable', fields);
}
```

- [ ] **Step 2: Call it at both throw sites**

In the post-agent-loop check from Task 5, before the `throw`:

```ts
          recordSandboxFailure(sandbox, 'agent-loop', 'SandboxUnavailableError');
```

In the outer catch branch from Task 5, before the `throw`. `sandbox` is null when
the death happened during `createRepoSandbox`, so identity is genuinely
unavailable there — log the phase without it rather than skipping the record:

```ts
      if (sandbox) {
        recordSandboxFailure(sandbox, 'harness', 'SandboxUnavailableError');
      } else {
        logger.error('sandbox became unavailable before it was returned', {
          'error.class': 'SandboxUnavailableError',
          'error.phase': 'sandbox-setup',
        });
      }
```

**Third site — the gate-driven throw.** `runSuite` and `runBuildGate` convert
death into `infra_error` (Tasks 3 and 4), which sets `verificationInfraError` and
reaches the pre-existing throw at `agent-fix.ts:1061`. That is neither Task 5
site, and the outer catch rethrows `VerificationInfraError` immediately — so
without this, the most common gate path records no sandbox identity at all. Add
before that throw:

```ts
      if (sandbox.unavailable) recordSandboxFailure(sandbox, 'verification-gate', 'SandboxUnavailableError');
```

- [ ] **Step 3: Assert the record is actually written**

`recordSandboxFailure` writes to both a span and the logger. Spans are a no-op
without Langfuse keys, so assert on the logger. Add `import { logger } from '../logger.js';`
to the test file if Step 1 of Task 5 did not already:

```ts
  it('records sandbox identity and age when the machine dies', async () => {
    // beforeEach resets mocks, so arrange explicitly — do not rely on a prior test.
    await arrangeDeathDuringAgentLoop();
    const errorSpy = vi.spyOn(logger, 'error');
    await expect(runAgentFix(makeInput())).rejects.toBeInstanceOf(VerificationInfraError);
    expect(errorSpy).toHaveBeenCalledWith(
      'sandbox became unavailable',
      expect.objectContaining({
        'sandbox.id': 'sbx-dies',
        'error.phase': expect.any(String),
        'sandbox.age_at_error_ms': expect.any(Number),
      }),
    );
  });
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @opslane/worker test && pnpm --filter @opslane/worker build`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/agent-fix.ts packages/worker/src/__tests__/agent-fix.test.ts
git commit -m "feat(worker): record sandbox id, age, and phase when a sandbox dies"
```

---

### Task 7: Confirm the existing requeue coverage still holds

**Files:**
- Verify only: `packages/worker/src/__tests__/index.test.ts:365-390`

**Interfaces:**
- Consumes: `VerificationInfraError` from Task 5.
- Produces: nothing new.

The requeue-vs-terminalize contract is **already covered**. `index.test.ts:365`
("rethrows verification infrastructure errors while the job has retries
remaining") and `:379` ("converts a final verification infrastructure failure to
needs_human with evidence") drive it through `mockRunPipeline.mockRejectedValue`.

Do **not** write a new `process-job-infra.test.ts`. An earlier draft of this plan
proposed one; it would have duplicated these tests and could not have worked as
written — `processJobInner` branches on `job.jobType`, and `processFixJob` is a
module-local lexical binding that `vi.spyOn` cannot replace.

- [ ] **Step 1: Run the existing coverage**

Run: `pnpm --filter @opslane/worker test -- index`
Expected: PASS, including the two tests above.

- [ ] **Step 2: Confirm the evidence assertion is meaningful**

Both existing tests build the fixture as `{ version: 1, tier: 'E0', checks: [] }`
(`index.test.ts:366`) — an **empty** checks array, which contradicts the guarantee
Task 5 now makes. Change both fixtures to carry a real infra check and assert it
survives terminalization:

```ts
    const evidence = {
      version: 1 as const,
      tier: null,
      checks: [{ name: 'sandbox', outcome: 'infra_error' as const, command: '', output_tail: 'gone' }],
    };
```

Then in the final-attempt test, assert the record reaches `updateGroupStatus`:

```ts
    expect(entry?.[3]?.evidence?.checks).toHaveLength(1);
```

- [ ] **Step 3: Commit (only if Step 2 changed anything)**

```bash
git add packages/worker/src/__tests__/index.test.ts
git commit -m "test(worker): assert infra failures carry evidence to terminalization"
```

## Final Verification

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm -r build`
- [ ] `pnpm --filter @opslane/worker test` — read the **skip count**, not just the pass count
- [ ] `node scripts/check-docs-drift.mjs`
- [ ] `docker compose config --quiet`
- [ ] Confirm only `sandbox-runtime.ts` imports `e2b`:
      `grep -rn "from 'e2b'" packages/worker/src --include=*.ts | grep -v __tests__`
      Expected: exactly one hit.
- [ ] **Live pipeline smoke — required.** The root `AGENTS.md` mandates this for
      pipeline behaviour changes: apply migrations, run `scripts/seed-e2e.sql`,
      rebuild ingestion and worker, POST an event to
      `$INGESTION_URL/api/v1/events`, and confirm the job reaches its expected
      terminal state. From a worktree, export the free-port triple and derived
      URLs as a unit (see root `AGENTS.md`), and confirm
      `(cd packages/ingestion && go test ./...)` reports **zero** skips.
- [ ] Live lifetime check (needs `E2B_API_KEY`). `SandboxRuntime` exposes no expiry
      field and only `sandbox-runtime.ts` may import `e2b`, so use a throwaway
      script. It must run from **`packages/worker`** so pnpm resolves the
      workspace-local `e2b`; a script in the repo root will not resolve it:

      ```bash
      cd packages/worker
      node --input-type=module -e "
        import { Sandbox } from 'e2b';
        const s = await Sandbox.create({ timeoutMs: 1_800_000 });
        console.log(s.sandboxId, await s.getInfo?.());
        await s.kill();
      "
      ```

      If `getInfo()` is unavailable in v2.35, assert instead that creation with
      `timeoutMs: 1_800_000` succeeds — a tier rejection surfaces as a creation
      error, which is the failure this check exists to rule out.

## Out of Scope

Do not implement these here; they are tracked separately.

- `CommandFailedError`, removing `buildFailureExitCode()`, removing the unreachable `res.exitCode === 0` branch in `runBuildGate` → **#274**
- Redacting Opslane-side faults from customer-facing evidence → **#273** (blocked on Task 6 landing and being confirmed in production)
- Provider-neutral `SandboxRuntime` (`/home/user/repo` hardcoded 13× across 7 files) → **#274**
- Fail-fast on `installFailed` — a real latent bug, but not required to fix any path in this plan
- Requeuing the seven existing incidents — decided out of scope; they stay `needs_human`
