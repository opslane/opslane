package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// SessionSummary is the project-scoped metadata exposed by session browsing.
// End-user fields are nullable because anonymous recordings are valid.
type SessionSummary struct {
	ID                    string
	StartedAt             time.Time
	LastChunkAt           *time.Time
	Status                string
	ChunkCount            int
	PlayableChunkCount    int
	BytesStored           int64
	PageURL               *string
	SDKRelease            *string
	EndUserID             *string
	ExternalUserID        *string
	EndUserEmail          *string
	ExternalAccountID     *string
	AccountName           *string
	ErrorCount            int
	RageClickCount        int
	DeadClickCount        int
	FormAbandonCount      int
	Coverage              *string
	ActivityClass         *string
	FailedRequestCount    int
	SuccessfulWriteCount  int
	UnverifiedSignalCount int
}

type SessionFilters struct {
	EndUserID     string
	AccountID     string
	EnvironmentID string
	Search        string
	HasSignals    bool
	From          *time.Time
	To            *time.Time
}

type SessionCursor struct {
	StartedAt time.Time
	ID        string
}

type sessionScanner interface {
	Scan(dest ...any) error
}

func scanSessionSummary(row sessionScanner) (SessionSummary, error) {
	var session SessionSummary
	err := row.Scan(
		&session.ID, &session.StartedAt, &session.LastChunkAt, &session.Status,
		&session.ChunkCount, &session.BytesStored, &session.PageURL, &session.SDKRelease,
		&session.EndUserID, &session.ExternalUserID, &session.EndUserEmail,
		&session.ExternalAccountID, &session.AccountName, &session.PlayableChunkCount,
		&session.ErrorCount, &session.RageClickCount, &session.DeadClickCount,
		&session.FormAbandonCount,
		&session.Coverage, &session.ActivityClass, &session.FailedRequestCount,
		&session.SuccessfulWriteCount, &session.UnverifiedSignalCount,
	)
	return session, err
}

const sessionSummarySelect = `SELECT s.id, s.started_at, s.last_chunk_at, s.status,
       s.chunk_count, s.bytes_stored, s.page_url, s.sdk_release,
       eu.id, eu.external_user_id, eu.email, eu.external_account_id, eu.account_name,
       (SELECT count(*) FROM session_chunks c
         WHERE c.session_id = s.id AND c.scrubbed_at IS NOT NULL),
       e.errors, f.rage, f.dead, f.abandon,
       sa.coverage, sa.activity_class,
       COALESCE(sa.failed_request_4xx_count + sa.failed_request_5xx_count, 0),
       COALESCE(sa.successful_write_count, 0), f.pending
  FROM sessions s
  LEFT JOIN end_users eu ON eu.id = s.end_user_id AND eu.project_id = $1
  LEFT JOIN session_analysis sa ON sa.session_id = s.id AND sa.project_id = $1
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(fs.occurrence_count) FILTER (WHERE fs.adjudication_status = 'accepted' AND fs.signal_type = 'rage_click'), 0) AS rage,
           COALESCE(sum(fs.occurrence_count) FILTER (WHERE fs.adjudication_status = 'accepted' AND fs.signal_type = 'dead_click'), 0) AS dead,
           COALESCE(sum(fs.occurrence_count) FILTER (WHERE fs.adjudication_status = 'accepted' AND fs.signal_type = 'form_abandon'), 0) AS abandon,
           COALESCE(sum(fs.occurrence_count) FILTER (WHERE fs.adjudication_status = 'pending'), 0) AS pending
      FROM friction_signals fs
     WHERE fs.session_id = s.id
       AND fs.project_id = $1
       AND fs.retracted_at IS NULL
       AND fs.superseded_by IS NULL
  ) f ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS errors
      FROM error_events ee
     WHERE ee.session_id = s.id
       AND ee.project_id = $1
  ) e ON true`

