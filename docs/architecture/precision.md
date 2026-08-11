---
covers:
  - packages/worker/src/pipeline.ts
  - packages/worker/src/investigate.ts
  - packages/worker/src/agent-fix.ts
  - packages/worker/src/harness/**
---
# Precision: what verification evidence means

Opslane opens pull requests automatically. That is only tolerable if a ready-for-review fix and an actionable draft cannot be confused. This page states both bars exactly — including what they do **not** guarantee.

## The ready-for-review gate

A PR is opened ready for review only when **all** of the following held during the run (`packages/worker/src/pipeline.ts`):

1. The candidate fix was produced and applied inside an isolated sandbox against a real clone of your repository.
2. The sandbox build gate passed (E0), or the repository had no build runner.
3. The project's test suite was run once before the patch and once after it. Opslane compares per-test results where Vitest JSON is available: pre-existing failures are recorded and excluded, while pass→fail regressions and unexplained collection drops block the PR (E1). A coarse runner can support E1 only when its post-patch run exits cleanly.
4. The fix carries **high confidence**. This is a hard, independent guard for locally verified delivery. (Medium/low-confidence *investigations* stop before fix generation entirely, posting their analysis as `investigated` for you to review and trigger.)

If dependency installation fails, the test runner crashes, the sandbox becomes unavailable, or a verification gate times out, Opslane records an `infra_error`. Infrastructure errors are retried and never count as evidence for or against the patch; persistent failure terminates as `verification_infra_error` only after the job retry budget is exhausted.

## Evidence tiers

- **E0:** the build/typecheck passed.
- **E1:** the post-patch suite introduced no new failures compared with the recorded pre-patch baseline. A repository with no test runner cannot reach E1.
- **E2:** reserved for the reproduction red→green→reversal gate. E2 is not implemented in this phase.

Each check records its outcome (`passed`, `failed`, `skipped_no_runner`, or `infra_error`), command, real exit code when known, and a bounded scrubbed output tail. The latest evidence appears in the PR body and incident detail view; candidate diffs are detail-only and are not included in incident lists.

## The draft gate

Projects default to `verified_only`. When a project explicitly selects `draft_when_unverified`, Opslane may publish a fix that falls short of the ready bar as a GitHub **draft** (`pr_draft`) only when:

- the diff judge approved the fix and the build passed;
- no executed check produced evidence against the patch, such as a new suite regression;
- the failure to reach the ready bar is incomplete or absent evidence, not a verification infrastructure error; and
- the project has not reached its open Opslane draft cap.

The draft PR leads with the fact that Opslane did **not** verify the fix locally. A durable `ci_watch` job observes GitHub checks and commit statuses for the exact head SHA Opslane pushed. At least one successful check and no failed/error check promotes the draft to ready and transitions it to `pr_created` with medium confidence. Zero checks never counts as green. A moved head, failed check, missing permission, or 24-hour no-CI timeout leaves it as a draft with that outcome recorded in version 2 evidence.

## What this guarantees

- No **ready-for-review** PR is opened without executed verification evidence. A locally delivered ready PR reached E1 in a clean environment and cleared the independent confidence guard; a CI-promoted ready PR records the exact external checks and head SHA that passed.
- Any unverified PR is a GitHub draft, is labeled as unverified in its body, and exists only for a project that opted in.
- Every non-PR outcome tells you why, with a machine-readable `reason_code` and human-actionable `remediation` — never a silent drop.

## What this does NOT guarantee

Honesty requires the other side of the ledger:

- **E1 ≠ proof that the production error is resolved.** If the existing suite doesn't cover the broken behavior, a wrong fix can introduce no regressions while leaving the error intact. A reproduction-backed E2 gate is a later phase.
- **A draft is not a verified recommendation.** It makes a positive-quality candidate actionable so repository CI and a human can review it; it is not ready to merge merely because it exists.
- **Green repository CI varies in strength.** A lint-only workflow can promote a draft. The evidence names the checks observed so reviewers can judge what actually ran.
- **The root cause may be deeper.** The fix addresses the error as observed; an underlying design issue can produce the same class of error elsewhere.
- **No performance or security review.** The gate checks behavior via tests, not resource usage, latency, or vulnerability introduction. Review PRs as you would a human contractor's.
- **Reproduction is not always possible.** Errors without app stack frames, without source maps, or originating in third-party code are declared unfixable rather than guessed at; investigations that read no repository files or provide no evidence citations are rejected as incomplete — that is the gate working, not failing.

## Why the gate is strict

A wrong ready-for-review PR costs more trust than ten honest drafts or `needs_human` incidents. The pipeline keeps incomplete evidence visible in GitHub without presenting it as proof: drafts are opt-in and visibly unready; rejected fixes and negative evidence still stop as `needs_human`.
