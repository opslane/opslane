-- Verified gaps from the Slice 6 acceptance run (.verify/runs/20260818-152726):
-- conflicts the model could not reconcile had no representation (AC16), run
-- observability was log-only (AC9), and code-derived requests were dropped.
-- observed_requests stays reserved for Slice 5 session evidence; code-derived
-- capabilities land in declared_requests instead.

ALTER TABLE route_map
  ADD COLUMN IF NOT EXISTS evidence_conflicts TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'clear'
    CHECK (review_status IN ('clear', 'needs_review')),
  ADD COLUMN IF NOT EXISTS declared_requests TEXT[] NOT NULL DEFAULT '{}';

-- One row per completed model pass, written in the same lease-fenced
-- transaction as the claims so a completed run always has its record.
-- unknown = claim with confidence 0; conflict_count counts routes whose
-- evidence_conflicts is non-empty; coverage = (route-unknown)/route.
CREATE TABLE IF NOT EXISTS product_context_runs (
  id             BIGSERIAL PRIMARY KEY,
  job_id         UUID NOT NULL REFERENCES error_group_jobs(id) ON DELETE CASCADE,
  execution      INTEGER NOT NULL CHECK (execution >= 0),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha     TEXT NOT NULL CHECK (commit_sha <> ''),
  model          TEXT NOT NULL CHECK (model <> ''),
  prompt_version INTEGER NOT NULL,
  route_count    INTEGER NOT NULL CHECK (route_count >= 0),
  unknown_count  INTEGER NOT NULL CHECK (unknown_count >= 0 AND unknown_count <= route_count),
  conflict_count INTEGER NOT NULL CHECK (conflict_count >= 0 AND conflict_count <= route_count),
  human_route_count INTEGER NOT NULL CHECK (human_route_count >= 0 AND human_route_count <= route_count),
  coverage       REAL NOT NULL CHECK (coverage >= 0 AND coverage <= 1),
  input_tokens   BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens  BIGINT NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens  BIGINT NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens BIGINT NOT NULL CHECK (cache_write_tokens >= 0),
  cost_usd       NUMERIC(12, 6) NOT NULL CHECK (cost_usd >= 0),
  latency_ms     INTEGER NOT NULL CHECK (latency_ms >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, execution)
);

CREATE INDEX IF NOT EXISTS idx_product_context_runs_project
  ON product_context_runs (project_id, created_at DESC);
