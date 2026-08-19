---
covers:
  - packages/sdk/**
  - packages/ingestion/**
  - packages/worker/**
description: One error from capture through investigation, verification, and delivery.
---

# Life of an error

What happens between an exception in a user's browser and a ready pull request, an actionable draft, or an honest reason there isn't one.

## 1. Capture (browser)

The SDK catches the error via global handlers (or a framework hook), attaches breadcrumbs (console, fetch/XHR, navigation) and network timings, scrubs tokens and credentials from text and URLs, and POSTs to `/api/v1/events`. Session recording is enabled by default; when browser support, storage, and the project's server-side switch allow it, the SDK uploads a continuous stream of masked-input chunks and the error points into that session.

## 2. Ingest and group (ingestion API)

The event is authenticated by API key, origin-checked for browser traffic, rate-limited, and masked again server-side (sensitive headers, API-key prefixes, URL credentials). Known JavaScript noise (ResizeObserver loops, stackless Script error., extension-only stacks) is dropped before persistence. Surviving events are fingerprinted: JavaScript stale-deploy asset failures (failed to fetch dynamically imported module and similar) share one family fingerprint per project; others on platform + error type + message + stack. When `GROUPING_DEBUG_ID_FRAMES` is enabled, JavaScript events carrying `debug_meta` images are keyed on debug IDs instead of bundle URLs in the first five stack frames, collapsing per-page-load URL variation; frames with content-hashed assets are skipped as already deploy-stable. Each event is captured into a provisional bucket by fingerprint with identity pending; a `stack_resolve` job is enqueued (a Postgres row, not a message queue). After resolution completes, the ingestion service's identity settlement loop attaches the event to its canonical issue. A periodic admission filter evaluates reach (two or more affected units in seven days, within configured action environments) and queues eligible issues for inquiry with evidence frozen.

## 3. Claim (worker)

The worker polls Postgres and claims jobs with `FOR UPDATE SKIP LOCKED` under a lease. If a worker dies mid-job, the lease expires and a reaper schedules a retry with exponential backoff (`lease_lost` is reported if a worker discovers it lost its lease).

## 4. Inquiry

A read-only agent reviews the bounded evidence bundle (stack frames, failed requests, product context, session replay pointers, affected-unit count) and repository to decide whether the episode deserves investigation. Three decisions: `investigate` (enqueues an `investigate` job with a brief naming what to examine first), `wait_for_more_evidence` (episode remains open; the filter re-queues it when new evidence settles and either the inquiry prompt version has advanced or affected-unit count has grown to 1.5× the evaluated count), or `do_not_pursue` (third-party noise, browser extensions, insufficient product connection). Each decision is persisted with its evidence signature and prompt version under the durable job lease; retries against identical evidence and prompt are idempotent.

## 5. Triage

A fast model call classifies the error: fixable in application code, or not? High-confidence *unfixable* verdicts short-circuit immediately into `needs_human` with a specific reason — `unfixable_third_party`, `unfixable_infra`, `unfixable_test_error`, `unfixable_no_app_frames`, or `unfixable_no_sourcemap` — each with remediation text ([full catalog](../reference/reason-codes.md)).

## 6. Investigate and fix

For fixable errors, the worker clones the repository (GitHub token or App installation token) and runs an agentic fix loop inside an **E2B sandbox**: read the referenced source, form a root cause, edit, install dependencies, and collect build/test evidence. The verdict is validated: candidate citations are verified against repository files (quoted code must appear within ±5 lines), evidence must cite files the investigation actually read, and filler text is rejected. Failed attempts escalate through model tiers before giving up.

## 7. Route by confidence — two stages

Investigation and fixing are separate stages:

- **Investigation stage.** Some investigations proceed to the fix stage; others stop here with the **root-cause analysis** persisted as **`investigated`** (no fix has been generated yet), waiting for a human to read it and trigger the fix from the dashboard.
- **Fix stage** (automatic for above-threshold, human-triggered from `investigated`). The agent writes a fix and declares a failing regression test; fail-first verification runs the test on the base commit (must fail with the declared assertion) and with the fix (must pass). An independent judge reviews the diff, declared test, and verification ledger; the judge may probe the sandbox (up to three commands) and can veto but cannot override mechanical predicates. A `reproduced` fix (red-then-green proof, clean suite, build passed) approved by the judge becomes a draft pull request (`pr_draft`). The exact head SHA is observed in repository CI and promoted to ready on green for human-triggered fixes; automated fixes remain draft. A `checked` fix (reproduction impossible, suite and build clean, quality confirmed) or judge veto preserves the bounded candidate diff and evidence on `needs_human` for manual review.
- **Anything the worker cannot progress** at either stage → **`needs_human`** with `reason_code`, `reason_message`, and `remediation` — always all three.

Terminal outcomes (`needs_human` or `pr_created`) enqueue `issue.triaged` events for notification destinations configured for post-triage delivery.

One known gap in this contract, stated honestly: if an **investigate** job repeatedly crashes or loses its lease until it dead-letters, its group can currently remain in `analyzing` without a terminal reason — dead-letter reconciliation covers fix jobs only. Tracked as [#25](https://github.com/opslane/opslane-oss/issues/25).

## 8. Human follow-up

From the dashboard: review an `investigated` analysis and trigger the fix, open a `pr_draft` in GitHub to inspect its CI, resolve or archive incidents, or act on a `needs_human` remediation (connect the GitHub App, upload source maps, add context) and retry. Automated draft PRs wait for external CI observation before promotion to ready; human-triggered drafts promote on green CI. Project settings keep draft delivery opt-in and default to verified-only.
