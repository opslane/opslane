# Hide Archived Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archived incidents disappear from every incident list and account incident count unless the caller explicitly asks for `status=archived`.

**Architecture:** The exclusion lives in SQL inside `packages/ingestion/db/queries.go`, not in the Vue layer, because `ListErrorGroups` caps at `LIMIT 100` and archived rows currently evict live ones from the response. Two shared predicate constants are applied at five query sites: the three `ListErrorGroups` WHERE-clause builders and the two account aggregate queries. The dashboard adds no filtering logic — only an escape-hatch link in its empty states.

**Tech Stack:** Go 1.24 + pgx (ingestion), Vue 3 + Vitest + `@vue/test-utils` (dashboard), Postgres.

**Spec:** `docs/superpowers/specs/2026-08-05-hide-archived-issues-design.md`

## Global Constraints

- The rule, verbatim: **archived issues are excluded from every incident list unless the caller explicitly filters for `status=archived`.** An explicit status filter always wins.
- No `include_archived` / `exclude_status` compatibility parameter. `AGENTS.md` forbids legacy shims by default; this is an explicit contract change.
- `ListAccountIncidents` gains **no** `status` passthrough. There is no account-scoped archived view.
- Account `incident_count` means *visible* incidents. It equals the length of the list rendered beneath it **only below 100** — `ListErrorGroups` caps at `LIMIT 100` while the count is unbounded, so an account with 101 visible incidents shows "101 incidents" over a 100-row list. That residual mismatch is out of scope and deliberately left alone; it is a far milder symptom than the "3 incidents / No incidents for this account" contradiction this change fixes.
- Go DB tests `t.Skip` when Postgres is unreachable, and the suite still prints `ok`. Note `testPool` (`testhelper_test.go:17`) falls back to `defaultTestDSN` = `postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable` when `DATABASE_URL` is unset, so exporting that exact DSN changes nothing — a skip means Postgres is not reachable at all, not that the variable is missing. Confirm **zero skips** before believing a green run.
- Dashboard verification requires both `build` and `test` (`packages/dashboard/AGENTS.md:13`).
- Every query below aliases `error_groups` as `eg`.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `packages/ingestion/db/queries.go` | Modify | Owns both predicate constants and applies them at all four query sites |
| `packages/ingestion/db/archived_visibility_test.go` | Create | All Go coverage for this change — list visibility, per-arm eviction, account counts |
| `packages/dashboard/src/components/FilterBar.vue` | Modify | Exposes `showArchived()` so callers switch status without duplicating URL-sync logic |
| `packages/dashboard/src/views/IssuesList.vue` | Modify | Renders the escape-hatch link in both empty states |
| `packages/dashboard/src/views/__tests__/issues-list-filters.test.ts` | Modify | Extend the existing suite — do not create a second one |

A new Go test file rather than appending to `queries_test.go` (which the spec named): that file is over 1000 lines and covers unrelated concerns, and `environment_filters_test.go` is the established precedent for a focused per-concern test file. The new file shares package `db_test`, so it reuses `testPool`, `seedGroup`, `cleanupTenant`, and `insertFrictionGroupForEnvironment` with no imports beyond stdlib and pgxpool.

---

### Task 1: Exclude archived from incident lists

**Files:**
- Modify: `packages/ingestion/db/queries.go:770-771` (predicate constants), `:774`, `:806`, `:812` (three application sites)
- Test: `packages/ingestion/db/archived_visibility_test.go` (create)

