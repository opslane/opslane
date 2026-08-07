-- Fix jobs load the persisted decision instead of re-triaging by error shape,
-- and the gate they apply is "code_fix at high confidence". Neither the routing
-- basis nor the confidence was stored, so the row could not answer the question
-- the fix job asks of it.
--
-- Both are nullable: rows written before this migration have no basis and no
-- confidence, and a fix job must read that as "not authorised" rather than
-- inventing one.

ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS basis TEXT;
ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS confidence TEXT
  CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low'));
