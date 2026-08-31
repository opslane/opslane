# Finishing the Sandbox Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish what the read-only isolation change started. Give the fix job a prebuilt image and a restricted network, move the last read-only job into a sandbox, and replace the hand-written agent loop with the Claude Agent SDK.

**Architecture:** One shared machine image with Node 22 baked in, which is the only place E2B lets memory be set. The fix job's network gets restricted after a probe measures what real repositories need. Product context stops walking the repository mechanically and lets the agent find routes instead, which removes the reason it could not move. The hand-written turn loop is then replaced by the SDK's, which stays on the worker: a spike showed the SDK can drive custom tools whose handlers execute in the machine, so nothing sensitive has to cross.

**Tech Stack:** TypeScript (ESM, strict), `e2b@2.45.0`, `@anthropic-ai/claude-agent-sdk@0.3.251`, Vitest.

**Spec:** `docs/design/2026-08-29-fix-sandbox-reliability-design.md`, plus the decisions and spike results recorded below.

## Who this runs for

One operator, in production, today. That is the single most important fact for sizing everything below, and several tasks were written before it was clear.

It means a broken fix job is the author's own broken fix job, seen within minutes, not a customer incident. So the plan prefers shipping a change and learning from a real failure over gating on a measurement. Where a task still reads cautiously, that caution is about not losing information, not about blast radius.

Two things it does not change. The isolation work still matters, because the repositories being read are real and the credentials on the worker are real. And a measurement is still worth taking when it is cheap, because "we found out by breaking it" is a fine strategy only when you notice.

## Global Constraints

- ESM and strict TypeScript. Use `unknown` plus narrowing, never `any`.
- Vitest tests colocated in `__tests__`.
- `e2b` is pinned at exactly `2.45.0`. `SandboxOpts` has no `memoryMB`/`cpuCount`; memory is settable only at image build time.
- E2B returns 400 unless an `allowOut` list is paired with `denyOut` containing `ALL_TRAFFIC`.
- Every task must leave `pnpm --filter @opslane/worker build` and `pnpm --filter @opslane/worker test` passing.

## Decisions already taken

These were settled in discussion. An implementer does not reopen them.

- **One shared image, not one per repository.** Per-customer images stay unbuilt until the fix job's network is restricted and install time is measured again.
- **Product context gets Bash inside its sandbox.** It is a wider tool surface than the other three jobs, and the run stops being purely observational, which is the accepted cost.

  One caveat with an ordering consequence. Review pointed out that while the read-only policy still allows `api.anthropic.com` with our key injected, a shell in that machine could issue arbitrary billable Anthropic requests without ever seeing the key. Task 9 removes that host, which closes it. **So Task 6 must land after Task 9**, or the shell arrives while the door is still open.
- **Net-more-routes beats deterministic coverage.** The agent found 58 routes to the mechanical walk's 47 and missed two the walk caught. Route discovery feeds triage, so a missed route means one page whose purpose is unknown, not a broken system.
- **The SDK's loop runs on the worker, not in the machine.** Measured, not assumed. Which means the credential, the validator and the dollar cap all stay put, and the machine never needs to reach Anthropic.

## What the spikes measured

Run against real systems on 2026-08-30 and 2026-08-31. These are results, not assumptions.

| Spike | Result |
|---|---|
| `Template.build` with `memoryMB: 2048` | Built in 12s. `node=v22.23.2`, `npm=10.9.8`, memory reports **1982MB**. `BuildInfo` has `alias`, `name`, `tags`, `templateId`, `buildId`. |
| `npm i -g` as a build step | **Fails.** Build steps run as a non-root user: `EACCES ... rename '/usr/local/lib/node_modules/npm'`. Unnecessary anyway, Node 22 bundles npm 10.9.8. |
| Mechanical route walk, real repository | 47 routes, 2321ms, no model. |
| Agent finding routes, same repository, no discovery block | 58 routes, 21s, $0.056, 5 turns, **4 Bash calls**. Missed `/assets/:asset_id` and `/callback`; found a whole `/loanees` section the walk did not. |
| Agent SDK headless | Returns `{subtype, total_cost_usd, num_turns, result}`. Installs inside a sandbox in 11s. |
| Agent SDK built-in `Read` | **Follows a symlink out of its working directory.** It does not solve containment; the machine boundary does. |
| SDK loop on the worker, custom tools executing in a sandbox | **Works.** Model called only `mcp__repo__read_file` and `mcp__repo__list_files`, each running a command in a real machine. Every built-in file tool refused. 4 turns, $0.064, correct answer. `ToolSearch` still appeared, so `disallowedTools` is a blocklist and an allowlist is required. |
| Sandbox command round trip | 174ms median over 12 calls. Twenty tool calls costs ~3.5s on a job that takes three minutes. |
| `interrupt()` called inside a tool handler | **Unusable.** Does not deadlock, but throws out of the iterator: `Claude Code returned an error result: [ede_diagnostic]`. The submission was captured and the run still ended in an error state. |
| Record in the handler, break the loop outside | **Works.** Handler records and returns; consumer breaks the `for await` and calls `return()`. Clean completion, answer captured, priced $0.00046 from per-turn usage. This is the termination protocol. |
| SDK per-turn usage | **Available mid-stream.** Assistant messages carry `usage.input_tokens`/`output_tokens` as they arrive, not only on the final result. The query object exposes `interrupt()` and `return()`. So a dollar cap can still be enforced during the run. |
| Deny-all egress plus proxy-injected key | Anthropic reachable from inside with no key sent (200), zero `sk-ant-` in the machine's environment, non-allowlisted hosts blocked. |

---

## Task 1: Build the shared JavaScript image

