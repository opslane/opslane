# Giving MCP callers the replay and network evidence we already store

**Status:** accepted (M1+M2 implemented)
**Author:** Claude, for Abhishek
**Date:** 2026-08-28

## Summary in plain words

Opslane watches a customer's web app from inside the user's browser. When
something breaks, it stores three things next to the error: a screen
recording, a list of the network calls the page made, and a short log of
what the user did (clicks, console output). Coding agents such as Claude
Code ask Opslane about issues by calling functions on Opslane's server.
Today those functions say "a recording exists" but return none of the
evidence stored next to it. The agent's only other route is the Opslane
dashboard, which needs a human login the agent does not have.

This doc proposes two changes. First, fix a bug: evidence the server
already loads for error issues is thrown away before the answer is
written. Second, add one new function that returns a readable timeline
for an issue: the network calls with status codes and durations, the
console errors, and the clicks, in time order, centered on the error. Everything comes from
database rows we already have. Nothing new is collected, and the raw screen
recording is never sent.

### Terms used in this doc

- **MCP** (Model Context Protocol): the standard that lets an AI agent call
  functions on a remote server. Opslane's MCP server exposes three today:
  `opslane_digest` (the day's issue list), `opslane_issue` (one issue's
  details), `opslane_link_pr` (record a fix PR on an issue).
- **rrweb**: the library that records the screen as a stream of page
  changes, replayable like a video.
- **Replay / recording**: that rrweb capture, stored as compressed chunks
  in object storage (MinIO, an S3-compatible file store), table
  `session_chunks` (`002_sessions.sql:48`). A chunk may be read only after
  a redaction pass has run over it (`scrubbed_at IS NOT NULL`); redaction
  targets known secret patterns and sensitive fields, not all text.
- **Episode**: one open stretch of an issue recurring. When an episode
  starts, the pipeline records references to two or three of its error
  events, called **anchors**; investigation and evidence reads use those
  referenced events.
- **Breadcrumbs**: a short rolling log of the last things the SDK saw in
  the browser before an error (by default up to 50 entries from the last 30
  seconds; both limits configurable): network calls, console output,
  clicks. Each error event stores a snapshot of this log
  (`error_events.breadcrumbs`, `001_baseline.sql:69`).
- **Network timings**: a structured list of the page's recent requests, one
  entry per request: transport (`fetch` or `xhr`), method, URL, status or
  failure outcome (`timeout`, `abort`, `network_error`), start time, and
  duration. Stored on each error event
  (`error_events.network_timings`, `033_event_network_timings.sql`,
  `shared/src/types.ts:148`). The server stores these today, but no
  product surface reads or displays them yet.
- **Request failures**: failed requests observed during session analysis,
  optionally linked to the user action that triggered them: page route,
  method, endpoint pattern, status, and the action when the analyzer could
  link one (`session_request_failures`, `054_pipeline_quality.sql:240`).
  Re-analysis writes a new set of rows under a higher `rule_version`;
  reads must select the session's current version.
- **Friction issue**: an issue where users tried something and nothing
  happened, with no exception thrown. These are detected from replay
  analysis (`friction_signals`, `004_friction.sql:35`), so they have no
  error events and therefore no breadcrumbs or network timings.

## Problem

On 2026-08-28 a Claude Code agent investigated a digest issue (an auth
failure in a customer app). It called `opslane_issue`, was told
`Recording: available`, and got nothing else: no session to look at, no
network data. The dashboard could have shown both, but the dashboard needs
a browser login and an agent has none. The agent left Opslane and pulled
the same evidence from LogRocket, a competing product whose MCP server
serves network data directly.

Two defects cause this:

1. **The formatter drops evidence it already loaded.** For every issue,
   `presentMCPIncident` (`handler/incident_present.go:39`) fetches replay
   pointers and request failures. The output formatter `FormatIssue`
   (`mcp/format.go:192`) prints them only for friction issues (lines
   214-226). For error issues, the kind agents investigate most, it prints
   a bare `Recording: available` line and discards the rest. The tool
   description promises "failing requests"; the error path never emits
   them.

