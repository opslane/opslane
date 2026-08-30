# Remaining Sandbox Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the sandbox work the design doc started. Lock down the fix job's network, and give the JavaScript path a prebuilt machine so memory can be set and the per-run Node download disappears.

**Architecture:** The fix job already runs in a rented machine but with unrestricted outbound network. It gets a policy of its own, tighter than the read-only one because no credential ever enters it. Separately, both paths move onto a saved machine image built ahead of time, which is the only place E2B lets you set memory.

**Tech Stack:** TypeScript (ESM, strict), `e2b@2.45.0`, Vitest.

**Spec:** `docs/design/2026-08-29-fix-sandbox-reliability-design.md`, milestone two, plus the fix-path egress gap recorded in its Scope section.

## Global Constraints

- ESM and strict TypeScript. Use `unknown` plus narrowing, never `any`.
- Vitest tests colocated in `__tests__`.
- `e2b` is pinned at exactly `2.45.0`. `SandboxOpts` has no `memoryMB`/`cpuCount`; memory is settable only at image build time, where it defaults to 1024.
- E2B returns 400 unless an `allowOut` list is paired with `denyOut` containing `ALL_TRAFFIC`.
- Every task must leave `pnpm --filter @opslane/worker build` and `pnpm --filter @opslane/worker test` passing.

## Scope

Two workstreams are planned here in full. Two are not, and the reason is stated rather than the work being quietly dropped.

**Planned: A, the fix job's network.** Ready now. It reuses `sandbox-network.ts`, which shipped and was verified live.

**Planned: B, the prebuilt JavaScript image.** Ready now. The design doc already settled the decisions: what goes in the image, what triggers a rebuild, and where builds run.

**Not planned: C, the Claude Agent SDK migration.** It cannot be turned into tasks yet. `ReadOnlyRunInput` carries function-valued fields, `validateTerminal` and the `terminalTool` schema, which cannot be serialized into a process running inside a machine. The host-to-machine protocol has to be designed before anyone can write steps against it. Two further gaps need answers in that design: the SDK has no way to force a final tool call the way `tool_choice` does today, and no dollar budget cap. Its built-in `Read` was also measured following a symlink out of its working directory, so it inherits the containment problem rather than solving it.

**Not planned: D, moving product context into a machine.** Its `discoverRepositoryRoutes` walks the checkout and reads up to 10,000 files to build the model's prompt. A three-method reader turns that into 10,000 round trips, and its multi-line patterns cannot be expressed as `grep`. It needs a different seam, most likely running the discovery walk itself inside the machine as a script and returning only the extracted routes. That is a design question, not a task list.

Its narrower problem is already handled separately: the model's own tools used a text-only path check, and that is being pointed at the correct `resolveInsideRepo` guard in the current branch.

---

## Workstream A: the fix job's network

### Task A1: A policy for a machine that holds no credential

**Files:**
- Modify: `packages/worker/src/harness/sandbox-network.ts`
- Test: `packages/worker/src/harness/__tests__/sandbox-network.test.ts`

**Interfaces:**
- Consumes: `ReadOnlyNetwork`, `ALLOWED_HOSTS` (already in this file).
- Produces: `buildFixNetwork(platform: Platform): ReadOnlyNetwork`

The fix machine's policy is **tighter** than the read-only one, which is counterintuitive and worth stating plainly. The model does not run inside the fix machine; the worker drives it and sends commands in. So the machine never needs `api.anthropic.com`, and no credential is injected, which removes the whole class of problem the read-only policy needed a proxy rule to solve.

What it does need is package registries, because unlike the read-only jobs the fix job installs dependencies.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { ALL_TRAFFIC } from 'e2b';
import { buildFixNetwork } from '../sandbox-network.js';

