-- Project-owned default environment and obsolete environment-override state.
-- Migrations are replayed on every boot, so every operation must be idempotent.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS default_environment_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_environments_id_project
  ON environments (id, project_id);

UPDATE projects p
SET default_environment_id = e.id
FROM environments e
WHERE p.default_environment_id IS NULL
  AND e.project_id = p.id
  AND e.name = 'production';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_projects_default_environment'
      AND conrelid = 'projects'::regclass
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT fk_projects_default_environment
      FOREIGN KEY (default_environment_id, id)
      REFERENCES environments (id, project_id)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE projects
  VALIDATE CONSTRAINT fk_projects_default_environment;

-- #240: project keys identify projects, not environments. These columns are
-- obsolete, and their original ADD statements were removed from replayed files.
ALTER TABLE projects DROP COLUMN IF EXISTS allow_payload_environment;
ALTER TABLE projects DROP COLUMN IF EXISTS provisioning_key_id;
