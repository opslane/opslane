#!/bin/sh
set -eu

INGESTION_PORT="${INGESTION_PORT:-18082}"
RELIABILITY_DATABASE="opslane_reliability"
LOCAL_RELIABILITY_DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/${RELIABILITY_DATABASE}"
export INGESTION_PORT
export OPSLANE_COMPOSE_DATABASE_URL="postgres://opslane:opslane_dev@postgres:5432/${RELIABILITY_DATABASE}?sslmode=disable"
# The GitHub twin signs pull_request webhooks with this; ingestion must verify
# them, so both sides share the secret (friction-ladder system test).
GITHUB_WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:-reliability-webhook-secret}"
export GITHUB_WEBHOOK_SECRET

docker compose stop ingestion >/dev/null 2>&1 || true
docker compose up -d --wait postgres
docker compose up -d minio minio-setup
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U opslane -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${RELIABILITY_DATABASE}' AND pid <> pg_backend_pid()"
docker compose exec -T postgres dropdb --if-exists -U opslane "${RELIABILITY_DATABASE}"
docker compose exec -T postgres createdb -U opslane "${RELIABILITY_DATABASE}"
docker compose run --rm migrate

# The worker source these suites import resolves @opslane/agent-core and
# @opslane/shared through their package entry points, which name dist. Build
# both first. Missing dist shows up two ways: vitest fails to resolve
# agent-core at runtime, and tsc reports "Cannot find module '@opslane/shared'"
# across every worker file it pulls in. Neither reproduces on a dev machine,
# where dist is left over from an earlier build and gitignored.
pnpm --filter @opslane/shared --filter @opslane/agent-core build

DATABASE_URL="${LOCAL_RELIABILITY_DATABASE_URL}" \
OPSLANE_RELIABILITY_DB_TESTS=1 \
pnpm --filter @opslane/worker exec vitest run \
  --no-file-parallelism \
  --maxWorkers=1 \
  --minWorkers=1 \
  src/__tests__/db.test.ts \
  src/__tests__/poller.integration.test.ts

docker compose up -d --build --wait ingestion

DATABASE_URL="${RELIABILITY_DATABASE_URL:-${LOCAL_RELIABILITY_DATABASE_URL}}" \
INGESTION_URL="${RELIABILITY_INGESTION_URL:-http://localhost:${INGESTION_PORT}}" \
pnpm --filter @opslane/test-reliability test:system
