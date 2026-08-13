---
covers:
  - packages/ingestion/grouping/fingerprint.go
  - packages/ingestion/grouping/suppress.go
  - packages/ingestion/priority/sweeper.godescription: How events group into issues, how issues rank, and what each status means.
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

Opslane fingerprints each error from four inputs: the platform, the error type, the normalized message, and at most five stack lines. Normalization replaces the parts that vary between users and deploys: numbers, hex values, UUIDs, double-quoted strings, URL origins, and hashed asset names. This reduces needless splitting. Because browsers emit different stack text, one bug can still surface as more than one issue.

Python errors group on their application frames instead. When Opslane cannot parse a traceback, it falls back to the raw text.

Grouping is per project. One issue holds separate counts for every environment it appeared in.

## How ranking works

The score adds the affected users over seven days to twice the affected users over 24 hours. This count includes signed-in users and anonymous sessions. Opslane then multiplies that total by a route weight: 3.0 for customer-facing routes, 1.0 for standard routes, 0.5 for admin routes.

Five stop reasons cut the score to a tenth: `unfixable_third_party`, `unfixable_no_app_frames`, `unfixable_infra`, `unfixable_test_error`, and `triage_unfixable`.

Reach and recency therefore beat raw occurrence counts. One user reloading 400 times ranks below a bug that reached 50 people once.

## Statuses

Statuses group by meaning. An issue can move between the groups in any order.

- **Working:** `new`, `queued`, `analyzing`, `fixing`.
- **Waiting for you:** `investigated` (analysis posted, fix button ready), `awaiting_approval`.
- **Delivered:** `pr_created`, `pr_draft`, `merged`.
- **Stopped:** `needs_human` with a reason code, `insight` for a real problem with no code cause. Every code and its remediation: [reason codes](../reference/reason-codes.md).
- **Closed:** `resolved`, `archived`.

For what reopens a closed issue, see [when Opslane opens a pull request](fix-prs.md).

## Which events Opslane drops

Opslane drops three kinds of JavaScript noise before they reach the list: ResizeObserver loop warnings, bare `Script error.` messages with no stack, and errors whose stack frames all come from a browser extension.

Opslane keeps stale-deploy failures and groups them. When a release replaces hashed assets, every failure to load an old asset lands in one issue.
