---
name: writing-commit-messages
description: Use when writing, amending, or reviewing a git commit message, or when asked to "commit this", "write the commit", or "describe these changes". Applies to any repo, any language, single commits or splitting a diff into several.
---

# Writing Commit Messages

## Overview

A commit message tells a reader who has not opened the diff what changed and why. Write it in plain English, in this exact shape. The reader is a tired colleague skimming `git log` six months from now.

## The shape

```
type(scope): <verb> <the thing that changed>

<Problem: 1 to 3 sentences. What was wrong or missing, as a user or operator would see it.>

<Change: 2 to 6 sentences. What the code does now. Name the one or two identifiers a reader must search for. Describe everything else in words.>

<Notes (only if true): a behavior change someone could trip on, tests deleted and why, or work deliberately left out.>

<Trailers the harness or repo requires, after a blank line.>
```

Fill every slot in order. Leave Notes out when there is nothing to say.

## The subject line

The subject is a label, not a headline. It states the change with a plain imperative verb: add, remove, stop, make, rename, fix, move, allow, require, return.

Test it two ways before keeping it:

1. **Could a reader guess which files changed?** If not, name the thing.
2. **Is it a sentence about the code, or a saying about the code?** "unified cards are the behavior, not a switch" is a saying. "remove the DIGEST_UNIFIED_CARDS switch" is the change.

Keep the Conventional Commits prefix the repo already uses (`feat`, `fix`, `test`, `docs`, `ci`, `build`, `refactor`). Lower case after the colon, no period, aim for 60 characters, hard stop at 72.

## The body

- One idea per sentence. About 20 words. No semicolons, no em dashes, no code in parentheses.
- Say what a thing does before you say what it is called. "the check that decides whether a path is inside the checkout" first, `resolveInsideRepo` second, once.
- At most one identifier per sentence, and only ones a reader would grep for.
- The Problem slot is the reason the commit exists. Write it even when the reason feels obvious.
- Budget: 60 to 150 words. Go longer only when the commit changes a public contract or deletes tests.
- Deleted or rewritten tests: group them by the behavior they pinned. One sentence per behavior, naming the behavior in words, not the test function. Three sentences covers most commits.

## Unrelated files in the diff

If a file does not belong to the change you are describing, do not mention it in the body. Above the message, tell the user which file it is and offer to commit it separately.

## Example

Before (real, from a project history):

```
fix(e2e): the narrative lane tolerates the live worker eating its jobs
```

After:

```
fix(e2e): claim narrative jobs even when the CI worker takes them first

The narrative e2e test failed on some CI runs with "no session_narrate
job". The keyless worker container in CI polls the same queue the test
feeds. When the container claimed the job first, it ran the job as a
no-op and the test found nothing to drive.

The test's claimJob helper now handles an empty claim. It resets any
narrative state the container touched, inserts a fresh job row already
claimed under the test's worker id, and hands that to the pipeline. The
test now drives the same job whichever process reaches the queue first.
```

## Quick check before committing

| Question | Fix if no |
|---|---|
| Does the subject name a concrete change? | Replace the saying with the verb and the thing. |
| Does the first body paragraph say what was wrong? | Add the Problem slot. |
| Can a reader follow the body without the diff open? | Replace identifiers with what they do. |
| Is every sentence under about 20 words? | Split it. |
| Is anything in the body about a file that belongs in another commit? | Move it to a note to the user. |
| Does any paragraph list function or test names one after another? | Collapse it to the behaviors they covered. |
