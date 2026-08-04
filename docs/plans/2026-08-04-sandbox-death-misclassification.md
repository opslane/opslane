# Sandbox death is misclassified as a failed patch

Plan for opslane-oss#255.

Revision 3 — two rounds of independent review, each of which falsified part of the
prior revision. Corrections are marked **[r2]** and **[r3]**. The r3 round found
that r2's central design did not work at all; that correction is in "The change".

## The failure, as measured

The JavaScript verification sandbox is killed 300s after creation, and **no code
path treats that as an infrastructure failure**.

Two live E2B probes against `opslane/merch-store` — the repository behind these
incidents — on 2026-08-04:

**Probe 1, setup timing.** Setup completes in **30.9s**: clone 1.0s,
`ensureModernNode` 3.3s, `npm install` **19.6s**, baseline suite 4.3s. Install
succeeds; `node_modules/.bin/vitest` is present afterwards.

**Probe 2, expiry.** Tool calls succeeded through T+298.7s and failed at T+313.8s:

```
constructor : SandboxNotFoundError
message     : "Sandbox is probably not running anymore"
```

`Sandbox.create()` with no options applies the SDK default of 300s
(`node_modules/e2b/dist/index.js:4631`). Nothing calls `setTimeout()` to extend it.

**[r2] What the probes do and do not prove.** They establish that a sandbox dies at
300s and that the death is misclassified. They do **not** prove dependency install
was healthy during the seven historical runs — a successful install today says
nothing about network or registry state weeks ago. Revision 1 claimed "npm install
was never the problem". That claim is withdrawn; install is simply not *required*
to explain the failures.

### Why the sandbox dies

Setup uses ~31s of 300s. From Langfuse (n=42-65): `agent-loop` p50 26.4s, p95
93.4s, max 135.3s, running up to 4× per job (2 tiers × 2 attempts,
`MAX_TEST_RETRIES = 1`). Worst observed run ≈606s.

## [r2/r3] How a dead sandbox actually terminates

Revision 1 asserted a single chain ending in `budget_exhausted`. That was wrong.
The outcome depends on **when** the sandbox dies. Four paths are named below because
each needs different handling; **[r3]** they are not exhaustive — see "Other deaths".

**A. Death during the agent loop → agent-reported terminal state.**
`agent-core/tool-loop.ts:202-212` converts every tool exception into model-visible
text, so the agent keeps working against a corpse. **[r3]** The end state is *not*
deterministically `budget_exhausted` — it can also be max-turns, a model `give_up`,
or apparent success followed by a failure in `extractDiff`. All seven production
incidents landed on `budget_exhausted`, but the plan must not assume that.

**B. Death at a gate, after the agent produced a diff → `worker_runtime_error`.**
The gate is misclassified as `failed`, and the reset at `agent-fix.ts:939` and
`:968` — `git checkout -- . && git clean -fd`, **not wrapped in try/catch** —
throws. It propagates to the outer catch and terminates as `worker_runtime_error`.

**C. Death before the post-patch suite → `worker_runtime_error`.**
`runSuite` executes `rm -f <results path>` at `test-runner.ts:204`, **outside** its
try block. It throws and propagates the same way.

**D. Death before the build gate → silent `skipped_no_runner`.**
This is the worst one. `fileExists` (`sandbox-repo.ts:378-385`) swallows every
error and returns `false`. So on a dead sandbox `runBuildGate` reads no
`package.json`, finds no `tsconfig.json`, and `selectBuildCommand` returns null →
`{ outcome: 'skipped_no_runner' }`. That is **not** an error outcome, and
`computeTier` (`evidence.ts:31`) explicitly accepts it:

```ts
const buildOk = e0 || build === 'skipped_no_runner';
```

A vanished machine is indistinguishable from a repository that legitimately has no
build script. This is a false-negative in the verification gate, not merely a
misleading incident.

### [r3] Other deaths

A-D are the paths needing distinct handling, not a complete enumeration. Also
reachable: death during clone or branch resolution (→ `clone_failed`); during
install aftermath, the baseline commit, or setup commands (→ `worker_runtime_error`);
during baseline-suite cleanup, tracked-file discovery, tier reset, or `extractDiff`
(→ `worker_runtime_error`); and silently swallowed during file preloading or scope
review. Items 1 and 3 below cover these generically, which is why the design raises
at the boundary rather than enumerating call sites.

### Why every path stays invisible

Infrastructure failure is detected by regex against the message text, in
`test-runner.ts:217` and `sandbox-repo.ts:371`:

```ts
if (/timed out|timeout/i.test(errorMessage)) { return { outcome: 'infra_error', ... }; }
```

`"Sandbox is probably not running anymore"` does not match.

### Why the tests did not catch it

`test-runner.test.ts:219` triggers the infra path with
`'Command timed out after 240000ms'` — verbatim the **local** backend's message
format (`sandbox-runtime.ts:170`). The regex was written against the test double
and only ever worked there.

