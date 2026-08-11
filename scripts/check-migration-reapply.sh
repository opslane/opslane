#!/bin/sh
# Migration reapply-with-data check.
#
# The migration runner (scripts/run-migrations.sh) has no ledger: it replays
# EVERY migration on EVERY boot. So a migration that unconditionally re-asserts
# a CHECK/constraint can silently conflict with a LATER migration that widened
# it, once real rows use the wider values. CI applying migrations once to a
# fresh, empty database never exercises this — the bug only appears on the
# second boot of a database that already holds data.
#
# This check encodes AGENTS.md's "reapply to a representative existing database"
# rule: apply migrations, seed a row at every boundary value a later migration
# introduced, then replay all migrations and require success.
#
# Extend SEED_SQL whenever a migration widens a constraint/enum to cover new
# values that real rows will hold.
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"
MIGRATION_DIR="${MIGRATION_DIR:-packages/ingestion/db/migrations}"
RUNNER="$(dirname "$0")/run-migrations.sh"

cleanup_seed() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DELETE FROM agent_sessions WHERE repo_url = 'reapply-check/repo';
-- diagnosis_decisions is insert-only (migration 034); toggle the guard trigger
-- around the seed-row delete, as the e2e teardown does.
ALTER TABLE diagnosis_decisions DISABLE TRIGGER diagnosis_decisions_immutable_row;
DELETE FROM diagnosis_decisions WHERE model = 'reapply-check';
ALTER TABLE diagnosis_decisions ENABLE TRIGGER diagnosis_decisions_immutable_row;
DELETE FROM error_group_jobs
  WHERE project_id IN (SELECT id FROM projects WHERE name = 'reapply-check-project');
DELETE FROM error_groups
  WHERE project_id IN (SELECT id FROM projects WHERE name = 'reapply-check-project');
DELETE FROM projects WHERE name = 'reapply-check-project';
DELETE FROM orgs WHERE name = 'reapply-check-org';
SQL
}

echo "[reapply-check] first application (fresh DB path)"
MIGRATION_DIR="$MIGRATION_DIR" "$RUNNER" >/dev/null

# Seed one agent_sessions row per lifecycle status, including the values added
# by migration 021 (provisioned / key_ok / app_reporting). If any of these rows
# would violate a constraint re-added by an earlier migration on replay, the
# replay below fails — which is exactly what we want to catch in CI.
#
# Also seed the boundary values migration 044 widened into two CHECK
# constraints: diagnosis_decisions.outcome = 'incomplete' and
# error_group_jobs.triggered_by = 'reinvestigate_report_only'.
echo "[reapply-check] seeding representative rows at every lifecycle status"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO agent_sessions (id, repo_url, status, poll_token_hash, expires_at)
SELECT gen_random_uuid(), 'reapply-check/repo', s, 'reapply-check-hash', now() + interval '1 hour'
FROM unnest(ARRAY['pending','completed','expired','failed',
                  'provisioned','key_ok','app_reporting']) AS s;

WITH org AS (
  INSERT INTO orgs (name) VALUES ('reapply-check-org') RETURNING id
), project AS (
  INSERT INTO projects (org_id, name, github_repo)
  SELECT id, 'reapply-check-project', 'reapply-check/repo' FROM org RETURNING id
), grp AS (
  INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen)
  SELECT id, 'reapply-check-group', 'Reapply check group', now(), now() FROM project
  RETURNING id, project_id
), job AS (
  INSERT INTO error_group_jobs (error_group_id, project_id, triggered_by)
  SELECT id, project_id, 'reinvestigate_report_only' FROM grp RETURNING id
)
INSERT INTO diagnosis_decisions
  (error_group_id, project_id, outcome, decision_reason, model, prompt_version)
SELECT id, project_id, 'incomplete', 'reapply-check seed', 'reapply-check', 'c0'
FROM grp;
SQL

echo "[reapply-check] replaying ALL migrations on the seeded database"
if ! MIGRATION_DIR="$MIGRATION_DIR" "$RUNNER" >/dev/null 2>/tmp/reapply-err.log; then
  echo "[reapply-check] FAIL — replaying migrations broke on a database with data:"
  sed 's/^/    /' /tmp/reapply-err.log
  echo "[reapply-check] A migration is re-asserting a constraint a later migration widened."
  cleanup_seed >/dev/null 2>&1 || true
  exit 1
fi

echo "[reapply-check] cleaning up seeded rows"
cleanup_seed

echo "[reapply-check] PASS — migrations replay cleanly with data present"