**Interfaces:**
- Consumes: existing `db.Queries.ListErrorGroups(ctx, projectID string, filters *db.ErrorGroupFilters) ([]db.ErrorGroup, error)`; existing test helpers `testPool(t) *pgxpool.Pool`, `seedGroup(t, pool, q, name) (orgID, projectID, envID, groupID string)`, `cleanupTenant(t, pool, orgID)`, `insertFrictionGroupForEnvironment(t, pool, projectID, environmentID, fingerprint string, firstSeen, lastSeen time.Time, occurrences int) string`
- Produces: package-level constants `visibleCandidateSQL` and `notArchivedSQL` in package `db` (Task 2 reuses both); test helpers `containsGroup([]db.ErrorGroup, string) bool` and `insertArchivedFlood(t, pool, projectID, environmentID, kind, prefix string, count int, newerThan time.Time)` in package `db_test` (Task 2 reuses `containsGroup`)

**Background for the implementer:** `ListErrorGroups` builds one of two SQL shapes. When no environment filter is passed it is a single flat `SELECT ... WHERE ... LIMIT 100`. When an environment *is* passed it becomes a CTE with two `UNION ALL` arms — an error arm reading `error_group_environments` and a friction arm reading `error_groups` directly — **and each arm carries its own `LIMIT 100`**. That is why the predicate must be appended to the arms' WHERE builders rather than the outer select: an outer filter would let 100 archived rows fill an arm and starve the live rows before the outer query ever sees them.

- [ ] **Step 1: Write the failing tests**

Create `packages/ingestion/db/archived_visibility_test.go`:

```go
package db_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func containsGroup(groups []db.ErrorGroup, groupID string) bool {
	for _, g := range groups {
		if g.ID == groupID {
			return true
		}
	}
	return false
}

// insertArchivedFlood inserts count archived groups of the given kind into the
// given environment, each with last_seen newer than newerThan so they sort
// ahead of any live fixture. Error groups also get the per-environment rollup
// row that the environment-filtered error arm reads from; friction groups are
// matched on error_groups.environment_id directly and need no rollup.
func insertArchivedFlood(
	t *testing.T,
	pool *pgxpool.Pool,
	projectID, environmentID, kind, prefix string,
	count int,
	newerThan time.Time,
) {
	t.Helper()
	ctx := context.Background()
	for i := 0; i < count; i++ {
		seen := newerThan.Add(time.Duration(i+1) * time.Minute)
		fingerprint := fmt.Sprintf("%s-%d", prefix, i)
		var id string
		if err := pool.QueryRow(ctx, `
			INSERT INTO error_groups
			  (project_id, fingerprint, title, first_seen, last_seen, occurrence_count,
			   status, kind, environment_id)
			VALUES ($1, $2, $2, $3, $3, 1, 'archived', $4, $5)
			RETURNING id`,
			projectID, fingerprint, seen, kind, environmentID,
		).Scan(&id); err != nil {
			t.Fatalf("insert archived %s group: %v", kind, err)
		}
		if kind != "error" {
			continue
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO error_group_environments
			  (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
			VALUES ($1, $2, $3, $3, 1)`, id, environmentID, seen,
		); err != nil {
			t.Fatalf("insert archived rollup: %v", err)
		}
	}
}

func TestListErrorGroupsHidesArchivedUnlessRequested(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, _, groupID := seedGroup(t, pool, q, "archived-hidden")

	if err := q.ArchiveErrorGroup(ctx, projID, groupID); err != nil {
		t.Fatalf("ArchiveErrorGroup: %v", err)
	}

	unfiltered, err := q.ListErrorGroups(ctx, projID, nil)
	if err != nil {
		t.Fatalf("ListErrorGroups unfiltered: %v", err)
	}
	if containsGroup(unfiltered, groupID) {
		t.Errorf("archived group %s appeared in the unfiltered list", groupID)
	}

	requested, err := q.ListErrorGroups(ctx, projID, &db.ErrorGroupFilters{Status: "archived"})
	if err != nil {
		t.Fatalf("ListErrorGroups status=archived: %v", err)
	}
	if !containsGroup(requested, groupID) {
		t.Errorf("archived group %s missing from the status=archived list", groupID)
	}
}

