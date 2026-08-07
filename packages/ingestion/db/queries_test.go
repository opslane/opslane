package db_test

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestInsertErrorEventStoresNetworkTimings(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "test-network-timings")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	proj, err := q.CreateProject(ctx, org.ID, "proj-network-timings", ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	env, err := q.CreateEnvironment(ctx, proj.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}

	timings := `[{"transport":"fetch","method":"POST","url":"https://api.test/search","started_at_ms":1,"duration_ms":10002,"outcome":"timeout"}]`
	result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            proj.ID,
		DefaultEnvironmentID: env.ID,
		ErrorType:            "TimeoutError",
		ErrorMessage:         "signal timed out",
		Fingerprint:          "fp-network-timings",
		Title:                "TimeoutError: signal timed out",
		NetworkTimings:       timings,
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup: %v", err)
	}

	var stored string
	if err := pool.QueryRow(ctx,
		`SELECT network_timings::text FROM error_events WHERE id = $1`, result.EventID,
	).Scan(&stored); err != nil {
		t.Fatalf("select: %v", err)
	}
	var decoded []map[string]any
	if err := json.Unmarshal([]byte(stored), &decoded); err != nil {
		t.Fatalf("unmarshal stored timings: %v", err)
	}
	if len(decoded) != 1 || decoded[0]["outcome"] != "timeout" {
		t.Fatalf("stored timings unexpected: %s", stored)
	}
}

// seedGroup creates an org/project/environment hierarchy plus one ingested
// error group and returns the pieces tests need.
func seedGroup(t *testing.T, pool *pgxpool.Pool, q *db.Queries, name string) (orgID, projectID, envID, groupID string) {
	t.Helper()
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, name)
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	proj, err := q.CreateProject(ctx, org.ID, name+"-proj", ptrStr("org/"+name))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	env, err := q.CreateEnvironment(ctx, proj.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}

	result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            proj.ID,
		DefaultEnvironmentID: env.ID,
		ErrorType:            "TypeError",
		ErrorMessage:         "boom",
		StackTraceRaw:        "at app.js:1:1",
		Fingerprint:          "fp-" + name,
		Title:                "TypeError: boom",
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup: %v", err)
	}
	return org.ID, proj.ID, env.ID, result.GroupID
}

// oauthContinuationQueries isolates continuation tests in a disposable
// database. These records contain sealed bearer credentials, so tests never
// apply the migration or insert fixtures into a retained development database.
func oauthContinuationQueries(t *testing.T) (*pgxpool.Pool, *db.Queries) {
	t.Helper()
	admin := testPool(t)
	pool, dsn := disposableDB(t, admin)
	if err := applyMigration(t, findPsql(t), dsn, "migrations/020_oauth_verification_continuations.sql"); err != nil {
		t.Fatalf("apply OAuth continuation migration: %v", err)
	}
	return pool, db.New(pool)
}

func testOAuthContinuation(kind string) db.OAuthVerificationContinuation {
	return db.OAuthVerificationContinuation{
		PendingTokenSealed: []byte("sealed-pending-token"),
		FlowKind:           kind,
	}
}

func TestOAuthVerificationContinuationReserveAndNullableBrowserSnapshot(t *testing.T) {
	_, q := oauthContinuationQueries(t)
	ctx := context.Background()
	continuation := testOAuthContinuation("browser")
	if err := q.StoreOAuthVerificationContinuation(ctx, "flow-browser", continuation, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("StoreOAuthVerificationContinuation: %v", err)
	}

	reserved, err := q.ReserveOAuthVerificationAttempt(ctx, "flow-browser")
	if err != nil {
		t.Fatalf("ReserveOAuthVerificationAttempt: %v", err)
	}
	if reserved == nil {
		t.Fatal("ReserveOAuthVerificationAttempt returned nil")
	}
	if reserved.Attempts != 1 || reserved.FlowKind != "browser" {
		t.Fatalf("reserved = %+v, want browser attempt 1", reserved)
	}
	if string(reserved.PendingTokenSealed) != string(continuation.PendingTokenSealed) {
		t.Fatalf("sealed token = %q, want %q", reserved.PendingTokenSealed, continuation.PendingTokenSealed)
	}
	if reserved.TargetOrgID != "" || reserved.CLIClientID != "" || reserved.CLIRedirectURI != "" ||
		reserved.CLIOAuthState != "" || reserved.CLICodeChallenge != "" || reserved.CLICodeChallengeMethod != "" {
		t.Fatalf("nullable browser snapshot did not scan as empty strings: %+v", reserved)
	}
}

func TestOAuthVerificationContinuationAttemptCap(t *testing.T) {
	_, q := oauthContinuationQueries(t)
	ctx := context.Background()
	if err := q.StoreOAuthVerificationContinuation(ctx, "flow-cap", testOAuthContinuation("browser"), time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("StoreOAuthVerificationContinuation: %v", err)
	}

	for want := 1; want <= db.MaxOAuthVerificationAttempts; want++ {
		reserved, err := q.ReserveOAuthVerificationAttempt(ctx, "flow-cap")
		if err != nil {
			t.Fatalf("reserve attempt %d: %v", want, err)
		}
		if reserved == nil || reserved.Attempts != want {
			t.Fatalf("reserve attempt %d = %+v", want, reserved)
		}
	}
	exhausted, err := q.ReserveOAuthVerificationAttempt(ctx, "flow-cap")
	if err != nil {
		t.Fatalf("reserve exhausted flow: %v", err)
	}
	if exhausted != nil {
		t.Fatalf("reserve beyond cap = %+v, want nil", exhausted)
	}
}

