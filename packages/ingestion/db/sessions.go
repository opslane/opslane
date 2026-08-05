package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrChunkSeqTaken is returned when a (session, seq) pair is already reserved.
// The SDK persists its seq counter, but a reload with a corrupted or reset
// counter would otherwise silently overwrite an earlier chunk.
var ErrChunkSeqTaken = errors.New("chunk seq already reserved for this session")

// ErrSessionNotFound is returned when a session does not exist for the project.
var ErrSessionNotFound = errors.New("session not found for project")

// ErrSessionTombstoned prevents retention races from recreating deleted ids.
var ErrSessionTombstoned = errors.New("session has been deleted")

var ErrSessionProjectConflict = errors.New("session id belongs to another project")

type SessionRegistration struct {
	EnvironmentID      string
	EnvironmentOutcome EnvironmentOutcome
	Diverged           bool
}

type SessionSDKIdentity struct {
	Name    string
	Version string
	Release string
}

// SessionOwnerProject is used only to classify a globally-colliding client id
// during replay initialization. Callers must not expose the returned tenant id.
func (q *Queries) SessionOwnerProject(ctx context.Context, sessionID string) (string, error) {
	var projectID string
	err := q.pool.QueryRow(ctx, `SELECT project_id FROM sessions WHERE id = $1`, sessionID).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read session owner: %w", err)
	}
	return projectID, nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// InsertSession registers a client-generated session. It is idempotent so a
// retried init request neither errors nor resets session progress.
func (q *Queries) RegisterSession(ctx context.Context, sessionID, projectID, defaultEnvironmentID, environmentLabel string, endUserID *string, startedAt time.Time, pageURL string, sdk *SessionSDKIdentity) (*SessionRegistration, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("register session: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var sdkName, sdkVersion, sdkRelease *string
	if sdk != nil {
		sdkName = &sdk.Name
		sdkVersion = &sdk.Version
		sdkRelease = &sdk.Release
	}
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, sessionID); err != nil {
		return nil, fmt.Errorf("register session: advisory lock: %w", err)
	}

	var tombstoned bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM session_tombstones WHERE session_id = $1)`,
		sessionID,
	).Scan(&tombstoned); err != nil {
		return nil, fmt.Errorf("register session: tombstone check: %w", err)
	}
	if tombstoned {
		return nil, ErrSessionTombstoned
	}

	var storedProjectID, storedEnvironmentID, storedEnvironmentName string
	err = tx.QueryRow(ctx,
		`SELECT s.project_id, s.environment_id, e.name
		 FROM sessions s
		 JOIN environments e ON e.id = s.environment_id AND e.project_id = s.project_id
		 WHERE s.id = $1`,
		sessionID,
	).Scan(&storedProjectID, &storedEnvironmentID, &storedEnvironmentName)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("register session: read owner: %w", err)
	}
	if err == nil && storedProjectID != projectID {
		return nil, ErrSessionProjectConflict
	}
	if err == nil {
		diverged := false
		if environmentLabel != "" && environmentNamePattern.MatchString(environmentLabel) {
			diverged = environmentLabel != storedEnvironmentName
		} else {
			diverged = defaultEnvironmentID != storedEnvironmentID
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("register session: commit retry: %w", err)
		}
		return &SessionRegistration{
			EnvironmentID:      storedEnvironmentID,
			EnvironmentOutcome: EnvironmentOutcomeSession,
			Diverged:           diverged,
		}, nil
	}

	environmentID, environmentOutcome, err := resolveEnvironmentTx(
		ctx, tx, projectID, defaultEnvironmentID, environmentLabel,
	)
	if err != nil {
		return nil, fmt.Errorf("register session: resolve environment: %w", err)
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO sessions (
		   id, project_id, environment_id, end_user_id, started_at, page_url,
		   sdk_name, sdk_version, sdk_release
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		sessionID, projectID, environmentID, endUserID, startedAt, pageURL,
		sdkName, sdkVersion, sdkRelease,
	)
	if err != nil {
		return nil, fmt.Errorf("insert session: %w", err)
	}

	var priorEventDivergence bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(
		   SELECT 1 FROM error_events
		   WHERE session_id = $1 AND project_id = $2 AND environment_id <> $3
		 )`,
		sessionID, projectID, environmentID,
	).Scan(&priorEventDivergence); err != nil {
		return nil, fmt.Errorf("register session: check event divergence: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("register session: commit: %w", err)
	}
	return &SessionRegistration{
		EnvironmentID:      environmentID,
		EnvironmentOutcome: environmentOutcome,
		Diverged:           priorEventDivergence,
	}, nil
}

