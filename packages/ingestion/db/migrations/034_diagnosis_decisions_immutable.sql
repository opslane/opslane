-- A diagnosis decision records what was decided and why, at a moment. It was
-- documented as immutable with nothing enforcing it, so an UPDATE could
-- silently rewrite the justification for a fix that had already shipped.

CREATE OR REPLACE FUNCTION reject_diagnosis_decision_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'diagnosis_decisions is insert-only: % rejected', TG_OP
    USING ERRCODE = '2F004';
END;
$$ LANGUAGE plpgsql;

-- One transaction per swap. run-migrations.sh invokes `psql -f`, which
-- autocommits each statement, and the compose migrate service re-runs every
-- file on every boot — so a bare DROP-then-CREATE left a window on each boot
-- where the table this migration exists to protect was fully mutable.
BEGIN;
DROP TRIGGER IF EXISTS diagnosis_decisions_immutable_row ON diagnosis_decisions;
CREATE TRIGGER diagnosis_decisions_immutable_row
  BEFORE UPDATE OR DELETE ON diagnosis_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_diagnosis_decision_mutation();
COMMIT;

-- TRUNCATE does not fire row-level triggers, so it needs a statement trigger.
BEGIN;
DROP TRIGGER IF EXISTS diagnosis_decisions_immutable_truncate ON diagnosis_decisions;
CREATE TRIGGER diagnosis_decisions_immutable_truncate
  BEFORE TRUNCATE ON diagnosis_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_diagnosis_decision_mutation();
COMMIT;
