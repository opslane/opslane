# Working the Opslane digest from Claude Code (against the landed pipeline)

Status: specification, not built. Supersedes `docs/design/2026-08-14-opslane-mcp-surface.md`,
which was written against the pre-rewrite schema.

The pipeline rewrite has landed on `main` (migrations 054 through 059). This document
is written against that code, not against the plan that produced it.

## Problem

A developer reads the daily Opslane digest in Slack, picks something worth fixing, and
then has to open the dashboard to act on it. The context Opslane already gathered lives
in a web UI, so the developer reads a title on their phone, walks to their editor, and
starts from a blank prompt. The marketing promise is that they never open a dashboard.
Today, acting on a digest item means opening one.

The rewrite makes this worse in one specific way and better in another. Worse: the digest
is now model-authored prose, so the structured facts a coding agent needs are one layer
below what Slack shows. Better: every issue now carries a customer-facing `state`
(`inboxState`, `packages/ingestion/handler/read_api.go:201`) and its evidence is frozen
and addressable, so a good answer exists to give the agent if we expose it. That state
is present for issues that have an episode; pre-rewrite issues, friction buckets, and
archived issues carry none (`attachPipelineState`, `read_api.go:228`).

## What this builds

Three MCP tools inside the existing `@opslane/cli`, run as `opslane mcp` over stdio, and a
Claude Code skill that drives them:

- `opslane_digest()` returns today's model-selected issues as facts, not prose.
- `opslane_issue(id)` returns everything Opslane knows about one issue, rich enough to fix
  without a second system.
- `opslane_link_pr(id, url)` records a pull request against an issue.

And the server-side reads and one write they need, because none exist yet.

This replaces the MCP surface that already ships. `cli/src/mcp/tools.ts` registers three
pre-rewrite tools against the old friction schema: `opslane_worklist`, `opslane_issue`, and
`opslane_resolve`. `opslane_resolve` writes `resolved` (`client.ts:88`), which this design's
non-goals forbid, so it is deleted rather than renamed. `opslane_worklist` becomes
`opslane_digest`. The CLI-side files that assume the old shape (`format.ts`, `client.ts`,
built around `element_selector` and `/incidents?kind=friction`) are rewritten against the
new endpoints. `opslane mcp` and `opslane init-claude` are already wired
(`cli/src/index.ts:176,186`); only the tools, the skill, and the client change.

A glossary, because the rewrite renamed the nouns:

- An **issue** is a stable problem. Its database row is an `error_group`; its identity is
  settled after stack resolution rather than at write time.
- An **episode** is one open round of work on an issue. A resolved issue closes its
  episode; a later recurrence opens a new one.
- The **digest** is the daily message. A Go query freezes a candidate set, then a model
  chooses which candidates to `include` and writes prose for each (`DigestPayload`,
  `packages/worker/src/digest-writer/schema.ts`).
- **Resolution** is a status of `resolved` on the issue. A database trigger then closes
  the open episode (`055_close_episodes_on_resolution.sql`).
- A **pull request** attached to an issue lives on `error_groups`: `pr_url`, `pr_number`,
  `pr_created_at`, and `status = 'pr_created'` (`error_groups`, `001_baseline.sql:83,91`; `pr_created_at` added in `006_admin_observability.sql:4`). It does not live on
  `diagnosis_decisions`, which records only the diagnosis. The merge webhook matches a PR
  by `github_repo` + `pr_number` + `status IN ('pr_created','pr_draft')`
  (`queries.go:1876`), so those columns, not the URL alone, are what make a merge resolve.

## Goals

Work one digest item end to end from a Claude Code session: read it, find the code, fix
it or review Opslane's fix, record the pull request. Never open the dashboard.

Hand a coding agent everything Opslane learned about an issue, so a `needs_human` is
fixable from the editor and a `verified_fix` is reviewable there.

Ship against the landed pipeline, reusing its frozen evidence rather than recomputing it.

## Non-goals

**Choosing what matters.** The MCP shows the model's selection. It does not re-rank, filter,
or second-guess the digest. If the selection is wrong, that is pipeline work.

**Marking anything resolved from a human claim.** No tool writes `resolved`. A fix is
resolved when it ships and the issue goes quiet, which the pipeline's auto-resolvers and
the closure trigger already handle.

