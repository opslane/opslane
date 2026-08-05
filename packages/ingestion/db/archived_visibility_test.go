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