func TestOAuthVerificationContinuationConcurrentReservationsAreAtomic(t *testing.T) {
	_, q := oauthContinuationQueries(t)
	ctx := context.Background()
	if err := q.StoreOAuthVerificationContinuation(ctx, "flow-concurrent", testOAuthContinuation("browser"), time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("StoreOAuthVerificationContinuation: %v", err)
	}

	const callers = 12
	start := make(chan struct{})
	attempts := make(chan int, callers)
	errs := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			reserved, err := q.ReserveOAuthVerificationAttempt(ctx, "flow-concurrent")
			if err != nil {
				errs <- err
				return
			}
			if reserved != nil {
				attempts <- reserved.Attempts
			}
		}()
	}
	close(start)
	wg.Wait()
	close(attempts)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent reserve: %v", err)
		}
	}

	got := make([]int, 0, db.MaxOAuthVerificationAttempts)
	for attempt := range attempts {
		got = append(got, attempt)
	}
	sort.Ints(got)
	if len(got) != db.MaxOAuthVerificationAttempts {
		t.Fatalf("successful reservations = %v, want exactly %d", got, db.MaxOAuthVerificationAttempts)
	}
	for i, attempt := range got {
		if want := i + 1; attempt != want {
			t.Fatalf("attempt numbers = %v, want distinct sequence 1..%d", got, db.MaxOAuthVerificationAttempts)
		}
	}
}

func TestOAuthVerificationContinuationConsumeIsSingleUse(t *testing.T) {
	_, q := oauthContinuationQueries(t)
	ctx := context.Background()
	if err := q.StoreOAuthVerificationContinuation(ctx, "flow-consume", testOAuthContinuation("browser"), time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("StoreOAuthVerificationContinuation: %v", err)
	}

	consumed, err := q.ConsumeOAuthVerificationContinuation(ctx, "flow-consume")
	if err != nil || !consumed {
		t.Fatalf("first consume = (%v, %v), want (true, nil)", consumed, err)
	}
	consumed, err = q.ConsumeOAuthVerificationContinuation(ctx, "flow-consume")
	if err != nil || consumed {
		t.Fatalf("second consume = (%v, %v), want (false, nil)", consumed, err)
	}
	reserved, err := q.ReserveOAuthVerificationAttempt(ctx, "flow-consume")
	if err != nil || reserved != nil {
		t.Fatalf("reserve consumed flow = (%+v, %v), want (nil, nil)", reserved, err)
	}
}

func TestOAuthVerificationContinuationExpiredFlowCannotBeReserved(t *testing.T) {
	_, q := oauthContinuationQueries(t)
	ctx := context.Background()
	if err := q.StoreOAuthVerificationContinuation(ctx, "flow-expired", testOAuthContinuation("browser"), time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("StoreOAuthVerificationContinuation: %v", err)
	}
	reserved, err := q.ReserveOAuthVerificationAttempt(ctx, "flow-expired")
	if err != nil || reserved != nil {
		t.Fatalf("reserve expired flow = (%+v, %v), want (nil, nil)", reserved, err)
	}
}

func TestOAuthVerificationContinuationStoresCLISnapshot(t *testing.T) {
	_, q := oauthContinuationQueries(t)
	ctx := context.Background()
	want := db.OAuthVerificationContinuation{
		PendingTokenSealed:     []byte("sealed-cli-token"),
		FlowKind:               "cli",
		TargetOrgID:            "7d39cf66-bb9e-47ad-aa06-f8d15684f673",
		CLIClientID:            "opslane-cli",
		CLIRedirectURI:         "http://127.0.0.1:49152/callback",
		CLIOAuthState:          "cli-state",
		CLICodeChallenge:       "pkce-challenge",
		CLICodeChallengeMethod: "S256",
	}
	if err := q.StoreOAuthVerificationContinuation(ctx, "flow-cli", want, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("StoreOAuthVerificationContinuation: %v", err)
	}
	got, err := q.ReserveOAuthVerificationAttempt(ctx, "flow-cli")
	if err != nil || got == nil {
		t.Fatalf("ReserveOAuthVerificationAttempt = (%+v, %v)", got, err)
	}
	if string(got.PendingTokenSealed) != string(want.PendingTokenSealed) ||
		got.FlowKind != want.FlowKind || got.TargetOrgID != want.TargetOrgID ||
		got.CLIClientID != want.CLIClientID || got.CLIRedirectURI != want.CLIRedirectURI ||
		got.CLIOAuthState != want.CLIOAuthState || got.CLICodeChallenge != want.CLICodeChallenge ||
		got.CLICodeChallengeMethod != want.CLICodeChallengeMethod {
		t.Fatalf("reserved CLI snapshot = %+v, want %+v", got, want)
	}
}