**Files:**
- Create: `packages/worker/e2b-javascript/build.ts`
- Create: `packages/worker/e2b-javascript/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a built template named `opslane-javascript-<YYYYMMDDHHMMSS>`, its id recorded in the README.

**Names are versioned and never reused.** Rebuilding a mutable name has no rollback: a bad build silently breaks every later job with nothing to point back at. Timestamped to the second, not the day, because two builds on one day would otherwise collide.

**Do not add an `npm i -g` step.** The spike proved it fails: build steps run as a non-root user and the global install cannot write to `/usr/local/lib/node_modules`. It is also pointless, since the Node 22 image already carries npm 10.9.8.

- [ ] **Step 1: Write the build script**

```ts
import { randomBytes } from 'node:crypto';
import { Template } from 'e2b';

/**
 * The shared JavaScript sandbox image.
 *
 * Node 22 is baked in because the stock E2B image ships 20.9, which predates
 * crypto.hash() and breaks modern Vite plugins. Without this, every JavaScript
 * run downloads and unpacks a Node tarball first, on a 180 second budget.
 *
 * Memory is set here because there is nowhere else: Sandbox.create takes no
 * memory option in e2b 2.45.
 */
// Timestamp plus a random suffix: two builds started in the same second would
// otherwise collide on a name that is supposed to be immutable.
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const SUFFIX = randomBytes(3).toString('hex');
const NAME = `opslane-javascript-${STAMP}-${SUFFIX}`;

const info = await Template.build(Template().fromNodeImage('22'), NAME, {
  memoryMB: 2048,
  cpuCount: 2,
  onBuildLogs: (entry) => console.log(entry.message),
});
console.log(JSON.stringify(info, null, 2));
```

`name` is a positional argument; the overload taking `alias` inside the options is deprecated.

- [ ] **Step 2: Run it**

Run: `E2B_API_KEY=... pnpm --filter @opslane/worker exec tsx e2b-javascript/build.ts`
Expected: a JSON object with `name`, `templateId` and `buildId`. Build takes about 12 seconds.

- [ ] **Step 3: Verify the image is what was asked for**

Boot a sandbox from it and run exactly these:

```bash
node --version                                        # expect v22.x
free -m | awk '/Mem:/{print $2}'                      # expect > 1024
```

Assert **greater than 1024**, not equal to 2048. The spike measured 1982 for a 2048 request; the difference is machine overhead and is expected.

- [ ] **Step 4: Build it in every environment that runs jobs**

A template built with one key exists only in that E2B project, so build it wherever jobs run. With one operator that is likely one project, and this step is a minute rather than a coordination problem. Record the name and id in the README with the date.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/e2b-javascript
git commit -m "feat(worker): prebuilt JavaScript sandbox image"
```

---

## Task 2: Boot the image, and stop downloading Node

**Files:**
- Modify: `packages/worker/src/harness/sandbox-runtime.ts`
- Modify: `packages/worker/src/harness/sandbox-repo.ts` (`ensureModernNode`)
- Create: `packages/worker/src/harness/image-check.ts` (exports `assertModernNode`, shared by preflight and repository setup)
- Create: `packages/worker/src/harness/image-preflight.ts`
- Modify: `packages/worker/src/harness/errors.ts` (add `SandboxImageError`)
- Modify: `packages/worker/src/agent-fix.ts` (convert `SandboxImageError` in the outer catch)
- Modify: `packages/worker/src/index.ts` (await the preflight before polling)
- Test: `packages/worker/src/harness/__tests__/sandbox-runtime.test.ts`, `.../sandbox-repo.test.ts`

**Interfaces:**
- Consumes: the template from Task 1.
- Produces: `assertModernNode` in `harness/image-check.ts`, and `class SandboxImageError extends Error` in `harness/errors.ts`. `ensureModernNode` is deleted.

Two failure modes to close. If the configured template does not exist in an environment, `Sandbox.create` fails before any of our code runs and every JavaScript job there stops. If it exists but is stale, Node 20 returns silently and surfaces later as an inscrutable Vite error.

**No worker-boot preflight.** An earlier draft added one, checking the template at startup and refusing to poll if it failed. That is the wrong trade here: it turns a bad template into a dead worker that claims nothing, instead of one failed fix job every ten days. The per-run assertion below already names the cause, and fix jobs are rare enough that finding out on the next one is fine.

**No default template name.** Task 1 builds only timestamped names, so any hard-coded default names something that was never built. An unset variable is a configuration error that fails at boot.

- [ ] **Step 1: Write the failing tests**

```ts
// sandbox-runtime.test.ts
it('boots the configured template by name', async () => {
  process.env['OPSLANE_E2B_JAVASCRIPT_TEMPLATE'] = 'opslane-javascript-20260831000303';
  const { createSandboxRuntime } = await import('../sandbox-runtime.js');
  await createSandboxRuntime('javascript');
  expect(create.mock.calls.at(-1)?.[0]).toBe('opslane-javascript-20260831000303');
});

it('refuses to start with no template configured', async () => {
  delete process.env['OPSLANE_E2B_JAVASCRIPT_TEMPLATE'];
  const { createSandboxRuntime } = await import('../sandbox-runtime.js');
  await expect(createSandboxRuntime('javascript')).rejects.toThrow(/OPSLANE_E2B_JAVASCRIPT_TEMPLATE/);
});
```

```ts
// sandbox-repo.test.ts , prove the download is gone, and the check is not
it('no JavaScript setup path downloads a Node tarball', () => {
  const src = readFileSync(new URL('../sandbox-repo.ts', import.meta.url), 'utf8');
  expect(src).not.toMatch(/nodejs\.org/);
  expect(src).not.toMatch(/node-v\d+/);
});

it('aborts setup before install when the image has an old Node', async () => {
  vi.doMock('../sandbox-runtime.js', () => ({
    createSandboxRuntime: async () => fakeSandbox({
      'node -e': () => { throw new CommandExitError({ exitCode: 1, stdout: '', stderr: '', error: undefined } as never); },
    }),
  }));
  const { createRepoSandbox } = await import('../sandbox-repo.js');
  await expect(createRepoSandbox({ repoUrl: 'x', platform: 'javascript' }))
    .rejects.toThrow(/does not provide Node 22/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @opslane/worker test -- sandbox-runtime sandbox-repo image-preflight`
