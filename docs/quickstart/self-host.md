---
covers:
  - docker-compose.yml
  - packages/ingestion/db/migrations/**
  - scripts/seed-e2e.sql
  - scripts/retire-friction-buckets.sql
  - packages/worker/src/bin/backfill-tickets.ts
  - packages/worker/src/friction/match-job.ts
  - packages/worker/src/friction/confirm-job.ts
  - packages/ingestion/db/project_keys.go
---
# Self-host quickstart

Run Opslane locally with Docker Compose. This is **developer self-hosting**: the default Compose file uses development credentials and is not a production deployment (production operations are tracked separately).

There are two paths, depending on which credentials you have. Both start the same way.

## Prerequisites

- Docker with Compose
- Ports `8082` (API + dashboard), `5434` (Postgres), and `9012` (MinIO) free on your machine

Compose uses `pgvector/pgvector:pg16`. An external PostgreSQL server must make the
`vector` extension available and permit the migration role to create it; migration
074 runs `CREATE EXTENSION IF NOT EXISTS vector`. On Amazon RDS, check the
[extension matrix for your exact engine version](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html)
and enable `vector` with an authorized database role before upgrading. Local
Compose is the verified deployment path here; these instructions do not claim an
RDS deployment test.

No other tools are required for Path 1. Nothing here needs Node, Go, or pnpm; everything runs in containers.

## Start the stack

```bash
git clone https://github.com/opslane/opslane.git
cd opslane
docker compose up -d --wait
curl http://localhost:8082/health
```

`docker compose up -d --wait` starts Postgres, MinIO (replay storage), the Opslane API service (`ingestion`, which also serves the dashboard at <http://localhost:8082>), and the worker, and returns once they report healthy. A one-shot `migrate` service applies all database migrations automatically; you do not run migrations by hand.

If the `curl` returns `{"status":"ok"}`-style output with HTTP 200, the stack is up.

> **Port conflict?** If `docker compose up` reports "port is already allocated", another service holds 8082/5434/9012. `docker ps` will show the holder. Each port has an override, so you can move the whole stack instead of stopping the other service:
>
> ```bash
> INGESTION_PORT=8092 OPSLANE_POSTGRES_HOST_PORT=5444 OPSLANE_MINIO_HOST_PORT=9022 docker compose up -d --wait
> curl http://localhost:8092/health
> ```
>
> Put those in `.env` if you want them to stick: every later `docker compose` command in this directory needs the same values, or the services disagree about where to find each other. The compose command's output is the source of truth; a healthy response on 8082 can come from a different app entirely, so always check `docker compose ps` shows *these* services healthy.

## Upgrading a running stack

For releases after the known-problems cutover, pull the release and rebuild the
services. The one-shot `migrate` service applies schema changes before the new API
and worker start. The first upgrade across migration 074 requires the explicit
order below: schema ordering alone cannot retire work held by old workers.

### Known-problems cutover (migration 074)

Deploy outside the daily summary window. Keep the same Compose project, volumes,
and port settings throughout. These commands use Compose's bundled database;
external-database operators must run the SQL against their configured database.

1. Pull the release and build its `ingestion` and worker images. Start PostgreSQL
   with the pgvector image, apply the additive schema through migration 074, and
   deploy the new `ingestion` service first. Keep new workers stopped at this stage.

   ```bash
   git pull
   docker compose build ingestion worker
   docker compose up -d --wait postgres
   docker compose run --rm migrate
   docker compose up -d --no-deps --wait ingestion
   ```

2. Stop **every old worker**, across all hosts and replicas. For a single Compose
   stack, run `docker compose stop worker`. Confirm no old worker process remains;
   a worker still running a job could otherwise rewrite an archived bucket.

3. Retire old buckets in one transaction:

   ```bash
   docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U opslane -d opslane < scripts/retire-friction-buckets.sql
   ```

   This archives groups with `kind='friction'` and no ticket in `candidate`, `queued`,
   `analyzing`, `awaiting_approval`, `insight`, `needs_human`, or `investigated`,
   preserving their previous status. It fails their pending or claimed
   investigation and fix jobs and invalidates cached digest copy. Existing
   `fixing`, `pr_draft`, and `pr_created` groups remain intact. Delivered digest payloads remain immutable. The script
   is safe to rerun.

4. Start the new workers, then backfill each intended project and environment.
   Replace the two UUID placeholders with stored IDs:

   ```bash
   docker compose up -d --no-deps --wait worker
   docker compose exec -T worker node dist/bin/backfill-tickets.js \
     --project PROJECT_UUID --environment ENVIRONMENT_UUID --since 14d --rate 60
   ```

   The CLI schedules jobs at 60 per minute and exits. Workers process them through
   the ordinary matching pipeline. Reruns skip active jobs and completed finding
   decisions, including findings judged not to be problems. Partial decisions
   resume, and completed empty narratives stay skipped. A host checkout can run
   the same command after a build with `pnpm --filter @opslane/worker backfill:tickets`
   and `DATABASE_URL` set.

5. Let matching and confirmation drain, then check cause investigations before
   the next digest. Use worker health and job logs to distinguish future scheduled
   jobs, retries, and failed work. The next digest includes only tickets with
   qualifying confirmed evidence and a completed cause investigation.

`FRICTION_MATCH_MAX_CONCURRENT=2` and `FRICTION_CONFIRM_MAX_CONCURRENT=1` are the
fleet-wide defaults. Confirmation permits 2000 recording checks per project per
UTC day by default. A backfill can consume model tokens and that daily budget;
`--rate` controls scheduled arrivals, not model spend or a global throughput limit.

**Fix forward:** after new workers have written atomic findings, API
rollback below migration 074 is unsupported: replaying migration 068 against those
`friction_signals` rows fails. Set `FRICTION_MATCH_MAX_CONCURRENT=0` and
`FRICTION_CONFIRM_MAX_CONCURRENT=0` on every worker and recreate the workers to
pause matching, confirmation, reconciliation, and new publication while preserving
data. These caps do not undo work already committed or stop unrelated job types.
Resume by restoring the caps after deploying the correction.

The daily summary is the one surface a mid-flight upgrade can visibly change. A run picks its issues, writes the summary, and checks it a few minutes later. That is normally a ten-minute window around 09:00 in the project's own timezone, and longer on a day a run is retrying. An upgrade landing inside that window can leave a run whose text was written by one version and checked by another. Any item that fails the check falls back to its plain mechanical lines for that day, so the reader sees the same issues described more tersely rather than losing them, and the next morning's run writes them normally again. Deploy outside a project's summary window if you would rather not spend that day.

## Path 1: capture and group an error, no credentials

**What this proves:** your app can send an error and Opslane captures and groups it, without any AI or GitHub account.

Seed a test project and its ingest key, then send a fake error:

```bash
docker compose exec -T postgres psql -U opslane -d opslane < scripts/seed-e2e.sql

curl -X POST http://localhost:8082/api/v1/events \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq' \
  -d '{"timestamp":"2026-01-01T00:00:00Z","error":{"type":"ReferenceError","message":"demo is not defined","stack":"ReferenceError: demo is not defined\n  at app.js:1:1"},"breadcrumbs":[],"context":{"url":"https://example.com","user_agent":"smoke test"},"sdk_version":"0.0.1","platform":"javascript"}'
```

The `opslane_pk_...` value is the seed script's test ingest key, quoted at the top of `scripts/seed-e2e.sql`; real deployments create their own. You should get HTTP `202` back. Give it a few seconds to show up as an issue, then check it:

```bash
docker compose exec -T postgres psql -U opslane -d opslane \
  -c "SELECT status, reason_code, reason_message FROM error_groups ORDER BY created_at DESC LIMIT 1;"
```

Expected result:

```text
 status | reason_code | reason_message
--------+-------------+----------------
 new    |             |
```

The event was captured and grouped into a `new` issue. Opslane doesn't investigate a one-off that hasn't reached enough users, and without AI credentials it couldn't investigate anyway. That takes Path 2.

Once an error reaches enough users, Opslane reads your repository and decides whether to investigate it. An investigation ends one of three ways: a pull request with a fix, a note that the cause is outside your code, or a stop with a reason for you to take over.

This quickstart uses two kinds of keys. The seeded `opslane_pk_` **ingest key** can only send events and recordings, and is safe to ship in a browser bundle. Uploading source maps takes a separate `opslane_sk_` **source-map key**, created with the key-creation command (`mint-key`); see the [source maps guide](../guides/source-maps.md).

## Path 2: full error-to-PR

**What this proves:** the complete loop: error in, investigated, fix written, evidence collected in a sandbox, pull request out, labeled ready or draft to match its evidence.

Requires all of the following set in your environment **before** `docker compose up`:

| Variable | What it's for | Where to get it |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | AI investigation and fix generation | [console.anthropic.com](https://console.anthropic.com) |
| `E2B_API_KEY` | Sandbox where fixes are built and verification evidence is collected before delivery | [e2b.dev](https://e2b.dev) |
| `GITHUB_TOKEN` | Cloning the repo, opening the PR, and reading its CI result | GitHub Settings > Developer settings > fine-grained PAT with repository contents and pull requests write access, plus checks and commit statuses read access |
| `OPSLANE_E2B_JAVASCRIPT_TEMPLATE` | The sandbox image every JavaScript job boots from. Without it, every job fails at startup. | Build it once with `packages/worker/e2b-javascript/build.ts`; see that directory's README |

You also need a **target repository the worker may open PRs against**. Use a fork of a small fixture app (e.g. this repo's `test-fixtures/vue-app` pushed to a scratch repo), never a production repo you aren't ready to receive AI PRs on. Point your project's `github_repo` at it (via the dashboard, or by editing the seeded project row).

```bash
# export the four variables above in your shell, then:
docker compose up -d --wait
```

Opslane only investigates an issue once it has reached enough real users recently, so drive the error from several distinct sessions with current timestamps, not a single one-off. Send errors that originate from code in that repository (install [`@opslane/sdk`](../../packages/sdk/README.md) in the fixture app, or resend a stack trace that matches its files). Watch the job:

```bash
docker compose logs -f worker
```

A verified automatic run opens a draft pull request containing the fix and its evidence. Automatic pull requests stay draft even when repository CI passes. A fix that a person starts can open ready for review after it reproduces the problem and verifies the change. Projects may also opt in to draft delivery for a more limited, independently reviewed fix when the available checks show no regression. Runs that cannot safely progress stop with a reason. The worker never opens a ready-for-review pull request without executed verification evidence.

The same contract is exercised by `test-e2e/error-to-pr.test.ts`, which skips itself unless `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` are present.

## The 15-minute definition

When we say this quickstart takes under fifteen minutes, the timer is defined as:

- **Start:** the `git clone` command begins, on a machine with Docker installed and images *not* pre-pulled, on a residential-class connection.
- **End (Path 1):** the `SELECT` above shows a `new` row (the event captured and grouped).
- Prerequisites (installing Docker, creating accounts for Path 2 credentials) are outside the timer.

## Cleanup

```bash
docker compose down        # stop the stack, keep data
docker compose down -v     # stop and delete all local data (destructive)
```

## Troubleshooting

- **Event returns 401:** the `X-API-Key` value doesn't match a key in the database. Copy the full `opslane_pk_...` value exactly as it appears above (or in `scripts/seed-e2e.sql`); a truncated or edited key can't parse. If the seed never ran, run it now; running it twice is safe.
- **Event returns 403 `insufficient_scope`:** the key is real but has the wrong scope, usually an `opslane_sk_` source-map key pasted where the ingest key belongs. Send events with the `opslane_pk_` key.
- **Job stays pending:** check `docker compose ps`: the worker container must be up and healthy. `docker compose logs worker` shows job-start and completion lines. Container health only proves the process answers, so if it is green and the job still sits there, ask the worker directly with `docker compose exec worker node -e "fetch('http://localhost:8081/health').then(r=>r.text()).then(console.log)"`. A `stalled` status means work is eligible and no worker is starting it; `queue_depth` separates jobs that are eligible now from ones held back by retry backoff.
- **`minio-setup exited (1)` and `ingestion` never starts:** the stack stops on purpose instead of hanging. Read the `minio-setup:` lines above the exit; they name the check and the fix. The usual cause is another Compose stack holding port 9012 (check `docker ps --filter publish=9012`), in which case set `OPSLANE_MINIO_HOST_PORT` to a free port and re-run. Otherwise `docker compose logs minio` has the real error.
- **Dashboard shows a login page you can't get past:** dashboard sign-in uses GitHub OAuth and needs a GitHub App configured (`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`) plus `DASHBOARD_ORIGIN=http://localhost:8082`, all set before `docker compose up`. Without `DASHBOARD_ORIGIN`, a successful GitHub sign-in redirects to port 3000, where nothing is listening in this setup. Path 1 doesn't require the dashboard.
