# Pipeline quality: from observations to customer action

Status: accepted v1 architecture; implementation pending

Date: 2026-08-16

Companion: `2026-08-16-pipeline-implementation-plan.md`

Supersedes: `2026-08-15-pipeline-and-digest-design.md` and the pipeline portions of
`2026-08-14-digest-signal-quality-design.md`

## Purpose

Opslane collects errors, session recordings, and repository code. Its job is not to
forward that material to a customer. Its job is to reduce it to a few trustworthy
actions: a verified fix to review, a specific decision only the customer can make,
or no message when nothing needs attention.

The pipeline therefore has two filters:

1. Cheap rules remove observations that have not earned an AI review.
2. the inquiry applies the product judgment that counts and thresholds cannot provide.

Only problems that survive both filters receive a full investigation. A separate
daily AI pass writes the customer's message from completed work. Mechanical code
owns facts, identity, counters, validation, deduplication, and delivery. AI owns
product interpretation, judgment, investigation, and writing.

This document defines that architecture. Its companion defines the build order.

## Production baseline

The measurements below come from read-only queries against AMFJ 2. The latest
snapshot was taken on 2026-08-16 around 05:15 UTC.

| Production fact | Current value |
| --- | ---: |
| Error events in one day | 27 |
| Error events in seven days | 301 |
| Error events in 30 days | 7,753 |
| Sessions analyzed in seven days | 78,803 |
| Failed writes in seven days | 97 across 62 sessions |
| 5xx responses in seven days | 45 across 36 sessions |
| Live error rows | 72 rows for 38 distinct titles |
| Live friction rows | 409, of which 391 are hidden candidates |
| Identified end users | 490 across 489 named accounts |

The latest digest, dated 2026-08-15, contained four cards. All four described dead
clicks around select or dropdown controls on Assets pages. Together they covered 30
visits, 27 of which continued successfully. Every card said `report_ready`; none
gave the reader a clear action. The same payload counted 85 held-back items and no
top new issue.

Three production examples anchor the design:

**Asset deletion is fragmented.** Seven live rows titled `Error deleting Assets`
contain 28 occurrences across nine identified users. Five fragments independently
produced a `code_fix` diagnosis, and several point to
`server/app/routes/api/resources/asset.py`. One customer problem has paid for
several investigations and still has no single outcome.

**Dead clicks need judgment.** The latest digest presented four related findings.
Counts alone cannot tell whether the controls blocked users, recorded harmless
clicks on internal DOM nodes, or exposed one shared component defect.

**Stale release assets have broad reach.** One live issue contains 577 occurrences
across 42 identified users. It clearly deserves review, even if the right answer is
an operational change rather than a code patch.

The current pipeline also wastes investigation work. Production holds 234 completed
investigation jobs and 31 completed fix jobs. Among 58 structured diagnosis
decisions, 39 need more context, 13 identify a code fix, five are not actionable,
and one is incomplete. The system investigates too early and with evidence split
across unstable issue identities.

## What the customer should receive

The inbox shows every settled issue that still matters, including low-volume issues
that Opslane is watching. The daily message contains only completed work or a clear
request for the customer.

A useful card answers four questions:

1. What broke in the customer's product?
2. Who or how many people encountered it?
3. What did Opslane establish?
4. What should the reader do now?

For example:

> **Customers cannot delete assets**
>
> Asset deletion failed 28 times across nine customer accounts and was last seen
> on August 13.
>
> We traced the failures to the asset deletion path and verified a change.
>
> **Action:** Review the fix PR.

If Opslane cannot write a safe fix, the card asks for the specific human decision.
If nothing needs attention, the digest says so. It does not manufacture content.

### Acceptance criteria

| # | The customer experience passes when |
| --- | --- |
| A1 | Every card has an action the reader can name. |
| A2 | One unresolved problem appears once, not once per deploy or fragment. |
| A3 | A problem card occurred inside the seven-day liveness window. A newly created approval or fix may appear without claiming that the problem is still occurring. |
| A4 | Cards name affected accounts when the SDK supplied them. |
| A5 | Cards use product language, not stack traces or internal workflow states. |
| A6 | Every link and requested action works. |
| A7 | The inbox distinguishes work that lacks reach from work AI reviewed and declined, and shows the reason for each decision. |
| A8 | Every number comes from stored observations under a written definition. |
| A9 | A problem fixed and later seen again is presented as returned, not new. |

