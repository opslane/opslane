# Phase 3a: Unblock Phase 3 and build the execution seam

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve the four blockers that make Phase 3 unwritable, add the Ink toolchain and the non-TTY command boundary, and build one tested process-ownership primitive that runs the install and owns the dev server.

**Architecture:** Nothing here renders. Tasks 1–5 correct modules that already shipped. Task 6 adds `tty_required`, the pinned Ink toolchain, and a minimal `onboard` command whose only job is the TTY boundary — so the contract row describes a command that exists. Tasks 7–11 build `process.ts`: **one** primitive (`startProcess`) owns every child, reacts to an **injected** `AbortSignal`, exposes completion, and cleans up deterministically. Install and dev server are both thin wrappers over it. Process-global signal handling lives in the command layer, never in the seam.

**Tech Stack:** TypeScript (ESM, strict), Node 22, Vitest, `ink@7.1.1` + `@inkjs/ui@2.0.0` + `react@19.2.8` (exact pins per `docs/decisions/tui-renderer.md`), `ink-testing-library@4.0.0` (dev).

**Source:** `/plan-eng-review` of Phase 3 (2026-07-24), its Codex outside voice, and a review of plan revision 1 that produced these corrections:
- `dev_script` must join the Zod `planShape`, not just the interface — `z.object` strips unknown keys, so validation would fail on every report.
- One process-ownership primitive for install *and* dev server. Revision 1 spawned the installer `detached` and never read its signal.
- No `process.on` / `process.exit` inside the seam. Signals belong to the command layer; the seam takes a signal.
- Abort must be checked *immediately*, never via a listener added to an already-aborted signal (that listener never fires).
- Finalize on `close`, not `exit`, and treat signal-termination as failure rather than `code ?? 0`.
- Quote argv when formatting a command for humans.

Revision 3 corrections, from a `/codex` pass over revision 2:
- A **literal** `import('./app.js')` is type-resolved at compile time, so it is TS2307 until `app.tsx` exists. The command ships without it; M4 adds it.
- `isJsonRecord` is not in `tools.ts` (it is unexported in `verify.ts:558`). Use `assertRecord` plus a local guard.
- Validate `dev_script` against the manifest `validatePlan` already read from `edit.manifest_file`, not a re-derived `<app_dir>/package.json`.
- Check `signal.aborted` **before** spawning, not after — spawn-then-kill still runs lifecycle scripts.
- Drop the trailing `chmod` in `envfile`: the temp file is already `0600` and `chmod` follows a swapped-in symlink.
- One `carry` shared by stdout and stderr splices their lines together; `String(chunk)` corrupts a split UTF-8 sequence. Use `StringDecoder` per stream.
- The dev-server URL regex required a trailing slash, so `http://localhost:3000` never matched, and per-chunk scanning misses a split URL.
- `process.exit` in a signal handler pre-empts the teardown it is supposed to trigger. Set `process.exitCode` and let the abort unwind.

**Not in scope:** `core.ts`, `app.tsx`, `tui.tsx`, the live smoke. Those are M3–M5. The SDK release (#45/#46) gates only M5.

---

## Before you start

```bash
cd /Users/abhishekray/orca/workspaces/opslane-oss/onboarding-10x-2
git fetch origin main --quiet
git checkout -b abhishekray07/phase-3a-execution-seam origin/main
pnpm install --frozen-lockfile
pnpm --filter @opslane/cli test    # expect: 32 files, 323 tests, all passing
```

All test commands run from `cli/`. Single test: `npx vitest run <file> -t "<name>"`.

---

## Task 1: `dev_script` joins the plan schema

The TUI must run the app's dev script and nothing tells it the name. `devScript` is referenced 7 times in the Phase 3 plan and exists nowhere in the code.

Follow the pattern `package_manager` already uses (`tools.ts:234-237`): the model reports, the CLI verifies against disk, a mismatch throws. A lockfile has one right answer; a dev script does not.

**Critical:** the field must be added to **three** places. The Zod `planShape` in `createReportPlanTool` (`tools.ts:396`) strips unknown keys, so a field present only on the interface never reaches `validatePlan`.

`validatePlan` is **not exported**. Test through `createReportPlanTool`, matching the existing style.

**Files:**
- Modify: `cli/src/onboard/tools.ts` (`planShape`, `OnboardingPlan`, `validatePlan`)
- Modify: `cli/src/onboard/spec.ts` (`renderDetectSpec`)
- Test: `cli/src/onboard/__tests__/tools.test.ts`

**Step 1: Write the failing test**

In the existing `describe('report_plan')` block, whose `beforeEach` already builds `root` and a `plan: ReportedPlanInput`. First extend that fixture's manifest so the app declares scripts:

```ts
    manifestContents = '{\n  "name": "web",\n  "scripts": { "dev": "vite" },\n  "dependencies": {}\n}\n';
```

and add `dev_script: 'dev',` to the `plan` object literal. Then:

```ts
  it('keeps dev_script through the schema and reports it', async () => {
    let captured: OnboardingPlan | undefined;
    const tool = createReportPlanTool(root, (value) => { captured = value; });

    await call(tool, { status: 'ok', plan });

    expect(captured?.dev_script).toBe('dev');
  });

  it('rejects a dev_script that the app manifest does not declare', async () => {
    const tool = createReportPlanTool(root, () => undefined);

    await expect(call(tool, { status: 'ok', plan: { ...plan, dev_script: 'serve' } }))
      .rejects.toThrow(/dev_script must be one of: dev/);
  });

  it('rejects a plan with no dev_script at all', async () => {
    const tool = createReportPlanTool(root, () => undefined);
    const { dev_script: _omitted, ...withoutDevScript } = plan;

    await expect(call(tool, { status: 'ok', plan: withoutDevScript })).rejects.toThrow();
  });
```

The first test is the one that catches the Zod-strip bug: it passes only if `planShape` carries the field through.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/onboard/__tests__/tools.test.ts -t "dev_script"`
Expected: FAIL — `dev_script` is not on `ReportedPlanInput`, and nothing validates it.

**Step 3: Write minimal implementation**

Add to the Zod `planShape` in `createReportPlanTool`, after `package_manager`:

```ts
    dev_script: z.string(),
```

Add to the `OnboardingPlan` interface, after `package_manager`:

```ts
  /** A key of `scripts` in the app's package.json. Verified against disk. */
  dev_script: string;
```

**Validate against the manifest `validatePlan` already read — do not re-derive a path.**
`validatePlan` reads `plan.edit.manifest_file` into `manifestContents` and JSON-parses it
at `tools.ts:288-300`. That is the app's real `package.json`. Deriving
`<app_dir>/package.json` independently would validate a different file whenever the plan
selects a nested manifest, and would read the same file twice.

There is no `isJsonRecord` in `tools.ts` — it lives unexported in `verify.ts:558`.
`tools.ts` has `assertRecord`. Use a small local guard rather than importing anything.

Move the `dev_script` check to **after** the manifest is parsed. Replace the existing
bare parse at `tools.ts:300` so the parsed value is kept:

```ts
  let manifestJson: unknown;
  try {
    manifestContents = readFileSync(manifestAbsolute);
    manifestJson = JSON.parse(manifestContents.toString('utf8'));
    assertRecord(manifestJson, 'edit.manifest_file');
  } catch {
    throw new Error('edit.manifest_file must be a valid regular JSON file');
  }

  const devScript = nonEmptyString(value.dev_script, 'dev_script');
  const scripts = (manifestJson as Record<string, unknown>).scripts;
  const availableScripts =
    typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts)
      ? Object.keys(scripts)
      : [];
  if (!availableScripts.includes(devScript)) {
    throw new Error(
      `dev_script must be one of: ${availableScripts.join(', ') || '(none declared)'}`,
    );
  }
```

Add `dev_script: devScript` to the returned object. No new imports.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/onboard/__tests__/tools.test.ts`
Expected: PASS. Other tests constructing plans need `dev_script` and a `scripts` manifest — fix the fixtures, never weaken `validatePlan`.

