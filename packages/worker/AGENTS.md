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

### In-process known-problems smoke

Build the workspace with `pnpm -r build`, apply migrations, and keep Postgres and
MinIO running. Export the complete `DATABASE_URL`, MinIO, and replay-store variable
block from the [root guidance](../../AGENTS.md#verification), including storage
credentials and URLs for the selected ports. The smoke also requires Go for its
production ingestion helpers.

Stop the worker before this test and leave it stopped throughout: the test calls
compiled production handlers in process with a fake model, and another worker
could claim its jobs. From the repository root:

```bash
docker compose stop worker
E2E_IN_PROCESS_WORKER=1 pnpm --filter @opslane/test-e2e exec vitest run friction-incidents.test.ts
```

Require zero skipped tests. Run the normal e2e phase with the worker running only
after this phase finishes, excluding `friction-incidents.test.ts` from that phase.

## Known-problems operations

- `FRICTION_MATCH_MODEL` defaults to `claude-haiku-4-5-20251001`;
  `FRICTION_FIRST_LOOK_MODEL` and `FRICTION_CONFIRM_MODEL` default to `claude-sonnet-5`.
  These clients use `NARRATIVE_API_KEY` / `NARRATIVE_BASE_URL`, falling back to
  `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`.
- `OPENAI_API_KEY` enables `text-embedding-3-small` retrieval (1536 dimensions).
  Missing or unavailable embeddings fall back to screen-based retrieval.
  PostgreSQL still requires the `vector` extension for migration 078.
- `FRICTION_MATCH_MAX_CONCURRENT` defaults to 2; `FRICTION_CONFIRM_MAX_CONCURRENT`
  defaults to 1. Both are fleet-wide claim caps. Set both to 0 on every worker
  to pause matching, confirmation, reconciliation, and new publication.
  `FRICTION_CONFIRM_DAILY_CAP` defaults to 2000 recording checks per project per UTC day.
- `FRICTION_CONFIRM_DAILY_CAP` reserves one project/UTC-day unit per unstaged recording check in PostgreSQL; do not reuse narrative session budget stamps. A resumed batch skips staged recordings. `FRICTION_CONFIRM_MAX_CONCURRENT=0` pauses confirmation and reconciliation.
- `FRICTION_MAX_OPEN_FIX_PRS` defaults to 5 per project. Automatic delivery reserves its slot under the project lock; manual requests are exempt. Ticket fixes and PR callbacks must match the live generation and attempt.
- Run `pnpm --filter @opslane/worker backfill:tickets --project UUID --environment UUID
  --since 14d --rate 60` after building. It schedules `friction_match` jobs through
  `available_at` and exits; it never sleeps to pace work. Matching materializes
  old narratives as atomic observations. Derive identity from stored
  `created_at::text` and `prompt_version`, preserving PostgreSQL microseconds.
  Completed decisions include `not_a_problem`; empty narratives use the exact
  `friction_session_processed` marker. Partial ledgers remain eligible.
- Follow the [migration 078 cutover](../../docs/quickstart/self-host.md#known-problems-cutover-migration-078).
  Stop every old worker before retiring buckets. Once new workers have written
  atomic signals, ingestion rollback below 078 is unsupported; fix forward with
  the two claim caps at 0. Preserve job spend under ADR-0001 throughout cutover.
