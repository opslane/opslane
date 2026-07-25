# Phase 3b: the onboarding controller and its Ink shell

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `opslane onboard` work end to end in a terminal: survey the repo, ask one question, wire the SDK, run the install and dev server behind consent, and confirm the app reported.

**Architecture:** A pure `runOnboardCore(deps)` holds every decision with all effects injected, so it is unit-testable with no TTY, no model, and no network. Task 3 builds the whole flow skeleton — including the terminal try/catch/finally — so every later task adds a branch inside a shape that already works. `app.tsx` is the only run-and-observe file: it wires real Ink into the core. `tui.tsx` is a pure view. `command.ts` already owns the TTY gate, repo resolution, and signals.

**Tech Stack:** TypeScript (ESM, strict), Node 22, Vitest, `ink@7.1.1` + `@inkjs/ui@2.0.0` + `react@19.2.8` + `ink-testing-library@4.0.0` (installed and pinned in Phase 3a).

**Builds on:** Phase 3a (`process.ts`, `command.ts`, `repo.ts`, `dev_script`, abort-safe seams). Phases 1/1b (`runDetect`/`runApply`). Phase 2 (`ensureLoggedIn`, `ensureProvisioned`, `writeEnvLocal`, `waitForAppReporting`, `createRunLog`).

**Revision 2** — rewritten after a `/codex` pass on revision 1 found 30 defects. The ones that reshaped it:
- `runDetect` returns `{ok:false, reason:'unsupported'}` and **discards** the agent's explanation (`engine.ts:364`). Revision 1 branched on a `subtype` that does not exist. Task 1 now surfaces the reason first.
- `createOnboardApproval`'s **default** allow-set does include `Bash`; the engine overrides it with a Bash-free list (`engine.ts:636`). Revision 1 had this backwards.
- `ApplyReport.installRequired` is `false` on the already-onboarded path (`engine.ts:580`). Revision 1 always installed.
- Revision 1's Task 2 test required Tasks 3-6, and Tasks 5-6 needed Task 7's error handling. Ordering is now dependency-correct.
- `startDevServer` takes no consent option, so "both commands behind consent" was false.

