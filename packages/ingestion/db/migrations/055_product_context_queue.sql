-- Immutable push receipts make GitHub redelivery idempotent even when a newer
-- push has replaced the payload of the active product-context job.
CREATE TABLE IF NOT EXISTS product_context_push_receipts (
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, delivery_id)
);

-- A newer deploy supersedes queued or running repository understanding. The
-- enqueue query returns the existing row to pending and lease fencing prevents
-- the superseded worker from publishing stale claims.
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_context_job_active
  ON error_group_jobs (project_id, job_type)
  WHERE job_type = 'product_context' AND status IN ('pending','claimed');
