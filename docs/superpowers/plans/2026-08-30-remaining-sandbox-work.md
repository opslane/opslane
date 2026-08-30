# Remaining Sandbox Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the fix job a prebuilt machine image so memory is settable and the per-run Node download disappears, then restrict its outbound network once we know what that breaks.

**Architecture:** The fix job already runs in a rented machine, with unrestricted outbound network and a stock image. It moves onto a saved image first, because the image is what removes its dependence on `nodejs.org`. Only then does the network get restricted, behind a switch, after a probe has measured which hosts real customer repositories actually need.

**Tech Stack:** TypeScript (ESM, strict), `e2b@2.45.0`, Vitest.

**Spec:** `docs/design/2026-08-29-fix-sandbox-reliability-design.md`, milestone two, plus the fix-path egress gap recorded in its Scope section.

## Global Constraints

- ESM and strict TypeScript. Use `unknown` plus narrowing, never `any`.
- Vitest tests colocated in `__tests__`.
- `e2b` is pinned at exactly `2.45.0`. `SandboxOpts` has no `memoryMB`/`cpuCount`; memory is settable only at image build time, where it defaults to 1024.
- E2B returns 400 unless an `allowOut` list is paired with `denyOut` containing `ALL_TRAFFIC`.
- Every task must leave `pnpm --filter @opslane/worker build` and `pnpm --filter @opslane/worker test` passing.

## Order matters here, more than usual

An earlier draft of this plan put the network policy first. That was wrong and would have caused an outage: `ensureModernNode` (`sandbox-repo.ts:91`) downloads Node 22 from `nodejs.org` on every JavaScript run, because the stock E2B image ships 20.9. Restricting the network before the image exists blocks that download and fails every JavaScript fix job before it reaches an install.

So the order is: build the image, switch to it, delete the download, measure what real repositories need, and only then restrict, behind a switch.

Tasks 1 to 3 are safe to deploy on their own and each improves things. Task 5 is the only one that can break a working job, which is why it is last and why it is the only one with a flag.

## Scope

**Planned: the JavaScript image and the fix job's network,** Tasks 1 to 5.

**Not planned: the Claude Agent SDK migration.** It cannot be turned into tasks yet. `ReadOnlyRunInput` carries function-valued fields, `validateTerminal` and the `terminalTool` schema, which cannot be serialized into a process running inside a machine. Three questions need answers first: what protocol carries those across, what replaces `tool_choice` for forcing the final tool call, and what enforces the dollar budget the SDK does not offer. Its built-in `Read` was also measured following a symlink out of its working directory, so it inherits the containment problem rather than solving it.

**Not planned: moving product context into a machine.** Its `discoverRepositoryRoutes` walks the checkout and reads up to 10,000 files to build the model's prompt. A three-method reader turns that into 10,000 round trips, and its multi-line patterns cannot be expressed as `grep`. The likely answer is running the walk itself inside the machine and returning only extracted routes, but that is a design question. Its narrower problem, the model's tools using a text-only path check, is fixed separately on the current branch.

**Not planned: per-repository images.** The design doc's milestone two described images holding each customer's code and dependencies. This plan builds one shared image instead. Per-repository images stay unplanned until the storage, naming, atomic replacement and deletion questions in the design doc's deferred list have answers.

---

## Task 1: Build the shared JavaScript image

**Files:**
- Create: `packages/worker/e2b-javascript/build.ts`
- Create: `packages/worker/e2b-javascript/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a built template named `opslane-javascript-<YYYYMMDD>`, its id recorded in the README.

**Names are versioned, never reused.** Rebuilding a mutable name has no rollback: a bad build silently breaks every later job and there is nothing to point back at. Each build gets a dated name, is verified, and only then does the environment variable move to it. Rolling back is moving that variable to the previous name.

Two facts from the pinned library, measured rather than read from documentation. `SandboxOpts` has no memory field, so an image is the only way to set memory. And `BasicBuildOptions.memoryMB` defaults to 1024, not the 512 the command-line documentation states.

- [ ] **Step 1: Write the build script**

```ts
import { Template } from 'e2b';