**Not in scope:** the live smoke (M5), blocked on `@opslane/sdk >= 1.2.0` reaching npm (#45/#46). Milestone B. Giving the agent a shell — rejected, see `docs/decisions/agent-runs-commands.md`.

---

## Before you start

```bash
cd /Users/abhishekray/orca/workspaces/opslane-oss/onboarding-10x-2
git fetch origin main --quiet
git checkout -b abhishekray07/phase-3b-controller-tui
pnpm install --frozen-lockfile
pnpm --filter @opslane/cli test    # expect 381 passing
```

All test commands run from `cli/`. Single test: `npx vitest run <file> -t "<name>"`.

---

## Task 1: Surface the unsupported reason

When the agent decides a repo has no web app it calls `report_plan` with a concrete reason. `runDetect` captures it into `unsupportedReason` and then throws it away, returning only `{ok:false, reason:'unsupported'}` (`engine.ts:364`). The controller has nothing to show the user beyond the word "unsupported".

**Files:**
- Modify: `cli/src/onboard/engine.ts` (`EngineResult`, the unsupported return)
- Test: `cli/src/onboard/__tests__/engine.test.ts`

**Step 1: Write the failing test**

In the detect-stage describe block:

```ts
  it('returns the agent explanation when the repo is unsupported', async () => {
    const result = await runDetect({
      cwd: root, signal: new AbortController().signal,
      onMessage: () => undefined, onPlan: () => undefined,
      queryFn: unsupportedQuery('this repository has no web application'),
    });
    expect(result).toMatchObject({
      ok: false, reason: 'unsupported',
      unsupportedReason: 'this repository has no web application',
    });
  });
```

Use whatever fake `queryFn` helper the neighbouring detect tests already use to drive `report_plan` with `status: 'unsupported'`.

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/engine.test.ts -t "unsupported"`
Expected: FAIL — `unsupportedReason` is undefined.

**Step 3: Write minimal implementation**

Add to `EngineResult`:

```ts
export interface EngineResult {
  ok: boolean;
  aborted: boolean;
  subtype?: string;
  reason?: string;
  /** The agent's own explanation, when `reason === 'unsupported'`. */
  unsupportedReason?: string;
}
```

And carry it through:

```ts
  if (unsupportedReason !== undefined) {
    return { ...core, ok: false, reason: 'unsupported', unsupportedReason };
  }
```

**Step 4: Run to verify it passes**

Run: `npx vitest run src/onboard/__tests__/engine.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add cli/src/onboard/engine.ts cli/src/onboard/__tests__/engine.test.ts
git commit -m "feat(cli): detect result carries the agent's unsupported reason"
```

---

## Task 2: Deny Bash outright

`ALLOWED_BASH` (`policy.ts:12`) and the `Bash` branch of `onboardPreToolUseHook` cannot execute: `'Bash'` is in `disallowedTools` for both stages (`engine.ts:105`, `:151`). `policy.test.ts` passes by calling the hook directly.

**Precise state, since revision 1 got it wrong:** `createOnboardApproval`'s *default* `allowedTools` includes `'Bash'` (`policy.ts:107`), but `runApply` overrides it with `['Read','Edit','Write','mcp__onboard__finish_apply']` (`engine.ts:636`). So the default is stale, not live. Removing `'Bash'` from it changes the denial message for any direct caller of the default — which is why the existing test at `policy.test.ts:123` must be updated too.

Giving the agent a shell was considered and rejected (`docs/decisions/agent-runs-commands.md`), so delete rather than wire.

**Step 1: Write the failing test**

Replace the "allows only exact package build, typecheck, or lint scripts through Bash" case:

```ts
  it('denies Bash outright: the agent has no shell', async () => {
    for (const command of ['pnpm run build', 'pnpm run lint', 'npm install', 'echo hi']) {
      expect(denied(await run(hook(), 'Bash', { command }))).toBe(true);
    }
  });
```

Then find the existing assertion at `policy.test.ts:123` that expects a `declined` denial for Bash through `createOnboardApproval`'s default, and update it to expect `does not allow tool Bash`.

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/policy.test.ts -t "no shell"`
Expected: FAIL — `pnpm run build` is currently permitted.

**Step 3: Write minimal implementation**

Delete `ALLOWED_BASH`. Replace the Bash branch:

```ts
    if (toolName === 'Bash') {
      // The agent has no shell. Both stages also list Bash in disallowedTools
      // and runApply passes a Bash-free allow-set, so this is defence in depth.
      // docs/decisions/agent-runs-commands.md records why a shell was rejected.
      return deny('The onboarding agent is not allowed to run shell commands');
    }
```

Remove `'Bash'` from `createOnboardApproval`'s default `allowedTools`.

**Step 4: Run to verify it passes**

Run: `npx vitest run src/onboard/__tests__/policy.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git commit -am "fix(cli): deny Bash outright instead of an unreachable allowlist"
```

---

## Task 3: `runOnboardCore` skeleton — contract, terminal handling, run-log discipline

Build the **whole shape** now, with one stub step, so no later task depends on error handling that does not exist yet.

**Files:**
- Create: `cli/src/onboard/core.ts`
- Test: `cli/src/onboard/__tests__/core.test.ts`

**The contract.** Every effect injected. Nothing imports `ink`, touches a TTY, or calls a model.

```ts
export type Stage =
  | 'login' | 'provision' | 'detect' | 'awaiting-approval' | 'apply'
  | 'writing-env' | 'installing' | 'starting-dev' | 'waiting'
  | 'done' | 'failed' | 'unsupported' | 'aborted';

export interface CoreEvent {
  stage: Stage;
  tasks?: TaskLine[];
  question?: { question: string; options: string[]; multi: boolean };
  plan?: OnboardingPlan;
  url?: string;
  output?: string;
  message?: string;
}

export interface CoreDeps {
  cwd: string;
  repo: string;
  apiUrl: string;
  tokenPath: string;
  signal: AbortSignal;
  loginFn: () => Promise<void>;
  ensureLoggedIn: typeof import('./provision.js').ensureLoggedIn;
  ensureProvisioned: typeof import('./provision.js').ensureProvisioned;
  runDetect: typeof import('./engine.js').runDetect;
  runApply: typeof import('./engine.js').runApply;
  requestApproval: ApprovalRequest;
  askUser: AskUserResolver;
  confirm: (prompt: string, command: string) => Promise<boolean>;
  writeEnv: typeof import('../envfile.js').writeEnvLocal;
  runCommand: typeof import('./process.js').runCommand;
  startDevServer: typeof import('./process.js').startDevServer;
  waitForAppReporting: typeof import('./wait.js').waitForAppReporting;
  runLog: RunLog;
  emit: (event: CoreEvent) => void;
}

export interface CoreResult {
  ok: boolean;
  status: 'completed' | 'unsupported' | 'failed' | 'aborted';
  message?: string;
  url?: string;
}
```

**Step 1: Write the failing test**

```ts
it('emits exactly one terminal stage on success', async () => {
  const events: CoreEvent[] = [];
  await expect(runOnboardCore(deps({ emit: (e) => events.push(e) })))
    .resolves.toMatchObject({ ok: true, status: 'completed' });
  const terminal = events.filter((e) =>
    ['done', 'failed', 'unsupported', 'aborted'].includes(e.stage));
  expect(terminal).toHaveLength(1);
  expect(terminal[0]!.stage).toBe('done');
});

it('emits failed as the terminal stage when a step throws', async () => {
  const events: CoreEvent[] = [];
  await runOnboardCore(deps({ emit: (e) => events.push(e),
    ensureProvisioned: async () => { throw new Error('boom') } }));
  expect(events.at(-1)!.stage).toBe('failed');
});

it('emits aborted, not failed, when the signal is already aborted', async () => {
  const controller = new AbortController();
  const events: CoreEvent[] = [];
  await runOnboardCore(deps({
    signal: controller.signal, emit: (e) => events.push(e),
    ensureProvisioned: async () => { controller.abort(); throw new Error('cancelled'); },
  }));
  expect(events.at(-1)!.stage).toBe('aborted');
});

it('records the session id and registers the api key as a secret', async () => {
  const setSessionId = vi.fn(async () => undefined);
  const addSecret = vi.fn();
  await runOnboardCore(deps({ runLog: { ...fakeRunLog(), setSessionId, addSecret } }));
  expect(addSecret).toHaveBeenCalledWith('opk_test');
  expect(setSessionId).toHaveBeenCalledWith('sess-1');
});

it('finishes the run log exactly once, even when a step throws', async () => {
  const finish = vi.fn(async () => undefined);
  await runOnboardCore(deps({
    runLog: { ...fakeRunLog(), finish },
    ensureProvisioned: async () => { throw new Error('boom'); },
  }));
  expect(finish).toHaveBeenCalledTimes(1);
});

it('drains queued run-log records before finishing', async () => {
  const order: string[] = [];
  const runLog = {
    ...fakeRunLog(),
    record: async () => { await delay(5); order.push('record'); },
    finish: async () => { order.push('finish'); },
  };
  await runOnboardCore(deps({ runLog }));
  expect(order.at(-1)).toBe('finish');
  expect(order.filter((o) => o === 'record').length).toBeGreaterThan(0);
});

it('never leaks a stack trace into the result message', async () => {
  const result = await runOnboardCore(deps({
    ensureProvisioned: async () => { throw new Error('ENOENT: no such file'); },
  }));
  expect(result.message).not.toMatch(/\bat \w+ \(/);
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/core.test.ts`
Expected: FAIL — `Cannot find module '../core.js'`.

**Step 3: Write minimal implementation**

```ts
export async function runOnboardCore(deps: CoreDeps): Promise<CoreResult> {
  const { emit, signal } = deps;

  // Records are fire-and-forget from the caller's view but must not outlive
  // `finish`, and a rejection must never become an unhandled rejection.
  let logChain: Promise<void> = Promise.resolve();
  const record = (message: unknown): void => {
    logChain = logChain.then(() => deps.runLog.record(message)).catch(() => undefined);
  };

  let outcome: CoreResult;
  try {
    outcome = await runFlow(deps, record);
  } catch (error) {
    outcome = signal.aborted
      ? { ok: false, status: 'aborted' }
      : { ok: false, status: 'failed', message: messageOf(error) };
  } finally {
    await logChain;                                   // drain before finishing
  }

  // Exactly one terminal event, mapped straight from the status.
  const TERMINAL = { completed: 'done', failed: 'failed', unsupported: 'unsupported', aborted: 'aborted' } as const;
  emit({ stage: TERMINAL[outcome.status], message: outcome.message, url: outcome.url });
  await deps.runLog.finish({ outcome: outcome.status }).catch(() => undefined);
  return outcome;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

`runFlow` for now:

```ts
  emit({ stage: 'login' });
  const tokens = await deps.ensureLoggedIn({
    apiUrl: deps.apiUrl, tokenPath: deps.tokenPath, loginFn: deps.loginFn,
  });

  emit({ stage: 'provision' });
  const provision = await deps.ensureProvisioned({
    apiUrl: deps.apiUrl, repo: deps.repo, token: tokens.accessToken,
  });
  // Both are required before any message is recorded in full mode: the key and
  // poll token must be redactable, and the log needs the server join key.
  deps.runLog.addSecret(provision.apiKey);
  deps.runLog.addSecret(provision.pollToken);
  await deps.runLog.setSessionId(provision.sessionId);

  return { ok: true, status: 'completed' };   // Tasks 4-8 replace this tail
```

**No terminal event is emitted inside `runFlow`** — that is the wrapper's job. Login stays
*inside* core so it is covered by the same error handling and the same abort; Task 11 gives
the shell a `loginFn` that unmounts Ink first so the authorization URL prints to a clean
stdout.

**Step 4: Run to verify it passes**

Run: `npx vitest run src/onboard/__tests__/core.test.ts`
Expected: PASS (5 tests).

**Step 5: Commit**

```bash
git add cli/src/onboard/core.ts cli/src/onboard/__tests__/core.test.ts
git commit -m "feat(cli): onboarding controller skeleton with one terminal event and drained logs"
```

---

## Task 4: Detect — plan, unsupported, failure, and the question

**Step 1: Write the failing test**

```ts
it('stops with the agent explanation when the repo is unsupported', async () => {
  const d = deps({
    runDetect: async () => ({ ok: false, aborted: false, reason: 'unsupported',
      unsupportedReason: 'this repository has no web application' }),
  });
  await expect(runOnboardCore(d)).resolves.toMatchObject({
    ok: false, status: 'unsupported',
    message: 'this repository has no web application',
  });
});

it('never writes env or polls when detect fails', async () => {
  const writeEnv = vi.fn();
  const waitForAppReporting = vi.fn();
  const d = deps({
    runDetect: async () => ({ ok: false, aborted: false, reason: 'no_plan' }),
    writeEnv, waitForAppReporting,
  });
  await expect(runOnboardCore(d)).resolves.toMatchObject({ ok: false, status: 'failed' });
  expect(writeEnv).not.toHaveBeenCalled();
  expect(waitForAppReporting).not.toHaveBeenCalled();
});

it('forwards the human answer back to the agent', async () => {
  let answer: string[] | undefined;
  const d = deps({
    askUser: async ({ options }) => [options[1]!],
    runDetect: async (o) => {
      answer = await o.askUser!({ question: 'Which app?', options: ['web', 'admin'], multi: false });
      o.onPlan(fixturePlan());
      return { ok: true, aborted: false };
    },
  });
  await runOnboardCore(d);
  expect(answer).toEqual(['admin']);       // the ANSWER, not just that we asked
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/core.test.ts -t "detect"`
Expected: FAIL.

**Step 3: Write minimal implementation**

Inside `runFlow`:

```ts
    emit({ stage: 'detect', tasks: [] });
    let plan: OnboardingPlan | undefined;
    let tasks: TaskLine[] = [];
    const detect = await deps.runDetect({
      cwd: deps.cwd, signal, askUser: deps.askUser,
      onPlan: (value) => { plan = value; },
      onMessage: (message) => {
        record(message);
        tasks = boundTasks(reduceTasks(tasks, message));   // Task 9 supplies boundTasks
        emit({ stage: 'detect', tasks });
      },
    });

    if (detect.aborted) return { ok: false, status: 'aborted' };
    if (detect.reason === 'unsupported') {
      return { ok: false, status: 'unsupported',
        message: detect.unsupportedReason ?? 'this repository is not supported' };
    }
    if (!detect.ok || plan === undefined) {
      return { ok: false, status: 'failed',
        message: detect.reason ?? 'the survey did not produce a plan' };
    }
```

Until Task 9 lands, `boundTasks` is the identity function; define it locally so the call site never changes.

**Step 4: Run to verify it passes**

Run: `npx vitest run src/onboard/__tests__/core.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git commit -am "feat(cli): controller handles unsupported repos and forwards agent questions"
```

---

## Task 5: Approve, apply, reconcile

`runApply` returns `editedFiles`; the captured `ApplyReport` also lists them. They must agree. A `result` message alone is not success.

**Step 1: Write the failing test**

```ts
it('writes no env and never polls when apply fails', async () => {
  const writeEnv = vi.fn();
  const waitForAppReporting = vi.fn();
  const d = deps({
    runApply: async () => ({ ok: false, aborted: false, reason: 'verification_failed',
      failures: ['manifest does not contain an identity-capable Opslane SDK version (>=1.2.0)'] }),
    writeEnv, waitForAppReporting,
  });
  const result = await runOnboardCore(d);
  expect(result).toMatchObject({ ok: false, status: 'failed' });
  expect(result.message).toMatch(/identity-capable/);
  expect(writeEnv).not.toHaveBeenCalled();
  expect(waitForAppReporting).not.toHaveBeenCalled();
});

it('rejects a report whose editedFiles disagree with the engine', async () => {
  const d = deps({
    runApply: async (o) => {
      o.onReport({ editedFiles: ['src/main.ts'], summary: 'x', installRequired: true, installCwd: 'web' });
      return { ok: true, aborted: false, editedFiles: ['src/main.ts', 'package.json'] };
    },
  });
  const result = await runOnboardCore(d);
  expect(result).toMatchObject({ ok: false, status: 'failed' });
  expect(result.message).toMatch(/report.*match|reconcil/i);
});

it('starts the apply task list empty rather than reusing detect tasks', async () => {
  const seen: TaskLine[][] = [];
  await runOnboardCore(deps({
    emit: (e) => { if (e.stage === 'apply' && e.tasks) seen.push(e.tasks); },
    runDetect: async (o) => {
      o.onMessage(toolUse('t1', 'Read')); o.onMessage(toolUse('t2', 'Glob'));
      o.onPlan(fixturePlan());
      return { ok: true, aborted: false };
    },
  }));
  expect(seen[0]).toHaveLength(0);
});

it('emits the plan for review before applying', async () => {
  const events: CoreEvent[] = [];
  await runOnboardCore(deps({ emit: (e) => events.push(e) }));
  expect(events.find((e) => e.stage === 'awaiting-approval')?.plan?.app_dir).toBe('web');
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/core.test.ts -t "apply"`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
    emit({ stage: 'awaiting-approval', plan });

    tasks = [];                                  // detect's list must not carry over
    emit({ stage: 'apply', tasks });
    let report: ApplyReport | undefined;
    const applied = await deps.runApply({
      cwd: deps.cwd, plan, signal,
      requestApproval: deps.requestApproval,
      onReport: (value) => { report = value; },
      onMessage: (message) => {
        record(message);
        tasks = boundTasks(reduceTasks(tasks, message));
        emit({ stage: 'apply', tasks });
      },
    });

    if (applied.aborted) return { ok: false, status: 'aborted' };
    if (!applied.ok || report === undefined) {
      return { ok: false, status: 'failed',
        message: applied.failures?.join('; ') ?? applied.reason ?? 'the wiring could not be verified' };
    }
    const sameFiles = (a: string[] = [], b: string[] = []) =>
      a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
    if (!sameFiles(report.editedFiles, applied.editedFiles)) {
      return { ok: false, status: 'failed',
        message: 'the agent report does not match the files the engine tracked' };
    }
```

**Step 4: Run to verify it passes**

Run: `npx vitest run src/onboard/__tests__/core.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git commit -am "feat(cli): controller reconciles the apply report before writing secrets"
```

---

## Task 6: Env write, symlink-contained

**Step 1: Write the failing test**

```ts
it('writes both env vars into the plan app dir', async () => {
  const writes: Array<[string, Record<string, string>]> = [];
  await runOnboardCore(deps({ writeEnv: async (dir, vars) => { writes.push([dir, vars]); return `${dir}/.env.local`; } }));
  expect(writes[0]).toEqual(['/repo/web', {
    VITE_OPSLANE_API_KEY: 'opk_test',
    VITE_OPSLANE_ENDPOINT: 'http://localhost:8082',
  }]);
});

it('refuses an app_dir that escapes the repo', async () => {
  const writeEnv = vi.fn();
  const d = deps({ plan: { ...fixturePlan(), app_dir: '../outside' }, writeEnv });
  await expect(runOnboardCore(d)).resolves.toMatchObject({ ok: false, status: 'failed' });
  expect(writeEnv).not.toHaveBeenCalled();
});
```

The second test passes because Task 3's wrapper already catches — `containedRepoRelative` throws.

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/core.test.ts -t "env"`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
    emit({ stage: 'writing-env' });
    const appDir = containedRepoRelative(deps.cwd, plan.app_dir);   // throws if it escapes
    const envDir = join(deps.cwd, appDir);
    await deps.writeEnv(envDir, {
      [plan.env_vars.api_key]: provision.apiKey,
      [plan.env_vars.endpoint]: provision.endpoint,
    });
```

**Step 4: Run to verify it passes**

Run: `npx vitest run src/onboard/__tests__/core.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git commit -am "feat(cli): controller writes env vars inside the contained app dir"
```

---

## Task 7: Install — driven by the report, behind consent

`ApplyReport.installRequired` is `false` when the repo was already wired (`engine.ts:580`). Respect it. `installCwd` comes from the report too; do not re-derive it.

A failed install must stop the flow. A live spike showed an agent given this job "fixed" an ETARGET by downgrading the SDK pin to a version that cannot report identity (`docs/decisions/agent-runs-commands.md`, Run 2). The controller reports and stops.

**Step 1: Write the failing test**

```ts
it('skips the install when the report says it is not required', async () => {
  const runCommand = vi.fn();
  await runOnboardCore(deps({ installRequired: false, runCommand }));
  expect(runCommand).not.toHaveBeenCalled();
});

it('asks for consent and skips the install when declined, then still starts the dev server', async () => {
  const startDevServer = vi.fn(() => fakeServer());
  let consentAsked = false;
  const d = deps({
    // Decline ONLY the install. Task 8 adds a dev-server prompt through the same
    // `confirm`; a blanket false would decline that too and this assertion would break.
    confirm: async (prompt) => !prompt.toLowerCase().includes('install'),
    runCommand: async (o) => {
      consentAsked = true;
      return (await o.consent!()) ? { ran: true, ok: true, exitCode: 0, signal: null }
                                  : { ran: false, copyPaste: 'pnpm install' };
    },
    startDevServer,
  });
  await expect(runOnboardCore(d)).resolves.toMatchObject({ ok: true, status: 'completed' });
  expect(consentAsked).toBe(true);
  expect(startDevServer).toHaveBeenCalledTimes(1);
});

it('stops on a failed install rather than continuing', async () => {
  const startDevServer = vi.fn();
  const d = deps({
    runCommand: async () => ({ ran: true, ok: false, exitCode: 1, signal: null }),
    startDevServer,
  });
  const result = await runOnboardCore(d);
  expect(result).toMatchObject({ ok: false, status: 'failed' });
  expect(result.message).toMatch(/install/i);
  expect(startDevServer).not.toHaveBeenCalled();
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/core.test.ts -t "install"`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
    if (report.installRequired) {
      emit({ stage: 'installing' });
      const installDir = join(deps.cwd, containedRepoRelative(deps.cwd, report.installCwd));
      const install = installCommand(deps.cwd, containedRepoRelative(deps.cwd, report.installCwd));
      const installed = await deps.runCommand({
        command: install, cwd: installDir, signal,
        consent: () => deps.confirm('Install dependencies?', formatCommand(install)),
        onOutput: (output) => emit({ stage: 'installing', output }),
      });
      if (installed.ran && !installed.ok) {
        return { ok: false, status: 'failed',
          message: `${formatCommand(install)} failed (exit ${installed.exitCode ?? installed.signal}). `
            + 'Fix the install and re-run onboarding. Do not change the @opslane/sdk version.' };
      }
    }
```

**Step 4: Run to verify it passes**

Run: `npx vitest run src/onboard/__tests__/core.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git commit -am "feat(cli): install driven by the apply report, behind consent"
```

---

## Task 8: Dev server — consent, race, teardown

`startDevServer` has no consent option, so the controller asks before calling it. And once running, the wait must race the server's own death: if Vite exits, sitting in a 15-minute poll is wrong.

**Step 1: Write the failing test**

```ts
it('asks before starting the dev server and stops if declined', async () => {
  const startDevServer = vi.fn();
  const d = deps({ confirm: async (prompt) => !prompt.includes('dev server'), startDevServer });
  const result = await runOnboardCore(d);
  expect(startDevServer).not.toHaveBeenCalled();
  expect(result.message).toMatch(/dev server/i);
});

it('emits the URL it parsed', async () => {
  const events: CoreEvent[] = [];
  await runOnboardCore(deps({ emit: (e) => events.push(e) }));
  expect(events.find((e) => e.url)?.url).toBe('http://localhost:5173/');
});

it('fails fast when the dev server dies instead of waiting out the poll', async () => {
  const waitForAppReporting = vi.fn(() => new Promise(() => undefined));   // never settles
  const d = deps({
    startDevServer: () => ({ ...fakeServer(), completed: Promise.resolve({ exitCode: 1, signal: null }) }),
    waitForAppReporting,
  });
  const result = await runOnboardCore(d);
  expect(result).toMatchObject({ ok: false, status: 'failed' });
  expect(result.message).toMatch(/dev server (exited|stopped)/i);
});

it('stops the dev server when the wait fails', async () => {
  const stop = vi.fn();
  const d = deps({
    startDevServer: () => ({ ...fakeServer(), stop }),
    waitForAppReporting: async () => { throw new Error('timed out waiting for your app to report'); },
  });
  await expect(runOnboardCore(d)).resolves.toMatchObject({ ok: false, status: 'failed' });
  expect(stop).toHaveBeenCalled();
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/core.test.ts -t "dev server"`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
    const dev = devCommand(deps.cwd, appDir, plan.dev_script);
    if (!(await deps.confirm('Start the dev server?', formatCommand(dev)))) {
      return { ok: false, status: 'failed',
        message: `Start it yourself with \`${formatCommand(dev)}\`, then re-run onboarding.` };
    }

    emit({ stage: 'starting-dev' });
    const server = deps.startDevServer({
      command: dev, cwd: envDir, signal,
      onOutput: (output) => emit({ stage: 'starting-dev', output }),
    });
    // The poll must be cancellable independently: when the server dies, the
    // losing side of the race would otherwise keep polling for 15 minutes.
    const pollController = new AbortController();
    const onOuterAbort = (): void => pollController.abort();
    signal.addEventListener('abort', onOuterAbort, { once: true });
    // Never let the losing branch surface as an unhandled rejection.
    const serverDied = server.completed.then(
      ({ exitCode }) => { throw new Error(`the dev server stopped (${exitCode ?? 'signal'}) unexpectedly`); },
      (error: unknown) => { throw error instanceof Error ? error : new Error(String(error)); },
    );
    void serverDied.catch(() => undefined);
    try {
      const url = await Promise.race([server.url, serverDied]);
      emit({ stage: 'waiting', url });
      await Promise.race([
        deps.waitForAppReporting({
          apiUrl: deps.apiUrl, sessionId: provision.sessionId,
          pollToken: provision.pollToken, signal: pollController.signal,
        }),
        serverDied,
      ]);
      return { ok: true, status: 'completed', url };
    } finally {
      pollController.abort();                       // stop the poll either way
      signal.removeEventListener('abort', onOuterAbort);
      server.stop();
      await server.completed.catch(() => undefined);  // teardown before the terminal event
    }
```

**Step 4: Run to verify it passes**

Run: `npx vitest run src/onboard/__tests__/core.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git commit -am "feat(cli): dev server behind consent, raced against its own exit"
```

---

## Task 9: Bound the task list in the controller

Bounding only the view leaves `reduceTasks` retaining every entry and re-cloning the array per message — O(n²) allocations on a real repo survey.

**Files:** modify `cli/src/onboard/core.ts`; test in `core.test.ts`.

**Step 1: Write the failing test**

```ts
it('bounds retained task state and counts what it dropped', async () => {
  let last: TaskLine[] = [];
  await runOnboardCore(deps({
    emit: (e) => { if (e.tasks) last = e.tasks; },
    runDetect: async (o) => {
      for (let i = 0; i < 200; i += 1) {
        o.onMessage(toolUse(`t${i}`, 'Read'));
        o.onMessage(toolResult(`t${i}`));
      }
      o.onPlan(fixturePlan());
      return { ok: true, aborted: false };
    },
  }));
  expect(last.length).toBeLessThanOrEqual(8);
  expect(last.filter((t) => t.state === 'run')).toHaveLength(0);
});

it('counts dropped failures separately from dropped successes', async () => {
  let event: CoreEvent | undefined;
  await runOnboardCore(deps({
    emit: (e) => { if (e.tasks) event = e; },
    runDetect: async (o) => {
      for (let i = 0; i < 30; i += 1) {
        o.onMessage(toolUse(`t${i}`, 'Read'));
        o.onMessage(toolResult(`t${i}`, { isError: i % 10 === 0 }));   // 3 failures
      }
      o.onPlan(fixturePlan());
      return { ok: true, aborted: false };
    },
  }));
  expect(event!.droppedFailed).toBe(3);
  expect(event!.droppedDone).toBe(30 - 3 - event!.tasks!.length);
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/core.test.ts -t "bounds retained"`
Expected: FAIL — 200 entries retained.

**Step 3: Write minimal implementation**

Replace the identity `boundTasks` from Task 4:

```ts
const MAX_TASKS = 8;

export interface BoundedTasks {
  tasks: TaskLine[];
  droppedDone: number;
  droppedFailed: number;
}

/**
 * Keep every still-running line (a `tool_result` must still find its `tool_use`),
 * plus the most recent settled ones. Failures are NEVER dropped silently — they
 * are counted separately so the view cannot report a failure as "done".
 */
function boundTasks(tasks: TaskLine[], prev: BoundedTasks): BoundedTasks {
  const running = tasks.filter((t) => t.state === 'run');
  const settled = tasks.filter((t) => t.state !== 'run');
  const room = Math.max(0, MAX_TASKS - running.length);
  // slice(-0) is slice(0) and returns EVERYTHING — guard room === 0 explicitly.
  const keep = room === 0 ? [] : settled.slice(-room);
  const dropped = settled.slice(0, settled.length - keep.length);
  return {
    tasks: [...keep, ...running],
    droppedDone: prev.droppedDone + dropped.filter((t) => t.state === 'done').length,
    droppedFailed: prev.droppedFailed + dropped.filter((t) => t.state === 'fail').length,
  };
}
```

Note `running` is never truncated: dropping a running line would orphan its
`tool_result` and the entry would never settle. When more than `MAX_TASKS` tools are
in flight the list exceeds the cap, which is correct and transient.

Carry `droppedDone` / `droppedFailed` in the emitted event so the view renders
`✓ N done` and, separately, `✗ M failed`.

**Step 4: Run to verify it passes**

Run: `npx vitest run src/onboard/__tests__/core.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git commit -am "feat(cli): bound retained task state, not just the rendered list"
```

---

## Task 10: `tui.tsx` — the pure view

**Files:** create `cli/src/onboard/tui.tsx` and `__tests__/tui.test.tsx`.

**Step 1: Write the failing test**

```tsx
it('renders the question and resolves on Enter', () => {
  const onAnswer = vi.fn();
  const { lastFrame, stdin } = render(
    <Tui stage="detect" tasks={[]} onAnswer={onAnswer}
      question={{ question: 'Which app?', options: ['web', 'admin'], multi: false }} />);
  expect(lastFrame()).toContain('Which app?');
  stdin.write('\r');
  expect(onAnswer).toHaveBeenCalledWith(['web']);
});

it.each([
  ['unsupported', 'this repository has no web application', /no web application/],
  ['failed', 'manifest does not contain an identity-capable Opslane SDK version', /identity-capable/],
  ['aborted', undefined, /cancell?ed|stopped/i],
])('renders %s so the user can act', (stage, message, pattern) => {
  const frame = render(<Tui stage={stage as Stage} tasks={[]} message={message} />).lastFrame() ?? '';
  expect(frame).toMatch(pattern);
  expect(frame).not.toMatch(/⠋|⠙|⠹/);              // no spinner on a terminal state
});

it('shows the clickable URL while waiting', () => {
  expect(render(<Tui stage="waiting" tasks={[]} url="http://localhost:5173/" />).lastFrame())
    .toContain('http://localhost:5173/');
});

it('renders dropped successes and failures separately', () => {
  const tasks = Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, label: `Read f${i}.ts`, state: 'done' as const }));
  const frame = render(<Tui stage="detect" tasks={tasks} droppedDone={33} droppedFailed={3} />).lastFrame() ?? '';
  expect(frame).toMatch(/\b37 done\b/);            // 33 dropped + 4 shown
  expect(frame).toMatch(/\b3 failed\b/);           // failures must never be counted as done
  expect(frame.split('\n').length).toBeLessThan(15);
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/tui.test.tsx`
Expected: FAIL — module missing.

**Step 3: Write minimal implementation**

A `Box` column. `Select`/`MultiSelect` from `@inkjs/ui` when `question` is set. Above the live lines: `✓ {droppedDone + shownDone} done` and, only when non-zero, `✗ {droppedFailed + shownFailed} failed`. Terminal stages render `message` with no spinner; `aborted` renders "Cancelled. Nothing was left running."

**Step 4: Run to verify it passes**

Run: `npx vitest run src/onboard/__tests__/tui.test.tsx`
Expected: PASS (6 tests).

**Step 5: Commit**

```bash
git add cli/src/onboard/tui.tsx cli/src/onboard/__tests__/tui.test.tsx
git commit -m "feat(cli): onboarding TUI view with actionable terminal states"
```

---

## Task 11: `app.tsx` — the Ink shell and the production dependency factory

Two jobs: supply the three interactive callbacks, and build the real `CoreDeps`. Revision 1 specified neither concretely.

**Approvals may overlap.** `runApply` tool calls can interleave, so a single parked resolver loses one. Queue them.

**The queue holds three prompt kinds with different resolve types.** `requestApproval` and `confirm` resolve `boolean`; `askUser` resolves `string[]` (`tools.ts:109`). A queue that settles everything with `false` is a type error. Tag each entry and settle per kind: `false` for approvals and confirmations, `[]` for questions.

Settle on: the outer `signal`, the per-approval `options.signal` the SDK supplies, and unmount.

**Login prints to stdout** (`login.ts:130`) — the authorization URL is the one thing the user must see, and Ink owns the screen. Do **not** move login outside core: that would duplicate the `ensureLoggedIn` call, put it outside core's error handling and abort, and leave an un-abortable OAuth wait (login accepts no signal, `login.ts:66`).

Instead the shell supplies a `loginFn` that **unmounts Ink, runs login, then re-renders**:

```ts
const loginFn = async (): Promise<void> => {
  instance.clear();
  instance.unmount();            // give stdout back
  await login({ apiUrl, clientId: process.env['OPSLANE_CLIENT_ID'] ?? 'opslane-cli' });
  instance = render(<OnboardApp {...props} />);   // resume
};
```

Login therefore still happens inside `runOnboardCore` (Task 3), covered by the same
try/catch and the same terminal mapping.

**Files:** create `cli/src/onboard/app.tsx` and `__tests__/app.test.tsx`.

**Step 1: Write the failing test**

```tsx
it('resolves an approval to true when accepted', async () => {
  let resolved: boolean | undefined;
  const { lastFrame, stdin } = render(<OnboardApp {...props({
    runCore: async (d) => {
      resolved = await d.requestApproval('Edit', { file_path: 'src/main.ts' });
      return { ok: true, status: 'completed' };
    },
  })} />);
  await delay(10);
  expect(lastFrame()).toMatch(/src\/main\.ts/);
  stdin.write('\r');
  await delay(10);
  expect(resolved).toBe(true);
});

it('prefers the SDK-supplied title over a reconstructed sentence', async () => {
  const { lastFrame } = render(<OnboardApp {...props({
    runCore: async (d) => {
      void d.requestApproval('Edit', { file_path: 'a.ts' },
        { title: 'Claude wants to edit a.ts' } as never);
      return new Promise(() => undefined);
    },
  })} />);
  await delay(10);
  expect(lastFrame()).toContain('Claude wants to edit a.ts');
});

it('queues overlapping approvals instead of dropping one', async () => {
  const settled: boolean[] = [];
  const { stdin } = render(<OnboardApp {...props({
    runCore: async (d) => {
      const a = d.requestApproval('Edit', { file_path: 'a.ts' }).then((v) => settled.push(v));
      const b = d.requestApproval('Edit', { file_path: 'b.ts' }).then((v) => settled.push(v));
      await Promise.all([a, b]);
      return { ok: true, status: 'completed' };
    },
  })} />);
  await delay(10); stdin.write('\r');
  await delay(10); stdin.write('\r');
  await delay(10);
  expect(settled).toHaveLength(2);
});

it('settles a queued question with an empty answer, not false', async () => {
  const controller = new AbortController();
  let answer: string[] | undefined;
  render(<OnboardApp {...props({
    signal: controller.signal,
    runCore: async (d) => {
      answer = await d.askUser({ question: 'Which app?', options: ['web'], multi: false });
      return { ok: false, status: 'aborted' };
    },
  })} />);
  await delay(10);
  controller.abort();
  await delay(10);
  expect(answer).toEqual([]);          // string[], not `false`
});

it('runOnboardApp builds real deps, logs in through the shell, and returns the core result', async () => {
  const calls: string[] = [];
  const result = await runOnboardApp({
    cwd: '/repo', repo: 'acme/web', apiUrl: 'http://localhost:8082',
    signal: new AbortController().signal,
    // test seam: swap the core so we assert the DEPS it received, not the flow
    runCore: async (d) => {
      calls.push(typeof d.loginFn, typeof d.runLog.record, typeof d.writeEnv, d.tokenPath ? 'tokenPath' : 'none');
      return { ok: true, status: 'completed' };
    },
  } as never);
  expect(result).toMatchObject({ ok: true, status: 'completed' });
  expect(calls[0]).toEqual(['function', 'function', 'function', 'tokenPath'].join(''));
});

it('settles every pending prompt when the signal aborts', async () => {
  const controller = new AbortController();
  let resolved: boolean | undefined;
  render(<OnboardApp {...props({
    signal: controller.signal,
    runCore: async (d) => {
      resolved = await d.requestApproval('Edit', { file_path: 'a.ts' });
      return { ok: false, status: 'aborted' };
    },
  })} />);
  await delay(10);
  controller.abort();
  await delay(10);
  expect(resolved).toBe(false);          // denied, not left hanging
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/app.test.tsx`
Expected: FAIL.

**Step 3: Write minimal implementation**

`app.tsx` exports:

```ts
export async function runOnboardApp(o: {
  cwd: string; repo: string; apiUrl: string; signal: AbortSignal;
}): Promise<CoreResult>
```

It (1) runs `ensureLoggedIn` before any render, (2) builds the production deps, (3) renders `<OnboardApp>` and resolves when core settles.

The production factory — every field of `CoreDeps` with a real implementation:

```ts
interface ShellUi {
  requestApproval: ApprovalRequest;
  askUser: AskUserResolver;
  confirm: (prompt: string, command: string) => Promise<boolean>;
  emit: (event: CoreEvent) => void;
  loginFn: () => Promise<void>;
}

// async: createRunLog returns a Promise. Revision 2 had `await` in a sync function.
async function productionDeps(
  o: { cwd: string; repo: string; apiUrl: string; signal: AbortSignal },
  ui: ShellUi,
): Promise<CoreDeps> {
  const full = process.env['OPSLANE_ONBOARD_LOG'] === 'full';
  if (full) {
    // Full mode records agent messages, which can contain repository source.
    // Say so before writing any of it.
    console.error('OPSLANE_ONBOARD_LOG=full: this run records full agent messages, '
      + 'including file contents, to ~/.opslane/logs. Secrets are redacted; source is not.');
  }
  return {
    ...o,
    tokenPath: defaultTokenPath(),
    loginFn: ui.loginFn,
    ensureLoggedIn, ensureProvisioned, runDetect, runApply,
    writeEnv: writeEnvLocal, runCommand, startDevServer, waitForAppReporting,
    requestApproval: ui.requestApproval,
    askUser: ui.askUser,
    confirm: ui.confirm,
    runLog: await createRunLog({
      dir: join(homedir(), '.opslane', 'logs'),
      runId: randomUUID(),
      mode: full ? 'full' : 'metadata',
    }),
    emit: ui.emit,
  };
}
```

A prompt queue: `pending: Array<{prompt, resolve}>`, render only `pending[0]`, shift on answer. On `signal.abort` and on unmount, resolve every entry `false`.

**Step 4: Run to verify it passes**

Run: `npx vitest run src/onboard/__tests__/app.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
git add cli/src/onboard/app.tsx cli/src/onboard/__tests__/app.test.tsx
git commit -m "feat(cli): Ink shell with a queued approval prompt and production deps"
```

---

## Task 12: Wire the command

`command.ts` today ends with an **unconditional** `exitWithStatus('internal_error', ...)` after the `finally`. Replace the whole placeholder path, not just the comment, or every successful run still fails.

**Step 1: Write the failing test**

```ts
it('passes the resolved repo, api url, and signal into the shell', async () => {
  const seen: unknown[] = [];
  await runOnboardCommand({ repo: 'acme/web' }, {
    isStdinTty: true, isStdoutTty: true,
    loadApp: async () => ({ runOnboardApp: async (o: unknown) => { seen.push(o); return { ok: true, status: 'completed' }; } }),
  });
  expect(seen[0]).toMatchObject({ repo: 'acme/web', apiUrl: expect.any(String) });
  expect((seen[0] as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
});

it('exits 0 and emits nothing extra on success', async () => {
  const exits: unknown[] = [];
  await runOnboardCommand({ repo: 'acme/web' }, {
    isStdinTty: true, isStdoutTty: true,
    exitWith: (...a) => { exits.push(a); },
    loadApp: async () => ({ runOnboardApp: async () => ({ ok: true, status: 'completed' }) }),
  });
  expect(exits).toEqual([]);
});

it('maps unsupported to usage_error and failed to internal_error', async () => {
  const cases = [
    ['unsupported', 'usage_error'],
    ['failed', 'internal_error'],
  ] as const satisfies ReadonlyArray<readonly [CoreResult['status'], AgentStatus]>;
  for (const [status, expected] of cases) {
    const exits: Array<[string, number]> = [];
    await runOnboardCommand({ repo: 'acme/web' }, {
      isStdinTty: true, isStdoutTty: true,
      exitWith: (s, _d, c) => { exits.push([s, c]); },
      loadApp: async () => ({ runOnboardApp: async () => ({ ok: false, status, message: 'x' }) }),
    });
    expect(exits).toEqual([[expected, 1]]);
  }
});

it('preserves the 130 exit code a real SIGINT set', async () => {
  const exits: unknown[] = [];
  const before = process.exitCode;
  await runOnboardCommand({ repo: 'acme/web' }, {
    isStdinTty: true, isStdoutTty: true,
    exitWith: (...a) => { exits.push(a); },
    loadApp: async () => ({
      runOnboardApp: async () => {
        process.emit('SIGINT');                 // the handler sets exitCode 130 and aborts
        return { ok: false, status: 'aborted' as const };
      },
    }),
  });
  expect(process.exitCode).toBe(130);
  expect(exits).toEqual([]);                    // nothing overwrote it
  process.exitCode = before;
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run src/onboard/__tests__/command.test.ts -t "shell"`
Expected: FAIL — `runOnboardCommand` takes one argument.

**Step 3: Write minimal implementation**

Add a typed second parameter with production defaults:

```ts
export interface OnboardCommandDeps {
  isStdinTty?: boolean;
  isStdoutTty?: boolean;
  exitWith?: (status: AgentStatus, data: Record<string, unknown>, code: number) => void;
  loadApp?: () => Promise<{ runOnboardApp: (o: {
    cwd: string; repo: string; apiUrl: string; signal: AbortSignal;
  }) => Promise<CoreResult> }>;
}
```

**Route the TTY gate and the exit through the injected deps too.** Revision 2 left
`requireTty` reading the real `process.stdin/stdout` and calling the real `exitWithStatus`,
which makes the injected `isStdinTty` / `exitWith` inert:

```ts
  const exitWith = deps.exitWith ?? exitWithStatus;
  requireTty({
    isStdinTty: deps.isStdinTty ?? process.stdin.isTTY === true,
    isStdoutTty: deps.isStdoutTty ?? process.stdout.isTTY === true,
    onFail: (status, code) => exitWith(status, { message: '...' }, code),
  });
```

Then replace everything after `resolveRepo` — including the trailing unconditional exit:

```ts
  const apiUrl = options.apiUrl ?? defaultApiUrl();
  const controller = new AbortController();
  const removeHandlers = installSignalHandlers({ controller });
  try {
    const { runOnboardApp } = await loadApp();
    const result = await runOnboardApp({ cwd: process.cwd(), repo: repo.repo, apiUrl, signal: controller.signal });
    if (result.ok) return;
    // SIGINT already set exitCode 130; do not overwrite it.
    if (result.status === 'aborted') return;
    exitWith(result.status === 'unsupported' ? 'usage_error' : 'internal_error',
      { message: result.message }, 1);
  } finally {
    removeHandlers();
  }
```

**Step 4: Verify the piped path is unchanged**

```bash
pnpm --filter @opslane/cli build
node dist/index.js onboard < /dev/null
```
Expected: one JSON document, `tty_required`, exit 1, zero ANSI. The shell must not load.

**Step 5: Commit**

```bash
git commit -am "feat(cli): opslane onboard runs the interactive flow"
```

---

## Task 13: Record what M5 needs

Do this **before** the gate so it lands in the same PR. Append to `docs/plans/2026-07-22-onboarding-10x-implementation.md` under M5:

- Blocked on `@opslane/sdk >= 1.2.0` on npm (#45/#46). Until then `npm install` fails ETARGET, verified.
- **Clear `~/.opslane/pending` first.** `ensureProvisioned` resumes sessions already at `app_reporting` or `completed` (`provision.ts:131`) and `waitForAppReporting` accepts those immediately (`wait.ts`), so a stale record makes the poll succeed without the edited app ever connecting. This is a false-success path in the product, not only in the smoke — if it recurs in real use, the fix is a server-side transition marker, not a smoke-script workaround.
- Assert a fresh `provisioned → app_reporting` transition for **this run's** session id.
- Re-run `node scripts/check-packed-packages.mjs`.

**Commit:** `git commit -am "docs: record M5 preconditions and the stale-session false-success path"`

---

## Task 14: Full gate and PR

```bash
cd /Users/abhishekray/orca/workspaces/opslane-oss/onboarding-10x-2
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

**Prove the new tests are real.** For Tasks 1, 5, 7, 8, 9, and 11, revert the implementation hunk, confirm the new tests fail, restore.

**Bounded live checks only.** Do **not** run an unstubbed `opslane onboard` under a PTY: it would log in, provision a real project, call the model, edit files, and install packages. Two safe checks:

```bash
# piped path, real binary
node cli/dist/index.js onboard < /dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])"
# expect: tty_required

# TTY gate passes and stops at repo resolution, no network, no model
cd /tmp && mkdir -p onboard-gate && cd onboard-gate && git init -q
script -q /dev/null node <repo>/cli/dist/index.js onboard | tr -d '\r' | head -5
# expect: usage_error naming --repo
```

Then confirm nothing leaked: `pgrep -f vite || echo "no orphans"` and `lsof -ti :5173 || echo "port free"`.

**Open the PR.** `git push` is blocked by a local hook — ask the user to run
`! git push -u origin abhishekray07/phase-3b-controller-tui`, then `gh pr create --base main`.

---

## What already exists (do not rebuild)

| Need | Shipped in |
|---|---|
| TTY gate, repo resolution, signal handlers | `command.ts` (Phase 3a) |
| Install / dev-server commands, group teardown, output throttling | `process.ts` (Phase 3a, proven live) |
| Both agent stages | `runDetect` / `runApply` — `engine.ts` |
| Task-list state from SDK messages | `reduceTasks` / `TaskLine` — `events.ts` |
| Login, provisioning, env write, polling, run log | Phase 2 |
| Path containment | `containedRepoRelative` — `paths.ts` |

## NOT in scope

| Deferred | Why |
|---|---|
| Live smoke to `app_reporting` | M5; blocked on the SDK release |
| Hard-repo acceptance | Milestone B, the design's real bar |
| Giving the agent a shell | Considered and rejected — `docs/decisions/agent-runs-commands.md` |
| Reconciling `engine.ts`'s install fields with `process.ts` | Task 7 consumes the report's fields; collapse the duplication once M5 shows which shape survives |
