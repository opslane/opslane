---
description: Machine-checkable correctness properties of the event-to-resolution pipeline.
---
# Reliability contract

This contract defines the machine-checkable correctness properties of Opslane's
event-to-resolution pipeline. It does not judge the quality of an investigation,
model response, summary, or proposed code change.

The database invariant scanner in `test-reliability` is the executable view of
this document. During the tracer-harness milestone it is read-only: known legacy
violations may be explicitly allowlisted, but new violations fail the scenario.

## Processing model

Opslane uses at-least-once job execution. A worker or provider operation may be
retried, but the durable and externally visible result must be idempotent.
"Exactly once" below therefore means exactly one observable event, transition,
branch, or pull request—not exactly one process invocation.

## Incident invariants

- `needs_human` has nonblank `reason_code`, `reason_message`, and `remediation`.
- `needs_human` does not expose pull-request delivery fields.
- `pr_draft` has a nonblank HTTPS `pr_url`, a positive `pr_number`, and a
  confidence value permitted by the canonical draft-delivery policy.
- `pr_created` has a nonblank HTTPS `pr_url`, a positive `pr_number`, and a
  confidence value permitted by the canonical delivery policy.
- A ready PR is either a locally verified high-confidence fix or a medium-confidence
  draft promoted by passing external CI recorded for the exact published head SHA.
- An unverified delivery is always a GitHub draft, requires judge approval plus a
  passing build and no negative execution evidence, and requires project opt-in.
- An active incident (`queued`, `analyzing`, or `fixing`) has live work in a
  `pending` or `claimed` job.
- A terminal incident (`needs_human`, `pr_created`, `resolved`, `merged`, or `archived`)
  has no `pending` or `claimed` job.
- `investigated` is intentionally nonterminal and may wait without a live job
  for human guidance.
- `pr_draft` is intentionally nonterminal. It may wait without live work after CI
  observation ends, or have one live `ci_watch` job while external evidence is pending.
- A legal transition never changes another project's incident.

## Job and lease invariants

- At most one ownership epoch can mutate a claimed job.
- Only the current owner may heartbeat, complete, fail, mutate the incident, or
  initiate an external delivery operation.
- An expired claim is eventually requeued or dead-lettered within the configured
  reaper interval.
- Attempts increment once per failed ownership epoch and do not exceed the job's
  retry budget.
- Dead-lettering reconciles related product state: it cannot leave an incident
  permanently active without live work.
- A model or clone failure is classified before it becomes customer-visible: a
  deterministic request-construction failure (rejected tool schema, invalid
  model, bad credentials) fails the durable job and dead-letters as an operator
  error without writing a diagnosis; a transient failure (timeout, rate limit,
  provider outage, network fault) retries the same job and produces
  `unable_to_establish_cause` only after the retry budget is exhausted.

Each claim increments a durable `lease_generation`. Job, incident, fix-job, trace,
and setup-PR writes require the current unexpired generation and lock the job row
while committing related database state. Workers abort when a heartbeat rejects
the generation or when the heartbeat query itself fails. Provider writes re-check
the lease immediately before Git push and pull-request creation; this narrows but
cannot eliminate a lease-expiry race inside the remote call itself.

## Event identity and retries

Payload equality is not an identity rule: identical errors can be legitimate
separate occurrences.

The planned idempotency contract is:

- the SDK creates one opaque event ID and preserves it across transport retries;
- identity is scoped to the authenticated project and environment;
- the first accepted ID stores the payload digest and accepted response IDs;
- the same ID and digest returns the original response without incrementing the
  occurrence count or creating more work;
- the same ID with a different digest is rejected without mutation;
- equal payloads with different IDs are separate occurrences;
- legacy payloads without an event ID keep current at-least-once behavior during
  the compatibility window.

These rules become required only when the API, SDK, schema, and compatibility
fixtures land together.

## Delivery invariants

- One logical delivery operation has a stable operation key and branch name.
- A retry reconciles an already-pushed branch or already-created pull request
  before issuing another create operation.
- `pr_created` maps to exactly one recorded pull request for the operation key.
- `pr_draft` and its later `pr_created` promotion map to the same recorded pull
  request and stable operation key; promotion never creates another PR.
- Draft delivery is reserved durably before a GitHub write. A project has at most
  its configured number of open Opslane drafts, and one group has at most one.
- External CI evidence is evaluated only for the exact head SHA Opslane pushed.
  Zero completed successful checks is never green, and a moved head is never promoted.
- A provider timeout after an ambiguous success is reconciled, not blindly
  retried as a new delivery.
- Secrets and tenant data are absent from remote URLs, errors, logs, and pull
  request content except where the destination contract explicitly requires it.

Crash-idempotent delivery is enforced by the durable reservation written before
provider calls, stable branch reconciliation, and pull-request adoption. The
tracer harness exercises the same retry boundaries against a provider twin.

## Replay and session invariants

- Unscrubbed replay/session content is never served or analyzed.
- Duplicate chunk commits are idempotent.
- Session chunk count and stored byte rollups equal committed chunks.
- A stale scrub or retention claimant cannot finalize work owned by a newer
  claimant once fencing is implemented.
- Deleted-session tombstones continue to cover late object uploads.

## Tenant and privacy invariants

- Every API read/write, queue mutation, and external request is scoped to the
  authenticated project or organization required by its contract.
- Cross-tenant identifiers never convert a denial into a successful read/write.
- Canary credentials and untrusted raw content do not appear in logs, public
  responses, pull-request bodies, or readable replay data.

## Scenario completion

A reliability scenario passes only when:

1. its expected terminal state or recovery state is reached before the deadline;
2. expected external side effects match the provider journal;
3. the invariant scanner reports no unallowlisted violations;
4. service logs contain no planted secret;
5. the scenario seed and event history are retained on failure.
