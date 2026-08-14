# Working the Opslane digest from Claude Code

Status: specification, not built. Supersedes the earlier draft of this file, which
specified six tools and three prerequisites.

Implementation plan: `docs/superpowers/plans/2026-08-14-opslane-mcp-v1.md`.
Production evidence: `docs/audits/2026-08-14-friction-vs-error-volume.md`.

## What this builds

Three MCP tools inside the existing `@opslane/cli`, run as `opslane mcp` over
stdio, plus a Claude Code skill that drives them:

- `opslane_digest()` returns today's digest items that still need a decision
- `opslane_issue(id)` returns everything Opslane knows about one of them
- `opslane_link_pr(id, url)` records the pull request the developer opened

And three server-side changes, because none of the reads exist today: the
symbolicated stack on the sample-event response, a route that serves the stored
digest, and a route that records a pull request.

A digest is the daily summary Opslane posts to Slack. It lists incidents, each of
which is either an `error`, meaning a crash, or `friction`, meaning a place users
click and nothing happens.

## Problem

On 2026-08-14 the production digest carried seven items. Four already had a pull
request open. Of the remaining three, the fix endpoint would have accepted one.

Its gate accepts two states and nothing else:

```sql
(kind = 'error'    AND status = 'investigated')
OR (kind = 'friction' AND status = 'awaiting_approval')
```

(`packages/ingestion/db/queries.go:1359`.) The two items that needed a person were
`needs_human` and `insight`. An incident is one of two kinds: an `error`, which is
a crash, or `friction`, which is a place users click and nothing happens.

So a developer reading that digest in Slack has three things to act on, and every
route to acting on them goes through the dashboard. The marketing promise is that
they never open one. They open one.

Opslane's job is to put the context in one place and say which issues matter. The
first half already works and then stays in Slack, where the developer becomes the
transport: they read a title on a phone, walk to a terminal, and start again from
a string.

## Goals

Work one digest item end to end from a Claude Code session: read it, find the
code, fix it, record the pull request. Never open the dashboard.

Hand a coding agent everything Opslane knows, including what it tried and why it
stopped, so an unfixed incident is worth opening rather than a category name.

Ship without waiting on the digest's ranking, the fix gate, or lifecycle
unification.

## Non-goals

**Handing work back to Opslane.** No tool asks the server to attempt a fix. That
is what keeps the fix gate off the critical path, and the gate is the thing that
refused two of the three items above that needed a person. A developer in their own
repository does not need permission from a `WHERE` clause to change a file.

**Marking anything resolved.** No tool writes `resolved`. Nobody knows a fix works
at the moment they write it. `resolved` is earned by a merge followed by silence.
The existing sweep does that: it resolves a merged group once `merged_at` is more
than 24 hours old and no new events have arrived since
(`packages/worker/src/db.ts:1362`).

**Dismissing.** Real, but it is triage rather than fixing, and it needs the
archive semantics thought through. Doing nothing is already an answer: the item
stays open, and it returns to the digest whenever its readiness row is refreshed.
An earlier draft claimed it "reappears in tomorrow's digest", which overstates it.
The digest windows on `digest_readiness.updated_at`, so an untouched item may not
reappear at all. That is the same mechanism described under `opslane_digest()`,
and it cuts both ways.

