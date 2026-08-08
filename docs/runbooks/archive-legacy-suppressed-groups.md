# Archive legacy suppressed-class error groups

Ingestion drops three known-noise JavaScript classes before fingerprinting or
persistence: `resize_observer`, `script_error`, and `extension_only`. The
authoritative rule list and matching behavior live in
`packages/ingestion/grouping/suppress.go`. Groups created before those rules
shipped can remain open and distort priority rankings even though they no longer
receive occurrences.

This is a retained-data operation. Discover candidates with read-only SQL,
review every row, and archive through the incident API. Never update production
`error_groups` directly.

## Prerequisite: prove archived groups stay closed

Run this check against a disposable database with the current ingestion build
before scheduling production cleanup. The relevant safeguards are independent:
suppression must stop known noise before grouping, and recurrence handling in
`packages/ingestion/db/queries.go` must not requeue an archived group.

1. Apply migrations and `scripts/seed-e2e.sql`, start ingestion, and export the
   disposable stack's `INGESTION_URL` and `DATABASE_URL`. Use the raw public key
   documented at the top of `scripts/seed-e2e.sql` as `INGEST_KEY`.
2. Sign in as the seeded `admin@e2e.test` user and retain the dashboard cookies:

   ```bash
   curl --fail-with-body -sS -c /tmp/opslane-archive-check-cookies \
     -X POST "$INGESTION_URL/auth/password" \
     -H 'Content-Type: application/json' \
     -d '{"email":"admin@e2e.test","password":"testpassword123"}'

   PROJECT_ID=00000000-0000-0000-0000-000000000010
   ```

3. Exercise the archived-group recurrence guard with an ordinary event. Send
   the same payload before and after archiving, and preserve the first group ID:

   ```bash
   EVENT_BODY='{"platform":"javascript","error":{"type":"TypeError","message":"archive recurrence check","stack":"TypeError: archive recurrence check\n  at check (https://app.example.test/check.js:1:1)"},"context":{}}'
   GROUP_ID=$(curl --fail-with-body -sS -X POST "$INGESTION_URL/api/v1/events" \
     -H "X-API-Key: $INGEST_KEY" -H 'Content-Type: application/json' \
     -d "$EVENT_BODY" | jq -r .group_id)

   curl --fail-with-body -sS -b /tmp/opslane-archive-check-cookies \
     -X POST "$INGESTION_URL/api/v1/projects/$PROJECT_ID/incidents/$GROUP_ID/archive" \
     | jq '{id, status, archived_at}'

   JOBS_BEFORE=$(psql "$DATABASE_URL" -X -tA -v ON_ERROR_STOP=1 \
     -v group_id="$GROUP_ID" -c \
     "SELECT count(*) FROM error_group_jobs WHERE error_group_id = :'group_id';")

   curl --fail-with-body -sS -X POST "$INGESTION_URL/api/v1/events" \
     -H "X-API-Key: $INGEST_KEY" -H 'Content-Type: application/json' \
     -d "$EVENT_BODY" | jq '{group_id, suppressed}'

   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v group_id="$GROUP_ID" \
     -v jobs_before="$JOBS_BEFORE" <<'SQL'
SELECT id, status, archived_at
FROM error_groups
WHERE id = :'group_id';

SELECT count(*) AS jobs_after, :'jobs_before' AS jobs_before
FROM error_group_jobs
WHERE error_group_id = :'group_id';
SQL
   ```

   The second ingest must return the same `group_id`; the database row must
   remain `archived`; and no new open group or new job may appear for it.

