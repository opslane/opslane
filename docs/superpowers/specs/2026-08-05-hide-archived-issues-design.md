# Hide archived issues from incident lists by default

## Problem

The dashboard issue list shows archived incidents mixed in with live ones. In
practice a batch of archived friction incidents can dominate the entire first
page.

This is worse than visual noise. `ListErrorGroups` caps results at `LIMIT 100`,
so archived rows **evict live issues from the response**. A user with 100+
archived incidents can lose real work off the bottom of the list entirely. Any
fix that filters in the Vue component would leave that eviction in place.

The codebase already treats archived as terminal everywhere else.
`packages/ingestion/db/queries.go:326` excludes archived from `requeueStatuses`
with the comment that archived groups are "permanently dismissed by the user."
The incident lists are the one place that does not honor that.

Archival is always explicit: `ArchiveIncident`
(`packages/ingestion/handler/read_api.go:917`) is the only writer of
`status = 'archived'`. Nothing archives automatically.

## The rule

> Archived issues are excluded from every incident list unless the caller
> explicitly filters for `status=archived`.

An explicit status filter always wins over the default. There is no third state
and no separate include-archived flag to keep in sync with the status filter.

Account incident **counts** are brought in line with the same rule: a count
means *visible incidents*. It matches the list rendered beneath it up to
`ListErrorGroups`' `LIMIT 100`; past that the count keeps climbing while the
list stops at 100. That residual gap is left alone — "101 incidents" over 100
rows is a far milder lie than "3 incidents" over an empty list. See "Account
views" below.

## Shared visibility predicates

`ListErrorGroups` currently inlines its candidate predicate as a local
`visibleCandidate` string. Promote both predicates to package-level constants in
`packages/ingestion/db/queries.go` so the incident list and the account counts
cannot drift apart:

```go
const (
	// Ordinary candidates are hidden workflow records (issue #56); the only
	// visible candidate is an exhausted 'unchecked' adjudication diagnostic.
	visibleCandidateSQL = "(eg.status <> 'candidate' OR eg.adjudication_status = 'unchecked')"

	// Archived groups are permanently dismissed by the user (see
	// requeueStatuses); they are excluded from every list and count unless
	// explicitly requested by status.
	notArchivedSQL = "eg.status <> 'archived'"
)
```

Every query below aliases `error_groups` as `eg`, so the constants drop in
unchanged.

## Server: incident lists

**File:** `packages/ingestion/db/queries.go`, `ListErrorGroups`

Append `notArchivedSQL` **only when no status filter was passed**
(`statusArg == 0`). When `statusArg != 0` the existing `eg.status = $n`
predicate already scopes the query, and appending `notArchivedSQL` would break
the archived view.

The query has two shapes, and the predicate is needed in three places:

1. the no-environment branch's `wheres`
2. the environment branch's `errorWheres`
3. the environment branch's `frictionWheres`

It must go **inside** the environment branch's CTE arms, not on the outer
select. Each arm carries its own `LIMIT 100`, so filtering after the union would
still let archived rows evict live ones within an arm.

`eg` is in scope in both arms: the error arm joins `error_groups eg ON eg.id =
ege.error_group_id`, and the friction arm selects `FROM error_groups eg`.

### Consumers

No handler changes. Both callers of `ListErrorGroups` inherit the new default:

- `packages/ingestion/handler/read_api.go:262` — project incidents list
- `packages/ingestion/handler/read_api.go:562` — account-scoped incidents list

`cli/src/errors.ts` needs no change; it passes `--status` straight through, so
`opslane errors --status archived` remains the way to see them.

## Server: account views

`ListAccountIncidents` (`read_api.go:553`) hardcodes
`&db.ErrorGroupFilters{AccountID: accountID}` and never reads `status`, so the
account incident list has no archived escape hatch and gains none here. That is
intentional: the account view answers "what is this customer hitting," and an
archived incident has been dismissed.

That makes the header count wrong. `GetAccountByID` (`queries.go:1013`) and
`ListAccounts` (`queries.go:974`) both compute:

```sql
COUNT(DISTINCT eau.error_group_id) AS incident_count
FROM end_users eu
LEFT JOIN error_group_affected_users eau ON eau.end_user_id = eu.id
```

with no status predicate at all. Without a fix, an account whose incidents are
all archived renders "3 incidents" directly above "No incidents for this
account" (`packages/dashboard/src/views/AccountDetail.vue:69`).

Note this divergence **already exists** for `candidate` groups, which
`visibleCandidate` hides from the list while the count still includes them. The
fix closes both.

In both queries, add a join to `error_groups` carrying the visibility
predicates, and count the joined group rather than the join-table column:

```sql
COUNT(DISTINCT eg.id) AS incident_count
FROM end_users eu
LEFT JOIN error_group_affected_users eau ON eau.end_user_id = eu.id
LEFT JOIN error_groups eg ON eg.id = eau.error_group_id
     AND <notArchivedSQL>
     AND <visibleCandidateSQL>
```