**Fixing the digest.** Ranking, impact gating, and fingerprint splitting are
upstream and filed separately (#375, #376, #377). This surface delivers the
digest; it cannot make it worth reading.

## Requirements

| | Requirement | Verified by |
| --- | --- | --- |
| R1 | A developer sees today's digest items that still need a decision | Plan Task 5: a `receipt_items` array of seven, four of them `pr_open`, returns three items and one summary line |
| R2 | Items whose PR is already open do not appear as work | Plan Task 5: `pr_open` partitions to receipts; an unrecognised state partitions to decisions |
| R3 | An error incident hands over a stack pointing at real source | Plan Task 1: `sample-event` returns `resolved.frames[].original_file`; the key is absent, not null, when there is none |
| R4 | A friction incident leads with the field that names a component | Plan Task 6: the root cause appears before the selector in the rendered payload |
| R5 | A filler root cause is refused rather than printed | Plan Task 6: `placeholder while I continue reading` renders as "the investigation did not complete"; a real cause containing the word survives |
| R6 | A failed fix attempt hands over its diff and the reason it failed | Plan Task 6: `candidate_diff` and `reason_message` both render |
| R7 | A developer records the PR they opened, from any status | Plan Task 3: linking succeeds from `needs_human`, `insight`, `investigated`, `awaiting_approval` |
| R8 | Merging that PR resolves the incident | Plan Task 3: link, deliver a merge webhook, assert the group reaches `merged` |
| R9 | A PR from another repository is refused | Plan Task 3: 422, and `pr_url` stays null |
| R10 | Customer text reaches a model as data | Plan Task 6: titles, selectors, and root causes are fenced, and the tags balance |
| R11 | The protocol is not corrupted by logging | Plan Task 7: an `initialize` exchange returns one line of JSON-RPC and stderr is empty |
| R12 | Customer source in a resolved frame is redacted, and never at the cost of a valid response | Plan Task 1: a `source_snippet` carrying escaped quotes and a token still returns parseable JSON with a non-empty body |
| R13 | Customer text cannot close the fence around it | Plan Task 6: a title containing `</untrusted>` renders with that sequence neutralised |

## System overview

```mermaid
sequenceDiagram
    participant D as Developer
    participant CC as Claude Code
    participant M as opslane mcp
    participant I as Ingestion API
    participant G as GitHub

    D->>CC: "let's work the Opslane digest"
    CC->>M: opslane_digest
    M->>I: GET /projects/{id}/digest/latest
    M-->>CC: items needing a decision; receipts as one line
    CC->>M: opslane_issue(id)
    M->>I: GET /incidents/{id}
    alt error
        M->>I: GET /incidents/{id}/sample-event
        Note over M: resolved frames against source
    end
    M-->>CC: root cause, then supporting fields,<br/>then what Opslane tried
    CC->>CC: locate the component, fix, run tests
    CC->>G: open a pull request
    CC->>M: opslane_link_pr(id, url)
    M->>I: POST /incidents/{id}/link-pr
    Note over I: status becomes pr_created
    G->>I: pull_request merged webhook
    Note over I: merged, then the sweep resolves it
```

Nothing in that flow marks an issue fixed. The system concludes it from a merge,
which is the one signal nobody has to be trusted about.

## Component design

### `opslane_digest()`

Reads the stored payload from `outbound_events` where `event_type =
'digest.daily'`, filtered to items that still need a decision.

**Why the stored payload rather than a live query.** The developer arrives having
already read the Slack digest and picked something from it. A live query returns a
different set, so the item they came to work on may be missing, reordered, or
joined by items they have not triaged. They then have to reconcile two lists
before starting, which is work the digest existed to remove. Staleness costs them
nothing by comparison: the worst case is an item that someone else has since
handled, and `opslane_issue` shows the current status. Digest rows survive 30 days: the pruner only deletes events older than
that with no deliveries (`packages/ingestion/notify/dispatcher.go:560`).

One naming collision is worth clearing up before the rest of this makes sense. The
stored payload calls its whole array `receipt_items`, and there were seven of them
on 2026-08-14. This design splits that array in two by `receipt_state`, and calls
one side receipts and the other decisions. Four of the seven were receipts.

`RECEIPT_STATES` holds `pr_open` and nothing else, so receipts are an allowlist and
decisions are the default. Every other state, including one added next
quarter, reaches the developer. A filter that hides what it does not recognise
loses work every time the digest schema grows.

Two mechanisms keep a linked incident out of tomorrow's work, and only one of
them is this filter. The digest inner-joins `digest_readiness` and windows on
`dr.updated_at` (`packages/ingestion/digest/build.go:27`, `:65`), which `LinkPR`
does not touch, so a linked incident usually falls out of the window and never
reaches the digest at all. The filter is the backstop for when it does.

### `opslane_issue(id)`

Everything known about one incident, ordered by what a coding agent can act on.

**Why the root cause comes first, for both kinds.** For friction it is the only
field that names a component. Production selectors look like this:

```
div:nth-of-type(3) > div.field-container.has-label > div.field-inner-container
  > div:nth-of-type(2) > div._11c81d4k._kqswh2mm > div._12ji1r31._1qu2glyw
  > div:nth-of-type(1)._16jlkb7n._1o9zkb7n > div:nth-of-type(2)._16jlkb7n._1o9zkb7n
```

Every class from `_11c81d4k` onward is an Atlaskit compiled-CSS atom, generated at
build time, absent from source, and shared by every element with the same style.
Grepping for it finds nothing. The root cause on that same incident reads "the
dropdown indicator of Atlaskit react-select instances inside the Asset Form",
which is searchable. An earlier draft led with the selector because it looked like
the precise machine-readable field.

**Why a filler root cause is refused.** On 2026-08-14, 13 of the 17 friction
groups holding a root cause said `placeholder`, including one in
`awaiting_approval` whose stated cause was "placeholder while I continue reading".
Those are the investigation agent's scratch notes persisted as a verdict. Printing
the word hands a coding agent a diagnosis that is not one. The guard is anchored
at the start of the string, so a real cause mentioning a placeholder image
survives.

**Why the resolved stack needs a new API field.** `GetSampleEvent` selects
`e.stack_trace_raw` and never `stack_trace_resolved`
(`packages/ingestion/db/queries.go:1262`). 20 of 29 open error groups measured on
2026-08-14 carry a resolved stack pointing at real paths like
`src/modules/common/fetch/fetcher.ts`, and none of it is reachable over HTTP.
Without this, the tool hands a coding agent a minified stack for the kind that
makes up most of the digest.

The envelope is redacted on the way out because a resolved frame can
carry `source_snippet`, which is verbatim customer source lifted from a source map
(`packages/worker/src/resolve-stack.ts:92`). That makes it a stronger disclosure
vector than the raw stack beside it.

Redaction here parses, redacts field by field, and re-marshals, rather than running
the string redactors over the JSON. The string form is regex over text
(`packages/ingestion/masking/masking.go:90`) and can leave a document that no
longer parses, at which point the handler writes a 200 with an empty body because
`json.NewEncoder` buffers. R12 covers it.

Fencing is a weaker control than it looks, and worth being explicit about. The
strings this surface hands a coding agent originate in a customer's browser, and
that agent can edit files and open pull requests. Balanced tags prove nothing on
their own: what matters is that `fence` neutralises any `</untrusted>` inside the
value (`cli/src/mcp/format.ts:17`), so the text cannot close its own fence. R13
covers that case specifically. Neither is a complete defence against a determined
injection, and this design does not claim one.

When nothing was symbolicated the raw stack is shown rather than suppressed.
"Raw" only means minified on browser platforms; a Python or Node backend stack is
already the real thing.

A failed fix attempt preserves its
writeup rather than discarding it (`packages/worker/src/index.ts:1457`), so
`candidate_diff` holds the diff it tried and `reason` carries a message. Today's
item 3 is that working: Opslane generated a diff, its own review rejected it in
writing because swapping `??` for `||` handles null identically, and the rejection
is readable. A developer picking that up starts from a diagnosis, a failed
attempt, and the reason it failed.

### `opslane_link_pr(id, url)`

The only write. Records a pull request the developer opened themselves.

**Why it works from any status.** "I fixed it, here is the PR" is true whether the
incident was `investigated`, `insight`, or `needs_human`. There is no gate to
widen and no state to be refused by. On the 2026-08-14 digest this accepts all
three actionable items; the fix endpoint accepts one.

**Why it sets `status = 'pr_created'`.** Skip this and merges are silently dropped.
`ProcessPRWebhook` matches on `p.github_repo = $1 AND eg.pr_number = $2 AND
eg.status IN ('pr_created','pr_draft')` (`packages/ingestion/db/queries.go:1766`).
Record the PR without the status and the first two conditions hold, the third
fails, the merge is dropped, and the incident never resolves. An earlier draft of
the plan did exactly that, and its tests passed. The end-to-end test now drives
link, webhook, and merge rather than asserting a 200.

A null `pr_fix_job_id` is fine: the webhook guards on `fixJobID != nil` before
touching the job (`queries.go:1821`).

The repository check lives in the UPDATE predicate because reading the project's
repository first and then writing leaves a window between the two.
Folding it in also avoids duplicating `GetProjectGitHubConfig`
(`queries.go:3404`), which takes an `orgID` the handler does not carry.

A PR number already claimed in the same repository is refused. The webhook
documents that `(github_repo, pr_number)` is not unique when projects share a
repository, and that it picks an arbitrary match (`queries.go:1721`). Three
production projects share `conelike/asset-management-jira`. Refusing the second
claim keeps that tuple unique in the only table that can violate it.

## Milestones

| | Deliverable | Exit criterion |
| --- | --- | --- |
| 1 | The resolved stack on `sample-event` | An event with a resolved stack returns `original_file` and `original_line`; one without omits the key entirely |
| 2 | `GET /projects/{id}/digest/latest` | Returns the most recent payload verbatim; 404 when none was sent; another project's digest is not readable |
| 3 | `POST /incidents/{id}/link-pr` | Link, then deliver a merge webhook, and the group reaches `merged`. A foreign repository is refused and `pr_url` stays null |
| 4 | The three tools over stdio | `tools/list` returns exactly the three names; stderr is empty during an `initialize` exchange |
| 5 | The skill and `opslane init-claude` | One named production incident, chosen in advance, goes from `opslane_digest` to a merged pull request in one session, with no dashboard visit and no manual database read. Failure to locate the component counts as a failure of this milestone, not of the session |

Milestone 4 is gated on 1 through 3: the tools have nothing to read until the
endpoints exist.

## Testing and validation

Go handler tests drive the real router with a real database and a real session
token. They need `DATABASE_URL`; without it `testDeps` calls `t.Skip`, so read the
skip count rather than the pass count. A storage misconfiguration reports `ok`
while roughly 30 tests never run.

Vitest covers the pure parts: partitioning, filler detection, rendering, and tool
registration. The client tests mock `authedFetch` rather than the network.

Two things need a live run and cannot be proven in CI. The first is the stdio
cleanliness check, which is a real process and a real JSON-RPC exchange, because
the failure mode is a stray `console.log` anywhere in the import graph. The second
is Milestone 5, which is a person working an item.

Every criterion with an on and an off gets both sides. The filler guard is tested
on strings that must be rejected and on a real root cause containing the word
"placeholder". The receipt filter is tested on `pr_open` and on an unrecognised
state that must not be hidden.

## Risks

**Duplicate projects make the wrong project reachable.** Three production projects
are named AMFJ and two share a repository. The client picks a project from the git
remote, so it can pick the wrong one, and `link_pr` would write to it. The
same-repository guard narrows the blast radius but does not fix the cause. Of
everything here, this is the risk easiest to hit and least addressed.

**A linked PR closed without merging promotes the incident.** The close path
clears `pr_url` and `pr_number`, which makes the incident linkable again. It also
sets `investigated` for errors and `awaiting_approval` for friction
(`queries.go:1861`). An incident that was
`needs_human` with `unfixable_third_party` comes back claiming a validated
diagnosis it never had, and becomes fix-triggerable. This is pre-existing
behaviour for worker-opened PRs; linking widens the set of incidents it reaches.
The plan tests it so the behaviour is recorded rather than discovered later.

**One day of digest history.** Exactly one day in production has the payload shape
these tools read. 2026-08-14 has schema v2 with seven receipt items; 08-13 through
08-10 have no schema version and zero receipt items. Whether seven is typical, and
what an empty day does to a session, is unknown.

**The digest may not be worth reading, and the compound number is small.** The
individual risks above are each survivable; multiplied, they are the thing a
reviewer should attack. On 2026-08-14: seven items, four already carrying a pull
request, and of the three left, one was worth acting on and it was a duplicate of
another. Separately, 13 of 17 friction groups hold a `placeholder` root cause. For
most friction incidents R5 therefore suppresses the leading field, and the agent
receives the positional CSS this document has already shown to be useless.

So the honest answer to "how many items does this make newly workable, with a
payload an agent can act on, on the only day we can measure" is between zero and
one. That is an argument for shipping the upstream issues first, or for treating
this as a spike rather than five milestones. It is not an argument the doc can
settle, and repeating that ranking is out of scope does not dissolve it.

## Alternatives considered

**A live worklist instead of the digest.** This is what shipped in the earlier,
narrower pass. Always current, and never matches what the developer read in Slack.
Rejected: two disagreeing lists are worse than one stale one.

**Keeping `opslane_fix`.** It has a real job, which is the confidence override:
investigation routes on confidence, so high goes straight to a fix and medium or
low parks in `investigated` awaiting a human (`packages/worker/src/index.ts:477`,
`:771`). Rejected for v1 because zero items in the measured digest were in
`investigated`, and because its gate is what refused the two items that needed a
person. It is the first candidate for v2.

**Keeping `opslane_resolve`.** One verb for "I am done here". Rejected because it
writes a claim the developer cannot support, and `link_pr` plus the existing
webhook produce the same ending with evidence attached.

**A standalone `@opslane/mcp` package.** Attractive because it avoids the CLI's npm
hold. Rejected because it cannot authenticate: the only flow producing a session
usable on incident routes is `opslane login`, which lives in the CLI. A standalone
package would reimplement OAuth and token refresh to avoid a dependency it would
then recreate.

**Reshaping the digest payload server-side.** Rejected: it creates a second source
of truth that can drift from what Slack showed, and the digest is only useful
because it is the same list.

## Open questions

Three questions are genuinely open. The second one blocks the friction half of the
product, so this is not a list you can start without reading.

**1. What happens to the 13 friction groups already holding a `placeholder` root
cause?** This blocks. R5 refuses to print filler, so those incidents arrive with no
diagnosis and a selector that cannot locate anything, which by this document's own
argument makes them unworkable. That is most of the friction corpus. Either they
get re-investigated, which is upstream work nobody has scheduled, or friction ships
knowing it works for four groups out of seventeen.

**2. Should linking a PR put the incident in tomorrow's digest as a receipt?**
Today it silently disappears, because the digest windows on
`digest_readiness.updated_at` and `LinkPR` does not touch it. Refreshing readiness
would produce a "you fixed three things yesterday" line. Quiet is defensible; so is
the receipt.

**3. Should `opslane_digest` read older digests?** It returns only the latest, so a
developer picking up Friday's work on Monday gets Monday's digest. With one day of
usable history in production this is untestable today, which is not the same as
unimportant.

### Decisions already made that a reviewer may want to reopen

An earlier draft parked these under open questions, which read as hedging. They are
decided, and each is spec'd and tested in the plan.

**`investigated` after a linked PR is closed unmerged** is recorded rather than
changed, because changing it touches worker-opened PRs too.

**A PR number already claimed in the same repository is refused**, per R9 and
Milestone 3. The alternative is to allow it and accept that the webhook picks an
arbitrary match.

**`resolved` is added to the sample-event response** as an additive optional field,
per Milestone 1. The dashboard consumes that endpoint, so this is a public contract
change even though nothing existing breaks.

## The honest caveat

The design assumes a coding agent can find the component from what the payload
sends, and that has never been driven from a friction incident the pipeline
actually produced. The verification that covered these fields planted its state
with SQL, so it proved the API returns what was put in it, not that the world
produces something useful.

The selector evidence above makes the failure mode concrete rather than
hypothetical: without a root cause, a friction incident gives a coding agent a
route and eight levels of positional CSS. That is the state 13 of 17 friction
groups are in right now, so the untested assumption and the known-bad data meet in
the same place.

One session with one real incident would answer it, costs nothing, and needs none
of the three endpoints. It should happen before Milestone 1, not after Milestone 5.