**Reproducing the dashboard.** The dashboard is for browsing every issue. The MCP is for
working the day's selection. The list is the digest's `included` set, not the full inbox.

**Designing around the dashboard.** This is MCP-first. A coding agent wants one call that
returns everything to fix an issue; a human wants to click between tabs. The evidence
endpoint is shaped for the agent, one round trip, and the dashboard adopts it rather than
the MCP matching the dashboard's current three-call sprawl (`getIncident` +
`getSampleEvent` + `getReplay`, `IncidentDetail.vue:5`).

**Carrying the inquiry's evidence.** The worker's `loadEvidence` also returns session write
rollups, product context, and related candidates, because the inquiry consumes them to
decide whether to investigate. A coding agent fixing code does not, so they are left out.

## Requirements

| | Requirement | Verified by |
| --- | --- | --- |
| R1 | A developer sees today's model-selected issues | `opslane_digest` returns the `included` set of the latest delivered `digest_run` |
| R2 | Each list row carries enough to choose without a second call | A row has the issue, its `state`, affected users or accounts, and a PR URL when one exists |
| R3 | An issue that already has a PR is flagged with its URL | A row shows `error_groups.pr_url`, already stamped onto the delivered digest card (`digest/validate.go:144`) |
| R4 | A developer sees a resolved stack pointing at real source | `opslane_issue` returns frames from `error_event_resolutions.envelope`, read through the episode's anchors |
| R5 | A `needs_human` friction issue is locatable | `opslane_issue` returns the failing request from `session_request_failures` when the diagnosis alone does not name a component |
| R6 | The developer sees what Opslane already tried | `opslane_issue` returns the diagnosis outcome and `decision_reason` from `diagnosis_decisions`, and `error_groups.pr_url` when set |
| R7 | A developer records a PR | `opslane_link_pr` writes `error_groups.pr_url/pr_number/pr_created_at` and sets `status = 'pr_created'`, refusing to overwrite an existing `pr_number` |
| R8 | Recording a PR does not claim the issue is fixed | `opslane_link_pr` does not set `resolved`; the pipeline resolves on merge-and-quiet |
| R9 | Customer text reaches a model as data | Titles, routes, and diagnosis text are fenced, and the fence cannot be closed by its content |
| R10 | The protocol is not corrupted by logging | An `initialize` exchange returns one line of JSON-RPC and stderr is empty |

## System overview

```mermaid
sequenceDiagram
    participant D as Developer
    participant CC as Claude Code
    participant M as opslane mcp
    participant I as Ingestion API
    participant G as GitHub

    D->>CC: "let's work today's Opslane digest"
    CC->>M: opslane_digest
    M->>I: GET /projects/{projectID}/digest/latest
    M-->>CC: today's included issues as facts, PRs flagged
    CC->>M: opslane_issue(id)
    M->>I: GET /projects/{projectID}/incidents/{incidentID}/evidence
    Note over I: anchors -> resolved frames,<br/>failing request, diagnosis, PR
    alt fix ready
        CC->>D: review Opslane's PR
    else needs human
        CC->>CC: locate the component, fix, run tests
        CC->>G: open a pull request
        CC->>M: opslane_link_pr(id, url)
        M->>I: POST /projects/{projectID}/incidents/{incidentID}/link-pr
    end
    G->>I: fix ships, issue goes quiet
    Note over I: auto-resolver sets resolved,<br/>trigger closes the episode
```

## Component design

### `opslane_digest()`

Reads the latest delivered `digest_run` (`status = 'delivered'`) and returns the cards in
its `rendered_payload.digest.generated_cards` as structured facts. Validation is fail-closed rather than a filter: if any card's claimed label, count, or
accounts disagree with the frozen candidate, the whole run is rejected
(`digest/validate.go:128`). A delivered run therefore has every card stamped from the
candidate, so `generated_cards` is system-truth by construction, not by trusting the
model.

It reads the delivered run rather than running a live query. The developer arrives having read the Slack
digest. A live query would return a different set, so the item they came for might be
missing or joined by items they never triaged. The digest is only useful because it is the
same list. The run is already frozen and stored in `digest_runs.rendered_payload`, so this is a read,
not a recomputation. The same "latest delivered" query already runs in
`cmd/digest-eval/main.go:44`.