Two constraints that are easy to get wrong:

- The predicates must live in the **`ON` clause**, not `WHERE`. In `WHERE` they
  demote the LEFT JOIN to an inner join, and accounts with zero visible
  incidents vanish from the accounts list entirely.
- Count `eg.id`, not `eau.error_group_id`. Filtered-out rows must contribute
  `NULL` so they fall out of the `COUNT(DISTINCT ...)`.

Unlike `ListErrorGroups`, the account counts apply `notArchivedSQL`
unconditionally — these endpoints take no status filter.

## Contract note

This is a deliberate, explicit behavior change to
`GET /api/v1/projects/{id}/incidents`, its account-scoped sibling, and the
account `incident_count` field. It is not a shim: no `include_archived=true`
compatibility parameter is added, per the "do not add legacy shims by default"
guardrail in `AGENTS.md`. The endpoints are not frozen contracts — only
`POST /api/v1/events` is append-only.

## Dashboard

**File:** `packages/dashboard/src/views/IssuesList.vue`

No filtering logic in the component. It keeps rendering whatever the API
returns.

The only change is the empty state: a quiet secondary link to the archived view,
with defined semantics.

**When it renders.** Only when the current status filter is not already
`archived`. `hasActiveFilters` is true when `status=archived` returns nothing,
so an unconditional link would point at the view the user is already on.

**Where it points.** It preserves every other active filter (environment,
platform, account) and replaces only `status` with `archived`. Jumping to a
bare `?status=archived` would silently discard the user's environment
selection.

The link deliberately carries **no count**. Rendering "3 archived issues hidden"
would require a count the API does not expose, and a new endpoint is not worth
it here. So the copy is unconditional in the other direction: a brand-new
project with no events shows a link to an empty archived list. Accepted
tradeoff.

`packages/dashboard/src/components/FilterBar.vue` gains one method,
`showArchived()`, added to its existing `defineExpose`. Its status dropdown and
options are unchanged — the existing "Archived" option (line 158) already sends
exactly the request that reveals them. The link routes through this method
rather than pushing a route itself, because `FilterBar` already owns the
watcher that syncs status to the URL and re-emits the filter set; duplicating
that in `IssuesList.vue` would drift.

## Out of scope

- `resolved` and `merged` still appear in the default list. Only `archived` is
  hidden.
- No change to sort order. `statusOrder` in `IssuesList.vue` keeps its
  `archived: 10` entry, which still applies inside the explicit archived view.
- No change to what causes an incident to be archived. The near-duplicate
  friction incidents that motivated this are a separate grouping concern.
- No account-scoped archived view. `ListAccountIncidents` gains no `status`
  passthrough; no UI asks for one.

## Verification

**Go — new file `packages/ingestion/db/archived_visibility_test.go`:**

A focused per-concern file in package `db_test`, following the
`environment_filters_test.go` precedent, rather than appending to the
1000-line `queries_test.go`. It reuses that package's existing helpers.

Incident lists:

- an archived group is absent from an unfiltered list
- the same group is present when `status=archived` is passed
- both hold in the environment-filtered query shape as well as the unfiltered
  one, for `kind='error'` and `kind='friction'`

Eviction regression, table-driven over the environment-filtered arms — this is
the case that distinguishes a correct per-arm filter from an outer-select
filter that would otherwise pass every other test:

| case | fixture |
| --- | --- |
| error arm, environment filtered | 101 archived `kind='error'` groups with `last_seen` newer than one older live error group, all in the selected environment |
| friction arm, environment filtered | same shape for `kind='friction'` |
| unfiltered branch, error | same shape for `kind='error'` with no environment filter |
| unfiltered branch, friction | same shape for `kind='friction'` with no environment filter |

In each case the older live group must still be returned.

Account counts:

- an account whose only incidents are archived reports `incident_count = 0` and
  still appears in `ListAccounts` (the LEFT JOIN regression)
- `GetAccountByID` count matches the length of `ListAccountIncidents` for the
  same account
- an ordinary `candidate` group is excluded from the count (the pre-existing
  divergence)

**Vitest — extend `packages/dashboard/src/views/__tests__/issues-list-filters.test.ts`:**

This suite already exists; add to it rather than creating a second one.

- the archived link is absent when the active status filter is `archived`
- activating the link issues a request with `status: 'archived'` and retains the
  other active filters — assert on the request, not merely that the text
  rendered

**Gate:**

```bash
(cd packages/ingestion && go build ./... && go test ./...)
pnpm --filter @opslane/dashboard build
pnpm --filter @opslane/dashboard test
```

Both dashboard commands are required by `packages/dashboard/AGENTS.md:13`.

Go DB tests do **not** require `DATABASE_URL` — `testPool`
(`testhelper_test.go:17`) falls back to the local dev DSN — so a skip means
Postgres is unreachable, not that a variable is missing. The storage tests are
the ones that need environment: they `t.Skip` without the MinIO block. Start
the services and export that block as a unit, then confirm the run reports
**zero** skips rather than trusting an `ok`.
