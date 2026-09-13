-- The ingestion handler validates step names. Dropping this CHECK makes the
-- Go allowlist the only gate, so later steps do not require a migration.
ALTER TABLE agent_session_steps DROP CONSTRAINT IF EXISTS agent_session_steps_step_check;