// ListSessions returns non-deleting project sessions newest-first. It fetches
// one row beyond the requested limit so exactly-full terminal pages do not
// advertise a cursor for a page that does not exist.
func (q *Queries) ListSessions(ctx context.Context, projectID string, filters SessionFilters, cursor *SessionCursor, limit int) ([]SessionSummary, *SessionCursor, error) {
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	var cursorStartedAt *time.Time
	cursorID := ""
	if cursor != nil {
		cursorStartedAt = &cursor.StartedAt
		cursorID = cursor.ID
	}

	rows, err := q.pool.Query(ctx, sessionSummarySelect+`
 WHERE s.project_id = $1
   AND s.status <> 'deleting'
   AND ($2 = '' OR s.end_user_id::text = $2)
   AND ($3 = '' OR eu.external_account_id = $3)
   AND ($4::timestamptz IS NULL OR s.started_at >= $4)
   AND ($5::timestamptz IS NULL OR s.started_at <= $5)
   AND ($6 = '' OR s.environment_id = NULLIF($6, '')::uuid)
   AND ($7::timestamptz IS NULL OR (s.started_at, s.id) < ($7, $8))
   AND ($9 = '' OR eu.email ILIKE '%' || $9 || '%'
                 OR eu.external_user_id ILIKE '%' || $9 || '%'
                 OR eu.account_name ILIKE '%' || $9 || '%'
                 OR eu.external_account_id ILIKE '%' || $9 || '%'
                 OR s.id = $9)
   AND ($10 = false OR (f.rage + f.dead + f.abandon + f.pending + e.errors) > 0)
 ORDER BY s.started_at DESC, s.id DESC
 LIMIT $11`, projectID, filters.EndUserID, filters.AccountID, filters.From, filters.To,
		filters.EnvironmentID, cursorStartedAt, cursorID, filters.Search, filters.HasSignals, limit+1)
	if err != nil {
		return nil, nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()

	sessions := make([]SessionSummary, 0, limit+1)
	for rows.Next() {
		session, scanErr := scanSessionSummary(rows)
		if scanErr != nil {
			return nil, nil, fmt.Errorf("scan session summary: %w", scanErr)
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("list sessions rows: %w", err)
	}

	var next *SessionCursor
	if len(sessions) > limit {
		sessions = sessions[:limit]
		last := sessions[len(sessions)-1]
		next = &SessionCursor{StartedAt: last.StartedAt, ID: last.ID}
	}
	return sessions, next, nil
}

type SessionAnalysisDailyRollup struct {
	Day                     time.Time
	TotalSessions           int
	NoReplaySessions        int
	PartialSessions         int
	ActiveSessions          int
	LightTouchSessions      int
	ZeroInteractionSessions int
	IdleTabSessions         int
	SuccessfulWrites        int
	SessionsWithFailures    int
}

func (q *Queries) SessionAnalysisDailyRollup(ctx context.Context, projectID string, day time.Time) (SessionAnalysisDailyRollup, error) {
	result := SessionAnalysisDailyRollup{Day: day}
	err := q.pool.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE coverage = 'no_replay'),
		       count(*) FILTER (WHERE coverage = 'partial'),
		       count(*) FILTER (WHERE coverage = 'complete' AND activity_class = 'active'),
		       count(*) FILTER (WHERE coverage = 'complete' AND activity_class = 'light_touch'),
		       count(*) FILTER (WHERE coverage = 'complete' AND activity_class = 'zero_interaction'),
		       count(*) FILTER (WHERE coverage = 'complete' AND activity_class = 'idle_tab'),
		       COALESCE(sum(successful_write_count) FILTER (WHERE coverage = 'complete'), 0),
		       count(*) FILTER (WHERE coverage = 'complete'
		                          AND failed_request_4xx_count + failed_request_5xx_count > 0)
		  FROM session_analysis
		 WHERE project_id = $1
		   AND session_started_at >= $2::date
		   AND session_started_at < $2::date + interval '1 day'`, projectID, day).Scan(
		&result.TotalSessions, &result.NoReplaySessions, &result.PartialSessions,
		&result.ActiveSessions, &result.LightTouchSessions, &result.ZeroInteractionSessions,
		&result.IdleTabSessions, &result.SuccessfulWrites, &result.SessionsWithFailures)
	return result, err
}

func (q *Queries) EnqueueAnalysisBackfillBatch(ctx context.Context, ruleVersion, batch int) (int, error) {
	tag, err := q.pool.Exec(ctx, `
		INSERT INTO error_group_jobs (project_id, session_id, job_type, status)
		SELECT s.project_id, s.id, 'session_analysis', 'pending'
		  FROM sessions s
		 WHERE s.status IN ('closed', 'analyzed', 'analysis_failed')
		   AND s.started_at >= now() - interval '30 days'
		   AND NOT EXISTS (SELECT 1 FROM session_analysis sa
		                    WHERE sa.session_id = s.id AND sa.rule_version >= $1)
		   AND NOT EXISTS (SELECT 1 FROM error_group_jobs j
		                    WHERE j.session_id = s.id AND j.job_type = 'session_analysis'
		                      AND j.status IN ('pending', 'claimed'))
		 ORDER BY s.started_at DESC
		 LIMIT $2`, ruleVersion, batch)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

func (q *Queries) CountAnalysisBackfillCandidates(ctx context.Context, ruleVersion int) (int, error) {
	var count int
	err := q.pool.QueryRow(ctx, `SELECT count(*) FROM sessions s
		WHERE s.status IN ('closed', 'analyzed', 'analysis_failed')
		  AND s.started_at >= now() - interval '30 days'
		  AND NOT EXISTS (SELECT 1 FROM session_analysis sa
		                  WHERE sa.session_id = s.id AND sa.rule_version >= $1)
		  AND NOT EXISTS (SELECT 1 FROM error_group_jobs j
		                  WHERE j.session_id = s.id AND j.job_type = 'session_analysis'
		                    AND j.status IN ('pending', 'claimed'))`, ruleVersion).Scan(&count)
	return count, err
}

// HasIdentifiedSessions reports whether the project has any non-deleting
// session attached to an end user, independently of the current list page.
func (q *Queries) HasIdentifiedSessions(ctx context.Context, projectID string) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1
		  FROM sessions
		 WHERE project_id = $1
		   AND end_user_id IS NOT NULL
		   AND status <> 'deleting'
	)`, projectID).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check identified sessions: %w", err)
	}
	return exists, nil
}