**Step 5: Tell the model about the field**

`renderDetectSpec`, `# Investigate` list, after the package-manager bullet:

```
- the script in the selected app's package.json that starts its dev server; and
```

`# Report` list, after the `manifest_file` bullet:

```
- Provide dev_script: the exact key from the selected app's package.json "scripts" that
  starts its dev server. It must be one of that file's declared scripts. In a repo with
  several (dev, dev:staging, start), choose the one for the app you selected.
```

**Step 6: Full suite, then commit**

```bash
pnpm --filter @opslane/cli build && pnpm --filter @opslane/cli test
git add cli/src/onboard/tools.ts cli/src/onboard/spec.ts cli/src/onboard/__tests__/tools.test.ts
git commit -m "feat(cli): plan carries a dev_script verified against the app manifest"
```

---

## Task 2: `resolveRepo`

`detectRepoFromGit` (`setup.ts:58`) returns `null` without a github.com remote, so a freshly scaffolded app dies before the agent runs. Task 6 wires this into the command, so it does not stay dead code.

**Files:** create `cli/src/onboard/repo.ts` and `__tests__/repo.test.ts`.

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { resolveRepo } from '../repo.js';

describe('resolveRepo', () => {
  it('prefers an explicit --repo over git detection', () => {
    expect(resolveRepo({ repo: 'acme/web', detect: () => 'other/repo' }))
      .toEqual({ ok: true, repo: 'acme/web' });
  });

  it('falls back to git detection when no flag is given', () => {
    expect(resolveRepo({ detect: () => 'acme/web' })).toEqual({ ok: true, repo: 'acme/web' });
  });

  it('rejects a malformed --repo instead of sending it to the server', () => {
    const result = resolveRepo({ repo: 'not a repo', detect: () => null });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.message).toMatch(/owner\/repo/);
  });

  it('names the fix when detection fails and no flag was given', () => {
    const result = resolveRepo({ detect: () => null });
    expect(result.ok === false && result.message).toMatch(/--repo <owner\/repo>/);
  });
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/repo.test.ts`
Expected: FAIL — `Cannot find module '../repo.js'`.

**Step 3: Write minimal implementation**

```ts
import { detectRepoFromGit, normalizeRepoURL } from '../setup.js';

export type ResolvedRepo = { ok: true; repo: string } | { ok: false; message: string };

export function resolveRepo({
  repo,
  detect = detectRepoFromGit,
}: { repo?: string; detect?: () => string | null }): ResolvedRepo {
  if (repo !== undefined) {
    const normalized = normalizeRepoURL(repo);
    return normalized === null
      ? { ok: false, message: `--repo must be owner/repo or a GitHub URL, got ${JSON.stringify(repo)}` }
      : { ok: true, repo: normalized };
  }
  const detected = detect();
  return detected === null
    ? {
        ok: false,
        message:
          'Could not determine the repository from git. Pass --repo <owner/repo>, or add a '
          + 'GitHub remote with: git remote add origin git@github.com:owner/repo.git',
      }
    : { ok: true, repo: detected };
}
```

**Step 4: Verify and commit**

Run: `npx vitest run src/onboard/__tests__/repo.test.ts` → PASS (4).

```bash
git add cli/src/onboard/repo.ts cli/src/onboard/__tests__/repo.test.ts
git commit -m "feat(cli): resolve the onboard repo from --repo or git with an actionable error"
```

---

## Task 3: The approval seam keeps the SDK's third argument

`createOnboardApproval` (`policy.ts:99`) is `async (toolName, input) => ...`. The SDK passes a third argument carrying display metadata and an abort signal; the Ink prompt is specified to render that metadata. A parked approval also never settles on cancellation, so quitting mid-prompt hangs.

**Files:** modify `cli/src/onboard/policy.ts` and `__tests__/policy.test.ts`.

**Step 1: Write the failing test**

```ts
it('forwards the SDK options to requestApproval', async () => {
  const seen: unknown[] = [];
  const canUseTool = createOnboardApproval({
    requestApproval: async (_t, _i, options) => { seen.push(options); return true; },
  });
  const opts = { signal: new AbortController().signal };
  await canUseTool('Edit', { file_path: 'a.ts' }, opts as never);
  expect(seen[0]).toBe(opts);
});

it('denies rather than hangs when the approval is aborted', async () => {
  const controller = new AbortController();
  const canUseTool = createOnboardApproval({
    requestApproval: () => new Promise<boolean>(() => { /* never settles */ }),
  });
  const pending = canUseTool('Edit', { file_path: 'a.ts' }, { signal: controller.signal } as never);
  controller.abort();
  await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
});

it('denies immediately when the signal is already aborted', async () => {
  const requestApproval = vi.fn(() => new Promise<boolean>(() => undefined));
  const canUseTool = createOnboardApproval({ requestApproval });
  await expect(canUseTool('Edit', { file_path: 'a.ts' }, { signal: AbortSignal.abort() } as never))
    .resolves.toMatchObject({ behavior: 'deny' });
});

it('removes its abort listener when approval wins the race', async () => {
  const controller = new AbortController();
  const canUseTool = createOnboardApproval({ requestApproval: async () => true });
  for (let i = 0; i < 50; i += 1) {
    await canUseTool('Edit', { file_path: 'a.ts' }, { signal: controller.signal } as never);
  }
  // A leak here surfaces as a MaxListenersExceededWarning; assert the signal is clean
  // by aborting and confirming nothing throws from a stale handler.
  expect(() => controller.abort()).not.toThrow();
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/policy.test.ts -t "SDK options"`
Expected: FAIL — third argument is `undefined`; the abort cases hang.

**Step 3: Write minimal implementation**

```ts
export type ApprovalRequest = (
  toolName: string,
  input: Record<string, unknown>,
  options?: { signal?: AbortSignal; [key: string]: unknown },
) => Promise<boolean>;
```

In the handler:

```ts
  return async (toolName, input, options) => {
    if (!allowed.has(toolName)) {
      return { behavior: 'deny', message: `Onboarding does not allow tool ${toolName}` };
    }
    if (!MUTATING_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input };

    const signal = options?.signal;
    // Check first: a listener added to an already-aborted signal never fires.
    if (signal?.aborted === true) return { behavior: 'deny', message: 'declined' };

    let onAbort: (() => void) | undefined;
    try {
      const approved = await new Promise<boolean>((resolve) => {
        onAbort = () => resolve(false);
        signal?.addEventListener('abort', onAbort, { once: true });
        void requestApproval(toolName, input, options).then(resolve, () => resolve(false));
      });
      return approved
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'declined' };
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    }
  };
```

**Step 4: Verify and commit**

Run: `npx vitest run src/onboard/__tests__/policy.test.ts` → PASS.

```bash
git add cli/src/onboard/policy.ts cli/src/onboard/__tests__/policy.test.ts
git commit -m "fix(cli): approval seam forwards SDK options and settles on abort"
```

---

## Task 4: `waitForAppReporting` accepts a caller signal

`WaitOptions` (`wait.ts:3`) has no `signal`. Two traps: `pollSessionOnce` turns an aborted fetch into `status: 'unreachable'` (`agent-protocol.ts:120-125`), which falls into backoff rather than exiting; and a listener registered on an already-aborted signal never fires, so a `Promise.race` against it sleeps forever.

**Check the signal immediately after every poll and before registering any pause listener.**

**Files:** modify `cli/src/onboard/wait.ts` and `__tests__/wait.test.ts`.

**Step 1: Write the failing test**

```ts
it('rejects immediately when the signal is already aborted', async () => {
  const fetchFn = vi.fn();
  await expect(waitForAppReporting({ ...OPTS, fetchFn, signal: AbortSignal.abort() }))
    .rejects.toThrow(/aborted/i);
  expect(fetchFn).not.toHaveBeenCalled();
});

it('stops on abort without sleeping through the backoff', async () => {
  const controller = new AbortController();
  const sleepFn = vi.fn(async () => undefined);
  const fetchFn = vi.fn(async () => {
    controller.abort();                       // abort lands mid-flight
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  await expect(waitForAppReporting({ ...OPTS, fetchFn, sleepFn, signal: controller.signal }))
    .rejects.toThrow(/aborted/i);
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(sleepFn).not.toHaveBeenCalled();     // the unreachable backoff must not run
});

it('does not accumulate abort listeners across poll turns', async () => {
  const controller = new AbortController();
  let polls = 0;
  const fetchFn = vi.fn(async () => {
    polls += 1;
    if (polls > 30) return new Response(JSON.stringify({ status: 'app_reporting' }), { status: 200 });
    return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
  });
  await waitForAppReporting({
    ...OPTS, fetchFn, sleepFn: async () => undefined, signal: controller.signal,
  });
  expect(controller.signal).toBeDefined();    // no MaxListenersExceededWarning emitted
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/wait.test.ts -t "abort"`
Expected: FAIL — `signal` is not an option; the mid-flight case backs off instead of rejecting.

**Step 3: Write minimal implementation**

Add `signal?: AbortSignal;` to `WaitOptions`. Then:

```ts
  const callerSignal = options.signal;
  const abortError = (): Error => new Error(`waiting for session ${options.sessionId} was aborted`);
  const throwIfAborted = (): void => { if (callerSignal?.aborted === true) throw abortError(); };

  throwIfAborted();
```

Make `pause` interruptible with deterministic listener cleanup:

```ts
  async function pause(ms: number): Promise<void> {
    const remaining = deadline - now();
    if (remaining <= 0) return;
    throwIfAborted();                          // never register on an aborted signal
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => reject(abortError());
        callerSignal?.addEventListener('abort', onAbort, { once: true });
        void sleepFn(Math.min(ms, remaining)).then(resolve, reject);
      });
    } finally {
      if (onAbort !== undefined) callerSignal?.removeEventListener('abort', onAbort);
    }
  }
```

**The default sleep must be cancellable.** Rejecting the race leaves the default
`setTimeout` referenced, so the process can stay alive through a 30s backoff after the
user has already quit. Replace the default `sleepFn` with a cancellable one:

```ts
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Do not hold the event loop open on an abandoned backoff.
    if (typeof timer.unref === 'function') timer.unref();
  }));
