# Environment Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the error pipeline environment-aware: jobs anchor to their triggering event, customers scope which environments may trigger automation, and the dashboard defaults to the project's default environment.

**Architecture:** Grouping identity stays `(project_id, fingerprint)`; environment remains a dimension. Three slices land in order: S1 dashboard default filter (no schema), S2 job evidence anchor (`error_group_jobs.event_id`), S3 action scope (enable flag + allowlist join table + ingest-transaction gate + dormant-group activation + settings surface). S4 (scoped priority) is a separate follow-up plan after S3 lands.

**Tech Stack:** Go 1.24 + pgx (ingestion), Postgres migrations (append-only, `IF NOT EXISTS`-guarded), Node 22 TypeScript (worker), Vue 3 + Vitest (dashboard).

## Global Constraints

- Migrations are append-only starting at `046`, safe to reapply (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`).
- Preserve terminal-status and lease contracts; do not weaken them in tests.
- The `POST /api/v1/events` wire contract is untouched (no SDK changes in this plan).
- Scope every new DB helper to project/org in its query, per `packages/ingestion/AGENTS.md`.
- Existing projects keep current behavior: `action_scope_enabled` defaults `false`; no backfill of jobs.
- **Commit order is not deployment order.** Tasks land code in dependency order for review; production rollout for S2 is migration → worker (NULL-tolerant, Task 5) → ingestion stamping (Task 4), and for S3 is schema (Task 6) → gate (Task 7) → settings surface (Tasks 8-9). Deploying ingestion's Task 4 before the Task 3 migration would fail at runtime; the rollout note in Task 10 records this.
- Verification per package: ingestion `go build ./... && go test ./...` (export `DATABASE_URL` first — DB-gated tests skip, not fail, without it; read the skip count); dashboard `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test`; worker `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`.
- Commit per task; keep diffs reviewable.

---

### Task 1: Dashboard — default environment fallback in the composable (S1)

**Files:**
- Modify: `packages/dashboard/src/composables/useEnvironmentFilter.ts`
- Test: `packages/dashboard/src/composables/useEnvironmentFilter.test.ts` (exists — extend)

**Interfaces:**
- Produces: `initialEnvironmentId(queryValue, storedValue, defaultEnvironmentId): string`; `ALL_ENVIRONMENTS_SENTINEL = '__all__'`; `environmentStorageKey(projectId): string`; `persistEnvironmentId(storage, environmentId, projectId, explicitClear): void`; `useEnvironmentFilter(projectId, usedBy, defaultEnvironmentId?)` — third param `MaybeRef<string | null | undefined>`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests** (append to the existing test file)

```ts
import { describe, expect, it } from 'vitest';
import {
  ALL_ENVIRONMENTS_SENTINEL,
  environmentStorageKey,
  initialEnvironmentId,
  persistEnvironmentId,
} from './useEnvironmentFilter';

describe('initialEnvironmentId with project default', () => {
  it('prefers the URL query over everything', () => {
    expect(initialEnvironmentId('env-url', 'env-stored', 'env-default')).toBe('env-url');
  });

  it('prefers the stored choice over the project default', () => {
    expect(initialEnvironmentId(undefined, 'env-stored', 'env-default')).toBe('env-stored');
  });

  it('falls back to the project default when nothing was chosen', () => {
    expect(initialEnvironmentId(undefined, null, 'env-default')).toBe('env-default');
  });

  it('treats a stored all-environments sentinel as an explicit choice of no filter', () => {
    expect(initialEnvironmentId(undefined, ALL_ENVIRONMENTS_SENTINEL, 'env-default')).toBe('');
  });

  it('returns empty when there is no default', () => {
    expect(initialEnvironmentId(undefined, null, null)).toBe('');
    expect(initialEnvironmentId(undefined, null, undefined)).toBe('');
  });
});

describe('environmentStorageKey', () => {
  it('is scoped per project', () => {
    expect(environmentStorageKey('p1')).toBe('opslane_environment_id:p1');
    expect(environmentStorageKey('p2')).not.toBe(environmentStorageKey('p1'));
  });
});

describe('persistEnvironmentId', () => {
  const makeStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  };

  it('stores the sentinel on explicit clear and removes on implicit reset', () => {
    const storage = makeStorage();
    persistEnvironmentId(storage, '', 'p1', true);
    expect(storage.getItem('opslane_environment_id:p1')).toBe(ALL_ENVIRONMENTS_SENTINEL);
    persistEnvironmentId(storage, '', 'p1', false);
    expect(storage.getItem('opslane_environment_id:p1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, expect failures**

Run: `pnpm --filter @opslane/dashboard exec vitest run src/composables/useEnvironmentFilter.test.ts`
Expected: FAIL — new exports missing; `initialEnvironmentId` takes 2 args; `persistEnvironmentId` takes 2 args.

- [ ] **Step 3: Implement**

Pure functions:

```ts
export const ALL_ENVIRONMENTS_SENTINEL = '__all__';

export function environmentStorageKey(projectId: string): string {
  return `${ENVIRONMENT_STORAGE_KEY}:${projectId}`;
}

export function initialEnvironmentId(
  queryValue: QueryValue,
  storedValue: string | null,
  defaultEnvironmentId?: string | null,
): string {
  const value = Array.isArray(queryValue) ? queryValue[0] : queryValue;
  if (value) return value;
  if (storedValue === ALL_ENVIRONMENTS_SENTINEL) return '';
  return storedValue || defaultEnvironmentId || '';
}

export function persistEnvironmentId(
  storage: EnvironmentStorage,
  environmentId: string,
  projectId: string,
  explicitClear: boolean,
): void {
  const key = environmentStorageKey(projectId);
  if (environmentId) storage.setItem(key, environmentId);
  else if (explicitClear) storage.setItem(key, ALL_ENVIRONMENTS_SENTINEL);
  else storage.removeItem(key);
}
```

Composable body — the watcher, clear, project-switch, and default application all change; persistence is centralized in one `syncSelection` and the watcher is a wrapper so the old `watch(selectedEnvironmentId, syncSelection)` bug (Vue passes the previous value as arg 2) cannot recur:

```ts
export function useEnvironmentFilter(
  projectId: MaybeRef<string>,
  usedBy: 'incidents' | 'sessions',
  defaultEnvironmentId?: MaybeRef<string | null | undefined>,
) {
  // ...existing refs unchanged...
  let suppressNextWatcherSync = false;

  // Initialization uses ONLY URL and storage — never the project default. The
  // default is applied in loadOptions after the environment list validates it;
  // applying it here would make a stale default an active hidden filter.
  const selectedEnvironmentId = ref(initialEnvironmentId(
    route.query['environment_id'],
    localStorage.getItem(environmentStorageKey(toValue(projectId))),
  ));

  function syncSelection(environmentId: string, explicitClear = false): void {
    persistEnvironmentId(localStorage, environmentId, toValue(projectId), explicitClear);
    void router.replace({ query: environmentFilterQuery(route.query, environmentId) });
  }

  // Explicit clear persists the sentinel SYNCHRONOUSLY — before the watcher or
  // any in-flight loadOptions can observe the empty selection — so the default
  // can never race back in between "user cleared" and "sentinel stored".
  function clear(): void {
    syncSelection('', true);
    if (selectedEnvironmentId.value !== '') {
      suppressNextWatcherSync = true;  // the sentinel write above already happened
      selectedEnvironmentId.value = '';
    }
  }

  function resetForInvalidSelection(): void {
    syncSelection('');                 // implicit: key removed, default may re-apply
    if (selectedEnvironmentId.value !== '') {
      suppressNextWatcherSync = true;
      selectedEnvironmentId.value = '';
    }
  }

  watch(selectedEnvironmentId, (next) => {
    if (suppressNextWatcherSync) {
      suppressNextWatcherSync = false;
      return;
    }
    syncSelection(next);
  });

  // Project switch: re-initialize for the NEW project from its own storage.
  // Never call clear() here — that would persist a sentinel under the new
  // project's key and permanently suppress its default. The new project's
  // default applies via loadOptions once its environments arrive.
  watch(
    () => toValue(projectId),
    (next, previous) => {
      if (previous && next !== previous) {
        suppressNextWatcherSync = true;
        selectedEnvironmentId.value = initialEnvironmentId(
          undefined,
          localStorage.getItem(environmentStorageKey(next)),
        );
      }
      void loadOptions();
    },
  );
  // ...
}
```

In `loadOptions`, replace the invalid-selection `clear()` call with `resetForInvalidSelection()`, and after options land apply the default only when it is genuinely usable. Guard against the stale-response race the function already handles for options (`generation !== loadGeneration` returns early above this point), and re-check the sentinel from storage so a clear() that ran while the request was in flight wins:

```ts
const fallback = toValue(defaultEnvironmentId);
if (
  filterAvailable.value &&                                  // never a hidden active filter
  !selectedEnvironmentId.value &&
  localStorage.getItem(environmentStorageKey(id)) !== ALL_ENVIRONMENTS_SENTINEL &&
  fallback &&
  response.environments.some((environment) => environment.id === fallback)
) {
  selectedEnvironmentId.value = fallback;                   // stale default = ignored
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `pnpm --filter @opslane/dashboard exec vitest run src/composables/useEnvironmentFilter.test.ts`
Expected: PASS, including pre-existing tests (old 2-arg call sites still compile — new params optional).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/composables/useEnvironmentFilter.ts packages/dashboard/src/composables/useEnvironmentFilter.test.ts
git commit -m "feat(dashboard): environment filter falls back to project default, per-project storage"
```

---

### Task 2: Dashboard — thread the project default into the composable's callers (S1)

**Files:**
- Modify: `packages/dashboard/src/components/FilterBar.vue` (line 32 calls `useEnvironmentFilter(toRef(props, 'projectId'), 'incidents')`)
- Modify: `packages/dashboard/src/views/SessionsList.vue` (line 40 calls `useEnvironmentFilter(projectId, 'sessions')`)
- Modify: the parent that renders `FilterBar` (found via `grep -rn '<FilterBar' packages/dashboard/src`) to pass the new prop.

**Interfaces:**
- Consumes: `useEnvironmentFilter(projectId, usedBy, defaultEnvironmentId?)` from Task 1; `Project.default_environment_id` already on the project response (`packages/dashboard/src/api.ts:151`).
- Produces: `FilterBar` prop `defaultEnvironmentId?: string | null`.

- [ ] **Step 1: Add the prop and pass it through**

In `FilterBar.vue`:

```ts
const props = defineProps<{
  projectId: string;
  defaultEnvironmentId?: string | null;
  // ...existing props unchanged
}>();

useEnvironmentFilter(toRef(props, 'projectId'), 'incidents', toRef(props, 'defaultEnvironmentId'));
```

In each parent rendering `<FilterBar>`, bind `:default-environment-id="project?.default_environment_id"` from the project object that view already loads. In `SessionsList.vue`, pass the same third argument from its loaded project.

- [ ] **Step 2: Build and test**

Run: `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test`
Expected: build green, all tests pass.

- [ ] **Step 3: Manual proof**

With the local stack up: seed two environments, set the project's default environment, open the issues list in a fresh browser profile (empty localStorage) → the default environment is selected. Clear the filter, reload → still "all environments". Switch to a second project → that project's own default applies (not the sentinel).

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src
git commit -m "feat(dashboard): issues and sessions default to the project's default environment"
```

---

### Task 3: Migration 046 — job evidence anchor column (S2)

**Files:**
- Create: `packages/ingestion/db/migrations/046_job_event_anchor.sql`
- Test: `packages/ingestion/db/migration_046_test.go`

**Interfaces:**
- Produces: `error_group_jobs.event_id UUID NULL REFERENCES error_events(id) ON DELETE SET NULL`.

- [ ] **Step 1: Write the migration**

```sql
-- 046: jobs anchor their evidence to the triggering event.
-- ON DELETE SET NULL: retention may delete old events without breaking job
-- history; the worker falls back to sample_event_id when the anchor is gone.
ALTER TABLE error_group_jobs
  ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES error_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_error_group_jobs_event ON error_group_jobs(event_id) WHERE event_id IS NOT NULL;
```

- [ ] **Step 2: Write the failing test** (mirror `migration_045_test.go`'s harness)

```go
func TestMigration046JobEventAnchor(t *testing.T) {
	db := openTestDB(t) // same helper the 045 test uses
	ctx := context.Background()

	var dataType, isNullable string
	err := db.QueryRow(ctx,
		`SELECT data_type, is_nullable FROM information_schema.columns
		 WHERE table_name = 'error_group_jobs' AND column_name = 'event_id'`,
	).Scan(&dataType, &isNullable)
	if err != nil {
		t.Fatalf("event_id column missing: %v", err)
	}
	if dataType != "uuid" || isNullable != "YES" {
		t.Fatalf("event_id = %s nullable=%s, want uuid nullable", dataType, isNullable)
	}

	var deleteRule string
	err = db.QueryRow(ctx,
		`SELECT rc.delete_rule
		 FROM information_schema.referential_constraints rc
		 JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name
		 WHERE kcu.table_name = 'error_group_jobs' AND kcu.column_name = 'event_id'`,
	).Scan(&deleteRule)
	if err != nil {
		t.Fatalf("event_id FK missing: %v", err)
	}
	if deleteRule != "SET NULL" {
		t.Fatalf("delete_rule = %s, want SET NULL", deleteRule)
	}

	// Idempotence: re-execute the migration SQL directly (the runner records
	// applied migrations, so re-running the runner proves nothing).
	sqlBytes, err := os.ReadFile("migrations/046_job_event_anchor.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, string(sqlBytes)); err != nil {
		t.Fatalf("migration 046 is not idempotent on reapply: %v", err)
	}
}
```

- [ ] **Step 3: Run**

Run: `cd packages/ingestion && go test ./db -run TestMigration046 -v`
Expected: PASS (fails with "column missing" if the file is misnamed for the runner).

- [ ] **Step 4: Commit**

```bash
git add packages/ingestion/db/migrations/046_job_event_anchor.sql packages/ingestion/db/migration_046_test.go
git commit -m "feat(ingestion): migration 046 — error_group_jobs.event_id evidence anchor"
```

---

### Task 4: Stamp the anchor at every enqueue site (S2)

**Files:**
- Modify: `packages/ingestion/db/queries.go` — new-group enqueue (`:657`), requeue enqueue (`:700`), guided fix job (`:1312`)
- Test: `packages/ingestion/db/error_group_ingestion_test.go` (extend)

**Interfaces:**
- Consumes: `event_id` column (Task 3); `eventID` variable already in scope in the ingest transaction.
- Produces: every `INSERT INTO error_group_jobs` for error groups carries `event_id`.

- [ ] **Step 1: Write the failing tests.** Three, reusing the file's existing project/environment/ingest fixtures (follow its local helper idiom; assertions below are literal):

```go
func TestEnqueueStampsTriggeringEvent(t *testing.T) {
	// (a) new group: ingest one event; the created job's event_id equals it.
	res := ingestOne(t, q, projectID, envID, "fp-anchor-1")
	assertJobEventID(t, q, res.GroupID, res.EventID)
}

func TestRequeueStampsTriggeringEvent(t *testing.T) {
	// (b) requeue: ingest, resolve the group via direct status UPDATE (the file
	// already does this for release-order tests), ingest a second event.
	// The NEW job's event_id equals the SECOND event's id.
}

func TestAnchorSurvivesSampleOverwrite(t *testing.T) {
	// (c) the central immutability property: ingest event A (job created,
	// anchored to A), then ingest event B on the same fingerprint while the
	// group is queued (no second job). Assert: job.event_id is still A,
	// error_groups.sample_event_id is now B.
}

func TestGuidedJobStampsCurrentSample(t *testing.T) {
	// (d) guided: ingest an event, move the group to status 'investigated'
	// (direct UPDATE), call EnqueueGuidedFixJob. The fix job's event_id
	// equals the group's current sample_event_id.
}
```

- [ ] **Step 2: Run, expect FAIL** — `event_id` is NULL in all four.

Run: `cd packages/ingestion && go test ./db -run 'TestEnqueueStamps|TestRequeueStamps|TestAnchorSurvives|TestGuidedJobStamps' -v`

- [ ] **Step 3: Implement**

New-group branch (`queries.go:657`):

```go
`INSERT INTO error_group_jobs (error_group_id, project_id, event_id)
 VALUES ($1, $2, $3)
 RETURNING id`,
groupID, p.ProjectID, eventID,
```

Requeue branch (`queries.go:700`): same three columns, same `eventID`.

Guided fix job (`queries.go:1312`):

```go
`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, guidance, triggered_by, platform, event_id)
 VALUES ($1, $2, 'fix', $3, 'human',
         (SELECT platform FROM error_groups WHERE id = $1 AND project_id = $2),
         (SELECT sample_event_id FROM error_groups WHERE id = $1 AND project_id = $2))
 RETURNING id`,
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd packages/ingestion && go test ./db` (with `DATABASE_URL` exported; zero skips)

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/db/error_group_ingestion_test.go
git commit -m "feat(ingestion): stamp triggering event_id on every error-group job"
```

---

### Task 5: Worker prefers the job's anchor over the mutable sample (S2)

**Files:**
- Modify: `packages/worker/src/db.ts` — `claimJob` RETURNING list (`:368`) + claimed-job type; new exported helper `resolveEvidenceEventId`
- Modify: `packages/worker/src/index.ts:485-486` and `:1143-1144`
- Test: colocated worker test next to the existing claim tests in `packages/worker/src/__tests__/`

**Interfaces:**
- Consumes: `error_group_jobs.event_id` (Tasks 3-4); `db.getErrorEvent(eventId, projectId)` (`db.ts:1330`, existing).
- Produces: claimed job gains `eventId: string | null`; `resolveEvidenceEventId(job: { eventId: string | null }, group: { sample_event_id: string | null }): string | null`.

- [ ] **Step 1: Failing unit test for the selection rule** (pure, not DB-gated — this is what proves the worker *uses* the anchor):

```ts
import { resolveEvidenceEventId } from '../db';

describe('resolveEvidenceEventId', () => {
  it('prefers the job anchor over the mutable sample', () => {
    expect(resolveEvidenceEventId({ eventId: 'A' }, { sample_event_id: 'B' })).toBe('A');
  });
  it('falls back to sample for historical/NULL-anchor jobs', () => {
    expect(resolveEvidenceEventId({ eventId: null }, { sample_event_id: 'B' })).toBe('B');
  });
  it('returns null when neither exists', () => {
    expect(resolveEvidenceEventId({ eventId: null }, { sample_event_id: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Failing DB-gated claim test** (colocated with existing claim tests, their setup helpers): seed a group whose `sample_event_id` is event B and a job with `event_id` = event A; `claimJob` returns `eventId === 'A'`.

- [ ] **Step 3: Implement**

```ts
export function resolveEvidenceEventId(
  job: { eventId: string | null },
  group: { sample_event_id: string | null },
): string | null {
  return job.eventId ?? group.sample_event_id ?? null;
}
```

Add `event_id` to `claimJob`'s RETURNING list (`:368`) and map `eventId: row.event_id ?? null` following the function's existing field-mapping idiom. At both evidence sites (`index.ts:485`, `:1143`):

```ts
const anchorEventId = resolveEvidenceEventId(job, group);
const event = anchorEventId
  ? await db.getErrorEvent(anchorEventId, job.projectId)
  : null;
```

- [ ] **Step 4: Build + full worker suite**

Run: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test` (with `DATABASE_URL`)
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src
git commit -m "feat(worker): investigations analyze the job's triggering event, not the mutable sample"
```

---

### Task 6: Migration 047 — action scope schema (S3)

**Files:**
- Create: `packages/ingestion/db/migrations/047_action_scope.sql`
- Test: `packages/ingestion/db/migration_047_test.go`

**Interfaces:**
- Produces: `projects.action_scope_enabled BOOLEAN NOT NULL DEFAULT false`; `project_action_environments(project_id, environment_id)` with composite FK to `environments(project_id, id)`.

- [ ] **Step 1: Write the migration**

```sql
-- 047: per-project action scope. Flag + allowlist; empty allowlist while
-- enabled means "no environment may trigger automation" (fails closed).
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS action_scope_enabled BOOLEAN NOT NULL DEFAULT false;

-- Composite-FK support (id is the PK, so uniqueness is trivially true, but
-- Postgres requires a matching unique index for the composite FK).
CREATE UNIQUE INDEX IF NOT EXISTS uq_environments_project_id_id ON environments(project_id, id);

CREATE TABLE IF NOT EXISTS project_action_environments (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, environment_id),
  FOREIGN KEY (project_id, environment_id)
    REFERENCES environments(project_id, id) ON DELETE CASCADE
);
```

- [ ] **Step 2: Write the failing test.** Assertions, in order:

```go
func TestMigration047ActionScope(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	// seed projects A and B, each with one environment, via the file's fixtures

	// 1. Flag defaults false on an existing project.
	var enabled bool
	mustScan(t, db.QueryRow(ctx, `SELECT action_scope_enabled FROM projects WHERE id = $1`, projectA), &enabled)
	if enabled {
		t.Fatal("action_scope_enabled must default to false")
	}

	// 2. Cross-project membership is rejected by the composite FK.
	if _, err := db.Exec(ctx,
		`INSERT INTO project_action_environments (project_id, environment_id) VALUES ($1, $2)`,
		projectA, envOfProjectB); err == nil {
		t.Fatal("cross-project environment accepted; composite FK missing")
	}

	// 3. Valid membership inserts.
	if _, err := db.Exec(ctx,
		`INSERT INTO project_action_environments (project_id, environment_id) VALUES ($1, $2)`,
		projectA, envOfProjectA); err != nil {
		t.Fatalf("valid allowlist row rejected: %v", err)
	}

	// 4. Enable the flag, delete the environment: membership cascades away,
	//    the flag STAYS true (fails closed — empty allowlist blocks automation,
	//    it does not silently reopen all environments).
	mustExec(t, db, `UPDATE projects SET action_scope_enabled = true WHERE id = $1`, projectA)
	mustExec(t, db, `DELETE FROM environments WHERE id = $1`, envOfProjectA)
	var members int
	mustScan(t, db.QueryRow(ctx, `SELECT count(*) FROM project_action_environments WHERE project_id = $1`, projectA), &members)
	if members != 0 {
		t.Fatalf("membership not cascaded on environment delete: %d rows", members)
	}
	mustScan(t, db.QueryRow(ctx, `SELECT action_scope_enabled FROM projects WHERE id = $1`, projectA), &enabled)
	if !enabled {
		t.Fatal("flag must survive environment deletion")
	}

	// 5. Idempotence: re-execute the migration SQL directly.
	sqlBytes, err := os.ReadFile("migrations/047_action_scope.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, string(sqlBytes)); err != nil {
		t.Fatalf("migration 047 is not idempotent on reapply: %v", err)
	}
}
```

(`mustScan`/`mustExec` are one-line local helpers if the file doesn't already have equivalents.)

- [ ] **Step 3: Run, commit**

```bash
cd packages/ingestion && go test ./db -run TestMigration047 -v
git add packages/ingestion/db/migrations/047_action_scope.sql packages/ingestion/db/migration_047_test.go
git commit -m "feat(ingestion): migration 047 — action scope flag and environment allowlist"
```

---

### Task 7: The gate — scope-aware enqueue, requeue, and dormant activation (S3)

**Files:**
- Modify: `packages/ingestion/db/queries.go` — the ingest transaction's job-creation section (`:653-720`)
- Test: `packages/ingestion/db/error_group_ingestion_test.go` (extend, table-driven)

**Interfaces:**
- Consumes: Task 6 schema; `environmentID` in scope in the transaction; `publishIssueCreated` (`:674`); `isRequeueEligible` (`:341`); Task 4's `event_id` stamping.
- Produces: `eventInActionScope(ctx, tx, projectID, environmentID) (bool, error)`.

- [ ] **Step 1: Write the failing table-driven test.** Each case seeds a project with `production` and `staging`; "scoped" = flag on, allowlist `[production]`. Status transitions between events use direct UPDATEs (the file's existing release-order idiom). `wantCreated` = expected count of `issue.created` rows in `outbound_events` for the group (asserted the way the existing publish tests do).

```go
func TestActionScopeGate(t *testing.T) {
	cases := []struct {
		name       string
		scoped     bool
		emptyList  bool     // scoped with allowlist emptied
		sequence   []step   // step = {env string, setStatusAfter string}
		wantJobs   int
		wantStatus string
		wantCreated int
	}{
		{"unscoped project unchanged", false, false, steps(ev("staging")), 1, "queued", 1},
		{"out-of-scope event creates group, no job, no issue.created", true, false, steps(ev("staging")), 0, "new", 0},
		{"in-scope event queues normally", true, false, steps(ev("production")), 1, "queued", 1},
		{"dormant group activates on first in-scope event, one issue.created", true, false, steps(ev("staging"), ev("production")), 1, "queued", 1},
		{"second out-of-scope event stays dormant", true, false, steps(ev("staging"), ev("staging")), 0, "new", 0},
		{"out-of-scope cannot requeue resolved", true, false, steps(ev("production"), setStatus("resolved"), ev("staging")), 1, "resolved", 1},
		{"in-scope requeues resolved, no second issue.created", true, false, steps(ev("production"), setStatus("resolved"), ev("production")), 2, "queued", 1},
		{"out-of-scope cannot requeue needs_human", true, false, steps(ev("production"), setStatus("needs_human"), ev("staging")), 1, "needs_human", 1},
		{"in-scope requeues needs_human", true, false, steps(ev("production"), setStatus("needs_human"), ev("production")), 2, "queued", 1},
		{"out-of-scope cannot requeue merged", true, false, steps(ev("production"), setStatus("merged"), ev("staging")), 1, "merged", 1},
		{"in-scope requeues merged (release-order rules still apply)", true, false, steps(ev("production"), setStatus("merged"), ev("production")), 2, "queued", 1},
		{"in-scope OLDER release cannot requeue resolved (releaseNotOlder survives the gate rewiring)", true, false, steps(evRel("production", "v2"), setStatusWithRelease("resolved", "v2"), evRel("production", "v1")), 1, "resolved", 1},
		{"scoped with empty allowlist blocks everything", true, true, steps(ev("production")), 0, "new", 0},
	}
}
```

The merged/resolved in-scope requeue-allowed cases use the same release (or empty release) on both events so `releaseNotOlder` passes; the older-release case seeds `resolved_in_release = "v2"` and sends a `v1` event, which must stay `resolved` — proving the gate composes with, and does not replace, the release-order check.

- [ ] **Step 2: Run, expect FAIL** (staging events currently always enqueue; `issue.created` counts differ).

- [ ] **Step 3: Implement.** The helper:

```go
// eventInActionScope reports whether an event from environmentID may trigger
// automation. Under READ COMMITTED this reads the statement snapshot at
// gate-query execution time — the configuration visible when this query runs
// decides; a concurrent settings PATCH applies to whichever gate queries
// execute after its commit.
func eventInActionScope(ctx context.Context, tx pgx.Tx, projectID, environmentID string) (bool, error) {
	var inScope bool
	err := tx.QueryRow(ctx,
		`SELECT (NOT p.action_scope_enabled)
		        OR EXISTS (SELECT 1 FROM project_action_environments pae
		                   WHERE pae.project_id = p.id AND pae.environment_id = $2)
		 FROM projects p WHERE p.id = $1`,
		projectID, environmentID,
	).Scan(&inScope)
	if err != nil {
		return false, fmt.Errorf("action scope check: %w", err)
	}
	return inScope, nil
}
```

Rewire the job-creation section (rollups/sample/affected-users updates above it are untouched):

- Compute `inScope` once, before the `isNew` branch.
- `isNew && inScope` → current new-group path (job with `event_id`, status `queued`, `publishIssueCreated`).
- `isNew && !inScope` → no job, no publish, status stays `new`.
- `!isNew && inScope` → **activation check first**: if group status is `new` and `NOT EXISTS (SELECT 1 FROM error_group_jobs WHERE error_group_id = $1)`, run the new-group path (job + `queued` + `publishIssueCreated` — first enqueue keeps the event's meaning). Otherwise the existing requeue logic runs unchanged (including `releaseNotOlder`).
- `!isNew && !inScope` → skip the requeue logic entirely.

Guided jobs (`EnqueueGuidedFixJob`) intentionally do **not** call `eventInActionScope` — add one test to this file: on a scoped project with an empty allowlist, ingest one event **while the project is still unscoped** so the group gets investigated state legitimately, set the group's status to `investigated` via direct UPDATE (`EnqueueGuidedFixJob` requires `kind='error' AND status='investigated'`, `queries.go:1290`), then enable the empty-allowlist scope and call `EnqueueGuidedFixJob`. It must create a fix job stamped with the current `sample_event_id` — proving scope bypass, not tripping status validation.

- [ ] **Step 4: Run the table test and the full package**

Run: `cd packages/ingestion && go test ./db -run TestActionScopeGate -v && go test ./...`
Expected: all PASS, zero skips with `DATABASE_URL` set.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/db/error_group_ingestion_test.go
git commit -m "feat(ingestion): environment action scope gates enqueue and requeue, with dormant activation"
```

---

### Task 8: Settings PATCH contract and scope fields on the project response (S3)

**Files:**
- Modify: `packages/ingestion/handler/read_api.go` — project response DTO (`:153-165`) and the settings PATCH handler (`:684-735`)
- Modify: `packages/ingestion/db/environments.go` — `SetProjectActionScope` + `GetProjectActionScope`
- Test: the handler test file colocated with `read_api.go`'s existing settings tests

**Interfaces:**
- Consumes: Task 6 schema.
- Produces: PATCH body field `action_environment_ids` (tri-state); project GET/list response fields `action_scope_enabled bool`, `action_environment_ids []string`; `SetProjectActionScope(ctx, tx, orgID, projectID string, environmentIDs *[]string) error` (takes the caller's tx); `GetProjectActionScope(ctx, orgID, projectID string) (bool, []string, error)`.

- [ ] **Step 1: Failing handler tests.** PATCH cases + GET round-trip:

| body | expected |
| --- | --- |
| field omitted | scope unchanged |
| `"action_environment_ids": null` | `enabled=false`, membership cleared |
| `"action_environment_ids": []` | `enabled=true`, empty membership |
| `"action_environment_ids": ["<env-of-this-project>"]` | `enabled=true`, one row |
| `"action_environment_ids": ["<dup>", "<dup>"]` | 200, one row (duplicates collapse) |
| `"action_environment_ids": ["<env-of-other-project>"]` | 400, nothing changed |
| `"action_environment_ids": ["not-a-uuid"]` | 400 (validation, not a 500 cast error) |
| GET after each successful PATCH | response `action_scope_enabled` / `action_environment_ids` reflect the stored state |

- [ ] **Step 2: Implement.**

Setter — takes the handler's transaction so the whole PATCH (this field plus `default_environment_id` and any other settings in the same request) commits or rolls back as one unit. If the current handler has no transaction, wrap the settings-update body in one as part of this task; the atomicity claim is for the whole PATCH:

```go
var ErrEnvironmentNotInProject = errors.New("environment does not belong to project")

func SetProjectActionScope(ctx context.Context, tx pgx.Tx, orgID, projectID string, environmentIDs *[]string) error {
	enabled := environmentIDs != nil
	tag, err := tx.Exec(ctx,
		`UPDATE projects SET action_scope_enabled = $3
		 WHERE id = $1 AND org_id = $2`, projectID, orgID, enabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM project_action_environments WHERE project_id = $1`, projectID); err != nil {
		return err
	}
	if !enabled {
		return nil
	}
	seen := make(map[string]struct{}, len(*environmentIDs))
	for _, envID := range *environmentIDs {
		if _, dup := seen[envID]; dup {
			continue // duplicates collapse silently
		}
		seen[envID] = struct{}{}
		tag, err := tx.Exec(ctx,
			`INSERT INTO project_action_environments (project_id, environment_id)
			 SELECT $1, e.id FROM environments e WHERE e.id = $2 AND e.project_id = $1`,
			projectID, envID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return fmt.Errorf("%w: %s", ErrEnvironmentNotInProject, envID)
		}
	}
	return nil
}
```

Handler:

- Parse `action_environment_ids` with the tri-state `json.RawMessage` idiom `default_environment_id` already uses at `:684-735` (absent / `null` / array).
- **Validate every element parses as a UUID before touching SQL** (the codebase's existing UUID validation idiom; a malformed string must be a 400, never a Postgres cast 500).
- Map `ErrEnvironmentNotInProject` to 400 naming the offending id.
- **Transaction refactor, spelled out:** the PATCH handler today issues independent statements for each settings field. As part of this task, wrap the handler's write path in one `pool.Begin(ctx)` transaction: move the existing `default_environment_id` UPDATE onto the tx, call `SetProjectActionScope(ctx, tx, ...)` on the same tx, single `tx.Commit`. Any error rolls back the whole PATCH — that is the atomicity claim, and the handler test for the 400 cases must assert `default_environment_id` was also left unchanged when scope validation fails in the same request.
- **Response fields, every construction site:** run `grep -n 'DefaultEnvironmentID' packages/ingestion/handler/read_api.go` — every DTO construction that carries `DefaultEnvironmentID` (the single-project response at `:153-165` and any project-list response the grep surfaces) gains `ActionScopeEnabled bool` + `ActionEnvironmentIDs []string` (json `action_scope_enabled`, `action_environment_ids`; always present, `[]` not null when empty), populated via `GetProjectActionScope` (flag from `projects`; ids from `project_action_environments` ordered by `created_at, environment_id` — rows inserted in one transaction share a timestamp, so `environment_id` is the deterministic tiebreaker). The GET round-trip test in Step 1 covers the single-project path; add one list-response assertion if the grep shows a list DTO carries the field.

- [ ] **Step 3: Run handler + db tests, expect PASS. Commit.**

```bash
cd packages/ingestion && go test ./handler ./db
git add packages/ingestion
git commit -m "feat(ingestion): project action-scope PATCH contract, scope fields on project responses"
```

---

### Task 9: Settings UI + end-to-end proof (S3)

**Files:**
- Modify: `packages/dashboard/src/views/Settings.vue`, `packages/dashboard/src/api.ts`
- Test: colocated Settings component test (follow the pattern of the existing view tests in `packages/dashboard/src/views/__tests__/`); then the live smoke

**Interfaces:**
- Consumes: Task 8's PATCH field and response fields.

- [ ] **Step 1: API types.** In `api.ts`: add `action_scope_enabled: boolean` and `action_environment_ids: string[]` to the project type; add `action_environment_ids?: string[] | null` to the settings-update payload type (omit = unchanged, mirroring the wire contract).

- [ ] **Step 2: Failing component tests** for the scope control:

- renders toggle off when GET returns `action_scope_enabled: false`; on + boxes checked per `action_environment_ids` when true
- toggle off → save payload contains `action_environment_ids: null`
- toggle on, none checked → payload `[]`, and the fails-closed copy is visible: "No environments selected — automatic investigation is off for this project."
- toggle on, two checked → payload has exactly those ids
- save failure (mock 400) → control re-renders from the last-known server state, error surfaced via the view's existing error idiom (no silent divergence)

- [ ] **Step 3: Implement the control** in `Settings.vue` next to the existing default-environment control: a toggle ("Limit automation to specific environments") and, when on, one checkbox per environment from the environments list the view already loads. Run the component tests to green.

- [ ] **Step 4: Build + unit tests**

Run: `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test`

- [ ] **Step 5: Live smoke (the S3 exit proof).** Per repo `AGENTS.md`: apply migrations, run `scripts/seed-e2e.sql`, rebuild ingestion + worker images, export the port/URL env block (worktree note in `AGENTS.md` if ports are taken). Then:

1. Create `production` and `staging` environments on the seeded project; PATCH scope to `[production-id]`.
2. Send an event with `environment: staging` to `$INGESTION_URL/api/v1/events` → assert via SQL: group exists, `error_group_environments` row exists, zero `error_group_jobs` rows, status `new`, zero `issue.created` rows in `outbound_events` for the group.
3. Send a same-fingerprint event with `environment: production` → assert: exactly one job, its `event_id` = the production event's id, status `queued`, exactly one `issue.created`.
4. Terminal state: the smoke's purpose is the gate (steps 2-3); the terminal assertion just proves the anchored job flows through the pipeline rather than wedging. Reuse the existing e2e terminal contract: run the smoke with the same environment the `test-e2e` suite uses (its compose/env setup defines the worker's provider configuration), and assert the same terminal predicate that suite asserts for an investigation job on the seeded project — poll up to 120s for the group leaving `queued`/`analyzing` into any status the e2e suite accepts as terminal, with `reason_code IS NOT NULL` whenever the status is `needs_human` (the `needs_human` reason contract). Pin the exact expected status set by reading the assertion in `test-e2e` at implementation time rather than inventing a parallel contract here.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard
git commit -m "feat(dashboard): action-scope settings UI"
```

---

### Task 10: Docs and rollout note

**Files:**
- Modify: `docs/contracts/` — add the PATCH field to whichever contract doc covers project settings (check the `docs/contracts/` index; create `docs/contracts/action-scope.md` if none covers it)

- [ ] **Step 1: Document**

- The PATCH tri-state contract (omitted / `null` / `[]` / ids) and its validation (400 on malformed UUID or foreign environment).
- Fails-closed semantics: enabled + empty allowlist = automation off; environment deletion cascades membership but never flips the flag.
- Dormant activation and `issue.created` meaning first automation enqueue.
- Guided/human jobs bypass scope; `sample_event_id` display semantics unchanged (cross-environment sample on filtered reads is a known v1 limitation).
- **Deployment order** (distinct from commit order): S2 = migration 046 → worker → ingestion; S3 = migration 047 → gate-bearing ingestion everywhere → settings PATCH/UI. A customer must never be able to configure a scope the ingest path ignores.
- S4 (scoped priority + affected-users environment dimension) is intentionally out of this plan; separate plan after S3 lands.

- [ ] **Step 2: Commit**

```bash
git add docs
git commit -m "docs: action-scope contract and rollout ordering"
```

---

## Self-review notes

- Spec coverage: design D4 → Tasks 1-2; D2 → Tasks 3-5; D1 → Tasks 6-9; D3 deferred (Task 10 records it). The design's deploy-order constraint is a Global Constraint and re-stated in Task 10.
- Type consistency: `eventInActionScope` (Task 7) matches Task 6 schema; worker `eventId` (Task 5) maps Task 3's column through `claimJob`; `SetProjectActionScope`'s tri-state matches Task 8's table and Task 9's payload; `resolveEvidenceEventId` is defined in Task 5 and used only there.
- Fixture-helper names in Tasks 4/5/7 are explicitly "follow the file's local idiom"; assertions and SQL are literal.
