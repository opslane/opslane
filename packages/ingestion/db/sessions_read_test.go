package db_test

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func insertReadSession(t *testing.T, q *db.Queries, pool *pgxpool.Pool, projectID, envID string, endUserID *string, id string, startedAt time.Time) {
	t.Helper()
	if err := q.InsertSession(context.Background(), id, projectID, envID, endUserID, startedAt, "https://app.example.test/page"); err != nil {
		t.Fatalf("insert session %s: %v", id, err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE sessions SET started_at=$2, last_chunk_at=$2::timestamptz + interval '5 minutes' WHERE id=$1`, id, startedAt); err != nil {
		t.Fatalf("set session times: %v", err)
	}
}

func addReadChunk(t *testing.T, q *db.Queries, sessionID, projectID string, seq int, scrubbed bool) {
	t.Helper()
	ctx := context.Background()
	key := fmt.Sprintf("sessions/%s/%s/chunk-%06d.json.gz", projectID, sessionID, seq)
	if err := q.ReserveChunkSeq(ctx, sessionID, projectID, seq, key, true); err != nil {
		t.Fatalf("reserve chunk: %v", err)
	}
	if err := q.CommitChunk(ctx, sessionID, projectID, seq, int64(100+seq)); err != nil {
		t.Fatalf("commit chunk: %v", err)
	}
	if scrubbed {
		first, last := int64(1000+seq*100), int64(1050+seq*100)
		if err := q.MarkChunkScrubbed(ctx, sessionID, projectID, seq, &first, &last, int64(1000+seq)); err != nil {
			t.Fatalf("mark chunk scrubbed: %v", err)
		}
	}
}

func addReadSignal(t *testing.T, pool *pgxpool.Pool, sessionID, projectID, envID, signalType, fingerprint, status string, ruleVersion, occurrenceCount int) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO friction_signals (
			session_id, project_id, environment_id, rule_version, signal_type,
			fingerprint, page_url_normalized, occurred_at, occurrence_count,
			adjudication_status
		) VALUES ($1, $2, $3, $4, $5, $6, '/checkout', now(), $7, $8)
		RETURNING id`,
		sessionID, projectID, envID, ruleVersion, signalType, fingerprint,
		occurrenceCount, status,
	).Scan(&id); err != nil {
		t.Fatalf("insert %s signal: %v", signalType, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM friction_signals WHERE id = $1`, id)
	})
	return id
}

func addReadError(t *testing.T, pool *pgxpool.Pool, sessionID, projectID, envID string) {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO error_events (
			project_id, environment_id, timestamp, error_type, error_message,
			stack_trace_raw, session_id
		) VALUES ($1, $2, now(), 'TypeError', 'boom', 'at test', $3)
		RETURNING id`,
		projectID, envID, sessionID,
	).Scan(&id); err != nil {
		t.Fatalf("insert error event: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM error_events WHERE id = $1`, id)
	})
}

func TestListSessions_FiltersPaginationAndTenantScope(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	otherProjectID, otherEnvID := seedSessionProject(t, pool)

	endUserID, err := q.UpsertEndUser(ctx, projectID, "user-acme", "acme", "user@acme.test", "Acme")
	if err != nil {
		t.Fatalf("upsert end user: %v", err)
	}
	otherEndUserID, err := q.UpsertEndUser(ctx, projectID, "user-other", "other", "other@test", "Other")
	if err != nil {
		t.Fatalf("upsert second end user: %v", err)
	}

	base := time.Now().UTC().Truncate(time.Microsecond).Add(-time.Hour)
	ids := []string{"sess_read_0001", "sess_read_0002", "sess_read_0003"}
	insertReadSession(t, q, pool, projectID, envID, &endUserID, ids[0], base.Add(time.Minute))
	insertReadSession(t, q, pool, projectID, envID, &endUserID, ids[1], base.Add(2*time.Minute))
	insertReadSession(t, q, pool, projectID, envID, &otherEndUserID, ids[2], base.Add(3*time.Minute))
	deletingID := "sess_read_deleting"
	insertReadSession(t, q, pool, projectID, envID, nil, deletingID, base.Add(4*time.Minute))
	if _, err := pool.Exec(ctx, `UPDATE sessions SET status='deleting' WHERE id=$1`, deletingID); err != nil {
		t.Fatalf("mark fixture deleting: %v", err)
	}
	insertReadSession(t, q, pool, otherProjectID, otherEnvID, nil, "sess_read_other_project", base.Add(5*time.Minute))

	addReadChunk(t, q, ids[0], projectID, 0, true)
	addReadChunk(t, q, ids[0], projectID, 1, false)

	got, next, err := q.ListSessions(ctx, projectID, db.SessionFilters{}, nil, 50)
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	if next != nil || len(got) != 3 {
		t.Fatalf("default list len/cursor = %d/%v, want 3/nil", len(got), next)
	}
	if got[0].ID != ids[2] || got[1].ID != ids[1] || got[2].ID != ids[0] {
		t.Fatalf("default order = %v", []string{got[0].ID, got[1].ID, got[2].ID})
	}
	if got[2].ChunkCount != 2 || got[2].PlayableChunkCount != 1 {
		t.Fatalf("chunk counts = %d/%d, want 2/1", got[2].ChunkCount, got[2].PlayableChunkCount)
	}

	byUser, _, err := q.ListSessions(ctx, projectID, db.SessionFilters{EndUserID: endUserID}, nil, 50)
	if err != nil || len(byUser) != 2 {
		t.Fatalf("end-user filter len=%d err=%v", len(byUser), err)
	}
	byAccount, exactLimitCursor, err := q.ListSessions(ctx, projectID, db.SessionFilters{AccountID: "acme"}, nil, 2)
	if err != nil || len(byAccount) != 2 || exactLimitCursor != nil {
		t.Fatalf("exact-limit account page len=%d cursor=%v err=%v, want 2/nil/nil", len(byAccount), exactLimitCursor, err)
	}
	from, to := base.Add(90*time.Second), base.Add(150*time.Second)
	byTime, _, err := q.ListSessions(ctx, projectID, db.SessionFilters{From: &from, To: &to}, nil, 50)
	if err != nil || len(byTime) != 1 || byTime[0].ID != ids[1] {
		t.Fatalf("time filter = %+v err=%v", byTime, err)
	}

	firstPage, cursor, err := q.ListSessions(ctx, projectID, db.SessionFilters{}, nil, 2)
	if err != nil || len(firstPage) != 2 || cursor == nil {
		t.Fatalf("first page len/cursor/err = %d/%v/%v", len(firstPage), cursor, err)
	}
	lastPage, cursor2, err := q.ListSessions(ctx, projectID, db.SessionFilters{}, cursor, 2)
	if err != nil || len(lastPage) != 1 || cursor2 != nil || lastPage[0].ID != ids[0] {
		t.Fatalf("last page = %+v cursor=%v err=%v", lastPage, cursor2, err)
	}
	otherRows, _, err := q.ListSessions(ctx, otherProjectID, db.SessionFilters{}, nil, 50)
	if err != nil || len(otherRows) != 1 || otherRows[0].ID != "sess_read_other_project" {
		t.Fatalf("other project rows = %+v err=%v", otherRows, err)
	}
}

func TestListSessions_CountsAcceptedActiveSignalsAndSearchesIdentity(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	otherProjectID, otherEnvID := seedSessionProject(t, pool)

	userID, err := q.UpsertEndUser(ctx, projectID, "Customer-123", "acct-789", "Jane@Acme.test", "Acme Corporation")
	if err != nil {
		t.Fatalf("upsert end user: %v", err)
	}
	base := time.Now().UTC().Truncate(time.Microsecond).Add(-time.Hour)
	signalSessionID := "sess_signal_search_exact"
	cleanSessionID := "sess_clean_search_exact"
	pendingSessionID := "sess_pending_only"
	insertReadSession(t, q, pool, projectID, envID, &userID, signalSessionID, base.Add(2*time.Minute))
	insertReadSession(t, q, pool, projectID, envID, nil, cleanSessionID, base.Add(time.Minute))
	insertReadSession(t, q, pool, projectID, envID, nil, pendingSessionID, base)
	if _, err := pool.Exec(ctx, `UPDATE sessions SET sdk_release = '@opslane/sdk@1.4.2' WHERE id = $1`, signalSessionID); err != nil {
		t.Fatalf("set sdk release: %v", err)
	}

	newRageID := addReadSignal(t, pool, signalSessionID, projectID, envID, "rage_click", "rage-versioned", "accepted", 2, 3)
	oldRageID := addReadSignal(t, pool, signalSessionID, projectID, envID, "rage_click", "rage-versioned", "accepted", 1, 9)
	if _, err := pool.Exec(ctx, `UPDATE friction_signals SET superseded_by = $2 WHERE id = $1`, oldRageID, newRageID); err != nil {
		t.Fatalf("supersede old signal: %v", err)
	}
	retractedID := addReadSignal(t, pool, signalSessionID, projectID, envID, "rage_click", "rage-retracted", "accepted", 1, 8)
	if _, err := pool.Exec(ctx, `UPDATE friction_signals SET retracted_at = now() WHERE id = $1`, retractedID); err != nil {
		t.Fatalf("retract signal: %v", err)
	}
	addReadSignal(t, pool, signalSessionID, projectID, envID, "dead_click", "dead-accepted", "accepted", 1, 2)
	addReadSignal(t, pool, signalSessionID, projectID, envID, "dead_click", "dead-pending", "pending", 1, 7)
	addReadSignal(t, pool, signalSessionID, projectID, envID, "form_abandon", "abandon-accepted", "accepted", 1, 5)
	addReadSignal(t, pool, signalSessionID, projectID, envID, "form_abandon", "abandon-rejected", "rejected", 1, 6)
	addReadSignal(t, pool, pendingSessionID, projectID, envID, "rage_click", "pending-only", "pending", 1, 12)
	addReadError(t, pool, signalSessionID, projectID, envID)
	addReadError(t, pool, signalSessionID, projectID, envID)

	// Deliberately inconsistent tenant columns prove that each LATERAL enforces
	// project scope instead of relying on the outer sessions predicate.
	addReadSignal(t, pool, signalSessionID, otherProjectID, otherEnvID, "form_abandon", "cross-project", "accepted", 1, 11)
	addReadError(t, pool, signalSessionID, otherProjectID, otherEnvID)

	all, _, err := q.ListSessions(ctx, projectID, db.SessionFilters{}, nil, 50)
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("sessions len = %d, want 3", len(all))
	}
	got := all[0]
	if got.ID != signalSessionID {
		t.Fatalf("first session = %q, want %q", got.ID, signalSessionID)
	}
	if got.SDKRelease == nil || *got.SDKRelease != "@opslane/sdk@1.4.2" {
		t.Fatalf("sdk release = %v", got.SDKRelease)
	}
	if got.ErrorCount != 2 || got.RageClickCount != 3 || got.DeadClickCount != 2 || got.FormAbandonCount != 5 {
		t.Fatalf("signal counts = errors:%d rage:%d dead:%d abandon:%d, want 2/3/2/5",
			got.ErrorCount, got.RageClickCount, got.DeadClickCount, got.FormAbandonCount)
	}
	if pendingOnly := all[2]; pendingOnly.ID != pendingSessionID || pendingOnly.RageClickCount != 0 {
		t.Fatalf("pending-only counts = %+v, want zero visible signals", pendingOnly)
	}

	detail, err := q.GetSessionSummary(ctx, projectID, signalSessionID)
	if err != nil || detail == nil || detail.RageClickCount != 3 || detail.ErrorCount != 2 {
		t.Fatalf("detail counts = %+v err=%v", detail, err)
	}

	searches := []string{"jane@acme", "CUSTOMER-123", "acme corporation", "ACCT-789", signalSessionID}
	for _, search := range searches {
		found, _, searchErr := q.ListSessions(ctx, projectID, db.SessionFilters{Search: search}, nil, 50)
		if searchErr != nil || len(found) != 1 || found[0].ID != signalSessionID {
			t.Errorf("search %q = %+v err=%v", search, found, searchErr)
		}
	}
	partialID, _, err := q.ListSessions(ctx, projectID, db.SessionFilters{Search: "sess_signal_search"}, nil, 50)
	if err != nil || len(partialID) != 0 {
		t.Fatalf("partial session id search = %+v err=%v, want no exact-id match", partialID, err)
	}

	withSignals, _, err := q.ListSessions(ctx, projectID, db.SessionFilters{HasSignals: true}, nil, 50)
	if err != nil || len(withSignals) != 1 || withSignals[0].ID != signalSessionID {
		t.Fatalf("with-signals filter = %+v err=%v", withSignals, err)
	}
}

func TestHasIdentifiedSessions_IsProjectScopedAndIgnoresDeleting(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	otherProjectID, otherEnvID := seedSessionProject(t, pool)
	userID, err := q.UpsertEndUser(ctx, projectID, "identified", "", "", "")
	if err != nil {
		t.Fatalf("upsert end user: %v", err)
	}
	insertReadSession(t, q, pool, projectID, envID, &userID, "sess_identified", time.Now())
	insertReadSession(t, q, pool, otherProjectID, otherEnvID, nil, "sess_other_anonymous", time.Now())

	hasIdentified, err := q.HasIdentifiedSessions(ctx, projectID)
	if err != nil || !hasIdentified {
		t.Fatalf("identified project = %v err=%v, want true", hasIdentified, err)
	}
	otherHasIdentified, err := q.HasIdentifiedSessions(ctx, otherProjectID)
	if err != nil || otherHasIdentified {
		t.Fatalf("anonymous project = %v err=%v, want false", otherHasIdentified, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE sessions SET status = 'deleting' WHERE id = 'sess_identified'`); err != nil {
		t.Fatalf("mark identified session deleting: %v", err)
	}
	hasIdentified, err = q.HasIdentifiedSessions(ctx, projectID)
	if err != nil || hasIdentified {
		t.Fatalf("deleting-only project = %v err=%v, want false", hasIdentified, err)
	}
}

func TestListSessions_EnvironmentFilterPreservesKeysetPagination(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, productionID := seedSessionProject(t, pool)
	staging, err := q.CreateEnvironment(ctx, projectID, "staging")
	if err != nil {
		t.Fatalf("create staging environment: %v", err)
	}

	base := time.Now().UTC().Truncate(time.Microsecond).Add(-time.Hour)
	insertReadSession(t, q, pool, projectID, productionID, nil, "sess_env_prod_old", base.Add(time.Minute))
	insertReadSession(t, q, pool, projectID, staging.ID, nil, "sess_env_stage_old", base.Add(2*time.Minute))
	insertReadSession(t, q, pool, projectID, productionID, nil, "sess_env_prod_new", base.Add(3*time.Minute))
	insertReadSession(t, q, pool, projectID, staging.ID, nil, "sess_env_stage_new", base.Add(4*time.Minute))

	filters := db.SessionFilters{EnvironmentID: productionID}
	firstPage, cursor, err := q.ListSessions(ctx, projectID, filters, nil, 1)
	if err != nil || len(firstPage) != 1 || firstPage[0].ID != "sess_env_prod_new" || cursor == nil {
		t.Fatalf("first environment page = %+v cursor=%v err=%v", firstPage, cursor, err)
	}

	lastPage, next, err := q.ListSessions(ctx, projectID, filters, cursor, 1)
	if err != nil || len(lastPage) != 1 || lastPage[0].ID != "sess_env_prod_old" || next != nil {
		t.Fatalf("last environment page = %+v cursor=%v err=%v", lastPage, next, err)
	}
}

func TestSessionSummaryAndPlayableChunks_AreFailClosedAndScoped(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	otherProjectID, _ := seedSessionProject(t, pool)
	sessionID := "sess_manifest_0001"
	insertReadSession(t, q, pool, projectID, envID, nil, sessionID, time.Now().Add(-time.Minute))
	addReadChunk(t, q, sessionID, projectID, 0, true)
	addReadChunk(t, q, sessionID, projectID, 1, false)
	addReadChunk(t, q, sessionID, projectID, 2, true)

	summary, err := q.GetSessionSummary(ctx, projectID, sessionID)
	if err != nil || summary == nil || summary.PlayableChunkCount != 2 {
		t.Fatalf("summary = %+v err=%v", summary, err)
	}
	if wrong, err := q.GetSessionSummary(ctx, otherProjectID, sessionID); err != nil || wrong != nil {
		t.Fatalf("cross-project summary = %+v err=%v", wrong, err)
	}

	chunks, err := q.ListPlayableChunks(ctx, projectID, sessionID)
	if err != nil || len(chunks) != 2 || !slices.Equal([]int{chunks[0].Seq, chunks[1].Seq}, []int{0, 2}) {
		t.Fatalf("playable chunks = %+v err=%v", chunks, err)
	}
	if chunks[0].ObjectKey == "" || chunks[0].DecodedSizeBytes == nil || *chunks[0].DecodedSizeBytes != 1000 {
		t.Fatalf("chunk metadata = %+v", chunks[0])
	}
	if hidden, err := q.GetPlayableChunk(ctx, projectID, sessionID, 1); err != nil || hidden != nil {
		t.Fatalf("unscrubbed chunk = %+v err=%v", hidden, err)
	}
	if wrong, err := q.GetPlayableChunk(ctx, otherProjectID, sessionID, 0); err != nil || wrong != nil {
		t.Fatalf("cross-project chunk = %+v err=%v", wrong, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE sessions SET status='deleting' WHERE id=$1`, sessionID); err != nil {
		t.Fatalf("mark deleting: %v", err)
	}
	if hidden, err := q.GetSessionSummary(ctx, projectID, sessionID); err != nil || hidden != nil {
		t.Fatalf("deleting summary = %+v err=%v", hidden, err)
	}
	if hidden, err := q.GetPlayableChunk(ctx, projectID, sessionID, 0); err != nil || hidden != nil {
		t.Fatalf("deleting chunk = %+v err=%v", hidden, err)
	}
}

func ingestForSession(t *testing.T, q *db.Queries, projectID, envID, fingerprint, sessionID string) *db.IngestResult {
	t.Helper()
	result, err := q.InsertErrorEventAndGroup(context.Background(), db.IngestParams{
		ProjectID: projectID, DefaultEnvironmentID: envID, Fingerprint: fingerprint,
		Title: "read test", ErrorType: "TypeError", ErrorMessage: "boom",
		StackTraceRaw: "at test", SessionID: sessionID,
	})
	if err != nil {
		t.Fatalf("ingest event: %v", err)
	}
	return result
}

func TestSessionPointerForGroup_UsesNewestIngestedOccurrenceAndEventTime(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	oldSession, newSession := "sess_pointer_old", "sess_pointer_new"
	insertReadSession(t, q, pool, projectID, envID, nil, oldSession, time.Now())
	insertReadSession(t, q, pool, projectID, envID, nil, newSession, time.Now())

	oldResult := ingestForSession(t, q, projectID, envID, "pointer-group", oldSession)
	newResult := ingestForSession(t, q, projectID, envID, "pointer-group", newSession)
	oldCreated := time.Now().Add(-time.Minute).UTC().Truncate(time.Microsecond)
	newCreated := time.Now().UTC().Truncate(time.Microsecond)
	errorAt := newCreated.Add(-45 * time.Second)
	if _, err := pool.Exec(ctx, `UPDATE error_events SET created_at=$2, timestamp=$3 WHERE id=$1`, oldResult.EventID, oldCreated, oldCreated.Add(-10*time.Second)); err != nil {
		t.Fatalf("update old event: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_events SET created_at=$2, timestamp=$3 WHERE id=$1`, newResult.EventID, newCreated, errorAt); err != nil {
		t.Fatalf("update new event: %v", err)
	}

	sessionID, gotErrorAt, ok, err := q.SessionPointerForGroup(ctx, newResult.GroupID, projectID)
	if err != nil || !ok || sessionID != newSession || !gotErrorAt.Equal(errorAt) {
		t.Fatalf("pointer = %q/%v/%v err=%v, want %q/%v/true", sessionID, gotErrorAt, ok, err, newSession, errorAt)
	}

	if _, err := pool.Exec(ctx, `UPDATE sessions SET status='deleting' WHERE id=$1`, newSession); err != nil {
		t.Fatalf("delete newest session: %v", err)
	}
	sessionID, _, ok, err = q.SessionPointerForGroup(ctx, newResult.GroupID, projectID)
	if err != nil || !ok || sessionID != oldSession {
		t.Fatalf("fallback pointer = %q/%v err=%v, want old session", sessionID, ok, err)
	}

	withoutSession := ingestForSession(t, q, projectID, envID, "no-session-group", "")
	if _, _, ok, err := q.SessionPointerForGroup(ctx, withoutSession.GroupID, projectID); err != nil || ok {
		t.Fatalf("no-session pointer ok=%v err=%v", ok, err)
	}
}

func TestInsertErrorEventAndGroup_PinsSessionWithoutLoweringLaterRetention(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	sessionID := "sess_pin_0001"
	insertReadSession(t, q, pool, projectID, envID, nil, sessionID, time.Now())

	before := time.Now()
	ingestForSession(t, q, projectID, envID, "pin-group-1", sessionID)
	var retainUntil *time.Time
	if err := pool.QueryRow(ctx, `SELECT retain_until FROM sessions WHERE id=$1`, sessionID).Scan(&retainUntil); err != nil {
		t.Fatalf("read pin: %v", err)
	}
	if retainUntil == nil || retainUntil.Before(before.Add(29*24*time.Hour)) || retainUntil.After(time.Now().Add(31*24*time.Hour)) {
		t.Fatalf("retain_until = %v, want approximately 30 days", retainUntil)
	}

	later := time.Now().Add(60 * 24 * time.Hour).UTC().Truncate(time.Microsecond)
	if _, err := pool.Exec(ctx, `UPDATE sessions SET retain_until=$2 WHERE id=$1`, sessionID, later); err != nil {
		t.Fatalf("set later pin: %v", err)
	}
	ingestForSession(t, q, projectID, envID, "pin-group-2", sessionID)
	if err := pool.QueryRow(ctx, `SELECT retain_until FROM sessions WHERE id=$1`, sessionID).Scan(&retainUntil); err != nil || retainUntil == nil || !retainUntil.Equal(later) {
		t.Fatalf("later pin = %v err=%v, want %v", retainUntil, err, later)
	}

	if result := ingestForSession(t, q, projectID, envID, "unknown-session-group", "sess_unknown_0001"); result == nil {
		t.Fatal("unknown-session event did not ingest")
	}
}

func TestMarkSessionDeleting_RechecksPinAfterCandidateSelection(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	sessionID := "sess_pin_race_0001"
	insertReadSession(t, q, pool, projectID, envID, nil, sessionID, time.Now().Add(-40*24*time.Hour))

	candidates, err := q.SessionsToDelete(ctx, 100)
	if err != nil {
		t.Fatalf("select candidates: %v", err)
	}
	if !slices.ContainsFunc(candidates, func(candidate db.SessionRef) bool { return candidate.ID == sessionID }) {
		t.Fatalf("test session absent from candidates: %+v", candidates)
	}
	ingestForSession(t, q, projectID, envID, "pin-race-group", sessionID)
	if err := q.MarkSessionDeleting(ctx, sessionID, projectID); err != nil {
		t.Fatalf("mark stale candidate: %v", err)
	}

	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM sessions WHERE id=$1`, sessionID).Scan(&status); err != nil || status == "deleting" {
		t.Fatalf("status=%q err=%v, pin did not win", status, err)
	}
	var tombstones int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM session_tombstones WHERE session_id=$1`, sessionID).Scan(&tombstones); err != nil || tombstones != 0 {
		t.Fatalf("tombstones=%d err=%v, want 0", tombstones, err)
	}
}