func TestCleanupExpiredTokensRemovesAgedOAuthVerificationContinuations(t *testing.T) {
	admin := testPool(t)
	pool, dsn := disposableDB(t, admin)
	psql := findPsql(t)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply migration %s: %v", file, err)
		}
	}

	ctx := context.Background()
	q := db.New(pool)
	continuation := testOAuthContinuation("browser")
	if err := q.StoreOAuthVerificationContinuation(ctx, "flow-aged", continuation, time.Now().Add(-25*time.Hour)); err != nil {
		t.Fatalf("store aged continuation: %v", err)
	}
	if err := q.StoreOAuthVerificationContinuation(ctx, "flow-recent", continuation, time.Now().Add(-time.Hour)); err != nil {
		t.Fatalf("store recent continuation: %v", err)
	}

	if _, _, err := q.CleanupExpiredTokens(ctx); err != nil {
		t.Fatalf("CleanupExpiredTokens: %v", err)
	}
	var aged, recent int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FILTER (WHERE flow_hash = 'flow-aged'),
		        count(*) FILTER (WHERE flow_hash = 'flow-recent')
		 FROM oauth_verification_continuations`,
	).Scan(&aged, &recent); err != nil {
		t.Fatalf("count continuations after cleanup: %v", err)
	}
	if aged != 0 || recent != 1 {
		t.Fatalf("continuations after cleanup: aged=%d recent=%d, want 0 and 1", aged, recent)
	}
}

func TestRollupUpsertTracksErrorOccurrencesPerEnvironment(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "rollup-upsert")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "rollup-upsert", ptrStr("org/rollup-upsert"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	envA, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment production: %v", err)
	}
	envB, err := q.CreateEnvironment(ctx, project.ID, "staging")
	if err != nil {
		t.Fatalf("CreateEnvironment staging: %v", err)
	}

	late := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	early := late.Add(-2 * time.Hour)
	for i, event := range []struct {
		environmentID string
		at            time.Time
	}{
		{environmentID: envA.ID, at: late},
		{environmentID: envA.ID, at: early},
		{environmentID: envB.ID, at: late.Add(time.Hour)},
	} {
		if _, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
			ProjectID:            project.ID,
			DefaultEnvironmentID: event.environmentID,
			ErrorType:            "TypeError",
			ErrorMessage:         "rollup",
			StackTraceRaw:        "at app.js:1:1",
			Fingerprint:          "fp-rollup-upsert",
			Title:                "TypeError: rollup",
			EventTime:            event.at,
		}); err != nil {
			t.Fatalf("InsertErrorEventAndGroup %d: %v", i, err)
		}
	}

	type rollup struct {
		first time.Time
		last  time.Time
		count int64
	}
	got := map[string]rollup{}
	rows, err := pool.Query(ctx, `
		SELECT ege.environment_id, ege.first_seen, ege.last_seen, ege.occurrence_count
		FROM error_group_environments ege
		JOIN error_groups eg ON eg.id = ege.error_group_id
		WHERE eg.project_id = $1 AND eg.fingerprint = 'fp-rollup-upsert'`, project.ID)
	if err != nil {
		t.Fatalf("query rollup: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var envID string
		var value rollup
		if err := rows.Scan(&envID, &value.first, &value.last, &value.count); err != nil {
			t.Fatalf("scan rollup: %v", err)
		}
		got[envID] = value
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rollup rows: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("rollup rows = %d, want 2: %#v", len(got), got)
	}
	if row := got[envA.ID]; row.count != 2 || !row.first.Equal(early) || !row.last.Equal(late) {
		t.Fatalf("production rollup = %+v, want count=2 first=%s last=%s", row, early, late)
	}
	if row := got[envB.ID]; row.count != 1 || !row.first.Equal(late.Add(time.Hour)) || !row.last.Equal(late.Add(time.Hour)) {
		t.Fatalf("staging rollup = %+v, want one occurrence at %s", row, late.Add(time.Hour))
	}

	frictionGroupID := insertIncident(t, q, project.ID, "fp-rollup-friction", "friction", "insight")
	var frictionRows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM error_group_environments WHERE error_group_id = $1`, frictionGroupID,
	).Scan(&frictionRows); err != nil {
		t.Fatalf("count friction rollups: %v", err)
	}
	if frictionRows != 0 {
		t.Fatalf("friction rollup rows = %d, want 0", frictionRows)
	}
}

func TestRollupUpsertRejectsFrictionFingerprintCollision(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "rollup-kind-collision")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "rollup-kind-collision", nil)
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	environment, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}

	const fingerprint = "fp-error-friction-collision"
	frictionGroupID := insertIncident(t, q, project.ID, fingerprint, "friction", "insight")
	_, err = q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            project.ID,
		DefaultEnvironmentID: environment.ID,
		ErrorType:            "TypeError",
		ErrorMessage:         "kind collision",
		StackTraceRaw:        "at app.js:1:1",
		Fingerprint:          fingerprint,
		Title:                "TypeError: kind collision",
	})
	if err == nil {
		t.Fatal("InsertErrorEventAndGroup accepted a friction-kind fingerprint collision")
	}

	var eventCount, rollupCount, occurrences int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM error_events WHERE project_id = $1`, project.ID).Scan(&eventCount); err != nil {
		t.Fatalf("count error events: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM error_group_environments WHERE error_group_id = $1`, frictionGroupID).Scan(&rollupCount); err != nil {
		t.Fatalf("count friction rollups: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT occurrence_count FROM error_groups WHERE id = $1`, frictionGroupID).Scan(&occurrences); err != nil {
		t.Fatalf("query friction occurrences: %v", err)
	}
	if eventCount != 0 || rollupCount != 0 || occurrences != 1 {
		t.Fatalf("collision mutated state: events=%d rollups=%d occurrences=%d", eventCount, rollupCount, occurrences)
	}
}