### This violates a documented contract

`docs/architecture/precision.md` (`covers:` names `agent-fix.ts` and `harness/**`)
states infrastructure errors "never count as evidence for or against the patch".
Path D goes further and lets an infrastructure failure count as *satisfying* a gate.

## The change

**[r3] Design correction, again.** Revision 2 proposed raising a typed error at the
runtime boundary and translating once in `runAgentFix`'s outer catch. That does not
work for path A — the path matching all seven incidents.

`agent-core/tool-loop.ts:202-212` erases the error type **twice**: the inner catch
rethrows `new Error(redact(message))`, destroying the class, and the outer catch
converts it to `output = "Error: ..."` with `isError = true`. This is deliberate
(the comment explains it protects the tracing exporter). No exception escapes
`runAgentLoop`, so no outer catch can ever observe sandbox death during the agent
loop.

The fix is **state, not exceptions**: the adapter records unavailability on the
runtime object, and the worker reads that flag at points where it matters.

### 1. Adapter raises a typed error and records a flag

`sandbox-runtime.ts` is the only file importing a provider SDK. `Sandbox.create()`
currently returns the SDK object directly, so this requires a real adapter wrapping
`commands.run`, `files.read`, and `files.write`.

```ts
export class SandboxUnavailableError extends Error {}

interface SandboxRuntime {
  readonly id: string;
  readonly createdAt: number;      // required — id + lifetimeMs cannot yield age-at-error
  readonly lifetimeMs: number;
  /** Set once the provider reports the machine is gone. Never resets. */
  readonly unavailable: boolean;
}
```

On `SandboxNotFoundError`, the adapter sets `unavailable = true` **and** throws
`SandboxUnavailableError`. The flag survives `tool-loop`'s type erasure; the throw
serves every path outside the agent loop.

**[r3] Map only `SandboxNotFoundError`.** Do **not** map E2B's `TimeoutError`.
Its documented variants cover both sandbox expiry and ordinary per-command deadline
exceeded; mapping it would convert agent-issued command timeouts — which today
return feedback to the model — into whole-job retries. That is an unrelated
behavioural change. Verify at implementation time that `SandboxNotFoundError` is
exported by the installed E2B version; assert it in a test.

### 2. Check the flag where the agent loop returns

Immediately after `runAgentLoop` returns in `agent-fix.ts`, check
`sandbox.unavailable` and throw `VerificationInfraError`. This is the only fix for
path A.

**[r3] This replaces the precedence rules proposed in r2.** Revision 2 wanted
`verificationInfraError` consulted at `budget_exhausted`, `gaveUp`, and
`malformed_diff` separately. Raising at the point failure becomes persistent makes
all three unnecessary and avoids recreating the enumeration problem. One check, not
three.

### 3. Translate escaping errors at the outer catch

`runAgentFix`'s outer catch translates any `SandboxUnavailableError` into
`VerificationInfraError`, covering paths B, C, and the setup/clone/reset/extractDiff
deaths enumerated below.

**[r3] Evidence hole.** `VerificationInfraError` requires a non-optional
`EvidenceRecord` (`errors.ts:8-14`), but `evidence` is null until after
`createRepoSandbox` returns — so a setup-time death cannot construct the error.
Fix: move `evidence = createEvidenceRecorder()` **above** the `createRepoSandbox`
call. Additionally, the catch must record an explicit `infra_error` check naming the
failing operation; otherwise a terminalized incident carries evidence containing
only passing checks and nothing identifying the real failure.

### 4. Stop `fileExists` from disguising a dead sandbox

`fileExists` must rethrow `SandboxUnavailableError`.

**[r3] Weakened claim.** Rethrowing only `SandboxUnavailableError` does *not* make
the remaining `false` mean "genuinely absent" — permission errors and provider
transport failures still report absent. Either match the provider's actual
file-not-found error, or state the limitation. Do not claim the stronger property.

### 5. Give the sandbox a lifetime that fits the work

`SANDBOX_LIFETIME_MS`, default `1_800_000`, floor `900_000`, both platforms.

**[r3] Floor is now stated as a constant and is above the measurement.** Revision 2
proposed 600,000 while citing a measured worst case of ~606s — internally
inconsistent. 900,000 sits above the measurement with margin. The floor is a guard
against gross misconfiguration, **not** a proof of sufficiency: the phase caps
(suite 240s ×2, build 240s ×2, install 300s, clone 120s) sum well past 1,500s, and
r2's claim that they are "not simultaneously reachable" was asserted without
control-flow evidence. Drop that claim. The lifetime is empirical.

**Upper bound:** the Python path already runs `timeoutMs: 1_800_000` in production
(`sandbox-runtime.ts:13,49`), which is direct evidence this account accepts it. Do
not exceed without checking the tier limit.