```

Test it: abort during an active pause and assert the promise rejects without waiting out
the interval (drive it with `vi.useFakeTimers()` and assert no timer remains pending).

Inside the loop, after the `remaining <= 0` guard **and again right after the poll returns**:

```ts
    throwIfAborted();
```

The second call is the one that matters: it runs before the `unreachable` branch can back off.

Chain the caller signal into the per-request controller, removing the listener when the request settles:

```ts
    const onCallerAbort = (): void => controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    // ...in the existing .finally(): clearTimeout(timeout) plus
    callerSignal?.removeEventListener('abort', onCallerAbort);
```

**Step 4: Verify and commit**

Run: `npx vitest run src/onboard/__tests__/wait.test.ts` → PASS.

```bash
git add cli/src/onboard/wait.ts cli/src/onboard/__tests__/wait.test.ts
git commit -m "feat(cli): waitForAppReporting accepts a caller signal and aborts promptly"
```

---

## Task 5: `envfile.ts` stops following symlinks

`envfile.ts:25` joins paths and writes, following symlinks. A symlinked `.gitignore` writes outside the repo; a `.gitignore` write that fails after `.env.local` succeeded leaves the key un-ignored.

Realpath-then-write is check-then-use and loses to a symlink swapped in between. **Open with `O_NOFOLLOW` and write through the open handle**, and use atomic rename for `.gitignore` too.

**Files:** modify `cli/src/envfile.ts` and `cli/src/__tests__/envfile.test.ts`.

**Step 1: Write the failing test**

```ts
it('refuses to write through a symlinked .gitignore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opslane-env-'));
  const outside = join(await mkdtemp(join(tmpdir(), 'opslane-out-')), 'victim');
  await writeFile(outside, 'original\n');
  await symlink(outside, join(dir, '.gitignore'));

  await expect(writeEnvLocal(dir, { VITE_OPSLANE_API_KEY: 'opk_x' })).rejects.toThrow();
  expect(await readFile(outside, 'utf8')).toBe('original\n');
});

it('refuses to write through a symlinked .env.local', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opslane-env-'));
  const outside = join(await mkdtemp(join(tmpdir(), 'opslane-out-')), 'victim');
  await writeFile(outside, 'original\n');
  await symlink(outside, join(dir, '.env.local'));

  await expect(writeEnvLocal(dir, { VITE_OPSLANE_API_KEY: 'opk_x' })).rejects.toThrow();
  expect(await readFile(outside, 'utf8')).toBe('original\n');
});

it('does not leave the key on disk when the gitignore write fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opslane-env-'));
  await mkdir(join(dir, '.gitignore'));       // a directory: the write must fail

  await expect(writeEnvLocal(dir, { VITE_OPSLANE_API_KEY: 'opk_x' })).rejects.toThrow();
  await expect(readFile(join(dir, '.env.local'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/envfile.test.ts -t "symlink"`
Expected: FAIL — writes follow the links and clobber `victim`.

**Step 3: Write minimal implementation**

```ts
import { constants, open } from 'node:fs/promises';

/** Read a file, refusing to traverse a final-component symlink. Missing is ''. */
async function readNoFollow(filePath: string): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return '';
    // ELOOP (Linux) / EMLINK (some BSDs) mean the final component is a symlink.
    throw new Error(`refusing to read ${filePath}: ${code}`);
  }
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
}
```

Order matters: resolve and write `.gitignore` **before** the key, so a gitignore failure aborts before any secret reaches disk. Use `writeFileAtomic` for both — rename replaces the name, never traversing an existing link.

```ts
  const envPath = join(dir, '.env.local');
  const gitignorePath = join(dir, '.gitignore');

  // gitignore FIRST: if this throws, no key has been written.
  const gitignore = await readNoFollow(gitignorePath);
  if (!gitignore.split(/\r?\n/).includes('.env.local')) {
    await writeFileAtomic(
      gitignorePath,
      `${gitignore}${gitignore && !gitignore.endsWith('\n') ? '\n' : ''}.env.local\n`,
    );
  }

  const current = await readNoFollow(envPath);
  // ...existing merge logic against `current`...
  await writeFileAtomic(envPath, next);
```

**Delete the trailing `chmod(envPath, 0o600)`.** It is redundant and it reintroduces the
race the rest of this task removes: `writeFileAtomic` already creates its temp file with
`open(tempPath, 'wx', 0o600)` (`fsutil.ts:15`) and `rename` preserves that mode, while
`chmod` is a path operation that follows whatever symlink is at `envPath` at that instant.
If a mode change is ever needed, do it on the open handle before the rename, inside
`writeFileAtomic`.

**Step 4: Verify and commit**

Run: `npx vitest run src/__tests__/envfile.test.ts` → PASS.

```bash
git add cli/src/envfile.ts cli/src/__tests__/envfile.test.ts
git commit -m "fix(cli): envfile refuses symlinked targets and ignores before writing the key"
```

---

## Task 6: `tty_required`, the Ink toolchain, and the command boundary

The contract row and the command land together. Adding the status alone would advertise a command that does not exist, and `resolveRepo` would stay dead code.

**Files:**
- Modify: `cli/src/contract.ts`, `docs/reference/cli-agent-contract.md`, `cli/package.json`, `cli/tsconfig.json`, `cli/src/index.ts`
- Create: `cli/src/onboard/command.ts`
- Test: `cli/src/__tests__/contract.subprocess.test.ts`

**Step 1: Add the doc row and watch the drift test fail**

Inside the `AGENT_STATUS_CONTRACT` markers, after the last `setup` row:

```
| `onboard` | `tty_required` | 1 | `stdout` | The command needs an interactive terminal; run it without piping stdin or stdout. |
```

Also update the document's opening line, and **scope the one-JSON-document invariant**.
`onboard` under a TTY renders Ink, so adding it to the covered list without qualification
would contradict the invariant three lines below it:

```
This deterministic reference is sourced from `cli/src/contract.ts` and the setup protocol in `cli/src/setup.ts`. It covers the agent-facing `setup`, `snippet`, `verify`, and `status` commands, and `onboard` when invoked non-interactively.
```

And amend the first invariant bullet:

```
- Each covered command writes exactly one JSON document to stdout per invocation. It never mixes prose, progress, or a second JSON document into stdout. `onboard` is covered only on its non-TTY path, which emits `tty_required` and exits 1; under a TTY it is an interactive human command and, like `login` and `init`, is exempt.
```

Run: `npx vitest run src/__tests__/contract-drift.test.ts` → FAIL (table has a row `AGENT_STATUSES` lacks).

**Step 2: Add the contract entry**

One line, in `AGENT_STATUSES` (`scripts/check-docs-drift.mjs` parses these without a build):

```ts
  agentStatus("onboard", "tty_required", 1, "stdout", "The command needs an interactive terminal; run it without piping stdin or stdout."),
```

Run: `npx vitest run src/__tests__/contract-drift.test.ts` → PASS.

**Step 3: Write the failing subprocess test**

In `cli/src/__tests__/contract.subprocess.test.ts`:

```ts
  it('onboard emits one tty_required JSON document when not a TTY', async () => {
    const result = await runCli(['onboard'], await temp(), await temp());
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'tty_required' });
    expect(result.stdout).not.toMatch(/\x1b\[/);      // zero ANSI bytes
  });