func setGroupStatus(t *testing.T, pool *pgxpool.Pool, groupID, status string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_groups SET status = $2::error_group_status WHERE id = $1`, groupID, status); err != nil {
		t.Fatalf("set group status: %v", err)
	}
}

func groupStatus(t *testing.T, pool *pgxpool.Pool, groupID string) string {
	t.Helper()
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM error_groups WHERE id = $1`, groupID).Scan(&status); err != nil {
		t.Fatalf("query group status: %v", err)
	}
	return status
}

func TestUpdateErrorGroupStatus_NeedsHumanRequiresReasonFields(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, _, groupID := seedGroup(t, pool, q, "status-reason")

	// Missing reason fields must be rejected before touching the row.
	err := q.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
		ProjectID: projID,
		GroupID:   groupID,
		Status:    "needs_human",
	})
	if err == nil || !strings.Contains(err.Error(), "needs_human requires") {
		t.Fatalf("expected needs_human validation error, got %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "queued" {
		t.Fatalf("group status changed to %q despite validation error", got)
	}

	// Complete needs_human update succeeds.
	err = q.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
		ProjectID:     projID,
		GroupID:       groupID,
		Status:        "needs_human",
		ReasonCode:    ptrStr("low_confidence_fix"),
		ReasonMessage: ptrStr("The fix did not pass the confidence gate."),
		Remediation:   ptrStr("Review the investigation writeup."),
	})
	if err != nil {
		t.Fatalf("UpdateErrorGroupStatus: %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "needs_human" {
		t.Fatalf("group status = %q, want needs_human", got)
	}
}

func TestUpdateErrorGroupStatus_IsTenantScoped(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, _, groupID := seedGroup(t, pool, q, "status-tenant-a")
	_, otherProjID, _, _ := seedGroup(t, pool, q, "status-tenant-b")

	err := q.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
		ProjectID: otherProjID, // wrong tenant for groupID
		GroupID:   groupID,
		Status:    "pr_created",
		PrURL:     ptrStr("https://github.com/org/repo/pull/1"),
	})
	if err == nil || !strings.Contains(err.Error(), "no matching row") {
		t.Fatalf("expected cross-tenant update to fail, got %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "queued" {
		t.Fatalf("cross-tenant update mutated group: status = %q", got)
	}
}

func TestUpdateProjectPrPosture_DefaultValidationAndTenantScope(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	orgID, projectID, _, _ := seedGroup(t, pool, q, "pr-posture")
	otherOrgID, _, _, _ := seedGroup(t, pool, q, "pr-posture-other")

	project, err := q.GetProjectByOrgID(ctx, orgID, projectID)
	if err != nil || project == nil {
		t.Fatalf("GetProjectByOrgID = (%+v, %v)", project, err)
	}
	if project.PrPosture != "verified_only" {
		t.Fatalf("default PrPosture = %q, want verified_only", project.PrPosture)
	}

	draft := "draft_when_unverified"
	project, err = q.UpdateProject(ctx, orgID, projectID, nil, nil, &draft, nil)
	if err != nil || project == nil {
		t.Fatalf("UpdateProject posture = (%+v, %v)", project, err)
	}
	if project.PrPosture != draft {
		t.Fatalf("PrPosture = %q, want %q", project.PrPosture, draft)
	}

	project, err = q.UpdateProject(ctx, orgID, projectID, nil, nil, nil, nil)
	if err != nil || project == nil || project.PrPosture != draft {
		t.Fatalf("omitted posture was not preserved: project=%+v err=%v", project, err)
	}

	invalid := "publish_everything"
	if _, err := q.UpdateProject(ctx, orgID, projectID, nil, nil, &invalid, nil); err == nil {
		t.Fatal("expected invalid pr_posture to violate the database constraint")
	}
	if project, err := q.UpdateProject(ctx, otherOrgID, projectID, nil, nil, &draft, nil); err != nil || project != nil {
		t.Fatalf("cross-org UpdateProject = (%+v, %v), want nil, nil", project, err)
	}
}

func TestTriggerFixJob_OnlyFromInvestigated(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, _, groupID := seedGroup(t, pool, q, "trigger-fix")

	// Not yet investigated: refused.
	if _, err := q.TriggerFixJob(ctx, projID, groupID, ""); !errors.Is(err, db.ErrNotInvestigated) {
		t.Fatalf("expected ErrNotInvestigated for queued group, got %v", err)
	}

	setGroupStatus(t, pool, groupID, "investigated")

	jobID, err := q.TriggerFixJob(ctx, projID, groupID, "focus on the null check")
	if err != nil {
		t.Fatalf("TriggerFixJob: %v", err)
	}
	if jobID == "" {
		t.Fatal("expected non-empty job ID")
	}
	if got := groupStatus(t, pool, groupID); got != "fixing" {
		t.Fatalf("group status = %q, want fixing", got)
	}

	var jobType, jobStatus, guidance string
	if err := pool.QueryRow(ctx,
		`SELECT job_type, status, COALESCE(guidance, '') FROM error_group_jobs WHERE id = $1`, jobID,
	).Scan(&jobType, &jobStatus, &guidance); err != nil {
		t.Fatalf("query job: %v", err)
	}
	if jobType != "fix" || jobStatus != "pending" || guidance != "focus on the null check" {
		t.Fatalf("job = (%q, %q, %q), want (fix, pending, guidance)", jobType, jobStatus, guidance)
	}

	// Already fixing: a second trigger is refused (no double-queue).
	if _, err := q.TriggerFixJob(ctx, projID, groupID, ""); !errors.Is(err, db.ErrNotInvestigated) {
		t.Fatalf("expected ErrNotInvestigated on double trigger, got %v", err)
	}
}