func TestListErrorGroupsHidesArchivedInEnvironmentFilteredArms(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, envID, errorGroupID := seedGroup(t, pool, q, "archived-env-arms")

	base := time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC)
	frictionGroupID := insertFrictionGroupForEnvironment(
		t, pool, projID, envID, "friction-archived-env", base, base, 1,
	)

	for _, id := range []string{errorGroupID, frictionGroupID} {
		if err := q.ArchiveErrorGroup(ctx, projID, id); err != nil {
			t.Fatalf("ArchiveErrorGroup %s: %v", id, err)
		}
	}

	visible, err := q.ListErrorGroups(ctx, projID, &db.ErrorGroupFilters{EnvironmentID: &envID})
	if err != nil {
		t.Fatalf("ListErrorGroups environment-filtered: %v", err)
	}
	if containsGroup(visible, errorGroupID) {
		t.Error("archived error group appeared in the environment-filtered error arm")
	}
	if containsGroup(visible, frictionGroupID) {
		t.Error("archived friction group appeared in the environment-filtered friction arm")
	}

	requested, err := q.ListErrorGroups(ctx, projID, &db.ErrorGroupFilters{
		EnvironmentID: &envID,
		Status:        "archived",
	})
	if err != nil {
		t.Fatalf("ListErrorGroups environment-filtered status=archived: %v", err)
	}
	if !containsGroup(requested, errorGroupID) {
		t.Error("archived error group missing from the explicit environment-filtered archived list")
	}
	if !containsGroup(requested, frictionGroupID) {
		t.Error("archived friction group missing from the explicit environment-filtered archived list")
	}
}

// A flood of archived rows must not consume the LIMIT 100 that lives inside
// each CTE arm. This is the case that separates a correct per-arm predicate
// from an outer-select filter, which would pass every other test here.
func TestListErrorGroupsArchivedFloodDoesNotEvictLiveGroups(t *testing.T) {
	const floodSize = 101

	for _, tc := range []struct {
		name        string
		kind        string
		filterByEnv bool
	}{
		{name: "error arm environment filtered", kind: "error", filterByEnv: true},
		{name: "friction arm environment filtered", kind: "friction", filterByEnv: true},
		{name: "unfiltered branch error", kind: "error", filterByEnv: false},
		{name: "unfiltered branch friction", kind: "friction", filterByEnv: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := testPool(t)
			ctx := context.Background()
			q := db.New(pool)

			org, err := q.CreateOrg(ctx, "archived-flood-"+tc.name)
			if err != nil {
				t.Fatalf("CreateOrg: %v", err)
			}
			t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
			project, err := q.CreateProject(ctx, org.ID, "archived-flood", nil)
			if err != nil {
				t.Fatalf("CreateProject: %v", err)
			}
			environment, err := q.CreateEnvironment(ctx, project.ID, "production")
			if err != nil {
				t.Fatalf("CreateEnvironment: %v", err)
			}

			// The live group is deliberately the OLDEST row, so ordering by
			// last_seen DESC places it behind the entire flood.
			base := time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC)
			var liveGroupID string
			if tc.kind == "friction" {
				liveGroupID = insertFrictionGroupForEnvironment(
					t, pool, project.ID, environment.ID, "friction-live-under-flood", base, base, 1,
				)
			} else {
				result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
					ProjectID:     project.ID,
					EnvironmentID: environment.ID,
					ErrorType:     "TypeError",
					ErrorMessage:  "live under flood",
					StackTraceRaw: "at live.js:1:1",
					Fingerprint:   "fp-live-under-flood",
					Title:         "TypeError: live under flood",
					EventTime:     base,
				})
				if err != nil {
					t.Fatalf("InsertErrorEventAndGroup: %v", err)
				}
				liveGroupID = result.GroupID
			}

			insertArchivedFlood(
				t, pool, project.ID, environment.ID, tc.kind, "flood-"+tc.kind, floodSize, base,
			)

			var filters *db.ErrorGroupFilters
			if tc.filterByEnv {
				filters = &db.ErrorGroupFilters{EnvironmentID: &environment.ID}
			}
			groups, err := q.ListErrorGroups(ctx, project.ID, filters)
			if err != nil {
				t.Fatalf("ListErrorGroups: %v", err)
			}
			if !containsGroup(groups, liveGroupID) {
				t.Fatalf(
					"live group %s was evicted by %d archived rows (got %d groups)",
					liveGroupID, floodSize, len(groups),
				)
			}
		})
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
(cd packages/ingestion && go test ./db/ -run 'TestListErrorGroups(HidesArchived|ArchivedFlood)' -v)
```

Expected: all three FAIL. `HidesArchivedUnlessRequested` and `HidesArchivedInEnvironmentFilteredArms` report the archived group appearing where it should not; `ArchivedFloodDoesNotEvictLiveGroups` reports the live group evicted in all four subtests.

If instead they SKIP, Postgres is unreachable — start it (`docker compose up -d postgres`) and re-run. A skip is not a failing test, and no amount of `DATABASE_URL` juggling fixes it: `testPool` already defaults to the local dev DSN.

- [ ] **Step 3: Promote the predicates to package-level constants**

In `packages/ingestion/db/queries.go`, delete the local `visibleCandidate` declaration and its comment (currently lines 770-771, immediately above `var query string`) and add this block near the top of the file, next to the existing `requeueStatuses` var around line 325:

```go
const (
	// Ordinary candidates are hidden workflow records (issue #56); the only
	// visible candidate is an exhausted 'unchecked' adjudication diagnostic.
	visibleCandidateSQL = "(eg.status <> 'candidate' OR eg.adjudication_status = 'unchecked')"

	// Archived groups are permanently dismissed by the user (see
	// requeueStatuses); they are excluded from every incident list and every
	// account incident count unless explicitly requested by status.
	notArchivedSQL = "eg.status <> 'archived'"
)
```

Then replace the three remaining bare `visibleCandidate` references inside `ListErrorGroups` with `visibleCandidateSQL`.

- [ ] **Step 4: Apply the archived predicate at all three sites**

Still in `ListErrorGroups`, immediately after the `var query string` declaration, add:

```go
	// Applied only when the caller passed no status: an explicit status filter
	// already scopes the query, and appending this would break status=archived.
	hideArchived := statusArg == 0