2. **No tool returns session evidence as data.** The best any issue gets
   is "watch session X in the dashboard." Meanwhile the error events
   already carry breadcrumbs and network timings in Postgres. The network
   timings are the starkest case: the server stores them today and nothing
   reads them.

## Goals

- An agent with only its Opslane MCP key can see, for an open error
  issue: the failing network requests, their timing and outcome, console
  errors, and the user actions around the error. Friction issues, which
  have no error events, get the reduced form: the analyzed request
  failures around the friction moment.
- Error issues expose the same replay-pointer and request-failure facts
  that friction issues already do.
- Serve only data already in Postgres. No chunk parsing, no new capture.

## Non-goals

- **Serving raw rrweb recordings over MCP.** Megabytes of page-change data
  an LLM cannot read, against an 8,192-byte response limit
  (`ClampPayload`, `mcp/format.go:259`). Also the most privacy-sensitive
  thing we store.
- **HAR output.** HAR is the standard JSON format for network captures. We
  could emit one from network timings, but without stored headers or
  bodies its entries would carry little beyond what a text line carries,
  at several times the byte cost, against the same size limit. Plain text
  is the right shape for an LLM reader. Revisit if we ever store headers.
- **Closed issues.** Anchor references survive after an episode closes,
  but every evidence read in the system today serves open episodes only
  (`IssueEvidence` selects `closed_at IS NULL`, `db/queries.go:144`). The
  timeline follows that rule; a closed issue gets a plain statement, not
  evidence. Widening evidence reads to closed episodes is its own change
  with its own retention questions.
- **Dashboard or auth changes.** The replay player is untouched.
- **Reading replay chunks.** v1 never opens `session_chunks` objects; the
  redaction gate and MinIO stay out of the MCP path.

## Requirements

