---
covers:
  - packages/worker/src/pipeline.ts
  - packages/worker/src/investigate.ts
  - packages/worker/src/agent-fix.ts
  - packages/worker/src/harness/**
description: What a verified fix guarantees, and what it does not.
---

# What "verified" means

Opslane opens pull requests on its own. That is only safe if you can tell a verified fix from an unverified one, and if "verified" means something exact. This page says what verification proves, and what it does not.

## What Opslane proves before a fix counts as verified

A fix is verified only when all of this held during the run, inside the sandbox, against a real clone of your repository:

- A targeted test fails on the broken code and passes on the fix, and Opslane ran it both ways to confirm.
- Your existing test suite gained no new failures when Opslane ran it before and after the edit.
- The changed repository built successfully, or it has no build step.
- A second model reviewed the diff and the evidence and approved it.

If the sandbox itself fails partway, when a dependency won't install, the test runner crashes, or a step times out, Opslane records an infrastructure error and retries. That never counts for or against the fix.

## What a verified fix guarantees

- Opslane never labels a fix verified without running that evidence. The pull request body lists the commands and their results, so you can check the work. A pull request that Opslane starts automatically still opens as a draft.
- When Opslane could not verify a fix, it says so on the pull request, and it opens one only if your project opted in to unverified drafts.
- Every stopped fix attempt tells you why, with a reason code and a next step.

## What it does NOT guarantee

- **A passing test is not proof the production error is gone.** The test proves the fix handles the symptom under test conditions. It does not prove production behaves the same, that the deeper root cause is addressed, or that the same kind of error can't happen elsewhere.
- **Green CI varies in strength.** A repository whose CI only runs a linter tells you less than one with a real test suite. The evidence names the checks that ran, so you can judge what actually passed.
- **No performance or security review.** The gate checks behavior through tests, not speed, resource use, or new vulnerabilities. Review the pull request as you would a contractor's.
- **Some errors can't be reproduced.** An error with no application stack frames, no source maps, or a cause in third-party code is marked unfixable rather than guessed at. That is the gate working, not failing.

## Why the gate is strict

One wrong "ready to merge" costs more trust than ten honest drafts or "needs a human" stops. So Opslane keeps unproven work visible without dressing it up as proof. An unverified fix is opt-in and labeled as unverified, and a fix Opslane can't stand behind stops for a human instead of shipping.
