package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func insertFrictionGroupForEnvironment(
	t *testing.T,
	pool *pgxpool.Pool,
	projectID, environmentID, fingerprint string,
	firstSeen, lastSeen time.Time,
	occurrences int,
) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO error_groups
		  (project_id, fingerprint, title, first_seen, last_seen, occurrence_count,
		   status, kind, environment_id)
		VALUES ($1, $2, $2, $3, $4, $5, 'insight', 'friction', $6)
		RETURNING id`,
		projectID, fingerprint, firstSeen, lastSeen, occurrences, environmentID,
	).Scan(&id); err != nil {
		t.Fatalf("insert friction group: %v", err)
	}
	return id
}

func TestListErrorGroupsEnvironmentFilterIsKindGatedAndScoped(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "environment-filter-scoped")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "environment-filter-scoped", nil)
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	production, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment production: %v", err)
	}
	staging, err := q.CreateEnvironment(ctx, project.ID, "staging")
	if err != nil {
		t.Fatalf("CreateEnvironment staging: %v", err)
	}

	base := time.Date(2026, 7, 18, 8, 0, 0, 0, time.UTC)
	var sharedGroupID string
	for _, occurrence := range []struct {
		environmentID string
		at            time.Time
	}{
		{production.ID, base},
		{staging.ID, base.Add(4 * time.Hour)},
	} {
		result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
			ProjectID:            project.ID,
			DefaultEnvironmentID: occurrence.environmentID,
			ErrorType:            "TypeError",
			ErrorMessage:         "shared",
			StackTraceRaw:        "at shared.js:1:1",
			Fingerprint:          "fp-shared-environments",
			Title:                "TypeError: shared",
			EventTime:            occurrence.at,
		})
		if err != nil {
			t.Fatalf("insert shared occurrence: %v", err)
		}
		sharedGroupID = result.GroupID
	}
	if _, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            project.ID,
		DefaultEnvironmentID: staging.ID,
		ErrorType:            "TypeError",
		ErrorMessage:         "staging only",
		StackTraceRaw:        "at staging.js:1:1",
		Fingerprint:          "fp-staging-only",
		Title:                "TypeError: staging only",
		EventTime:            base.Add(6 * time.Hour),
	}); err != nil {
		t.Fatalf("insert staging-only error: %v", err)
	}
	productionFrictionID := insertFrictionGroupForEnvironment(
		t, pool, project.ID, production.ID, "friction-production",
		base.Add(time.Hour), base.Add(2*time.Hour), 7,
	)
	insertFrictionGroupForEnvironment(
		t, pool, project.ID, staging.ID, "friction-staging",
		base.Add(3*time.Hour), base.Add(5*time.Hour), 9,
	)

	filtered, err := q.ListErrorGroups(ctx, project.ID, &db.ErrorGroupFilters{EnvironmentID: &production.ID})
	if err != nil {
		t.Fatalf("ListErrorGroups filtered: %v", err)
	}
	if len(filtered) != 2 {
		t.Fatalf("filtered groups = %d, want production error + friction: %#v", len(filtered), filtered)
	}
	if filtered[0].ID != productionFrictionID || filtered[1].ID != sharedGroupID {
		t.Fatalf("filtered order = [%s, %s], want friction then error by environment recency", filtered[0].ID, filtered[1].ID)
	}
	if filtered[1].OccurrenceCount != 1 || !filtered[1].FirstSeen.Equal(base) || !filtered[1].LastSeen.Equal(base) {
		t.Fatalf("scoped error aggregates = count %d first %s last %s",
			filtered[1].OccurrenceCount, filtered[1].FirstSeen, filtered[1].LastSeen)
	}
	if filtered[0].OccurrenceCount != 7 || !filtered[0].LastSeen.Equal(base.Add(2*time.Hour)) {
		t.Fatalf("friction aggregates changed under filter: %+v", filtered[0])
	}

	unfiltered, err := q.ListErrorGroups(ctx, project.ID, nil)
	if err != nil {
		t.Fatalf("ListErrorGroups unfiltered: %v", err)
	}
	for _, group := range unfiltered {
		if group.ID == sharedGroupID {
			if group.OccurrenceCount != 2 || !group.LastSeen.Equal(base.Add(4*time.Hour)) {
				t.Fatalf("unfiltered global aggregates changed: %+v", group)
			}
			return
		}
	}
	t.Fatal("shared error group missing from unfiltered results")
}

func TestListErrorGroupsCorrelatesIdentityWithEnvironmentAtOccurrenceLevel(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "environment-filter-correlation")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "environment-filter-correlation", nil)
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM friction_signals WHERE project_id = $1`, project.ID); err != nil {
			t.Logf("cleanup friction signals: %v", err)
		}
		if _, err := pool.Exec(context.Background(), `DELETE FROM sessions WHERE project_id = $1`, project.ID); err != nil {
			t.Logf("cleanup sessions: %v", err)
		}
	})
	production, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment production: %v", err)
	}
	staging, err := q.CreateEnvironment(ctx, project.ID, "staging")
	if err != nil {
		t.Fatalf("CreateEnvironment staging: %v", err)
	}

	base := time.Date(2026, 7, 18, 8, 0, 0, 0, time.UTC)
	insert := func(fingerprint, environmentID, userID, accountID string, at time.Time) string {
		t.Helper()
		result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
			ProjectID:            project.ID,
			DefaultEnvironmentID: environmentID,
			ErrorType:            "TypeError",
			ErrorMessage:         fingerprint,
			StackTraceRaw:        "at app.js:1:1",
			Fingerprint:          fingerprint,
			Title:                fingerprint,
			EventTime:            at,
			EndUserID:            userID,
			EndUserAccountID:     accountID,
			EndUserAccountName:   accountID,
		})
		if err != nil {
			t.Fatalf("insert %s: %v", fingerprint, err)
		}
		return result.GroupID
	}

	// Account A is affected by this group only in staging. An unrelated
	// production occurrence must not make the group match account A × prod.
	falseMatchGroup := insert("fp-false-match", staging.ID, "user-a", "account-a", base)
	insert("fp-false-match", production.ID, "user-b", "account-b", base.Add(time.Hour))
	positiveEventGroup := insert("fp-positive-event", production.ID, "user-c", "account-a", base.Add(2*time.Hour))

	// Active folded friction is another occurrence source for error-kind groups.
	foldedGroup := insert("fp-positive-fold", staging.ID, "user-d", "account-b", base.Add(3*time.Hour))
	var accountAUserID string
	if err := pool.QueryRow(ctx,
		`SELECT id FROM end_users WHERE project_id = $1 AND external_user_id = 'user-a'`, project.ID,
	).Scan(&accountAUserID); err != nil {
		t.Fatalf("query account A user: %v", err)
	}
	if err := q.InsertSession(ctx, "session-correlation-fold", project.ID, production.ID, &accountAUserID, base, "/"); err != nil {
		t.Fatalf("InsertSession: %v", err)
	}
	foldedAt := base.Add(4 * time.Hour)
	if _, err := pool.Exec(ctx, `
		INSERT INTO friction_signals
		  (session_id, project_id, environment_id, end_user_id, rule_version,
		   signal_type, fingerprint, page_url_normalized, occurred_at,
		   occurrence_count, incident_id, adjudication_status)
		VALUES ($1, $2, $3, $4, 1, 'dead_click', 'fold-correlation', '/', $5, 2, $6, 'accepted')`,
		"session-correlation-fold", project.ID, production.ID, accountAUserID, foldedAt, foldedGroup,
	); err != nil {
		t.Fatalf("insert folded signal: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO error_group_environments
		  (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
		VALUES ($1, $2, $3, $3, 2)`, foldedGroup, production.ID, foldedAt,
	); err != nil {
		t.Fatalf("insert folded rollup: %v", err)
	}

	frictionGroup := insertFrictionGroupForEnvironment(
		t, pool, project.ID, production.ID, "friction-account-a", foldedAt, foldedAt, 2,
	)
	if _, err := pool.Exec(ctx, `
		INSERT INTO error_group_affected_users
		  (error_group_id, end_user_id, first_seen, last_seen, occurrence_count)
		VALUES ($1, $2, $3, $3, 2)`, frictionGroup, accountAUserID, foldedAt,
	); err != nil {
		t.Fatalf("link friction affected user: %v", err)
	}

	filtered, err := q.ListErrorGroups(ctx, project.ID, &db.ErrorGroupFilters{
		AccountID:     "account-a",
		EnvironmentID: &production.ID,
	})
	if err != nil {
		t.Fatalf("ListErrorGroups: %v", err)
	}
	got := make(map[string]bool, len(filtered))
	for _, group := range filtered {
		got[group.ID] = true
	}
	for _, want := range []string{positiveEventGroup, foldedGroup, frictionGroup} {
		if !got[want] {
			t.Errorf("expected correlated group %s, got %#v", want, got)
		}
	}
	if got[falseMatchGroup] {
		t.Fatalf("group %s falsely matched account-a in production", falseMatchGroup)
	}
}

func TestListGroupEnvironmentsUsesKindSpecificSources(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "group-environments")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "group-environments", nil)
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	production, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment production: %v", err)
	}
	staging, err := q.CreateEnvironment(ctx, project.ID, "staging")
	if err != nil {
		t.Fatalf("CreateEnvironment staging: %v", err)
	}

	base := time.Date(2026, 7, 18, 8, 0, 0, 0, time.UTC)
	var errorGroupID string
	for _, occurrence := range []struct {
		environmentID string
		at            time.Time
	}{
		{production.ID, base},
		{production.ID, base.Add(time.Hour)},
		{staging.ID, base.Add(2 * time.Hour)},
	} {
		result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
			ProjectID:            project.ID,
			DefaultEnvironmentID: occurrence.environmentID,
			ErrorType:            "TypeError",
			ErrorMessage:         "environment detail",
			StackTraceRaw:        "at app.js:1:1",
			Fingerprint:          "fp-environment-detail",
			Title:                "environment detail",
			EventTime:            occurrence.at,
		})
		if err != nil {
			t.Fatalf("InsertErrorEventAndGroup: %v", err)
		}
		errorGroupID = result.GroupID
	}
	frictionGroupID := insertFrictionGroupForEnvironment(
		t, pool, project.ID, staging.ID, "friction-environment-detail",
		base, base.Add(3*time.Hour), 5,
	)

	errorEnvironments, err := q.ListGroupEnvironments(ctx, project.ID, errorGroupID)
	if err != nil {
		t.Fatalf("ListGroupEnvironments error: %v", err)
	}
	if len(errorEnvironments) != 2 {
		t.Fatalf("error environments = %#v, want 2", errorEnvironments)
	}
	if errorEnvironments[0].ID != staging.ID || errorEnvironments[0].Name != "staging" || errorEnvironments[0].OccurrenceCount != 1 {
		t.Fatalf("newest error environment = %#v, want staging count 1", errorEnvironments[0])
	}
	if errorEnvironments[1].ID != production.ID || errorEnvironments[1].Name != "production" || errorEnvironments[1].OccurrenceCount != 2 {
		t.Fatalf("production error environment = %#v, want count 2", errorEnvironments[1])
	}

	frictionEnvironments, err := q.ListGroupEnvironments(ctx, project.ID, frictionGroupID)
	if err != nil {
		t.Fatalf("ListGroupEnvironments friction: %v", err)
	}
	if len(frictionEnvironments) != 1 || frictionEnvironments[0].ID != staging.ID ||
		frictionEnvironments[0].OccurrenceCount != 5 || !frictionEnvironments[0].LastSeen.Equal(base.Add(3*time.Hour)) {
		t.Fatalf("friction environments = %#v", frictionEnvironments)
	}

	otherOrg, err := q.CreateOrg(ctx, "group-environments-other")
	if err != nil {
		t.Fatalf("CreateOrg other: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, otherOrg.ID) })
	otherProject, err := q.CreateProject(ctx, otherOrg.ID, "other", nil)
	if err != nil {
		t.Fatalf("CreateProject other: %v", err)
	}
	crossTenant, err := q.ListGroupEnvironments(ctx, otherProject.ID, errorGroupID)
	if err != nil || len(crossTenant) != 0 {
		t.Fatalf("cross-tenant ListGroupEnvironments = (%#v, %v), want empty", crossTenant, err)
	}
}

func TestListEnvironmentsByObservedSurface(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	org, err := q.CreateOrg(ctx, "environment-observed-surfaces")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, org.ID)
		cleanupTenant(t, pool, org.ID)
	})
	project, err := q.CreateProject(ctx, org.ID, "observed", nil)
	if err != nil || project.DefaultEnvironmentID == nil {
		t.Fatalf("project = %#v, err=%v", project, err)
	}
	production, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatal(err)
	}
	staging, err := q.CreateEnvironment(ctx, project.ID, "staging")
	if err != nil {
		t.Fatal(err)
	}
	unused, err := q.CreateEnvironment(ctx, project.ID, "unused")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID: project.ID, DefaultEnvironmentID: production.ID,
		Fingerprint: "observed-error", ErrorType: "Error", ErrorMessage: "observed", Title: "observed",
	}); err != nil {
		t.Fatal(err)
	}
	insertFrictionGroupForEnvironment(t, pool, project.ID, staging.ID, "observed-friction", time.Now(), time.Now(), 1)
	observedSessionID := "observed-session-staging-" + uuid.NewString()
	deletingSessionID := "observed-session-deleting-" + uuid.NewString()
	if err := q.InsertSession(ctx, observedSessionID, project.ID, staging.ID, nil, time.Now(), ""); err != nil {
		t.Fatal(err)
	}
	if err := q.InsertSession(ctx, deletingSessionID, project.ID, unused.ID, nil, time.Now(), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE sessions SET status = 'deleting' WHERE id = $1`, deletingSessionID); err != nil {
		t.Fatal(err)
	}

	all, err := q.ListEnvironments(ctx, project.ID, "")
	if err != nil || len(all) != 3 {
		t.Fatalf("all = %#v, err=%v", all, err)
	}
	incidents, err := q.ListEnvironments(ctx, project.ID, "incidents")
	if err != nil || len(incidents) != 2 || incidents[0].ID != production.ID || incidents[1].ID != staging.ID {
		t.Fatalf("incidents = %#v, err=%v", incidents, err)
	}
	sessions, err := q.ListEnvironments(ctx, project.ID, "sessions")
	if err != nil || len(sessions) != 1 || sessions[0].ID != staging.ID {
		t.Fatalf("sessions = %#v, err=%v", sessions, err)
	}
	if _, err := q.ListEnvironments(ctx, project.ID, "unknown"); err == nil {
		t.Fatal("unknown usedBy succeeded")
	}
}