// GetSessionSummary returns nil when the session is absent, belongs to another
// project, or is deleting.
func (q *Queries) GetSessionSummary(ctx context.Context, projectID, sessionID string) (*SessionSummary, error) {
	session, err := scanSessionSummary(q.pool.QueryRow(ctx, sessionSummarySelect+`
 WHERE s.project_id = $1 AND s.id = $2 AND s.status <> 'deleting'`, projectID, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get session summary: %w", err)
	}
	return &session, nil
}

// SessionChunk is a scrubbed chunk manifest entry. ObjectKey is intentionally
// retained only in the DB layer; HTTP manifests never serialize it.
type SessionChunk struct {
	Seq              int
	ObjectKey        string
	SizeBytes        *int64
	DecodedSizeBytes *int64
	HasFullSnapshot  bool
	FirstEventMs     *int64
	LastEventMs      *int64
}

const playableChunksSelect = `SELECT c.seq, c.object_key, c.size_bytes, c.decoded_size_bytes,
       c.has_full_snapshot, c.first_event_ms, c.last_event_ms
  FROM session_chunks c
  JOIN sessions s ON s.id = c.session_id
 WHERE c.project_id = $1 AND c.session_id = $2
   AND s.project_id = $1 AND s.status <> 'deleting'
   AND c.scrubbed_at IS NOT NULL`

func scanSessionChunk(row sessionScanner) (SessionChunk, error) {
	var chunk SessionChunk
	err := row.Scan(&chunk.Seq, &chunk.ObjectKey, &chunk.SizeBytes, &chunk.DecodedSizeBytes,
		&chunk.HasFullSnapshot, &chunk.FirstEventMs, &chunk.LastEventMs)
	return chunk, err
}

// ListPlayableChunks returns only scrubbed chunks, ordered for stitching.
func (q *Queries) ListPlayableChunks(ctx context.Context, projectID, sessionID string) ([]SessionChunk, error) {
	rows, err := q.pool.Query(ctx, playableChunksSelect+` ORDER BY c.seq ASC`, projectID, sessionID)
	if err != nil {
		return nil, fmt.Errorf("list playable chunks: %w", err)
	}
	defer rows.Close()

	chunks := make([]SessionChunk, 0)
	for rows.Next() {
		chunk, scanErr := scanSessionChunk(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("scan playable chunk: %w", scanErr)
		}
		chunks = append(chunks, chunk)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list playable chunks rows: %w", err)
	}
	return chunks, nil
}

// GetPlayableChunk applies the same fail-closed scrub and session-status gates
// as ListPlayableChunks and returns nil for every unavailable case.
func (q *Queries) GetPlayableChunk(ctx context.Context, projectID, sessionID string, seq int) (*SessionChunk, error) {
	chunk, err := scanSessionChunk(q.pool.QueryRow(ctx, playableChunksSelect+` AND c.seq = $3`, projectID, sessionID, seq))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get playable chunk: %w", err)
	}
	return &chunk, nil
}