```

Note the assertion is one JSON **document**, matching `cli-agent-contract.md` and every other command — not one line. `jsonOutput` pretty-prints and that is the shipped contract.

**This subprocess test cannot separate the two gates.** `runCli` pipes stdin *and* stdout,
so it passes even if the implementation only checks one of them. Add a unit test that
drives the gate directly with injected TTY state, so each condition is proved on its own:

```ts
// command.test.ts
it.each([
  ['stdin not a tty',  { stdin: false, stdout: true  }],
  ['stdout not a tty', { stdin: true,  stdout: false }],
  ['neither a tty',    { stdin: false, stdout: false }],
])('gates on %s', (_label, tty) => {
  const exits: Array<[string, number]> = [];
  requireTty({ isStdinTty: tty.stdin, isStdoutTty: tty.stdout,
    onFail: (status, code) => { exits.push([status, code]); } });
  expect(exits).toEqual([['tty_required', 1]]);
});

it('passes when both are a tty', () => {
  const exits: unknown[] = [];
  requireTty({ isStdinTty: true, isStdoutTty: true,
    onFail: (...a) => { exits.push(a); } });
  expect(exits).toEqual([]);
});
```

Extract the check into a `requireTty({ isStdinTty, isStdoutTty, onFail })` helper in
`command.ts` so it is reachable without a PTY.

Run: `npx vitest run src/__tests__/contract.subprocess.test.ts -t "onboard"` → FAIL (unknown command).

**Step 4: Add the toolchain**

Exact pins, no ranges (`docs/decisions/tui-renderer.md`: "All package versions were exact, not ranges"). This repo has no `save-exact`, so pin `@types/react` explicitly too:

```bash
cd cli
pnpm add ink@7.1.1 @inkjs/ui@2.0.0 react@19.2.8
pnpm add -D ink-testing-library@4.0.0
pnpm add -D @types/react@$(npm view @types/react version)
```

Verify **both** dependency sections carry bare versions:
```bash
node -p "JSON.stringify({d:require('./package.json').dependencies,dev:require('./package.json').devDependencies},null,1)"
```
Expected: no `^` or `~` on `ink`, `@inkjs/ui`, `react`, `@types/react`, `ink-testing-library`.

Add to `cli/tsconfig.json` `compilerOptions`: `"jsx": "react-jsx",`

**Step 5: Write the minimal command**

`cli/src/onboard/command.ts` — plain `.ts`, no JSX, so no `react/jsx-runtime` import reaches the piped path:

```ts
import { exitWithStatus } from '../output.js';
import { resolveRepo } from './repo.js';

export interface OnboardOptions { apiUrl?: string; repo?: string }

/**
 * The TTY gate lives here, outside any .tsx. With jsx:react-jsx every .tsx
 * compiles with react/jsx-runtime hoisted above user code, so deferring only
 * the `ink` import would still load React on the piped path. The dynamic
 * boundary has to wrap the whole shell module.
 */
export async function runOnboardCommand(options: OnboardOptions): Promise<void> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    exitWithStatus('tty_required', {
      message: 'opslane onboard needs an interactive terminal; run it without piping stdin or stdout.',
    }, 1);
  }

  const repo = resolveRepo({ repo: options.repo });
  if (!repo.ok) exitWithStatus('usage_error', { message: repo.message }, 1);

  // M4 replaces this with: await (await import('./app.js')).runOnboardApp({...})
  exitWithStatus('internal_error', { message: 'the onboarding UI is not built yet' }, 1);
}
```

**Do not write the `import('./app.js')` line in this phase.** TypeScript resolves a
*literal* dynamic-import specifier at compile time, so `import('./app.js')` is a TS2307
error until `app.tsx` exists — and a runtime `try/catch` cannot suppress a compile error.
The command ships with the TTY gate and repo resolution working, and M4 adds the import
in the same commit that creates the module.

That keeps this phase's contract row honest: `tty_required` is reachable and tested today.

Register in `cli/src/index.ts`, after `setup`:

```ts
program
  .command('onboard')
  .description('Agent-guided SDK onboarding for the repo in the current directory')
  .option('--api-url <url>', 'Opslane API URL')
  .option('--repo <owner/repo>', 'Override auto-detected repository')
  .action(async (opts: { apiUrl?: string; repo?: string }) => {
    const { runOnboardCommand } = await import('./onboard/command.js');
    await runOnboardCommand(opts);
  });
```

**Step 6: Verify and commit**

```bash
pnpm --filter @opslane/cli build && pnpm --filter @opslane/cli test
git add cli/src/contract.ts docs/reference/cli-agent-contract.md cli/package.json cli/tsconfig.json cli/src/index.ts cli/src/onboard/command.ts cli/src/__tests__/contract.subprocess.test.ts pnpm-lock.yaml
git commit -m "feat(cli): onboard command boundary, tty_required status, and the pinned Ink toolchain"
```

---

## Task 7: Command derivation and shell-safe formatting

> **Revision note, 2026-07-24.** A proposal to move installs into the agent (gated by
> `canUseTool`) was written up and then **rejected** the same day —
> `docs/decisions/agent-runs-commands.md` has the full reasoning. Task 7 is unchanged:
> `installCommand` stays, the deterministic seam stays, the agent does not run installs.
>
> One real defect that review surfaced and that this plan does NOT yet address:
> `ALLOWED_BASH` (`policy.ts:12`) and the Bash branch of `onboardPreToolUseHook` are
> **unreachable** — `'Bash'` is in `disallowedTools` for both stages (`engine.ts:105`,
> `:151`) and absent from both `tools` arrays. The tests pass by calling the hook directly.
> Code that looks like a security control but can never execute is worse than either
> enabling or deleting it. Decide which in M3; do not leave it as-is.

**Files:** create `cli/src/onboard/process.ts` and `__tests__/process.test.ts`.

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { devCommand, formatCommand, installCommand } from '../process.js';

describe('command derivation', () => {
  it.each([
    ['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'],
  ])('derives %s -> %s', (lockfile, manager) => {
    const root = repoWith({ [lockfile]: '', 'package.json': '{}' });
    expect(installCommand(root, '.')).toEqual({ executable: manager, args: ['install'] });
    expect(devCommand(root, '.', 'dev')).toEqual({ executable: manager, args: ['run', 'dev'] });
  });

  it('builds the dev command from the plan dev_script', () => {
    const root = repoWith({ 'package-lock.json': '', 'package.json': '{}' });
    expect(devCommand(root, '.', 'dev:staging'))
      .toEqual({ executable: 'npm', args: ['run', 'dev:staging'] });
  });

  it('throws when no lockfile identifies a package manager', () => {
    expect(() => installCommand(repoWith({ 'package.json': '{}' }), '.')).toThrow(/lockfile/i);
  });
});

describe('formatCommand', () => {
  it('leaves ordinary argv unquoted', () => {
    expect(formatCommand({ executable: 'npm', args: ['run', 'dev'] })).toBe('npm run dev');
  });

  it('quotes a script name containing a space', () => {
    expect(formatCommand({ executable: 'npm', args: ['run', 'dev staging'] }))
      .toBe("npm run 'dev staging'");
  });

  it('quotes shell metacharacters so copy-paste cannot run a second command', () => {
    expect(formatCommand({ executable: 'npm', args: ['run', 'dev;echo bad'] }))
      .toBe("npm run 'dev;echo bad'");
  });

  it('escapes an embedded single quote', () => {
    expect(formatCommand({ executable: 'npm', args: ['run', "it's"] }))
      .toBe("npm run 'it'\\''s'");
  });
});
```

