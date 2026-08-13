---
covers:
  - packages/worker/src/friction/promotion.ts
  - packages/worker/src/friction/promotion-db.ts
  - packages/worker/src/friction/analyzer.ts
---
# Friction

Friction is a user getting stuck while your app runs without error. Opslane finds it in session recordings.

A **signal** is one friction pattern in one analyzed session. A **friction issue** is a signal that five distinct signed-in users hit within seven days.

Opslane ships two detectors: **rage clicks**, a burst of clicks on one element, and **dead clicks**, a click that leaves the page unchanged. [How Opslane analyzes a session](session-analysis.md) covers the detection mechanics.

## A signal near an error joins that error

When a signal lands within 30 seconds of an error in the same session, Opslane immediately checks whether the signal is real friction or detector noise. An accepted signal attaches to that error issue. Friction you expected as its own issue therefore appears as evidence under an error.

## Becoming an issue

Only a signal from a signed-in user can start a friction issue. An anonymous signal can still attach to a nearby error.

Signals collect in a bucket keyed by the environment and the signal's fingerprint. The fingerprint combines the signal type, the element selector in canonical form, and the page URL stripped of query and hash, with variable path segments replaced by placeholders. The same dead button on staging and production stays in two buckets.

Once five distinct signed-in users hit the same bucket within a rolling seven days, Opslane judges the bucket. An accepted bucket becomes a visible issue. A rejected bucket stays hidden, and its signals still count as evidence later. After a bucket becomes an issue, matching anonymous signals attach to it too.

## Two decisions, in order

1. **Is this a real problem?** The judgment separates genuine friction from detector noise. The issue and its counts include accepted signals only.
2. **Is there a code cause?** After the bucket becomes an issue, Opslane investigates your repository. See [how investigation works](investigation.md).

An issue with a code cause enters the fix path. The fix path waits for your approval unless you raise the friction autonomy setting; see [when Opslane opens a pull request](fix-prs.md). An issue with no code cause closes as an insight and stops there.

## Ranking

Friction issues rank on the same score as errors: distinct signed-in users plus anonymous sessions from accepted signals, weighted by route. See [how issues work](issues.md).