## End-to-end flow

```text
Errors and recordings
        |
        v
Store raw input, resolve stacks, and extract session facts
        |
        v
Group observations under stable issues
        |
        v
Cheap rules: watch, inactive, or send to inquiry
        |                              ^
        |                              |
        +-------------------- product understanding
                               built by an LLM from
                               repository code and sessions
        |
        v
inquiry: investigate, wait, or do not pursue
        |
        v
AI investigation: verified fix or specific needs_human result
        |
        v
Daily factual selection -> daily AI writing -> validation -> delivery
```

The inbox reads live state throughout this flow. It is not a delivery channel and
does not wait for the daily message.

### Who decides what

| Work | Owner | Decision |
| --- | --- | --- |
| Store an error or recording | Mechanical | Preserve the observation. |
| Resolve a stack | Mechanical | Recover stable source locations or use the raw fallback. |
| Group observations | Mechanical | Bind exact, versioned fingerprints to a stable issue. |
| Count reach and recency | Mechanical | Compute identified users, anonymous sessions, and last occurrence. |
| Apply the cheap filter | Mechanical | Watch, mark inactive, or send to an inquiry. |
| Explain routes and actions | LLM | Build grounded product understanding from code and sessions. |
| Review a qualified issue | inquiry | Investigate, wait, or do not pursue. |
| Find and fix the cause | AI investigator | Produce a verified fix or a specific human request. |
| Choose and explain today's work | Daily AI pass | Include, defer, order, and write customer-facing cards. |
| Check and send the message | Mechanical | Validate facts and references, record receipts, and deliver once. |

## 1. Store observations and prepare facts

The request path records facts; it makes no lasting product decision.

### Errors

One transaction stores the immutable error event, a provisional capture bucket, the
end-user and session links, a pending identity record, and a stack-resolution job.
It creates no stable issue, inquiry job, investigation, or notification.

The response preserves the current `group_id` and `error_group_id` fields, but
`docs/contracts/events.md` will define them as provisional capture handles. No SDK
uses either field as a stable issue identifier, and the current suppression path
already returns an empty value.

Concurrent matching requests share a provisional bucket through a unique raw key;
every request keeps its own event row. The bucket is an ingestion aid, not the
customer's issue. V1 retains one small bucket row per distinct raw fingerprint and
monitors its count and age. A later error-event retention policy may prune buckets
with their source events.

### Stack resolution

The worker resolves one event at a time before grouping. Source-map work no longer
depends on an investigation.

TypeScript writes a versioned structured frame envelope. Go alone normalizes that
envelope, serializes the identity string, and hashes it. A shared golden fixture
asserted in both languages prevents a path separator, anonymous-function marker, or
prefix change from silently re-keying every issue.

Resolved identity uses `original_file + original_function`. An anonymous frame
falls back to `original_file + original_line`. Generated positions, original
positions, and `original_function` remain available for audit and investigation.
Source snippets never enter the identity key.

`sourcemap_position_cache` keys by project, debug ID, source-map content hash,
resolver version, generated line, and generated column. Since 2026-08-05, 509 events
with debug IDs shared 34 source maps, including one 2.25 MB map. The cache resolves
each artifact position once instead of fetching the map for every event.

An event without a debug ID uses its raw fingerprint immediately. An event whose map
has not arrived waits until the next daily boundary; a later upload wakes it sooner.
Object-store failures retry. Exhausted work falls back to the raw fingerprint, and a
watchdog reports stuck jobs.

The production replay established that this path is viable. Since 2026-08-05, 720
JavaScript events had stacks, 509 carried a debug ID, and every one of those 509 IDs
matched an uploaded map. Thus roughly seven events in ten can use resolved identity;
the rest keep the current raw behavior.

### Session facts

The worker decodes each retained recording and replaces one compact fact set
transactionally. It stores:

- detailed failed requests;
- aggregate successful writes;
- normalized routes;
- exact click-to-request links when the recording establishes the link; and
- rule and source versions.

It does not copy a general event timeline into Postgres. Complete decoded recordings
in the audited sample ranged from 1.1 MB to 28 MB, whereas the useful facts fit in a
small record. Raw recordings remain in object storage.

Late chunks replace the derived facts. Facts expire with their scrubbed recording by
foreign-key cascade. V1 has no separate archive of expired session facts.

### Product understanding

Understanding a product is AI work, not a mechanical rule.

