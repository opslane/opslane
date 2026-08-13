-- Forensic candidate dispositions and the cause kind that drove routing.
-- Both nullable: every existing row and every legacy-shape decision stays valid.
-- The inline CHECK follows 035's pattern: it applies when the column is first
-- created and the guarded ADD COLUMN makes replays a no-op. diagnosis_decisions
-- is insert-only (034), so a bad cause_kind would otherwise be permanent.
ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS candidate_dispositions jsonb;
ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS cause_kind text
  CHECK (cause_kind IS NULL OR cause_kind IN ('local_code', 'external_system', 'data_or_input', 'configuration', 'unknown'));