```

In the `environmentArg == 0` branch, extend the initial `wheres` build:

```go
		wheres := []string{"eg.project_id = $1", visibleCandidateSQL}
		if hideArchived {
			wheres = append(wheres, notArchivedSQL)
		}
```

In the `else` branch, after `errorWheres` and `frictionWheres` are declared and before the `if statusArg != 0` block:

```go
		if hideArchived {
			errorWheres = append(errorWheres, notArchivedSQL)
			frictionWheres = append(frictionWheres, notArchivedSQL)
		}
```

Both arms already have `eg` in scope: the error arm joins `error_groups eg ON eg.id = ege.error_group_id`, the friction arm selects `FROM error_groups eg`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
(cd packages/ingestion && go test ./db/ -run 'TestListErrorGroups(HidesArchived|ArchivedFlood)' -v)
```

Expected: PASS, six test cases total (two top-level plus four subtests), zero skips.

- [ ] **Step 6: Run the full ingestion suite for regressions**

```bash
(cd packages/ingestion && go build ./... && go test ./...)
```

Expected: PASS with zero skips. Existing tests that assert an archived group is listed without a status filter would now legitimately fail — if any do, fix the *test* to pass `Status: "archived"`, since the new default is the intended behavior.

- [ ] **Step 7: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/db/archived_visibility_test.go
git commit -m "feat(ingestion): exclude archived groups from incident lists by default

