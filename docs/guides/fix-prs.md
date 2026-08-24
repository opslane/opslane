---
covers:
  - packages/worker/src/pipeline.ts
  - packages/worker/src/agent-fix.ts
  - packages/worker/src/ci-watch.ts
  - packages/worker/src/friction/promotion.ts
description: When Opslane opens a pull request, how it investigates, and what verification proves.
---

# When Opslane opens a pull request

Three paths can start a pull request:

1. **An error issue, automatically.** A mechanical filter admitted the issue, the repository inquiry chose to investigate, and the diagnosis traced an actionable cause to your code. Opslane creates the fix job immediately. There is no confidence, reach, or approval gate after that diagnosis.
2. **A friction issue, with your approval.** The app keeps working while users get stuck on rage clicks or dead clicks. When Opslane traces that friction to your code, the fix waits for your approval. Raising the `friction autonomy` project setting makes these fixes automatic.
3. **An eligible posted analysis, when you press fix.** A person can start the same fix path from the dashboard when the issue is ready for that action.

Only these three paths write to your repository.

## From events to issues

Ingestion stores each accepted error as an observation and queues stack resolution. After resolution, ingestion uses raw and resolved stack aliases to assign the observation to a stable issue across deploys. Noise such as browser-extension errors and stacks with no useful application frames is discarded before capture.

Ranking favors issues with recent, broad impact. It remains separate from the admission decision that controls repository inquiry.

Friction issues start from session recordings instead of stack traces. Opslane groups repeated rage clicks, dead clicks, and abandoned forms by the affected surface and environment.

## When Opslane investigates and fixes

Opslane doesn't investigate every error issue. A cheap factual filter first checks whether it has reached enough real users recently inside environments where you allow error automation. Below that bar, Opslane watches the issue.

Once an issue clears the bar, a repository inquiry decides whether to investigate, wait for more evidence, or stop. An actionable error diagnosis starts the fix path automatically. This needs the worker's keys: Anthropic for inquiry and investigation, E2B for fix verification, and GitHub for the repository.

## How investigation works

An investigation determines whether your code caused an issue, and where. It runs on your worker and ends one of three ways.

When every stack frame lies outside your code, the job stops before the clone and records `unfixable_no_app_frames`.

### What the investigator reads

- The event that triggered the job: the error type and message, the stack trace (resolved through your uploaded source maps), the breadcrumbs, and the network timing.
- One line of session facts, when Opslane analyzed the session: what the user did just before the error.
- A clone of your repository's default branch. Opslane records the commit it investigated, so you can check every claim against exactly what it read.

The investigator only reads files. Code runs later, in the sandbox, only when Opslane attempts a fix.

### The evidence bar

The result must name the cause and cite the files the investigator read at the recorded commit. Opslane checks every citation. A citation fails when the file does not resolve at that commit, or when the investigator never opened it. A cause statement that reads as placeholder text is rejected outright. When a check fails, Opslane hides the analysis and shows a plain reason on the issue.

### The outcomes

- **A verified fix as a pull request.** The cause is in your code, and the fix built and passed its checks.
- **An insight.** The user pain is real, but the cause is outside your code. The issue closes as an insight, not a pull request.
- **A stop with a reason.** Opslane couldn't establish a cause, or it's missing a credential or evidence it needs. The issue records a reason code and a next step; see [reason codes](../reference/reason-codes.md).

Friction issues, like rage clicks and dead clicks, follow a different path, with an approval step you can require before a fix opens. See [friction and session recordings](friction.md).

### What leaves your host

Investigation sends Anthropic the event context and the source files the agent reads. The [trust page](../architecture/trust.md) lists what every external service receives.

## Verification

Opslane applies the fix in an E2B sandbox. It runs the project's tests before and after the edit, then builds the changed repository. A reproduced fix also needs a fail-first check: the target test fails without the change and passes with it. Finally, a second model reviews the diff and evidence and can reject the candidate. A passing build and unchanged suite count as checked, not reproduced. The pull request records the commands and their results.

## Ready or draft

A fix you start yourself opens ready for review when it clears the reproduction bar. **A fix Opslane starts on its own always opens as a draft**, however well it verified. Drafts require the project to opt in and stay under its open-draft cap, and the verification section of the body says whether the change was reproduced or only checked.

Opslane watches your repository's CI on the draft's exact commit and records the result on the pull request. For a fix you triggered, green CI can also mark the pull request ready. If the branch moves or CI does not produce a usable result, the pull request stays draft and the issue records the reason.

## One pull request per issue

Opslane reserves delivery before it pushes a branch, which prevents retries and restarts from opening competing pull requests for the same issue. Opslane never merges; you do. Merging marks the issue as merged.

A fixed error that returns in a later release can reopen the same issue. An issue closed because the cause lies outside your code stays closed.

## What's on the pull request

The branch is `opslane/fix-` plus the first eight characters of the issue id. The body states the cause, the change, and the evidence: each command that ran and its result.
