---
covers:
  - packages/worker/src/friction/promotion.ts
  - packages/worker/src/friction/promotion-db.ts
  - packages/worker/src/friction/analyzer.tsdescription: How Opslane finds users getting stuck without an error, and when that becomes an issue.
---

# Friction

Friction is a user getting stuck while your app keeps working. Opslane finds it in session recordings.

A **signal** is one friction pattern in one analyzed session. A **friction issue** is a signal that five distinct signed-in users hit within seven days and that Opslane then accepts as real.

Opslane ships two detectors: **rage clicks**, a burst of clicks on one element, and **dead clicks**, a click that leaves the page unchanged.

## What Opslane reads from a recording

A session is one user's visit: the recording of what they saw, plus the clicks, page changes, and network requests the SDK captured. Analysis turns that into counts and labels, never a transcript.

A session goes idle after 30 minutes and closes on the next retention sweep. Closing queues the analysis, and a late chunk queues it again, so the analyzer reads every chunk the session sent.

For each session the analyzer records five things: the landing page and page-event count, the clicks and typed inputs, failed same-origin requests split into 4xx and 5xx, successful and failed writes, and the elapsed time from first activity to last.

Those numbers produce two labels. **Coverage** records how much of the session the recording holds: complete, partial, or no replay. **Activity** records the kind of visit: active, light touch, zero interaction, or idle tab. Opslane classifies activity only from a complete recording and labels anything less unknown.

Opslane uses session facts outside friction too. When an error occurs in an analyzed session, its investigation gets one line describing what the user was doing. The dashboard session list shows the counts and labels for each visit.

### Redaction

Raw chunks land in storage first and a server-side pass redacts them within seconds. Every read path, dashboard, API, and worker alike, serves a chunk only after that pass succeeds. See [replay privacy and masking](replay-privacy.md).

## Signals near an error

A signal within 30 seconds of an error in the same session goes straight to judgment. An accepted signal attaches to that error issue. Such friction appears as evidence under the error issue rather than as its own issue.

## Becoming an issue

Only a signal from a signed-in user can start a friction issue. An anonymous signal can only attach to a nearby error.

Signals collect in a bucket keyed by the environment and the signal's fingerprint. The fingerprint combines the signal type, the element selector in canonical form, and the page URL stripped of query and hash, with variable path segments replaced by placeholders. The same dead button on staging and production stays in two buckets.

Once five distinct signed-in users hit the same bucket within a rolling seven days, Opslane judges the bucket. An accepted bucket becomes a visible issue. A rejected bucket stays hidden, and its signals still count as evidence later. A change to the detector rules starts a fresh bucket.

## Two decisions, in order

1. **Is this a real problem?** The issue and its counts include accepted signals only.
2. **Is there a code cause?** After the bucket becomes an issue, Opslane investigates your repository. See [investigation and fix pull requests](fix-prs.md).

An issue with a code cause enters the fix path, which waits for your approval unless you raise the friction autonomy setting. An issue with no code cause closes as an insight and stops there.

## Ranking

Friction issues rank on the same score as errors, counting the distinct signed-in users behind accepted signals, weighted by route. See [how issues work](issues.md).