Archived rows shared the LIMIT 100 with live ones and evicted them from
the response. The predicate goes inside each environment CTE arm, which
carries its own limit, not on the outer select."
```

---

### Task 2: Count only visible incidents in account aggregates

**Files:**
- Modify: `packages/ingestion/db/queries.go:974-982` (`ListAccounts`), `:1013-1021` (`GetAccountByID`)
- Test: `packages/ingestion/db/archived_visibility_test.go` (append)

**Interfaces:**
- Consumes: `visibleCandidateSQL` and `notArchivedSQL` from Task 1; `containsGroup` from Task 1; `db.Queries.ListAccounts(ctx, projectID string, query *string) ([]db.Account, error)`; `db.Queries.GetAccountByID(ctx, projectID, externalAccountID string) (*db.Account, error)`; `db.Account.IncidentCount`
- Produces: nothing consumed by later tasks

**Background for the implementer:** After Task 1, `ListAccountIncidents` no longer returns archived groups, but `Account.IncidentCount` still counts them — so `AccountDetail.vue` can render "3 incidents" directly above "No incidents for this account." The same divergence already exists for `candidate` groups, which `visibleCandidateSQL` hides from the list while the count includes them. Both queries share one join shape, so one fix closes both.

Two traps:
1. The predicates go in the **`ON` clause**. In `WHERE` they demote the `LEFT JOIN` to an inner join, and accounts with zero visible incidents drop out of the accounts list entirely.
2. Count `eg.id`, not `eau.error_group_id`. Filtered-out rows must contribute `NULL` so they fall out of `COUNT(DISTINCT ...)`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/ingestion/db/archived_visibility_test.go`:

```go
// linkAccountUser attaches a new end user carrying externalAccountID to the
// given group, which is how both account aggregates discover incidents.
func linkAccountUser(
	t *testing.T,
	pool *pgxpool.Pool,
	projectID, groupID, externalUserID, externalAccountID string,
) {
	t.Helper()
	ctx := context.Background()
	var userID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO end_users (project_id, external_user_id, external_account_id, account_name)
		VALUES ($1, $2, $3, $3)
		RETURNING id`,
		projectID, externalUserID, externalAccountID,
	).Scan(&userID); err != nil {
		t.Fatalf("insert end user: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO error_group_affected_users (error_group_id, end_user_id)
		VALUES ($1, $2)`, groupID, userID,
	); err != nil {
		t.Fatalf("link affected user: %v", err)
	}
}

func accountByID(accounts []db.Account, externalAccountID string) *db.Account {
	for i := range accounts {
		if accounts[i].ExternalAccountID == externalAccountID {
			return &accounts[i]
		}
	}
	return nil
}

func TestAccountIncidentCountExcludesArchivedAndMatchesTheList(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, _, groupID := seedGroup(t, pool, q, "account-archived-count")

	linkAccountUser(t, pool, projID, groupID, "user-archived", "acct-archived")
	if err := q.ArchiveErrorGroup(ctx, projID, groupID); err != nil {
		t.Fatalf("ArchiveErrorGroup: %v", err)
	}

	account, err := q.GetAccountByID(ctx, projID, "acct-archived")
	if err != nil {
		t.Fatalf("GetAccountByID: %v", err)
	}
	if account == nil {
		t.Fatal("GetAccountByID returned nil for an account whose only incident is archived")
	}
	if account.IncidentCount != 0 {
		t.Errorf("IncidentCount = %d, want 0 (archived incidents are not visible)", account.IncidentCount)
	}

	// The count must equal the list rendered beneath it in AccountDetail.vue.
	// This equality only holds below ListErrorGroups' LIMIT 100; the fixture is
	// deliberately one incident, so the cap is not in play here.
	incidents, err := q.ListErrorGroups(ctx, projID, &db.ErrorGroupFilters{AccountID: "acct-archived"})
	if err != nil {
		t.Fatalf("ListErrorGroups by account: %v", err)
	}
	if len(incidents) != account.IncidentCount {
		t.Errorf("list length %d does not match IncidentCount %d", len(incidents), account.IncidentCount)
	}

	// The LEFT JOIN must survive: an account with zero visible incidents is
	// still an account and must keep appearing in the accounts list.
	accounts, err := q.ListAccounts(ctx, projID, nil)
	if err != nil {
		t.Fatalf("ListAccounts: %v", err)
	}
	listed := accountByID(accounts, "acct-archived")
	if listed == nil {
		t.Fatal("account with only archived incidents vanished from ListAccounts")
	}
	if listed.IncidentCount != 0 {
		t.Errorf("ListAccounts IncidentCount = %d, want 0", listed.IncidentCount)
	}
}

func TestAccountIncidentCountExcludesOrdinaryCandidates(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, envID, _ := seedGroup(t, pool, q, "account-candidate-count")

	// adjudication_status stays NULL: its CHECK admits only 'unchecked', and an
	// 'unchecked' candidate is the one variety that is deliberately visible.
	var candidateID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO error_groups
		  (project_id, fingerprint, title, first_seen, last_seen, occurrence_count,
		   status, kind, environment_id)
		VALUES ($1, 'fp-ordinary-candidate', 'ordinary candidate', now(), now(), 1,
		        'candidate', 'friction', $2)
		RETURNING id`, projID, envID,
	).Scan(&candidateID); err != nil {
		t.Fatalf("insert candidate group: %v", err)
	}
	linkAccountUser(t, pool, projID, candidateID, "user-candidate", "acct-candidate")

	account, err := q.GetAccountByID(ctx, projID, "acct-candidate")
	if err != nil {
		t.Fatalf("GetAccountByID: %v", err)
	}
	if account == nil {
		t.Fatal("GetAccountByID returned nil for an account whose only incident is a candidate")
	}
	if account.IncidentCount != 0 {
		t.Errorf("GetAccountByID IncidentCount = %d, want 0 (ordinary candidates are hidden workflow records)", account.IncidentCount)
	}

	// Assert ListAccounts separately: the two queries are edited independently,
	// so covering only GetAccountByID would let a missing visibleCandidateSQL
	// in ListAccounts ship green.
	accounts, err := q.ListAccounts(ctx, projID, nil)
	if err != nil {
		t.Fatalf("ListAccounts: %v", err)
	}
	listed := accountByID(accounts, "acct-candidate")
	if listed == nil {
		t.Fatal("account with only a candidate incident vanished from ListAccounts")
	}
	if listed.IncidentCount != 0 {
		t.Errorf("ListAccounts IncidentCount = %d, want 0", listed.IncidentCount)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
(cd packages/ingestion && go test ./db/ -run 'TestAccountIncidentCount' -v)
```

Expected: both FAIL with `IncidentCount = 1, want 0`.

`db.Account.IncidentCount` is a plain `int` (`queries.go:939`), so `len(incidents)` compares directly with no conversion.

- [ ] **Step 3: Apply the predicates to both account queries**

In `ListAccounts` (`packages/ingestion/db/queries.go:974`), change the opening of `sql` from `COUNT(DISTINCT eau.error_group_id)` and add the group join:

```go
	sql := `SELECT eu.external_account_id,
	               MAX(eu.account_name) AS account_name,
	               COUNT(DISTINCT eu.id) AS user_count,
	               COUNT(DISTINCT eg.id) AS incident_count,
	               MAX(eu.last_seen) AS last_seen
	        FROM end_users eu
	        LEFT JOIN error_group_affected_users eau ON eau.end_user_id = eu.id
	        LEFT JOIN error_groups eg ON eg.id = eau.error_group_id
	             AND ` + notArchivedSQL + `
	             AND ` + visibleCandidateSQL + `
	        WHERE eu.project_id = $1 AND eu.external_account_id IS NOT NULL`
```

Apply the identical join and count change to `GetAccountByID` (`:1013`), keeping its own `WHERE eu.project_id = $1 AND eu.external_account_id = $2`.

Unlike `ListErrorGroups`, `notArchivedSQL` is applied unconditionally here — neither endpoint accepts a status filter.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
(cd packages/ingestion && go test ./db/ -run 'TestAccountIncidentCount' -v)
```

Expected: PASS, zero skips.

- [ ] **Step 5: Run the full ingestion suite**

```bash
(cd packages/ingestion && go build ./... && go test ./...)
```

Expected: PASS with zero skips.

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/db/archived_visibility_test.go
git commit -m "fix(ingestion): account incident counts count only visible incidents

Archived and ordinary-candidate groups inflated the account header count
above the list beneath it. Predicates go in the ON clause so accounts
with zero visible incidents survive the LEFT JOIN."
```

---

### Task 3: Archived escape-hatch link in the issues empty states

**Files:**
- Modify: `packages/dashboard/src/components/FilterBar.vue:88-95` (add `showArchived`, extend `defineExpose`)
- Modify: `packages/dashboard/src/views/IssuesList.vue:65` (add computed), `:213-234` (both empty states)
- Test: `packages/dashboard/src/views/__tests__/issues-list-filters.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `FilterBar` exposed instance methods via the existing `filterBar` template ref in `IssuesList.vue`; existing `currentFilters` ref and `hasActiveFilters` computed
- Produces: `FilterBar.showArchived(): void` on the exposed instance; `[data-testid="view-archived"]` on the link

**Background for the implementer:** `FilterBar` already watches `selectedStatus` and calls `onFilterChange` on every change, which syncs the URL query and re-emits filters. So `showArchived()` only needs to assign the ref — the watcher does the rest, and every other filter is left untouched, which is exactly the "preserve other filters, replace only status" requirement. Do not build a `router.push` in `IssuesList.vue`; that would duplicate the URL-sync logic and drift.

- [ ] **Step 1: Write the failing tests**

Append to `packages/dashboard/src/views/__tests__/issues-list-filters.test.ts`, after the existing `describe` block:

```ts
describe('IssuesList archived escape hatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAccounts.mockResolvedValue([]);
    mocks.listEnvironments.mockResolvedValue({ environments: [], rollup_ready: false });
    mocks.route.query = {};
    window.history.replaceState({}, '', '/');
  });

  it('offers the archived view from an empty filtered feed and keeps the other filters', async () => {
    mocks.route.query = { project_id: 'p1', platform: 'python' };
    window.history.replaceState({}, '', '/?project_id=p1&platform=python');
    mocks.listIncidents.mockResolvedValue([]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(mocks.listIncidents).toHaveBeenCalledWith('p1', { platform: 'python' });

    await wrapper.get('[data-testid="view-archived"]').trigger('click');
    await flushPromises();

    // Assert on the request, not the rendered text: the point of the link is
    // the filter it applies, and it must not discard the platform filter.
    expect(mocks.listIncidents).toHaveBeenLastCalledWith('p1', {
      platform: 'python',
      status: 'archived',
    });

    // The URL must follow too, or a reload drops the user back to the
    // default view with no way to tell what happened.
    expect(mocks.replace).toHaveBeenCalledWith({
      query: {
        project_id: 'p1',
        platform: 'python',
        status: 'archived',
      },
    });

    wrapper.unmount();
  });

  it('offers the archived view from a wholly empty feed', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.find('[data-testid="view-archived"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it('does not offer the archived view when already viewing archived', async () => {
    mocks.route.query = { project_id: 'p1', status: 'archived' };
    window.history.replaceState({}, '', '/?project_id=p1&status=archived');
    mocks.listIncidents.mockResolvedValue([]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(mocks.listIncidents).toHaveBeenCalledWith('p1', { status: 'archived' });
    expect(wrapper.find('[data-testid="view-archived"]').exists()).toBe(false);

    wrapper.unmount();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @opslane/dashboard test -- issues-list-filters
```

Expected: the first two FAIL on the missing `[data-testid="view-archived"]` element. The third may pass vacuously (nothing renders the element yet) — that is fine; it becomes meaningful after Step 3.

- [ ] **Step 3: Expose `showArchived` from FilterBar**

In `packages/dashboard/src/components/FilterBar.vue`, add after the `reset` function and update the expose:

```ts
function showArchived() {
  // The watcher on selectedStatus performs the URL sync and re-emit, so every
  // other active filter is preserved and only status changes.
  selectedStatus.value = 'archived';
}

defineExpose({ reset, showArchived });
```

- [ ] **Step 4: Render the link in both empty states**

In `packages/dashboard/src/views/IssuesList.vue`, add next to `hasActiveFilters` (line 65):

```ts
const viewingArchived = computed(() => currentFilters.value.status === 'archived');

function viewArchived() {
  filterBar.value?.showArchived();
}
```

Then add this block inside **both** `<EmptyState>` elements — the `v-if="hasActiveFilters"` one and the `v-else` one — as a sibling of the existing slot content:

```html
        <button
          v-if="!viewingArchived"
          type="button"
          data-testid="view-archived"
          class="mx-auto mt-3 block text-sm text-muted underline underline-offset-4 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click="viewArchived"
        >
          Archived issues are hidden — view archived
        </button>
```

`block mx-auto` is load-bearing, not decoration. `EmptyState.vue` wraps its
default slot in a single `text-center` div, and the existing primary action is
`inline-flex` — a second inline element would sit beside it on the same line.
`block` forces its own row and `mx-auto` re-centers it.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @opslane/dashboard test -- issues-list-filters
```

Expected: all three new tests PASS, and the pre-existing tests in the file still PASS.

- [ ] **Step 6: Run the dashboard gate**

```bash
pnpm --filter @opslane/dashboard build
pnpm --filter @opslane/dashboard test
```

Expected: both succeed. `build` runs `vue-tsc`, so a type error on the `showArchived` expose surfaces here rather than at runtime.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/src/components/FilterBar.vue \
        packages/dashboard/src/views/IssuesList.vue \
        packages/dashboard/src/views/__tests__/issues-list-filters.test.ts
git commit -m "feat(dashboard): offer the archived view from empty issue states

Archived issues no longer appear by default, so an empty feed links to
them. The link routes through FilterBar so the other active filters and
the URL sync are preserved, and it hides when already viewing archived."
```

---

## Final verification

Run the full repository gate before opening a PR. `DATABASE_URL` alone is not enough for a zero-skip run — the Go storage tests `t.Skip` without the MinIO variables, so export the whole block from `AGENTS.md` as a unit and start the services first:

```bash
# --wait blocks until both report healthy. Without it the first test can race
# container startup and t.Skip, which reads as a green run.
docker compose up -d --wait postgres minio

export INGESTION_PORT=8082
export OPSLANE_POSTGRES_HOST_PORT=5434
export OPSLANE_MINIO_HOST_PORT=9012
export INGESTION_URL="http://localhost:$INGESTION_PORT"
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:$OPSLANE_POSTGRES_HOST_PORT/opslane?sslmode=disable"
export MINIO_ENDPOINT="http://localhost:$OPSLANE_MINIO_HOST_PORT"
export REPLAY_STORE_ENDPOINT="$MINIO_ENDPOINT"
export REPLAY_STORE_PUBLIC_ENDPOINT="$MINIO_ENDPOINT"
export MINIO_ACCESS_KEY=minio MINIO_SECRET_KEY=minio12345 MINIO_BUCKET=opslane-replays
export REPLAY_STORE_ACCESS_KEY=minio REPLAY_STORE_SECRET_KEY=minio12345 REPLAY_STORE_BUCKET=opslane-replays

pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

If this runs from a worktree where another stack already holds the default ports, pick a free triple and re-export the whole block — the URLs do not follow the ports on their own.

Read the **skip count**, not the pass count. `go test ./...` printing `ok` while ~30 storage tests silently skipped is the documented failure mode of this gate.
