-- Debug-ID-keyed source maps (v1 single-map upload; supersedes the frozen
-- batch tables per docs/plans/2026-08-03-v1-sourcemaps-simplification.md).
CREATE TABLE IF NOT EXISTS sourcemap_files (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  debug_id TEXT NOT NULL CHECK (
    debug_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  has_sources_content BOOLEAN NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  object_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, debug_id)
);

-- No FK: a tombstone must survive the project row it describes. It records
-- which object-storage prefixes hold orphaned customer source until the
-- deferred sweeper runs. A trigger also covers manual SQL deletes.
CREATE TABLE IF NOT EXISTS sourcemap_tombstones (
  project_id UUID NOT NULL,
  storage_prefix TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id)
);

CREATE OR REPLACE FUNCTION write_sourcemap_tombstone() RETURNS trigger AS $$
BEGIN
  INSERT INTO sourcemap_tombstones (project_id, storage_prefix)
  VALUES (OLD.id, 'sourcemaps/' || OLD.id || '/')
  ON CONFLICT (project_id) DO NOTHING;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_sourcemap_tombstone ON projects;
CREATE TRIGGER projects_sourcemap_tombstone
  BEFORE DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION write_sourcemap_tombstone();
