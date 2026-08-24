---
covers:
  - packages/worker/src/friction/promotion.ts
  - packages/worker/src/friction/promotion-db.ts
  - packages/worker/src/friction/analyzer.ts
description: How Opslane finds users getting stuck without an error, and when that becomes an issue.
---

# Friction

Friction is a user getting stuck while your app keeps working. Opslane finds it in session recordings.

A **signal** is one friction pattern in one analyzed session. A **friction issue** forms when the same pattern reaches enough signed-in users recently and Opslane accepts it as real.

Opslane detects **rage clicks**, repeated clicks on one element; **dead clicks**, a click that leaves the page unchanged; and **form abandonment**, when a user starts a form but leaves without submitting it.

## What Opslane reads from a recording

A session is one user's visit: the recording of what they saw, plus the clicks, page changes, and network requests the SDK captured. Analysis turns that into counts and labels, never a transcript.

A session closes after it goes idle. Closing queues analysis, and a late chunk queues it again, so the analyzer reads every chunk the session sent.

For each session the analyzer records facts about pages, interaction, same-origin requests, writes, and elapsed activity. It stores counts and classifications, not a transcript of what the user typed.

Those facts also describe recording coverage and the level of user activity. Opslane only classifies activity when the recording has enough coverage to support the conclusion.

Opslane uses session facts outside friction too. When an error occurs in an analyzed session, its investigation gets one line describing what the user was doing. The dashboard session list shows the counts and labels for each visit.

### Redaction

Raw chunks land in storage first, then a server-side pass redacts them. Every read path, including the dashboard, API, and worker, serves a chunk only after that pass succeeds. See [replay privacy and masking](replay-privacy.md).

## Signals near an error

A signal close to an error in the same session goes straight to judgment. An accepted signal attaches to that error issue and appears as supporting evidence instead of starting a separate issue.

## Becoming an issue

Only a signal from a signed-in user can start a friction issue. An anonymous signal can only attach to a nearby error.

Signals collect by environment and the affected surface. Opslane combines the signal type, a normalized element selector, and a normalized page path so changing IDs and path parameters do not split one problem. The same dead button on staging and production stays in separate groups.

Once enough distinct signed-in users hit the same group recently, Opslane judges whether it represents real user pain. An accepted group becomes a visible issue. A rejected group stays hidden, but later evidence can still support a new decision.

## Two decisions, in order

1. **Is this a real problem?** The issue and its counts include accepted signals only.
2. **Is there a code cause?** After the bucket becomes an issue, Opslane investigates your repository. See [investigation and fix pull requests](fix-prs.md).

An issue with a code cause enters the fix path, which waits for your approval unless you raise the friction autonomy setting. An issue with no code cause closes as an insight and stops there.

## Ranking

Friction issues use the same ranking system as errors. Recent impact across distinct users matters more than repeated activity from one person, and route importance can raise or lower priority. See [how issues work](issues.md).