// InsertSession preserves the existing idempotent API for internal callers.
func (q *Queries) InsertSession(ctx context.Context, sessionID, projectID, environmentID string, endUserID *string, startedAt time.Time, pageURL string) error {
	_, err := q.RegisterSession(ctx, sessionID, projectID, environmentID, "", endUserID, startedAt, pageURL, nil)
	return err
}

// SessionBelongsToProject is the ownership gate for every session-scoped route.
func (q *Queries) SessionBelongsToProject(ctx context.Context, sessionID, projectID string) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM sessions WHERE id = $1 AND project_id = $2 AND status <> 'deleting')`,
		sessionID, projectID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("session ownership check: %w", err)
	}
	return exists, nil
}

// SessionIsTombstoned reports whether retention has deleted the session.
func (q *Queries) SessionIsTombstoned(ctx context.Context, sessionID string) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM session_tombstones WHERE session_id = $1)`,
		sessionID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("tombstone check: %w", err)
	}
	return exists, nil
}

// ReserveChunkSeq claims (session, seq) before ingestion writes the object.
// The row is a reservation until CommitChunk records the buffered byte length.
func (q *Queries) ReserveChunkSeq(ctx context.Context, sessionID, projectID string, seq int, objectKey string, hasFullSnapshot bool) error {
	tag, err := q.pool.Exec(ctx,
		`INSERT INTO session_chunks (session_id, seq, project_id, object_key, has_full_snapshot)
		 SELECT $1, $2, $3, $4, $5
		 WHERE EXISTS (SELECT 1 FROM sessions WHERE id = $1 AND project_id = $3 AND status <> 'deleting')`,
		sessionID, seq, projectID, objectKey, hasFullSnapshot,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrChunkSeqTaken
		}
		return fmt.Errorf("reserve chunk seq: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrSessionNotFound
	}
	return nil
}

