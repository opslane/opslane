# Post-Triage Alert Delivery (W-C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Slack destination choose to be alerted when an issue reaches a triage terminal with a known outcome, instead of at ingest time when nothing is known but the title.

**Architecture:** `notification_destinations` gains `delivery_policy` (`immediate` | `post_triage`). `immediate` is today's behavior, unchanged and default. `post_triage` suppresses the ingest-time `issue.created` and instead delivers an `issue.triaged` message when the worker transitions the group into `needs_human` or `pr_created`. Emission is appended **to each existing status-writing statement as a CTE**, gated on the same `status IS DISTINCT FROM` transition test the code already uses for `needs_human_at` — so the write and the alert are one atomic statement and no writer loses its lease guard.

**Tech Stack:** Go 1.24 (`packages/ingestion`: migration, outbox filter, settings API, Slack formatter), Node 22 + TypeScript (`packages/worker`: outbox CTE, payload construction), Postgres.

**Spec:** `docs/superpowers/plans/2026-08-12-adjudication-grounding-and-alert-policy.md` §W-C (design, lines 76-93) and §CP-C (AC-C.1 through AC-C.9, lines 110-122). **Read the spec before starting.** The deferral at spec line 135 is discharged: C4 merged as #351, C5 as #360.

### Deliberate deviation from the spec — read this first

Spec item 1 (line 86) calls for a single worker helper that owns all `error_groups.status` SQL, with the other writers refactored to call it. **This plan does not do that**, for a reason the spec did not account for:

`updateGroupStatus` (`packages/worker/src/db.ts:998-1045`) wraps its `UPDATE` in a lease-ownership CTE — `WITH owned AS (SELECT id FROM error_group_jobs WHERE id = $14 AND worker_id = $15 AND lease_generation = $16::bigint … FOR UPDATE)` plus `AND EXISTS (SELECT 1 FROM owned)`. Its parameters run to `$16`, and the other writers have their own shapes. A generic helper taking "extra assignment fragments plus a values array" would either renumber those placeholders incorrectly or drop the lease predicate — and dropping it lets a stale worker mutate a group, violating the lease contract in `packages/worker/AGENTS.md`.

Instead: each writer keeps its own SQL, its own parameters, and its own lease guard, and gains a shared **SQL fragment** appended as a CTE. The spec's actual goal — no terminal transition can reach the database without enqueuing the alert — is then proven by an integration test that drives **every** writer path (AC-C.8), not by a source grep. A grep over `db.ts` is kept only as an advisory tripwire; it cannot prove "unrepresentable" (it misses `UPDATE public.error_groups`, quoted identifiers, and any write outside that file, and it false-positives on comments and test strings).

## Global Constraints

- `delivery_policy` values are exactly `'immediate'` and `'post_triage'`. Default `'immediate'`.
- **The policy transforms *when* the existing `issue.created` subscription delivers; it is not a new subscription.** `issue.triaged` is an internal payload/formatter type. The destination create/update API must NOT accept it in `event_types`. (Spec line 81.)
- There is exactly **one** event-type allowlist in the codebase — the subscription allowlist at `packages/ingestion/handler/notifications.go:23`. It must NOT gain `issue.triaged`. Dispatch is gated by the `switch` in `notify.FormatSlack` (`notify/slack.go:32`) and by `EventPayload.Validate` (`notify/event.go:20`); those are the two places that change.
- Dedup key is `issue.triaged:<groupID>:<terminalJobID>`. The terminal job ID is **mandatory** on every emitting transition and **stable across retries of that job**; a reopened regression must carry a new job id. A null job id must fail loudly, never silently skip emission. (Spec line 88.)
- Payload carries **no model prose**. `reason_message` and `root_cause` never enter it. The `label` comes from a fixed template table keyed on **(terminal status, reason_code)** — never reason_code alone, because every `code_fix` decision carries `low_confidence_fix` and would announce a successful PR as "low confidence fix". (Spec line 89.)
- `insight` / `not_actionable` emit **nothing**; those groups reach humans through the daily digest. (Spec line 93.)
- Migrations are append-only and idempotent; next number is **053** (latest on main is `052_route_map_enforcement.sql`).
- Terminal-status and lease contracts are preserved. Fix the implementation, never the contract (root `AGENTS.md`).
- Every `needs_human` write still requires non-empty `reason_code`, `reason_message`, `remediation` (`packages/worker/AGENTS.md`).
- **Use the test helpers this repo actually has.** Verified signatures:
  - `seedNotificationProject(t *testing.T, q *db.Queries, name string) (orgID, projectID, environmentID string)` — **creates no destination**.
  - `destinationFixture(projectID, name string) db.NotificationDestination` — a `slack` destination on `issue.created`, `Enabled: true`.
  - Also present: `applyMigration`, `applyMigrationList`, `seedTenant`, `seedGroup`, `newTestRouter`, `newChiRouteContext`.

  Names from an earlier draft — `newDisposableDatabase`, `seedProject`, `seedDestination`, `newTestDependencies`, `postDestination`, `newAuthenticatedRequest` — **do not exist**; neither does any `env` wrapper struct with `.Pool`. Every task that needs a new helper declares it in its Interfaces block and says so in the commit message.

---

### Task 1: Migration 053 — `delivery_policy` column and named constraint

**Satisfies:** AC-C.1.

**Files:**
- Create: `packages/ingestion/db/migrations/053_delivery_policy.sql`
- Test: the migration test file that already uses `applyMigration` / `applyMigrationList`

**Interfaces:**
- Consumes: nothing.
- Produces: column `notification_destinations.delivery_policy TEXT NOT NULL DEFAULT 'immediate'`; constraint `notification_destinations_delivery_policy_check`.

- [ ] **Step 1: Write the failing test**