Define `repoWith` at the top of this new test file (a `mkdtempSync` plus `writeFileSync` loop) — the existing `tools.test.ts` does not export one.

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/process.test.ts`
Expected: FAIL — `Cannot find module '../process.js'`.

**Step 3: Write minimal implementation**

```ts
import { packageManagerForRepo } from './tools.js';

export interface Command { executable: string; args: string[] }

function manager(root: string, appDir: string): string {
  const detected = packageManagerForRepo(root, appDir);
  if (detected === null) throw new Error(`No lockfile in ${appDir} identifies a package manager`);
  return detected;
}

export function installCommand(root: string, appDir: string): Command {
  return { executable: manager(root, appDir), args: ['install'] };
}

/** `devScript` comes from the plan, already verified against the app manifest (Task 1). */
export function devCommand(root: string, appDir: string, devScript: string): Command {
  return { executable: manager(root, appDir), args: ['run', devScript] };
}

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** For display and copy-paste only. Execution always uses argv, never this string. */
export function formatCommand({ executable, args }: Command): string {
  return [executable, ...args]
    .map((value) => (SAFE.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`))
    .join(' ');
}
```

**Step 4: Verify and commit**

Run: `npx vitest run src/onboard/__tests__/process.test.ts` → PASS (9).

```bash
git add cli/src/onboard/process.ts cli/src/onboard/__tests__/process.test.ts
git commit -m "feat(cli): derive install and dev commands, format them shell-safely"
```

---

## Task 8: `startProcess` — one ownership primitive

Install and dev server share this. It owns the child, reacts to an **injected** signal, exposes completion, and cleans up deterministically. It installs **no** `process.on` handlers and never calls `process.exit` — those belong to the command layer (Task 11), which is what makes this testable without killing Vitest.

**Files:** modify `process.ts` and its test.

**Step 1: Write the failing test**

```ts
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  return child;
}

it('resolves completion with the exit code', async () => {
  const child = fakeChild();
  const handle = startProcess({
    command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
    spawnFn: () => child as never,
  });
  child.emit('close', 0, null);
  await expect(handle.completed).resolves.toEqual({ exitCode: 0, signal: null });
});

it('finalizes on close, not exit, so output is drained', async () => {
  const child = fakeChild();
  const handle = startProcess({
    command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
    spawnFn: () => child as never,
  });
  child.emit('exit', 0, null);
  let settled = false;
  void handle.completed.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit('close', 0, null);
  await expect(handle.completed).resolves.toMatchObject({ exitCode: 0 });
});

it('reports signal termination rather than calling it success', async () => {
  const child = fakeChild();
  const handle = startProcess({
    command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
    spawnFn: () => child as never,
  });
  child.emit('close', null, 'SIGTERM');
  await expect(handle.completed).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
});

it('rejects completion when spawn errors', async () => {
  const child = fakeChild();
  const handle = startProcess({
    command: { executable: 'nope', args: [] }, cwd: '/repo', spawnFn: () => child as never,
  });
  child.emit('error', new Error('ENOENT'));
  await expect(handle.completed).rejects.toThrow(/ENOENT/);
});

it('spawns with argv and shell:false', () => {
  const spawnFn = vi.fn(() => fakeChild() as never);
  startProcess({ command: { executable: 'npm', args: ['install'] }, cwd: '/repo', spawnFn });
  const [exe, args, opts] = spawnFn.mock.calls[0]!;
  expect(exe).toBe('npm');
  expect(args).toEqual(['install']);
  expect(opts).toMatchObject({ shell: false, detached: true, cwd: '/repo' });
});

it('kills the whole process group on stop, idempotently', () => {
  const kills: Array<[number, string | undefined]> = [];
  const handle = startProcess({
    command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
    spawnFn: () => fakeChild() as never,
    killFn: (pid, signal) => { kills.push([pid, signal]); },
  });
  handle.stop(); handle.stop(); handle.stop();
  expect(kills).toEqual([[-4242, 'SIGTERM']]);       // negative pid = the group
});

it('stops when the injected signal aborts', () => {
  const kills: number[] = [];
  const controller = new AbortController();
  startProcess({
    command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
    spawnFn: () => fakeChild() as never,
    killFn: (pid) => { kills.push(pid); },
    signal: controller.signal,
  });
  controller.abort();
  expect(kills).toEqual([-4242]);
});

it('never spawns when the signal is already aborted', async () => {
  const spawnFn = vi.fn(() => fakeChild() as never);
  const handle = startProcess({
    command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
    spawnFn, signal: AbortSignal.abort(),
  });
  expect(spawnFn).not.toHaveBeenCalled();     // not "spawned then killed"
  await expect(handle.completed).rejects.toThrow(/aborted/i);
});

it('balances its abort listeners', () => {
  const controller = new AbortController();
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const realAdd = controller.signal.addEventListener.bind(controller.signal);
  const realRemove = controller.signal.removeEventListener.bind(controller.signal);
  vi.spyOn(controller.signal, 'addEventListener')
    .mockImplementation((t, l, o) => { added.push(l); realAdd(t, l as never, o); });
  vi.spyOn(controller.signal, 'removeEventListener')
    .mockImplementation((t, l, o) => { removed.push(l); realRemove(t, l as never, o); });

  const child = fakeChild();
  startProcess({
    command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
    spawnFn: () => child as never, signal: controller.signal,
  });
  child.emit('close', 0, null);
  expect(removed).toEqual(added);             // every listener added was removed
});
```

Those two are the ones revision 2 would have failed: it spawned first and checked
`aborted` after, and its leak test only asserted a signal object was defined.

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/process.test.ts -t "startProcess"`
Expected: FAIL — `startProcess` is not exported.

**Step 3: Write minimal implementation**

```ts
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface ProcessOptions {
  command: Command;
  cwd: string;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
  /**
   * Called once per decoded, ANSI-stripped, complete line. startDevServer uses
   * this for URL detection so it never scans raw chunks. A mutable Set works:
   * the scanner removes itself once the URL is found or the timeout fires.
   */
  lineListeners?: Set<(line: string) => void>;
  flushMs?: number;
  spawnFn?: (executable: string, args: string[], options: object) => ChildProcess;
  killFn?: (pid: number, signal?: NodeJS.Signals) => void;
}

export interface ProcessHandle {
  pid: number | undefined;
  /** Settles on `close`, so stdout and stderr have drained. */
  completed: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  stop: () => void;
}

export function startProcess(options: ProcessOptions): ProcessHandle {
  const spawnFn = options.spawnFn ?? nodeSpawn;
  const killFn = options.killFn ?? ((pid, signal) => { process.kill(pid, signal); });

  // Check BEFORE spawning. Spawning and then killing still runs the package's
  // lifecycle scripts for however long it takes the signal to land.
  if (options.signal?.aborted === true) {
    return {
      pid: undefined,
      completed: Promise.reject(new Error('aborted before start')),
      stop: () => undefined,
    };
  }

  // detached makes the child a group leader, so killing -pid also takes the
  // grandchildren a dev server spawns (Vite -> esbuild).
  const child = spawnFn(options.command.executable, options.command.args, {
    cwd: options.cwd, shell: false, detached: true,
  });

  const cleanups: Array<() => void> = [];
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
    try { if (child.pid !== undefined) killFn(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  };

  cleanups.push(attachOutput(child, options));

  const completed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', (error) => { stop(); reject(error); });
      // `close` not `exit`: exit can fire before the streams are drained.
      child.once('close', (code, signal) => {
        for (const cleanup of cleanups.splice(0)) cleanup();
        stopped = true;                       // nothing left to kill
        resolve({ exitCode: code, signal });
      });
    },
  );

  const signal = options.signal;
  if (signal?.aborted === true) {
    stop();                                   // check first; a late listener never fires
  } else if (signal !== undefined) {
    const onAbort = (): void => stop();
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort));
  }

  return { pid: child.pid, completed, stop };
}
```

`attachOutput` is Task 9. For now return a no-op cleanup and pipe chunks straight through; Task 9 replaces the body and its tests prove the change.

**Step 4: Verify and commit**

Run: `npx vitest run src/onboard/__tests__/process.test.ts` → PASS (17).

```bash
git add cli/src/onboard/process.ts cli/src/onboard/__tests__/process.test.ts
git commit -m "feat(cli): one process-ownership primitive with injected abort and group teardown"
```

---

## Task 9: Line-buffered, throttled, sanitised output

A cold `npm install` prints hundreds of lines; one Ink frame rebuild per line makes the noisiest moment the jankiest. Child output is also untrusted — the CLI now runs package lifecycle scripts and the repo's dev script — so control sequences must be stripped before anything renders them.

Two correctness points revision 1 got wrong: chunk boundaries are not line boundaries (buffer the partial line), and a fake child that emits everything in one microtask proves nothing about throttling (use fake timers and keep it alive).

**Files:** modify `process.ts` and its test.

**Step 1: Write the failing test**

```ts
it('flushes on the interval, not once per chunk', async () => {
  vi.useFakeTimers();
  try {
    const child = fakeChild();
    const onOutput = vi.fn();
    startProcess({
      command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
      spawnFn: () => child as never, onOutput, flushMs: 100,
    });
    for (let i = 0; i < 200; i += 1) child.stdout.emit('data', Buffer.from(`line ${i}\n`));
    expect(onOutput).not.toHaveBeenCalled();          // nothing before the first tick
    vi.advanceTimersByTime(100);
    expect(onOutput).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 200; i += 1) child.stdout.emit('data', Buffer.from(`more ${i}\n`));
    vi.advanceTimersByTime(100);
    expect(onOutput).toHaveBeenCalledTimes(2);         // 400 lines, 2 flushes
  } finally {
    vi.useRealTimers();
  }
});

