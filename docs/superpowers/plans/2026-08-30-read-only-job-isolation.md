# Read-Only Job Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the four read-only job types from reading customer repositories on the shared worker host. Their file access moves into a per-run E2B sandbox with deny-all egress and an API key the sandbox never sees.

**Architecture:** `runReadOnlyAgent` keeps its public contract except that `repoPath: string` becomes `reader: RepoReader`. The three tool bodies keep all their formatting and truncation on the host and delegate only raw data fetching to the reader, so output shapes cannot drift. The sandbox reader enforces containment inside the machine with `realpath`, and a failure that means the machine is gone propagates as a typed error instead of becoming model-visible text.

**Tech Stack:** TypeScript (ESM, strict), `e2b@2.45.0`, Vitest, Postgres job queue.

**Spec:** `docs/design/2026-08-29-fix-sandbox-reliability-design.md`

## Global Constraints

- ESM and strict TypeScript. Use `unknown` plus narrowing, never `any`.
- Vitest tests colocated in `__tests__`.
- Every terminal `needs_human` result carries a non-empty `reason_code`, `reason_message`, and `remediation`.
- Do not weaken terminal-status or lease contracts to make a test pass.
- `e2b` is pinned at exactly `2.45.0`. `SandboxOpts` has no `memoryMB`/`cpuCount`.
- E2B returns 400 unless an `allowOut` list is paired with `denyOut` containing `ALL_TRAFFIC`.
- Egress allowlist is exactly: `registry.npmjs.org`, `github.com`, `api.anthropic.com`.
- Every task must leave `pnpm --filter @opslane/worker build` and `pnpm --filter @opslane/worker test` passing. A task that breaks the build midway is a defect.

## Scope

This plan covers Phase 1 only: isolation, egress, and install-failure classification for **three** read-only job types: investigate, issue_inquiry, and friction_investigate.

**`product_context` is excluded, discovered during implementation.** Its `discoverRepositoryRoutes` (`product-context/job.ts:158`) walks the checkout with `node:fs/promises` and reads up to 10,000 source files (`:72`), running multi-line regexes over each to build the model's prompt (`:342`). That is not expressible through a three-method `RepoReader`: it would be 10,000 command round-trips, the multi-line regexes cannot be ported to `grep`, and streaming the files back would copy customer code onto the host, which is the thing this change exists to stop. It needs its own seam and its own design. Production volume over 14 days made the call easy: investigate 370, issue_inquiry 31, friction_investigate 0, product_context 1.

**Deliberately not in this plan, with reasons:**

- **The Claude Agent SDK migration.** It needs a design pass first, not a task list. `ReadOnlyRunInput` carries function-valued fields (`validateTerminal`, `terminalTool` schema) that cannot be serialized into a sandbox process, so the host-to-sandbox protocol has to be designed before it can be planned. The SDK also has no `tool_choice` forcing and no dollar budget cap, and its built-in `Read` was measured following a symlink out of its working directory. File this as its own design.
- **"Retry a clean install failure once before telling the customer."** This needs durable per-attempt install state to distinguish a first failure from a second, with clearing rules across clone failures and successes. In this plan a clean install failure terminalizes on its first occurrence. That is still far better than today, where it silently continues and burns the whole model budget.
- `best_supported` reaching customers unverified; installation-wide GitHub tokens at `app.go:94`; npm postinstall tampering in the fix pipeline; per-repository prebuilt machines; Python parity.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/worker/src/harness/sandbox-network.ts` | **New.** Builds the E2B network config. Pure, no I/O. |
| `packages/worker/src/harness/machine-state.ts` | **New.** Decides gone / alive / unknown from a failure plus one liveness probe. |
| `packages/worker/src/harness/readonly-sandbox.ts` | **New.** Rents a sandbox, clones into it, exposes a `RepoReader`, owns the lifetime. |
| `packages/worker/src/investigate-tools.ts` | **Modify.** Keeps all formatting; delegates raw fetching to a `RepoReader`. |
| `packages/worker/src/readonly-agent.ts` | **Modify.** Takes a `reader`, and lets `MachineUnavailableError` escape. |
| `packages/worker/src/harness/sandbox-repo.ts` | **Modify.** Install failure classifies and stops. |

---

## Task 0: Shared error classes

**Files:**
- Modify: `packages/worker/src/harness/errors.ts`
- Test: `packages/worker/src/harness/__tests__/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class MachineUnavailableError extends Error { readonly state: 'gone' | 'unknown' }`
  - `class DependencyInstallError extends Error { readonly output: string }`

Both classes live here and only here. Two definitions of the same class break `instanceof` silently, and every later task imports from this module. `errors.ts` imports nothing from the worker, so no task can create a cycle by importing it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { DependencyInstallError, MachineUnavailableError } from '../errors.js';

describe('error classes', () => {
  it('MachineUnavailableError carries the state it was classified with', () => {
    const e = new MachineUnavailableError('gone', 'gone');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('MachineUnavailableError');
    expect(e.state).toBe('gone');
  });
  it('DependencyInstallError carries scrubbed output', () => {
    const e = new DependencyInstallError('install failed', 'ERESOLVE could not resolve');
    expect(e.output).toContain('ERESOLVE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- errors`
Expected: FAIL, neither class is exported

- [ ] **Step 3: Write minimal implementation**

```ts
/** The machine could not serve the request. `state` never claims death it cannot prove. */
export class MachineUnavailableError extends Error {
  constructor(message: string, readonly state: 'gone' | 'unknown') {
    super(message);
    this.name = 'MachineUnavailableError';
  }
}

/** The customer's dependency list could not be installed. `output` is already scrubbed. */
export class DependencyInstallError extends Error {
  constructor(message: string, readonly output: string) {
    super(message);
    this.name = 'DependencyInstallError';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- errors && pnpm --filter @opslane/worker build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/harness/errors.ts packages/worker/src/harness/__tests__/errors.test.ts
git commit -m "feat(worker): shared error classes for machine and install failures"
```