```go
func TestMigration053_DeliveryPolicyIsIdempotentAndEnforced(t *testing.T) {
	// Use this file's real database fixture and migration runner. Do not invent
	// a newDisposableDatabase helper -- it does not exist.
	ctx := context.Background()

	applyMigrationList(t, pool)
	applyMigrationList(t, pool) // reapply: must be clean

	var defaultValue string
	if err := pool.QueryRow(ctx,
		`SELECT column_default FROM information_schema.columns
		 WHERE table_name = 'notification_destinations' AND column_name = 'delivery_policy'`).Scan(&defaultValue); err != nil {
		t.Fatalf("delivery_policy column missing: %v", err)
	}
	if !strings.Contains(defaultValue, "immediate") {
		t.Errorf("default must be 'immediate', got %q", defaultValue)
	}

	// Constraint names are per-relation, not database-global. Assert on THIS table.
	var constraintName string
	if err := pool.QueryRow(ctx,
		`SELECT conname FROM pg_constraint
		 WHERE conrelid = 'notification_destinations'::regclass
		   AND conname = 'notification_destinations_delivery_policy_check'`).Scan(&constraintName); err != nil {
		t.Fatalf("named check constraint missing on notification_destinations: %v", err)
	}

	// Enforcement must be proven against a REAL ROW. An UPDATE ... WHERE true on
	// an empty table affects zero rows and succeeds, proving nothing.
	_, projectID, _ := seedNotificationProject(t, queries, "constraint")
	destination := destinationFixture(projectID, "slack")
	insertDestination(t, queries, destination)
	_, err := pool.Exec(ctx,
		`UPDATE notification_destinations SET delivery_policy = 'whenever' WHERE id = $1`, destination.ID)
	if err == nil {
		t.Fatal("constraint did not reject an invalid delivery_policy")
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("want check_violation (SQLSTATE 23514), got %v", err)
	}
	if pgErr.ConstraintName != "notification_destinations_delivery_policy_check" {
		t.Errorf("wrong constraint fired: %q", pgErr.ConstraintName)
	}
}

func TestMigration053_RecoversFromPartialApply(t *testing.T) {
	// The failure boundary is: column added, constraint not yet added.
	ctx := context.Background()
	applyMigrationList(t, pool)

	if _, err := pool.Exec(ctx,
		`ALTER TABLE notification_destinations DROP CONSTRAINT notification_destinations_delivery_policy_check`); err != nil {
		t.Fatalf("simulate partial apply: %v", err)
	}

	applyMigrationList(t, pool)

	var constraintName string
	if err := pool.QueryRow(ctx,
		`SELECT conname FROM pg_constraint
		 WHERE conrelid = 'notification_destinations'::regclass
		   AND conname = 'notification_destinations_delivery_policy_check'`).Scan(&constraintName); err != nil {
		t.Fatalf("re-run must restore the constraint: %v", err)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/ingestion && go test ./db/ -run TestMigration053 -v`
Expected: FAIL — `delivery_policy column missing`.

- [ ] **Step 3: Write the migration**

Add `insertDestination(t, queries, destinationFixture(...))` if the test file has no insert helper yet — `destinationFixture` already exists and builds the row.

Create `packages/ingestion/db/migrations/053_delivery_policy.sql`:

```sql
-- Per-destination delivery policy for issue.created.
-- 'immediate' preserves today's behavior: alert at ingest, on the first event.
-- 'post_triage' holds the same subscription until the worker reaches a triage
-- terminal, then delivers issue.triaged with a known outcome instead.
ALTER TABLE notification_destinations
  ADD COLUMN IF NOT EXISTS delivery_policy TEXT NOT NULL DEFAULT 'immediate';

-- Separate, independently guarded statement: a partial apply that stops between
-- the column and the constraint is repaired by re-running the migration.
-- conrelid is required -- constraint names are unique per relation, not per
-- database, so an unscoped conname probe would skip this constraint whenever any
-- other table happens to carry the same name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'notification_destinations'::regclass
      AND conname = 'notification_destinations_delivery_policy_check'
  ) THEN
    ALTER TABLE notification_destinations
      ADD CONSTRAINT notification_destinations_delivery_policy_check
      CHECK (delivery_policy IN ('immediate', 'post_triage'));
  END IF;
END $$;
```

`ADD COLUMN IF NOT EXISTS` will not repair a column that already exists with the wrong type or default; if the test reports a wrong default, drop the column on the disposable database and re-run rather than patching around it. `notification_destinations` is small (one row per destination), so the `ACCESS EXCLUSIVE` lock and the constraint's validation scan are not a concern here; do not copy this shape onto a large table without `NOT VALID` + `VALIDATE CONSTRAINT`.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd packages/ingestion && go test -count=1 -json ./db/ > /tmp/db-test.json; echo "exit=$?"
grep -c '"Action":"skip"' /tmp/db-test.json
```

Expected: `exit=0` and `0` skips. Capture to a file rather than piping into `grep -c` — `grep` exits non-zero on zero matches, so a pipeline reports failure on the good result and hides `go test`'s real exit status. A skipped DB suite reports `ok` while proving nothing — export the `DATABASE_URL` block from the root `AGENTS.md` if you see skips.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/migrations/053_delivery_policy.sql packages/ingestion/db/
git commit -m "feat(ingestion): add notification_destinations.delivery_policy (migration 053)"
```

---

### Task 2: `publishIssueCreated` honors `immediate`

**Satisfies:** AC-C.2, and the first half of AC-C.3.

**Files:**
- Modify: `packages/ingestion/db/notifications.go` — the `hasDestination` probe at :212 **and** the destinations CTE at :248
- Test: the notifications test file in `packages/ingestion/db/`

**Interfaces:**
- Consumes: migration 053 (Task 1).
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