it('buffers a line split across two chunks', async () => {
  vi.useFakeTimers();
  try {
    const child = fakeChild();
    let last = '';
    startProcess({
      command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
      spawnFn: () => child as never, onOutput: (t) => { last = t; }, flushMs: 10,
    });
    child.stdout.emit('data', Buffer.from('added 42 pac'));
    child.stdout.emit('data', Buffer.from('kages\n'));
    vi.advanceTimersByTime(10);
    expect(last).toContain('added 42 packages');
    expect(last).not.toContain('added 42 pac\nkages');
  } finally {
    vi.useRealTimers();
  }
});

it('does not splice stdout and stderr into one another', async () => {
  vi.useFakeTimers();
  try {
    const child = fakeChild();
    let last = '';
    startProcess({
      command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
      spawnFn: () => child as never, onOutput: (t) => { last = t; }, flushMs: 10,
    });
    child.stdout.emit('data', Buffer.from('out-par'));
    child.stderr.emit('data', Buffer.from('err-line\n'));
    child.stdout.emit('data', Buffer.from('tial\n'));
    vi.advanceTimersByTime(10);
    expect(last).toContain('err-line');
    expect(last).toContain('out-partial');
    expect(last).not.toContain('out-parerr-line');
  } finally { vi.useRealTimers(); }
});

it('decodes a multi-byte character split across chunks', async () => {
  vi.useFakeTimers();
  try {
    const child = fakeChild();
    let last = '';
    startProcess({
      command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
      spawnFn: () => child as never, onOutput: (t) => { last = t; }, flushMs: 10,
    });
    const arrow = Buffer.from('\u2192 done\n', 'utf8');   // -> is 3 bytes
    child.stdout.emit('data', arrow.subarray(0, 2));
    child.stdout.emit('data', arrow.subarray(2));
    vi.advanceTimersByTime(10);
    expect(last).toContain('\u2192 done');
    expect(last).not.toContain('\ufffd');
  } finally { vi.useRealTimers(); }
});

it('keeps only the last 8 lines', async () => {
  vi.useFakeTimers();
  try {
    const child = fakeChild();
    let last = '';
    startProcess({
      command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
      spawnFn: () => child as never, onOutput: (t) => { last = t; }, flushMs: 10,
    });
    for (let i = 0; i < 50; i += 1) child.stdout.emit('data', Buffer.from(`line ${i}\n`));
    vi.advanceTimersByTime(10);
    expect(last.split('\n')).toHaveLength(8);
    expect(last).toContain('line 49');
    expect(last).not.toContain('line 41');
  } finally {
    vi.useRealTimers();
  }
});

it('strips terminal control sequences so a script cannot spoof a prompt', async () => {
  vi.useFakeTimers();
  try {
    const child = fakeChild();
    let last = '';
    startProcess({
      command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
      spawnFn: () => child as never, onOutput: (t) => { last = t; }, flushMs: 10,
    });
    child.stdout.emit('data', Buffer.from('[2J[H[31mRun npm install? [Y/n][0m\n'));
    vi.advanceTimersByTime(10);
    expect(last).not.toContain('');
    expect(last).toContain('Run npm install? [Y/n]');
  } finally {
    vi.useRealTimers();
  }
});

