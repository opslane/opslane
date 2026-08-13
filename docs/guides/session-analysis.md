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

A session closes after 30 idle minutes, and closing queues the analysis. A late chunk queues the analysis again, so the analyzer reads every chunk the session sent. The server scrubs each chunk on arrival, before the analyzer or any other reader sees it.

## What the analyzer extracts

For each session:

- The landing page and the number of pages after it.
- Clicks and typed inputs.
- Failed requests, counted separately for 4xx and 5xx.
- Successful and failed writes.
- The time from first activity to last.

Those numbers produce two labels. **Coverage** records how much of the session the recording holds: complete, partial, or none. **Activity** records the kind of visit: active, light touch, zero interaction, or idle tab. The analyzer labels an incomplete recording partial.

## Where the facts go

- **Into error investigations.** Each error from an analyzed session gets one line of context describing what the user was doing. See [how investigation works](investigation.md).
- **Into friction issues.** Rage clicks, dead clicks, and form abandonment each open an issue by themselves. When a friction issue traces to your code, Opslane can open a pull request; see [when Opslane opens a pull request](fix-prs.md).
- **Into the dashboard.** The session list shows the counts and labels for each visit.
