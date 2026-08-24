---
description: How Opslane keeps queued work, external delivery, and replay processing safe under retries.
---
# Reliability model

Opslane assumes work can fail halfway through. A worker may restart, a provider may time out after accepting a request, or a lease may expire while code is still running. The system uses durable Postgres state to make those retries safe and to leave an actionable result when it cannot continue.

## Jobs and ownership

Postgres is the only queue. Workers claim jobs with a lease, renew ownership while they work, and may write results only while that ownership remains current. An expired job becomes available for retry. Repeated failure eventually stops the job and reconciles the issue so it does not look active without live work.

Failures are classified before they become customer-visible. Problems such as invalid credentials or a request the provider will never accept stop as operator errors. Timeouts, rate limits, and provider outages retry within the job's budget. If investigation still cannot establish a cause, the issue stops with a reason and next step rather than a guessed diagnosis.

Every job and issue mutation stays inside its project. A stale worker cannot use an old lease to overwrite newer work.

## Error decisions

A mechanical filter admits an error issue only after enough recent real-user impact appears in environments allowed for error automation. A repository inquiry then decides whether to investigate, wait, or stop.

Once an admitted investigation finds an actionable cause in your code, it creates a fix job automatically. Error fixes do not pass through another confidence, reach, or approval gate. The approval path applies to friction fixes only.

Error investigation ends with one of three useful outcomes: a verified fix delivered as a pull request, an insight that points outside your code, or a stop with a reason for a person.

## Fix verification and delivery

Fix work runs in an isolated sandbox. Opslane runs the test suite before and after the edit, builds the changed repository, checks a fail-first reproduction when one is available, and asks a second model to review the diff and evidence. The reviewer can reject a candidate but cannot turn weak execution evidence into a verified fix.

Automatic pull requests always open as drafts. A person-triggered fix can open ready for review when it clears the reproduction bar. A project may opt in to limited draft delivery when the fix passes its build, introduces no observed regression, and passes independent review without a reproduced test.

Delivery is reserved in Postgres before GitHub writes begin. Retries use a stable branch and reconcile an existing branch or pull request instead of blindly creating another one. Opslane evaluates repository CI only for the exact commit it pushed. A moved branch or an absent usable result cannot promote a draft.

## Event retry limit

Two identical event payloads can represent two real occurrences, so payload equality is not an identity key. The current browser event contract has no client-generated event ID that survives transport retries. A retry after an ambiguous response can therefore store another occurrence. Job processing after capture is designed for retries, but capture itself does not promise client-level deduplication.

## Replay safety

The SDK gives each replay chunk stable session and sequence identity, so committing the same chunk again does not double its stored counts. A server-side scrub must finish before a chunk can be read by the dashboard, API, or worker. Retention tombstones protect deleted sessions from late object uploads.

Across these paths, Opslane keeps secrets and untrusted payloads out of logs, public responses, and pull request text except where a destination explicitly requires the data.