/** Pinned, not `latest`: an unpinned npm makes the image nondeterministic and
 * will eventually pick a release that does not support the baked Node. */
const NPM_VERSION = '10.9.2';

/**
 * The shared JavaScript sandbox image.
 *
 * Node 22 is baked in because the stock E2B image ships 20.9, which predates
 * crypto.hash() and breaks modern Vite plugins. Without this, every JavaScript
 * run downloads and unpacks a Node tarball before it can do anything.
 *
 * Memory is set here because there is nowhere else: Sandbox.create takes no
 * memory option in e2b 2.45.
 */
const template = Template()
  .fromNodeImage('22')
  .runCmd(`npm i -g npm@${NPM_VERSION}`);

// Timestamped to the second, not the day: two builds on one day would
// otherwise reuse a name that is supposed to be immutable.
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const NAME = `opslane-javascript-${STAMP}`;

const info = await Template.build(template, NAME, {
  memoryMB: 2048,
  cpuCount: 2,
  onBuildLogs: (entry) => console.log(entry.message),
});
// Print the whole result rather than named fields: the exact shape of BuildInfo
// is the SDK's, and hard-coding field names here would be a guess.
console.log(JSON.stringify(info, null, 2));
```

`name` is a positional argument. The overload that takes `alias` inside the options object is deprecated.

- [ ] **Step 2: Run it**

Run: `E2B_API_KEY=... pnpm --filter @opslane/worker exec tsx e2b-javascript/build.ts`
Expected: a JSON object naming the built template. Copy its name and id into the README beside the Python one, with the date and who built it.

- [ ] **Step 3: Confirm the image is what was asked for**

Boot a sandbox from the template and assert both properties, with exact commands rather than a vague check:

```bash
node --version                                    # expect v22.x
cat /sys/fs/cgroup/memory.max                     # expect ~2147483648, not the 1024MB default
```

If `memory.max` reads `max`, fall back to `free -m` and expect a total above 1500.

- [ ] **Step 4: Build it in every environment that runs jobs**

A template built with a developer key exists only in that E2B project. Record in the README which projects have it, and build it in each before Task 2 deploys anywhere.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/e2b-javascript
git commit -m "feat(worker): prebuilt JavaScript sandbox image"
```

---

## Task 2: Boot the image, and stop downloading Node

**Files:**
- Modify: `packages/worker/src/harness/sandbox-runtime.ts:147`
- Modify: `packages/worker/src/harness/sandbox-repo.ts` (`ensureModernNode`, around line 91)
- Test: `packages/worker/src/harness/__tests__/sandbox-runtime.test.ts`, `packages/worker/src/harness/__tests__/sandbox-repo.test.ts`

**Interfaces:**
- Consumes: the template from Task 1.
- Produces: `class SandboxImageError extends Error` in `harness/errors.ts`, converted to `VerificationInfraError` by `agent-fix.ts`'s catch. `ensureModernNode` is deleted.

**Two failure modes to close before this ships.** If the configured template does not exist in an environment, `Sandbox.create` fails before any of our code runs and every JavaScript job in that environment stops. And if the template exists but is stale, Node 20 comes back silently and surfaces much later as an inscrutable Vite error.

So this task adds a startup preflight and keeps a fast runtime assertion.

The preflight lives in `packages/worker/src/harness/image-preflight.ts` as `assertImageUsable(): Promise<void>`, and `index.ts` awaits it before the poller starts. Create-and-kill is not enough: a stale template creates perfectly well and still carries Node 20, so the preflight runs the **same** `assertModernNode` check inside the machine before killing it. A worker that cannot make a usable machine must not claim jobs.