Mechanical discovery supplies registered routes, likely page files, observed
requests, and likely handlers. An LLM then reads the relevant repository code and
records what each route is for, which user actions it supports, which client and
server code implements those actions, and the likely audience.

For `/assets/:id/edit`, mechanical evidence may find the Vue route and observed
`PUT /api/assets/:id` calls. The LLM reads the form, client function, and server
handler and records that the page edits an asset and that a failed PUT means the save
did not complete.

This work runs when a repository connects, after relevant deploys, and when sessions
reveal an unknown route or action. Each claim records its code references, observed
requests, commit, prompt version, model, confidence, and source. Human corrections
remain authoritative. Conflicting evidence lowers confidence or requests review.
Missing understanding means unknown, never unimportant.

Product understanding helps inquiries, investigations, ranking, and customer language.
It does not bypass the v1 mechanical filter.

## 2. Keep one problem under one issue

A fingerprint labels an observation. A separate alias table binds fingerprints to a
stable issue. No fingerprint is rewritten to impersonate another fingerprint.

```text
event -> exact fingerprint -------> stable issue
               raw alias ---------> same issue
          resolved alias ---------> same issue
```

`canonical_issue_fingerprints` is the sole identity lookup. The physical
`error_groups` table remains the stable-issue table to avoid a repository-wide
rename, but `error_groups.fingerprint` loses identity meaning after cutover.

A Go settlement loop claims pending identities with `FOR UPDATE SKIP LOCKED`. For
each observation it:

1. chooses the resolved fingerprint when available;
2. looks up the resolved and raw aliases;
3. attaches to the one known issue or creates an issue;
4. binds unknown aliases when they do not conflict;
5. records disagreement instead of merging;
6. updates counts from the attached observation; and
7. marks the observation settled.

Normal settlement only attaches new observations. A separate, audited merge may
redirect aliases and rebuild counts from source events. V1 permits an automatic
confirmed merge only before either issue starts investigation or publication. A
inquiry may flag likely duplicates, but it cannot silently rewrite identity. Later
conflicts remain visible as possible duplicates.

`sample_event_id` never participates in settlement or investigation evidence. The
current ingest path rewrites it on every event, so any decision based on it changes
with arrival order.

Other existing grouping paths remain explicit:

- suppression stays before capture;
- curated family fingerprints enter as primary fingerprints;
- Python and stackless JavaScript settle on versioned raw fingerprints; and
- available JavaScript source maps always use the resolved path.

Friction has no stack, so it enters stable grouping directly. V1 may bind
high-confidence aliases but does not attempt perfect click identity.

## 3. Apply the cheap filter

The cheap filter runs after identity settles. It answers one factual question:

> Has this issue happened recently, inside the customer's permitted scope, to enough
> distinct people or sessions to deserve an AI review?

It does not decide whether the issue is a real defect, actionable, fixable, or worth
mentioning to the customer.

The v1 rule is:

```text
identity still pending                  -> wait
no observations in action scope         -> watch: outside scope
no occurrence in the last seven days    -> inactive
two affected units in seven days        -> send to inquiry
otherwise                               -> watch: below threshold
```

An affected unit is one distinct identified user or, when no identity exists, one
anonymous session. An occurrence count is not reach: one retry loop can generate any
number of events. Route importance and `priority_score` may order work, but they do
not turn one affected unit into two.

The 30-day replay sends roughly three to seven issues per recent day to inquiries and
leaves 24 to 31 at one affected unit. The implementation reruns that replay against
the final action-scope query before cutover.

Every decision is append-only and records the counts, reason, rule version, and
time. A watched issue remains visible and accumulates evidence. New evidence or a
rule-version change runs the filter again.

The database keeps one internal row for each round of work on an issue. The product
does not expose this term. An unresolved issue stays in the same round even if it
goes quiet and later becomes active. Resolution closes the round. A later recurrence
opens a new round and appears to the customer as returned. This internal scope makes
"investigate once" and "publish once" enforceable without treating the returned
problem as a new issue.

Passing the filter is durable, but digest liveness is independent. A qualified issue
that stops occurring may finish its investigation, but it cannot enter a later
digest as current work.

## 4. Open an inquiry and apply judgment

An inquiry opens as soon as an issue clears the cheap filter. It is a bounded AI review,
not the full investigation.

The inquiry receives:

- the stable issue and current work round;
- affected-user and anonymous-session counts;
- first, threshold-crossing, and recent representative observations;
- resolved frames and exact request failures;
- route and action understanding;
- recording availability and exact replay links; and
- read-only access to relevant repository code.

The inquiry answers the questions rules cannot:

- Does this describe a genuine product problem or expected behavior?
- Did the user appear blocked, degraded, or unaffected?
- Is this browser-extension, framework, or third-party noise?
- Do several issues appear related?
- Is there enough evidence to spend a full investigation?
- What should the investigator examine first?

The inquiry returns one structured decision:

```text
investigate
wait_for_more_evidence
do_not_pursue
```

The record includes a plain-language reason, evidence references, possible related
issue IDs, an investigation brief, model, prompt version, and time. Every candidate
gets a decision. Silence is a failure.

One new occurrence does not trigger another inquiry. After
`wait_for_more_evidence`, the issue returns to the inquiry stage when the number of distinct
affected people or anonymous sessions has grown by at least half since the last
review, rounded up. For example, a review at five affected people becomes eligible
again at eight. The issue may return sooner when the evidence changes materially:
a new failing request, resolved code location, route or action, or distinct recording
pattern can change the decision even when the count does not.

A change to product understanding requeues only issues on the affected route or
action. A prompt-version change makes work eligible for a controlled batch; it does
not enqueue every issue in the capture path. A human may always request another
review.

`do_not_pursue` remains visible in a separate inbox list. It returns to the inquiry stage
only after material new evidence, a relevant product-understanding change, a
controlled prompt-version re-evaluation, or a human request. Uncertainty favors
investigation rather than a silent false negative.

An inquiry does not compute counts, alter source facts, publish messages, or hide issues.
They may recommend that likely duplicates be reviewed together, but only the audited
identity operation may merge them.

The current dead-click digest illustrates this interface. Counts found repeated
clicks across Assets routes. An inquiry must read the session behavior and shared select
code to decide whether these are harmless recovered clicks, one component defect, or
several distinct problems. The database cannot make that decision from selectors.

## 5. Investigate accepted problems

Only a inquiry's `investigate` decision creates a full investigation job.

The job freezes the observation that crossed the threshold, the issue's first
observation in the current round, and a recent distinct observation. The investigator
therefore receives stable evidence even as later events arrive. It never reads the
mutable `sample_event_id`.

The worker checks out the trigger observation's reachable `commit_sha`; otherwise it
uses the default branch head and records the commit it actually inspected. One
evidence reader supplies resolved frames, compact session facts, product
understanding, replay pointers, and evidence availability. Repository access remains
available throughout the investigation.

The existing agent loop traces the route, client request, server handler, and related
code. It may inspect a recording when facts and code leave ambiguity. If it proposes
a patch, deterministic builds, tests, and fix verification decide whether the patch
is safe. Failed verification returns evidence to the agent while budget remains.

The job ends with one useful result:

```text
verified_fix
needs_human
unable_to_establish_cause
```

A verified fix carries its diff, verification evidence, and PR state. `needs_human`
names the decision or external action required. `unable_to_establish_cause` states
which evidence was missing and may run again when that evidence arrives. The system
never converts it to the customer phrase "Investigation report ready."

One unique job per work round prevents duplicate investigations. Retries reclaim the
same job and evidence anchors rather than starting another investigation.

## 6. Write the daily message with AI

The daily message has a factual selection step, an AI writing step, and a mechanical
delivery step.

### Factual selection

At the project's daily boundary, Go freezes a candidate set. A problem result must:

- have settled identity;
- have passed the inquiry stage;
- have a useful terminal investigation result or an outstanding customer action;
- have become usable since the last committed digest run;
- have occurred inside the trailing seven-day liveness window;
- remain unresolved; and
- lack a digest receipt for the current round of work.

A newly created PR, approval request, or other customer action may also qualify when
the action became ready since the last committed run. Its card describes the action
as current; it does not claim that the underlying problem is still occurring. This
query protects freshness and publish-once semantics. The daily AI cannot revive a
stale issue or invent a candidate.

### AI writing

The daily AI receives the frozen candidates, current counts, named accounts,
product understanding, investigation outcomes, and valid actions. It may include,
defer, order, and explain candidates. It may summarize related findings together
when the evidence supports that relationship, without changing their stored
identities.

The structured result accounts for every input candidate:

```text
included: cards with issue IDs, copy, and one action
deferred: issue IDs with plain-language reasons
```