Facts rather than the model's prose, and this turns out to be nearly free. Two payload columns are
easy to confuse. `writer_payload` (also `payload`) holds the model's `{included, deferred}`
output (`digest-writer/schema.ts`), written for a person. `rendered_payload` holds the
delivered `GeneratedDigestCard`s (`notify/event.go:78`), and `digest/validate.go:144` stamps each
one with the system's own `incident_id`, `title`, `affected_users`, `accounts`, and
`pr_url` taken from the frozen candidate, not the model. So the delivered cards already
carry system-truth facts. The list reads them and joins only `inboxState`, which the
`generated_cards` do not include. It keeps the model's one-line `action` as a hint.

The PR flag is a first-class field for a reason. A `verified_fix` row means Opslane already
opened a PR. The developer's job there is review, not authoring, and burying the URL inside
a detail call would cost a round trip per row. The URL rides on the list row.

### `opslane_issue(id)`

Everything known about one issue in one call, assembled from the frozen evidence so a
coding agent acts without a second round trip. This reads one new endpoint,
`GET /projects/{projectID}/incidents/{incidentID}/evidence`, which is the shared source of
"an issue's evidence": the dashboard moves onto it too. The bundle is deliberately smaller
than the worker's `loadEvidence`, carrying only what a fix needs.

It reads anchors, never `sample_event_id`. The pipeline freezes three evidence
events per episode in `issue_evidence_anchors` (`anchor_kind` of `threshold`, `first`,
`recent`). `sample_event_id` is rewritten on every new occurrence
(`db/queries.go` rewrites it), so reading it would hand the agent a moving target. The
detail view reads the anchored events, which are stable.

The resolved stack comes from `error_event_resolutions`. The rewrite resolves
stacks to source before grouping and stores the frames in `error_event_resolutions.envelope`
as JSONB. Reading that gives the agent file and line against the developer's own tree. The
old `sample-event` endpoint returned only the raw minified stack; this is the field that
was missing.

The failing request earns its place on friction issues. A `needs_human` friction issue often
cannot be located from the diagnosis alone, because the selector is positional and its
classes are generated at build time. `session_request_failures` carries the route, method,
endpoint pattern, and status for the failing action, which points the agent at the network
call behind the dead click. This is the cheapest evidence that closes the friction gap.

It hands over the diagnosis and the attempt. The issue carries a diagnosis outcome
of `verified_fix`, `needs_human`, or `unable_to_establish_cause`, plus a summary and a PR
when one exists. For a `needs_human`, that summary is where the agent starts. For a
`verified_fix`, the PR is what it reviews.

**When there are no anchors.** Pre-rewrite issues and friction buckets can lack an episode,
and therefore anchors (`attachPipelineState`, `read_api.go:228`). The endpoint returns empty
evidence with stated availability, never an error, matching `loadEvidence`'s behavior when
`retainedSessionIds` is empty (`evidence/bundle.ts`). R5 still holds for the issues it
targets: a `needs_human` diagnosis implies an investigated episode, which has anchors.

**Bounded and fenced.** Every field is capped, the payload is capped, and truncation is
marked. Titles, routes, and diagnosis text come from customer browsers or a model, so they
are wrapped and the wrapper cannot be closed by its content.

### `opslane_link_pr(id, url)`

Records a pull request against an issue. The only write.

The write is symmetric with Opslane's own PR. A PR attached to an issue is one fact: a
fix is in flight at this URL. It does not matter who opened it. Opslane records its own PR
on `error_groups` (`pr_url`, `pr_number`, `pr_created_at`, `status = 'pr_created'`); the
developer's PR goes in the identical columns. There is no separate developer-PR record.

**Why it sets `status = 'pr_created'`, which is required, not optional.** The merge webhook
matches on `pr_number` and `status IN ('pr_created','pr_draft')` (`queries.go:1876`). Write
the URL without the status and the merge never matches, and the issue never resolves. This
is the exact bug that reached a green test suite in the pre-rewrite design. Setting the
status is not a claim the fix works; it is the claim that a PR exists, which just became
true. `resolved` is still never written here.

**Why it refuses to overwrite an existing `pr_number`.** Forcing `pr_created` over a group
that already holds Opslane's own `pr_number` would clobber Opslane's PR association and
break the merge match for that PR. So the write is guarded: it refuses when `pr_number` is
already set, and it confirms the PR's repository matches `projects.github_repo` first.