const (
	watchWindowMs         = 15_000
	watchCandidateEvents  = 50
	watchCandidateSignals = 50
)

// watchCoverageSQL is the single source of the watchability contract, applied
// to a candidate row exposing session_id + anchor_ms: the session's scrubbed,
// bounded chunks must stitch across the full ±15s window around the anchor,
// and a full-snapshot chunk must start at-or-before the window. Shared by the
// error and friction watchable queries so the two lanes cannot drift.
var watchCoverageSQL = fmt.Sprintf(`
WHERE EXISTS (
  SELECT 1 FROM session_chunks c
   WHERE c.session_id = cand.session_id AND c.project_id = $2
     AND c.scrubbed_at IS NOT NULL
     AND c.first_event_ms IS NOT NULL AND c.last_event_ms IS NOT NULL
  HAVING min(c.first_event_ms) <= cand.anchor_ms - %d
     AND max(c.last_event_ms) >= cand.anchor_ms + %d
)
AND EXISTS (
  SELECT 1 FROM session_chunks c
   WHERE c.session_id = cand.session_id AND c.project_id = $2
     AND c.scrubbed_at IS NOT NULL AND c.has_full_snapshot
     AND c.first_event_ms IS NOT NULL AND c.last_event_ms IS NOT NULL
     AND c.first_event_ms <= cand.anchor_ms - %d
)`, watchWindowMs, watchWindowMs, watchWindowMs)

// frictionCandidateSQL is the single source of "the incident's live signals,
// representative first, then earliest accepted": shared by the incident-page
// pointer and the digest watchable query so retraction/supersession semantics
// stay identical on both surfaces.
const frictionCandidateSQL = `
  SELECT fs.session_id,
         (extract(epoch FROM fs.occurred_at) * 1000)::bigint AS anchor_ms,
         fs.occurred_at,
         (fs.id = g.representative_signal_id) AS representative,
         fs.id
    FROM friction_signals fs
    JOIN sessions s ON s.id = fs.session_id AND s.project_id = fs.project_id
    JOIN error_groups g ON g.id = $1 AND g.project_id = $2
   WHERE fs.incident_id = $1 AND fs.project_id = $2
     AND ($3::timestamptz IS NULL OR fs.occurred_at >= $3)
     AND fs.adjudication_status = 'accepted'
     AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
     AND s.status <> 'deleting'
   ORDER BY (fs.id = g.representative_signal_id) DESC, fs.occurred_at ASC, fs.id ASC`

// One candidate per session (a looping session cannot evict every covered
// sibling from the pool), newest sessions first, pool bounded before the
// coverage probes run.
var watchableErrorSessionSQL = fmt.Sprintf(`
SELECT cand.session_id, cand.anchor_ms FROM (
  SELECT per_session.* FROM (
    SELECT DISTINCT ON (e.session_id)
           e.session_id,
           (extract(epoch FROM e."timestamp") * 1000)::bigint AS anchor_ms,
           e.created_at, e.id
      FROM error_events e
      JOIN sessions s ON s.id = e.session_id AND s.project_id = e.project_id
     WHERE e.error_group_id = $1 AND e.project_id = $2
       AND ($3::timestamptz IS NULL OR e."timestamp" >= $3)
       AND e.session_id IS NOT NULL AND s.status <> 'deleting'
     ORDER BY e.session_id, e.created_at DESC, e.id DESC
  ) per_session
  ORDER BY per_session.created_at DESC, per_session.id DESC
  LIMIT %d
) cand
%s
ORDER BY cand.created_at DESC, cand.id DESC
LIMIT 1`, watchCandidateEvents, watchCoverageSQL)