Deferred work remains in the inbox and may return at the next boundary while it is
still current. The prompt favors a short, useful message; a configurable safety cap
prevents an unbounded payload.

The AI may translate facts into product language. It may not change counts, account
names, PR URLs, issue URLs, or investigation state. It cites the candidate IDs and
evidence used for each card.

### Validation and delivery

Mechanical validation rejects unknown IDs, stale candidates, invented links,
unsupported numbers, duplicate actions, and malformed output. A transaction then
stores the run, chosen items, deferred reasons, rendered payload, publication
receipts, outbox event, and deliveries.

The existing outbox remains at-least-once at the remote boundary because a
destination may accept a request whose response is lost. Postgres prevents
intentional duplicate publication.

An unresolved issue appears in one digest. Resolution closes that round of work. If
the same issue later returns and clears the filters again, the message labels it
returned.

## 7. Show useful state in the inbox

The inbox exposes the pipeline without its storage vocabulary:

| Customer state | Meaning |
| --- | --- |
| Processing | Opslane stored the observation and is still working out which problem it belongs to. |
| Watching | The problem is current but has not affected enough people to look into yet. |
| Reviewing evidence | Opslane is deciding whether this is worth investigating. |
| Waiting for evidence | Opslane looked and named the evidence it still needs. |
| Reviewed, not pursuing | Opslane looked and decided against investigating. |
| Investigating | The full agent is tracing the cause or testing a fix. |
| Fix ready | Opslane verified a change and has a PR or approval request. |
| Needs you | Opslane found a specific decision or external action. |
| Inactive | The issue stopped occurring before it advanced. |
| Resolved | A person or verified fix closed the issue. |

The inbox renders `Watching` and `Reviewed, not pursuing` as separate lists. The
first means the problem has not reached enough people or sessions to look into. The
second means Opslane looked and declined to investigate. Rejected work shows the
decision reason, cited evidence, review time, and a way to request another review.
Every watched or rejected issue links to its observations and available recordings.
The digest remains selective because the inbox preserves completeness.

## Stored state and write ownership

Storage names belong here, not in the customer explanation.

| Stored state | Sole writer | Retention |
| --- | --- | --- |
| `error_events` | Capture transaction | Existing error-event policy |
| `error_capture_buckets` | Capture transaction | V1 retains and monitors; later follows event retention |
| `error_event_resolutions` | Resolution job | Follows the event |
| `sourcemap_position_cache` | Resolution job | Versioned artifact cache |
| `error_event_identities` | Identity settlement | Follows the event |
| `canonical_issue_fingerprints` | Identity settlement or audited merge | Stable identity history |
| `error_groups` | Identity and issue lifecycle logic | Canonical issue record |
| `issue_episodes` | Issue lifecycle logic | Internal work rounds |
| `issue_decisions` | Cheap filter | Append-only |
| `issue_inquiry_decisions` | Inquiry job | Append-only and versioned; records reviewed affected-unit count and evidence signature |
| `issue_evidence_anchors` | Filter/inquiry handoff | Follows the work round |
| `route_map` and product claims | Repository-understanding job or human | Versioned; human rows authoritative |
| compact session facts | Session analysis | Expires with the recording |
| `diagnosis_decisions` | Investigation job | Existing issue history |
| `issue_publications` | Publication transaction | Delivery audit |
| `digest_runs` and `digest_run_items` | Daily publication transaction | Delivery audit |

`canonical_issue_fingerprints` is the sole hot-path identity lookup. The new decision
tables replace every runtime use of `digest_readiness`; that table may remain inert
until a cleanup migration removes it.

## Asynchrony, retries, and concurrency

Postgres remains the durable queue. The design introduces no Redis, BullMQ, or
workflow engine.

Each job records its input version and may be retried safely. Live work outranks
bounded reprocessing. Version changes drain stale rows in batches instead of
blocking capture.

Workers use:

- row locks for one observation or work round;
- sorted advisory locks for fingerprint keys;
- unique constraints for one inquiry, investigation, and publication per work round;
- `FOR UPDATE SKIP LOCKED` for multi-replica claims; and
- absolute rollup reconstruction tests to check incremental counters.

Model timeouts and invalid structured output retry the same durable job. Exhausted
inquiry work remains visible as waiting for review. Exhausted investigation work ends
as `unable_to_establish_cause` with the failure recorded. A digest-generation failure
does not advance the window or write publication receipts; the next sweep retries the
same frozen run.

