---
covers:
  - packages/worker/src/investigate.ts
  - packages/worker/src/verdict-validation.ts
  - packages/worker/src/classify.ts
---
# How investigation works

An investigation determines whether your code caused an issue, and where. It runs on your worker and ends in one of four outcomes.

One check runs first: when every stack frame lies outside your code, the job stops before Opslane clones the repository (`unfixable_no_app_frames`).

## What the investigator reads

- The event that triggered the job: the error type and message, the stack trace (resolved through your uploaded source maps), the breadcrumbs, and the network timing.
- One line of session facts, when Opslane analyzed the session: what the user did just before the error.
- A clone of your repository's default branch. Opslane records the commit it investigated, so you can check every claim against exactly what it read.

The investigator reads files; it executes nothing. Code runs later, in the sandbox, only when Opslane attempts a fix.

## The evidence bar

The result must name the cause and cite the files the investigator read at the recorded commit. Opslane checks every citation. A citation fails when the file does not resolve at that commit, or when the agent never opened it. A cause statement that reads as placeholder text is rejected outright. When a check fails, Opslane hides the analysis and shows a plain reason on the issue.

## The four outcomes

- **A fix attempt.** The cause is in your code and the issue reached the impact bar: at least one signed-in user, or three anonymous sessions in the last seven days. See [When Opslane opens a pull request](fix-prs.md).
- **An analysis for you.** The cause is in your code, but the issue has not reached enough users yet. The analysis appears on the issue with a fix button.
- **A finding outside your code.** The user pain is real and the cause sits outside your code. The issue closes as an insight, not a pull request.
- **A stop with a reason.** The evidence or credential Opslane needs is missing. The issue records a reason code and a suggested next step.

## What leaves your host

Investigation sends Anthropic the event context and the source files the agent reads. The [trust page](../architecture/trust.md) lists what every external service receives.