**Crash exposure:** the ceiling is not a reservation (`agent-fix.ts:1213-1216` kills
in a `finally`, E2B bills actual uptime), but a worker crash skips `finally` and the
orphan now leaks up to 30 minutes instead of 5 — a real 6× increase. Accept
deliberately, matching Python, and say so in the comment rather than deleting it.

### 6. Record sandbox identity at the point of failure

**[r3] One design, not two.** Revision 2 offered "phase spans or root span, or
alternatively extend `traceSpan`" — competing sketches, not a plan.

`traceSpan(name, attributes, fn)` (`tracing.ts:116`) sets attributes at start and
has no mutation callback, and `sandbox-setup` has ended before any gate runs. Use
`trace.getActiveSpan()` from `@opentelemetry/api` (already imported in
`tracing.ts:14`) at the point the failure is caught, and set attributes there:
`sandbox.id`, `sandbox.created_at`, `sandbox.lifetime_ms`, `sandbox.age_at_error_ms`,
`error.class`, `error.phase`. Emit the same fields via `logger.error`, so the record
survives when Langfuse keys are unset.

**Blast radius:** adding required fields to `SandboxRuntime` breaks every structural
fake — four test files: `sandbox-repo.test.ts`, `sandbox-repo-setup.test.ts`,
`test-runner.test.ts`, `sandbox-runtime.test.ts`.

## Explicitly not in this plan

- `CommandFailedError`, `buildFailureExitCode()` removal, the unreachable
  `res.exitCode === 0` branch → #274.
- Fail-fast on `installFailed`. **[r2]** Kept out, but the revision-1 justification
  ("install was never the problem") is withdrawn — see above. It stays out because
  it is not required to fix any of paths A-D.
- Redacting internal faults from customer evidence → #273 (blocked on item 6).
- Provider-neutral `SandboxRuntime` → #274.
- Invalidating evidence recorded before a death. `computeTier` yields `tier: null`
  once the gates are `infra_error`. **[r3]** This holds only if item 3 records an
  explicit `infra_error` check — a direct runtime failure whose evidence contains no
  infra entry would not be covered.

## [r3] Backfill — decided: out of scope

The seven existing incidents are terminal in the database and will not retry
themselves. This plan changes future classification only. **They stay
`needs_human`.** Revision 2 left this as "decide before closing #255", which left
the scope undefined; it is now decided. If a one-off requeue is wanted, file it
separately — it is a data operation, not part of this fix.

## Verification

**[r3] Test with a fake `SandboxRuntime`, not the local backend.** Revision 2
proposed adding a fault-injection hook so the local backend could die mid-command.
That is unnecessary scope: `ensureRunning()` is checked only before spawning and
`kill()` does not terminate an in-flight child, but a structural fake that throws
`SandboxUnavailableError` from an in-flight promise tests the classification
directly. Do not modify the local backend for this.

- Unit: `sandbox.unavailable` set after `runAgentLoop` yields `VerificationInfraError`,
  regardless of whether the agent reported budget exhaustion, max turns, `give_up`,
  or success (path A — the fix that matters).
- Unit: `runBuildGate` against an unavailable sandbox yields `infra_error`, **not**
  `skipped_no_runner` (path D).
- Unit: `fileExists` rethrows `SandboxUnavailableError`.
- Unit: an escaping `SandboxUnavailableError` becomes `VerificationInfraError` with a
  non-empty evidence record naming the failing operation (paths B, C, and setup
  deaths — covers the r3 evidence hole).
- Unit: a setup-time death (before `createRepoSandbox` returns) constructs a valid
  `VerificationInfraError`, proving the recorder was moved above the call.
- Unit: E2B exports `SandboxNotFoundError` at the installed version.
- Unit: `SANDBOX_LIFETIME_MS` below the 900,000 floor falls back to the default.
- **[r3]** Integration: target `processJobInner` directly (`index.ts:158` holds the
  rethrow logic; the poller calls `processJob` at `:154`, and `processFixJob` is at
  `:661`). Two focused tests beat one heavily mocked end-to-end: non-final attempt
  rethrows so the poller calls `failJob` without terminalizing the group; final
  attempt writes `verification_infra_error` with evidence.
- **[r3]** Lifetime check needs no 1,800s wait — read the sandbox's reported expiry
  from the provider immediately after creation.
- `pnpm --filter @opslane/worker test`, `pnpm -r build`, the root `AGENTS.md` smoke.
- Document `SANDBOX_LIFETIME_MS` in `docs/reference/environment-variables.md`
  (`scripts/check-docs-drift.mjs` gate).

## The premise worth testing rather than assuming

#255 assumes these seven would have become PRs with a healthy sandbox. Not
established. They may fail honestly as `tests_failed`. That is still a real fix —
correct classification, no wasted budget, no fabricated explanations, and path D
closed — but the "most direct lever on PR conversion" framing would be wrong.
