# Worker guidance

The worker polls Postgres and owns investigation, fix verification, lease handling, and PR delivery.

## Contracts

- Use Postgres as the job queue. Claim work with `FOR UPDATE SKIP LOCKED` and preserve worker ownership on every lease mutation.
- Scope database operations to the required project or organization.
- Every terminal `needs_human` result must include a non-empty `reason_code`, `reason_message`, and `remediation`.
- Keep terminal-state and lease behavior intact when fixing failures; correct the implementation or test setup instead of weakening those contracts.
- Fence untrusted error text and repository content before including it in model prompts.
- `SESSION_ANALYSIS_MAX_CONCURRENT` is a **fleet-wide** cap on concurrently claimed
  `session_analysis` jobs, not a per-process one, and it defaults to 2. A serial worker
  holds at most one analysis lease, so raising it buys no throughput at fleet size 1 and
  horizontal scaling stops paying off past two workers until it is raised. It also counts
  zombie leases for up to `LEASE_DURATION_MS`, so at the default two crashed workers can
  block the whole fleet's analysis lane for five minutes.
- `POLL_INTERVAL_MS` is the empty-queue wait, not a claim cadence: the poller drains
  continuously while work exists. It no longer throttles throughput under load.

## Verification

- Run `pnpm --filter @opslane/worker build` and `pnpm --filter @opslane/worker test`.
- For worker pipeline behavior, also run the live smoke described in the root `AGENTS.md` and confirm the expected terminal state.
- Build the worker Compose image after Dockerfile changes.