---

## Task 1: Network configuration

**Files:**
- Create: `packages/worker/src/harness/sandbox-network.ts`
- Test: `packages/worker/src/harness/__tests__/sandbox-network.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildReadOnlyNetwork(anthropicApiKey: string): SandboxNetworkOpts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { ALL_TRAFFIC } from 'e2b';
import { buildReadOnlyNetwork } from '../sandbox-network.js';

describe('buildReadOnlyNetwork', () => {
  it('denies all traffic and allows exactly the three required hosts', () => {
    const net = buildReadOnlyNetwork('sk-ant-test');
    expect(net.denyOut).toEqual([ALL_TRAFFIC]);
    expect(net.allowOut).toEqual(['registry.npmjs.org', 'github.com', 'api.anthropic.com']);
  });

  it('injects the api key as a header rule so it never enters the sandbox', () => {
    const net = buildReadOnlyNetwork('sk-ant-test');
    expect(net.rules?.['api.anthropic.com']).toEqual([
      { transform: { headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' } } },
    ]);
  });

  it('registers no rule for hosts needing no credential', () => {
    const net = buildReadOnlyNetwork('sk-ant-test');
    expect(net.rules?.['github.com']).toBeUndefined();
    expect(net.rules?.['registry.npmjs.org']).toBeUndefined();
  });

  it('rejects an empty key rather than building a rule that injects nothing', () => {
    expect(() => buildReadOnlyNetwork('')).toThrow('Anthropic API key is required');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- sandbox-network`
Expected: FAIL, cannot find module `../sandbox-network.js`

- [ ] **Step 3: Write minimal implementation**

