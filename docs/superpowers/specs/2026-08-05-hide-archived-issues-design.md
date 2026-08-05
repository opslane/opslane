# Hide archived issues from incident lists by default

## Problem

The dashboard issue list shows archived incidents mixed in with live ones. In
practice a burst of auto-archived friction incidents can dominate the entire
first page.

This is worse than visual noise. `ListErrorGroups` caps results at `LIMIT 100`,
so archived rows **evict live issues from the response**. A user with 100+
archived incidents can lose real work off the bottom of the list entirely. Any
fix that filters in the Vue component would leave that eviction in place.

The codebase already treats archived as terminal everywhere else.
`packages/ingestion/db/queries.go:326` excludes archived from `requeueStatuses`
with the comment that archived groups are "permanently dismissed by the user."
The list query is the one place that does not honor that.

## The rule

> Archived issues are excluded from every incident list unless the caller
> explicitly filters for `status=archived`.

An explicit status filter always wins over the default. There is no third state
and no separate include-archived flag to keep in sync with the status filter.

## Server

**File:** `packages/ingestion/db/queries.go`, `ListErrorGroups`

Add a predicate alongside the existing `visibleCandidate` one, applied **only
when no status filter was passed** (`statusArg == 0`):

```go
// Archived groups are permanently dismissed by the user (see requeueStatuses);
// they are excluded from every list unless explicitly requested by status.
notArchived := "eg.status <> 'archived'"
```

When `statusArg != 0` the existing `eg.status = $n` predicate already scopes the
query, and appending `notArchived` would break the archived view. So the append
is conditional.

The query has two shapes, and the predicate is needed in three places:

1. the no-environment branch's `wheres`
2. the environment branch's `errorWheres`
3. the environment branch's `frictionWheres`

It must go **inside** the environment branch's CTE arms, not on the outer
select. Each arm carries its own `LIMIT 100`, so filtering after the union would
still let archived rows evict live ones inside an arm.

`eg` is in scope in both arms: the error arm joins `error_groups eg ON eg.id =
ege.error_group_id`, and the friction arm selects `FROM error_groups eg`.

### Consumers

No handler changes. Both callers of `ListErrorGroups` inherit the new default:

- `packages/ingestion/handler/read_api.go:262` — project incidents list
- `packages/ingestion/handler/read_api.go:562` — account-scoped incidents list

`cli/src/errors.ts` needs no change; it passes `--status` straight through, so
`opslane errors --status archived` remains the way to see them.

### Contract note

This is a deliberate, explicit behavior change to
`GET /api/v1/projects/{id}/incidents`, not a shim. No `include_archived=true`
compatibility parameter is added, per the "do not add legacy shims by default"
guardrail in `AGENTS.md`. The endpoint is not a frozen contract — only
`POST /api/v1/events` is append-only.

## Dashboard

**File:** `packages/dashboard/src/views/IssuesList.vue`

No filtering logic in the component. It keeps rendering whatever the API
returns.

The only change is the empty state. Both existing variants — "No issues match
these filters" and "No issues yet" — get a quiet secondary link to the archived
view (`?status=archived`), so a user who archived everything is not told their
issues simply vanished.

The link deliberately carries **no count**. Rendering "3 archived issues hidden"
would require a count the API does not expose, and a new endpoint is not worth
it here. The copy is therefore unconditional: a brand-new project with no events
shows a link to an empty archived list. Accepted tradeoff.

`packages/dashboard/src/components/FilterBar.vue` is untouched. The existing
"Archived" option (line 158) already sends exactly the request that reveals
them.

## Out of scope

- `resolved` and `merged` still appear in the default list. Only `archived` is
  hidden.
- No change to sort order. `statusOrder` in `IssuesList.vue` keeps its
  `archived: 10` entry, which still applies inside the explicit archived view.
- No change to what causes an incident to be archived. The near-duplicate
  friction incidents that motivated this are a separate grouping concern.

## Verification

**Go — `packages/ingestion/db/queries_test.go`:**

- an archived group is absent from an unfiltered list
- the same group is present when `status=archived` is passed
- both hold in the environment-filtered query shape as well as the unfiltered
  one, for both `kind='error'` and `kind='friction'`
- eviction regression: with more than 100 archived rows and one live row, the
  live row is still returned

**Vitest — new file `packages/dashboard/src/views/IssuesList.test.ts`:**

`IssuesList.vue` has no test today. Add one colocated in `views/`, following
the existing `SessionsList.test.ts` / `Settings.test.ts` siblings.

- the empty state renders the archived link

**Gate:**

```bash
(cd packages/ingestion && go build ./... && go test ./...)
pnpm --filter @opslane/dashboard test
```

Go DB tests require `DATABASE_URL`; confirm the run reports **zero** skips
rather than trusting an `ok`.