4. Exercise all three suppression paths. Record the project event/group counts,
   send each payload, then confirm every response has `suppressed: true`, empty
   event/group IDs, and unchanged counts:

   ```bash
   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v project_id="$PROJECT_ID" -c \
     "SELECT (SELECT count(*) FROM error_events WHERE project_id = :'project_id') AS events,
             (SELECT count(*) FROM error_groups WHERE project_id = :'project_id') AS groups,
             (SELECT count(*) FROM error_group_jobs WHERE project_id = :'project_id') AS jobs;"

   for body in \
     '{"platform":"javascript","error":{"type":"Error","message":"ResizeObserver loop limit exceeded","stack":""},"context":{}}' \
     '{"platform":"javascript","error":{"type":"Error","message":"Script error.","stack":""},"context":{}}' \
     '{"platform":"javascript","error":{"type":"Error","message":"extension check","stack":"Error: extension check\n  at run (chrome-extension://abcdef/content.js:10:5)"},"context":{}}'
   do
     curl --fail-with-body -sS -X POST "$INGESTION_URL/api/v1/events" \
       -H "X-API-Key: $INGEST_KEY" -H 'Content-Type: application/json' \
       -d "$body" | jq '{event_id, group_id, suppressed}'
   done

   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v project_id="$PROJECT_ID" -c \
     "SELECT (SELECT count(*) FROM error_events WHERE project_id = :'project_id') AS events,
             (SELECT count(*) FROM error_groups WHERE project_id = :'project_id') AS groups,
             (SELECT count(*) FROM error_group_jobs WHERE project_id = :'project_id') AS jobs;"
   ```

Record the date, deployed revision, disposable database, operator, and results
in the production change ticket. Do not continue if either check fails.

## 1. Dry run candidates

Use an operator-approved read-only database credential. This repository does
not provide a production SQL wrapper; `scripts/run-migrations.sh` is a write
path and is not appropriate here. The explicit read-only transaction below
protects against accidental writes even if the credential is over-privileged.

Set `OPSLANE_READ_ONLY_DATABASE_URL` through the deployment's secret mechanism
and set `PROJECT_ID` to one reviewed project. Each query returns only open error
groups because resolved, merged, and archived groups do not participate in
priority ranking.

### ResizeObserver loop

This mirrors the JavaScript platform check and the
`strings.HasPrefix(strings.TrimSpace(message), "ResizeObserver loop")` rule.

```bash
psql "$OPSLANE_READ_ONLY_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v project_id="$PROJECT_ID" <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT eg.id, eg.title, eg.status, eg.occurrence_count,
       eg.affected_users_count, eg.last_seen
FROM error_groups eg
WHERE eg.project_id = :'project_id'
  AND eg.kind = 'error'
  AND eg.status NOT IN ('resolved', 'merged', 'archived')
  AND EXISTS (
    SELECT 1
    FROM error_events ee
    WHERE ee.project_id = eg.project_id
      AND ee.error_group_id = eg.id
      AND ee.platform = 'javascript'
      AND btrim(ee.error_message) LIKE 'ResizeObserver loop%'
  )
ORDER BY eg.affected_users_count DESC, eg.occurrence_count DESC, eg.id;
COMMIT;
SQL
```

### Stackless `Script error.`

This mirrors the case-insensitive message match and empty-after-trimming stack
requirement.

```bash
psql "$OPSLANE_READ_ONLY_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v project_id="$PROJECT_ID" <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT eg.id, eg.title, eg.status, eg.occurrence_count,
       eg.affected_users_count, eg.last_seen
FROM error_groups eg
WHERE eg.project_id = :'project_id'
  AND eg.kind = 'error'
  AND eg.status NOT IN ('resolved', 'merged', 'archived')
  AND EXISTS (
    SELECT 1
    FROM error_events ee
    WHERE ee.project_id = eg.project_id
      AND ee.error_group_id = eg.id
      AND ee.platform = 'javascript'
      AND lower(btrim(ee.error_message)) = 'script error.'
      AND btrim(ee.stack_trace_raw) = ''
  )
ORDER BY eg.affected_users_count DESC, eg.occurrence_count DESC, eg.id;
COMMIT;
SQL
```

### Extension-only stacks

The extension rule accepts only parsed frames whose schemes are
`chrome-extension`, `moz-extension`, `safari-extension`, or
`safari-web-extension`. It rejects a stack with a normal web frame or an
unparsed non-header line. The query below applies that line-level contract and
excludes ResizeObserver messages because that earlier rule wins.