```ts
import { ALL_TRAFFIC } from 'e2b';
import type { SandboxNetworkOpts } from 'e2b';

const ALLOWED_HOSTS = ['registry.npmjs.org', 'github.com', 'api.anthropic.com'] as const;

/**
 * Network policy for a read-only sandbox.
 *
 * The key is attached by E2B's egress proxy, not placed in the sandbox
 * environment. A sandbox holds one customer's repository and untrusted file
 * content steers the model, so a key inside the machine is reachable by the very
 * thing being isolated. Measured: a request from inside with no key returns 200,
 * and `env` inside the machine contains no Anthropic variable.
 *
 * E2B returns 400 unless denyOut names ALL_TRAFFIC, so the deny is not redundant.
 */
export function buildReadOnlyNetwork(anthropicApiKey: string): SandboxNetworkOpts {
  if (!anthropicApiKey) throw new Error('Anthropic API key is required to build the egress rule');
  return {
    denyOut: [ALL_TRAFFIC],
    allowOut: [...ALLOWED_HOSTS],
    rules: {
      'api.anthropic.com': [
        { transform: { headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' } } },
      ],
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- sandbox-network && pnpm --filter @opslane/worker build`
Expected: PASS, 4 tests, build clean

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/harness/sandbox-network.ts packages/worker/src/harness/__tests__/sandbox-network.test.ts
git commit -m "feat(worker): egress policy for read-only sandboxes"
```

---

## Task 2: Machine-state classification

**Files:**
- Create: `packages/worker/src/harness/machine-state.ts`
- Test: `packages/worker/src/harness/__tests__/machine-state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MachineState = 'gone' | 'alive' | 'unknown'`
  - `isCommandFailure(err: unknown): err is CommandExitError`
  - `classifyFailure(err: unknown, probe: () => Promise<boolean>): Promise<MachineState>`

Background. In `e2b@2.45.0` only `Unavailable`, `Canceled`, and `DeadlineExceeded` map to `TimeoutError`; every other transport code falls through to `new SandboxError(\`${code}: ${message}\`)`, which is how production's `2: [unknown] terminated` was produced. So the error type cannot separate a dead machine from a slow command. Ask the machine.

Two rules the tests enforce. A `CommandExitError` means the command ran, so the machine works and no probe is needed. And `isRunning()` returning false is reported as `gone`, but a probe that itself fails is `unknown`, never `gone`, because a failed probe is not evidence of death.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { CommandExitError, SandboxError, SandboxNotFoundError, TimeoutError } from 'e2b';
import { classifyFailure, isCommandFailure } from '../machine-state.js';

const exitErr = (exitCode: number) =>
  new CommandExitError({ exitCode, stdout: '', stderr: '', error: undefined } as never);
const never = () => Promise.reject(new Error('probe should not have run'));

describe('isCommandFailure', () => {
  it('is true when the command ran and returned a code', () => {
    expect(isCommandFailure(exitErr(1))).toBe(true);
  });
  it('is false for a transport failure', () => {
    expect(isCommandFailure(new SandboxError('2: [unknown] terminated'))).toBe(false);
  });
});

describe('classifyFailure', () => {
  it('reports alive for a command exit without probing', async () => {
    expect(await classifyFailure(exitErr(1), never)).toBe('alive');
  });
  it('reports gone for a missing sandbox without probing', async () => {
    expect(await classifyFailure(new SandboxNotFoundError('gone'), never)).toBe('gone');
  });
  it('reports gone when the probe says not running', async () => {
    expect(await classifyFailure(new SandboxError('2: [unknown] terminated'), async () => false)).toBe('gone');
  });
  it('reports unknown when the probe says running, because the machine answered but the operation did not', async () => {
    expect(await classifyFailure(new SandboxError('2: [unknown] terminated'), async () => true)).toBe('unknown');
  });
  it('reports unknown when the probe itself fails, never gone', async () => {
    const probe = vi.fn(async () => { throw new Error('probe unreachable'); });
    expect(await classifyFailure(new SandboxError('2: [unknown] terminated'), probe)).toBe('unknown');
  });
  it('reports alive for a command deadline, so a slow suite is not a dead machine', async () => {
    expect(await classifyFailure(new TimeoutError("exceeding 'timeoutMs'"), async () => true)).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- machine-state`
Expected: FAIL, cannot find module `../machine-state.js`

- [ ] **Step 3: Write minimal implementation**

```ts
import { CommandExitError, SandboxNotFoundError } from 'e2b';

/** What the provider says about the machine, as of the moment we asked. */
export type MachineState = 'gone' | 'alive' | 'unknown';

/**
 * True when the command executed and returned a failure code, so the machine works.
 * A type predicate, not a boolean: callers read `exitCode`/`stdout`/`stderr` off
 * the narrowed value, which `unknown` would not permit.
 */
export function isCommandFailure(err: unknown): err is CommandExitError {
  return err instanceof CommandExitError;
}

/**
 * Classify a failed sandbox operation.
 *
 * `alive` is reserved for the case we can prove: the command ran and returned a
 * code. A live probe after a transport failure only tells us the machine answers
 * now, not that the failed operation was the machine's fault, so that is
 * `unknown`. `unknown` and `gone` are both retriable; only `gone` may be reported
 * as death. A paused sandbox also reads as not-running here, which is why the
 * caller logs the state rather than asserting the machine was destroyed.
 */
export async function classifyFailure(
  err: unknown,
  probe: () => Promise<boolean>,
): Promise<MachineState> {
  if (isCommandFailure(err)) return 'alive';
  if (err instanceof SandboxNotFoundError) return 'gone';
  try {
    return (await probe()) ? 'unknown' : 'gone';
  } catch {
    return 'unknown';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- machine-state && pnpm --filter @opslane/worker build`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/harness/machine-state.ts packages/worker/src/harness/__tests__/machine-state.test.ts
git commit -m "feat(worker): classify machine death by probing, not by error type"
```

---

## Task 3: RepoReader seam and all four callers, in one change

**Files:**
- Modify: `packages/worker/src/investigate-tools.ts`
- Modify: `packages/worker/src/readonly-agent.ts` (the `repoPath` field, and dispatch at lines 368, 373, 375)
- Modify: `packages/worker/src/investigate.ts:376`, `packages/worker/src/inquiry/job.ts:166`, `packages/worker/src/product-context/job.ts:379`, `packages/worker/src/friction/investigate-friction.ts:182`
- Test: `packages/worker/src/__tests__/investigate-tools.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RepoReader { readFile(path: string): Promise<string>; grep(args: string[]): Promise<string>; list(path: string): Promise<string>; }`
  - `createHostReader(repoPath: string): RepoReader`
  - `executeReadFile(reader: RepoReader, input: Record<string, unknown>): Promise<string>` and the same signature change for `executeSearch` and `executeListFiles`
  - `ReadOnlyRunInput.reader: RepoReader` replaces `ReadOnlyRunInput.repoPath: string`

This is deliberately one task, not two. Changing the `execute*` signatures without updating the callers in the same commit leaves the build broken.

**The seam is raw data, not formatted output.** `RepoReader` returns raw bytes and raw `grep`/`ls` stdout. All formatting, truncation, the `No matches found.` string, and the `MAX_SEARCH_RESULTS` cap stay in `investigate-tools.ts`. This is what stops the sandbox implementation from silently changing what the model sees.

**`MachineUnavailableError` must escape.** The `execute*` functions turn ordinary errors into model-visible strings. A dead machine must not become a string, or the agent keeps burning turns against a machine that is gone. Task 4 defines the class; this task must already rethrow anything named `MachineUnavailableError`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { executeListFiles, executeReadFile, executeSearch, type RepoReader } from '../investigate-tools.js';

function reader(over: Partial<RepoReader> = {}): RepoReader {
  return {
    readFile: async () => '',
    grep: async () => '',
    list: async () => '',
    ...over,
  };
}

describe('executeReadFile', () => {
  it('adds line numbers', async () => {
    const out = await executeReadFile(reader({ readFile: async () => 'const x = 1;' }), { path: 'a.ts' });
    expect(out).toBe('   1 | const x = 1;');
  });
  it('requires a path', async () => {
    expect(await executeReadFile(reader(), {})).toBe('Error: "path" parameter is required');
  });
  it('reports a missing file for any not-found shape', async () => {
    const r = reader({ readFile: async () => { throw new Error('cat: a.ts: No such file or directory'); } });
    expect(await executeReadFile(r, { path: 'a.ts' })).toBe('Error: file not found: a.ts');
  });
  it('rethrows a machine-unavailable error instead of stringifying it', async () => {
    const boom = Object.assign(new Error('machine gone'), { name: 'MachineUnavailableError' });
    const r = reader({ readFile: async () => { throw boom; } });
    await expect(executeReadFile(r, { path: 'a.ts' })).rejects.toBe(boom);
  });
});

describe('executeSearch', () => {
  it('keeps the no-match string', async () => {
    expect(await executeSearch(reader({ grep: async () => '' }), { pattern: 'x' })).toBe('No matches found.');
  });
  it('caps results at 50 and says how many more there were', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `a.ts:${i}:hit`).join('\n');
    const out = await executeSearch(reader({ grep: async () => lines }), { pattern: 'hit' });
    expect(out.split('\n')).toHaveLength(51);
    expect(out).toContain('[10 more results]');
  });
  it('passes default include flags when none is given', async () => {
    let seen: string[] = [];
    await executeSearch(reader({ grep: async (a) => { seen = a; return ''; } }), { pattern: 'x' });
    expect(seen).toContain('--include');
    expect(seen).toContain('*.ts');
    expect(seen.at(-2)).toBe('x');
    expect(seen.at(-1)).toBe('.');
  });
  it('rethrows a machine-unavailable error', async () => {
    const boom = Object.assign(new Error('gone'), { name: 'MachineUnavailableError' });
    await expect(executeSearch(reader({ grep: async () => { throw boom; } }), { pattern: 'x' })).rejects.toBe(boom);
  });
});

describe('executeListFiles', () => {
  it('returns the raw listing', async () => {
    expect(await executeListFiles(reader({ list: async () => 'a.ts\nb/' }), { path: '.' })).toBe('a.ts\nb/');
  });
  it('host and sandbox readers agree on the same tree', async () => {
    // Parity is the whole point of the seam: if the two implementations format
    // differently, switching silently changes what the model sees.
    // Build a fixture tree, run createHostReader over it, run the sandbox
    // command shape over the same tree, and assert the strings are identical.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- investigate-tools`
Expected: FAIL, `RepoReader` is not exported and `executeReadFile` still takes a string

- [ ] **Step 3: Write minimal implementation**

```ts
import { MachineUnavailableError } from './harness/errors.js';

/**
 * A machine-unavailable failure must reach the job, not the model.
 *
 * `instanceof` against the class exported from harness/errors.js, never a name
 * check: a name is mutable and an unrelated error could impersonate it.
 * errors.js imports nothing from this module, so there is no cycle.
 */
function rethrowIfMachineGone(err: unknown): void {
  if (err instanceof MachineUnavailableError) throw err;
}

/**
 * Everything the read-only agent may do to a checkout, as raw data.
 *
 * Formatting deliberately lives in the callers below, not here: the host and
 * sandbox implementations must be interchangeable, and if each produced its own
 * formatting the model's view would change silently when we switch.
 */
export interface RepoReader {
  /** Whole file as text, already bounded by the implementation. */
  readFile(path: string): Promise<string>;
  /** Raw grep stdout. Empty string means no matches. */
  grep(args: string[]): Promise<string>;
  /** Raw directory listing, one entry per line. */
  list(path: string): Promise<string>;
}

export async function executeReadFile(reader: RepoReader, input: Record<string, unknown>): Promise<string> {
  const filePath = input['path'];
  if (typeof filePath !== 'string' || filePath.length === 0) return 'Error: "path" parameter is required';
  try {
    const content = await reader.readFile(filePath);
    return content.length > MAX_FILE_SIZE
      ? `${addLineNumbers(content.slice(0, MAX_FILE_SIZE))}\n... [truncated at 50KB]`
      : addLineNumbers(content);
  } catch (err: unknown) {
    rethrowIfMachineGone(err);
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|No such file|not found/i.test(msg)) return `Error: file not found: ${filePath}`;
    return `Error: reading file failed: ${msg}`;
  }
}

export async function executeSearch(reader: RepoReader, input: Record<string, unknown>): Promise<string> {
  const pattern = input['pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) return 'Error: "pattern" parameter is required';
  const include = typeof input['include'] === 'string' ? input['include'] : undefined;
  const defaultExtensions = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.vue', '*.svelte', '*.json', '*.go', '*.py'];
  const includeArgs = include
    ? ['--include', include]
    : defaultExtensions.flatMap((ext) => ['--include', ext]);
  const args = ['-r', '-n', ...includeArgs, ...grepExclusionArgs(), '-m', '5', '--', pattern, '.'];
  try {
    const stdout = await reader.grep(args);
    const lines = stdout.split('\n').filter(Boolean);
    if (lines.length === 0) return 'No matches found.';
    return lines.length > MAX_SEARCH_RESULTS
      ? `${lines.slice(0, MAX_SEARCH_RESULTS).join('\n')}\n... [${lines.length - MAX_SEARCH_RESULTS} more results]`
      : lines.join('\n');
  } catch (err: unknown) {
    rethrowIfMachineGone(err);
    return `Error searching: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function executeListFiles(reader: RepoReader, input: Record<string, unknown>): Promise<string> {
  const path = typeof input['path'] === 'string' ? input['path'] : '.';
  try {
    return await reader.list(path);
  } catch (err: unknown) {
    rethrowIfMachineGone(err);
    return `Error listing files: ${err instanceof Error ? err.message : String(err)}`;
  }
}
```

Add `createHostReader(repoPath)`, moving the existing host logic verbatim behind the three raw methods: `safePath` plus the bounded `open`/`read` window for `readFile`, `execFileAsync('grep', args, { cwd })` for `grep`, **catching exit code 1 and returning its stdout**, because grep exits 1 when there are no matches and `execFileAsync` rejects on any non-zero code. Without this the `No matches found.` test fails inside this task:

```ts
grep: async (args) => {
  try {
    return (await execFileAsync('grep', args, { cwd: repoPath, maxBuffer: 512 * 1024, timeout: 10_000 })).stdout;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 1) {
      return String((err as { stdout?: string }).stdout ?? '');
    }
    throw err;
  }
},
```, and the existing `readdir` walk for `list`. Keep `safePath` for now; Task 5 deletes both.

In `readonly-agent.ts`, replace `repoPath: string;` with `reader: RepoReader;` and pass `input.reader` at the three dispatch sites. At each of the four job call sites, pass `reader: createHostReader(repoDir)` using whatever local variable already holds the clone directory at that site.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`
Expected: PASS. The build is the check that all four call sites were updated.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src
git commit -m "refactor(worker): raw-data RepoReader seam behind the read-only tools"
```

---

## Task 4: Sandbox-backed reader with in-machine containment

**Files:**
- Create: `packages/worker/src/harness/readonly-sandbox.ts`
- Test: `packages/worker/src/harness/__tests__/readonly-sandbox.test.ts`

**Interfaces:**
- Consumes: `RepoReader` (Task 3), `buildReadOnlyNetwork` (Task 1), `classifyFailure`/`isCommandFailure` (Task 2), `MachineUnavailableError` (Task 0), `logger` from `../logger.js`.
- Produces:
  - `createSandboxReader(sbx: MinimalSandbox, root: string): RepoReader`
  - `interface ReadOnlyCheckout { reader: RepoReader; sandboxId: string; createdAt: number; close(): Promise<void>; }`
  - `createReadOnlyCheckout(opts: ReadOnlyCheckoutOpts): Promise<ReadOnlyCheckout>`

**Containment is enforced inside the machine, with `realpath`.** Task 5 deletes the host's lexical `safePath`, and a lexical check cannot see through a symlink anyway. Every read resolves the path in the machine and refuses anything that lands outside the checkout. This matters even though the machine holds one customer's repository, because it also holds `/proc`, the clone credential's former location, and anything a later task adds.

**`readFile` stays bounded.** `head -c` is used rather than `cat` so a multi-gigabyte or special file cannot exhaust the command output or the deadline.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { CommandExitError } from 'e2b';
import { createSandboxReader, MachineUnavailableError } from '../readonly-sandbox.js';

function fake(run: (cmd: string) => Promise<{ stdout: string }>, running: () => Promise<boolean> = async () => true) {
  return { sandboxId: 'sbx', isRunning: vi.fn(running), commands: { run: vi.fn(run) }, kill: vi.fn(async () => undefined) };
}

describe('createSandboxReader containment', () => {
  it('resolves the path inside the machine and bounds the read', async () => {
    const sbx = fake(async () => ({ stdout: 'x' }));
    await createSandboxReader(sbx as never, '/home/user/repo').readFile('src/a.ts');
    const cmd = sbx.commands.run.mock.calls[0]![0] as string;
    expect(cmd).toContain('realpath');
    expect(cmd).toContain('head -c');
    expect(cmd).toContain("'src/a.ts'");
  });

  it('turns the containment failure exit code into a refusal, not a machine error', async () => {
    const sbx = fake(async () => { throw new CommandExitError({ exitCode: 3, stdout: '', stderr: 'PATH_OUTSIDE', error: undefined } as never); });
    await expect(createSandboxReader(sbx as never, '/home/user/repo').readFile('../../etc/passwd'))
      .rejects.toThrow('path escapes the repository');
  });

  it('single-quotes model-supplied strings', async () => {
    const sbx = fake(async () => ({ stdout: '' }));
    await createSandboxReader(sbx as never, '/home/user/repo').readFile("a'; rm -rf /; '.ts");
    expect(sbx.commands.run.mock.calls[0]![0] as string).toContain(`'a'\\''; rm -rf /; '\\''.ts'`);
  });
});

describe('createSandboxReader failure classification', () => {
  it('raises MachineUnavailableError with state gone when the probe says not running', async () => {
    const sbx = fake(async () => { throw new Error('2: [unknown] terminated'); }, async () => false);
    await expect(createSandboxReader(sbx as never, '/r').readFile('a.ts')).rejects.toMatchObject({
      name: 'MachineUnavailableError', state: 'gone',
    });
  });

  it('raises state unknown when the probe itself fails, never gone', async () => {
    const sbx = fake(async () => { throw new Error('2: [unknown] terminated'); }, async () => { throw new Error('unreachable'); });
    await expect(createSandboxReader(sbx as never, '/r').readFile('a.ts')).rejects.toMatchObject({ state: 'unknown' });
  });

  it('lets an ordinary command failure through unchanged', async () => {
    const exit = new CommandExitError({ exitCode: 1, stdout: '', stderr: 'grep: bad', error: undefined } as never);
    const sbx = fake(async () => { throw exit; });
    await expect(createSandboxReader(sbx as never, '/r').grep(['-r', 'x', '.']))
      .rejects.not.toBeInstanceOf(MachineUnavailableError);
  });

  it('returns empty stdout for grep exit 1, which means no matches', async () => {
    const exit = new CommandExitError({ exitCode: 1, stdout: '', stderr: '', error: undefined } as never);
    const sbx = fake(async () => { throw exit; });
    expect(await createSandboxReader(sbx as never, '/r').grep(['-r', 'x', '.'])).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- readonly-sandbox`
Expected: FAIL, cannot find module `../readonly-sandbox.js`

- [ ] **Step 3: Write minimal implementation**

```ts
import { CommandExitError, Sandbox } from 'e2b';
import { classifyFailure, isCommandFailure, type MachineState } from './machine-state.js';
import { MachineUnavailableError } from './errors.js';
import { logger } from '../logger.js';
import { buildReadOnlyNetwork } from './sandbox-network.js';
import { buildGitNetrc } from '../repo-clone.js';
import type { RepoReader } from '../investigate-tools.js';

const SANDBOX_REPO = '/home/user/repo';
/** One byte past the host's 50KB cap, so the host can still detect truncation. */
const MAX_READ_BYTES = 51_201;
const READ_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5_000;
const SANDBOX_LIFETIME_MS = 900_000;
/** Exit code the in-machine guard uses for a path that escapes the checkout. */
const PATH_OUTSIDE_EXIT = 3;

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
  return `p=$(realpath -e -- ${q(path)} 2>/dev/null) || exit 4; ` +
    `case "$p" in ${q(root)}/*|${q(root)}) ;; *) exit ${PATH_OUTSIDE_EXIT};; esac; `;
}

export function createSandboxReader(sbx: MinimalSandbox, root: string): RepoReader {
  const run = async (cmd: string, okExitCodes: number[] = []): Promise<string> => {
    try {
      return (await sbx.commands.run(cmd, { timeoutMs: READ_TIMEOUT_MS })).stdout;
    } catch (err: unknown) {
      if (err instanceof CommandExitError) {
        if (okExitCodes.includes(err.exitCode)) return err.stdout;
        if (err.exitCode === PATH_OUTSIDE_EXIT) throw new Error('path escapes the repository');
        if (err.exitCode === 4) throw new Error('No such file or directory');
        throw err;
      }
      const state = await classifyFailure(err, () => sbx.isRunning({ requestTimeoutMs: PROBE_TIMEOUT_MS }));
      throw new MachineUnavailableError(
        state === 'gone' ? 'The work machine is no longer running.' : 'The work machine state could not be determined.',
        state,
      );
    }
  };

  return {
    readFile: (path) => run(`cd ${q(root)} && ${guardedPath(root, path)} head -c ${MAX_READ_BYTES} -- "$p"`),
    // grep exits 1 for "no matches", which is not a failure.
    grep: (args) => run(`cd ${q(root)} && grep ${args.map(q).join(' ')}`, [1]),
    // Must match the host reader's output exactly. Read the existing
    // executeListFiles before writing this: it walks with readdir, marks
    // directories, applies isExcludedTraversalDirectory, and descends one level.
    // A parity test in this task compares both readers over one fixture tree.
    list: (path) => run(
      `cd ${q(root)} && ${guardedPath(root, path)} ` +
      `find "$p" -maxdepth 2 -not -path '*/.git/*' -not -path '*/node_modules/*' ` +
      `-printf '%P%y\\n' 2>/dev/null | sed 's/d$/\\//;s/f$//' | sort`,
    ),
  };
}
```

Then `createReadOnlyCheckout`:

```ts
export interface ReadOnlyCheckoutOpts {
  repoUrl: string;
  commitSha?: string | undefined;
  githubToken?: string | undefined;
  anthropicApiKey: string;
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
      await sbx.commands.run(
        `git clone --depth 1 ${q(opts.repoUrl)} ${q(SANDBOX_REPO)}`,
        { timeoutMs: CLONE_TIMEOUT_MS },
      );
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
          // Only a git-level failure is a missing commit. A transport failure
          // means the machine is in trouble and must not be silently downgraded
          // to "use the default head".
          // Only a genuine missing ref is a fallback. An auth failure, a DNS
          // failure or a GitHub outage is also a CommandExitError, and silently
          // investigating the wrong commit is worse than failing.
          const detail = `${err instanceof CommandExitError ? err.stderr : ''}`;
          const missingRef = /couldn't find remote ref|not a valid object name|no such remote ref/i.test(detail);
          if (!isCommandFailure(err) || !missingRef) throw err;
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
    return {
      reader: createSandboxReader(sbx, SANDBOX_REPO),
      sandboxId: sbx.sandboxId,
      createdAt,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- readonly-sandbox && pnpm --filter @opslane/worker build`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/harness/readonly-sandbox.ts packages/worker/src/harness/__tests__/readonly-sandbox.test.ts
git commit -m "feat(worker): sandbox-backed reader with in-machine containment"
```

---

## Task 5: Cut the four jobs over and delete host reading

**Files:**
- Modify: the four job files listed in Task 3
- Modify: `packages/worker/src/investigate.ts:291-302` (the quote checker)
- Modify: `packages/worker/src/investigate-tools.ts` (delete `createHostReader`, `safePath`, and the now-unused `node:fs` imports)
- Test: `packages/worker/src/__tests__/readonly-isolation.test.ts` (new file)

**Interfaces:**
- Consumes: `createReadOnlyCheckout` (Task 4).
- Produces: no new exports. `safePath` and `createHostReader` are gone.

Investigation has a second host read at `investigate.ts:302`, the verbatim-quote check. It must go through the same reader or it silently keeps reading the worker.

**There is no feature flag.** An earlier draft gated this on `READONLY_SANDBOX_ENABLED`, but the host path is deleted in this same task, so the flag's off-branch could only throw. A switch whose two positions are "work" and "fail every job" is a kill switch, not a rollout, and it would break all four job types on deploy until someone set an environment variable. The cutover is the change. Roll back by reverting the commit.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as tools from '../investigate-tools.js';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('read-only jobs no longer read the host', () => {
  it('exports no host reader and no lexical path guard', () => {
    expect(Object.keys(tools)).not.toContain('createHostReader');
    expect(Object.keys(tools)).not.toContain('safePath');
  });

  it('investigate-tools does not import the filesystem', () => {
    expect(src('investigate-tools.ts')).not.toMatch(/from 'node:fs/);
  });

  it('the quote checker no longer reads the host synchronously', () => {
    expect(src('investigate.ts')).not.toMatch(/readFileSync|statSync/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- readonly-isolation`
Expected: FAIL on all three

- [ ] **Step 3: Write minimal implementation**

**Where the checkout is created, and what it replaces.** Three of the four jobs receive `input.repoPath` rather than cloning themselves; the clone happens in `index.ts` where `cloneRepo` is called (`index.ts:644` for investigation). The checkout **replaces** that host clone for these four job types. It is not created alongside it: leaving `cloneRepo` in place would still copy customer code onto the shared worker, which is the entire thing this change exists to stop. Remove the `cloneRepo` call and its `cleanup` from each read-only job's dispatch path, and keep `cloneRepo` only where a host checkout is still genuinely needed, which is the fix job at `index.ts:1344`, where the diff is applied and the branch is pushed.

Two things the host clone currently produces must still be produced: `cloneResult.headSha` feeds `db.recordInvestigatedCommit`, and `cloneResult.defaultBranch` feeds `db.cacheProjectDefaultBranch`. Get both from inside the sandbox instead, with `git rev-parse HEAD` and `git symbolic-ref --short refs/remotes/origin/HEAD`, and return them on `ReadOnlyCheckout` as `headSha` and `defaultBranch`. Replace `repoPath: string` with `reader: RepoReader` on each job's input type:

- `investigate.ts` uses a local `repoPath` and `apiKey`; its call site is line 376.
- `inquiry/job.ts:166` uses `input.repoPath` and an `apiKey` read from the environment at line 160.
- `product-context/job.ts:379` uses `input.repoPath`.
- `friction/investigate-friction.ts:182` uses `input.repoPath` and an `apiKey` function parameter.

In `index.ts`, wrap each job dispatch:

```ts
const checkout = await createReadOnlyCheckout({
  repoUrl: buildRepoUrl(project.github_repo, githubToken),
  commitSha: evidence.frames.commitSha,
  githubToken,
  anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
});
try {
  await runInvestigation({ ...existing, reader: checkout.reader });
} catch (err: unknown) {
  // Convert here, where the checkout metadata is in scope. Task 6 depends on
  // this being the conversion point.
  throw toInfraError(err, checkout, evidence.record());
} finally {
  await checkout.close();
}
```

**`quoteAt` stays synchronous.** Making it async would cascade into `deriveOutcome` (`classify.ts:70`), whose `resolvePath` and `quoteAt` parameters are synchronous, and `deriveOutcome` is also called from `agent-fix.ts:973` in the fix pipeline, which this plan does not touch. Instead, prefetch. The model can only cite files it read, and `run.filesRead` already lists them, so fetch those files through the reader before calling `deriveOutcome` and let `quoteAt` read the Map:

```ts
/**
 * Fetch the files the model actually read, so the verbatim-quote check stays
 * synchronous. Async here would spread through deriveOutcome into agent-fix.ts,
 * which this change does not touch.
 */
/** One repository-relative POSIX form, so './src/a.ts' and 'src/a.ts' agree. */
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

const quoteCache = new Map<string, string | null>();
for (const cited of run.filesRead) {
  try {
    const text = await checkout.reader.readFile(cited);
    quoteCache.set(norm(cited), text.length > QUOTE_CHECK_MAX_FILE_BYTES ? null : text);
  } catch (err: unknown) {
    // A dead machine is not an ungrounded citation. Swallowing it here would
    // mark every quote unverifiable and terminalize a job that should retry.
    if (err instanceof MachineUnavailableError) throw err;
    quoteCache.set(norm(cited), null);
  }
}
const quoteAt = (resolved: string, line: number, quote: string): boolean => {
  const text = quoteCache.get(norm(resolved));
  return text != null && quoteWithinWindow(text, line, quote);
};
```

`resolveCited` currently calls `resolveInsideRepo(repoPath, cited)` against the host. Replace it with a lookup against `quoteCache` using the same `norm`, returning the normalized path when present and null otherwise: a file the model never read cannot ground a citation, which is the same rule the host version enforced.

Then delete `createHostReader`, `safePath`, and the `node:fs` imports from `investigate-tools.ts`, and `readFileSync`/`statSync` from `investigate.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src
git commit -m "feat(worker): read-only jobs read inside a sandbox, not on the host"
```

---

## Task 6: Machine failures reach the retry lane, with the machine identifier

**Files:**
- Modify: the four job files
- Modify: `packages/worker/src/harness/readonly-sandbox.ts`
- Test: `packages/worker/src/__tests__/readonly-isolation.test.ts`

**Interfaces:**
- Consumes: `MachineUnavailableError` (Task 4), `VerificationInfraError` (`harness/errors.js`).
- Produces: no new exports.

`MachineUnavailableError` escaping the agent is useless unless something converts it into the existing retry lane. `index.ts:408` already requeues a `VerificationInfraError` up to `max_attempts` and then writes `verification_infra_error`, so this task only has to route into it, and log the machine identifier and its age, which is the gap that made both August incidents unexplainable.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { MachineUnavailableError } from '../harness/readonly-sandbox.js';
import { VerificationInfraError } from '../harness/errors.js';
import { toInfraError } from '../harness/readonly-sandbox.js';

describe('toInfraError', () => {
  it('converts a machine failure into the existing infra retry lane', () => {
    const out = toInfraError(new MachineUnavailableError('gone', 'gone'), { sandboxId: 'sbx-1', createdAt: Date.now() - 5000 }, {} as never);
    expect(out).toBeInstanceOf(VerificationInfraError);
  });

  it('leaves an unrelated error alone so real bugs are not laundered as infra', () => {
    const bug = new TypeError('cannot read property of undefined');
    expect(toInfraError(bug, { sandboxId: 'sbx-1', createdAt: Date.now() }, {} as never)).toBe(bug);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- readonly-isolation`
Expected: FAIL, `toInfraError` is not exported

- [ ] **Step 3: Write minimal implementation**

```ts
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
```

**Where this is wired.** The conversion happens in `index.ts`, at the four dispatch sites where Task 5 put the `try`/`catch`/`finally` around each job, because that is the only scope holding both the `checkout` metadata and the job's evidence record. Do not try to convert inside the four job functions: Task 5 passes them only `reader`, so they have no `sandboxId` or `createdAt` to log.

Each of the four jobs builds its evidence record differently. Use whatever that dispatch site already has: investigation has an `evidence` bundle in scope, and the other three construct theirs at the point of failure. If a site has no evidence record available, pass an empty record rather than inventing one; `VerificationInfraError` requires the field but the retry lane does not read it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src
git commit -m "feat(worker): route machine failures to retry and log the machine identity"
```

---

## Task 7: Surface the new reason code on every customer surface

**Files:**
- Modify: `shared/` reason-code union
- Modify: `packages/dashboard/` incident rendering
- Modify: wherever the Slack card maps a reason code to copy
- Test: the existing tests for each

**Interfaces:**
- Consumes: nothing. This lands the reason code before Task 8 emits it, so Task 8 can build.
- Produces: no new exports.

A reason code that no surface renders shows the customer a blank or a fallback. This comes first so that Task 8, which raises the error, can compile against a union that already contains the code.

- [ ] **Step 1: Find every place reason codes are enumerated**

Run: `grep -rn "worker_runtime_error" shared packages/dashboard packages/ingestion --include=*.ts --include=*.vue --include=*.go | grep -v __tests__`
Expected: the list of surfaces to update

- [ ] **Step 2: Write the failing test**

Add a case to each surface's existing reason-code test asserting `dependency_install_failed` renders its own copy rather than a fallback.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm -r test`
Expected: FAIL on the new cases

- [ ] **Step 4: Add the reason code to each surface, then re-run**

Run: `pnpm -r build && pnpm -r test && (cd packages/ingestion && go build ./... && go test ./...)`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: render the dependency_install_failed reason on every surface"
```

---

## Task 8: Install failure stops the run

**Files:**
- Modify: `packages/worker/src/harness/sandbox-repo.ts:215-232`
- Modify: `packages/worker/src/harness/errors.ts` (add `DependencyInstallError` and `MachineUnavailableError` here, so both are importable without a cycle)
- Modify: `packages/worker/src/agent-fix.ts` (the outer catch, around line 1486)
- Test: `packages/worker/src/harness/__tests__/sandbox-repo.test.ts`

**Interfaces:**
- Consumes: `isCommandFailure` (Task 2).
- Produces:
  - `classifyInstallFailure(err: unknown): 'dependencies' | 'infrastructure'`
  - `class DependencyInstallError extends Error { readonly output: string }` exported from `harness/errors.js` (same module as `VerificationInfraError`, so no import cycle)

A clean install failure terminalizes on its first occurrence with reason `dependency_install_failed`. The retry-once refinement is out of scope, see Scope above.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { CommandExitError } from 'e2b';
import { classifyInstallFailure } from '../sandbox-repo.js';

const exit = (exitCode: number) =>
  new CommandExitError({ exitCode, stdout: '', stderr: '', error: undefined } as never);

describe('classifyInstallFailure', () => {
  it('calls a clean package-manager exit a dependency problem', () => {
    expect(classifyInstallFailure(exit(1))).toBe('dependencies');
  });
  it('calls a kill signal infrastructure', () => {
    expect(classifyInstallFailure(exit(137))).toBe('infrastructure');
    expect(classifyInstallFailure(exit(143))).toBe('infrastructure');
  });
  it('calls a dropped connection infrastructure', () => {
    expect(classifyInstallFailure(new Error('2: [unknown] terminated'))).toBe('infrastructure');
  });
  it('calls a blocked host infrastructure, not the customer\'s fault', () => {
    const err = new CommandExitError({
      exitCode: 1, stdout: '', stderr: 'request to https://cdn.example.com failed, reason: getaddrinfo ENOTFOUND',
      error: undefined,
    } as never);
    expect(classifyInstallFailure(err)).toBe('infrastructure');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- sandbox-repo`
Expected: FAIL, `classifyInstallFailure` is not exported

- [ ] **Step 3: Write minimal implementation**

```ts
/** Codes that mean something killed the process rather than it choosing to fail. */
const KILL_EXIT_CODES = new Set([137, 143]);

/**
 * Signatures that mean the network failed, not the dependency list.
 *
 * This matters because our own egress allowlist can cause them: a package that
 * fetches a binary from a host we do not allow produces an ordinary non-zero
 * npm exit. Blaming the customer's dependencies for our network policy would be
 * both wrong and unfixable by them.
 */
const NETWORK_FAILURE_SIGNATURES = [
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
  'network timeout', 'socket hang up', 'getaddrinfo',
];

export function classifyInstallFailure(err: unknown): 'dependencies' | 'infrastructure' {
  if (!isCommandFailure(err)) return 'infrastructure';
  const e = err as { exitCode?: number; stdout?: string; stderr?: string };
  if (KILL_EXIT_CODES.has(e.exitCode ?? 0)) return 'infrastructure';
  const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  if (NETWORK_FAILURE_SIGNATURES.some((sig) => output.includes(sig))) return 'infrastructure';
  return 'dependencies';
}
```

Replace the swallow at `sandbox-repo.ts:227`. Emit the operator alert, then raise: `infrastructure` raises `VerificationInfraError`; `dependencies` raises `DependencyInstallError` carrying `scrubSecrets(`${err.stdout}\n${err.stderr}`).slice(0, 2000)` (npm writes diagnostics to both streams). Do not continue in either case. In `agent-fix.ts`, add a branch before the generic handler that turns `DependencyInstallError` into a terminal `needs_human` with reason code `dependency_install_failed`, message naming the failure, and remediation "Check that your dependencies install cleanly on a fresh checkout."

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src
git commit -m "feat(worker): a failed install stops the run and says which kind it was"
```

---

## Task 9: Live verification against real E2B

**Files:**
- Create: `packages/worker/scripts/verify-isolation.ts`

**Interfaces:**
- Consumes: `Sandbox` from `e2b` directly, plus `buildReadOnlyNetwork` (Task 1) and `createSandboxReader` (Task 4).
- Produces: nothing importable.

The script does not go through `createReadOnlyCheckout`, which exposes no command runner or kill. It creates its own `Sandbox` with the same network policy, plants its own fixture with `sbx.files.write` and `sbx.commands.run`, wraps it with `createSandboxReader`, and calls `sbx.kill()` directly for check 5. Use any small public repository for the clone, for example `https://github.com/e2b-dev/e2b`.

Unit tests prove the code agrees with our reading of the library. This proves the library behaves as read. It is a script, not a CI test, because it costs real sandboxes.

- [ ] **Step 1: Write the script**

It must assert five things against a live sandbox, printing PASS or FAIL per line and exiting non-zero on any failure:

1. `curl https://api.anthropic.com/v1/models` from inside, with no key supplied, returns 200.
2. `env` inside the machine contains no variable matching `ANTHROPIC`.
3. `curl https://example.com` fails.
4. A symlink planted at `repo/src/evil.ts` pointing to `/etc/hostname` is refused by `reader.readFile('src/evil.ts')` with "path escapes the repository".
5. Killing the sandbox mid-run makes the next `reader.readFile` raise `MachineUnavailableError` with state `gone`.

- [ ] **Step 2: Run it**

Run: `E2B_API_KEY=... ANTHROPIC_API_KEY=... pnpm --filter @opslane/worker exec tsx scripts/verify-isolation.ts`
Expected: five PASS lines, exit 0

- [ ] **Step 3: Commit**

```bash
git add packages/worker/scripts/verify-isolation.ts
git commit -m "test(worker): live verification of sandbox isolation and egress"
```
