---
description: What Opslane checks before it opens a pull request, and what that check can't promise.
---

# When Opslane opens a pull request

Opslane opens a pull request only after it checks that its fix actually works. Here is what that check is, and what it can't promise.

## What Opslane checks first

Before you ever see a pull request, Opslane has:

- Run your test suite before and after its change, and confirmed nothing that passed before now fails.
- Built your project, if you have a build step.
- Where it could, written a new test that fails on the broken code and passes with the fix.
- Had a second AI model read the change and agree with it.

If a fix can't pass those checks, Opslane doesn't open a normal pull request. It opens a draft you have to opt into, or it stops and tells you why.

## What the check can't promise

- **A passing test isn't proof the bug is gone for your users.** It shows the fix handles the problem under your tests, not that production behaves the same, or that the deeper cause is solved.
- **Your CI is only as strong as your tests.** If your checks only run a linter, a green result means less than a real test suite.
- **No performance or security review.** The check is about behavior, not speed, resource use, or new vulnerabilities.
- **Some bugs can't be reproduced.** An error with no stack trace, no source maps, or a cause in someone else's code is flagged as unfixable instead of guessed at.

Review every Opslane pull request the way you would a coworker's. It never merges its own.
