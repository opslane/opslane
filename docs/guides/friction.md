---
covers:
  - packages/worker/src/friction/match-job.ts
  - packages/worker/src/friction/match.ts
  - packages/worker/src/friction/first-look.ts
  - packages/worker/src/friction/confirm-job.ts
  - packages/worker/src/friction/confirm.ts
  - packages/worker/src/friction/tickets-db.ts
  - packages/worker/src/friction/investigate-ticket.ts
  - packages/worker/src/friction/fix-attempts.ts
  - packages/worker/src/narrative/**
description: How recording findings become known problems, confirmed issues, and verified fixes.
---

# Catching bugs that don't throw

Some bugs never throw an error, such as a dead button or a form nobody can submit.
Opslane finds these problems from session recordings and checks whether other
recordings show the same problem.

## What Opslane reads

A recording captures what a visitor saw and did: clicks, page changes, and network
requests. Once a session closes, Opslane builds a timeline, writes a narrative,
and identifies individual findings tied to moments in the recording. Frame
checks test claims that need visual evidence. For example, a claim that a button
did nothing needs screenshots that show the result.

One recording can contain several different problems. Repeated findings of
one problem in that recording still count as one affected session.

Raw recording chunks land in storage first, then the server redacts them. Every
read path serves a chunk only after redaction succeeds. See
[replay privacy and masking](replay-privacy.md).

## Matching a known problem

Opslane compares each finding with known problems in the same project and
environment. A known problem, called a **ticket**, describes a specific control,
action, and symptom. Similar wording or a shared page alone does not establish a
match. A second model reviews proposals for new tickets and can match an existing
ticket, create one, or decide the finding is not a problem.

Tickets stay internal while evidence accumulates. Anonymous recordings can start
and support tickets. A nearby JavaScript error does not automatically absorb a
recording finding. Production and staging keep separate tickets.

## Confirming an issue

After three recordings match a ticket, Opslane re-reads recordings against that
exact problem definition. Each check can confirm, refute, or leave the result
inconclusive. An unavailable recording does not count as a negative result.
A match alone never increases the issue's confirmed impact.

Publication requires at least three confirmed recordings and a confirmation rate
of at least 40% among counted checks. When confirmed recordings include identified
users, they must include at least two distinct identified users. Entirely anonymous
evidence can qualify through distinct recordings.

A published issue's counts, reproduction steps, and investigation evidence use
only findings cited by finalized confirmation checks. Counts shown for a
recent window can therefore differ from the ticket's total matched recordings.
More recordings can strengthen or weaken the evidence; recording deletion can
remove an issue from publication when it no longer qualifies.

## Finding a cause and offering a fix

Opslane investigates the repository after publication. It records which confirmed
findings the proposed code cause explains. An issue enters the daily summary
and offers **Create fix PR** only after a successful cause investigation covers at
least half of its current confirmed finding evidence.

By default, recording-derived issues wait for a person to request a fix. Projects
can enable automatic fixes; automatic delivery is limited to five open fix PRs
per project by default. Both paths use the current issue's evidence and verified
fix workflow.

If Opslane cannot establish a code cause, the ticket keeps tracking the problem.
It stays out of the summary until a later investigation meets the cause requirement.
A merged fix closes that publication; a recurrence needs evidence from recordings
after the fix. The ticket retains its identity and publishes a new incident when
the new evidence qualifies.

Operators upgrading from the old bucket pipeline must follow the
[known-problems cutover](../quickstart/self-host.md#known-problems-cutover-migration-074).