**How the URL becomes a `pr_number`.** The merge match is `github_repo` + `pr_number`
(`queries.go:1878`), so the write must extract the number correctly or the merge silently
never matches. Reuse `projectPullRequest` (`digest/validate.go:287`), which parses a
`https://github.com/{owner}/{repo}/pull/{n}` URL and confirms the repo. It returns a bool
rather than the number, so `link_pr` still extracts `parts[3]` as the `pr_number`. This is
the whole reason the tool exists rather than telling the developer to paste a URL into a
form: a wrong number looks like success and resolves nothing.

**The cost of setting `pr_created`: the merge webhook becomes the only resolver.**
`resolveInactiveGroups` excludes `pr_created` (`db.ts:1668`). So a linked PR that is
abandoned, or lands in a repository other than the project's, strands the issue in
`pr_created` with nothing to auto-resolve it. The repository guard removes the wrong-repo case; the
abandoned-PR case is a real edge the pipeline does not currently sweep.

## Server-side work

Three reads and one write, all Go, all reused by the dashboard.

**`GET /projects/{projectID}/digest/latest`.** Returns the latest delivered run's `included`
episodes joined to issue facts and `inboxState`. New. Nothing serves the digest today.

**`GET /projects/{projectID}/incidents/{incidentID}/evidence`.** The shared evidence source.
One call returning the fix-shaped bundle: the diagnosis and outcome, the resolved stack
frames, the route and selector, the failing request, a replay pointer, and the PR when set.
It assembles from `issue_evidence_anchors`, `error_event_resolutions`, and
`session_request_failures`, a Go port of the worker's `loadEvidence` (`evidence/bundle.ts`)
minus the three inquiry-only fields. New. The incident endpoint already carries `state`,
`episode_id`, priority, root cause, selector, route, and the anchor event IDs
(`read_api.go:201,73`), but not the frozen frames or the failing request, so the evidence
endpoint composes those existing facts with the two missing pieces.

**`POST /projects/{projectID}/incidents/{incidentID}/link-pr`.** Writes `error_groups.pr_url/pr_number/`
`pr_created_at` and `status = 'pr_created'`, guarded against overwriting an existing
`pr_number` and against a foreign repository. New.

Two things are more built than a first look suggests, and the evidence endpoint should lean
on them. The incident detail endpoint already returns per-issue `state`, `episode_id`, and
the anchor `evidence_event_ids` via `IssuePipelineRecords` (`db/inbox.go:28`,
`read_api.go:259`). And `packages/worker/src/evidence/bundle.ts` `loadEvidence` is a
complete blueprint for the bundle: frames from `error_event_resolutions.envelope` through
the anchors, failing requests from `session_request_failures`, a `recordingAvailability` of
`available`/`partial`/`expired`/`missing`, and a replay pointer. The Go endpoint is a port
of it. Only the frames and the failing-request assembly are genuinely net-new; the anchor
IDs are already exposed.

## Milestones

| | Deliverable | Exit criterion |
| --- | --- | --- |
| 1 | `GET /projects/{projectID}/digest/latest` | The latest delivered run's `included` set returns as facts with state and PR URL; a project with no delivered run returns an empty set, not an error |
| 2 | `GET /incidents/{id}/evidence` | An issue returns resolved frames from its anchors and the failing request; an issue whose recording expired returns stated availability, not an error |
| 3 | `POST /incidents/{id}/link-pr` | A PR sets `error_groups.pr_number` and `status='pr_created'`, then a merge webhook drives the issue to `merged`; a foreign repo and an already-set `pr_number` are both refused |
| 4 | The three tools over stdio | `tools/list` returns exactly `opslane_digest`, `opslane_issue`, `opslane_link_pr` and no others, so a leftover `opslane_resolve` fails the check; stderr is empty during `initialize` |
| 5 | The rewritten skill and tools | From a linked repository, a fresh session works one item start to finish without the dashboard. `opslane init-claude` already ships, so only the skill and the three tools are new here |

Milestone 4 is gated on 1 through 3.

## Testing and validation