var watchableFrictionSessionSQL = fmt.Sprintf(`
SELECT cand.session_id, cand.anchor_ms FROM (%s
   LIMIT %d
) cand
%s
ORDER BY cand.representative DESC, cand.occurred_at ASC, cand.id ASC
LIMIT 1`, frictionCandidateSQL, watchCandidateSignals, watchCoverageSQL)

// GroupRecording is one coverage-proven recording for an error incident.
// DurationMs is the recorded span of bounded chunks (gaps included), and
// CrashCount is aggregated from error_events before chunk access.
type GroupRecording struct {
	SessionID  string
	StartedAt  time.Time
	DurationMs int64
	CrashCount int64
	AnchorMs   int64
}

const recordingsCap = 5

var groupRecordingsSQL = fmt.Sprintf(`
SELECT cand.session_id, cand.started_at, crashes.crash_count, cand.anchor_ms,
       span.first_ms, span.last_ms
  FROM (
    SELECT per_session.* FROM (
      SELECT DISTINCT ON (e.session_id)
             e.session_id,
             (extract(epoch FROM e."timestamp") * 1000)::bigint AS anchor_ms,
             e.created_at, e.id, s.started_at
        FROM error_events e
        JOIN sessions s ON s.id = e.session_id AND s.project_id = e.project_id
       WHERE e.error_group_id = $1 AND e.project_id = $2
         AND e.session_id IS NOT NULL AND s.status <> 'deleting'
       ORDER BY e.session_id, e.created_at DESC, e.id DESC
    ) per_session
    ORDER BY per_session.created_at DESC, per_session.id DESC
    LIMIT %d
  ) cand
  CROSS JOIN LATERAL (
    SELECT count(*)::bigint AS crash_count
      FROM error_events e
     WHERE e.error_group_id = $1 AND e.project_id = $2
       AND e.session_id = cand.session_id
  ) crashes
  CROSS JOIN LATERAL (
    SELECT min(c.first_event_ms) AS first_ms, max(c.last_event_ms) AS last_ms
      FROM session_chunks c
     WHERE c.session_id = cand.session_id AND c.project_id = $2
       AND c.scrubbed_at IS NOT NULL
       AND c.first_event_ms IS NOT NULL AND c.last_event_ms IS NOT NULL
  ) span
  %s
  ORDER BY cand.anchor_ms DESC, cand.session_id DESC
  LIMIT %d`, watchCandidateEvents, watchCoverageSQL, recordingsCap)