// CommitChunk records that the object exists, with its server-observed size.
// It is idempotent: retrying a committed chunk does not alter session rollups.
// Deliberately does not set scrubbed_at; only the scrubber makes data readable.
func (q *Queries) CommitChunk(ctx context.Context, sessionID, projectID string, seq int, sizeBytes int64) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin commit chunk: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE session_chunks c
		    SET size_bytes = $4, uploaded_at = now()
		  FROM sessions s
		 WHERE c.session_id = $1 AND c.seq = $2
		   AND s.id = c.session_id AND s.project_id = $3 AND s.status <> 'deleting'
		   AND c.uploaded_at IS NULL`,
		sessionID, seq, projectID, sizeBytes,
	)
	if err != nil {
		return fmt.Errorf("commit chunk: %w", err)
	}
	if tag.RowsAffected() == 0 {
		var alreadyCommitted bool
		if qerr := tx.QueryRow(ctx,
			`SELECT EXISTS(
			   SELECT 1 FROM session_chunks c JOIN sessions s ON s.id = c.session_id
			    WHERE c.session_id = $1 AND c.seq = $2 AND s.project_id = $3 AND s.status <> 'deleting'
			      AND c.uploaded_at IS NOT NULL)`,
			sessionID, seq, projectID,
		).Scan(&alreadyCommitted); qerr != nil {
			return fmt.Errorf("commit chunk recheck: %w", qerr)
		}
		if alreadyCommitted {
			return tx.Commit(ctx)
		}
		return ErrSessionNotFound
	}

	_, err = tx.Exec(ctx,
		`UPDATE sessions
		    SET last_chunk_at  = now(),
		        chunk_count    = chunk_count + 1,
		        bytes_stored   = bytes_stored + $3,
		        next_chunk_seq = GREATEST(next_chunk_seq, $2 + 1)
		  WHERE id = $1 AND project_id = $4`,
		sessionID, seq, sizeBytes, projectID,
	)
	if err != nil {
		return fmt.Errorf("update session rollup: %w", err)
	}

	return tx.Commit(ctx)
}

// ProjectRecordingEnabled reports the per-project recording kill switch.
func (q *Queries) ProjectRecordingEnabled(ctx context.Context, projectID string) (bool, error) {
	var enabled bool
	err := q.pool.QueryRow(ctx,
		`SELECT recording_enabled FROM projects WHERE id = $1`, projectID,
	).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read recording_enabled: %w", err)
	}
	return enabled, nil
}

// UpsertEndUser resolves a project-scoped external user id to an end_users row.
func (q *Queries) UpsertEndUser(ctx context.Context, projectID, externalUserID, accountID, email, accountName string) (string, error) {
	if externalUserID == "" {
		return "", errors.New("external user id is required")
	}
	now := time.Now()
	var id string
	err := q.pool.QueryRow(ctx,
		`INSERT INTO end_users (project_id, external_user_id, external_account_id, email, account_name, first_seen, last_seen)
		 VALUES ($1, $2, $3, $4, $5, $6, $6)
		 ON CONFLICT (project_id, external_user_id) DO UPDATE
		   SET last_seen = $6,
		       email = COALESCE(NULLIF($4, ''), end_users.email),
		       external_account_id = COALESCE(NULLIF($3, ''), end_users.external_account_id),
		       account_name = COALESCE(NULLIF($5, ''), end_users.account_name)
		 RETURNING id`,
		projectID, externalUserID, nilIfEmpty(accountID), nilIfEmpty(email), nilIfEmpty(accountName), now,
	).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("upsert end user: %w", err)
	}
	return id, nil
}

// maxScrubAttempts bounds retries on a chunk that will not scrub. Past this it
// remains permanently unreadable because scrubbed_at stays NULL.
const maxScrubAttempts = 5

// ChunkRef identifies a chunk awaiting scrubbing.
type ChunkRef struct {
	SessionID string
	Seq       int
	ProjectID string
	ObjectKey string
}

// ClaimUnscrubbedChunks atomically claims up to limit uploaded chunks,
// incrementing scrub_attempts so a poison chunk eventually gives up.
func (q *Queries) ClaimUnscrubbedChunks(ctx context.Context, limit int) ([]ChunkRef, error) {
	rows, err := q.pool.Query(ctx,
		`UPDATE session_chunks
		    SET scrub_attempts = scrub_attempts + 1, scrub_claimed_at = now()
		  WHERE (session_id, seq) IN (
		          SELECT c.session_id, c.seq FROM session_chunks c
		          JOIN sessions s ON s.id = c.session_id
		           WHERE c.scrubbed_at IS NULL
		             AND c.uploaded_at IS NOT NULL
		             AND c.uploaded_at <= now() - interval '30 seconds'
		             AND (c.scrub_claimed_at IS NULL OR c.scrub_claimed_at < now() - interval '2 minutes')
		             AND c.scrub_attempts < $2
		             AND s.status <> 'deleting'
		           ORDER BY c.uploaded_at ASC
		           LIMIT $1
		           FOR UPDATE SKIP LOCKED
		        )
		 RETURNING session_id, seq, project_id, object_key`,
		limit, maxScrubAttempts,
	)
	if err != nil {
		return nil, fmt.Errorf("claim unscrubbed chunks: %w", err)
	}
	defer rows.Close()

	var out []ChunkRef
	for rows.Next() {
		var c ChunkRef
		if err := rows.Scan(&c.SessionID, &c.Seq, &c.ProjectID, &c.ObjectKey); err != nil {
			return nil, fmt.Errorf("scan chunk ref: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// MarkChunkScrubbed makes a chunk readable. Call it only after the redacted
// bytes are durably stored.
func (q *Queries) MarkChunkScrubbed(ctx context.Context, sessionID, projectID string, seq int, firstEventMs, lastEventMs *int64, decodedSizeBytes int64) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin mark chunk scrubbed: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`UPDATE session_chunks
		    SET scrubbed_at = now(), scrub_error = NULL, scrub_claimed_at = NULL,
		        first_event_ms = $4, last_event_ms = $5, decoded_size_bytes = $6
		  WHERE session_id = $1 AND seq = $2 AND project_id = $3`,
		sessionID, seq, projectID, firstEventMs, lastEventMs, decodedSizeBytes,
	); err != nil {
		return fmt.Errorf("mark chunk scrubbed: %w", err)
	}

	// Late-chunk re-analysis (issue #56, design v4-5 whole-session truth): a
	// chunk becoming READABLE after its session closed/analyzed re-enqueues
	// analysis, unless a live job already covers it. Scrub time is the correct
	// producer moment — a commit-time job races the scrubber and analyzes a
	// partial session. Same transaction: a chunk is never readable without its
	// re-analysis job.
	if _, err := tx.Exec(ctx,
		`INSERT INTO error_group_jobs (project_id, job_type, session_id)
		 SELECT s.project_id, 'session_analysis', s.id
		   FROM sessions s
		  WHERE s.id = $1 AND s.project_id = $2
		    AND s.status IN ('closed', 'analyzed', 'analysis_failed')
		    AND NOT EXISTS (
		      SELECT 1 FROM error_group_jobs j
		       WHERE j.session_id = s.id
		         AND j.job_type = 'session_analysis'
		         AND j.status IN ('pending', 'claimed'))`,
		sessionID, projectID,
	); err != nil {
		return fmt.Errorf("re-enqueue late-chunk analysis: %w", err)
	}

	return tx.Commit(ctx)
}

// MarkChunkScrubFailed records why scrubbing failed while leaving the chunk
// unreadable.
func (q *Queries) MarkChunkScrubFailed(ctx context.Context, sessionID, projectID string, seq int, reason string) error {
	if len(reason) > 500 {
		reason = reason[:500]
	}
	_, err := q.pool.Exec(ctx,
		`UPDATE session_chunks SET scrub_error = $4, scrub_claimed_at = NULL
		  WHERE session_id = $1 AND seq = $2 AND project_id = $3`,
		sessionID, seq, projectID, reason,
	)
	if err != nil {
		return fmt.Errorf("mark chunk scrub failed: %w", err)
	}
	return nil
}

// hardCapDays is the ceiling on retention even for evidence-pinned sessions.
const hardCapDays = 90

// SessionRef identifies a session slated for deletion.
type SessionRef struct {
	ID        string
	ProjectID string
}

// SessionsToDelete returns sessions past either their project retention window
// when unpinned, or the absolute hard cap whether pinned or not.
func (q *Queries) SessionsToDelete(ctx context.Context, limit int) ([]SessionRef, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT s.id, s.project_id
		   FROM sessions s
		   JOIN projects p ON p.id = s.project_id
		  WHERE s.status <> 'deleting'
		    AND (s.started_at < now() - make_interval(days => $1)
		     OR (
		          s.started_at < now() - make_interval(days => p.session_retention_days)
		          AND (s.retain_until IS NULL OR s.retain_until <= now())
		        ))
		  ORDER BY s.started_at ASC
		  LIMIT $2`,
		hardCapDays, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("select sessions to delete: %w", err)
	}
	defer rows.Close()

	var out []SessionRef
	for rows.Next() {
		var s SessionRef
		if err := rows.Scan(&s.ID, &s.ProjectID); err != nil {
			return nil, fmt.Errorf("scan session ref: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// MarkSessionDeleting tombstones a session and blocks uploads/scrub claims.
func (q *Queries) MarkSessionDeleting(ctx context.Context, sessionID, projectID string) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin mark session deleting: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE sessions SET status = 'deleting', deletion_started_at = COALESCE(deletion_started_at, now())
		  WHERE id = $1 AND project_id = $2 AND status <> 'deleting'
		    AND (started_at < now() - make_interval(days => $3)
		     OR (started_at < now() - make_interval(days => (
		           SELECT session_retention_days FROM projects WHERE id = $2))
		         AND (retain_until IS NULL OR retain_until <= now())))`,
		sessionID, projectID, hardCapDays,
	)
	if err != nil {
		return fmt.Errorf("mark session deleting: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Candidate selection is advisory. A retention pin may have committed
		// after that read; in that case this stale candidate is a clean no-op.
		return tx.Commit(ctx)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO session_tombstones (session_id, project_id) VALUES ($1, $2)
		 ON CONFLICT (session_id) DO NOTHING`,
		sessionID, projectID,
	); err != nil {
		return fmt.Errorf("insert tombstone: %w", err)
	}
	return tx.Commit(ctx)
}

// SessionsReadyForPurge returns tombstoned sessions after all upload policies
// and scrub leases issued before deletion have expired.
func (q *Queries) SessionsReadyForPurge(ctx context.Context, grace time.Duration, limit int) ([]SessionRef, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, project_id FROM sessions
		  WHERE status = 'deleting' AND deletion_started_at <= now() - make_interval(secs => $1)
		  ORDER BY deletion_started_at ASC LIMIT $2`, int(grace.Seconds()), limit)
	if err != nil {
		return nil, fmt.Errorf("select sessions ready for purge: %w", err)
	}
	defer rows.Close()
	var out []SessionRef
	for rows.Next() {
		var ref SessionRef
		if err := rows.Scan(&ref.ID, &ref.ProjectID); err != nil {
			return nil, fmt.Errorf("scan purge session: %w", err)
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}

// DeleteMarkedSession removes a session only after its objects are gone.
func (q *Queries) DeleteMarkedSession(ctx context.Context, sessionID, projectID string) error {
	_, err := q.pool.Exec(ctx,
		`DELETE FROM sessions WHERE id = $1 AND project_id = $2 AND status = 'deleting'`,
		sessionID, projectID)
	if err != nil {
		return fmt.Errorf("delete marked session: %w", err)
	}
	return nil
}

// ClaimTombstonesForStorageSweep rotates through deleted sessions so a late
// object created after the first purge cannot remain orphaned forever. The
// lease prevents every ingestion replica from re-sweeping the same prefixes.
func (q *Queries) ClaimTombstonesForStorageSweep(ctx context.Context, limit int) ([]SessionRef, error) {
	rows, err := q.pool.Query(ctx,
		`UPDATE session_tombstones
		    SET storage_sweep_claimed_at = now()
		  WHERE session_id IN (
		        SELECT t.session_id
		          FROM session_tombstones t
		          LEFT JOIN sessions s ON s.id = t.session_id
		         WHERE s.id IS NULL
		           AND (t.storage_sweep_claimed_at IS NULL
		                OR t.storage_sweep_claimed_at < now() - interval '2 minutes')
		         ORDER BY COALESCE(t.storage_swept_at, t.deleted_at) ASC
		         LIMIT $1
		         FOR UPDATE OF t SKIP LOCKED
		       )
		 RETURNING session_id, project_id`, limit)
	if err != nil {
		return nil, fmt.Errorf("select tombstones for storage sweep: %w", err)
	}
	defer rows.Close()
	var out []SessionRef
	for rows.Next() {
		var ref SessionRef
		if err := rows.Scan(&ref.ID, &ref.ProjectID); err != nil {
			return nil, fmt.Errorf("scan storage-sweep tombstone: %w", err)
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}

func (q *Queries) MarkTombstoneStorageSwept(ctx context.Context, sessionID, projectID string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE session_tombstones
		    SET storage_swept_at = now(), storage_sweep_claimed_at = NULL
		  WHERE session_id = $1 AND project_id = $2`, sessionID, projectID)
	if err != nil {
		return fmt.Errorf("mark tombstone storage swept: %w", err)
	}
	return nil
}