## The production examples through the new flow

| Example | Stable grouping | Cheap filter | inquiry | Investigation | Customer result |
| --- | --- | --- | --- | --- | --- |
| Asset deletion | Seven fragments and their aliases converge on one issue when evidence agrees. | Nine users pass. | Confirms a real failed product action and directs the agent to the delete path. | One investigation combines all evidence and verifies a fix or states the required decision. | One card, one action, no repeated alert. |
| Assets dead clicks | Exact signals remain auditable; likely relationships are presented to the inquiry. | Repeated sessions may pass. | Reads recovered behavior and shared control code; investigates only a supported defect. | Traces the common select control when accepted. | One supported card or no card, not four vague reports. |
| Stale release assets | One stable issue already contains broad evidence. | Forty-two users pass. | Recognizes a current release-delivery problem even if no source patch fits. | Establishes the cache or asset-retention action. | A specific `needs_human` card while the problem remains current. |

## Verification

Mechanical claims have deterministic tests:

- Go and TypeScript agree on the resolved-frame fixture and fingerprint.
- Concurrent capture, settlement, filtering, the inquiry stage, and publication remain
  idempotent.
- Missing maps and expired recordings degrade to explicit fallbacks.
- One unresolved work round gets one investigation and one digest receipt.
- A resolved issue that returns gets a new round and a returned label.
- One new occurrence cannot re-run a waiting inquiry; 50% growth or materially new evidence can.
- Digest validation rejects unsupported counts, IDs, and links.

AI quality needs fixed fixtures and human evaluation:

- Replay production candidates through the inquiry; inspect every rejection and every
  proposed relationship.
- Run the investigator once over the unified asset-deletion evidence and compare it
  with the fragmented production investigations.
- Generate a week of daily messages from production snapshots. The founder must name
  the action for every card. Any "so what?" fails the evaluation.
- Track inquiry acceptance, reversal, investigation yield, verified-fix yield, digest
  inclusion, customer action, latency, tokens, and cost by model and prompt version.

Pipeline changes also require the repository's live smoke: apply migrations, seed a
disposable project, rebuild ingestion and worker, send events, and observe capture,
resolution, identity, filtering, the inquiry stage, investigation, and digest delivery reach
their expected states with zero skipped database or storage tests.

## Direct cutover

V1 has one production user, so it uses one coordinated cutover rather than shadow
identity, dual writes, or per-project activation flags.

Before the window, a read-only report replays identity, the cheap filter, and inquiry
candidates over 30 days. A person reads every proposed many-to-one identity change
and the held and rejected lists.

During the window:

1. Let active jobs finish.
2. Stop ingestion and the worker.
3. Snapshot Postgres.
4. Apply the migration and backfill.
5. Deploy both runtimes.
6. Run the end-to-end smoke.
7. Resume traffic.

The browser SDK buffers up to 100 events in memory and retries with exponential
backoff whose base caps at 30 seconds; jitter can extend a delay to 45 seconds. Its
best-effort unload flush is limited to 60 KiB. A short outage is mostly survivable,
not lossless: overflow, prolonged failure, or navigation can still drop events.

Before traffic resumes, rollback restores the snapshot and old images. After new
canonical data arrives, recovery is a forward fix because old binaries cannot read
the new sources of truth safely.

## Non-goals and later work

**Critical-action overrides.** V1 does not let one occurrence bypass the cheap
filter because a route appears important. Product understanding first needs measured
accuracy and coverage.

**Perfect dead-click identity.** Generated classes and privacy-safe selectors make
click identity weaker than resolved error identity. An inquiry can judge related
findings in v1. Capturing a control's accessible name could improve grouping, but it
changes the SDK privacy trade and belongs in a separate design.

**Pricing policy.** Inquiries, repository understanding, investigations, and daily
writing add model cost. V1 records tokens and cost by job, model, and prompt. Product
pricing and free-tier limits follow measured usage; they do not change the pipeline's
correctness.

**Persisted general timelines.** Error investigations use compact facts, source
events, code, and optional replay access. V1 does not copy full replay timelines into
Postgres.

**Tracing as a requirement.** Traces may later contribute evidence through the same
evidence reader. V1 does not wait for tracing.

**Automatic splitting after a wrong merge.** V1 prevents speculative merges and
keeps an audited merge path. It does not add a second automatic clustering system.