Go handler tests drive the real router with a real database and a real session token.
Database-gated tests skip when `DATABASE_URL` is unset, so read the skip count before
trusting a green suite. Note the pattern is not uniform: `digest/build_test.go:20` falls
back to the Compose DSN rather than skipping, so a bare `go test ./...` still exercises that
package.

Vitest covers the pure parts: digest partitioning, fencing, rendering, and tool
registration. Client tests mock `authedFetch`.

Two things need a live run: the stdio cleanliness check, because a stray `console.log`
anywhere in the import graph corrupts the protocol, and Milestone 5, which is a person
working an item.

## Risks

**Duplicate projects make the wrong project reachable.** Production has multiple projects
named AMFJ sharing a repository. The MCP picks a project from the git remote, so it can pick
the wrong one, and `link_pr` would write to it. The repository check does not help here: the
duplicates share a `github_repo`, so it passes for both. Worse, the merge webhook matches on
`github_repo` and `pr_number` without scoping to a project (`queries.go:1878`), so a
`pr_number` that collides with a sibling project's Opslane PR could resolve the wrong
project's issue. The `link_pr` write is what makes that reachable. The real fix is
de-duplicating the AMFJ projects, which is upstream.

**Evidence availability degrades.** Recordings and source maps expire. The evidence endpoint
must state what is missing rather than fail, or a coding agent treats an expired recording
as an empty one.

**A linked PR can strand an issue in `pr_created`.** Once the write sets `pr_created`, the
merge webhook is the only resolver, because `resolveInactiveGroups` excludes that status
(`db.ts:1668`). A PR opened and then abandoned leaves the issue stuck. The repository guard
handles the wrong-repo case; the abandoned case needs a pipeline sweep that does not exist
yet, and is worth flagging to whoever owns resolution.

**The digest may be empty or thin.** The pipeline is new. If a day's run includes few
issues, the MCP is honest but sparse. This surface delivers the selection; it cannot enrich
it.

**The evidence assembly is a second implementation.** The Go endpoint ports `loadEvidence`
from the worker's TypeScript (`evidence/bundle.ts`). They read the same frozen anchors, so
they select the same events, but the two shapes are authored separately and can drift. The
mitigation is to mirror `loadEvidence` field for field and test both against one fixture,
rather than designing a fresh shape.

## Alternatives considered

**Read the model's prose cards directly.** Rejected. The cards are written for a human
reader. A coding agent wants facts, and the facts are one join below the prose.

**Call the worker's `loadEvidence` over HTTP.** Rejected. It would make the inquiry, a
batch job, depend on ingestion being up at request time, which it does not today. The two
services share a database and nothing else. Instead the Go evidence endpoint ports
`loadEvidence`'s shape and reads the same frozen tables, so the two agree by mirroring, not
by a runtime call.

**Match the dashboard's three-call evidence pattern.** Rejected. That pattern suits a human
paging between tabs. An agent wants one call and the full context, so the MCP defines the
one-call endpoint and the dashboard converges onto it.

**Serve the full inbox instead of the digest.** Rejected for the list. The inbox is for
browsing; the day's work is the digest's selection. The inbox belongs behind a future tool,
not this one.

**A standalone `@opslane/mcp` package.** Rejected. Only `opslane login` produces a session
usable on these routes, and it lives in the CLI. A standalone package would reimplement
auth to avoid a dependency it would then recreate.

## Open questions

None block starting. Relinking after a developer opens the wrong PR is deliberately punted:
the overwrite guard protects Opslane's PR, and correcting a wrong link is a rare case not
worth the branch in v1. The empty-digest fallback and the one-versus-many evidence calls
were both settled during review, against a fallback and for one call.

## The honest caveat

The detail view assumes the frozen evidence is enough for a coding agent to fix a
`needs_human` from the editor. This has never been driven from a real production issue
through the new pipeline. The anchors, resolutions, and session failures all exist as
tables; whether their contents, assembled, let an agent find and fix a component is
untested.

The sharper risk is coverage. The detail view is anchor-dependent, and a share of issues
carry no episode and therefore no anchors, so they return empty evidence. Friction, which
dominates actionable volume, is exactly where the diagnosis is thinnest and the failing
request matters most. So the honest test is not "does the bundle assemble" but "on a real
friction `needs_human`, is the assembled evidence enough to fix." One session with one such
issue would answer it, and it should happen before the rewrite of the tools ships, not
after.