describe('buildFixNetwork', () => {
  it('allows the registries a JavaScript install needs, and nothing else', () => {
    const net = buildFixNetwork('javascript');
    expect(net.denyOut).toEqual([ALL_TRAFFIC]);
    expect(net.allowOut).toEqual(['registry.npmjs.org', 'github.com']);
  });

  it('allows the Python registries on the Python path', () => {
    const net = buildFixNetwork('python');
    expect(net.allowOut).toContain('pypi.org');
    expect(net.allowOut).toContain('files.pythonhosted.org');
    expect(net.allowOut).toContain('github.com');
  });

  it('injects no credential, because none enters this machine', () => {
    expect(buildFixNetwork('javascript').rules).toEqual({});
    expect(buildFixNetwork('python').rules).toEqual({});
  });

  it('does not reach Anthropic: the model runs on the worker, not in here', () => {
    expect(buildFixNetwork('javascript').allowOut).not.toContain('api.anthropic.com');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- sandbox-network`
Expected: FAIL, `buildFixNetwork` is not exported

- [ ] **Step 3: Write minimal implementation**

```ts
/** What a dependency install has to reach, per platform. */
const FIX_HOSTS: Record<Platform, string[]> = {
  javascript: ['registry.npmjs.org', 'github.com'],
  python: ['pypi.org', 'files.pythonhosted.org', 'github.com'],
};

/**
 * Network policy for a fix machine.
 *
 * Tighter than the read-only policy despite doing more, because the model runs
 * on the worker and only commands cross into the machine. Nothing here needs an
 * API key, so nothing here injects one.
 *
 * The wider allowance is package registries. That is a real exposure: install
 * scripts are customer-controlled code and can reach whatever these lines allow.
 * It is narrower than today's unrestricted outbound, which is the point.
 */
export function buildFixNetwork(platform: Platform): ReadOnlyNetwork {
  return {
    denyOut: [ALL_TRAFFIC],
    allowOut: [...(FIX_HOSTS[platform] ?? FIX_HOSTS.javascript)],
    rules: {},
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- sandbox-network && pnpm --filter @opslane/worker build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/harness/sandbox-network.ts packages/worker/src/harness/__tests__/sandbox-network.test.ts
git commit -m "feat(worker): egress policy for fix machines"
```

---

### Task A2: Apply it, and prove a blocked host fails honestly

**Files:**
- Modify: `packages/worker/src/harness/sandbox-runtime.ts:147,150`
- Test: `packages/worker/src/harness/__tests__/sandbox-runtime.test.ts`
- Modify: `packages/worker/scripts/verify-isolation.ts`

**Interfaces:**
- Consumes: `buildFixNetwork` (Task A1).
- Produces: no new exports.

The risk this task carries is not that the policy fails to apply. It is that a package needing a host outside the list now fails to install, and that failure must be reported as ours rather than the customer's. That routing already exists: `classifyInstallFailure` reads the output for network signatures and returns `infrastructure`. This task proves the two work together, because a wrong answer here tells customers their dependency list is broken when our own rule blocked it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { ALL_TRAFFIC } from 'e2b';

const create = vi.fn(async () => ({ sandboxId: 's', commands: {}, files: {}, kill: async () => {} }));
vi.mock('e2b', async (orig) => ({ ...(await orig<typeof import('e2b')>()), Sandbox: { create } }));

describe('createSandboxRuntime', () => {
  it('creates the JavaScript fix machine with a deny-all policy', async () => {
    const { createSandboxRuntime } = await import('../sandbox-runtime.js');
    await createSandboxRuntime('javascript');
    const opts = create.mock.calls.at(-1)?.[0] as { network?: { denyOut: string[]; allowOut: string[] } };
    expect(opts.network?.denyOut).toEqual([ALL_TRAFFIC]);
    expect(opts.network?.allowOut).toEqual(['registry.npmjs.org', 'github.com']);
  });

  it('keeps the Python template and gives it the Python policy', async () => {
    const { createSandboxRuntime } = await import('../sandbox-runtime.js');
    await createSandboxRuntime('python');
    const [template, opts] = create.mock.calls.at(-1) as [string, { network?: { allowOut: string[] } }];
    expect(template).toBe('opslane-python');
    expect(opts.network?.allowOut).toContain('pypi.org');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- sandbox-runtime`
Expected: FAIL, `network` is undefined on the create options

- [ ] **Step 3: Write minimal implementation**

Pass the policy at both call sites:

```ts
if (platform !== 'python') {
  return adaptE2BSandbox(
    await Sandbox.create({ timeoutMs: lifetimeMs, network: buildFixNetwork(platform) }),
    lifetimeMs, createdAt,
  );
}
const template = process.env['OPSLANE_E2B_PYTHON_TEMPLATE']?.trim() || DEFAULT_PYTHON_TEMPLATE;
return adaptE2BSandbox(
  await Sandbox.create(template, { timeoutMs: lifetimeMs, network: buildFixNetwork(platform) }),
  lifetimeMs, createdAt,
);
```

Then add a sixth check to `scripts/verify-isolation.ts`: in a machine built with `buildFixNetwork('javascript')`, install a package whose dependency points at a host outside the list, catch the real failure, and assert `classifyInstallFailure` returns `infrastructure`. This is the same shape as the AC11 check that already passed for the read-only policy.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test && pnpm --filter @opslane/worker build`
Expected: PASS

Then, with real credentials: `pnpm --filter @opslane/worker exec tsx scripts/verify-isolation.ts`
Expected: six PASS lines, exit 0

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src packages/worker/scripts
git commit -m "feat(worker): fix machines deny outbound except package registries"
```

---

### Task A3: Find out what the allowlist actually breaks, before it breaks it

**Files:**
- Create: `packages/worker/scripts/probe-install-hosts.ts`

**Interfaces:**
- Consumes: `buildFixNetwork` (Task A1).
- Produces: nothing importable.

Do not skip this. A real dependency tree can fetch binaries from hosts that are not npm: Playwright pulls browsers from a CDN, `sharp` pulls prebuilds from GitHub releases, anything using `node-gyp` wants headers from `nodejs.org`. None appeared in the one tree measured so far, which installed 199 packages against `registry.npmjs.org` and `github.com` alone. That is one repository, not a rule.

- [ ] **Step 1: Write the script**

For each connected repository, clone into a machine built with `buildFixNetwork`, run the real install, and print the repository, whether it succeeded, and any host named in the failure output.

- [ ] **Step 2: Run it against every connected repository**

Run: `pnpm --filter @opslane/worker exec tsx scripts/probe-install-hosts.ts`
Expected: a table. Every failure names the host that was blocked.

- [ ] **Step 3: Decide from the results, do not guess**

If a repository needs a host, add it to `FIX_HOSTS` with a comment naming the package that needs it. If several do, that is a signal the allowlist is the wrong shape and belongs back in front of the user rather than being widened quietly.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/scripts/probe-install-hosts.ts packages/worker/src/harness/sandbox-network.ts
git commit -m "test(worker): probe which hosts real dependency trees need"
```

---

## Workstream B: a prebuilt JavaScript image

### Task B1: Build the image

**Files:**
- Create: `packages/worker/e2b-javascript/build.ts`
- Create: `packages/worker/e2b-javascript/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a built template named `opslane-javascript`, and its id recorded in the README.

Two facts from the pinned library, both measured rather than read from documentation. `SandboxOpts` has no memory field, so an image is the only way to set memory. And `BasicBuildOptions.memoryMB` defaults to 1024, not the 512 the command-line documentation states.

The build runs in process. The library exposes the whole build API, so this needs no command-line tool and no separate pipeline.

- [ ] **Step 1: Write the build script**

```ts
import { Template } from 'e2b';

/**
 * The JavaScript fix and read-only image.
 *
 * Node 22 is baked in because the stock E2B image ships 20.9, which predates
 * crypto.hash() and breaks modern Vite plugins. Without this every single run
 * downloads and unpacks a Node tarball first.
 *
 * Memory is set here because there is nowhere else: Sandbox.create takes no
 * memory option in e2b 2.45.
 */
const template = Template().fromNodeImage('22').runCmd('npm i -g npm@latest');

const info = await Template.build(template, 'opslane-javascript', {
  memoryMB: 2048,
  cpuCount: 2,
  onBuildLogs: (entry) => console.log(entry.message),
});
console.log(`built ${info.name} template=${info.templateId} build=${info.buildId}`);
```

Note the call shape: `name` is a positional argument, not a field in the options object. The deprecated overload takes `alias` inside the options instead.

- [ ] **Step 2: Run it**

Run: `E2B_API_KEY=... pnpm --filter @opslane/worker exec tsx e2b-javascript/build.ts`
Expected: a template id printed. Record it in the README next to the Python one.

- [ ] **Step 3: Confirm the image is what was asked for**

Run a sandbox from it and check `node --version` reports v22, and that memory is above the default.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/e2b-javascript
git commit -m "feat(worker): prebuilt JavaScript sandbox image"
```

---

### Task B2: Use it, and delete the per-run Node download

**Files:**
- Modify: `packages/worker/src/harness/sandbox-runtime.ts`
- Modify: `packages/worker/src/harness/sandbox-repo.ts` (`ensureModernNode`, around line 91)
- Test: `packages/worker/src/harness/__tests__/sandbox-repo.test.ts`

**Interfaces:**
- Consumes: the template from Task B1.
- Produces: no new exports. `ensureModernNode` is deleted.

`ensureModernNode` exists only because the stock image ships Node 20.9. With Node 22 in the image it is dead weight, and it is not free: it downloads and unpacks a tarball on a 180 second budget on every JavaScript run.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import * as repo from '../sandbox-repo.js';

describe('node provisioning', () => {
  it('no longer downloads Node at run time', () => {
    expect(Object.keys(repo)).not.toContain('ensureModernNode');
  });
});
```

Add a matching assertion that the JavaScript path passes the template name to `Sandbox.create`, mirroring the Python assertion in Task A2.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- sandbox-repo`
Expected: FAIL on both

- [ ] **Step 3: Write minimal implementation**

Name the template on the JavaScript path the way the Python path already does, reading `OPSLANE_E2B_JAVASCRIPT_TEMPLATE` with the built name as the default. Delete `ensureModernNode` and its call site.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test && pnpm --filter @opslane/worker build`
Expected: PASS

Then measure: run a fix against a real repository and compare setup duration against the 168 seconds recorded on 2026-08-28.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src
git commit -m "feat(worker): boot the JavaScript image instead of installing Node per run"
```

---

### Task B3: Rebuild when the image goes stale

**Files:**
- Create: `packages/worker/src/image-refresh.ts`
- Test: `packages/worker/src/__tests__/image-refresh.test.ts`

**Interfaces:**
- Consumes: `Template.build` (Task B1).
- Produces: `shouldRebuildImage(changedPaths: string[]): boolean`

This is the smaller, honest half of the design doc's milestone two. That milestone described per-repository images holding each customer's code and dependencies. This task does not build those. It rebuilds the one shared image when the thing it contains changes, which is a much smaller claim and does not require deciding where customer source may live.

Per-repository images stay unplanned until the storage, naming, replacement and deletion questions in the design doc's deferred list have answers.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { shouldRebuildImage } from '../image-refresh.js';

describe('shouldRebuildImage', () => {
  it('rebuilds when the image definition changes', () => {
    expect(shouldRebuildImage(['packages/worker/e2b-javascript/build.ts'])).toBe(true);
  });
  it('does not rebuild for unrelated changes', () => {
    expect(shouldRebuildImage(['packages/worker/src/investigate.ts'])).toBe(false);
  });
  it('does not rebuild for an empty push', () => {
    expect(shouldRebuildImage([])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- image-refresh`
Expected: FAIL, module not found

- [ ] **Step 3: Write minimal implementation**

```ts
/** Paths whose change means the shared image no longer matches its definition. */
const IMAGE_SOURCES = ['packages/worker/e2b-javascript/', 'packages/worker/e2b-python/'];

export function shouldRebuildImage(changedPaths: string[]): boolean {
  return changedPaths.some((p) => IMAGE_SOURCES.some((src) => p.startsWith(src)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- image-refresh && pnpm --filter @opslane/worker build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/image-refresh.ts packages/worker/src/__tests__/image-refresh.test.ts
git commit -m "feat(worker): rebuild the shared image when its definition changes"
```

---

## What has to be answered before C and D can be planned

**C, the Agent SDK.** How do a validator function and a tool schema cross into a process running inside a machine? What replaces forcing the final tool call, which the current loop does with `tool_choice`? What enforces the dollar budget, which the SDK does not offer? And does its built-in `Read`, measured following a symlink out of its working directory, get contained by the machine boundary alone or does it need its own guard?

**D, product context in a machine.** Does the discovery walk move into the machine as a script returning only extracted routes, or does the job change shape so it no longer needs a whole-repository walk? The first is smaller and keeps the existing output; the second is a product question.

Neither is blocked on A or B. Both are blocked on a decision.
