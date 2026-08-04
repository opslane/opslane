# The sandbox runtime declares its own failure contract

- **Status:** ACCEPTED (2026-08-04).
- **Applies to:** `packages/worker/src/harness/sandbox-runtime.ts` and every caller of `SandboxRuntime`.
- **Measured:** 2026-08-04. Live E2B probe against `opslane/merch-store`, the repository behind the incidents in #255.
- **Prompted by:** #255.

`SandboxRuntime` describes only the happy path. It declares `run(): Promise<SandboxCommandResult>`
and says nothing about what may be thrown. Every caller therefore invents its own failure
classification by string-matching the error message — the same regex appears in
`test-runner.ts` and twice in `sandbox-repo.ts`.

The runtime now declares what it throws. `sandbox-runtime.ts` — the only file that imports a
provider SDK — maps each backend's failures onto two errors the harness owns:

- **`SandboxUnavailableError`** — the machine is gone. Never evidence about the patch; retryable.
- **`CommandFailedError`** — the command ran and exited non-zero. Carries `exitCode`, `stdout`, `stderr`.

Callers test the error type. They never import `e2b` and never inspect message text.

## Why the string matching had to go

The regex was `/timed out|timeout/i`. A live probe measured what E2B actually throws when a
sandbox reaches its lifetime mid-run:

```
constructor : SandboxNotFoundError
message     : "Sandbox is probably not running anymore"
```

No match. So a vanished sandbox was classified `failed` rather than `infra_error`: the agent was
told its own patch broke the build, retried against a dead machine, exhausted its budget, and
terminated as `budget_exhausted` — the one exit path that cannot requeue. This contradicted
`docs/architecture/precision.md`, which states infrastructure errors "never count as evidence for
or against the patch".

The tests did not catch it. `test-runner.test.ts:219` triggers the infra path by throwing
`'Command timed out after 240000ms'` — verbatim the **local** backend's message format
(`sandbox-runtime.ts:170`). The regex was written against the test double and only ever worked
there. E2B's real errors were never in the test set.

That is the argument against simply adding another alternation to the regex: it preserves the
mechanism that produced a green suite over blind production. E2B exports a typed hierarchy
(`SandboxNotFoundError`, `TimeoutError`, `CommandExitError`, `NotEnoughSpaceError`, …). The
information was always there; the code discarded it and re-derived a worse answer from prose.

## Considered alternatives

**Import E2B's error classes at the call sites.** Fifteen minutes' work. Rejected: it puts the
provider in three more files, and the `local` backend throws a plain `Error`, so the deterministic
harness could never exercise the sandbox-death path — the fix would ship untested.

**Extend the regex with the new message.** Five minutes. Rejected for the reason above: the next
provider message phrased differently fails identically and silently.

## Consequences

- Both backends must map their failures onto these two errors. A new backend that does not is
  incorrect, not merely untested.
- The `local` backend can now raise `SandboxUnavailableError` on demand, so sandbox death is
  reachable in the deterministic harness and the fix carries a real regression test.
- `buildFailureExitCode()` in `sandbox-repo.ts`, which recovers an exit code by regexing
  `"exited with code (\d+)"` out of a message, becomes dead code — `CommandFailedError` carries the
  number directly.
- The `res.exitCode === 0 ? passed : failed` branch in `runBuildGate` was already unreachable on
  E2B (the SDK throws `CommandExitError` on non-zero exit rather than returning it) and is removed.
- This does **not** make the runtime provider-neutral on its own. `/home/user/repo` remains
  hardcoded across seven files, and lifetime policy still lives in the factory. Tracked in #274.