Expected: FAIL on all

- [ ] **Step 3: Write minimal implementation**

```ts
const jsTemplate = process.env['OPSLANE_E2B_JAVASCRIPT_TEMPLATE']?.trim();
if (!jsTemplate) throw new Error('OPSLANE_E2B_JAVASCRIPT_TEMPLATE is not set');
```

`assertModernNode` lives in its own module, exported, because both the preflight and repository setup call it. Leaving it private to `sandbox-repo.ts` makes the preflight uncompilable.

Replace `ensureModernNode` with an assertion that checks the major version, not a feature. `crypto.hash` landed late in Node 20, so a feature probe passes on the very image this exists to reject:

```ts
async function assertModernNode(sandbox: SandboxRuntime): Promise<void> {
  try {
    await sandbox.commands.run(
      `node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"`,
      { timeoutMs: 15_000 },
    );
  } catch (err: unknown) {
    // Only a command that ran and failed says anything about the image. A
    // timeout or a dead machine keeps its own meaning and its own lane.
    if (!isCommandFailure(err)) throw err;
    throw new SandboxImageError(
      'The sandbox image does not provide Node 22 or newer. Check OPSLANE_E2B_JAVASCRIPT_TEMPLATE.',
    );
  }
}

```

`SandboxImageError` is its own class, not a plain `Error`: a plain one reaches the catch-all in `agent-fix.ts` and terminalizes as `worker_runtime_error`, which is the useless-card failure this whole line of work started from. `agent-fix.ts` converts it into `VerificationInfraError`, where the evidence record exists.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @opslane/worker test && pnpm --filter @opslane/worker build`
Expected: PASS