```go
func TestPublishIssueCreated_SkipsPostTriageDestinations(t *testing.T) {
	ctx := context.Background()
	// Real signature: (t, *db.Queries, name) -> (orgID, projectID, environmentID).
	// It creates NO destination; build them from destinationFixture.
	_, projectID, environmentID := seedNotificationProject(t, queries, "policy")

	immediate := destinationFixture(projectID, "immediate")
	postTriage := destinationFixture(projectID, "post-triage")
	postTriage.DeliveryPolicy = "post_triage"
	insertDestination(t, queries, immediate)
	insertDestination(t, queries, postTriage)

	groupID := ingestFirstEvent(t, projectID, environmentID)

	rows, err := pool.Query(ctx,
		`SELECT d.destination_id FROM outbound_deliveries d
		 JOIN outbound_events e ON e.id = d.event_id
		 WHERE e.event_type = 'issue.created' AND e.payload->'issue'->>'id' = $1`, groupID)
	if err != nil {
		t.Fatalf("query deliveries: %v", err)
	}
	defer rows.Close()
	var deliveries []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		deliveries = append(deliveries, id)
	}

	if len(deliveries) != 1 || deliveries[0] != immediate.ID {
		t.Errorf("only the immediate destination may receive issue.created, got %v (immediate=%s post_triage=%s)",
			deliveries, immediate.ID, postTriage.ID)
	}
}

func TestPublishIssueCreated_NoEventRowWhenEveryDestinationIsPostTriage(t *testing.T) {
	_, projectID, environmentID := seedNotificationProject(t, queries, "policy")
	only := destinationFixture(projectID, "post-triage")
	only.DeliveryPolicy = "post_triage"
	insertDestination(t, queries, only)

	groupID := ingestFirstEvent(t, projectID, environmentID)

	var events int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM outbound_events WHERE event_type = 'issue.created' AND payload->'issue'->>'id' = $1`,
		groupID).Scan(&events); err != nil {
		t.Fatalf("count: %v", err)
	}
	if events != 0 {
		t.Errorf("no immediate destination means no issue.created event row, got %d", events)
	}
}
```

`destinationFixture` gains a `DeliveryPolicy` field (defaulting to `"immediate"` so every existing caller is unaffected). `insertDestination` and `ingestFirstEvent` are new helpers this task adds; list them in the commit message.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ingestion && go test ./db/ -run TestPublishIssueCreated -v`
Expected: FAIL — both destinations receive the alert.

- [ ] **Step 3: Write the implementation**

Both destination selections change. The probe at :212:

```go
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM notification_destinations
			WHERE project_id = $1 AND enabled AND 'issue.created' = ANY(event_types)
			  AND delivery_policy = 'immediate'
		)`, projectID).Scan(&hasDestination); err != nil {
```

and the CTE at :248:

```go
		WITH destinations AS (
			SELECT id FROM notification_destinations
			WHERE project_id = $1 AND enabled AND $2 = ANY(event_types)
			  AND delivery_policy = 'immediate'
		), event AS (
```

Both are required. The probe alone still writes an orphaned `outbound_events` row with no deliveries; the CTE alone still pays for the name lookups and payload build on a project with no immediate destinations.

- [ ] **Step 4: Run the tests to verify they pass**

Run `go test -count=1 -json ./db/ ./handler/` to a file and check `exit=0` with `0` skips, as in Task 1 Step 4. Existing `issue.created` tests must pass unchanged — destinations seeded without an explicit policy default to `immediate`.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/
git commit -m "feat(ingestion): hold issue.created for post_triage destinations"
```

---

### Task 3: Expose `delivery_policy` through the settings API

**Satisfies:** the settings half of spec item 5.

**Files:**
- Modify: `packages/ingestion/handler/notifications.go` (request/response structs at :36, :57, :64; create at ~:143-172; update at ~:208-235)
- Modify: `packages/ingestion/db/notifications.go` (create/update/read column lists)
- Modify: the dashboard's notification destination type
- Test: `packages/ingestion/handler/` notifications test file (uses `newTestRouter`)

**Interfaces:**
- Consumes: migration 053.
- Produces: `delivery_policy` on the create request (optional, defaults `"immediate"`), the update request (optional pointer), and the destination response.

- [ ] **Step 1: Write the failing test**

```go
func TestCreateDestination_AcceptsDeliveryPolicy(t *testing.T) {
	router := newTestRouter(t)

	recorder := postJSON(t, router, "/api/v1/notifications/destinations",
		`{"name":"triage only","webhook_url":"https://hooks.slack.com/services/T/B/x","delivery_policy":"post_triage"}`)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create failed: %d %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		DeliveryPolicy string   `json:"delivery_policy"`
		EventTypes     []string `json:"event_types"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.DeliveryPolicy != "post_triage" {
		t.Errorf("delivery_policy not persisted, got %q", response.DeliveryPolicy)
	}
	// The policy is not a subscription: event_types is untouched by it.
	if !slices.Contains(response.EventTypes, "issue.created") {
		t.Errorf("post_triage must keep the issue.created subscription, got %v", response.EventTypes)
	}
}

func TestCreateDestination_DefaultsToImmediate(t *testing.T) {
	router := newTestRouter(t)
	recorder := postJSON(t, router, "/api/v1/notifications/destinations",
		`{"name":"default","webhook_url":"https://hooks.slack.com/services/T/B/x"}`)
	var response struct {
		DeliveryPolicy string `json:"delivery_policy"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &response)
	if response.DeliveryPolicy != "immediate" {
		t.Errorf("omitted policy must default to immediate, got %q", response.DeliveryPolicy)
	}
}

func TestCreateDestination_RejectsUnknownPolicy(t *testing.T) {
	router := newTestRouter(t)
	recorder := postJSON(t, router, "/api/v1/notifications/destinations",
		`{"name":"bad","webhook_url":"https://hooks.slack.com/services/T/B/x","delivery_policy":"whenever"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Errorf("unknown delivery_policy must be rejected at the API, got %d", recorder.Code)
	}
}

func TestCreateDestination_RejectsIssueTriagedAsASubscription(t *testing.T) {
	router := newTestRouter(t)
	recorder := postJSON(t, router, "/api/v1/notifications/destinations",
		`{"name":"bad","webhook_url":"https://hooks.slack.com/services/T/B/x","event_types":["issue.triaged"]}`)
	if recorder.Code != http.StatusBadRequest {
		t.Errorf("issue.triaged is not user-selectable, got %d", recorder.Code)
	}
}
```

Use the file's existing request helper rather than `postJSON` if one is already defined.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ingestion && go test ./handler/ -run TestCreateDestination -v`
Expected: FAIL — `delivery_policy` absent from the response.

- [ ] **Step 3: Write the implementation**

Next to the subscription allowlist at :23, add a **separate** map:

```go
var supportedDeliveryPolicies = map[string]struct{}{
	"immediate":   {},
	"post_triage": {},
}
```

The allowlist at :23 is the subscription allowlist and must NOT gain `issue.triaged` — `TestCreateDestination_RejectsIssueTriagedAsASubscription` pins that.

Add `DeliveryPolicy string` (create request), `DeliveryPolicy *string` (update request), and `DeliveryPolicy string \`json:"delivery_policy"\`` (response). In the create handler, right after the `event_types` defaulting at :148:

```go
	if request.DeliveryPolicy == "" {
		request.DeliveryPolicy = "immediate"
	}
	if _, ok := supportedDeliveryPolicies[request.DeliveryPolicy]; !ok {
		writeJSONError(w, http.StatusBadRequest, "delivery_policy contains an unsupported value")
		return
	}
```

Mirror it in the update handler under a nil check on the pointer. Thread the value into the `INSERT`/`UPDATE` column lists in `db/notifications.go` and into the `SELECT` in the read helper.

On the dashboard, add `delivery_policy: 'immediate' | 'post_triage'` to the destination type **and a control that sets it** — a two-option radio on the destination form, labelled "Alert immediately" / "Alert after triage". A type-only change ships an API field no user can reach, which means the feature is unusable without a database write.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/ingestion && go test -count=1 ./handler/ ./db/ && pnpm --filter @opslane/dashboard build`

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/notifications.go packages/ingestion/db/notifications.go packages/ingestion/handler/ packages/dashboard/
git commit -m "feat(ingestion): expose delivery_policy on the notification settings API"
```

---

### Task 4: Emit `issue.triaged` from inside each status-writing statement

**Satisfies:** AC-C.5, AC-C.7, AC-C.8.

**Rationale:** `updateGroupStatus` already computes "is this a new transition" in SQL, at `db.ts:1032-1041`:

```sql
needs_human_at = CASE
  WHEN $3::error_group_status = 'needs_human'
       AND status IS DISTINCT FROM 'needs_human' THEN now()
  ELSE needs_human_at
END,
```

`status IS DISTINCT FROM $3` inside the `UPDATE` reads the pre-update row. That is the transition test, it is already proven in this codebase, and it needs no previous-status round trip — which is what makes this safe. A `RETURNING (SELECT status FROM error_groups WHERE id = $1)` subquery would **not** work: the scalar subquery reads the statement snapshot, so under `READ COMMITTED` a concurrent update can leave it stale.

Emission is appended as a CTE on the **same statement**, so the status write and the outbox row commit together or not at all. If they were separate statements, a status commit followed by an outbox failure would lose the alert permanently — the retry would see the terminal status already present and suppress emission.

**Files:**
- Modify: `packages/worker/src/db.ts` — `updateGroupStatus` (:966), `updateGroupInvestigation` (:2163), `updateGroupAndCreateFixJob` (:2273), and the PR-creation path
- Test: `packages/worker/src/__tests__/issue-triaged-emission.test.ts` (new; colocated per root `AGENTS.md`)

**Interfaces:**
- Consumes: migration 053.
- Produces (all in `packages/worker/src/db.ts`):
  - `export function isTriageTerminalStatus(status: string): boolean` — pure; `needs_human` or `pr_created`.
  - `export function triageLabel(status: 'needs_human' | 'pr_created', reasonCode: string | null): string`
  - `export function triagedDedupKey(groupId: string, terminalJobId: string): string`
  - `export function incidentURL(base: string | undefined, groupId: string, projectId: string): string`
  - `function buildTriagedPayload(row): object`
  - `function triagedOutboxCte(params: { statusParam: string; projectParam: string; payloadParam: string; dedupParam: string }): string` — the SQL fragment. Callers pass their own placeholder strings, so no writer's numbering is rewritten.

**New test helpers this task adds** (none of these exist yet; add them in the test file and list them in the commit message):

```ts
seedTerminalReadyGroup(opts: {
  deliveryPolicy: 'immediate' | 'post_triage';
  reason_message?: string;
  root_cause?: string;
}): Promise<{ groupId: string; jobId: string; projectId: string; lease: JobLease }>
countTriagedEvents(groupId: string): Promise<number>
fetchTriagedPayload(groupId: string): Promise<unknown>
reopenGroup(groupId: string): Promise<void>
seedFixJob(groupId: string): Promise<string>
// One driver per writer path, for the AC-C.8 coverage table:
runInvestigationNeedsHuman(groupId: string): Promise<void>
runInvestigationInsight(groupId: string): Promise<void>
runFixFailure(groupId: string): Promise<void>
runWorkerRuntimeError(groupId: string): Promise<void>
runPrSuccess(groupId: string): Promise<void>
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { isTriageTerminalStatus } from '../db.js';

describe('isTriageTerminalStatus', () => {
  it('covers exactly the two statuses a human must be paged for', () => {
    expect(isTriageTerminalStatus('needs_human')).toBe(true);
    expect(isTriageTerminalStatus('pr_created')).toBe(true);
    // insight / not_actionable reach humans through the daily digest (spec line 93).
    expect(isTriageTerminalStatus('insight')).toBe(false);
    expect(isTriageTerminalStatus('investigated')).toBe(false);
    expect(isTriageTerminalStatus('fixing')).toBe(false);
  });
});
```

Then the database-backed emission tests — the ones that actually matter:

```ts
describe('issue.triaged emission', () => {
  it('emits exactly once on the transition into needs_human', async () => {
    const { groupId, jobId } = await seedTerminalReadyGroup({ deliveryPolicy: 'post_triage' });
    await updateGroupStatus(groupId, projectId, 'needs_human', { reason: REASON, terminalFixJobId: jobId }, lease);
    expect(await countTriagedEvents(groupId)).toBe(1);
  });

  it('does not emit a second time when the same terminal job re-runs', async () => {
    // AC-C.5(a): a reclaimed lease re-running the same job must dedup, both by
    // the transition test (status is already needs_human) and by the dedup key.
    const { groupId, jobId } = await seedTerminalReadyGroup({ deliveryPolicy: 'post_triage' });
    await updateGroupStatus(groupId, projectId, 'needs_human', { reason: REASON, terminalFixJobId: jobId }, lease);
    await updateGroupStatus(groupId, projectId, 'needs_human', { reason: REASON, terminalFixJobId: jobId }, lease);
    expect(await countTriagedEvents(groupId)).toBe(1);
  });

  it('emits again for a reopened group under a NEW terminal job id', async () => {
    // AC-C.5(b). The dedup key must include the job id or a regression is
    // permanently silenced.
    const { groupId, jobId } = await seedTerminalReadyGroup({ deliveryPolicy: 'post_triage' });
    await updateGroupStatus(groupId, projectId, 'needs_human', { reason: REASON, terminalFixJobId: jobId }, lease);
    await reopenGroup(groupId);
    const secondJobId = await seedFixJob(groupId);
    await updateGroupStatus(groupId, projectId, 'needs_human', { reason: REASON, terminalFixJobId: secondJobId }, lease);
    expect(await countTriagedEvents(groupId)).toBe(2);
  });

  it('emits nothing when the lease is lost and no row is updated', async () => {
    // A zero-row UPDATE must not enqueue an alert for a group it did not change.
    const { groupId, jobId } = await seedTerminalReadyGroup({ deliveryPolicy: 'post_triage' });
    await updateGroupStatus(groupId, projectId, 'needs_human', { reason: REASON, terminalFixJobId: jobId }, staleLease);
    expect(await countTriagedEvents(groupId)).toBe(0);
  });

  it('emits nothing for immediate destinations', async () => {
    const { groupId, jobId } = await seedTerminalReadyGroup({ deliveryPolicy: 'immediate' });
    await updateGroupStatus(groupId, projectId, 'needs_human', { reason: REASON, terminalFixJobId: jobId }, lease);
    expect(await countTriagedEvents(groupId)).toBe(0);
  });

  it('rejects a terminal transition with no terminal job id', async () => {
    // A null job id would silently skip emission, which is exactly the failure
    // this feature exists to prevent. It must be loud.
    const { groupId } = await seedTerminalReadyGroup({ deliveryPolicy: 'post_triage' });
    await expect(
      updateGroupStatus(groupId, projectId, 'needs_human', { reason: REASON }, lease),
    ).rejects.toThrow(/terminal job id/i);
  });
});

// AC-C.8: drive EVERY status writer into a terminal transition. This, not a
// source grep, is the coverage proof.
describe('every status writer emits', () => {
  it.each([
    ['investigation -> needs_human', runInvestigationNeedsHuman, 1],
    ['investigation -> insight',     runInvestigationInsight,    0],
    ['fix failure -> needs_human',   runFixFailure,              1],
    ['runtime error -> needs_human', runWorkerRuntimeError,      1],
    ['PR success -> pr_created',     runPrSuccess,               1],
  ])('%s emits %i', async (_name, drive, expected) => {
    const { groupId } = await seedTerminalReadyGroup({ deliveryPolicy: 'post_triage' });
    await drive(groupId);
    expect(await countTriagedEvents(groupId)).toBe(expected);
  });
});
```

Add an advisory tripwire, clearly labelled as such:

```ts
// Advisory only. A source grep cannot prove a choke point -- it misses
// `UPDATE public.error_groups`, quoted identifiers, and any write outside this
// file, and it false-positives on comments. The it.each above is the real proof.
it('advisory: every error_groups status write in db.ts carries the triaged CTE', () => {
  const source = readFileSync(new URL('../db.ts', import.meta.url), 'utf8');
  const statusWrites = source.match(/UPDATE\s+error_groups[\s\S]{0,2000}?\bstatus\s*=\s*\$/gi) ?? [];
  expect(statusWrites.length).toBeGreaterThan(0);
  // Every such statement should sit in a query that also references the CTE name.
  expect(source).toContain('triaged_outbox');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @opslane/worker test -- issue-triaged-emission`
Expected: FAIL — `isTriageTerminalStatus` is not exported; no events are emitted.

- [ ] **Step 3: Write the implementation**

```ts
/** The two terminal statuses a post_triage destination is paged for. */
export function isTriageTerminalStatus(status: string): boolean {
  return status === 'needs_human' || status === 'pr_created';
}

/**
 * SQL appended to a status-writing statement so the transition and its alert
 * commit atomically.
 *
 * The caller supplies its OWN placeholder names, because each writer has its
 * own parameter numbering (updateGroupStatus runs to $16 with a lease CTE at
 * $14-$16). Renumbering a writer's parameters from a generic helper is how the
 * lease predicate gets silently dropped.
 *
 * `status IS DISTINCT FROM <statusParam>` reads the PRE-update row inside the
 * same UPDATE -- the same idiom the needs_human_at CASE already uses. Do not
 * replace it with a RETURNING subquery: a scalar subquery reads the statement
 * snapshot and goes stale under concurrent updates at READ COMMITTED.
 */
function triagedOutboxCte(params: {
  statusParam: string;
  projectParam: string;
  payloadParam: string;
  dedupParam: string;
}): string {
  return `, triaged_outbox AS (
    INSERT INTO outbound_events (project_id, event_type, dedup_key, payload)
    SELECT ${params.projectParam}, 'issue.triaged', ${params.dedupParam}, ${params.payloadParam}::jsonb
    WHERE EXISTS (
        SELECT 1 FROM updated_group
        -- Both gates are required and neither is optional:
        --   1. a row exists at all  -> the UPDATE actually changed this group
        --      (a lost lease updates zero rows and must emit nothing);
        --   2. previous_status IS DISTINCT FROM the new status -> this is a
        --      TRANSITION, not a re-run of an already-terminal write;
        --   3. the new status is one a human is paged for -> insight and
        --      not_actionable reach humans through the daily digest instead.
        WHERE previous_status IS DISTINCT FROM ${params.statusParam}::error_group_status
          AND ${params.statusParam}::error_group_status IN ('needs_human', 'pr_created')
      )
      AND EXISTS (
        SELECT 1 FROM notification_destinations
        WHERE project_id = ${params.projectParam} AND enabled
          AND 'issue.created' = ANY(event_types)
          AND delivery_policy = 'post_triage'
      )
    ON CONFLICT (project_id, dedup_key) DO NOTHING
    RETURNING id
  ), triaged_deliveries AS (
    INSERT INTO outbound_deliveries (event_id, destination_id)
    SELECT triaged_outbox.id, d.id
    FROM triaged_outbox
    CROSS JOIN notification_destinations d
    WHERE d.project_id = ${params.projectParam} AND d.enabled
      AND 'issue.created' = ANY(d.event_types)
      AND d.delivery_policy = 'post_triage'
  )`;
}
```

Each writer changes as follows, keeping its own SQL, parameters, and lease guard:

1. Wrap the writer's existing `UPDATE error_groups … RETURNING id` in a named CTE `updated_group`, and carry the previous status into it by joining a `MATERIALIZED` `prior` CTE that reads the row under `FOR UPDATE`. `RETURNING` cannot see the pre-update value of a column the same statement is writing, so the previous status has to come from a locked read in the same statement:

```sql
WITH prior AS MATERIALIZED (
  SELECT id, status AS previous_status
  FROM error_groups
  WHERE id = $1 AND project_id = $2
  FOR UPDATE
)
-- ... existing owned/lease CTE unchanged ...
, updated_group AS (
  UPDATE error_groups AS g
  SET status = $3::error_group_status /* ... existing assignments unchanged ... */
  FROM prior
  WHERE g.id = prior.id AND g.project_id = $2
    /* ... existing lease predicate unchanged ... */
  RETURNING g.id, prior.previous_status
)
```

`prior` takes `FOR UPDATE`, so the previous status is read under a row lock and cannot go stale.

For a leased call, `prior` must be gated on `owned` as well, so a stale worker does not take a row lock on a group it will not update, and so lock acquisition keeps the existing job-then-group order:

```sql
WITH owned AS ( /* unchanged */ ),
prior AS MATERIALIZED (
  SELECT id, status AS previous_status
  FROM error_groups
  WHERE id = $1 AND project_id = $2
    AND EXISTS (SELECT 1 FROM owned)   -- leased calls only
  FOR UPDATE
)
```

2. **Compute the two new placeholders from the array you are about to pass — never from a hardcoded number.** `updateGroupStatus` builds its parameter list conditionally: a leased call occupies `$1`–`$16`, an unleased call only `$1`–`$13`. "Append at the end" is therefore ambiguous and will collide or leave gaps. Do this instead:

```ts
const values: unknown[] = [ /* ... the writer's existing values, lease values included when present ... */ ];
const payloadParam = `$${values.length + 1}`;
const dedupParam = `$${values.length + 2}`;
values.push(JSON.stringify(payload), triagedDedupKey(errorGroupId, terminalJobId));

const sql = `${priorAndOwnedCtes} , updated_group AS ( ${existingUpdate} ) ${triagedOutboxCte({
  statusParam: '$3', projectParam: '$2', payloadParam, dedupParam,
})} SELECT id FROM updated_group`;
```

3. **The statement needs a final top-level query.** A `WITH` chain of data-modifying CTEs is not a complete statement on its own, and the writers' callers already read `RETURNING id` to detect a lost lease. End every rewritten statement with `SELECT id FROM updated_group` and keep the existing zero-rows-means-lease-lost handling pointed at that result.

4. Before issuing the query, throw if this is a terminal transition with no job id:

```ts
if (isTriageTerminalStatus(status) && !terminalJobId) {
  throw new Error(`terminal job id is required to transition group ${errorGroupId} into ${status}`);
}
```

`buildTriagedPayload`, `triagedDedupKey`, `triageLabel`, and `incidentURL` are all defined in **this** task (Step 3b below) — Task 5 only covers the Go side. Task 4 must be buildable and committable on its own.

- [ ] **Step 3b: Write the payload helpers this task depends on**

These are pure functions and belong here, not in Task 5, because Task 4's SQL binds their output.

```ts
/**
 * Human-readable outcome label, keyed on (terminal status, reason_code).
 *
 * Keying on reason_code alone is a known trap: every code_fix decision carries
 * low_confidence_fix, so a successful PR would announce itself as "low
 * confidence fix". No model prose ever reaches this table (program copy rule).
 */
const TRIAGE_LABELS: Record<string, string> = {
  'pr_created:*': 'Fix PR opened',
  'needs_human:insufficient_context': 'Needs review — no verified cause',
  'needs_human:unfixable_third_party': 'Needs review — cause is third-party code',
  'needs_human:unfixable_infra': 'Needs review — infrastructure cause',
  'needs_human:unfixable_no_app_frames': 'Needs review — no application code in the stack',
  'needs_human:worker_runtime_error': 'Needs review — investigation crashed',
  'needs_human:verification_failed': 'Needs review — fix failed verification',
  'needs_human:budget_exhausted': 'Needs review — investigation budget exhausted',
  'needs_human:*': 'Needs review',
};

export function triageLabel(status: 'needs_human' | 'pr_created', reasonCode: string | null): string {
  if (status === 'pr_created') return TRIAGE_LABELS['pr_created:*']!;
  return TRIAGE_LABELS[`needs_human:${reasonCode ?? ''}`] ?? TRIAGE_LABELS['needs_human:*']!;
}

/**
 * Includes the terminal job id so a reclaimed lease dedups to one delivery while
 * a reopened regression -- which gets a NEW job id -- pages again. The group id
 * alone would silence regressions permanently.
 */
export function triagedDedupKey(groupId: string, terminalJobId: string): string {
  return `issue.triaged:${groupId}:${terminalJobId}`;
}

/**
 * Mirrors Go's notify.BuildIncidentURL (packages/ingestion/notify/url.go:11-29),
 * including its rejections: non-http(s) schemes, embedded credentials, and
 * loopback hosts all yield "". The it.each table in Task 5's tests is what keeps
 * the two implementations in step.
 */
export function incidentURL(base: string | undefined, groupId: string, projectId: string): string {
  /* implement to match url.go:11-29 exactly; return '' on every rejection path */
}
```

`buildTriagedPayload` produces:

```ts
{
  version: 1,
  event_type: 'issue.triaged',
  issue: { id, title, first_seen },
  project: { id, name },
  environment,
  dashboard_url: incidentURL(process.env['DASHBOARD_URL'], groupId, projectId),
  outcome: {
    status,
    reason_code: reasonCode,
    label: triageLabel(status, reasonCode),
    impact: { users_7d, anon_sessions_7d },
  },
}
```

`DASHBOARD_URL` is already read in the worker (`packages/worker/src/pipeline.ts:208`) and is the same variable ingestion uses (`packages/ingestion/main.go:147`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`
Expected: PASS. The `it.each` coverage block is what matters — if a writer path emits `0` where `1` is expected, that writer did not get the CTE.

Implement **one writer at a time**, re-running the `it.each` block after each. Four SQL statements with three different parameter shapes is the riskiest step in either plan.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/db.ts packages/worker/src/__tests__/issue-triaged-emission.test.ts
git commit -m "feat(worker): emit issue.triaged atomically with the terminal status write"
```

---

### Task 5: Go-side contract — `Outcome`, tightened `Validate`, Slack formatter, cross-runtime fixture

**Satisfies:** AC-C.3, AC-C.4, AC-C.6, AC-C.9.

The TypeScript payload helpers landed in Task 4. This task is the Go half plus the fixture that pins the two runtimes together.

**Files:**
- Modify: `packages/ingestion/notify/event.go` (`Outcome` field + tightened `Validate`)
- Modify: `packages/ingestion/notify/slack.go` (`issue.triaged` case in `FormatSlack`)
- Create: `test-fixtures/wire/issue-triaged-v1.json`
- Test: `packages/worker/src/__tests__/issue-triaged.test.ts`, `packages/ingestion/notify/slack_test.go`, `packages/ingestion/notify/event_test.go`

**Do not touch** `handler/notifications.go`'s allowlist at :23. `FormatSlack`'s switch and `EventPayload.Validate` are the dispatch gates; there is no second allowlist in this codebase.

**Interfaces:**
- Consumes: Task 4's `buildTriagedPayload`, `triageLabel`, `incidentURL`.
- Produces: `type TriagePayload struct` + `Outcome *TriagePayload \`json:"outcome,omitempty"\`` on `EventPayload`; `formatSlackTriaged`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('triageLabel', () => {
  it('announces a PR for PR-bearing outcomes, not the fix confidence', () => {
    // Every code_fix decision carries low_confidence_fix; keying on reason_code
    // alone would announce a successful PR as "low confidence fix" (spec line 89).
    expect(triageLabel('pr_created', 'low_confidence_fix')).toBe('Fix PR opened');
    expect(triageLabel('pr_created', null)).toBe('Fix PR opened');
  });

  it('names the blocker for needs_human outcomes', () => {
    expect(triageLabel('needs_human', 'insufficient_context')).toBe('Needs review — no verified cause');
    expect(triageLabel('needs_human', 'unfixable_third_party')).toBe('Needs review — cause is third-party code');
    expect(triageLabel('needs_human', 'worker_runtime_error')).toBe('Needs review — investigation crashed');
  });

  it('falls back without inventing prose for an unmapped reason code', () => {
    expect(triageLabel('needs_human', 'some_future_code')).toBe('Needs review');
    expect(triageLabel('needs_human', null)).toBe('Needs review');
  });
});

// The worker duplicates Go's BuildIncidentURL. This pins the duplication so it
// cannot drift, including the rejection cases Go enforces.
describe('incidentURL matches Go BuildIncidentURL', () => {
  it.each([
    ['https://app.example.com', 'https://app.example.com/incidents/G?project_id=P'],
    ['https://app.example.com/', 'https://app.example.com/incidents/G?project_id=P'],
    ['http://localhost:3000', ''],   // loopback rejected
    ['ftp://app.example.com', ''],   // bad scheme rejected
    [undefined, ''],
  ])('%s -> %s', (base, want) => {
    expect(incidentURL(base, 'G', 'P')).toBe(want);
  });
});

it('never leaks model prose into the payload', async () => {
  const sentinel = 'SENTINEL_MODEL_PROSE';
  const { groupId, jobId } = await seedTerminalReadyGroup({
    deliveryPolicy: 'post_triage', reason_message: sentinel, root_cause: sentinel,
  });
  await updateGroupStatus(groupId, projectId, 'needs_human', { reason: REASON, terminalFixJobId: jobId }, lease);

  const payload = await fetchTriagedPayload(groupId);
  expect(JSON.stringify(payload)).not.toContain(sentinel);
  expect(payload).toEqual(JSON.parse(readFileSync('test-fixtures/wire/issue-triaged-v1.json', 'utf8')));
});
```

Go side, in `packages/ingestion/notify/event_test.go` — the tagged union must stay exclusive:

```go
func TestValidate_OutcomeOnlyOnIssueTriaged(t *testing.T) {
	issue := &IssueRef{ID: "g", Title: "t", FirstSeen: "2026-08-13T00:00:00Z"}
	outcome := &TriagePayload{Status: "needs_human", Label: "Needs review"}

	if err := (EventPayload{Version: 1, EventType: "issue.created", Issue: issue, Outcome: outcome}).Validate(); err == nil {
		t.Error("issue.created must reject an outcome body")
	}
	if err := (EventPayload{Version: 1, EventType: "digest.daily", Digest: &DigestPayload{}, Outcome: outcome}).Validate(); err == nil {
		t.Error("digest.daily must reject an outcome body")
	}
	if err := (EventPayload{Version: 1, EventType: "issue.triaged", Issue: issue}).Validate(); err == nil {
		t.Error("issue.triaged requires an outcome body")
	}
	if err := (EventPayload{Version: 1, EventType: "issue.triaged", Issue: issue, Outcome: outcome, Digest: &DigestPayload{}}).Validate(); err == nil {
		t.Error("issue.triaged must reject a digest body")
	}
}
```

and in `slack_test.go`, the Go half of the cross-runtime fixture:

```go
func TestFormatSlackTriaged_DecodesTheSharedFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "test-fixtures", "wire", "issue-triaged-v1.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var payload EventPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("the worker's payload must decode in Go: %v", err)
	}
	if err := payload.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if payload.Outcome == nil || payload.Outcome.Label == "" {
		t.Fatal("the outcome label is what makes the message actionable")
	}

	body, _, err := FormatSlack(payload)
	if err != nil {
		t.Fatalf("format: %v", err)
	}
	if !strings.Contains(string(body), payload.Outcome.Label) {
		t.Error("the rendered Slack message must carry the outcome label")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @opslane/worker test -- issue-triaged` and `cd packages/ingestion && go test ./notify/ -run 'Triaged|Outcome' -v`
Expected: FAIL — `triageLabel` undefined; `EventPayload` has no `Outcome`.

- [ ] **Step 3: Write the implementation**

The TypeScript helpers (`triageLabel`, `triagedDedupKey`, `incidentURL`, `buildTriagedPayload`) are already implemented in Task 4 Step 3b. Do not re-add them here.


In `packages/ingestion/notify/event.go`, add `TriagePayload`, add `Outcome *TriagePayload \`json:"outcome,omitempty"\`` to `EventPayload`, and **tighten every branch** of `Validate` so exactly one body is present:

```go
case "issue.created":
	if payload.Issue == nil || payload.Digest != nil || payload.Outcome != nil {
		return fmt.Errorf("issue.created requires issue body only")
	}
case "digest.daily":
	if payload.Digest == nil || payload.Issue != nil || payload.Outcome != nil {
		return fmt.Errorf("digest.daily requires digest body only")
	}
case "issue.triaged":
	if payload.Issue == nil || payload.Outcome == nil || payload.Digest != nil {
		return fmt.Errorf("issue.triaged requires issue and outcome bodies only")
	}
```

Adding `Outcome` without amending the first two branches would leave `issue.created + outcome` valid, contradicting the "exactly one event body" contract.

In `notify/slack.go`, add `case "issue.triaged": return formatSlackTriaged(payload)` to the switch at :33 and write `formatSlackTriaged` following `formatSlackIssue` (:43-89): same masking (`masking.RedactURL(masking.RedactBody(...))`), same backtick substitution, same `truncate`/`slackEscape`, same `encoder.SetEscapeHTML(false)`. Header text `"Triaged in " + payload.Project.Name`; the section carries the outcome label and impact.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test
cd packages/ingestion && go build ./... || exit 1
go test -count=1 -json ./... > /tmp/ingestion-test.json; echo "exit=$?"
grep -c '"Action":"skip"' /tmp/ingestion-test.json
```

Expected: `exit=0` and `0` skips.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/db.ts packages/ingestion/notify/ test-fixtures/wire/issue-triaged-v1.json packages/worker/src/__tests__/
git commit -m "feat: issue.triaged payload, label table, and Slack formatter"
```

---

### Task 6: Full-pipeline proof and docs

**Satisfies:** AC-C.3 end-to-end, AC-C.4, AC-C.7, AC-C.9, spec item 7.

**Files:**
- Test: `test-e2e/notifications-contract.test.ts` (extend — it already covers "New issue in")
- Modify: `docs/contracts/` notification event catalog
- Modify: `docs/guides/slack.md`

- [ ] **Step 1: Write the failing test**

Extend `test-e2e/notifications-contract.test.ts` with:

- **AC-C.3:** one project, two destinations (`immediate` + `post_triage`), ingest one event, investigation lands `needs_human`. The `immediate` destination gets exactly one `issue.created` and zero `issue.triaged`; the `post_triage` destination gets exactly zero `issue.created` and exactly one `issue.triaged` carrying the label. Cross-delivery in either direction fails.
- **AC-C.4:** investigation lands `insight` — no `issue.triaged` row, and the group still appears in the digest build.
- **AC-C.7:** a fix job dying as `worker_runtime_error` still emits exactly one `issue.triaged`.
- **AC-C.9:** a PR-bearing outcome renders "Fix PR opened", not a confidence phrase.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- notifications-contract`
Expected: FAIL on the `post_triage` assertions.

- [ ] **Step 3: Make it pass and write the docs**

No new production code should be needed. Document in the contracts catalog: `issue.triaged` is an internal payload type, not a subscription; `delivery_policy` is the only user-facing control; the dedup key includes the terminal job id so a reopened regression pages again; `insight`/`not_actionable` deliberately emit nothing.

- [ ] **Step 4: Run the full repository gate**

From the repository root, with the `DATABASE_URL`/MinIO block from `AGENTS.md` exported:

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test -count=1 -json ./... > /tmp/gate.json; echo "exit=$?"; grep -c '"Action":"skip"' /tmp/gate.json)
docker compose config --quiet
```

The Go line must print `0`. Read the **skip count**, not the pass count. Then run the live smoke from the root `AGENTS.md` — this plan changes pipeline behavior, so the smoke is required.

- [ ] **Step 5: Commit**

```bash
git add test-e2e/notifications-contract.test.ts docs/contracts/ docs/guides/slack.md
git commit -m "test(e2e): pin immediate vs post_triage delivery; document the policy"
```

---

## Rollout

Ship with every destination on `immediate` (the migration default), so behavior is unchanged on merge. Flip the AMFJ 2 Slack destination to `post_triage` and confirm the next window-title occurrence produces no ingest-time alert and one `issue.triaged` at the terminal — or, since that error lands `insight`/`not_actionable` roughly a third of the time, no alert at all.

## Self-Review

**Spec coverage.** AC-C.1 → Task 1 (relation-scoped constraint probe; enforcement proven against a real row via SQLSTATE 23514; partial-apply boundary). AC-C.2 → Task 2. AC-C.3 → Tasks 2 + 6. AC-C.4 → Tasks 4 (`insight` expects 0) + 6. AC-C.5 → Task 4 (re-run dedups; reopen under a new job id pages again). AC-C.6 → Task 5 (sentinel + cross-runtime fixture + `Validate` exclusivity). AC-C.7 → Tasks 4 + 6. AC-C.8 → Task 4's `it.each` over every writer path, with the grep demoted to advisory. AC-C.9 → Task 5. Spec item 5 (settings) → Task 3. Item 6 (formatter) → Task 5. Item 7 (docs) → Task 6. **Spec item 1 (single helper) is deliberately not implemented** — see the deviation note; its goal is met by per-writer CTEs plus the coverage test, without dropping the lease predicate. Task 4 also owns the TypeScript payload helpers (Step 3b) so it builds and commits on its own; Task 5 is the Go half plus the cross-runtime fixture.

**Placeholder scan.** One intentional implementation stub: `incidentURL`'s body, which says "match url.go:11-29 exactly" and is fully pinned by an `it.each` table including the rejection cases. Task 6's test bodies are specified as exact assertions rather than written out, because that file's fixtures are the pattern to follow and inventing signatures would repeat the very error this revision fixes.

**Type consistency.** `delivery_policy` is `'immediate' | 'post_triage'` in the migration, the Go map, the API, and the dashboard type. `isTriageTerminalStatus(status)` takes one argument everywhere. `triageLabel(status, reasonCode)`'s `'needs_human' | 'pr_created'` domain matches `isTriageTerminalStatus`'s true set. `triagedDedupKey(groupId, terminalJobId)` produces the key Task 4's CTE binds. `outcome` is the JSON key in the TS builder, the Go struct tag, and the fixture.

**Known weak points, carried deliberately.**

1. Task 4 Step 3 rewrites four SQL statements, each with its own parameter numbering and one with a conditional lease CTE. Placeholders are computed from `values.length`, never hardcoded. Implement one writer at a time, re-running the `it.each` block after each.
2. `incidentURL` duplicates Go's `BuildIncidentURL` in TypeScript. The duplication is real and permanent; the `it.each` parity table including the rejection cases (loopback, bad scheme) is the only thing keeping them in step.
