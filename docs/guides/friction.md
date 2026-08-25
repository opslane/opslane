---
covers:
  - packages/worker/src/friction/promotion.ts
  - packages/worker/src/friction/promotion-db.ts
  - packages/worker/src/friction/analyzer.ts
description: How Opslane finds users getting stuck without an error, and when that becomes an issue.
---

# Catching bugs that don't throw

Some bugs never throw an error, such as a dead button or a form nobody can submit. Opslane finds them from session recordings.

A **signal** is one friction pattern in one analyzed session. A **friction issue** forms when the same pattern reaches enough signed-in users recently and Opslane accepts it as real.

Opslane detects **rage clicks**, repeated clicks on one element; **dead clicks**, a click that leaves the page unchanged; and **form abandonment**, when a user starts a form but leaves without submitting it.

## What Opslane reads from a recording

A session is one user's visit: the recording of what they saw, plus the clicks, page changes, and network requests the SDK captured. Analysis turns that into counts and labels, never a transcript.

A session closes after it goes idle. Opslane then analyzes it. If a late part of the recording arrives, Opslane analyzes the complete session again.

For each session Opslane records facts about pages, clicks, requests to the same website, requests that changed data, and active time. It stores counts and labels, not a transcript of what the user typed.

Those facts also describe how much of the visit the recording captured and how active the user was. Opslane only labels activity when the recording captured enough of the visit to support the conclusion.

Opslane uses session facts outside friction too. When an error occurs in an analyzed session, its investigation gets one line describing what the user was doing. The dashboard session list shows the counts and labels for each visit.

### Redaction

Raw recording chunks land in storage first, then the server redacts them. Every read path, including the dashboard, API, and worker, serves a chunk only after redaction succeeds. See [replay privacy and masking](replay-privacy.md).

## Problems near an error

When a friction signal happens close to an error in the same session, Opslane evaluates it at once. If Opslane accepts the signal as a real problem, it adds the signal to the error issue instead of starting a separate issue.

## Becoming an issue

Only a signal from a signed-in user can start a friction issue. An anonymous signal can only attach to a nearby error.

Opslane groups signals by environment and the affected part of your app. It uses the signal type, the clicked element, and the page path. It removes changing IDs and path parameters before grouping, so those values do not split one problem. The same dead button on staging and production stays in separate groups.

Once enough distinct signed-in users hit the same group recently, Opslane decides whether it represents a real problem. An accepted group becomes a visible issue. A rejected group stays hidden, but later recordings can support a new decision.

## Two decisions, in order

1. **Is this a real problem?** The issue and its counts include accepted signals only.
2. **Is there a code cause?** After the group becomes an issue, Opslane investigates your repository. See [how Opslane works](../how-it-works.md#it-investigates-in-your-code).

An issue with a code cause enters the fix path. By default, Opslane waits for your approval before it fixes a bug found only from a session recording. You can allow it to fix these issues automatically. An issue with no code cause closes with a note and stops there.

## Ranking

Friction issues use the same ranking system as errors. Recent impact across distinct users matters more than repeated activity from one person, and the importance of the affected page can raise or lower priority. See [how Opslane works](../how-it-works.md#it-only-investigates-the-errors-that-matter).
