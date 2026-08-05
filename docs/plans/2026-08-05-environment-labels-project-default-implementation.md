# Environment labels and project default: implementation plan

Issue: [#237](https://github.com/opslane/opslane-oss/issues/237)
Design: [environment-labels-project-default.md](../design/2026-08-05-environment-labels-project-default.md)
Status: ready to implement after #240
Base inspected: `220b7ac`

## Outcome

Ship one coherent change in which a valid SDK label creates its environment with the
telemetry that first uses it, missing or invalid labels use a project default, existing
sessions remain authoritative, manual environment creation disappears, and each dashboard
surface filters only by environments it has observed.

There is no v1 environment-count cap, rejection table, warning UI, archive state, or
resolver cache.

## Preconditions

1. Land or rebase onto #240.
2. Confirm this search is empty before starting the feature work:

   ```bash
   rg -n "allow_payload_environment|AllowPayloadEnvironment|ctxAllowPayloadEnvironment" packages docs test-e2e
   ```

3. Preserve #240's event wire compatibility and do not edit frozen files under
   `test-fixtures/wire/`.

## Task 1: add the project default and initialize every project writer

### Files

- Add `packages/ingestion/db/migrations/032_project_default_environment.sql`.
- Update `packages/ingestion/db/migrations_test.go`.
- Update `packages/ingestion/db/queries.go`.
- Update `packages/ingestion/db/project_keys.go`.
- Update `packages/ingestion/db/agent_provision.go`.
- Update `packages/ingestion/handler/onboarding.go`.
- Update provisioning tests in `packages/ingestion/db/*provision*_test.go` and
  `packages/ingestion/handler/*provision*_test.go`.

### Changes

1. In migration 032, in this order:

   - `ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_environment_id UUID`.
   - Create a unique index, with `IF NOT EXISTS`, on `environments(id, project_id)`.
   - Backfill only null project defaults from the same project's exact `production` row.
   - In a `DO` block guarded by `pg_constraint`, add
     `FOREIGN KEY (default_environment_id, id) REFERENCES environments(id, project_id)
     NOT VALID`.
   - Validate the constraint. Do not add `NOT NULL`.

2. Add `DefaultEnvironmentID *string` to `db.Project` and to every project `SELECT`,
   `RETURNING`, and `Scan`. After #240, use one consistent projection order everywhere:

   ```text
   id, org_id, name, github_repo, default_branch,
   friction_autonomy, pr_posture, default_environment_id, created_at
   ```

3. Add one transaction helper in `db/environments.go`:

   ```go
   EnsureProjectDefaultEnvironmentTx(ctx, tx, projectID) (*Environment, error)
   ```

   It upserts the exact `production` row, sets `projects.default_environment_id` only
   when null, and returns production. Callers also set the returned ID on their in-memory
   `Project` value before serializing it.

4. Use that helper from all production project writers:

   - `provisionProjectTx` in `db/queries.go`;
   - `OnboardingSetup` in `handler/onboarding.go`;
   - `ProvisionAgentSession` in `db/agent_provision.go`.

   `OnboardProvision` already flows through `provisionProjectTx`. Remove agent
   provisioning's eager `development` row; its first telemetry will discover it.

5. Add `DefaultEnvironmentID *string` to `ProjectKeyLookup` and select it in
   `LookupProjectKey`. Do not resolve `production` by name in this query.

### Tests

- Fresh migration, previous-schema roll-forward, and schema replay stay green.
- Add a data-replay test: create production and staging, select staging as default, replay
  all migrations, and assert staging survives.
- Add a composite-FK test that rejects another project's environment.
- Assert ordinary, onboarding, onboard, and agent provisioning return a non-null production
  default. Agent provisioning creates one environment, not two.
- Assert an idempotent provisioning retry does not reset an already changed default.

### Checkpoint

```bash
(cd packages/ingestion && go test ./db -run 'Migration|Provision|Agent')
(cd packages/ingestion && go test ./handler -run 'Onboard|Provision')
```

Run these with `DATABASE_URL` set and confirm zero skips.

## Task 2: expose and change the default safely

### Files

- Update `packages/ingestion/handler/project_keys.go` and `auth.go`.
- Update `packages/ingestion/handler/read_api.go`.
- Update `packages/ingestion/handler/metrics.go`.
- Update `packages/ingestion/handler/project_keys_test.go`, project endpoint tests, and
  route/auth tests.
- Update `packages/dashboard/src/api.ts`.

### Changes

1. `ProjectKey` puts `lookup.DefaultEnvironmentID` into `ctxEnvironmentID`. When it is
   null, call `FindEnvironmentIDByName(projectID, "production")`, increment
   `opslane_project_default_invariant_total{reason="null_default"}`, and continue. If the
   same-project production row is absent, return 500. Delete the handler LRU use from auth.

2. Add `default_environment_id` as `*string` to `projectJSON` and `string | null` to the
   dashboard `Project` type.

3. Decode PATCH presence separately from value. Use `json.RawMessage` (or an equivalent
   optional-value type) so omitted and explicit `null` are distinguishable:

   - omitted: existing `UpdateProject` behavior;
   - null, non-string, or malformed UUID: 400;
   - same-project environment: update and return 200;
   - unknown or cross-project environment: 404.

4. Put the tenant check and update in one DB statement or transaction. The write must be
   scoped by both `projects.org_id` and `environments.project_id`; do not verify access in
   one query and update in a later unguarded query.

5. Add `default_environment_id?: string` to the dashboard `updateProject` input. Do not
   expose a nullable write from the dashboard.

### Tests

- Project list, create, and patch responses include the field.
- PATCH covers omitted, null, non-string, malformed UUID, unknown UUID, cross-project UUID,
  same-project success, and existing role rules.
- Project-key authentication uses a non-production default without a name lookup.
- The nullable compatibility branch uses same-project production and fails when it is absent.

### Checkpoint

```bash
(cd packages/ingestion && go test ./handler -run 'Project|Key|DefaultEnvironment')
pnpm --filter @opslane/dashboard test -- --run
```

## Task 3: make discovery part of event and session transactions

### Files

- Add `packages/ingestion/db/environments.go` tests in
  `packages/ingestion/db/environment_resolution_test.go`.
- Update `packages/ingestion/db/queries.go` and `sessions.go`.
- Update `packages/ingestion/handler/error_event.go`, `session.go`, and `metrics.go`.
- Delete `packages/ingestion/handler/env_resolver.go` and its LRU-specific tests.
- Rewrite `packages/ingestion/handler/environment_override_integration_test.go` around
  label discovery and project defaults.

### Changes

1. In `db/environments.go`, define the exact syntax once and add a private
   `resolveEnvironmentTx` helper. It returns the selected environment ID plus one of:

   ```text
   default | invalid_label | existing | created
   ```

   Missing, null-decoded-as-empty, and empty labels select the default. Invalid strings
   select the default. Valid strings select an exact row or insert with:

   ```sql
   INSERT INTO environments (project_id, name)
   VALUES ($1, $2)
   ON CONFLICT (project_id, name) DO NOTHING
   RETURNING id
   ```

   If no row returns, select the concurrent winner. Verify the default and every selected
   ID belong to the project. Never retain the raw invalid value.

2. Replace `IngestParams.EnvironmentID` at the ingest boundary with:

   ```go
   DefaultEnvironmentID string
   EnvironmentLabel     string
   ```

   Inside `InsertErrorEventAndGroup`, after opening its existing transaction:

   - first query a live same-project session when `SessionID` is present;
   - if found, use its environment and skip `resolveEnvironmentTx`;
   - otherwise resolve the label in the transaction;
   - use the selected ID for the event and environment rollup;
   - return `EnvironmentOutcome` and `EnvironmentDiverged` in `IngestResult` after commit.

   For divergence, compare a valid explicit label with the session environment name;
   missing/invalid labels compare the current default ID with the session environment ID.

3. Change `RegisterSession` to accept default ID and raw label rather than a pre-resolved
   environment ID. At transaction start, take a transaction-scoped advisory lock derived
   from the global session ID, then recheck tombstone/ownership:

   - existing same-project session: return its stored environment and never resolve the
     retry label;
   - existing other-project session: `ErrSessionProjectConflict`;
   - tombstone: `ErrSessionTombstoned`;
   - new session: resolve, insert, check prior-event divergence, and commit.

   Add `EnvironmentOutcome` to `SessionRegistration` so the handler records the committed
   result. Keep the test-fixture-oriented `InsertSession` wrapper source-compatible by
   treating its supplied environment ID as the default with an empty label.

4. In both handlers, pass `EnvironmentIDFromCtx()` as the default and the decoded payload
   label unchanged. Delete pre-transaction resolution and the event handler's standalone
   `SessionEnvironment` lookup. Keep cheap exits before the DB call, so suppressed errors
   and non-registering disabled replay requests do not discover environments.

5. Replace override/fallback metrics with the fixed-cardinality resolution counter. Record
   outcomes and divergence only after a successful DB commit. No raw-label log fields.

### Tests

- Missing, null, empty, invalid, existing, created, and case-distinct labels.
- Concurrent same-label discovery creates one row.
- A forced error after discovery but before event commit leaves no environment row.
- A forced session insert failure leaves no environment row.
- Concurrent registration of one session ID creates only the winning session's environment.
- Existing same-project session wins before event discovery; no unused row is created.
- Cross-project collision, tombstone, retry idempotency, and out-of-order divergence remain.
- Suppressed errors and non-registering disabled replay initialization create nothing.
- Changing the default affects later unlabeled events/sessions but not stored rows or an
  existing session.

### Checkpoint

```bash
(cd packages/ingestion && go test ./db -run 'Environment|Session|ErrorGroup')
(cd packages/ingestion && go test ./handler -run 'Environment|ErrorEvent|Session')
```

Run with the disposable Postgres configuration and confirm zero skips.

## Task 4: remove manual creation and add surface-observed lists

### Files

- Update `packages/ingestion/db/queries.go` and
  `packages/ingestion/db/environment_filters_test.go`.
- Update `packages/ingestion/handler/read_api.go`, `routes.go`,
  `environments_readiness_test.go`, and `route_matrix_test.go`.
- Update `packages/dashboard/src/api.ts`.
- Update `packages/dashboard/src/composables/useEnvironmentFilter.ts` and its test.
- Update `packages/dashboard/src/components/FilterBar.vue`.
- Update `packages/dashboard/src/views/SessionsList.vue`, `Settings.vue`, and their tests.

### Changes

1. Replace the environment list DB interface with:

   ```go
   ListEnvironments(ctx, projectID, usedBy string) ([]Environment, error)
   ```

   Implement three explicit query branches; do not build SQL from the query value:

   - empty: every project row;
   - `incidents`: an environment for which either an error-kind group has an
     `error_group_environments` row or a friction-kind group has that direct
     `error_groups.environment_id`;
   - `sessions`: an environment referenced by a same-project session whose status is not
     `deleting`.

   Order every branch by `environments.created_at, environments.id`.

2. `ListEnvironmentsEndpoint` accepts only empty, `incidents`, or `sessions`; return 400
   for any other non-empty value. Keep `rollup_ready` in the response for issue-filter
   compatibility.

3. Remove `CreateEnvironmentEndpoint`, its route, direct `db.CreateEnvironment` if it has
   no remaining production caller, and all route authorization expectations. Add an
   explicit route-matrix assertion that POST now receives the normal JSON 404.

4. Dashboard API:

   ```ts
   listEnvironments(projectId, usedBy?: 'incidents' | 'sessions')
   ```

   Delete `createEnvironment`.

5. `useEnvironmentFilter(projectId, usedBy)` loads the surface-specific list and exposes
   `filterAvailable`:

   - incidents: `rollup_ready && environments.length >= 2`;
   - sessions: `environments.length >= 2`.

   When false, or when the selected ID is absent from the response, clear component state,
   URL query, and `opslane_environment_id` local storage.

6. Pass `incidents` from `FilterBar.vue` and `sessions` from `SessionsList.vue`. Do not gate
   session request parameters on rollup readiness. Render each select only when
   `filterAvailable`.

7. In `Settings.vue`, load the unfiltered list. Delete the create form, name state, handler,
   and copy. Mark the selected project's default row and add `Make default` buttons that
   call `updateProject`; update the shared project state from the response. Admin role
   behavior stays as it is for other project mutations.

### Tests

- DB and endpoint tests cover all three lists, both incident kinds, session-only rows,
  unused rows, deleting sessions, invalid `used_by`, and deterministic ordering.
- Settings shows the badge/action, changes the default, and has no create controls.
- Issue filter requires readiness plus two incident-observed environments.
- Session filter requires two session-observed environments and ignores rollup readiness.
- A stale selection is cleared from state, URL, and local storage.
- POST environment creation is 404.

### Checkpoint

```bash
(cd packages/ingestion && go test ./db -run 'EnvironmentFilter|ListEnvironment')
(cd packages/ingestion && go test ./handler -run 'Environment|RouteMatrix')
pnpm --filter @opslane/dashboard build
pnpm --filter @opslane/dashboard test -- --run
```

## Task 5: contracts, E2E, and final proof

### Files

- Update `docs/contracts/events.md`.
- Update `docs/reference/http-routes.md`.
- Rewrite `test-e2e/environments.test.ts`.
- Update any environment-filter Chromium test and `scripts/seed-e2e.sql` only where the
  new project-default column requires it.

### Changes and acceptance

1. Document that a valid exact SDK label is authoritative and auto-discovered, absent or
   invalid values use the project default, and an existing session wins.
2. Document the default PATCH field, the `used_by` query, and removed POST route.
3. Rewrite E2E setup so it does not toggle #240's removed flag or manually insert the
   second environment. Ingest `staging`, read the created row, and use that ID for filter
   assertions.
4. E2E must prove:

   - production is the initial default;
   - `staging` is created by its first committed event;
   - invalid syntax falls back without dropping the event;
   - one group spans production and staging with correct rollups;
   - a changed default affects later unlabeled telemetry;
   - an existing session overrides a conflicting later event label without creating it;
   - incident and session filters use their own observed rows;
   - manual POST creation returns 404.

5. Apply the `contract-change` label to the implementation PR because event attribution
   changes while the append-only wire shape remains compatible.

### Final verification

Use the disposable ports and URLs from the root `AGENTS.md`, export storage credentials,
and run:

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Then run the required pipeline smoke:

1. Apply migrations, run `scripts/seed-e2e.sql`, and start the isolated Compose stack.
2. Rebuild ingestion and worker.
3. POST an event with a unique valid environment label.
4. Assert the environment and event exist and reference each other.
5. Confirm the queued job reaches its expected terminal state.
6. Re-run `go test ./...` with `DATABASE_URL` and MinIO variables set; report the skip count
   and require **zero** skips.

## Done means

- No allowlist flag, manual-create route, environment LRU, cap, rejection persistence, or
  warning UI remains.
- Environment discovery is rollback-safe for both accepted events and registered sessions.
- Every current project writer sets a production default.
- Project defaults cannot cross tenant boundaries.
- Filters show only surface-observed environments and cannot stay invisibly selected.
- Focused tests, full repository gate, E2E, and live smoke all pass with zero database or
  storage skips.