func TestTriggerFixJob_IsTenantScoped(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, _, groupID := seedGroup(t, pool, q, "trigger-tenant-a")
	_, otherProjID, _, _ := seedGroup(t, pool, q, "trigger-tenant-b")

	setGroupStatus(t, pool, groupID, "investigated")

	if _, err := q.TriggerFixJob(ctx, otherProjID, groupID, ""); !errors.Is(err, db.ErrNotInvestigated) {
		t.Fatalf("expected cross-tenant trigger to be refused, got %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "investigated" {
		t.Fatalf("cross-tenant trigger mutated group: status = %q", got)
	}
}

func TestProcessPRWebhook_ReceiptBeforeTransition_Idempotent(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, _, groupID := seedGroup(t, pool, q, "pr-lifecycle")

	// Put the group into pr_created with a PR number.
	if err := q.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
		ProjectID: projID,
		GroupID:   groupID,
		Status:    "pr_created",
		PrURL:     ptrStr("https://github.com/org/pr-lifecycle/pull/7"),
	}); err != nil {
		t.Fatalf("UpdateErrorGroupStatus: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET pr_number = 7 WHERE id = $1`, groupID); err != nil {
		t.Fatalf("set pr_number: %v", err)
	}

	result, err := q.ProcessPRWebhook(ctx, "org/pr-lifecycle", 7, true, "delivery-merge", time.Now())
	if err != nil || result.GroupID != groupID || result.Duplicate {
		t.Fatalf("ProcessPRWebhook = (%+v, %v), want group %s, not duplicate", result, err, groupID)
	}
	if got := groupStatus(t, pool, groupID); got != "merged" {
		t.Fatalf("group status = %q, want merged", got)
	}

	var outcome string
	if err := pool.QueryRow(ctx,
		`SELECT outcome FROM pr_outcomes
		 WHERE error_group_id = $1 AND github_delivery_id = 'delivery-merge'`,
		groupID,
	).Scan(&outcome); err != nil || outcome != "merged" {
		t.Fatalf("receipt = (%q, %v), want merged", outcome, err)
	}

	result, err = q.ProcessPRWebhook(ctx, "org/pr-lifecycle", 7, true, "delivery-merge", time.Now())
	if err != nil || !result.Duplicate || result.GroupID != groupID {
		t.Fatalf("redelivery = (%+v, %v), want duplicate for group %s", result, err, groupID)
	}
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM pr_outcomes WHERE error_group_id = $1`, groupID,
	).Scan(&count); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	if count != 1 {
		t.Fatalf("receipts = %d, want 1", count)
	}
}

func TestProcessPRWebhook_DraftCloseRestoresNeedsHumanAndClosesDelivery(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projectID, _, groupID := seedGroup(t, pool, q, "draft-close")

	const (
		prNumber      = 81
		prURL         = "https://github.com/org/draft-close/pull/81"
		reasonCode    = "low_confidence_fix"
		reason        = "The candidate passed review but local verification was incomplete."
		remediation   = "Review the draft PR and its CI results before marking it ready."
		candidateDiff = "diff --git a/src/a.ts b/src/a.ts"
	)
	evidence := `{"version":1,"tier":"E0","checks":[]}`
	if _, err := pool.Exec(ctx,
		`UPDATE error_groups
		 SET status = 'pr_draft', pr_number = $2, pr_url = $3,
		     reason_code = $4, reason_message = $5, remediation = $6,
		     candidate_diff = $7, verification_evidence = $8::jsonb
		 WHERE id = $1`,
		groupID, prNumber, prURL, reasonCode, reason, remediation, candidateDiff, evidence,
	); err != nil {
		t.Fatalf("seed draft group: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO delivery_reservations
		   (error_group_id, project_id, operation_key, branch_name, posture,
		    diff_hash, candidate_diff, state, pr_url, pr_number)
		 VALUES ($1, $2, $3, $4, 'draft', 'hash', $5, 'open', $6, $7)`,
		groupID, projectID, "fix:"+groupID, "opslane/fix-draft", candidateDiff, prURL, prNumber,
	); err != nil {
		t.Fatalf("seed delivery reservation: %v", err)
	}
	var watchJobID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, payload)
		 VALUES ($1, $2, 'ci_watch', $3::jsonb) RETURNING id`,
		groupID, projectID, `{"pr_number":81,"head_sha":"abc123"}`,
	).Scan(&watchJobID); err != nil {
		t.Fatalf("seed CI watcher: %v", err)
	}

	result, err := q.ProcessPRWebhook(
		ctx, "org/draft-close", prNumber, false, "delivery-draft-close", time.Now(),
	)
	if err != nil || result.GroupID != groupID || result.Duplicate {
		t.Fatalf("ProcessPRWebhook = (%+v, %v), want group %s", result, err, groupID)
	}
	if result.CleanupBranch != "opslane/fix-draft" {
		t.Fatalf("cleanup branch = %q, want stable draft branch", result.CleanupBranch)
	}

	var (
		status, gotReasonCode, gotReason, gotRemediation string
		gotDiff, gotEvidence                             string
		gotPrURL                                         *string
		gotPrNumber                                      *int
		needsHumanAtSet                                  bool
	)
	if err := pool.QueryRow(ctx,
		`SELECT status, reason_code, reason_message, remediation,
		        candidate_diff, verification_evidence::text, pr_url, pr_number,
		        needs_human_at IS NOT NULL
		 FROM error_groups WHERE id = $1`,
		groupID,
	).Scan(&status, &gotReasonCode, &gotReason, &gotRemediation,
		&gotDiff, &gotEvidence, &gotPrURL, &gotPrNumber, &needsHumanAtSet); err != nil {
		t.Fatalf("query closed draft: %v", err)
	}
	if status != "needs_human" || gotReasonCode != reasonCode || gotReason != reason || gotRemediation != remediation {
		t.Fatalf("closed draft writeup = status %q reason (%q, %q, %q)", status, gotReasonCode, gotReason, gotRemediation)
	}
	if gotDiff != candidateDiff || !strings.Contains(gotEvidence, `"tier": "E0"`) {
		t.Fatalf("closed draft proof = diff %q evidence %q", gotDiff, gotEvidence)
	}
	if gotPrURL != nil || gotPrNumber != nil {
		t.Fatalf("closed draft retained delivery fields: url=%v number=%v", gotPrURL, gotPrNumber)
	}
	if !needsHumanAtSet {
		t.Fatal("closed draft did not stamp needs_human_at")
	}

	var watchStatus, reservationState string
	if err := pool.QueryRow(ctx, `SELECT status FROM error_group_jobs WHERE id = $1`, watchJobID).Scan(&watchStatus); err != nil {
		t.Fatalf("query watcher: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT state FROM delivery_reservations WHERE error_group_id = $1`, groupID).Scan(&reservationState); err != nil {
		t.Fatalf("query reservation: %v", err)
	}
	if watchStatus != "completed" || reservationState != "closed" {
		t.Fatalf("draft cleanup = watcher %q reservation %q, want completed/closed", watchStatus, reservationState)
	}

	redelivery, err := q.ProcessPRWebhook(
		ctx, "org/draft-close", prNumber, false, "delivery-draft-close", time.Now(),
	)
	if err != nil || !redelivery.Duplicate || redelivery.CleanupBranch != "opslane/fix-draft" {
		t.Fatalf("draft close redelivery = (%+v, %v), want duplicate cleanup retry", redelivery, err)
	}
}

