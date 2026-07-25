-- 002_sessions.sql — always-on session recording (epic #31, Batch 1).
-- Append-only after the 001 baseline.
--
-- IDEMPOTENCY IS MANDATORY: there is no migration-tracking table. scripts/
-- run-migrations.sh psql -f's every *.sql in this directory on every start.
-- Every statement here must survive being re-run indefinitely.
--
-- N-1 COMPATIBILITY: this migration only ADDS tables and columns, so an old
-- ingestion binary meeting this schema simply ignores it. Note sessions.status
-- is TEXT + CHECK, not a Postgres enum -- a CHECK constraint can be dropped and
-- re-added, whereas an enum value is permanent. Deliberate (design v4-20).

-- A recorded browser session. The id is client-generated and durable across
-- reloads (persisted in sessionStorage), so it is TEXT, not UUID: the SDK falls
-- back to a non-UUID format when crypto.randomUUID is unavailable in
-- non-secure contexts (packages/sdk/src/session.ts).
CREATE TABLE IF NOT EXISTS sessions (
  id                    TEXT PRIMARY KEY,
  project_id            UUID NOT NULL REFERENCES projects(id),
  environment_id        UUID NOT NULL REFERENCES environments(id),
  end_user_id           UUID REFERENCES end_users(id),
  -- Server-side high-water mark. The client also persists its own counter; this
  -- is the authoritative record and the chunks PK is the real duplicate guard.
  next_chunk_seq        INTEGER NOT NULL DEFAULT 0,
  started_at            TIMESTAMPTZ NOT NULL,
  last_chunk_at         TIMESTAMPTZ,
  chunk_count           INTEGER NOT NULL DEFAULT 0,
  bytes_stored          BIGINT NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'recording'
                          CHECK (status IN ('recording','closed','analyzing','analyzed','analysis_failed','deleting')),
  analyzer_rule_version INTEGER,
  -- Evidence pinning (design v4-16): set when an incident references this
  -- session. The retention sweep skips pinned sessions but still enforces the
  -- hard 90-day cap.
  retain_until          TIMESTAMPTZ,
  deletion_started_at   TIMESTAMPTZ,
  page_url              TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One gzipped rrweb segment. Every chunk opens with a full rrweb snapshot
-- (has_full_snapshot), so it is independently playable and a lost predecessor
-- does not corrupt it (design v4-19).
--
-- FAIL-CLOSED: a chunk with scrubbed_at IS NULL has NOT been redacted. Nothing
-- may read, analyze, or serve it. Every read path must gate on scrubbed_at
-- IS NOT NULL (design v4-2 / #47).
CREATE TABLE IF NOT EXISTS session_chunks (
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  project_id        UUID NOT NULL REFERENCES projects(id),
  object_key        TEXT NOT NULL,
  -- NULL until the upload handler stores the buffered object and commits its
  -- server-observed byte length (design v4-1).
  size_bytes        BIGINT,
  has_full_snapshot BOOLEAN NOT NULL DEFAULT FALSE,
  uploaded_at       TIMESTAMPTZ,
  scrubbed_at       TIMESTAMPTZ,
  scrub_attempts    INTEGER NOT NULL DEFAULT 0,
  scrub_claimed_at  TIMESTAMPTZ,
  scrub_error       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);

-- A deleted session id (design v4-16). An ingestion-owned storage write may
-- already be in flight when retention deletes the session row; recurring
-- prefix sweeps ensure that late write cannot become permanent orphaned data.
-- Deliberately not FK'd to sessions -- the whole point is that the row is gone.
CREATE TABLE IF NOT EXISTS session_tombstones (
  session_id TEXT PRIMARY KEY,
  project_id UUID NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  storage_swept_at TIMESTAMPTZ,
  storage_sweep_claimed_at TIMESTAMPTZ
);

-- Re-application also upgrades databases that created these tables from an
-- earlier draft of this migration.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS deletion_started_at TIMESTAMPTZ;
ALTER TABLE session_chunks ADD COLUMN IF NOT EXISTS scrub_claimed_at TIMESTAMPTZ;
ALTER TABLE session_tombstones ADD COLUMN IF NOT EXISTS storage_swept_at TIMESTAMPTZ;
ALTER TABLE session_tombstones ADD COLUMN IF NOT EXISTS storage_sweep_claimed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'sessions'::regclass
       AND conname = 'sessions_status_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%deleting%'
  ) THEN
    ALTER TABLE sessions DROP CONSTRAINT sessions_status_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'sessions'::regclass AND conname = 'sessions_status_check'
  ) THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_status_check
      CHECK (status IN ('recording','closed','analyzing','analyzed','analysis_failed','deleting'));
  END IF;
END $$;

-- Access paths shipped with the schema (design v4-18). Each one backs a
-- specific query; do not drop one without deleting its caller.

-- Scrubber claim loop (Task 11).
CREATE INDEX IF NOT EXISTS idx_session_chunks_unscrubbed
  ON session_chunks(uploaded_at)
  WHERE scrubbed_at IS NULL;

-- Idle-session close sweep (Task 12).
CREATE INDEX IF NOT EXISTS idx_sessions_recording_last_chunk
  ON sessions(last_chunk_at)
  WHERE status = 'recording';

-- Sessions-by-user browsing (Batch 2). Sessions-by-account rides this plus the
-- existing idx_end_users_account via the end_users join -- there is no accounts
-- table today (design v4-18 parks that decision for Batch 3).
CREATE INDEX IF NOT EXISTS idx_sessions_end_user_started
  ON sessions(end_user_id, started_at)
  WHERE end_user_id IS NOT NULL;

-- Sessions-by-time browsing (Batch 2) and the retention sweep scan (Task 12).
CREATE INDEX IF NOT EXISTS idx_sessions_project_started
  ON sessions(project_id, started_at);

-- Retention sweep: find expiry candidates. The predicate must match
-- SessionsToDelete's WHERE exactly -- Postgres only uses a partial index when
-- the query predicate implies the index predicate, and status <> 'deleting'
-- does not imply status <> 'recording'.
DROP INDEX IF EXISTS idx_sessions_retention;
CREATE INDEX IF NOT EXISTS idx_sessions_retention_not_deleting
  ON sessions(started_at)
  WHERE status <> 'deleting';

-- Purge sweep: SessionsReadyForPurge orders by deletion_started_at. 'deleting'
-- is transient, so the partial predicate keeps this index tiny.
CREATE INDEX IF NOT EXISTS idx_sessions_purge
  ON sessions(deletion_started_at)
  WHERE status = 'deleting';

-- Revisit deleted-session prefixes forever. An ingestion-owned storage write
-- already in flight may finish after the first retention pass.
CREATE INDEX IF NOT EXISTS idx_session_tombstones_storage_sweep_order
  ON session_tombstones((COALESCE(storage_swept_at, deleted_at)), storage_sweep_claimed_at);

-- Per-project recording controls.
-- recording_enabled is the runtime kill switch: /sessions/init returns
-- {"recording": false} when it is off, and the chunk upload endpoint 403s,
-- which stops sessions already in flight (see Correction 8).
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS recording_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS session_retention_days INTEGER NOT NULL DEFAULT 30;