// groupKind resolves an incident's lane; found=false when the group does not
// exist in the tenant.
// RowQuerier is implemented by pgx pools, connections, and transactions.
type RowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func groupKindOn(ctx context.Context, q RowQuerier, errorGroupID, projectID string) (kind string, found bool, err error) {
	err = q.QueryRow(ctx,
		`SELECT kind FROM error_groups WHERE id=$1 AND project_id=$2`, errorGroupID, projectID).Scan(&kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return kind, true, nil
}

func (q *Queries) groupKind(ctx context.Context, errorGroupID, projectID string) (kind string, found bool, err error) {
	return groupKindOn(ctx, q.pool, errorGroupID, projectID)
}

// SessionPointerForGroup resolves pointer identity independently of chunk
// readiness. Error incidents use their newest ingested occurrence; friction
// incidents prefer the live representative signal and otherwise use their
// earliest accepted, active signal.
func (q *Queries) SessionPointerForGroup(ctx context.Context, errorGroupID, projectID string) (sessionID string, errorAt time.Time, ok bool, err error) {
	kind, found, err := q.groupKind(ctx, errorGroupID, projectID)
	if err != nil {
		return "", time.Time{}, false, fmt.Errorf("session pointer group kind: %w", err)
	}
	if !found {
		return "", time.Time{}, false, nil
	}

	query := `SELECT ee.session_id, ee.timestamp
		   FROM error_events ee
		   JOIN sessions s ON s.id = ee.session_id AND s.project_id = $2
		  WHERE ee.error_group_id = $1 AND ee.project_id = $2
		    AND ee.session_id IS NOT NULL
		    AND s.status <> 'deleting'
		  ORDER BY ee.created_at DESC, ee.id DESC
		  LIMIT 1`
	if kind == "friction" {
		query = `SELECT cand.session_id, cand.occurred_at FROM (` + frictionCandidateSQL + `
	   LIMIT 1) cand`
		err = q.pool.QueryRow(ctx, query, errorGroupID, projectID, nil).Scan(&sessionID, &errorAt)
	} else {
		err = q.pool.QueryRow(ctx, query, errorGroupID, projectID).Scan(&sessionID, &errorAt)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return "", time.Time{}, false, nil
	}
	if err != nil {
		return "", time.Time{}, false, fmt.Errorf("session pointer for group: %w", err)
	}
	return sessionID, errorAt, true, nil
}

// WatchableSessionForGroup returns a pointer whose scrubbed, bounded chunks
// span the full +/-15 second playback window and whose opening side has a full
// snapshot. The span may contain gaps in v1. anchorMs is absolute client-clock
// epoch milliseconds, matching the dashboard's ?t= contract.
func (q *Queries) WatchableSessionForGroup(ctx context.Context, errorGroupID, projectID string) (sessionID string, anchorMs int64, ok bool, err error) {
	return WatchableSessionForGroupOn(ctx, q.pool, errorGroupID, projectID, time.Time{})
}

// WatchableSessionForGroupOn is the transaction-capable watchable-session
// lookup. A non-zero since value excludes incident activity before that time.
func WatchableSessionForGroupOn(ctx context.Context, q RowQuerier, errorGroupID, projectID string, since time.Time) (sessionID string, anchorMs int64, ok bool, err error) {
	kind, found, err := groupKindOn(ctx, q, errorGroupID, projectID)
	if err != nil {
		return "", 0, false, fmt.Errorf("watchable session group kind: %w", err)
	}
	if !found {
		return "", 0, false, nil
	}

	query := watchableErrorSessionSQL
	if kind == "friction" {
		query = watchableFrictionSessionSQL
	}
	var floor any
	if !since.IsZero() {
		floor = since
	}
	err = q.QueryRow(ctx, query, errorGroupID, projectID, floor).Scan(&sessionID, &anchorMs)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", 0, false, nil
	}
	if err != nil {
		return "", 0, false, fmt.Errorf("watchable session for group: %w", err)
	}
	return sessionID, anchorMs, true, nil
}

// RecordingsForGroup lists coverage-proven sessions for an error incident,
// newest client-time anchor first. Friction incidents keep the existing
// identity-based session pointer and do not expose this list.
func (q *Queries) RecordingsForGroup(ctx context.Context, errorGroupID, projectID string) ([]GroupRecording, error) {
	kind, found, err := q.groupKind(ctx, errorGroupID, projectID)
	if err != nil {
		return nil, fmt.Errorf("recordings group kind: %w", err)
	}
	if !found || kind == "friction" {
		return nil, nil
	}

	rows, err := q.pool.Query(ctx, groupRecordingsSQL, errorGroupID, projectID)
	if err != nil {
		return nil, fmt.Errorf("recordings for group: %w", err)
	}
	defer rows.Close()

	recordings := make([]GroupRecording, 0)
	for rows.Next() {
		var rec GroupRecording
		var firstMs, lastMs int64
		if err := rows.Scan(&rec.SessionID, &rec.StartedAt, &rec.CrashCount, &rec.AnchorMs, &firstMs, &lastMs); err != nil {
			return nil, fmt.Errorf("scan group recording: %w", err)
		}
		rec.DurationMs = lastMs - firstMs
		recordings = append(recordings, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("recordings for group rows: %w", err)
	}
	return recordings, nil
}