func TestProcessPRWebhook_ConcurrentRedeliveryReportsDuplicate(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, _, groupID := seedGroup(t, pool, q, "pr-webhook-concurrent")
	if _, err := pool.Exec(ctx,
		`UPDATE error_groups
		 SET status = 'pr_created', pr_number = 71, pr_url = 'https://example.test/pull/71'
		 WHERE id = $1`,
		groupID,
	); err != nil {
		t.Fatalf("set PR fields: %v", err)
	}

	type callResult struct {
		result db.PRWebhookResult
		err    error
	}
	start := make(chan struct{})
	results := make(chan callResult, 2)
	for range 2 {
		go func() {
			<-start
			result, err := q.ProcessPRWebhook(
				ctx, "org/pr-webhook-concurrent", 71, true, "delivery-concurrent", time.Now(),
			)
			results <- callResult{result: result, err: err}
		}()
	}
	close(start)

	duplicates := 0
	processed := 0
	for range 2 {
		call := <-results
		if call.err != nil {
			t.Fatalf("ProcessPRWebhook: %v", call.err)
		}
		if call.result.GroupID != groupID {
			t.Fatalf("result group = %q, want %q", call.result.GroupID, groupID)
		}
		if call.result.Duplicate {
			duplicates++
		} else {
			processed++
		}
	}
	if processed != 1 || duplicates != 1 {
		t.Fatalf("processed=%d duplicates=%d, want one of each", processed, duplicates)
	}

	var receiptCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM pr_outcomes WHERE github_delivery_id = 'delivery-concurrent'`,
	).Scan(&receiptCount); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	if receiptCount != 1 {
		t.Fatalf("receipt count = %d, want 1", receiptCount)
	}
}

func TestProcessPRWebhook_FrictionCloseAttributesAndReturnsToAwaitingApproval(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "pr-webhook-friction-close")
	ctx := context.Background()
	groupID := insertIncident(t, q, projectID, "fp-webhook-friction-close", "friction", "pr_created")

	var fixJobID string
	if err := q.Pool().QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
		 VALUES ($1, $2, 'fix', 'human') RETURNING id`,
		groupID, projectID,
	).Scan(&fixJobID); err != nil {
		t.Fatalf("insert fix job: %v", err)
	}
	if _, err := q.Pool().Exec(ctx,
		`UPDATE error_groups
		 SET pr_number = 42, pr_url = 'https://github.com/org/repo/pull/42', pr_fix_job_id = $2
		 WHERE id = $1`,
		groupID, fixJobID,
	); err != nil {
		t.Fatalf("set PR fields: %v", err)
	}

	result, err := q.ProcessPRWebhook(ctx, "org/repo", 42, false, "delivery-friction-close", time.Now())
	if err != nil || result.GroupID != groupID || result.Duplicate {
		t.Fatalf("ProcessPRWebhook = (%+v, %v), want group %s", result, err, groupID)
	}
	if got := groupStatus(t, q.Pool(), groupID); got != "awaiting_approval" {
		t.Fatalf("group status = %q, want awaiting_approval", got)
	}

	var receiptJobID *string
	if err := q.Pool().QueryRow(ctx,
		`SELECT fix_job_id FROM pr_outcomes WHERE github_delivery_id = 'delivery-friction-close'`,
	).Scan(&receiptJobID); err != nil {
		t.Fatalf("query receipt: %v", err)
	}
	if receiptJobID == nil || *receiptJobID != fixJobID {
		t.Fatalf("receipt fix_job_id = %v, want %s", receiptJobID, fixJobID)
	}

	var prURL *string
	var prNumber *int
	var groupFixJobID *string
	if err := q.Pool().QueryRow(ctx,
		`SELECT pr_url, pr_number, pr_fix_job_id FROM error_groups WHERE id = $1`, groupID,
	).Scan(&prURL, &prNumber, &groupFixJobID); err != nil {
		t.Fatalf("query PR fields: %v", err)
	}
	if prURL != nil || prNumber != nil || groupFixJobID != nil {
		t.Fatalf("PR fields not cleared: url=%v number=%v fix_job_id=%v", prURL, prNumber, groupFixJobID)
	}
}

