-- S2b: source-map batches, files, and manifest rows.
-- The runner replays every migration on every boot, so every statement must be
-- idempotent. Add-only, never drop: a later foreign key depends on this index.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_api_keys_id_project_key'
      AND conrelid = 'project_api_keys'::regclass
  ) THEN
    ALTER TABLE project_api_keys
      ADD CONSTRAINT project_api_keys_id_project_key UNIQUE (id, project_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sourcemap_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  upload_key_db_id UUID NOT NULL,
  idempotency_key UUID NOT NULL,
  manifest_sha256 BYTEA NOT NULL CHECK (octet_length(manifest_sha256) = 32),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completing', 'complete', 'expired')),
  probe BOOLEAN NOT NULL DEFAULT false,
  commit_sha TEXT
    CHECK (commit_sha IS NULL OR commit_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  release TEXT CHECK (release IS NULL OR octet_length(release) <= 200),
  expected_file_count INTEGER NOT NULL
    CHECK (expected_file_count BETWEEN 1 AND 500),
  expected_bytes BIGINT NOT NULL
    CHECK (expected_bytes BETWEEN 1 AND 1073741824),
  received_file_count INTEGER NOT NULL DEFAULT 0,
  received_bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  completion_claimed_at TIMESTAMPTZ,
  completion_lease_expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  storage_sweep_claimed_at TIMESTAMPTZ,
  storage_swept_at TIMESTAMPTZ,
  UNIQUE (id, project_id),
  UNIQUE (project_id, upload_key_db_id, idempotency_key),
  FOREIGN KEY (upload_key_db_id, project_id)
    REFERENCES project_api_keys(id, project_id),
  CHECK (received_file_count BETWEEN 0 AND expected_file_count),
  CHECK (received_bytes BETWEEN 0 AND expected_bytes),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'completing'
      AND completion_claimed_at IS NOT NULL
      AND completion_lease_expires_at IS NOT NULL)
    OR
    (status <> 'completing'
      AND completion_claimed_at IS NULL
      AND completion_lease_expires_at IS NULL)
  ),
  CHECK (
    status NOT IN ('completing', 'complete') OR
    (
      received_file_count = expected_file_count AND
      received_bytes = expected_bytes
    )
  ),
  CHECK ((status = 'complete') = (completed_at IS NOT NULL)),
  CHECK ((status = 'expired') = (expired_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_sourcemap_batches_project_health
  ON sourcemap_batches(project_id, completed_at DESC, id DESC)
  WHERE status = 'complete' AND probe = false;

CREATE INDEX IF NOT EXISTS idx_sourcemap_batches_expiry
  ON sourcemap_batches(expires_at, id)
  WHERE status = 'pending' AND storage_swept_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sourcemap_batches_completion_reclaim
  ON sourcemap_batches(completion_lease_expires_at, id)
  WHERE status = 'completing';

CREATE TABLE IF NOT EXISTS sourcemap_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  debug_id UUID NOT NULL,
  content_sha256 BYTEA NOT NULL CHECK (octet_length(content_sha256) = 32),
  size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1 AND 104857600),
  object_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  UNIQUE (id, project_id),
  UNIQUE (project_id, debug_id),
  UNIQUE (project_id, object_key),
  CHECK (
    object_key =
      'sourcemaps/v1/projects/' || project_id::text ||
      '/maps/' || encode(content_sha256, 'hex') || '.map'
  )
);

CREATE TABLE IF NOT EXISTS sourcemap_batch_files (
  batch_id UUID NOT NULL,
  project_id UUID NOT NULL,
  debug_id UUID NOT NULL,
  code_file TEXT NOT NULL
    CHECK (octet_length(code_file) BETWEEN 1 AND 4096),
  expected_size_bytes BIGINT NOT NULL
    CHECK (expected_size_bytes BETWEEN 1 AND 104857600),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'staged', 'linked')),
  staging_object_key TEXT,
  received_size_bytes BIGINT,
  canonical_size_bytes BIGINT
    CHECK (
      canonical_size_bytes IS NULL OR
      canonical_size_bytes BETWEEN 1 AND 104857600
    ),
  raw_sha256 BYTEA
    CHECK (raw_sha256 IS NULL OR octet_length(raw_sha256) = 32),
  content_sha256 BYTEA
    CHECK (content_sha256 IS NULL OR octet_length(content_sha256) = 32),
  source_map_id UUID,
  uploaded_at TIMESTAMPTZ,
  PRIMARY KEY (batch_id, debug_id),
  FOREIGN KEY (batch_id, project_id)
    REFERENCES sourcemap_batches(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (source_map_id, project_id)
    REFERENCES sourcemap_files(id, project_id),
  CHECK (
    received_size_bytes IS NULL OR
    received_size_bytes = expected_size_bytes
  ),
  CHECK (
    (state = 'pending'
      AND staging_object_key IS NULL
      AND received_size_bytes IS NULL
      AND canonical_size_bytes IS NULL
      AND raw_sha256 IS NULL
      AND content_sha256 IS NULL
      AND source_map_id IS NULL
      AND uploaded_at IS NULL)
    OR
    (state = 'staged'
      AND staging_object_key IS NOT NULL
      AND received_size_bytes IS NOT NULL
      AND canonical_size_bytes IS NOT NULL
      AND raw_sha256 IS NOT NULL
      AND content_sha256 IS NOT NULL
      AND source_map_id IS NULL
      AND uploaded_at IS NOT NULL)
    OR
    (state = 'linked'
      AND received_size_bytes IS NOT NULL
      AND canonical_size_bytes IS NOT NULL
      AND raw_sha256 IS NOT NULL
      AND content_sha256 IS NOT NULL
      AND source_map_id IS NOT NULL
      AND uploaded_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_sourcemap_batch_files_source_map
  ON sourcemap_batch_files(source_map_id, batch_id)
  WHERE state = 'linked';

CREATE OR REPLACE FUNCTION prevent_sourcemap_file_identity_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.project_id, NEW.debug_id, NEW.content_sha256,
         NEW.size_bytes, NEW.object_key, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.project_id, OLD.debug_id, OLD.content_sha256,
         OLD.size_bytes, OLD.object_key, OLD.created_at)
  THEN
    RAISE EXCEPTION 'source map artifact identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_sourcemap_file_identity_immutable
BEFORE UPDATE ON sourcemap_files
FOR EACH ROW EXECUTE FUNCTION prevent_sourcemap_file_identity_update();
