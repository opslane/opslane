# Postgres usage ledger as the queryable record of job spend

The worker computes token usage and cost per phase of every job, but until now
only emitted them as Langfuse span attributes — and Langfuse is optional, so
self-hosted deployments (and any query joining spend to outcomes) had no cost
data at all. We decided to persist spend in Postgres as an insert-only
`job_usage` ledger — one row per (job, execution, phase, model) with token
counts and cost — written best-effort by the worker at phase completion,
never failing the job.

The ledger is authoritative **relative to Langfuse** (which may be absent),
not a reconciled record of provider billing: it is best-effort and can
undercount. Known loss cases: a failed insert is logged and dropped, and a
worker that dies after a paid model response but before phase completion
loses usage that existed only in memory. Acceptable for analytics; both must
be closed (durable writes, provider reconciliation) before anything is
invoiced from this table.

## Field semantics (frozen)

- **Tokens** (`input`, `output`, `cache_read`, `cache_write`) are
  provider-returned counts — the durable truth.
- **`cost_usd`** is a worker-side estimate derived from the static
  `MODEL_PRICING` table at run time (USD, 4 decimal places). Pricing is
  time-sensitive (Sonnet 5's introductory rate runs through 2026-08-31,
  `packages/worker/src/investigate.ts:41`); no per-row unit rates are stored
  because `(tokens, model, created_at)` allows recomputation against any
  pricing history.
- **`model`** is the requested model id.
- **Execution number** is `error_group_jobs.attempts` as returned by
  `claimJob`. Distinct executions always get distinct values because both
  `failJob` and the reaper increment `attempts` before requeue; a lease-lost
  zombie and its replacement therefore write separate rows, and since both
  actually paid the provider, both rows are correct spend. Inner fix/test
  retries within one execution aggregate into their phase row.
- **`phase`** is plain text validated in worker code, not a CHECK
  constraint — new pipeline phases must not require a migration.

## Attribution boundary

`pr_outcomes.fix_job_id` reaches only the fix job; investigation, judge, and
narrative spend live in other jobs with no stored causal link today. So:

- The v1 admin metric is **blended cost per merged PR** — total ledger spend
  over the window divided by merges — which amortizes failed investigations
  and needs-human outcomes and requires no attribution join.
- Fix jobs record a nullable `source_job_id` (the investigate job that
  created them) from day one, because the caller of
  `updateGroupAndCreateFixJob` is that job and the link is unbackfillable.
  Marginal per-PR attribution can be built on it later; grouping by
  `error_group_id` alone is ambiguous after reinvestigation.

## Considered options

- **Langfuse-only (status quo)** — rejected: optional dependency, no SQL join
  to `pr_outcomes`/`diagnosis_decisions`, so "cost per merged PR" was
  unanswerable without manual trace exports.
- **Cost columns on `error_group_jobs`** — rejected: loses the per-phase and
  per-retry breakdown ("where does the money go"), and mixes model tiers when
  the fix loop falls back mid-attempt. sim.ai shipped this shape and
  deprecated it in favor of a ledger:
  <https://github.com/simstudioai/sim/blob/16e0a2b/packages/db/schema.ts#L2956-L2965>
- **Ledger + projected `cost_total` on the job row** — deferred, not
  rejected: add the projection when a list view needs to sort by cost.
- **Durable/retryable ledger writes** — deferred: correct for billing,
  out of scope for the v1 analytics slice; revisit with invoicing.

## Consequences

- The unique key is `(job_id, attempts, phase, model)` and duplicate inserts
  are dropped with `ON CONFLICT DO NOTHING`, so a replayed phase cannot
  double-count within one execution.
- Insert-only is database-enforced with a mutation-rejecting trigger, the
  same pattern as `diagnosis_decisions`
  (`packages/ingestion/db/migrations/034_diagnosis_decisions_immutable.sql`).
- A phase's spend may span multiple rows (model-tier fallback); always SUM,
  never read one row as a phase total.
