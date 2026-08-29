-- 065_unified_digest_cards.sql -- additive schema for rollout-safe unified cards.
BEGIN;

ALTER TABLE digest_run_items
  ADD COLUMN IF NOT EXISTS error_group_id UUID REFERENCES error_groups(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_digest_run_items_run_group
  ON digest_run_items (run_id, error_group_id);
-- Friction has no episode. Keep the legacy table's primary key untouched
-- until the production-gated identity hardening migration; old binaries can
-- continue writing episode rows while new binaries use this additive table.
CREATE TABLE IF NOT EXISTS digest_unified_run_items (
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id             UUID NOT NULL REFERENCES digest_runs(id) ON DELETE CASCADE,
  error_group_id     UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  candidate_snapshot JSONB NOT NULL,
  outcome            TEXT CHECK (outcome IS NULL OR outcome IN ('included','deferred')),
  reason             TEXT,
  PRIMARY KEY (run_id,error_group_id)
);

ALTER TABLE digest_runs
  ADD COLUMN IF NOT EXISTS unified_cards_mode TEXT NOT NULL DEFAULT 'off';

CREATE TABLE IF NOT EXISTS digest_card_copy (
  error_group_id    UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  spell_started_at  TIMESTAMPTZ NOT NULL,
  authored_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  input_fingerprint TEXT NOT NULL,
  title             TEXT NOT NULL,
  copy              TEXT NOT NULL,
  action            TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_version    INT NOT NULL,
  invalidated_at    TIMESTAMPTZ,
  PRIMARY KEY (error_group_id, spell_started_at, authored_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_card_copy_current
  ON digest_card_copy (error_group_id, spell_started_at)
  WHERE invalidated_at IS NULL;

ALTER TABLE digest_run_candidate_evaluations
  ADD COLUMN IF NOT EXISTS render_mode TEXT,
  ADD COLUMN IF NOT EXISTS input_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS spell_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN,
  ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'validation';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='drce_render_mode_check') THEN
    ALTER TABLE digest_run_candidate_evaluations ADD CONSTRAINT drce_render_mode_check
      CHECK (render_mode IS NULL OR render_mode IN ('authored','cached','receipt_fallback'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='drce_phase_check') THEN
    ALTER TABLE digest_run_candidate_evaluations ADD CONSTRAINT drce_phase_check
      CHECK (phase IN ('freeze','validation'));
  END IF;
  -- 065 never shipped, so it is edited in place rather than superseded. A
  -- development database that applied the earlier draft already carries the
  -- three-value CHECK and may hold 'shadow' rows: drop that CHECK, normalize
  -- the rows, then add the two-value one. Databases that never saw the draft
  -- skip straight to the ADD, and a replay finds the constraint already
  -- correct and touches nothing (its OID is pinned by test).
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname='digest_runs_unified_mode_check'
                AND pg_get_constraintdef(oid) LIKE '%shadow%') THEN
    ALTER TABLE digest_runs DROP CONSTRAINT digest_runs_unified_mode_check;
  END IF;
  UPDATE digest_runs SET unified_cards_mode='off'
   WHERE unified_cards_mode NOT IN ('off','on');
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='digest_runs_unified_mode_check') THEN
    ALTER TABLE digest_runs ADD CONSTRAINT digest_runs_unified_mode_check
      CHECK (unified_cards_mode IN ('off','on'));
  END IF;
END $$;

COMMIT;
