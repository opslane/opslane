# Worker guidance

The worker polls Postgres and owns investigation, fix verification, lease handling, and PR delivery.

## Contracts

- Use Postgres as the job queue. Claim work with `FOR UPDATE SKIP LOCKED` and preserve worker ownership on every lease mutation.
- Scope database operations to the required project or organization.
- Every terminal `needs_human` result must include a non-empty `reason_code`, `reason_message`, and `remediation`.
- Keep terminal-state and lease behavior intact when fixing failures; correct the implementation or test setup instead of weakening those contracts.
- Fence untrusted error text and repository content before including it in model prompts.
- `SESSION_ANALYSIS_MAX_CONCURRENT` is a **fleet-wide** cap on concurrently claimed
  `session_analysis` jobs, not a per-process one, and it defaults to 2. A worker
  process runs `WORKER_CONCURRENCY` claim loops (default 1, max 16); the ceiling on
  simultaneously running analysis jobs is
  `min(SESSION_ANALYSIS_MAX_CONCURRENT, replicas × WORKER_CONCURRENCY)`, and every
  job type shares the loops. It also counts zombie leases for up to
  `LEASE_DURATION_MS`, so at the default two crashed workers can block the whole
  fleet's analysis lane for five minutes.
- Product-context discovery's "routes observed in sessions" input and the
  unknown-route sweeper both read `error_groups.page_url_normalized`, which is
  fed by the settlement chain (capture → identity settlement → priority
  sweeper URL stamping), not by ingest directly. Do not bridge them from raw
  `error_events`; that would create a second URL-normalization contract.
- `POLL_INTERVAL_MS` is the empty-queue wait, not a claim cadence: the poller drains
  continuously while work exists. It no longer throttles throughput under load.
- Retry spacing lives in `available_at`, not in the poll tick. `failJob` and the reaper
  both push a failed job out by capped exponential backoff with jitter
  (`RETRY_BACKOFF_BASE_SECONDS`, `RETRY_BACKOFF_CAP_SECONDS` in `src/db.ts`). A job that
  is `pending` is not necessarily claimable; claim queries must keep honoring
  `available_at` or a poison job spins at drain speed.
- `/health` is a queue-shape report, not just liveness. `status` is `ok`, `stalled`
  (eligible work, zero claims in the last minute, and nothing in flight — all three), or
  `unknown` (no successful queue sample yet, or the newest one is older than two sample
  intervals). A failed sample must degrade to `unknown`, never to `ok`: the sample and the
  claim fail from the same cause, so treating a missing sample as an empty queue would
  report health during the exact outage the field exists to surface. Keep the payload
  snake_case; `QueueDepthRow` stays camelCase as the internal type.

## Verification

- Run `pnpm --filter @opslane/worker build` and `pnpm --filter @opslane/worker test`.
- For worker pipeline behavior, also run the live smoke described in the root `AGENTS.md` and confirm the expected terminal state.
- Build the worker Compose image after Dockerfile changes.