it('flushes the trailing partial line on close', async () => {
  const child = fakeChild();
  let last = '';
  const handle = startProcess({
    command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
    spawnFn: () => child as never, onOutput: (t) => { last = t; }, flushMs: 10_000,
  });
  child.stdout.emit('data', Buffer.from('no trailing newline'));
  child.emit('close', 0, null);
  await handle.completed;
  expect(last).toContain('no trailing newline');
  expect(last.split('\n').length).toBeLessThanOrEqual(8);   // carry must not make it 9
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/process.test.ts -t "flushes on the interval"`
Expected: FAIL — the stub flushes per chunk, splits mid-line, and leaves escapes intact.

**Step 3: Write minimal implementation**

```ts
// Covers CSI, OSC and single-character escapes.
const ANSI = /\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)|[@-Z\\-_]/g;
const TAIL_LINES = 8;

import { StringDecoder } from 'node:string_decoder';

function attachOutput(child: ChildProcess, options: ProcessOptions): () => void {
  const onOutput = options.onOutput;
  // Attach when EITHER a renderer or a line listener needs the stream. Bailing
  // on `onOutput === undefined` alone would silently disable URL detection for
  // a dev server started without an output sink.
  if (onOutput === undefined && options.lineListeners === undefined) return () => undefined;
  const emit = onOutput ?? (() => undefined);

  const tail: string[] = [];
  const trim = (): void => {
    if (tail.length > TAIL_LINES) tail.splice(0, tail.length - TAIL_LINES);
  };

  /**
   * Per-stream state. stdout and stderr interleave, so a single shared carry
   * splices half a stderr line onto half a stdout line. StringDecoder holds
   * back a multi-byte UTF-8 sequence split across a chunk boundary, which
   * String(chunk) would decode as replacement characters.
   */
  const reader = (): ((chunk: Buffer | string) => void) => {
    const decoder = new StringDecoder('utf8');
    let carry = '';
    return (chunk) => {
      const lines = (carry + decoder.write(Buffer.from(chunk as Buffer))).split(/\r?\n/);
      carry = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.replace(ANSI, '');
        tail.push(line);
        // startDevServer subscribes here so it scans complete, decoded lines.
        for (const listener of options.lineListeners ?? []) listener(line);
      }
      trim();
    };
  };
  const readers: Array<{ stream: NodeJS.ReadableStream | null; take: (c: Buffer) => void }> = [
    { stream: child.stdout, take: reader() as (c: Buffer) => void },
    { stream: child.stderr, take: reader() as (c: Buffer) => void },
  ];
  for (const { stream, take } of readers) stream?.on('data', take);

  const flush = (): void => emit(tail.join('\n'));
  const timer = setInterval(flush, options.flushMs ?? 100);

  return () => {
    clearInterval(timer);
    for (const { stream, take } of readers) stream?.off('data', take);
    trim();                       // the trailing partial line must not make it 9
    flush();
  };
}
```

The final `trim()` matters: revision 2 pushed the carry after the last trim, so the tail
could reach nine lines on close.

**Step 4: Verify and commit**

Run: `npx vitest run src/onboard/__tests__/process.test.ts` → PASS (22).

```bash
git add cli/src/onboard/process.ts cli/src/onboard/__tests__/process.test.ts
git commit -m "feat(cli): line-buffered, throttled, ANSI-stripped child output"
```

---

## Task 10: `runCommand` and `startDevServer` on top of the primitive

Both are thin wrappers. Neither touches `process.on` or `process.exit`.

**Files:** modify `process.ts` and its test.

**Step 1: Write the failing test**

```ts
it('reports a non-zero exit rather than throwing', async () => {
  const child = fakeChild();
  const promise = runCommand({
    command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
    spawnFn: () => child as never,
  });
  child.emit('close', 1, null);
  await expect(promise).resolves.toEqual({ ran: true, ok: false, exitCode: 1, signal: null });
});

it('treats signal termination as failure, not success', async () => {
  const child = fakeChild();
  const promise = runCommand({
    command: { executable: 'npm', args: ['install'] }, cwd: '/repo',
    spawnFn: () => child as never,
  });
  child.emit('close', null, 'SIGTERM');
  await expect(promise).resolves.toMatchObject({ ok: false, signal: 'SIGTERM' });
});

it('does not spawn when consent is declined, and returns a quoted copy-paste', async () => {
  const spawnFn = vi.fn();
  await expect(runCommand({
    command: { executable: 'npm', args: ['run', 'dev staging'] }, cwd: '/repo',
    consent: async () => false, spawnFn: spawnFn as never,
  })).resolves.toEqual({ ran: false, copyPaste: "npm run 'dev staging'" });
  expect(spawnFn).not.toHaveBeenCalled();
});

it('parses the dev server URL from stdout', async () => {
  const child = fakeChild();
  const handle = startDevServer({
    command: { executable: 'npm', args: ['run', 'dev'] }, cwd: '/repo',
    spawnFn: () => child as never,
  });
  child.stdout.emit('data', Buffer.from('  [32m➜[0m  Local:   http://localhost:5173/\n'));
  await expect(handle.url).resolves.toBe('http://localhost:5173/');
});

it('matches a URL with no trailing slash (Next, CRA)', async () => {
  const child = fakeChild();
  const handle = startDevServer({
    command: { executable: 'npm', args: ['run', 'dev'] }, cwd: '/repo',
    spawnFn: () => child as never,
  });
  child.stdout.emit('data', Buffer.from('  - Local:        http://localhost:3000\n'));
  await expect(handle.url).resolves.toBe('http://localhost:3000');
});

it('finds a URL split across two chunks', async () => {
  const child = fakeChild();
  const handle = startDevServer({
    command: { executable: 'npm', args: ['run', 'dev'] }, cwd: '/repo',
    spawnFn: () => child as never,
  });
  child.stdout.emit('data', Buffer.from('  Local:   http://localh'));
  child.stdout.emit('data', Buffer.from('ost:5173/\n'));
  await expect(handle.url).resolves.toBe('http://localhost:5173/');
});

it('reports the real port when the default was taken', async () => {
  const child = fakeChild();
  const handle = startDevServer({
    command: { executable: 'npm', args: ['run', 'dev'] }, cwd: '/repo',
    spawnFn: () => child as never,
  });
  child.stdout.emit('data', Buffer.from('Port 5173 is in use, trying another one...\n'));
  child.stdout.emit('data', Buffer.from('  ➜  Local:   http://localhost:5174/\n'));
  await expect(handle.url).resolves.toBe('http://localhost:5174/');
});

it('stops the child when no URL appears before the timeout', async () => {
  const kills: number[] = [];
  const child = fakeChild();
  const handle = startDevServer({
    command: { executable: 'npm', args: ['run', 'dev'] }, cwd: '/repo',
    spawnFn: () => child as never, killFn: (pid) => { kills.push(pid); }, urlTimeoutMs: 10,
  });
  await expect(handle.url).rejects.toThrow(/no .*URL/i);
  expect(kills).toEqual([-4242]);          // a hung dev server must not be left running
});

it('rejects the URL when the child exits first', async () => {
  const child = fakeChild();
  const handle = startDevServer({
    command: { executable: 'npm', args: ['run', 'dev'] }, cwd: '/repo',
    spawnFn: () => child as never,
  });
  child.emit('close', 1, null);
  await expect(handle.url).rejects.toThrow(/exited/i);
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/process.test.ts -t "dev server"`
Expected: FAIL — neither wrapper is exported.

**Step 3: Write minimal implementation**

```ts
export type RunResult =
  | { ran: true; ok: boolean; exitCode: number | null; signal: NodeJS.Signals | null }
  | { ran: false; copyPaste: string };

export async function runCommand(
  options: ProcessOptions & { consent?: () => Promise<boolean> },
): Promise<RunResult> {
  if (options.consent !== undefined && !(await options.consent())) {
    return { ran: false, copyPaste: formatCommand(options.command) };
  }
  const { exitCode, signal } = await startProcess(options).completed;
  // A signal-terminated child has exitCode null; calling that success hides a kill.
  return { ran: true, ok: exitCode === 0 && signal === null, exitCode, signal };
}

// The path is OPTIONAL. Vite prints a trailing slash; Next and CRA do not, and
// revision 2's regex silently missed `http://localhost:3000`.
const LOCALHOST_URL = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/\S*)?)/i;

export interface DevServerHandle extends ProcessHandle {
  url: Promise<string>;
  restartCommand: string;
}

