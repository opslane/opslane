---
covers:
  - packages/ingestion/grouping/fingerprint.go
  - packages/ingestion/grouping/suppress.go
  - packages/ingestion/priority/sweeper.go
description: How events group into issues, how issues rank, and what each status means.
---

# How issues work

The list uses three terms:

- An **occurrence** is one recorded instance of the issue. For an error issue, each occurrence is a captured error event.
- An **issue** groups occurrences that look like the same problem.
- **Affected users** counts the distinct signed-in users who hit the issue. One user can produce many occurrences.

Error issues come from stack traces. Friction issues come from session recordings; see [friction](friction.md).

## What the list shows

Each row shows the title, the occurrence count, the affected-user count, the time of the last occurrence, the per-environment counts, the status, and the rank position.

## How error occurrences group

Capture does not create an issue. It stores the observation and queues a worker job to resolve the stack. Once resolution finishes or falls back to the raw stack, ingestion decides issue identity.

That identity uses normalized error details and application frames. Opslane records aliases for both raw and resolved forms, so the same bug can stay attached to one issue when source maps arrive late or bundle names change between deploys. Python errors follow the same goal using parsed application frames, with raw text as a fallback when parsing fails.

Identity is per project. One issue holds separate counts for every environment where it appeared.

## How ranking works

Ranking considers recent impact across distinct signed-in users and anonymous sessions, with route importance as another signal. Issues that Opslane cannot act on rank lower.

Reach and recency therefore matter more than raw occurrence counts. Repeated failures from one person do not outweigh a problem that affects many people.

Ranking only decides order. A separate, cheap filter decides whether an error issue has enough recent impact in an allowed environment to enter the repository inquiry. Below that bar, Opslane watches the issue. The inquiry then decides whether to investigate, wait, or stop. See [when Opslane opens a pull request](fix-prs.md).

## Reading the lifecycle

The status tells you what Opslane is doing now: watching for more evidence, reviewing the issue, investigating or fixing it, waiting for a person, tracking a pull request, or finished. A stopped issue includes a reason and next step; see [reason codes](../reference/reason-codes.md). An insight means the problem is real but its cause lies outside your code.

For what reopens a closed issue, see [when Opslane opens a pull request](fix-prs.md).

## Which events Opslane drops

Opslane drops common JavaScript noise before capture, including ResizeObserver loop warnings, bare `Script error.` messages with no stack, and errors whose frames all come from browser extensions.

Opslane keeps stale-deploy failures and groups them. When a release replaces hashed assets, every failure to load an old asset lands in one issue.