func (q *Queries) ReleaseTombstoneStorageSweep(ctx context.Context, sessionID, projectID string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE session_tombstones SET storage_sweep_claimed_at = NULL
		  WHERE session_id = $1 AND project_id = $2`, sessionID, projectID)
	if err != nil {
		return fmt.Errorf("release tombstone storage sweep: %w", err)
	}
	return nil
}

// ReleaseChunkReservation makes a failed inline attempt retryable.
func (q *Queries) ReleaseChunkReservation(ctx context.Context, sessionID, projectID string, seq int) error {
	_, err := q.pool.Exec(ctx,
		`DELETE FROM session_chunks
		  WHERE session_id = $1 AND project_id = $2 AND seq = $3 AND uploaded_at IS NULL`,
		sessionID, projectID, seq)
	if err != nil {
		return fmt.Errorf("release chunk reservation: %w", err)
	}
	return nil
}

// CloseIdleSessions marks recording sessions with no recent chunk as closed
// and enqueues one session_analysis job per closed session — the friction
// detection producer (issue #56, design: "session close → session_analysis
// job"). One statement, so a close is never observed without its job. The
// recording→closed transition happens exactly once per session, which makes
// the enqueue naturally idempotent.
func (q *Queries) CloseIdleSessions(ctx context.Context, idleMinutes int) (int64, error) {
	tag, err := q.pool.Exec(ctx,
		`WITH closed AS (
		   UPDATE sessions
		      SET status = 'closed'
		    WHERE status = 'recording'
		      AND COALESCE(last_chunk_at, started_at) < now() - make_interval(mins => $1)
		    RETURNING id, project_id
		 )
		 INSERT INTO error_group_jobs (project_id, job_type, session_id)
		 SELECT project_id, 'session_analysis', id FROM closed`,
		idleMinutes,
	)
	if err != nil {
		return 0, fmt.Errorf("close idle sessions: %w", err)
	}
	return tag.RowsAffected(), nil
}