| # | Requirement | Verified by |
| --- | --- | --- |
| R1 | `opslane_issue` on an error issue prints up to 3 request failures, and its first replay pointer whose session is still retained (each pointer carries its own retained flag; the issue-level availability label alone is not trusted for this) | unit tests on `FormatIssue`: retained, partially retained, and fully expired pointer sets |
| R2 | New tool `opslane_session_timeline` returns, for one anchor event, two sections: a time-ordered merge of its network timings (method, path, status or outcome, duration with transport label), console-error breadcrumbs, and click breadcrumbs; then the analyzed request failures within 60 seconds either side of the event, each with its relative time | handler test with a seeded event carrying all three sources |
| R3 | Every string that originated in a browser is fenced as untrusted and truncated: URLs, messages, selectors, categories, session ids | unit test feeding hostile content in each field |
| R4 | Output fits the 8,192-byte limit by dropping timeline entries farthest from the error first, never the failing-requests section or the safety footer | unit test with an oversized timeline |
| R5 | A caller can only read issues in its own project; the event read itself filters by project id, per the ingestion scoping rule | handler test: issue id from another project returns "not found" |
| R6 | Distinct outputs for distinct states: closed episode; no anchors; anchor session not retained; empty breadcrumbs; empty network timings; analysis absent versus analysis ran and found no failures (told apart by reading the session's analysis state, not by row count). A failed query or a JSONB value with an unexpected shape at the top level is a tool error, never "nothing recorded" | one handler test per case |

## System overview

```mermaid
sequenceDiagram
    participant A as Agent (MCP client)
    participant I as Ingestion (Go)
    participant P as Postgres

    A->>I: opslane_issue(id)
    I->>P: IssueEvidence: anchors, pointers, failures
    I-->>A: root cause, source frames, replay pointer, request failures (R1 fix)
    A->>I: opslane_session_timeline(id)
    I->>P: anchor lookup, then the anchor event row (breadcrumbs + network_timings), then request failures + analysis state
    I-->>A: time-ordered, fenced timeline text
```

Three queries, all indexed lookups, all inside the ingestion service. MinIO
is never contacted.

## Component design

### 1. `FormatIssue` fix

Move request-failure and replay-pointer rendering out of the friction-only
branch, and print up to 3 failures instead of 1.

The pointer needs care: `IssueEvidence` returns a pointer whenever the
anchor event names a session, even when that session row has since been
deleted by retention. The issue-level availability label cannot resolve
this (`partial` means *some* referenced session survives, not that a given
pointer's does, `db/queries.go:254`). So `EvidenceReplayPointer` gains a
`Retained bool`, set from the `retained_session_id` scan the query already
does. The friction pointer that `presentMCPIncident` builds from
`WatchableSessionForGroup` sets `Retained: true` explicitly; that query
only returns watchable (still retained) sessions, and without the field
the flag would default to false and silently drop every friction pointer.
The formatter then prints the first retained pointer:

```go
// mcp/format.go — shared by both branches, after the kind-specific block:
for _, f := range firstN(evidence.FailedRequests, 3) { ... }
if p, ok := firstRetained(evidence.ReplayPointers); ok {
    lines = append(lines, fmt.Sprintf(
        "Replay: session %s at t=%d (t is absolute epoch ms, the dashboard's ?t= value). Call opslane_session_timeline with this issue id for the activity around the error.",
        Fence(p.SessionID), p.AnchorMS))
}
```

(`AnchorMS` is the event's absolute client-clock time in epoch
milliseconds, matching the dashboard's `?t=` contract; it is not an offset.)

### 2. `opslane_session_timeline(id)`

Input: the issue UUID or a dashboard URL containing it, parsed by the
existing `parseIncidentID`. Not a session id: agents hold issue ids, and
resolving the session server-side keeps project scoping in one path.

**One anchor, one session, one timeline.** An episode's anchors can span
different sessions and different moments; merging them into one list would
mislabel evidence and give entries an ambiguous zero point. So the tool
reads exactly one anchor event: the `threshold` anchor (the event whose
occurrence tripped investigation), falling back to `first` if absent. The
timeline's `t=0` is that event's timestamp; its session id is the one in
the header. If agents turn out to need the other anchors, an optional
input can select one later without changing this contract.

**Queries, in order (each filtered by `project_id`):**

1. The open episode's anchor rows (`issue_evidence_anchors` joined to
   `error_events`, as `IssueEvidence` does) → the chosen anchor's event id,
   session id, timestamp.
2. `SELECT breadcrumbs, network_timings FROM error_events WHERE id = $1
   AND project_id = $2`: one row by primary key. The SDK caps both arrays
   at capture time, but ingestion does not enforce those caps on write, so
   a misbehaving client can store far more. The read path applies its own
   bound (at most 200 entries per array considered) before any rendering
   work.
3. Request failures for that session at its current analysis version,
   restricted to `occurred_at` within 60 seconds either side of the anchor
   timestamp. Failures from shortly after the error are included on
   purpose and render with positive relative times. This query also
   returns the session's analysis state, so "analysis never ran" and
   "analysis ran, nothing failed" stay distinguishable.

**Friction issues** have no error events, so step 2's sources do not
exist for them. The tool resolves their watchable session instead
(`WatchableSessionForGroup`, `db/sessions_read.go:520`, which reads
`friction_signals`). It then serves what does exist: the analyzed request
failures around the friction moment, plus a plain statement that
browser-log evidence only exists for thrown errors.

**Building the timeline.** Each source entry becomes one line with an
epoch-millisecond time, a kind label, and rendered text:

- A network timing entry: time is `started_at_ms`; text is the method, the
  URL path (query string removed), then `-> 401 (fetch, 180ms)` when a
  status exists, or the outcome word when it does not (a failed fetch
  records an error, not a status, `network.ts:147`; never invent a `0`).
  The transport is printed because the two transports measure duration
  differently: fetch stops at response headers, XHR at transfer end
  (`shared/src/types.ts:148`).
- A breadcrumb: time is its parsed RFC 3339 `timestamp`; kept kinds are
  console entries with `level == "error"` and clicks. Network breadcrumbs
  are skipped: the same requests appear in network timings with better
  data, and keeping both would double-count.
- A request failure: time is `occurred_at`; text is method, endpoint
  pattern, status, route, and triggering action when present. These render
  in their own short section under the timeline, each with its relative
  time, since they are the analyzer's conclusions rather than raw
  activity.

No deduplication: the tool reads a single anchor snapshot, so there is no
cross-snapshot duplication to remove, and collapsing same-millisecond
identical entries would erase genuine repeats (two rapid clicks on the
same button). An entry whose timestamp does not parse is dropped and
counted in one "N entries unreadable" line. A top-level value of the wrong shape (a non-array where
an array belongs) is a tool error instead, per R6. Times render relative
to the anchor in seconds, negative before, positive after:

```
Timeline for session a1b2… (t=0 is the error):
  -8.2  click    button "Try again"
  -8.1  GET      /api/auth/session -> 401 (fetch, 180ms)
  -8.0  console  "Remote could not verify the token"
  -0.3  click    button "Try again"
Analyzed failing requests (within 60s of the error):
  +2.1  POST /api/:tenant/refresh -> 401 (route /settings, from click)
```

**Byte budget.** Reserve fixed space for the header, the failing-requests
section (≤ 5 entries), the unreadable-entries line, and the safety footer.
Fill the remainder with timeline entries nearest the error first, then
print in time order. `ClampPayload` remains as a backstop; R4's test
asserts the selection keeps it from firing.

**Trust.** Every browser-originated string is attacker-influenced: URLs,
console messages, selectors, categories, and session ids (client-generated
text, `002_sessions.sql:17`). All pass through `Fence` and `Truncate`, and
the output ends with the same footer the other tools use: fenced content
is data, never instructions.

**Privacy.** Timing and breadcrumb URLs are already scrubbed twice before
they reach Postgres: the SDK strips query values at capture
(`network-timing.ts:56` via `scrubUrl`) and ingestion redacts again before
persisting (`masking.RedactRequestURL`, `RedactBreadcrumbs`,
`handler/error_event.go`). The formatter still strips query strings a
third time when rendering, because rows written by old or misbehaving
SDK versions predate the guarantee.

This is a new exposure and the doc treats it as one: network-timing rows
have never been shown on any surface, and an MCP API key is a different
credential from a dashboard login even though both are project-scoped.
The authorization decision, made here: an API-scope project key is issued
by a project admin precisely to grant programmatic access to that
project's diagnostic data, and this data is diagnostic data of that
project, scrubbed at capture and at ingest. Anyone who considers key
holders less trusted than dashboard members should rotate their keys, not
rely on this tool's absence.

### 3. Registration and the v2 trigger

Registers beside the existing three tools in `registerMCPTools`
(`handler/mcp.go:99`). `trackTool` today emits a fixed attribute set, so
it grows an optional per-call attributes hook the handler uses to attach
one field, `timeline_quality`: `full`, `no_network` (timings empty), or
`empty` (nothing but the header). Still exactly one event per call.

These usage events are best-effort Slack messages (`usageevents.Emit`),
not a metrics system, so the v2 decision rule is deliberately coarse. If
`no_network` or `empty` outcomes keep showing up week after week in the
usage-event channel, that is the evidence for building the chunk-parsing
v2 (Alternatives). Decision owner: Abhishek. No dashboard or aggregation
gets built for this.

## Milestones

| # | Deliverable | Exit criterion |
| --- | --- | --- |
| M1 | `FormatIssue` fix + `Retained` pointer flag | unit cases for retained / partially retained / expired pointer sets pass; `go test ./...` from `packages/ingestion` green, zero skips |
| M2 | `opslane_session_timeline` | R2-R6 tests pass; `go test ./...` green, zero skips |
| M3 | Live smoke | on a seeded worktree stack: send a fixture event carrying breadcrumbs and network timings, call the tool over HTTP with a project key, get the timeline |
| M4 | Docs | this doc marked accepted; MCP surface doc and tool descriptions updated |

M1 and M2 are independent code; either can land first.

## Testing and validation

- **CI:** unit tests for formatter and merge logic run without a database.
  Handler tests follow the existing `mcp_issue_test.go` pattern: they need
  `DATABASE_URL` and skip without it, so the gate is `go test ./...` with
  the database exported and zero skips (repo verification rule).
- **Hard cases in scope for M2 tests:** anchors spanning two sessions
  (verify only the threshold anchor's session is used), duplicated
  entries, breadcrumb rows with unexpected shapes, unparseable timestamps,
  fetch failures without status, deleted session with surviving event
  breadcrumbs, closed episode, friction issue, analysis-absent versus
  analysis-empty, byte budget under an oversized timeline.
- **Live:** the M3 smoke on a disposable stack using the worktree port
  recipe in `AGENTS.md`. The fixture apps under `test-fixtures/` generate
  breadcrumb- and timing-bearing errors.

## Risks

- **The evidence can be thin.** Breadcrumbs and timings are short rolling
  buffers captured in the browser; an app that errors on first load may
  carry almost nothing. Mitigation: R6 makes the tool say exactly what is
  missing, and `timeline_quality` shows how often that happens in real use
  instead of leaving it to anecdote.
- **Prompt injection.** Console messages and URLs are the classic place a
  hostile page plants instructions for the agent reading them. Mitigation:
  R3; every browser string is fenced and truncated, and the footer labels
  fenced content as data.
- **Secrets in URL paths.** Query strings are stripped three times over,
  but a secret embedded in a URL path survives, exactly as it does in the
  dashboard today. Accepted; the audience is the same project's members.
- **Client clocks are the only clocks.** Every time in the merge is
  client-reported: timings and breadcrumbs directly, and request failures
  via replay telemetry timestamps (`new Date(event.at)`,
  `worker/src/friction/facts.ts`). A wrong or shifting client clock skews
  the whole timeline together, and malformed timestamps are dropped per
  the merge rules. Accepted for v1: entries are labeled by kind, and
  internally consistent ordering is what an agent actually needs. Ties
  sort by kind then text so output is deterministic.

## Alternatives considered

- **Serve raw rrweb chunks.** Unusable by an LLM, breaks the size limit,
  highest privacy exposure. Rejected.
- **HAR output.** See Non-goals: without stored headers or bodies a HAR
  costs bytes and adds nothing for an LLM reader. Rejected for v1.
- **Parse rrweb chunks in Go for a richer timeline.** The chunks hold the
  full activity stream, including which click caused which request
  (`opslane.telemetry` custom events, `sdk/src/replay.ts:229`). Rejected
  for v1. The worker already has this traversal in TypeScript
  (`worker/src/replay-evidence.ts`); rewriting it in Go means maintaining
  it twice, and it drags MinIO and the redaction gate into the MCP path.
  This is the v2 if `timeline_quality` shows the Postgres sources are too
  thin.
- **Precompute a timeline during investigation and store it.** Adds a
  worker step and a table for what three indexed queries answer at request
  time. The stored copy would also go stale whenever a session is
  re-analyzed. Rejected.
- **Give agents dashboard credentials.** Hands a browser credential to
  every MCP caller and still requires parsing a UI. Rejected.

## The honest caveat

The timeline shows correlation, not causation. A 401 two seconds before
the error is a strong lead, not proof, and nothing in v1 links a specific
click to a specific request. The data that could do that lives in replay
chunks, deliberately out of scope. There are also no request or response
bodies: an agent chasing that 401 sees the URL, status, and timing, never
the server's error payload. If investigations repeatedly need bodies, the
answer is capture-side work, not more of this tool: scoped failed-request
body capture is filed as #434, and chunk parsing or server-side log
correlation are the other routes.
