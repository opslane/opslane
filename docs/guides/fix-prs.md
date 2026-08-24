---
covers:
  - packages/worker/src/pipeline.ts
  - packages/worker/src/agent-fix.ts
  - packages/worker/src/ci-watch.ts
  - packages/worker/src/friction/promotion.ts
description: When Opslane opens a pull request, how it investigates, and what verification proves.
---

# When Opslane opens a pull request

Three paths end in a pull request:

1. **An error issue, automatically.** Opslane traced the cause to your code, the issue reached enough users to be worth fixing, and the fix passed verification.
2. **A friction issue, with your approval.** The app keeps working while users get stuck on rage clicks or dead clicks. When Opslane traces that friction to your code, the fix waits for your approval. Raising the `friction autonomy` project setting makes these fixes automatic.
3. **Any analysis, when you press fix.** Every posted analysis has a fix button in the dashboard. Pressing it starts the same fix path at any confidence level.

Only these three paths write to your repository.

## From events to issues

The same crash from 500 users is one issue. Opslane filters out errors from browser extensions, cross-origin scripts, and harmless browser warnings before they become issues. It ranks issues by the number of users each one hits.

Friction issues start from session recordings instead of stack traces. Opslane groups rage clicks and dead clicks into one issue for each environment.

## Conditions for the automatic path

All of these must hold:

- The worker has its keys: Anthropic for the investigation, E2B for the sandbox, GitHub for the repository.
- The issue's environment is one you allow automation in. This applies only if you limited automation to chosen environments; see [Environments](environments.md).
- The issue reached the impact bar: at least two affected users or sessions in the last seven days, counting occurrences inside your action scope (a signed-in user and an anonymous session each count as one). Below that, the issue is watched and nothing investigates it.
- Opslane admitted it. Once an issue clears the impact bar, Opslane reads your repository and decides whether it is a real product problem worth investigating.
- Opslane named a cause in your code and cited the files it read; a cause with no cited files goes no further.
- The diagnosis was high-confidence. High-confidence diagnoses attempt a fix automatically; medium and low confidence post the analysis and wait for you to press the fix button.

## How investigation works

An investigation determines whether your code caused an issue, and where. It runs on your worker and ends in one of four outcomes.

When every stack frame lies outside your code, the job stops before the clone and records `unfixable_no_app_frames`.

### What the investigator reads

- The event that triggered the job: the error type and message, the stack trace (resolved through your uploaded source maps), the breadcrumbs, and the network timing.
- One line of session facts, when Opslane analyzed the session: what the user did just before the error.
- A clone of your repository's default branch. Opslane records the commit it investigated, so you can check every claim against exactly what it read.

The investigator only reads files. Code runs later, in the sandbox, only when Opslane attempts a fix.

### The evidence bar

The result must name the cause and cite the files the investigator read at the recorded commit. Opslane checks every citation. A citation fails when the file does not resolve at that commit, or when the investigator never opened it. A cause statement that reads as placeholder text is rejected outright. When a check fails, Opslane hides the analysis and shows a plain reason on the issue.

### The four outcomes

- **A fix attempt.** The cause is in your code, the issue cleared the impact bar, and the diagnosis was high-confidence. See the conditions above.
- **An analysis for you.** The cause is in your code, but the diagnosis was medium or low confidence. The analysis appears on the issue with a fix button, and you decide whether to run the fix.
- **A finding outside your code.** The user pain is real and the cause sits outside your code. The issue closes as an insight, not a pull request.
- **A stop with a reason.** The evidence or credential Opslane needs is missing. The issue records a reason code and a suggested next step; see [reason codes](../reference/reason-codes.md).

### What leaves your host

Investigation sends Anthropic the event context and the source files the agent reads. The [trust page](../architecture/trust.md) lists what every external service receives.

## Verification

Opslane applies the fix in an E2B sandbox. The build runs first, then the project's test commands. Whatever passed before the fix must pass after it. An unattended fix has to clear a higher bar: a test that fails before the change and passes after it. A clean build and an unchanged suite counts as checked, not reproduced. The pull request records the commands and their results.

## Ready or draft

A fix you start yourself opens ready for review when it clears the reproduction bar. **A fix Opslane starts on its own always opens as a draft**, however well it verified. Drafts require the project to opt in and stay under its open-draft cap, and the verification section of the body says whether the change was reproduced or only checked.

Opslane watches your repository's CI on the draft's exact commit and records the result on the pull request. For a fix you triggered, green CI also marks the pull request ready. If the branch moves, or if 24 hours pass without a CI result, the pull request stays a draft and the issue records the reason.

## One pull request per issue

Opslane records the issue's pull request before pushing the branch, so retries and restarts reuse that pull request. Opslane never merges; you do. Merging marks the issue as merged.

A fixed error that returns can reopen the issue under two conditions. The issue must be resolved, merged, or waiting on a human, and the returning error must come from a release at least as new as the fix. An issue closed for a cause outside your code stays closed.

## What's on the pull request

The branch is `opslane/fix-` plus the first eight characters of the issue id. The body states the cause, the change, and the evidence: each command that ran and its result.