```ts
export async function assertImageUsable(): Promise<void> {
  const sandbox = await createSandboxRuntime('javascript');
  try {
    await assertModernNode(sandbox);
  } finally {
    await sandbox.kill().catch(() => undefined);
  }
}
```

Its test asserts three things: a missing `OPSLANE_E2B_JAVASCRIPT_TEMPLATE` fails with a configuration message, an image reporting Node 20 fails with the image message, and a healthy image resolves and kills the machine.

**Do not delete the Node check, only the download.** Deleting `ensureModernNode` outright trusts whatever `OPSLANE_E2B_JAVASCRIPT_TEMPLATE` points at. A stale or misconfigured template silently restores Node 20 and the failure surfaces much later as a confusing Vite error. Replace the 180-second download with a one-command assertion that fails fast and says what is wrong.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';

const create = vi.fn(async () => ({ sandboxId: 's', commands: { run: vi.fn() }, files: {}, kill: async () => {} }));
vi.mock('e2b', async (orig) => ({ ...(await orig<typeof import('e2b')>()), Sandbox: { create } }));

describe('createSandboxRuntime', () => {
  it('boots the JavaScript template by name', async () => {
    const { createSandboxRuntime } = await import('../sandbox-runtime.js');
    await createSandboxRuntime('javascript');
    expect(create.mock.calls.at(-1)?.[0]).toBe(process.env['OPSLANE_E2B_JAVASCRIPT_TEMPLATE']);
  });
});
```

And in the sandbox-repo suite, prove the download is gone rather than merely unexported:

```ts
import { readFileSync } from 'node:fs';
it('no JavaScript setup path downloads a Node tarball', () => {
  const src = readFileSync(new URL('../sandbox-repo.ts', import.meta.url), 'utf8');
  expect(src).not.toMatch(/nodejs\.org/);
  expect(src).not.toMatch(/node-v\d+/);
});
it('aborts setup before install when the image has an old Node', async () => {
  // Source-text presence would pass for an unused function. Drive it.
  // createRepoSandbox owns creation, so drive it through the real seam by
  // mocking the runtime factory rather than inventing a parameter.
  vi.doMock('../sandbox-runtime.js', () => ({
    createSandboxRuntime: async () => fakeSandbox({
      'node -e': () => { throw new CommandExitError({ exitCode: 1, stdout: '', stderr: '', error: undefined } as never); },
    }),
  }));
  const { createRepoSandbox } = await import('../sandbox-repo.js');
  await expect(createRepoSandbox({ repoUrl: 'x', platform: 'javascript' }))
    .rejects.toThrow(/does not provide Node 22/);
  expect(sandbox.commands.run).not.toHaveBeenCalledWith(
    expect.stringContaining('npm install'), expect.anything(),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @opslane/worker test -- sandbox-runtime sandbox-repo`
Expected: FAIL on all three

- [ ] **Step 3: Write minimal implementation**

Name the template on the JavaScript path the way the Python path already does:

```ts
// No default. Task 1 builds only timestamped names, so any hard-coded default
// would name a template that was never built. An unset variable is a
// configuration error and must fail loudly at boot, not per job.
const jsTemplate = process.env['OPSLANE_E2B_JAVASCRIPT_TEMPLATE']?.trim();
if (!jsTemplate) throw new Error('OPSLANE_E2B_JAVASCRIPT_TEMPLATE is not set');
return adaptE2BSandbox(await Sandbox.create(jsTemplate, { timeoutMs: lifetimeMs }), lifetimeMs, createdAt);
```

Replace `ensureModernNode` with:

```ts
/**
 * Confirm the image really has a modern Node, without downloading one.
 *
 * The image is supposed to supply this, but the template name is an environment
 * variable and a stale one silently reintroduces Node 20. Failing here names the
 * cause; failing later surfaces as an inscrutable Vite error.
 */
async function assertModernNode(sandbox: SandboxRuntime): Promise<void> {
  try {
    // Assert the major version, not a feature. crypto.hash landed in late Node
    // 20, so a feature probe passes on the very image this exists to reject.
    await sandbox.commands.run(
      `node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"`,
      { timeoutMs: 15_000 },
    );
  } catch (err: unknown) {
    // Only a command that ran and failed says anything about the image. A
    // timeout or a dead machine must keep its own meaning and its own lane.
    if (!isCommandFailure(err)) throw err;
    // A dedicated class, not a plain Error: a plain one reaches agent-fix's
    // catch-all and terminalizes as worker_runtime_error, which is the exact
    // useless-card failure this whole line of work started from. agent-fix
    // converts this into VerificationInfraError, where the evidence record is.
    throw new SandboxImageError(
      'The sandbox image does not provide Node 22 or newer. Check OPSLANE_E2B_JAVASCRIPT_TEMPLATE.',
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @opslane/worker test && pnpm --filter @opslane/worker build`
Expected: PASS

Then measure a real fix run and compare setup duration against the 168 seconds recorded on 2026-08-28.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src
git commit -m "feat(worker): boot the JavaScript image instead of installing Node per run"
```

---

## Task 3: Measure what real repositories need, before restricting anything

**Files:**
- Create: `packages/worker/scripts/probe-install-hosts.ts`
- Create: `docs/evidence/2026-08-30-install-host-probe.md`

**Interfaces:**
- Consumes: `Sandbox` from `e2b` directly.
- Produces: nothing importable. Its output is evidence, and it gates Task 5.

**This is a gate, not a nice-to-have.** One dependency tree has been measured: 199 packages installed with only `registry.npmjs.org` and `github.com` reachable. That is one repository, not a rule. Real trees reach further, and the specific packages are known: Playwright fetches browsers from a CDN, Puppeteer from Chrome-for-Testing storage, Cypress from its own CDN, `node-gyp` from `nodejs.org`, and native packages like older `sharp` and `canvas` from GitHub release assets.

GitHub is also not one host. Clones and archives use `codeload.github.com`, raw files use `raw.githubusercontent.com`, and release binaries use `objects.githubusercontent.com` and `release-assets.githubusercontent.com`.

- [ ] **Step 1: Write the probe**

**JavaScript repositories only.** Task 5's rollout is JavaScript-only for the same reason: no Python repository has been probed, and restricting a path nobody measured is how you break it.

For each connected JavaScript repository, boot a machine from the Task 1 template with a candidate allowlist, clone, install, and record the outcome. Use the repository's own package manager, detected from its lockfile, with a 300 second install timeout.

**Credentials.** A GitHub App installation token is minted from app credentials plus an installation id, not read off a repository row; `projects.github_repo` is only a name. One token also cannot span installations, and these tokens expire inside the hour while each repository takes two runs of up to 300 seconds.

So the probe takes a JSON map from installation id to token, `PROBE_GITHUB_TOKENS`, refuses to start without it, and re-reads the file before each repository so an operator can refresh it mid-run. A repository whose installation has no entry is skipped and recorded as unprobed, never silently attempted without credentials.

**Pin the commit.** Resolve one commit SHA per repository up front and check that exact SHA out in both runs. Without it, a push between the baseline and restricted clones changes the dependency tree underneath the comparison and the result means nothing.

**The candidate allowlist is an input, not a constant.** This task runs before `buildFixNetwork` exists. The probe takes the candidate host list as an argument so the same script can re-run as the list changes; Task 4 then encodes whatever this measured.

**Remove the credential before installing.** This is not optional and an earlier draft missed it. Install scripts are customer-controlled code, and the baseline run has unrestricted network by design, so a token still present during install can be read and sent anywhere. Order is: write the credential, clone, prove removal with `rm -f /home/user/.netrc && test ! -e /home/user/.netrc`, and only then install. If removal cannot be proven, destroy the machine and record that repository as unprobed.

Run each repository twice: once with the network unrestricted to get a baseline, once with the candidate allowlist. A repository that fails both ways is broken independently and must not be counted against the allowlist.

- [ ] **Step 2: Run it against every connected repository**

Run: `pnpm --filter @opslane/worker exec tsx scripts/probe-install-hosts.ts`
Expected: a table with a row per repository: baseline result, restricted result, and any host named in the restricted failure.

- [ ] **Step 3: Accept that some failures will not name a host**

A blocked connection can surface as a TLS reset or a bare socket error with no hostname. When that happens, re-run that repository with the allowlist widened one host at a time from the known list above, and record which addition fixed it. Write every result into the evidence document, including the ones that stayed unexplained.

**Anonymise what gets committed.** The evidence file goes into the repository, so it records per-repository outcomes by opaque index, plus the hosts and packages involved. Repository names, URLs, tokens and raw install logs stay out of version control. The mapping from index to repository stays local to whoever ran it.

- [ ] **Step 4: Decide from the results, do not guess**

If every repository passes on a small list, Task 4 uses it. If several need scattered hosts, that is a signal an allowlist is the wrong shape for the fix path, and it goes back to the user rather than being widened quietly until it stops failing.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/scripts/probe-install-hosts.ts docs/evidence
git commit -m "test(worker): measure which hosts real dependency trees need"
```

---

## Task 4: A policy for a machine that holds no credential

**Files:**
- Modify: `packages/worker/src/harness/sandbox-network.ts`
- Test: `packages/worker/src/harness/__tests__/sandbox-network.test.ts`

**Interfaces:**
- Consumes: `ReadOnlyNetwork` and `ALL_TRAFFIC` (already in this file), plus Task 3's measured host list.
- Produces: `buildFixNetwork(platform: Platform): ReadOnlyNetwork`

The fix machine's policy injects no credential, and that is not an oversight. The model runs on the worker and only commands cross into the machine, so no API key ever enters it. That removes the whole class of problem the read-only policy needed a proxy rule to solve.

One honest limit. This policy governs what our harness needs. Customer code, install scripts, tests and builds can call anything, and when the policy blocks them the failure appears as a test or build failure rather than a policy failure. Task 5's rollout is what makes that discoverable.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { ALL_TRAFFIC } from 'e2b';
import { buildFixNetwork } from '../sandbox-network.js';

describe('buildFixNetwork', () => {
  it('denies everything by default', () => {
    expect(buildFixNetwork('javascript').denyOut).toEqual([ALL_TRAFFIC]);
  });

  it('allows the GitHub hosts a clone and a release asset actually use', () => {
    const allow = buildFixNetwork('javascript').allowOut;
    for (const host of ['github.com', 'codeload.github.com', 'objects.githubusercontent.com',
                        'raw.githubusercontent.com', 'release-assets.githubusercontent.com']) {
      expect(allow).toContain(host);
    }
  });

  it('allows the JavaScript registry and the Node download host', () => {
    const allow = buildFixNetwork('javascript').allowOut;
    expect(allow).toContain('registry.npmjs.org');
    // node-gyp fetches headers from here even with Node baked into the image.
    expect(allow).toContain('nodejs.org');
  });

  it('allows the Python registries on the Python path', () => {
    const allow = buildFixNetwork('python');
    expect(allow.allowOut).toContain('pypi.org');
    expect(allow.allowOut).toContain('files.pythonhosted.org');
  });

  it('injects no credential, because none enters this machine', () => {
    expect(buildFixNetwork('javascript').rules).toEqual({});
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
/** GitHub serves clones, raw files and release binaries from different hosts. */
const GITHUB_HOSTS = [
  'github.com', 'codeload.github.com',
  'raw.githubusercontent.com', 'objects.githubusercontent.com',
  // Release downloads commonly redirect here.
  'release-assets.githubusercontent.com',
];

/**
 * What a dependency install has to reach, per platform.
 *
 * Every entry beyond the registries is here because Task 3's probe measured a
 * real repository needing it. Do not add a host without a probe result.
 */
const FIX_HOSTS: Record<Platform, string[]> = {
  javascript: ['registry.npmjs.org', 'nodejs.org', ...GITHUB_HOSTS],
  python: ['pypi.org', 'files.pythonhosted.org', ...GITHUB_HOSTS],
};

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

## Task 5: Apply the policy, decided by the caller, off by default

**Files:**
- Modify: `packages/worker/src/harness/sandbox-runtime.ts:134,147,150`
- Modify: `packages/worker/src/harness/sandbox-repo.ts:156` (`createRepoSandbox` options)
- Modify: `packages/worker/src/agent-fix.ts` (the `createRepoSandbox` call, around line 607)
- Test: `packages/worker/src/harness/__tests__/sandbox-runtime.test.ts`, `packages/worker/src/__tests__/agent-fix.test.ts`
- Modify: `packages/worker/scripts/verify-isolation.ts`

**Interfaces:**
- Consumes: `buildFixNetwork` (Task 4).
- Produces: `createSandboxRuntime(platform, network?)` and `createRepoSandbox({ ..., network? })`. Both default to `undefined`, which is today's behaviour.

**The decision does not belong in `createSandboxRuntime`.** An earlier draft read an environment variable there. That function knows neither the project nor the job type, so a process-wide variable would restrict evaluation and reliability-harness runs alongside fix jobs, and "enable for one project" would be impossible.

So the policy is passed in. `createSandboxRuntime` and `createRepoSandbox` each gain an optional `network` parameter and apply whatever they are handed. The fix dispatch in `agent-fix.ts` is the only place that decides, because it is the only place holding the project id.

The caller chain is short and was verified: `createSandboxRuntime` has exactly one caller, `createRepoSandbox` at `sandbox-repo.ts:156`, which is called from the fix path. Nothing else has to change, and anything that later calls either function inherits `undefined` and stays unrestricted until it opts in.

**Rollout is a named list of project ids, and this is the specification, not a choice for the implementer.** `FIX_SANDBOX_EGRESS_PROJECTS` holds a comma-separated list of project uuids. Empty or unset means nobody is restricted, which is today's behaviour and the default in every environment. Parsing trims whitespace, ignores empty entries, and lowercases before comparing. An entry that is not a uuid is a configuration error logged once at boot, not silently dropped.

An environment variable rather than a database column on purpose: this is a short-lived rollout control, and adding a column means a migration plus a way to unset it that outlives the rollout it exists for.

```ts
/** Projects whose fix machines get the restricted policy. Empty means none. */
export function isEgressRolloutProject(projectId: string): boolean {
  const raw = process.env['FIX_SANDBOX_EGRESS_PROJECTS'] ?? '';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .includes(projectId.toLowerCase());
}
```

**Rollback is turning it off, not reverting the code.** A machine already running keeps the policy it was created with. Turning the setting off takes effect on the next machine; in-flight jobs finish under the old one.

**JavaScript only for now.** Task 3 probed JavaScript repositories. No Python repository has been measured, and Python installs reach different hosts, VCS dependencies and custom indexes. The decision returns `undefined` for the Python platform until an equivalent Python probe exists.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ALL_TRAFFIC } from 'e2b';

const create = vi.fn(async () => ({ sandboxId: 's', commands: { run: vi.fn() }, files: {}, kill: async () => {} }));
vi.mock('e2b', async (orig) => ({ ...(await orig<typeof import('e2b')>()), Sandbox: { create } }));

describe('createSandboxRuntime network policy', () => {
  beforeEach(() => { create.mockClear(); vi.resetModules(); });

  it('applies no policy when the caller passes none, preserving today behaviour', async () => {
    const { createSandboxRuntime } = await import('../sandbox-runtime.js');
    await createSandboxRuntime('javascript');
    expect((create.mock.calls.at(-1)?.[1] as { network?: unknown }).network).toBeUndefined();
  });

  it('applies exactly the policy the caller passes', async () => {
    const { createSandboxRuntime } = await import('../sandbox-runtime.js');
    const { buildFixNetwork } = await import('../sandbox-network.js');
    await createSandboxRuntime('javascript', buildFixNetwork('javascript'));
    const net = (create.mock.calls.at(-1)?.[1] as { network?: { denyOut: string[] } }).network;
    expect(net?.denyOut).toEqual([ALL_TRAFFIC]);
  });
});
```

And in the fix-path suite, prove the scoping rather than the plumbing:

```ts
it('restricts a project on the rollout list', async () => {
  const opts = await captureRepoSandboxOptions({ projectId: ROLLOUT_PROJECT, platform: 'javascript' });
  expect(opts.network?.denyOut).toEqual([ALL_TRAFFIC]);
});

it('leaves a project not on the list unrestricted', async () => {
  const opts = await captureRepoSandboxOptions({ projectId: OTHER_PROJECT, platform: 'javascript' });
  expect(opts.network).toBeUndefined();
});

it('leaves Python unrestricted even on the rollout list, because it was never probed', async () => {
  const opts = await captureRepoSandboxOptions({ projectId: ROLLOUT_PROJECT, platform: 'python' });
  expect(opts.network).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @opslane/worker test -- sandbox-runtime agent-fix`
Expected: FAIL, `createSandboxRuntime` takes one argument and nothing scopes by project

- [ ] **Step 3: Write minimal implementation**

Thread the parameter:

```ts
export async function createSandboxRuntime(
  platform: Platform = 'javascript',
  network?: ReadOnlyNetwork,
): Promise<SandboxRuntime> {
```

and pass `network` into both `Sandbox.create` calls. Do the same through `createRepoSandbox`. Then in `agent-fix.ts`, decide once:

```ts
/**
 * Restrict this machine's network only for projects on the rollout list, and
 * only on the platform that was probed. Returning undefined is today's
 * behaviour, which is what makes this safe to deploy before it is enabled.
 */
const network = platform === 'javascript' && isEgressRolloutProject(input.projectId)
  ? buildFixNetwork(platform)
  : undefined;
```

Add the live check to `scripts/verify-isolation.ts`: in a machine built with `buildFixNetwork('javascript')`, install a package whose dependency points at a host outside the list, catch the real failure, and assert `classifyInstallFailure` returns `infrastructure`. Same shape as the check that already passes for the read-only policy.

- [ ] **Step 4: Run tests, then verify live**

Run: `pnpm --filter @opslane/worker test && pnpm --filter @opslane/worker build`
Expected: PASS

Then: `pnpm --filter @opslane/worker exec tsx scripts/verify-isolation.ts`
Expected: all checks pass, including the new one

- [ ] **Step 5: Enable for one project, then watch**

Add one project to the rollout list. Watch its fix jobs for a week, specifically for install failures newly classified as `infrastructure`, which is what a missing host looks like. Widen only after a clean week.

**Watch for failures the classifier does not cover.** Install failures are classified. A blocked clone, setup command, test or build is not: those take their own paths and can surface as a test failure or `worker_runtime_error` rather than a policy problem. During the rollout week, treat any new failure on that project as a suspected policy block until proven otherwise, and check the machine's allowlist first.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src packages/worker/scripts
git commit -m "feat(worker): optional egress policy for fix machines, per project"
```

---

## Deliberately not included

**Automatic image rebuilds.** An earlier draft had a `shouldRebuildImage` function that classified changed paths. Nothing called it, from CI, the push handler, a queue job or deployment. It was dead code dressed as a feature. Rebuilding the shared image is a manual step in Task 1 until something actually dispatches it, and the README records which environments have which build.

**Restricting anything outside the fix path.** Only `agent-fix.ts` opts in. `createSandboxRuntime` and `createRepoSandbox` apply whatever policy they are handed and default to none, so any future caller is unrestricted until it explicitly asks otherwise.