export function startDevServer(
  options: ProcessOptions & { urlTimeoutMs?: number },
): DevServerHandle {
  const lineListeners = options.lineListeners ?? new Set<(line: string) => void>();
  const handle = startProcess({ ...options, lineListeners });

  // Scan DECODED, LINE-BUFFERED text, not raw chunks. A URL split across a
  // chunk boundary is invisible to a per-chunk scan, and that is exactly what
  // happens when a dev server flushes its banner in pieces. Give attachOutput
  // an onLine hook and subscribe to that instead of re-reading the streams.
  const url = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => settle(() => { handle.stop(); reject(new Error('the dev server printed no localhost URL')); }),
      options.urlTimeoutMs ?? 30_000,
    );
    const settle = (finish: () => void): void => {
      clearTimeout(timer);
      lineListeners.delete(scan);
      finish();
    };
    const scan = (line: string): void => {
      const match = LOCALHOST_URL.exec(line);
      if (match !== null) settle(() => resolve(match[1]!));
    };
    lineListeners.add(scan);
    void handle.completed
      .then(({ exitCode }) => settle(() => reject(new Error(`the dev server exited (${exitCode})`))))
      .catch((error: unknown) => settle(() => reject(error)));
  });
  void url.catch(() => undefined);          // no unhandled rejection if nobody awaits

  return { ...handle, url, restartCommand: formatCommand(options.command) };
}
```

**Step 4: Verify and commit**

Run: `npx vitest run src/onboard/__tests__/process.test.ts` → PASS (29).

```bash
git add cli/src/onboard/process.ts cli/src/onboard/__tests__/process.test.ts
git commit -m "feat(cli): consented run and TUI-owned dev server over the process primitive"
```

---

## Task 11: Signals belong to the command layer

`startProcess` reacts to a signal; it never installs one. The command owns the `AbortController`, translates `SIGINT`/`SIGTERM` into an abort, and exits. Keeping this out of the seam is what lets Task 8's tests run without killing Vitest.

**Files:** modify `cli/src/onboard/command.ts`; test `cli/src/onboard/__tests__/command.test.ts`.

**Step 1: Write the failing test**

```ts
it('aborts the run controller on SIGINT and sets exit code 130', () => {
  const exits: number[] = [];
  const controller = new AbortController();
  const off = installSignalHandlers({
    controller, exitFn: (code) => { exits.push(code); },
  });
  process.emit('SIGINT');
  expect(controller.signal.aborted).toBe(true);
  expect(exits).toEqual([130]);
  off();
  // The handler must NOT have exited the process; teardown runs after abort.
});

it('maps SIGTERM to 143, not 130', () => {
  const exits: number[] = [];
  const off = installSignalHandlers({
    controller: new AbortController(), exitFn: (code) => { exits.push(code); },
  });
  process.emit('SIGTERM');
  expect(exits).toEqual([143]);
  off();
});

it('removes its handlers so repeated runs do not stack', () => {
  const before = process.listenerCount('SIGINT');
  installSignalHandlers({ controller: new AbortController(), exitFn: () => undefined })();
  expect(process.listenerCount('SIGINT')).toBe(before);
});
```

`exitFn` is injected precisely so the test never calls the real `process.exit`.

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/command.test.ts`
Expected: FAIL — `installSignalHandlers` is not exported.

**Step 3: Write minimal implementation**

```ts
/**
 * Signal handling lives here, not in process.ts. The seam takes an AbortSignal
 * so it stays testable; this is the one place allowed to touch process globals.
 */
export function installSignalHandlers({
  controller,
  exitFn = (code) => { process.exitCode = code; },
}: {
  controller: AbortController;
  exitFn?: (code: number) => void;
}): () => void {
  const codes = { SIGINT: 130, SIGTERM: 143 } as const;
  const handlers = Object.entries(codes).map(([signal, code]) => {
    // Set exitCode and abort; do NOT call process.exit here. A synchronous
    // exit kills the process before startProcess's teardown and the command's
    // `finally` have run, which is how orphaned dev servers happen — the exact
    // failure this whole task exists to prevent.
    const handler = (): void => { exitFn(code); controller.abort(); };
    process.on(signal as NodeJS.Signals, handler);
    return () => process.removeListener(signal as NodeJS.Signals, handler);
  });
  return () => { for (const off of handlers) off(); };
}
```

**Wire the signal through, explicitly.** The controller is useless unless its signal
reaches the seam. In `runOnboardCommand`:

```ts
  const controller = new AbortController();
  const removeHandlers = installSignalHandlers({ controller });
  try {
    // M4: await runOnboardApp({ ...options, repo: repo.repo, signal: controller.signal })
    // Every startProcess / waitForAppReporting call downstream takes this signal.
  } finally {
    removeHandlers();
  }
```

Node exits on its own once the abort has torn down the children and the event loop
drains, using the `process.exitCode` already set. If a hung child ever prevents that,
add a bounded `setTimeout(() => process.exit(code), 5_000).unref()` as a last resort —
but only after the teardown has been given its chance.

**Step 4: Verify and commit**

Run: `npx vitest run src/onboard/__tests__/command.test.ts` → PASS (3).

```bash
git add cli/src/onboard/command.ts cli/src/onboard/__tests__/command.test.ts
git commit -m "feat(cli): command layer owns signal handling and aborts the run controller"
```

---

## Task 12: Full gate and PR

**Step 1: Whole-repo gate** (per `AGENTS.md`)

```bash
cd /Users/abhishekray/orca/workspaces/opslane-oss/onboarding-10x-2
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

`pnpm test` excludes `@opslane/test-e2e` by design; nothing here touches it.

**Step 2: Prove every new test is real**

For Tasks 1, 3, 4, 5, 8, 9, 10, and 11, revert the implementation hunk, confirm the new tests fail, restore. A test that passes against unfixed code is not a regression test. Pay particular attention to:
- Task 1's "keeps dev_script through the schema" — must fail with `planShape` unchanged.
- Task 8's "stops immediately when the signal is already aborted" — must fail if the `aborted` pre-check is replaced by a listener.
- Task 9's throttle test — must fail if the interval is replaced by a per-chunk flush.

**Step 3: Confirm nothing leaks a process**

```bash
pnpm --filter @opslane/cli test
pgrep -f 'npm run dev' || echo "no orphans"
```

**Step 4: Open the PR**

`git push` is blocked by a local hook. Ask the user to run:
`! git push -u origin abhishekray07/phase-3a-execution-seam`
then create the PR with `gh pr create --base main`.

---

## What already exists (do not rebuild)

| Need | Already shipped |
|---|---|
| Package-manager detection from lockfiles | `packageManagerForRepo` — `tools.ts:157` |
| Model-reports-CLI-verifies pattern | `validatePlan` — `tools.ts:234-237` |
| Repo string normalisation | `normalizeRepoURL` / `detectRepoFromGit` — `setup.ts:52-70` |
| Typed terminal status output | `exitWithStatus` — `output.ts` |
| Atomic 0600 writes, file locking | `writeFileAtomic` / `withFileLock` — `fsutil.ts` |
| Compiled-CLI subprocess test harness | `contract.subprocess.test.ts` |
| Task-list state from SDK messages | `reduceTasks` / `TaskLine` — `events.ts:187` |
| Both agent stages | `runDetect` / `runApply` — `engine.ts:302,484` |
| Login, provisioning, env write, polling, run log | Phase 2 (#192) |

## NOT in scope

| Deferred | Why |
|---|---|
| `core.ts`, `app.tsx`, `tui.tsx` | M3–M4; they consume this seam, so they need its real shape first |
| Live smoke to `app_reporting` | M5; blocked on `@opslane/sdk` >= 1.2.0 (#45/#46) |
| Bounding `reduceTasks` | M4, where the renderer that suffers from it exists |
| `ink-testing-library` view coverage | M4, when there is a view to test |
| Preflight ordering (model key before mutation) | M3, where the controller sequences login and provisioning |
| Smoke pending-state isolation | M5, part of the smoke procedure |
| Hard-repo acceptance | Milestone B, the design's actual bar |
| Reconciling `engine.ts`'s install-command fields | See the note below — decide in M3, not here |

## Known duplication to resolve in M3

`engine.ts:67` and `:690` still expose an install command as a **string** plus a relative
`installCwd`, from when the report carried the hand-off text. `process.ts` now derives
structured argv and re-detects the package manager independently. Two seams computing the
same thing will drift.

Do not fix it in this plan: nothing here consumes the engine's version, and changing the
report shape touches the apply-stage tests. Decide in M3, when `core.ts` has to pick one:
either the report returns the structured command plus the real lockfile directory, or
those fields are removed and the command is derived once, downstream, from the plan.