func TestProcessPRWebhook_ErrorCloseRevertsToInvestigated(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, _, groupID := seedGroup(t, pool, q, "pr-close")

	if err := q.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
		ProjectID: projID,
		GroupID:   groupID,
		Status:    "pr_created",
		PrURL:     ptrStr("https://github.com/org/pr-close/pull/3"),
	}); err != nil {
		t.Fatalf("UpdateErrorGroupStatus: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET pr_number = 3 WHERE id = $1`, groupID); err != nil {
		t.Fatalf("set pr_number: %v", err)
	}

	result, err := q.ProcessPRWebhook(ctx, "org/pr-close", 3, false, "delivery-error-close", time.Now())
	if err != nil || result.GroupID != groupID {
		t.Fatalf("ProcessPRWebhook = (%+v, %v), want group %s", result, err, groupID)
	}
	if got := groupStatus(t, pool, groupID); got != "investigated" {
		t.Fatalf("group status = %q, want investigated", got)
	}

	var prURL *string
	var prNumber *int
	if err := pool.QueryRow(ctx,
		`SELECT pr_url, pr_number FROM error_groups WHERE id = $1`, groupID).Scan(&prURL, &prNumber); err != nil {
		t.Fatalf("query pr fields: %v", err)
	}
	if prURL != nil || prNumber != nil {
		t.Fatalf("PR fields not cleared on close: pr_url=%v pr_number=%v", prURL, prNumber)
	}
}

