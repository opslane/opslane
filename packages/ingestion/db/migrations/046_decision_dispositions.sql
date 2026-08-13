-- Forensic candidate dispositions and the cause kind that drove routing.
-- Both nullable: every existing row and every legacy-shape decision stays valid.
ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS candidate_dispositions jsonb;
ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS cause_kind text;
