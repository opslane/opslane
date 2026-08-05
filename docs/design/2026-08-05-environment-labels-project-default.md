# Environment labels with a project default

Issue: [#237](https://github.com/opslane/opslane-oss/issues/237)
Status: approved design, revision 2; implementation pending
Date: 2026-08-05
Dependency: [#240](https://github.com/opslane/opslane-oss/issues/240) lands first

## In one paragraph

Environment is a customer-controlled SDK label, not an admin-managed allowlist and
not a property of an ingest key. Every project begins with a `production` environment
that is also its default. The first accepted error event or registered session carrying
another valid label creates that environment in the same database transaction as the
telemetry and assigns the telemetry to it. Missing or invalid labels use the current
project default; invalid raw values are not persisted. Admins may change the default
among existing environments, prospectively. Manual environment creation is removed,
and each dashboard filter lists only environments observed on that surface.

This design **supersedes** #237's original non-goal that unknown labels must not create
environment rows. It follows the closest product precedent: Sentry and BugSnag treat
bounded SDK values as environment identity without admin pre-creation. The primary-source
comparison is recorded in
[environment-models.md](../research/2026-08-04-environment-models.md).

## Problem

Project-scoped ingest keys no longer identify an environment. The current middleware
still resolves every key to the row named `production`, after which a payload label may
replace it only when an admin already created an exact matching row. This produces four
problems:

1. Customers control SDK configuration but must duplicate it in Opslane first.
2. An explicit unknown or invalid label is silently attributed to `production`.
3. Manual rows may make a dashboard filter look useful even when that surface has no data.
4. There is no project default that an admin can inspect or change.

The result can be misleading: telemetry submitted as staging may appear under production,
while an empty staging filter looks healthy.

## Goals

- Make every syntactically valid SDK label authoritative without admin pre-creation.
- Give every project a visible, changeable default environment.
- Never drop otherwise valid telemetry because its environment label is absent or invalid.
- Create an environment only when the telemetry that discovered it commits.
- Keep environment behavior consistent for errors and session initialization.
- Preserve cross-environment error grouping and existing-session authority.
- Show an environment filter only when that surface has at least two observed environments.
- Keep the first version small: no lifecycle or rejection-management subsystem.

## Non-goals

- A project-level environment-count cap.
- Storing or displaying invalid submitted labels.
- Archiving, hiding, deleting, merging, or recycling environment rows.
- Manual environment creation through the dashboard or HTTP API.
- Renaming environments.
- Reclassifying historical events or sessions after a default change.
- Splitting one error group into one group per environment.
- Changing the browser SDK wire shape.
- Reintroducing environment-bound ingest keys.

If cardinality becomes a demonstrated problem, active-environment limits or lifecycle
controls are separate work based on measured usage. They are not prebuilt here.

## Domain language

| Term | Meaning |
| --- | --- |
| Environment label | Exact, case-sensitive string supplied by an SDK |
| Environment | Durable project-owned identity selected by events, sessions, rollups, and filters |
| Default environment | Existing project row used when a label is absent or invalid |
| Discovered environment | Environment row created by the first telemetry that commits with its valid label |
| Surface-observed environment | Environment referenced by at least one incident or session, depending on the requested surface |

"Environment override", "key environment", and "approved environment" are obsolete
terms after #240. A project key identifies a project and scope only.

## Requirements

| ID | Requirement | Verified by |
| --- | --- | --- |
| R1 | Every project has a default environment an admin can see and change | Migration, provisioning, project PATCH, and Settings tests |
| R2 | A valid label selects an exact existing row or creates one | Event and session database integration tests |
| R3 | Discovery and telemetry persistence commit or roll back together | Forced-failure transaction tests for event and session paths |
| R4 | Missing and invalid labels use the current default | Event and session tests before and after a default change |
| R5 | Invalid labels do not drop telemetry and are not stored | Success-response, attribution, and raw-value absence assertions |
| R6 | A default change affects future unlabeled telemetry only | Historical-row and existing-session assertions |
| R7 | An existing same-project session wins before event-label discovery | Session-authority and unused-row assertions |
| R8 | Filters contain only environments observed on their requested surface | Database, endpoint, dashboard, and E2E tests |
| R9 | A filter is hidden until its surface has at least two observed environments | Dashboard unit and Chromium E2E tests |
| R10 | Manual environment creation no longer exists | Route matrix returns 404 and Settings has no creation form |
| R11 | Migration replay never resets an operator-selected default | Data-idempotency migration test |

## Label contract

A label is valid only when it matches the existing environment-name contract:

```text
^[A-Za-z0-9._-]{1,64}$
```

The server does not trim or case-fold.

| Submitted JSON value | Result |
| --- | --- |
| field absent, `null`, or `""` | Use project default |
| `"production"` | Select the existing production row |
| `"staging"` | Select it or create it transactionally |
| `"Staging"` | Distinct from `staging`; select or create its own row |
| `" staging "` | Invalid; use project default |
| `"qa/west"` | Invalid; use project default |
| a 65-character string | Invalid; use project default |
| a non-string JSON value | Reject the request as malformed with HTTP 400 |

Invalid strings are not copied to events, sessions, warnings, metrics, or logs. The
existing request-body limit remains the memory and network bound.

## Resolution behavior

### Decision table

| Existing live same-project session? | Label | Matching row? | Selected environment | Side effect |
| --- | --- | --- | --- | --- |
| No | absent | n/a | current default | none |
| No | invalid | n/a | current default | fixed-cardinality metric only |
| No | valid | yes | matching row | none |
| No | valid | no | new row | create inside telemetry transaction |
| Yes | any | any | session's stored environment | do not discover or create from the event label |

An event arriving before its session may discover an environment normally. If a later
session initialization selects a different environment, the historical event is not
rewritten. The session owns subsequent events and the existing fixed-cardinality
divergence metric increments.

Requests that do not persist telemetry do not discover environments. In particular,
suppressed errors and replay-only session initialization skipped because recording is
disabled do not create rows. A session initialization that registers SDK identity still
counts as a registered session even when replay recording is disabled.

### Deep database module

Environment resolution is owned by one database module. Handlers provide project context,
the current default ID, and the raw SDK label; they do not look up or create environment
rows. The module has one private transaction-aware operation conceptually equivalent to:

```go
resolveEnvironmentTx(ctx, tx, projectID, defaultEnvironmentID, label)
    (environmentID, outcome, error)
```

`outcome` is one of `default`, `invalid_label`, `existing`, or `created`. A caller that
finds an existing session first reports `session_authoritative` instead. The operation
guarantees that the selected environment belongs to the project and treats database
failures as errors, never as customer fallbacks.

For a valid label it first selects the exact project/name row. On a miss it performs an
`INSERT ... ON CONFLICT (project_id, name) DO NOTHING RETURNING id`, then selects the
winner when another transaction created the row. This is case-sensitive, concurrency-safe,
and does not require a project lock or a negative cache.

The current handler-level environment LRU and standalone resolver are removed. Every
accepted event and registered session already owns a database transaction; keeping lookup,
creation, and persistence together is the simpler correctness boundary. Caching can be
reconsidered only after measurement.

### Event transaction

`InsertErrorEventAndGroup` performs the following before inserting the event:

1. When `session_id` is present, look up a live same-project session in the transaction.
2. If found, select the session environment and do not resolve the event label.
3. Otherwise resolve the label in the same transaction.
4. Use the selected environment for the event and its group-environment rollup.
5. Commit the environment row, event, rollup, and queue mutation together.

The result returns the fixed-cardinality resolution outcome and divergence boolean so the
handler records metrics only after a successful commit.

### Session transaction

`RegisterSession` owns idempotency, authority, and discovery in one transaction:

1. Serialize the globally unique client session ID for the transaction.
2. Recheck tombstone and existing-session state.
3. If the session exists in the same project, return its stored environment without
   resolving the retry's label.
4. If it belongs to another project, return the existing opaque conflict.
5. Only for a genuinely new session, resolve the label and insert the session.
6. Commit the environment row and session together.

The implementation may use a transaction-scoped PostgreSQL advisory lock derived from the
session ID. Hash collisions only serialize unrelated registrations; they do not affect
correctness. This closes the race where two first registrations could otherwise create an
unused environment before one loses the session primary-key conflict.

## Data model

### Project default

Migration `032_project_default_environment.sql` runs in this replay-safe order:

1. Add nullable `projects.default_environment_id` with `IF NOT EXISTS`.
2. Add an idempotent unique index on `environments(id, project_id)`.
3. Backfill only null defaults from each project's exact `production` row.
4. Add the composite foreign key as `NOT VALID` when it does not already exist.
5. Validate the constraint.

The foreign key is:

```sql
FOREIGN KEY (default_environment_id, id)
REFERENCES environments (id, project_id)
```

It prevents a project from selecting another project's environment. The backfill always
contains `WHERE p.default_environment_id IS NULL`, so replay cannot overwrite a later
operator choice.

The column remains nullable during this expand phase. API project JSON therefore exposes
`default_environment_id` as `string | null`. Every current project writer must create the
production row and set the default in its existing transaction. If authentication sees a
legacy null, it resolves that project's production row, increments an invariant metric,
and continues. A missing production row is a server error, not a cross-project guess.

A later contraction may add `NOT NULL` only after production has shown no nulls and every
writer is known to set the field.

### Project creation

One transaction helper owns default initialization:

```text
create or reuse production environment
→ set default_environment_id only when null
→ return production environment
```

It is used by:

- ordinary project provisioning,
- onboarding setup and onboard provisioning,
- agent-session provisioning.

Agent provisioning stops pre-creating `development`. The first accepted telemetry labeled
`development` creates it like any other customer label.

## HTTP interface

### Project responses

Project JSON gains a nullable field during the expand phase:

```json
{
  "default_environment_id": "<uuid-or-null>"
}
```

### Change default

The existing admin-gated project PATCH accepts:

```http
PATCH /api/v1/projects/{projectID}
Content-Type: application/json

{"default_environment_id":"<same-project environment uuid>"}
```

Semantics are exact:

- omitted: leave the current default unchanged;
- JSON `null`, non-string, or malformed UUID: HTTP 400;
- unknown or other-project UUID: HTTP 404 without changing the project;
- valid same-project UUID: update and return HTTP 200 with the project JSON.

### List environments

The existing endpoint accepts one optional query:

```text
GET /api/v1/projects/{projectID}/environments
GET /api/v1/projects/{projectID}/environments?used_by=incidents
GET /api/v1/projects/{projectID}/environments?used_by=sessions
```

- no `used_by`: all rows, for Settings;
- `incidents`: rows referenced by an error incident's environment rollup or a friction
  incident's environment ID;
- `sessions`: rows referenced by a non-deleting session;
- any other non-empty value: HTTP 400.

The response shape remains:

```json
{"environments":[],"rollup_ready":true}
```

The project default comes from project JSON and is not duplicated here.

### Removed interface

`POST /api/v1/projects/{projectID}/environments` is removed and returns the normal JSON
404. Its dashboard client function and Settings form are deleted. Internal transactional
creation remains private to provisioning and telemetry persistence.

## Dashboard behavior

Settings → Environments lists all rows, marks the current default, and gives admins a
`Make default` action on other rows. There are no create, warning, archive, delete, rename,
or remediation controls. During the nullable migration phase, Settings treats the exact
`production` row as the effective default when project JSON unexpectedly contains null.

Issue filters load `used_by=incidents`; session filters load `used_by=sessions`.

- The issue filter renders only when rollups are ready and at least two incident-observed
  environments are returned.
- The session filter renders when at least two session-observed environments are returned;
  it does not depend on incident-rollup readiness.
- Settings loads the unfiltered list.
- If the selected environment is not returned or the filter becomes unavailable, the
  composable clears it from component state, the URL, and local storage.

## Observability

Resolution uses fixed-cardinality metrics only:

```text
opslane_ingest_environment_resolution_total{outcome="default"}
opslane_ingest_environment_resolution_total{outcome="existing"}
opslane_ingest_environment_resolution_total{outcome="created"}
opslane_ingest_environment_resolution_total{outcome="invalid_label"}
opslane_ingest_environment_resolution_total{outcome="session_authoritative"}
```

Unexpected null defaults increment a separate invariant counter. Logs may contain the
project ID and fixed outcome but never the ingest key or raw environment label.

## Verification

### Migration and provisioning

- Apply all migrations on a fresh disposable database and from the previous schema.
- Replay all migrations and compare schema snapshots.
- Set staging as default, replay all migrations, and assert it remains selected.
- Attempt a cross-project default and assert the composite foreign key rejects it.
- Assert every project-creation path creates only production and sets it as default.

### Database and handlers

- Prove absent, invalid, exact existing, distinct-case, and first-valid-label outcomes.
- Force event and session persistence failures and assert a newly discovered environment
  rolls back.
- Race first discovery of the same label and assert one environment row.
- Prove an existing session wins before discovery and no unused row is created.
- Preserve out-of-order divergence, cross-project session conflict, and tombstone behavior.
- Change the default and prove only later unlabeled telemetry changes attribution.
- Assert invalid raw labels occur in no persisted column or structured log field.

### HTTP and dashboard

- Prove project JSON and PATCH status semantics, including null and cross-project cases.
- Prove each `used_by` mode returns only surface-observed rows and rejects unknown modes.
- Prove Settings has only default management and the manual POST route returns 404.
- Prove one observed environment hides each filter, while two show it.
- Prove session filtering works independently of incident-rollup readiness.
- Prove an unavailable option clears stale URL and local-storage selection.

### End to end

Rewrite `test-e2e/environments.test.ts` around label-driven discovery. Create the second
environment by sending telemetry, not direct SQL or the removed POST route. Because this
changes the ingestion pipeline, the final gate includes a disposable Compose smoke that:

1. applies and replays migrations;
2. seeds fixtures and starts ingestion, worker, Postgres, and MinIO;
3. sends a new valid label and proves its row and telemetry commit together;
4. changes the default and proves later unlabeled telemetry follows it;
5. confirms the job reaches its expected terminal state; and
6. runs database-backed Go tests with zero skips.

## Delivery order

1. Land #240 and confirm the payload-environment flag is gone.
2. Add the default migration, project model, and all provisioning writers.
3. Put the default into project-key lookup and add exact PATCH semantics.
4. Move environment resolution into event and session transactions; remove the LRU.
5. Add surface-observed environment lists and remove manual creation.
6. Add Settings default management and surface-specific dashboard filters.
7. Update contracts, E2E, repository checks, and the live smoke.

The schema, ingestion behavior, removed route, and dashboard behavior ship together.

## Deferred decisions

- Environment archiving, hiding, deletion, merging, and renaming.
- A measured active-environment cap or other cardinality control.
- Automatic cleanup of accidental environments.
- Historical telemetry reclassification.
- A `NOT NULL` contraction for `projects.default_environment_id`.

There are no open product decisions for this slice.