```bash
psql "$OPSLANE_READ_ONLY_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v project_id="$PROJECT_ID" <<'SQL'
BEGIN TRANSACTION READ ONLY;
WITH nonblank_lines AS (
  SELECT ee.id AS event_id, ee.error_group_id, line.ordinality AS line_number,
         btrim(line.value) AS line
  FROM error_events ee
  CROSS JOIN LATERAL regexp_split_to_table(ee.stack_trace_raw, E'\\n')
    WITH ORDINALITY AS line(value, ordinality)
  WHERE ee.project_id = :'project_id'
    AND ee.platform = 'javascript'
    AND btrim(ee.error_message) NOT LIKE 'ResizeObserver loop%'
    AND (
      ee.stack_trace_raw ILIKE '%chrome-extension://%'
      OR ee.stack_trace_raw ILIKE '%moz-extension://%'
      OR ee.stack_trace_raw ILIKE '%safari-extension://%'
      OR ee.stack_trace_raw ILIKE '%safari-web-extension://%'
    )
    AND btrim(line.value) <> ''
), classified AS (
  SELECT *, min(line_number) OVER (PARTITION BY event_id) AS first_line,
         regexp_match(
           line,
           '([a-zA-Z][a-zA-Z0-9+.-]*)://[^[:space:]()]+:[0-9]+:[0-9]+'
         ) AS frame
  FROM nonblank_lines
), extension_events AS (
  SELECT event_id, error_group_id
  FROM classified
  GROUP BY event_id, error_group_id
  HAVING count(*) FILTER (WHERE frame IS NOT NULL) > 0
     AND bool_and(
       (frame IS NOT NULL AND lower(frame[1]) IN (
         'chrome-extension', 'moz-extension',
         'safari-extension', 'safari-web-extension'
       ))
       OR (line_number = first_line AND line ~ '^[A-Za-z][A-Za-z0-9_$]*: ')
     )
)
SELECT DISTINCT eg.id, eg.title, eg.status, eg.occurrence_count,
       eg.affected_users_count, eg.last_seen
FROM error_groups eg
JOIN extension_events candidate ON candidate.error_group_id = eg.id
WHERE eg.project_id = :'project_id'
  AND eg.kind = 'error'
  AND eg.status NOT IN ('resolved', 'merged', 'archived')
ORDER BY eg.affected_users_count DESC, eg.occurrence_count DESC, eg.id;
COMMIT;
SQL
```

Compare the three result sets with the current `SuppressRules` slice before
every run. If a rule exists in code without a query here, stop and update the
runbook. Save the query output in the change ticket and have a second person
review each ID. Remove false positives; do not expand the cleanup to adjacent
noise classes.

## 2. Archive reviewed incidents

The mutation endpoint is
`POST /api/v1/projects/{projectID}/incidents/{incidentID}/archive`, registered in
`packages/ingestion/handler/routes.go`. It requires dashboard/CLI session auth;
an SDK ingest key is rejected. The handler is project-scoped and idempotent.

Archive one reviewed ID at a time so the response can be checked and recorded.
Use the standard authenticated dashboard cookie jar, or replace `-b` with an
approved `Authorization: Bearer ...` CLI session token:

```bash
INCIDENT_ID='<reviewed-incident-uuid>'
curl --fail-with-body -sS -b /path/to/opslane-session-cookies \
  -X POST \
  "$INGESTION_URL/api/v1/projects/$PROJECT_ID/incidents/$INCIDENT_ID/archive" \
  | jq '{id, title, status, archived_at}'
```

Require `status: "archived"`, the expected ID/title, and a non-null
`archived_at` before moving to the next reviewed ID. Keep the reviewed ID file,
API responses, operator, and timestamp with the change record.

## 3. Verify

1. Re-run all three dry-run queries. Every reviewed ID must be absent. Investigate
   any unreviewed candidate; do not archive it automatically.
2. Confirm each reviewed ID is archived in the API's explicit archived view:

   ```bash
   curl --fail-with-body -sS -b /path/to/opslane-session-cookies \
     "$INGESTION_URL/api/v1/projects/$PROJECT_ID/incidents?status=archived" \
     | jq --arg id "$INCIDENT_ID" '.[] | select(.id == $id) | {id, status, archived_at}'
   ```

   This list is capped at 100 rows, so use the tenant-scoped read-only SQL check
   for a cleanup larger than that.
3. Fetch the default incident list and confirm none of the reviewed IDs appears.
   Confirm dashboard/account incident counts fell by the reviewed number where
   applicable.
4. Watch `opslane_suppressed_events_total{rule=...}` for all three rule names.
   New matching events should increase those counters, not recreate an open
   incident.

If a reviewed ID was archived in error, use the existing tenant-scoped
`POST /api/v1/projects/{projectID}/incidents/{incidentID}/unarchive` endpoint.
Do not repair it with SQL.