func TestProcessPRWebhook_ReopenedMergeRecoversViaReceipt(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "pr-webhook-reopen-merge")
	ctx := context.Background()
	groupID := insertIncident(t, q, projectID, "fp-webhook-reopen", "friction", "pr_created")

	var fixJobID string
	if err := q.Pool().QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
		 VALUES ($1, $2, 'fix', 'human') RETURNING id`,
		groupID, projectID,
	).Scan(&fixJobID); err != nil {
		t.Fatalf("insert fix job: %v", err)
	}
	if _, err := q.Pool().Exec(ctx,
		`UPDATE error_groups
		 SET pr_number = 55, pr_url = 'https://github.com/org/repo/pull/55', pr_fix_job_id = $2
		 WHERE id = $1`,
		groupID, fixJobID,
	); err != nil {
		t.Fatalf("set PR fields: %v", err)
	}

	// Close unmerged: receipt written, PR fields cleared, group parked.
	if _, err := q.ProcessPRWebhook(ctx, "org/repo", 55, false, "delivery-reopen-close", time.Now()); err != nil {
		t.Fatalf("close delivery: %v", err)
	}
	if got := groupStatus(t, q.Pool(), groupID); got != "awaiting_approval" {
		t.Fatalf("group status after close = %q, want awaiting_approval", got)
	}

	// Reopen + merge: no pr_created match remains, but the close receipt still
	// links repo+pr_number to the group — the merge must be recovered.
	mergedAt := time.Now().Add(-2 * time.Minute).UTC().Truncate(time.Second)
	result, err := q.ProcessPRWebhook(ctx, "org/repo", 55, true, "delivery-reopen-merge", mergedAt)
	if err != nil || result.GroupID != groupID || result.Duplicate {
		t.Fatalf("recovered merge = (%+v, %v), want group %s", result, err, groupID)
	}
	if got := groupStatus(t, q.Pool(), groupID); got != "merged" {
		t.Fatalf("group status after recovered merge = %q, want merged", got)
	}

	// The recovered receipt keeps the fix-job attribution and the PR's actual
	// merge time (not webhook-processing time) lands in merged_at.
	var receiptJobID *string
	if err := q.Pool().QueryRow(ctx,
		`SELECT fix_job_id FROM pr_outcomes WHERE github_delivery_id = 'delivery-reopen-merge'`,
	).Scan(&receiptJobID); err != nil {
		t.Fatalf("query recovered receipt: %v", err)
	}
	if receiptJobID == nil || *receiptJobID != fixJobID {
		t.Fatalf("recovered receipt fix_job_id = %v, want %s", receiptJobID, fixJobID)
	}
	var mergedAtDB time.Time
	if err := q.Pool().QueryRow(ctx,
		`SELECT merged_at FROM error_groups WHERE id = $1`, groupID,
	).Scan(&mergedAtDB); err != nil {
		t.Fatalf("query merged_at: %v", err)
	}
	if !mergedAtDB.UTC().Truncate(time.Second).Equal(mergedAt) {
		t.Fatalf("merged_at = %v, want %v", mergedAtDB.UTC(), mergedAt)
	}

	// Redelivery of the recovered merge stays idempotent.
	result, err = q.ProcessPRWebhook(ctx, "org/repo", 55, true, "delivery-reopen-merge", time.Now())
	if err != nil || !result.Duplicate || result.GroupID != groupID {
		t.Fatalf("recovered-merge redelivery = (%+v, %v), want duplicate", result, err)
	}
	var receipts int
	if err := q.Pool().QueryRow(ctx,
		`SELECT count(*) FROM pr_outcomes WHERE error_group_id = $1`, groupID,
	).Scan(&receipts); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	if receipts != 2 {
		t.Fatalf("receipts = %d, want 2 (close + recovered merge)", receipts)
	}
}

func TestProcessPRWebhook_NoMatch(t *testing.T) {
	q, _ := createFrictionTestProject(t, "pr-webhook-no-match")
	result, err := q.ProcessPRWebhook(
		context.Background(), "org/repo", 999, true, "delivery-no-match", time.Now(),
	)
	if err != nil || result.GroupID != "" || result.Duplicate {
		t.Fatalf("no match = (%+v, %v), want empty result", result, err)
	}
}

func TestResolveArchiveUnarchiveLifecycle(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, _, groupID := seedGroup(t, pool, q, "lifecycle")

	if err := q.ResolveErrorGroup(ctx, projID, groupID); err != nil {
		t.Fatalf("ResolveErrorGroup: %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "resolved" {
		t.Fatalf("group status = %q, want resolved", got)
	}

	if err := q.ArchiveErrorGroup(ctx, projID, groupID); err != nil {
		t.Fatalf("ArchiveErrorGroup: %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "archived" {
		t.Fatalf("group status = %q, want archived", got)
	}

	// Archived groups cannot be resolved; they must be unarchived first.
	if err := q.ResolveErrorGroup(ctx, projID, groupID); err == nil {
		t.Fatal("expected ResolveErrorGroup on archived group to fail")
	}

	if err := q.UnarchiveErrorGroup(ctx, projID, groupID); err != nil {
		t.Fatalf("UnarchiveErrorGroup: %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "investigated" {
		t.Fatalf("group status = %q, want investigated", got)
	}

	// Unarchiving a non-archived group fails.
	if err := q.UnarchiveErrorGroup(ctx, projID, groupID); err == nil {
		t.Fatal("expected UnarchiveErrorGroup on non-archived group to fail")
	}
}

func TestLookupProjectKeyResolvesTenantAndHonorsRevocation(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	orgID, projID, _, _ := seedGroup(t, pool, q, "api-key")

	key, err := q.CreateProjectKey(ctx, projID, db.ScopeIngest, "test", nil, "")
	if err != nil {
		t.Fatalf("CreateProjectKey: %v", err)
	}
	if !strings.HasPrefix(key.Raw, "opslane_pk_") {
		t.Fatalf("raw key %q missing opslane_pk_ prefix", key.Raw)
	}

	lookup, err := q.LookupProjectKey(ctx, key.Raw)
	if err != nil {
		t.Fatalf("LookupProjectKey: %v", err)
	}
	if lookup.OrgID != orgID || lookup.ProjectID != projID || lookup.Scope != db.ScopeIngest {
		t.Fatalf("lookup = %+v, want org=%s project=%s scope=%s", lookup, orgID, projID, db.ScopeIngest)
	}

	// Unknown key is rejected.
	if _, err := q.LookupProjectKey(ctx, "def_not-a-real-key"); !errors.Is(err, db.ErrProjectKeyInvalid) {
		t.Fatal("expected unknown key lookup to fail")
	}

	// Revoked key is rejected.
	if _, err := pool.Exec(ctx,
		`UPDATE project_api_keys SET revoked_at = now() WHERE id = $1`, key.ID); err != nil {
		t.Fatalf("revoke key: %v", err)
	}
	if _, err := q.LookupProjectKey(ctx, key.Raw); !errors.Is(err, db.ErrProjectKeyInvalid) {
		t.Fatal("expected revoked key lookup to fail")
	}
}