Then measure a real fix run against the 168 seconds of setup recorded on 2026-08-28.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src
git commit -m "feat(worker): boot the JavaScript image instead of installing Node per run"
```

---

## Task 3: Measure what real repositories need, before restricting anything

**Files:**
- Create: `packages/worker/scripts/probe-install-hosts.ts`
- Create: `docs/evidence/2026-08-31-install-host-probe.md`

**Interfaces:**
- Consumes: `Sandbox` from `e2b` directly, plus a candidate host list as an argument.
- Produces: nothing importable. Its output gates Task 5.

**Not a gate. Information.** An earlier draft made this a hard gate before Task 5, sized for a customer base that does not exist. With one operator in production, shipping the policy and finding the missing host from a real failure is a legitimate strategy, and often faster than probing everything first.

Run it if it is convenient, because it is cheap and it tells you the answer without breaking anything. Skip it and Task 5 still ships; the Slack alert is what makes the failure legible.

One dependency tree has been measured: 199 packages installed with only `registry.npmjs.org` and `github.com` reachable. That is one repository, not a rule. Playwright fetches browsers from a CDN, Puppeteer from Chrome-for-Testing storage, Cypress from its own CDN, `node-gyp` from `nodejs.org`, and native packages like older `sharp` from GitHub release assets. GitHub itself is several hosts: clones use `codeload.github.com`, raw files `raw.githubusercontent.com`, release binaries `objects.githubusercontent.com` and `release-assets.githubusercontent.com`.

**JavaScript repositories only.** No Python repository has been probed, and Task 5 restricts nothing on the Python path for that reason.

**Credentials.** A GitHub App installation token is minted from app credentials plus an installation id, not read off a repository row. One token cannot span installations, and they expire inside the hour while each repository needs two runs of up to 300 seconds. So the probe takes a **path** to a JSON file mapping installation id to token, in `PROBE_GITHUB_TOKENS_FILE`, refuses to start without it, and re-reads that file before each repository so an operator can refresh tokens mid-run. It cannot be an environment variable: a running process never sees an updated environment. A repository whose installation has no entry is skipped and recorded as unprobed, never attempted uncredentialed.

**Remove the credential before installing.** Install scripts are customer-controlled code and the baseline run has unrestricted network by design, so a token still on disk during install can be read and sent anywhere. Order: write the credential, clone, prove removal with `rm -f /home/user/.netrc && test ! -e /home/user/.netrc`, then install. If removal cannot be proven, destroy the machine and record the repository as unprobed.

**Pin the commit.** Resolve one SHA per repository up front and check that exact SHA out in both runs. A push between clones otherwise changes the tree underneath the comparison.

- [ ] **Step 1: Write the probe**

For each JavaScript repository: boot from the Task 1 template, clone, prove credential removal, install. Run twice, once unrestricted for a baseline and once with the candidate allowlist. A repository failing both ways is broken independently and is not counted against the allowlist.

- [ ] **Step 2: Run it against every connected JavaScript repository**

Run: `pnpm --filter @opslane/worker exec tsx scripts/probe-install-hosts.ts`
Expected: a table per repository with baseline result, restricted result, and any host named in the restricted failure.

- [ ] **Step 3: Accept that some failures name no host**

A blocked connection can surface as a TLS reset or a bare socket error. When that happens, re-run that repository widening the allowlist one host at a time from the list above, and record which addition fixed it.

- [ ] **Step 4: Write anonymised evidence**

The evidence file goes into the repository, so record outcomes by opaque index plus the hosts and packages involved. Repository names, URLs, tokens and raw install logs stay out of version control.

- [ ] **Step 5: Decide from the results**

Encode whatever the probe measured into Task 4, including scattered per-repository hosts. The decision is to ship restricted and let real failures teach us rather than holding the boundary back until the list is perfect. That is safe here because the failures land on the author.

It only works if a failure is legible, so Task 5 carries a Slack alert.

- [ ] **Step 6: Commit**

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
- Consumes: `ReadOnlyNetwork`, `ALL_TRAFFIC`.

**This is the bootstrap policy, and it does not wait for Task 3.** The hosts below are the starting list: the two measured in the one install that has been run, plus the GitHub hosts that clones, raw files and release binaries actually use, plus `nodejs.org` for `node-gyp`. Task 3 is optional and may amend this list; if it never runs, this ships as it stands and a real failure amends it.
- Produces: `buildFixNetwork(platform: Platform): ReadOnlyNetwork`

The fix machine injects no credential, and that is not an oversight. The model runs on the worker and only commands cross into the machine, so no key ever enters it. That removes the class of problem the read-only policy needed a proxy rule for.

One honest limit: this governs what our harness needs. Customer code, install scripts, tests and builds can call anything, and when the policy blocks them the failure appears as a test or build failure rather than a policy failure.

- [ ] **Step 1: Write the failing test**

```ts
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
  it('allows the registry and the Node header host node-gyp needs', () => {
    const allow = buildFixNetwork('javascript').allowOut;
    expect(allow).toContain('registry.npmjs.org');
    expect(allow).toContain('nodejs.org');
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
  'github.com', 'codeload.github.com', 'raw.githubusercontent.com',
  'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
];

/**
 * What a dependency install has to reach, per platform. Every entry beyond the
 * registries is here because Task 3 measured a real repository needing it.
 * Do not add a host without a probe result.
 */
const FIX_HOSTS: Record<Platform, string[]> = {
  javascript: ['registry.npmjs.org', 'nodejs.org', ...GITHUB_HOSTS],
  python: ['pypi.org', 'files.pythonhosted.org', ...GITHUB_HOSTS],
};

export function buildFixNetwork(platform: Platform): ReadOnlyNetwork {
  return { denyOut: [ALL_TRAFFIC], allowOut: [...(FIX_HOSTS[platform] ?? FIX_HOSTS.javascript)], rules: {} };
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

## Task 5: Apply the policy, on by default for JavaScript

**Files:**
- Modify: `packages/worker/src/harness/sandbox-runtime.ts`, `.../sandbox-repo.ts`, `packages/worker/src/agent-fix.ts`
- Test: `.../__tests__/sandbox-runtime.test.ts`, `packages/worker/src/__tests__/agent-fix.test.ts`
- Modify: `packages/worker/scripts/verify-isolation.ts`

**Interfaces:**
- Consumes: `buildFixNetwork` (Task 4).
- Produces: `createSandboxRuntime(platform, network?)` and `createRepoSandbox({ ..., network? })`, both defaulting to `undefined`, which is today's behaviour.

**The decision does not belong in `createSandboxRuntime`.** That function knows neither the platform in context nor the job type, so deciding there would restrict evaluation and reliability-harness runs alongside fix jobs. The policy is passed in, and `agent-fix.ts` decides.

The chain was verified: `createSandboxRuntime` has exactly one caller, `createRepoSandbox` at `sandbox-repo.ts:156`, called from the fix path.

**On by default, for JavaScript only.** An earlier draft shipped this behind a per-project list that someone had to opt projects into. That was wrong for this system: a switch requiring a manual step is a switch nobody flips, and the security value stays zero while the code sits there. At two fix jobs a fortnight across five customers, a per-project rollout list would have contained everyone on day one.

So the policy applies wherever Task 3 measured it, which is the JavaScript path. Python keeps today's open egress: its installs reach PyPI mirrors, VCS dependencies and custom indexes that nobody has probed, and restricting an unmeasured path is how you break it quietly.

`FIX_SANDBOX_EGRESS_DISABLED=1` turns it off entirely, as an escape hatch rather than a rollout control.

**Rollback is turning it off, not reverting.** A machine already running keeps the policy it was created with.

**JavaScript only.** Task 3 probed JavaScript. The decision returns `undefined` for Python until an equivalent probe exists.

- [ ] **Step 1: Write the failing test**

```ts
it('applies no policy when the caller passes none', async () => {
  await createSandboxRuntime('javascript');
  expect((create.mock.calls.at(-1)?.[1] as { network?: unknown }).network).toBeUndefined();
});

it('restricts JavaScript by default', async () => {
  const opts = await captureRepoSandboxOptions({ platform: 'javascript' });
  expect(opts.network?.denyOut).toEqual([ALL_TRAFFIC]);
});

it('never restricts Python, because Task 3 never probed it', async () => {
  const opts = await captureRepoSandboxOptions({ platform: 'python' });
  expect(opts.network).toBeUndefined();
});

it('honours the escape hatch', async () => {
  process.env['FIX_SANDBOX_EGRESS_DISABLED'] = '1';
  const opts = await captureRepoSandboxOptions({ platform: 'javascript' });
  expect(opts.network).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @opslane/worker test -- sandbox-runtime agent-fix`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**


In `agent-fix.ts`:

```ts
// On for JavaScript, which Task 3 measured. Never for Python, which it did not.
const network = platform === 'javascript' && process.env['FIX_SANDBOX_EGRESS_DISABLED'] !== '1'
  ? buildFixNetwork(platform)
  : undefined;
```

Add the live check to `verify-isolation.ts`: in a machine built with `buildFixNetwork('javascript')`, install a package whose dependency points at a blocked host, catch the real failure, and assert `classifyInstallFailure` returns `infrastructure`.

**Step 3b: the Slack alert, which is the other half of shipping this on by default.**

Restricting egress and finding out weeks later is not a decision anyone made. Fix jobs run about twice a fortnight, so a blocked host during clone, setup, test or build would sit unnoticed until someone happened to read a job record. Install failures get classified; the other four phases surface as ordinary failures with nothing pointing at the allowlist.

Create `packages/worker/src/restricted-machine-alert.ts`:

```ts
export function alertRestrictedMachineFailure(input: {
  network: ReadOnlyNetwork | undefined;
  phase: 'clone' | 'setup' | 'install' | 'test' | 'build';
  jobId: string;
  projectId: string;
  detail: string;
}): void {
  if (!input.network) return;   // no policy, so nothing could have been blocked
  emitUsageEvent('fix_restricted_machine_failed', {
    job_id: input.jobId,
    project_id: input.projectId,
    phase: input.phase,
    allow_out: input.network.allowOut.join(','),
    detail: scrubSecrets(input.detail).slice(0, 800),
  });
}
```

Silent when the machine had no policy: an alert that fires on unrelated failures trains the reader to ignore it. `scrubSecrets` and the 800-character cap are not optional. The detail is raw command output, it can carry a token or a private registry URL, and it is going to Slack.

Call it from `agent-fix.ts` at the setup-failure catch (phase `clone` when the message says clone failed, `setup` otherwise) and at the `DependencyInstallError` branch, passing `err.output`.

Test that a credential never reaches the payload:

```ts
it('never puts a credential in the payload', () => {
  alertRestrictedMachineFailure({
    network: net, phase: 'clone', jobId: 'j', projectId: 'p',
    detail: 'fatal: https://x:ghp_AAAABBBBCCCCDDDD@github.com/o/r failed, key sk-ant-api03-SECRET',
  });
  const detail = emit.mock.calls[0]![1]['detail']!;
  expect(detail).not.toContain('ghp_AAAABBBBCCCCDDDD');
  expect(detail).not.toContain('sk-ant-api03-SECRET');
});
```

- [ ] **Step 4: Run tests, then verify live**

Run: `pnpm --filter @opslane/worker test && pnpm --filter @opslane/worker build`
Then: `pnpm --filter @opslane/worker exec tsx scripts/verify-isolation.ts`
Expected: all checks pass

- [ ] **Step 5: Deploy, then watch the next fix job**

Fix jobs run about twice a fortnight, so the next one is the test. The Step 3b alert does the watching: a `fix_restricted_machine_failed` message in Slack names the phase and the allowlist that was in force. **Treat every one of those as a suspected policy block until proven otherwise.** Install failures also get classified as `infrastructure`, which is what a missing host looks like, but a blocked clone, setup command, test or build takes its own path and can surface as a test failure or `worker_runtime_error`, which is why the alert covers all five phases rather than trusting the classifier.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src packages/worker/scripts
git commit -m "feat(worker): optional egress policy for fix machines, per project"
```

---

## Task 6: Product context finds its own routes

**Files:**
- Modify: `packages/worker/src/product-context/job.ts`
- Modify: `packages/worker/src/harness/sdk-agent.ts` (the product-context-only `run_command` tool and its allowlist entry)
- Modify: `packages/worker/src/harness/readonly-sandbox.ts` (a bounded command method on the checkout; `RepoReader` has no exec)
- Modify: `packages/worker/src/index.ts` (product context's checkout lifecycle, as the other three already have)
- Modify: `packages/worker/src/__tests__/readonly-isolation.test.ts` (drop the descope entry)
- Test: `packages/worker/src/product-context/__tests__/job.test.ts`, `packages/worker/src/harness/__tests__/sdk-agent.test.ts`

**Interfaces:**
- Consumes: `RepoReader` (already shipped).
- Produces: no new exports. `discoverRepositoryRoutes` and `MAX_DISCOVERY_FILES` are deleted.

This is what unblocks the last job. The mechanical walk reads up to 10,000 files with `node:fs/promises` to build the prompt, which is why product context could not move into a sandbox: a one-file-at-a-time reader turns that into 10,000 round trips.

The spike measured the alternative on a real repository. The agent found **58 routes in 21 seconds for $0.056**, against the walk's 47 in 2.3 seconds for nothing. It missed `/assets/:asset_id` and `/callback`, and found a whole `/loanees` section the walk did not.

Accepted: net more routes beats deterministic coverage. Route discovery feeds triage, so a missed route means one page whose purpose is unknown, not a broken system.

**It gets Bash.** The spike agent used four Bash calls and no file reads; it grepped the router config rather than walking anything. Inside a machine with deny-all egress and no credentials there is nothing for Bash to reach, which is why the objection that applies on the shared host does not apply here. The cost is a wider tool surface than the other three jobs and a run that can modify its checkout.

- [ ] **Step 1: Write the failing test**

```ts
it('no longer walks the host filesystem', () => {
  const src = readFileSync(new URL('../job.ts', import.meta.url), 'utf8');
  expect(src).not.toMatch(/from 'node:fs/);
  expect(src).not.toMatch(/MAX_DISCOVERY_FILES/);
});

it('asks the model to find routes rather than handing it a discovery block', () => {
  const prompt = buildProductContextPrompt();
  expect(prompt).not.toMatch(/DISCOVERY_START/);
  expect(prompt).toMatch(/find every user-facing route/i);
});

it('accepts a route list the model returns', async () => {
  const claims = parseRouteClaims({ routes: [{ path: '/assets', purpose: 'browse assets' }] });
  expect(claims).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @opslane/worker test -- product-context`
Expected: FAIL, the walk is still there and the prompt still has a discovery block

- [ ] **Step 3: Write minimal implementation**

Delete `discoverRepositoryRoutes`, `MAX_DISCOVERY_FILES` and the `node:fs/promises` import. Replace the prompt's discovery block with an instruction to find the routes. Keep the terminal tool as it is.

Remove `product-context/job.ts` from `DESCOPED_JOB_SOURCES` in the isolation test, and route it through `createReadOnlyCheckout` like the other three.

**Bash is a tool, and it needs a typed capability of its own.** `RepoReader` has read, grep, list and exists, and it must not grow execution: that interface is the read-only contract the other three jobs depend on.

Add a separate `CommandRunner` returned by the checkout:

```ts
/** Bounded command execution inside the checkout. Product context only. */
export interface CommandRunner {
  run(command: string): Promise<{ stdout: string; exitCode: number }>;
}
```

It runs with the checkout as its working directory, a 30 second timeout, and output capped the way `executeSearch` already caps results. Thread it from `createReadOnlyCheckout` through the job into `sdk-agent`, where it backs a `run_command` tool whose qualified name is in the allowlist for this job and no other.

**Grounding is the part that breaks, and it must be fixed in this task.** The spike agent made four Bash calls and zero reads. `groundRouteClaims` and `classification.minFilesRead` both key off files the model actually read, so a Bash-only run has every citation rejected as unread and may not clear the evidence floor at all. Two changes:

- `groundRouteClaims` becomes **async** and fetches each submitted citation through the `RepoReader` rather than consulting `filesRead`. It currently calls `resolveInsideRepo` against a host path synchronously; that becomes a reader call, so every caller must await it. A citation is grounded if the file exists in the checkout and the claim checks out, regardless of how the model found it.
- The prompt requires a `read_file` on every file it intends to cite before submitting. Bash is for finding things; citations come from reads.

A test must cover the four-Bash-zero-Read case explicitly, because that is what the spike actually produced, and it must assert the whole sequence: the first submission fails `minFilesRead`, the feedback goes back, the model reads the files it intends to cite, and only the corrected submission is accepted.

**Known and accepted: the shell can edit the tree that grounding checks.** `run_command` can write files, so in principle a model could write the content it then cites and have grounding confirm it.

Deliberately not addressed. The model is not adversarial toward us, and a deliberate version needs a customer to plant instructions in their own repository for the payoff of a wrong description of their own page. The likelier version is a command modifying a file as a side effect, which is a correctness annoyance rather than a hole.

The fix, if this ever matters, is three commands before grounding: `git checkout -- .`, `git clean -fd`, and assert `git status --porcelain` is empty. Recorded here so the next reader knows it was considered rather than missed.

**Audit every consumer before deleting the walk.** `discoverRepositoryRoutes` output does not only build the prompt. Trace what reads the persisted result: `route_map`, the evidence bundle at `evidence/bundle.ts`, and the inquiry job at `inquiry/job.ts:110`. An integration test must run from model-discovered routes through persistence to an inquiry read.

**Split the commits, but do not build a fallback.** This task changes route discovery, adds a command tool, reworks grounding, and moves the job. Each of those is a separate commit so any one can be reverted.

An earlier draft also asked for a sandboxed mechanical walk as a fallback. Cut: that is a second implementation to maintain for a job that runs once a fortnight, and if the agent version fails the answer is to fix it, not to fail over to a parallel path nobody exercises.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @opslane/worker test && pnpm --filter @opslane/worker build`
Expected: PASS, and the isolation test now covers all four jobs with no allowlist entry

- [ ] **Step 5: Compare against the old walk on a real repository**

Run both over the same checkout and record route counts and the difference. Accept a result that finds fewer routes only if it finds the ones that matter; if it drops a whole section, stop and report.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src
git commit -m "feat(worker): product context discovers its own routes, and moves into a sandbox"
```

---

## Task 8: Replace the hand-written loop with the SDK, keeping the loop on the worker

**Files:**
- Create: `packages/worker/src/harness/sdk-agent.ts`
- Modify: the four job call sites
- Delete: `packages/worker/src/readonly-agent.ts`
- Modify: `packages/worker/package.json` (add `@anthropic-ai/claude-agent-sdk@0.3.251`, pinned) and `pnpm-lock.yaml`, or frozen-lockfile CI fails
- Test: `packages/worker/src/harness/__tests__/sdk-agent.test.ts`

**Interfaces:**
- Consumes: `@anthropic-ai/claude-agent-sdk@0.3.251`, `RepoReader` (already shipped).
- Produces: `runReadOnlyAgentSdk(input: ReadOnlyRunInput): Promise<ReadOnlyRunResult>`, result shape unchanged.

**The loop stays on the worker. Nothing moves into the machine.** An earlier draft planned to run the SDK inside the sandbox, which is where the hard questions came from: the key would have to go in, the validator would have to cross a process boundary, and the dollar cap would be lost.

A spike showed that is unnecessary. The SDK's loop runs here, with custom tools defined through `createSdkMcpServer` and `tool()` whose handlers execute commands in the machine. Measured: the model called only our two tools, every built-in file tool was refused, and it reached the right answer in 4 turns for $0.064.

So this task deletes turn management and nothing else. The conversation, the credential, `validateTerminal` and `budgetUsd` all stay exactly where they are.

Three consequences worth stating, because they undo earlier plan text:

- **Task 7 is no longer a gate.** The validator does not cross anything, so the retry survives untouched and no callback channel is needed. Task 7 stays worth doing as evidence, but Task 8 does not wait for it.
- **The machine still needs no Anthropic access.** Which means the unused allowlist entry and key-injection rule in `sandbox-network.ts` can be closed rather than kept warm. See Task 9.
- **The round trip is not a concern.** 174ms median, about 3.5 seconds across twenty tool calls on a three-minute job.

**Use an allowlist, not a blocklist.** The spike set `disallowedTools` and `ToolSearch` still appeared, because anything not named gets through. Name exactly the tools that may run.

- [ ] **Step 1: Write the failing test**

```ts
it('exposes only our tools, by allowlist', async () => {
  const opts = buildQueryOptions(fakeInput());
  expect(opts.allowedTools).toEqual(['mcp__repo__read_file', 'mcp__repo__search', 'mcp__repo__list_files', 'mcp__repo__submit']);
});

it('a built-in file tool is not reachable', async () => {
  const opts = buildQueryOptions(fakeInput());
  for (const builtin of ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'ToolSearch']) {
    expect(opts.allowedTools).not.toContain(builtin);
  }
});

it('tool handlers read through the RepoReader, never the host', async () => {
  const reader = { readFile: vi.fn(async () => 'x'), grep: vi.fn(async () => ''), list: vi.fn(async () => ''), exists: vi.fn(async () => []) };
  await callTool('read_file', { path: 'a.ts' }, reader);
  expect(reader.readFile).toHaveBeenCalledWith('a.ts');
});

it('returns the result shape the four jobs already consume', async () => {
  const out = await runReadOnlyAgentSdk(fakeInput());
  expect(out).toMatchObject({
    terminalInput: expect.anything(), filesRead: expect.any(Array),
    costUsd: expect.any(Number), stop: expect.any(String),
  });
});

it('enforces the dollar budget from per-turn usage, not the final total', async () => {
  const out = await runReadOnlyAgentSdk({ ...fakeInput(), budgetUsd: 0.0001 });
  expect(out.stop).toBe('budget');
});

it('feeds a rejection back and accepts the corrected resubmission', async () => {
  const validate = vi.fn()
    .mockReturnValueOnce({ ok: false, feedback: 'cause_locations[0].path is required' })
    .mockReturnValueOnce({ ok: true });
  const out = await runReadOnlyAgentSdk({ ...fakeInput(), validateTerminal: validate });
  expect(validate).toHaveBeenCalledTimes(2);
  expect(out.terminalInput).not.toBeNull();
});

it('lets a dead machine escape instead of becoming tool output', async () => {
  const reader = { ...fakeReader(), readFile: async () => { throw new MachineUnavailableError('gone', 'gone'); } };
  await expect(runReadOnlyAgentSdk({ ...fakeInput(), reader }))
    .rejects.toBeInstanceOf(MachineUnavailableError);
});

it('carries the whole usage record, which job_usage rows are written from', async () => {
  const out = await runReadOnlyAgentSdk(fakeInput());
  expect(out.usage).toMatchObject({
    input: expect.any(Number), output: expect.any(Number),
    cacheRead: expect.any(Number), cacheWrite: expect.any(Number),
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @opslane/worker test -- sdk-agent`
Expected: FAIL, module not found

- [ ] **Step 3: Write minimal implementation**

Define the tools with `createSdkMcpServer` and `tool()`.

**Handlers call the existing formatters, not `RepoReader` directly.** `executeReadFile`, `executeSearch` and `executeListFiles` own line numbering, the 50KB truncation marker, the `No matches found.` string and the result cap. Calling `RepoReader` from a handler would rebuild all of that and change what the model sees, which is the exact drift the raw-data seam was built to prevent.

**Map the whole input, not just the tools.** `apiKey` into the SDK's environment, `model`, `systemPrompt` and `firstMessage` into the prompt, `maxTurns`, `budgetUsd`, the job's own terminal tool schema, and every field of `ReadOnlyRunResult` on the way back including the separated cache-read and cache-write usage that `job_usage` rows are written from.

Drive `query()` with `allowedTools` naming exactly those tools.

Four mechanics the plan must pin down, because the SDK owns iteration and we do not:

**Rejection feedback.** `validateTerminal` runs inside the terminal tool's handler. On rejection the handler returns a `CallToolResult` with `isError: true` and the feedback as its text, and does **not** throw. Throwing may end the call rather than continue the turn. Track resubmits in a closure and, once exhausted, return the submission as accepted so the run terminates rather than looping.

**Termination protocol, measured.** A handler must never interrupt the query it is serving. That was tried and it throws out of the iterator with `Claude Code returned an error result: [ede_diagnostic]`, ending the run in an error state even though the submission was captured.

The working shape, also measured: the handler records and returns its `CallToolResult`. The consumer breaks the `for await` loop and calls `return()` on the query for cleanup. One protocol covers all three stopping cases:

```ts
let captured: Record<string, unknown> | null = null;
let fatal: unknown = null;
let costUsd = 0;

try {
  for await (const message of q) {
    costUsd += priceMessage(message, tier.model);   // per-turn usage, see below
    if (fatal) break;                                // dead machine
    if (captured) break;                             // accepted submission
    if (costUsd > input.budgetUsd) { stop = 'budget'; break; }
  }
} finally {
  await q.return?.().catch(() => undefined);
}
if (fatal) throw fatal;   // rethrown after cleanup, never as tool output
```

An accepted terminal call does not end `query()` by itself; the model may keep going or submit again. Breaking on `captured` is what ends it.

**Fatal errors must escape.** `MachineUnavailableError` from `RepoReader` must not become a model-visible tool error, or the agent burns turns against a dead machine. The handler stores it in `fatal` and returns normally; the loop above breaks and rethrows after cleanup.

**Pricing.** Input, output, cache-read and cache-write tokens all price differently per model. `priceMessage` must reuse the existing `pricingFor` / `calculateCost` pair rather than inventing a rate, and tests must cover a cache-heavy turn and a model switch.

**The whole result contract, not just cost.** `ReadOnlyRunResult` carries `usage` with cache reads and writes separated, and `job_usage` rows are written from it. Map and test every field, not only `costUsd`.

| Today | With the SDK |
|---|---|
| hand-written turn loop | `query()` |
| `readOnlyTools()` | `tool()` definitions whose handlers call the **existing** `executeReadFile` / `executeSearch` / `executeListFiles`, never `RepoReader` directly |
| `terminalTool` | a `tool()` built from each job's own `Anthropic.Tool`: its name, description and schema, not a generic `submit`. The allowlist entry is `mcp__repo__${input.terminalTool.name}`, constructed, not hard-coded |
| `validateTerminal` | unchanged, still called by us in the terminal handler |
| `budgetUsd` | price each assistant message's `usage` as it arrives; when the total passes the cap, set the stop reason and **break the outer loop**, then `return()` in `finally`. Never `interrupt()` from a handler. Never `total_cost_usd` on the final result, which arrives after the money is spent |
| `classification.minFilesRead` | unchanged, count reads in the handler |
| `filesRead` | accumulate in the `read_file` handler |

- [ ] **Step 4: Prove the allowlist against the real SDK, not a mock**

Unit tests assert the options object. They do not prove the SDK honours it. Add `packages/worker/scripts/verify-sdk-tools.ts`, run as
`ANTHROPIC_API_KEY=... E2B_API_KEY=... pnpm --filter @opslane/worker exec tsx scripts/verify-sdk-tools.ts`,
which drives a real `query()` against a throwaway sandbox fixture and asserts an attempted `Read`, `Bash` and `ToolSearch` are all refused, and that the terminal capture and break protocol above completes cleanly. The spike showed `ToolSearch` slipping past a blocklist, which is exactly the failure a mock cannot catch.

- [ ] **Step 5: One live smoke per job type, then delete**

Run each of the four job types once against a real checkout on the new harness and confirm it reaches a terminal submission that grounds. That is the bar, not a statistical comparison: an earlier draft asked for a ten-group shadow run with agreement thresholds, which is more measurement than one operator needs.

Keep one thing from that draft, because a spike actually hit it: the SDK once invented an absolute path and asked a clarifying question instead of reading anything. If a smoke run ends without a terminal submission, that is the failure to investigate before deleting `readonly-agent.ts`.

- [ ] **Step 5: Run the full gate, then commit**

```bash
pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test
git add packages/worker
git commit -m "feat(worker): SDK turn loop on the worker, tools still execute in the sandbox"
```

---

## Task 9: Close the Anthropic hole the machine never used

**Files:**
- Modify: `packages/worker/src/harness/sandbox-network.ts`
- Test: `packages/worker/src/harness/__tests__/sandbox-network.test.ts`
- Modify: `packages/worker/scripts/verify-isolation.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports. `api.anthropic.com` and its injection rule leave the read-only policy.

The model conversation runs on the worker: `readonly-agent.ts:162` creates the client and `:257` sends the request. Nothing inside the machine has ever called Anthropic. But `sandbox-network.ts:13` allowlists `api.anthropic.com` and attaches our key to anything reaching it.

That is an open door with a live credential on it that nothing walks through. It was built because a spike proved key injection works, without first checking whether the machine needed the access at all.

Task 8 settles it: the loop stays on the worker, so the machine never will need it.

**This precedes Task 8 and Task 6.** An earlier draft said to do it after Task 8, written when the loop was still going to move into the machine. It no longer does, so both the old and the new loop run on the worker and neither needs this access. It must come before Task 6, which puts a shell in the machine.

- [ ] **Step 1: Write the failing test**

```ts
it('does not allow the machine to reach Anthropic', () => {
  expect(buildReadOnlyNetwork(...).allowOut).not.toContain('api.anthropic.com');
});

it('injects no credential, because nothing in the machine authenticates', () => {
  expect(buildReadOnlyNetwork(...).rules).toEqual({});
});

it('still reaches the git host and the registry', () => {
  const allow = buildReadOnlyNetwork(...).allowOut;
  expect(allow).toContain('registry.npmjs.org');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @opslane/worker test -- sandbox-network`
Expected: FAIL, the host and rule are still there

- [ ] **Step 3: Write minimal implementation**

Drop `api.anthropic.com` from `ALWAYS_ALLOWED_HOSTS` and delete the `rules` entry.

The key threads further than one function. It is a parameter of `buildReadOnlyNetwork`, a field on `ReadOnlyCheckoutOpts`, an argument at every `createReadOnlyCheckout` call site, and it appears in tests and in `verify-isolation.ts`. Remove it from the **checkout plumbing only**. The worker-side agent input keeps its `apiKey`, because that is what still talks to Anthropic. Run `grep -rn "anthropicApiKey" packages/worker/src` and clear every hit in the sandbox path.

- [ ] **Step 4: Flip the live check**

`verify-isolation.ts` currently asserts Anthropic is reachable from inside with no key. Invert it: assert Anthropic is **not** reachable. Keep the assertion that no `sk-ant-` value appears in the machine's environment.

- [ ] **Step 5: Run tests, then verify live**

Run: `pnpm --filter @opslane/worker test && pnpm --filter @opslane/worker exec tsx scripts/verify-isolation.ts`
Expected: PASS, with Anthropic now blocked

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src packages/worker/scripts
git commit -m "feat(worker): read-only machines cannot reach Anthropic, because nothing in them needs to"
```

---

## Order

`1, 2, 4, 5, 9, 8, 6`.

Task 3 is not in the delivery path. It is an optional diagnostic that can run at any point, before Task 5 to pre-empt a failure or after one to explain it. Task 7 was deleted; see below.

Task 9 sits before Task 8 because both the old and the new loop run on the worker, so removing the unused Anthropic access does not depend on the SDK swap. It must precede Task 6, which adds a shell to the machine.

Task 6 is last because it depends on Task 9 having closed that access, and because it is the largest single change: route discovery, a new command tool, grounding rework, and the job's move into a sandbox.

## Deliberately not included

**Per-repository images.** Decided: one shared image. Revisit once Task 5 has run for a week and install time is measured again.

**Automatic image rebuilds.** A previous draft had a function classifying changed paths that nothing called. Rebuilding is a documented manual step in Task 1 until something dispatches it.

**Python egress.** Task 3 probes JavaScript. Python stays unrestricted until an equivalent probe exists, and Task 5 enforces that by returning no policy for it.

**`best_supported` reaching customers unverified**, installation-wide GitHub tokens at `app.go:94`, and npm postinstall tampering in the fix pipeline. All three are real and none is this plan's subject.
