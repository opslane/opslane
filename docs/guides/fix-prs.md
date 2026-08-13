---
covers:
  - packages/worker/src/pipeline.ts
  - packages/worker/src/agent-fix.ts
  - packages/worker/src/ci-watch.ts
  - packages/worker/src/friction/promotion.ts
---
# When Opslane opens a pull request

Three paths end in a pull request:

1. **An error issue, automatically.** Opslane traced the cause to your code, the issue reached enough users to be worth fixing, and the fix passed verification.
2. **A friction issue, with your approval.** The app kept running while users got stuck: rage clicks or dead clicks. When Opslane traces that friction to your code, the fix waits for your approval. Raising the `friction autonomy` project setting makes these fixes automatic.
3. **Any analysis, when you press fix.** Every posted analysis has a fix button in the dashboard. Pressing it starts the same fix path at any confidence level.

These three paths are the only ones that write to your repository.

## From events to issues

The same crash from 500 users is one issue. Opslane filters out errors from browser extensions, cross-origin scripts, and harmless browser warnings before they become issues. It ranks issues by the number of users each one hits.

Friction issues start from session recordings instead of stack traces. Opslane groups rage clicks and dead clicks into one issue for each environment.

## Conditions for the automatic path

All of these must hold:

- The worker has its keys: Anthropic for the investigation, E2B for the sandbox, GitHub for the repository.
- The issue's environment is one you allow automation in. This applies only if you limited automation to chosen environments; see [Environments](environments.md).
- Opslane named a cause in your code and cited the files it read; a cause with no cited files goes no further.
- The issue reached the impact bar: at least one signed-in user, or at least three anonymous sessions in the last seven days. Below that, the analysis is posted and waits for you to press the fix button. Confidence is recorded on the analysis but does not by itself decide whether a fix runs.

## Verification

Opslane applies the fix in an E2B sandbox, runs the build, then runs the project's test commands. Whatever passed before the fix must pass after it. An unattended fix has to clear a higher bar: a test that fails before the change and passes after it. A clean build and an unchanged suite counts as checked, not reproduced. The pull request records the commands and their results.

## Ready or draft

A fix you start yourself opens ready for review when it clears the reproduction bar. **A fix Opslane starts on its own always opens as a draft**, however well it verified. Drafts require the project to opt in and stay under its open-draft cap, and the verification section of the body says whether the change was reproduced or only checked.

Opslane watches your repository's CI on the draft's exact commit and records the result on the pull request. For a fix you triggered, green CI also marks the pull request ready. If the branch moves, or if 24 hours pass without a CI result, the pull request stays a draft and the issue records the reason.

## One pull request per issue

Opslane records the issue's pull request before pushing the branch, so retries and restarts reuse that pull request. Opslane never merges; you do. Merging marks the issue as merged.

A fixed error that returns can reopen the issue, within three limits. The issue must be resolved, merged, or waiting on a human. The returning error must come from a release at least as new as the fix. Some stop reasons end the issue for good: a cause outside your code stays closed.

## What's on the pull request

The branch is `opslane/fix-` plus the first eight characters of the issue id. The body states the cause, the change, and the evidence: each command that ran and its result.
