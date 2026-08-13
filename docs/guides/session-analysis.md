---
covers:
  - packages/worker/src/friction/facts.ts
  - packages/worker/src/friction/analyzer.ts
  - packages/ingestion/db/sessions.go
---
# How Opslane analyzes a session

A session is one user's visit: the recording of what they saw, plus the clicks, page changes, and network requests the SDK captured. Masking is on by default; see [replay privacy and masking](replay-privacy.md) for what a recording holds.

Analysis turns a recording into counts and labels, never a transcript.

## When analysis runs

A session closes after 30 idle minutes, on the next retention sweep, and closing queues the analysis. A late chunk queues the analysis again, so the analyzer reads every chunk the session sent. Raw chunks land in storage first and a server-side pass redacts them within seconds. No dashboard, API, or worker read path serves a chunk until that pass succeeds.

## What the analyzer extracts

For each session:

- The landing page and the number of page events in the session.
- Clicks and typed inputs.
- Failed same-origin requests, counted separately for 4xx and 5xx.
- Successful and failed writes.
- The time from first activity to last.

Those numbers produce two labels. **Coverage** records how much of the session the recording holds: complete, partial, or no replay. **Activity** records the kind of visit: active, light touch, zero interaction, or idle tab. Activity is classified only from a complete recording; anything less is labelled unknown. The analyzer labels an incomplete recording partial.

## Where the facts go

- **Into error investigations.** Each error from an analyzed session gets one line of context describing what the user was doing. See [how investigation works](investigation.md).
- **Into friction issues.** Two detectors ship today: rage clicks and dead clicks. A repeated signal becomes its own issue once enough users hit it; see [friction](friction.md).
- **Into the dashboard.** The session list shows the counts and labels for each visit.
