# Onboarding v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Revision 3 — hardened by two Codex review rounds (18 P1 / 8 P2, then 9 P1 / 11 P2, all folded in). Round 1: M1 backward compatibility with the live wizard, key cap on mint-on-resume, correct `packages/ingestion/github/` paths, redirect-loop closure. Round 2: true completion short-circuit in the evaluator, hard-gate-only `complete`, transactional mint+cap, router completion flag, state-based banners with mutation-event refresh, lease-safe settlement migration (see the self-review record's round-2 list).

**Goal:** Replace the auto-SDK-install-PR wizard with a manual-first onboarding flow whose single hard gate is "first event received"; GitHub and Slack become deferable steps with persistent banners; the setup-PR machinery is deleted.

**Architecture:** Server-derived wizard state (`GET /onboarding/state` + `POST /onboarding/complete` share one fact evaluator; `orgs.onboarded_at` gates wizard entry only). The dashboard wizard renders `next_step` and never derives anything. Milestones: M1 server groundwork (no UI change, old wizard keeps working) → M2 wizard rewrite → M3 setup-PR deletion → M4 docs.

**Tech Stack:** Go 1.24 + chi + pgx (ingestion), Vue 3 + Vitest (dashboard), Node 22 TS (worker), append-only SQL migrations.

**Spec:** `docs/design/2026-08-26-onboarding-v2.md` (read it first; Appendix A holds the acceptance criteria each milestone must meet).

## Global Constraints

- Migrations are append-only, guarded (`IF NOT EXISTS` / idempotent `UPDATE`s), starting at `062` (highest existing is `061_api_key_scope.sql`).
- `POST /api/v1/events` wire contract untouched; never edit `test-fixtures/wire/`.
- No new dependencies. No Redis/queue — the Postgres job queue stays.
- ESM + strict TypeScript; `unknown` + narrowing, never `any`. Vitest tests colocated in `__tests__`.
- Server code is AGPL-3.0-only; nothing here touches the MIT SDK boundary (`packages/sdk` has **no changes** in this plan).
- Every M1 task must leave the **current** wizard working — the old dashboard ships against the M1 server.
- Full gate before claiming a milestone done: `pnpm -r build && pnpm test` (with `DATABASE_URL` exported), `(cd packages/ingestion && go build ./... && go test ./...)` with **zero skips**, `docker compose config --quiet`.
- Go handler tests: external package `handler_test`, helpers `testDeps(t)` / `seedTenant(t, deps.Queries)` / `cleanupTenantHandler`, router via `handler.NewRouterWithPool(deps, pool)`, cloud mode via `deps.AuthProvider = cloudAuthStub{}`. **Copy the auth-acquisition pattern from an existing passing test in the same file you extend** (e.g. how `notifications_test.go` builds its authenticated request) — do not invent token plumbing.
- Dashboard tests: `// @vitest-environment jsdom`, `vi.hoisted()` mock object, `vi.mock('../../api', …)` before importing the SUT, `mount` + `flushPromises`.
- Commit after every task with the message given in its last step. Always `git add <explicit paths>` — never rely on `-a` to pick up untracked files.

---

## Milestone 1 — Server groundwork (Tasks 1–7)

### Task 1: Migration 062 — `orgs.onboarded_at`

**Files:**
- Create: `packages/ingestion/db/migrations/062_onboarding_v2.sql`

**Interfaces:**
- Produces: `orgs.onboarded_at TIMESTAMPTZ NULL` — read by Tasks 2, 6; backfilled non-null for every org that already has a project.

- [ ] **Step 1: Write the migration**

```sql
-- Onboarding v2: one stored completion fact. Set only by POST /onboarding/complete.
-- Backfill marks every org that already has a project as onboarded so existing
-- users never see the new wizard; a projectless org still needs it.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;

UPDATE orgs o
   SET onboarded_at = now()
 WHERE o.onboarded_at IS NULL
   AND EXISTS (SELECT 1 FROM projects p WHERE p.org_id = o.id);
```

- [ ] **Step 2: Apply twice to prove idempotency.** The worktree dev DB is fine for this — the migration is additive plus a guarded backfill, safe on retained data. For a truly clean-state check, spin a disposable Postgres (`docker run --rm -e POSTGRES_PASSWORD=x -p 5599:5432 postgres:16`) and run the full migration directory against it first.

```bash
psql "$DATABASE_URL" -f packages/ingestion/db/migrations/062_onboarding_v2.sql
psql "$DATABASE_URL" -f packages/ingestion/db/migrations/062_onboarding_v2.sql
psql "$DATABASE_URL" -c "SELECT count(*) FILTER (WHERE onboarded_at IS NOT NULL) AS backfilled, count(*) AS total FROM orgs;"
```

Expected: second apply succeeds unchanged; orgs with projects show `onboarded_at` set.

- [ ] **Step 3: Verify the migration runner picks it up**

Run: `cd packages/ingestion && go test ./db -run TestMigrations -v`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ingestion/db/migrations/062_onboarding_v2.sql
git commit -m "feat(ingestion): add orgs.onboarded_at with has-project backfill"
```

### Task 2: Idempotent onboarding setup (backward-compatible)

Rewire `OnboardingSetup` onto the **existing** `ProvisionProject` machinery (`db/queries.go:430-526`, conflict target `(org_id, idempotency_token)` from migration 018) plus the has-project reuse rule and the 409. **Backward compatibility is a requirement:** the live wizard sends `{project_name, github_repo}` with no token, and it must keep working until Task 9 replaces it. So `idempotency_token` is optional (server generates one when absent) and `github_repo` is still passed through to creation.

**Files:**
- Modify: `packages/ingestion/db/queries.go` (new method near `ProvisionProject`, ~line 456)
- Modify: `packages/ingestion/db/project_keys.go` (cap helpers, after `CreateProjectKeyTx` ~line 262)
- Modify: `packages/ingestion/handler/onboarding.go`
- Test: `packages/ingestion/handler/onboarding_test.go` (create if absent)

**Interfaces:**
- Consumes: `provisionProjectTx` (unexported, `queries.go:461`), `EnsureProjectDefaultEnvironmentTx`, `CreateProjectKeyTx(ctx, tx, projectID, ScopeIngest, "onboarding", nil, "")`, `ProjectProvisioning{Project, Environment, APIKey}`, `uuid.NewString()`.
- Produces: `(q *Queries) OnboardingProvision(ctx, orgID, name string, githubRepo *string, idempotencyToken string) (*ProjectProvisioning, error)`; `RevokeExcessOnboardingKeysTx(ctx, tx pgx.Tx, projectID string) error` (keeps the 5 newest live `scope='ingest' AND label='onboarding'` keys); `ErrOrgOnboarded = errors.New("org already onboarded")` in `db`; handler request gains optional `idempotency_token`, response shape unchanged (`{project, environment, api_key:{id, raw_key}}`).

- [ ] **Step 1: Write the failing handler test**

Create `packages/ingestion/handler/onboarding_test.go` (package `handler_test`). First mirror the request-building and auth pattern of an existing test in this package that POSTs an authenticated org-scoped route (open `notifications_test.go` and copy how it obtains a session credential and attaches it — reuse its helper if exported, otherwise reproduce it locally as `onboardingHTTP(t, router, method, path, cred, body string)`). The body helper must send the string **raw** (`strings.NewReader(body)`), not re-marshal it. Seed helpers: if no `seedTenantNoProject` exists in the shared helpers, write one locally (copy `seedTenant`, skip its project insert).

```go
func TestOnboardingSetupIdempotency(t *testing.T) {
	deps, pool := testDeps(t)
	router := handler.NewRouterWithPool(deps, pool)
	orgID, cred := seedTenantNoProject(t, deps.Queries) // adjust returns to your local helper
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	body := `{"project_name":"web","idempotency_token":"tok-1"}`
	first := onboardingHTTP(t, router, "POST", "/api/v1/onboarding/setup", cred, body)
	if first.Code != http.StatusCreated {
		t.Fatalf("first create: got %d body=%s", first.Code, first.Body.String())
	}
	second := onboardingHTTP(t, router, "POST", "/api/v1/onboarding/setup", cred, body)
	if second.Code != http.StatusCreated {
		t.Fatalf("replay: got %d", second.Code)
	}
	var a, b struct {
		Project struct {
			ID string `json:"id"`
		} `json:"project"`
		APIKey struct {
			RawKey string `json:"raw_key"`
		} `json:"api_key"`
	}
	mustDecode(t, first.Body, &a)
	mustDecode(t, second.Body, &b)
	if a.Project.ID != b.Project.ID {
		t.Fatalf("replay created a second project")
	}
	if a.APIKey.RawKey == b.APIKey.RawKey || a.APIKey.RawKey == "" {
		t.Fatalf("expected two distinct working keys")
	}

	// Different token, same org, existing project → same project (no duplicate).
	third := onboardingHTTP(t, router, "POST", "/api/v1/onboarding/setup", cred, `{"project_name":"other","idempotency_token":"tok-2"}`)
	if third.Code != http.StatusCreated {
		t.Fatalf("different-token call: got %d body=%s", third.Code, third.Body.String())
	}
	var c struct {
		Project struct {
			ID string `json:"id"`
		} `json:"project"`
	}
	mustDecode(t, third.Body, &c)
	if c.Project.ID != a.Project.ID {
		t.Fatalf("has-project rule violated: new project created")
	}

	// Legacy client shape (no token) still works on a fresh org.
	orgID2, cred2 := seedTenantNoProject(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID2) })
	legacy := onboardingHTTP(t, router, "POST", "/api/v1/onboarding/setup", cred2, `{"project_name":"legacy","github_repo":"acme/web"}`)
	if legacy.Code != http.StatusCreated {
		t.Fatalf("legacy shape: got %d body=%s", legacy.Code, legacy.Body.String())
	}

	// Mark onboarded → 409.
	if _, err := pool.Exec(context.Background(), `UPDATE orgs SET onboarded_at = now() WHERE id = $1`, orgID); err != nil {
		t.Fatal(err)
	}
	fourth := onboardingHTTP(t, router, "POST", "/api/v1/onboarding/setup", cred, body)
	if fourth.Code != http.StatusConflict {
		t.Fatalf("onboarded org: got %d, want 409", fourth.Code)
	}
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd packages/ingestion && go test ./handler -run TestOnboardingSetupIdempotency -v`
Expected: FAIL (replay currently creates a second project; 409 branch missing).

- [ ] **Step 3: Add the db method and cap helpers**

In `db/queries.go`, after `ProvisionProject`:

```go
// ErrOrgOnboarded rejects onboarding setup for an org whose wizard already completed.
var ErrOrgOnboarded = errors.New("org already onboarded")

// OnboardingProvision is the wizard's project bootstrap. Serialized per org via
// an advisory lock so two devices cannot race a first project into existence.
// Rules: onboarded org → ErrOrgOnboarded; org with an existing project → that
// project plus a fresh onboarding ingest key; otherwise token-idempotent create.
func (q *Queries) OnboardingProvision(ctx context.Context, orgID, name string, githubRepo *string, idempotencyToken string) (*ProjectProvisioning, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("onboarding provision: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('onboard-' || $1))`, orgID); err != nil {
		return nil, fmt.Errorf("onboarding provision: lock: %w", err)
	}

	var onboardedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT onboarded_at FROM orgs WHERE id = $1`, orgID).Scan(&onboardedAt); err != nil {
		return nil, fmt.Errorf("onboarding provision: org lookup: %w", err)
	}
	if onboardedAt != nil {
		return nil, ErrOrgOnboarded
	}

	var result *ProjectProvisioning
	var existing Project
	err = tx.QueryRow(ctx,
		`SELECT id, org_id, name, github_repo, default_branch, friction_autonomy, pr_posture, default_environment_id, digest_timezone, created_at
		   FROM projects WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1`, orgID,
	).Scan(&existing.ID, &existing.OrgID, &existing.Name, &existing.GithubRepo, &existing.DefaultBranch,
		&existing.FrictionAutonomy, &existing.PrPosture, &existing.DefaultEnvironmentID, &existing.DigestTimezone, &existing.CreatedAt)
	switch {
	case err == nil:
		env, envErr := q.EnsureProjectDefaultEnvironmentTx(ctx, tx, existing.ID)
		if envErr != nil {
			return nil, fmt.Errorf("onboarding provision: %w", envErr)
		}
		key, keyErr := q.CreateProjectKeyTx(ctx, tx, existing.ID, ScopeIngest, "onboarding", nil, "")
		if keyErr != nil {
			return nil, fmt.Errorf("onboarding provision: %w", keyErr)
		}
		result = &ProjectProvisioning{Project: existing, Environment: *env, APIKey: *key}
	case errors.Is(err, pgx.ErrNoRows):
		result, err = q.provisionProjectTx(ctx, tx, orgID, name, githubRepo, idempotencyToken)
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("onboarding provision: project lookup: %w", err)
	}

	if err := RevokeExcessOnboardingKeysTx(ctx, tx, result.Project.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("onboarding provision: commit: %w", err)
	}
	return result, nil
}
```

Before writing, check `ProjectProvisioning`'s actual field names/types at its definition (grep `type ProjectProvisioning` in `db/`) and adjust the struct literal.

In `db/project_keys.go`, after `CreateProjectKeyTx` — both a tx and a pool variant (Task 3 needs the pool one):

```go
const onboardingKeyCap = 5

// RevokeExcessOnboardingKeysTx keeps only the five newest live onboarding
// ingest keys for a project. A cap, not zero-event revocation: revoking on
// every mint would kill a snippet already pasted on another machine.
func RevokeExcessOnboardingKeysTx(ctx context.Context, tx pgx.Tx, projectID string) error {
	_, err := tx.Exec(ctx, excessOnboardingKeysSQL, projectID, onboardingKeyCap)
	if err != nil {
		return fmt.Errorf("revoke excess onboarding keys: %w", err)
	}
	return nil
}

// RevokeExcessOnboardingKeys is the pool variant used by the key-create handler.
func (q *Queries) RevokeExcessOnboardingKeys(ctx context.Context, projectID string) error {
	_, err := q.pool.Exec(ctx, excessOnboardingKeysSQL, projectID, onboardingKeyCap)
	if err != nil {
		return fmt.Errorf("revoke excess onboarding keys: %w", err)
	}
	return nil
}

const excessOnboardingKeysSQL = `
	UPDATE project_api_keys
	   SET revoked_at = now()
	 WHERE project_id = $1 AND scope = 'ingest' AND label = 'onboarding' AND revoked_at IS NULL
	   AND key_id NOT IN (
	     SELECT key_id FROM project_api_keys
	      WHERE project_id = $1 AND scope = 'ingest' AND label = 'onboarding' AND revoked_at IS NULL
	      ORDER BY created_at DESC, id DESC LIMIT $2)`
```

(`created_at DESC, id DESC` — matching the table's own index ordering, `028_project_api_keys.sql:24-26`; `created_at` alone can tie and revoke the key just handed to the wizard.)

```go
```

- [ ] **Step 4: Rewire the handler**

Replace the body of `OnboardingSetup` (`handler/onboarding.go:20-104`), keeping the limiter and validation:

```go
	orgID := OrgIDFromCtx(r.Context())

	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req struct {
		ProjectName      string `json:"project_name"`
		IdempotencyToken string `json:"idempotency_token"`
		GithubRepo       string `json:"github_repo"` // legacy wizard still sends this; honored at create
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ProjectName == "" {
		writeJSONError(w, http.StatusBadRequest, "project_name is required")
		return
	}
	if len(req.ProjectName) > 100 {
		writeJSONError(w, http.StatusBadRequest, "project_name must be 100 characters or less")
		return
	}
	if strings.TrimSpace(req.IdempotencyToken) == "" {
		// Legacy clients (pre-v2 wizard) send no token; each such call gets its
		// own, preserving their previous non-idempotent semantics on fresh orgs.
		req.IdempotencyToken = uuid.NewString()
	}
	var githubRepo *string
	if req.GithubRepo != "" {
		githubRepo = &req.GithubRepo
	}

	result, err := d.Queries.OnboardingProvision(r.Context(), orgID, req.ProjectName, githubRepo, req.IdempotencyToken)
	if errors.Is(err, db.ErrOrgOnboarded) {
		writeJSONError(w, http.StatusConflict, "org already onboarded")
		return
	}
	if err != nil {
		slog.Error("onboarding: provision", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to complete setup")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{
		"project":     toProjectJSON(result.Project, false, []string{}),
		"environment": environmentJSON{ID: result.Environment.ID, ProjectID: result.Environment.ProjectID, Name: result.Environment.Name, CreatedAt: result.Environment.CreatedAt.Format(time.RFC3339)},
		"api_key": map[string]any{
			"id":      result.APIKey.ID,
			"raw_key": result.APIKey.Raw,
		},
	})
```

Adjust imports (`strings`, `errors`, `github.com/google/uuid` — check which uuid package the repo already uses via `grep -rn '"github.com/google/uuid"' packages/ingestion/handler | head -1` and match it).

- [ ] **Step 5: Run the tests**

Run: `cd packages/ingestion && go test ./handler -run TestOnboardingSetup -v && go test ./db ./handler`
Expected: PASS, zero skips (export the worktree `DATABASE_URL` block from AGENTS.md first).

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/db/project_keys.go packages/ingestion/handler/onboarding.go packages/ingestion/handler/onboarding_test.go
git commit -m "feat(ingestion): token-idempotent onboarding setup with has-project reuse and 409"
```

### Task 3: Ingest-scope key mint + Settings visibility (cap applies here too)

**Files:**
- Modify: `packages/ingestion/handler/api_keys.go` (create handler ~48-88, `presentAPIKey` ~29-46)
- Modify: `packages/ingestion/db/project_keys.go` (`CreateAPIKey` ~264, `ListAPIKeys` ~294-300, `RevokeAPIKey` ~322-332)
- Test: `packages/ingestion/handler/api_keys_test.go` (extend)

**Interfaces:**
- Consumes: `ScopeIngest`/`ScopeAPI` constants, `prefixIngest = "opslane_pk"`, `RevokeExcessOnboardingKeys` (Task 2).
- Produces: `POST /projects/{id}/api-keys` accepts optional `"scope": "ingest"` (default `"api"`); every ingest-scope mint with label `onboarding` runs the cap (this is the mint-on-resume path — without it, repeated cleared-browser resumes mint unbounded live keys); list/revoke cover both scopes; `Redacted` prefix follows scope.

- [ ] **Step 1: Write the failing test** (extend `api_keys_test.go`, copying its existing auth/request pattern):

```go
func TestIngestScopeKeyLifecycleAndCap(t *testing.T) {
	deps, pool := testDeps(t)
	router := handler.NewRouterWithPool(deps, pool)
	orgID, projectID, cred := seedForAPIKeys(t, deps.Queries) // reuse this file's existing seeding
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	var lastKeyID string
	for i := 0; i < 6; i++ {
		res := apiKeysHTTP(t, router, "POST", "/api/v1/projects/"+projectID+"/api-keys", cred,
			`{"label":"onboarding","expires_at":null,"scope":"ingest"}`)
		if res.Code != http.StatusCreated {
			t.Fatalf("create %d: %d %s", i, res.Code, res.Body.String())
		}
		var created struct {
			KeyID string `json:"key_id"`
			Token string `json:"token"`
			Scope string `json:"scope"`
		}
		mustDecode(t, res.Body, &created)
		if created.Scope != "ingest" || !strings.HasPrefix(created.Token, "opslane_pk_") {
			t.Fatalf("wrong scope/prefix: %+v", created)
		}
		lastKeyID = created.KeyID
	}

	// Six mints → exactly five live: the oldest is revoked, the newest survives.
	list := apiKeysHTTP(t, router, "GET", "/api/v1/projects/"+projectID+"/api-keys", cred, "")
	var keys []struct {
		KeyID  string `json:"key_id"`
		Scope  string `json:"scope"`
		Status string `json:"status"`
	}
	mustDecode(t, list.Body, &keys)
	live := 0
	for _, k := range keys {
		if k.Scope == "ingest" && k.Status == "active" {
			live++
		}
	}
	if live != 5 {
		t.Fatalf("cap failed: %d live ingest keys", live)
	}

	rev := apiKeysHTTP(t, router, "DELETE", "/api/v1/projects/"+projectID+"/api-keys/"+lastKeyID, cred, "")
	if rev.Code != http.StatusNoContent {
		t.Fatalf("revoke ingest key: %d", rev.Code)
	}
}
```

(Adapt helper names to what `api_keys_test.go` actually uses — read it first.)

- [ ] **Step 2: Run to verify failure** — `go test ./handler -run TestIngestScopeKeyLifecycleAndCap -v`. Expected: FAIL (400 unknown field `scope`).

- [ ] **Step 3: Implement**

`db/project_keys.go` — generalize `CreateAPIKey`: signature gains `scope string`; validate `scope == ScopeAPI || scope == ScopeIngest`; the INSERT's literals `'api', 'opslane_ak'` become bound params fed from `minted.Scope, minted.TokenPrefix`; mint with `NewProjectKey(scope, "")`. Widen the filters:

```go
// ListAPIKeys line 300:
WHERE k.project_id = $2 AND k.scope IN ('api','ingest')
// RevokeAPIKey line 332:
AND k.project_id = $2 AND k.key_id = $3 AND k.scope IN ('api','ingest')
```

`handler/api_keys.go` — input gains `Scope string`; default + validate. **Mint and cap must be one transaction** — a committed mint whose cap then fails would leave >5 live keys, so add a db method that does both atomically and have the handler use it for the ingest path:

```go
	if input.Scope == "" {
		input.Scope = db.ScopeAPI
	}
	if input.Scope != db.ScopeAPI && input.Scope != db.ScopeIngest {
		writeJSONError(w, http.StatusBadRequest, "scope must be api or ingest")
		return
	}
```

New db method in `project_keys.go` (the ingest path; the api path keeps `CreateAPIKey`):

```go
// CreateIngestKeyCapped mints an ingest key and enforces the onboarding cap in
// one transaction: either both happen or neither does.
func (q *Queries) CreateIngestKeyCapped(
	ctx context.Context,
	orgID, projectID, label string,
	createdByUserID *string,
) (*MintedProjectKey, *APIKeyRecord, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("create ingest key: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	// Org-scope the project exactly like CreateAPIKey's INSERT…SELECT does.
	var ok bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM projects WHERE id = $1 AND org_id = $2)`,
		projectID, orgID,
	).Scan(&ok); err != nil {
		return nil, nil, fmt.Errorf("create ingest key: project scope: %w", err)
	}
	if !ok {
		return nil, nil, pgx.ErrNoRows
	}

	minted, err := q.CreateProjectKeyTx(ctx, tx, projectID, ScopeIngest, label, createdByUserID, "")
	if err != nil {
		return nil, nil, err
	}
	if label == "onboarding" {
		if err := RevokeExcessOnboardingKeysTx(ctx, tx, projectID); err != nil {
			return nil, nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, fmt.Errorf("create ingest key: commit: %w", err)
	}
	record := &APIKeyRecord{KeyID: minted.KeyID, Scope: minted.Scope, Label: label, CreatedAt: time.Now().UTC()}
	return minted, record, nil
}
```

Handler branch: `input.Scope == db.ScopeIngest` → `CreateIngestKeyCapped`; else the existing `CreateAPIKey` call unchanged (its signature no longer needs a scope param — revert that part of the earlier sketch; only `presentAPIKey`, list, and revoke widen).

Fix `presentAPIKey`'s hardcoded redaction:

```go
	prefix := "opslane_ak_"
	if key.Scope == db.ScopeIngest {
		prefix = "opslane_pk_"
	}
	// ...
	Redacted: prefix + key.KeyID + "_…",
```

Update every other caller of `Queries.CreateAPIKey(` (grep) with the scope argument.

- [ ] **Step 4: Run** — `go test ./handler ./db`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add packages/ingestion/db/project_keys.go packages/ingestion/handler/api_keys.go packages/ingestion/handler/api_keys_test.go && git commit -m "feat(ingestion): ingest-scope API key mint with onboarding cap"`

### Task 4: `enabled` on notification-destination create

**Files:**
- Modify: `packages/ingestion/handler/notifications.go` (request struct ~60-65, create handler ~182-192)
- Test: `packages/ingestion/handler/notifications_test.go` (extend)

**Interfaces:**
- Produces: `POST …/notification-destinations` accepts optional `"enabled": false`; omitted → `true` (today's behavior). Task 9 creates with `enabled:false`.

- [ ] **Step 1: Failing test** — copy an existing *passing* create-destination test in `notifications_test.go` verbatim (including exactly how it authenticates — do not invent token plumbing), then modify the copy: send `"enabled": false` in the body, assert the create response contains `"enabled":false`, and follow with the same file's list-request pattern asserting the listed destination also reports `"enabled":false`.

- [ ] **Step 2: Run to verify failure** — expected FAIL with 400 (`decodeNotificationRequest` uses `DisallowUnknownFields`).

- [ ] **Step 3: Implement** — `createNotificationDestinationRequest` gains `Enabled *bool \`json:"enabled"\``; at line 191 replace `Enabled: true,` with:

```go
		Enabled: request.Enabled == nil || *request.Enabled,
```

- [ ] **Step 4: Run** — PASS; also `go test ./digest` to confirm the scheduler still selects enabled-only (`digest/scheduler.go:96-99`).

- [ ] **Step 5: Commit** — `git add packages/ingestion/handler/notifications.go packages/ingestion/handler/notifications_test.go && git commit -m "feat(ingestion): allow creating disabled notification destinations"`

### Task 5: `latest_error_group_id` on event-count

**Files:**
- Modify: `packages/ingestion/db/queries.go` (near `HasEvents`, ~3681)
- Modify: `packages/ingestion/handler/read_api.go:1184-1200`
- Test: `packages/ingestion/handler/read_api_test.go` (new test — there is **no** existing event-count test to extend; write your own seeding by copying whichever helper in that file inserts an error group + event for the issues-list tests)

**Interfaces:**
- Produces: `GET /projects/{id}/event-count` → `{"has_events": bool, "latest_error_group_id": string|null}`. Task 9's success screen links this id. Legacy wizard only reads `has_events` — additive, backward-compatible.

- [ ] **Step 1: Failing test** — new `TestEventCountLatestGroup`: fresh project → `"has_events":false` and `"latest_error_group_id":null`; after seeding a group+event → `true` and the seeded group id.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`db/queries.go`:

```go
// LatestErrorGroupID returns the most recently active error group, or nil.
func (q *Queries) LatestErrorGroupID(ctx context.Context, projectID string) (*string, error) {
	var id *string
	err := q.pool.QueryRow(ctx,
		`SELECT id::text FROM error_groups WHERE project_id = $1 ORDER BY last_seen DESC LIMIT 1`,
		projectID,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("latest error group: %w", err)
	}
	return id, nil
}
```

`handler/read_api.go` — after the `HasEvents` call:

```go
	latest, err := d.Queries.LatestErrorGroupID(r.Context(), projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to check events")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"has_events": hasEvents, "latest_error_group_id": latest})
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** — `git add packages/ingestion/db/queries.go packages/ingestion/handler/read_api.go packages/ingestion/handler/read_api_test.go && git commit -m "feat(ingestion): event-count returns latest_error_group_id"`

### Task 6: Onboarding state + complete + auth/me field

**Files:**
- Create: `packages/ingestion/handler/onboarding_state.go`
- Modify: `packages/ingestion/db/queries.go` (facts queries), `packages/ingestion/handler/auth_handlers.go` (userJSON ~158, AuthMe ~319), `packages/ingestion/handler/routes.go` (~130)
- Test: `packages/ingestion/handler/onboarding_state_test.go`

**Interfaces:**
- Consumes: `HasEvents`, `LatestErrorGroupID` (Task 5), `GetOrgGitHubInstallation(ctx, orgID) (int64, error)`, `d.GitHubAppSlug`.
- Produces:
  - `GET /api/v1/onboarding/state` (any org member) → `{"onboarding_complete":bool,"next_step":"create_project"|"install_sdk"|"connect_github"|"connect_slack"|"done","project_id":string|null,"has_events":bool,"github_connected":bool,"github_mode":"app"|"pat","slack_connected":bool}`
  - `POST /api/v1/onboarding/complete` (admin-gated like setup) → 200 `{"onboarding_complete":true}`; 422 `{"error":"missing_facts","missing":["first_event"]}` when no event; 200 no-op when already set.
  - auth/me gains `"onboarding_complete": bool`; a DB failure computing it is a 500, never a silent `false` (a silent false would route a completed user back into setup).
  - db: `OrgOnboarded(ctx, orgID) (bool, error)`, `NewestProjectIDAndRepo(ctx, orgID) (id *string, repo *string, err error)`, `HasEnabledDigestDestination(ctx, projectID) (bool, error)`, `MarkOrgOnboarded(ctx, orgID) error`.
- **Precedence rule:** `onboarded_at` short-circuits — an onboarded org is always `next_step:"done"`, even if its facts later regress (events purged, destination deleted). Banners, not the wizard, own regressions.

- [ ] **Step 1: db queries** (in `queries.go`):

```go
func (q *Queries) OrgOnboarded(ctx context.Context, orgID string) (bool, error) {
	var at *time.Time
	if err := q.pool.QueryRow(ctx, `SELECT onboarded_at FROM orgs WHERE id = $1`, orgID).Scan(&at); err != nil {
		return false, fmt.Errorf("org onboarded: %w", err)
	}
	return at != nil, nil
}

func (q *Queries) NewestProjectIDAndRepo(ctx context.Context, orgID string) (*string, *string, error) {
	var id, repo *string
	err := q.pool.QueryRow(ctx,
		`SELECT id::text, github_repo FROM projects WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1`,
		orgID,
	).Scan(&id, &repo)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("newest project: %w", err)
	}
	return id, repo, nil
}

func (q *Queries) HasEnabledDigestDestination(ctx context.Context, projectID string) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM notification_destinations
		   WHERE project_id = $1 AND enabled AND 'digest.daily' = ANY(event_types))`,
		projectID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("has digest destination: %w", err)
	}
	return exists, nil
}

// MarkOrgOnboarded is idempotent; the WHERE guard makes replays no-ops.
func (q *Queries) MarkOrgOnboarded(ctx context.Context, orgID string) error {
	if _, err := q.pool.Exec(ctx,
		`UPDATE orgs SET onboarded_at = now() WHERE id = $1 AND onboarded_at IS NULL`, orgID); err != nil {
		return fmt.Errorf("mark onboarded: %w", err)
	}
	return nil
}
```

- [ ] **Step 2: Failing handler test** (`onboarding_state_test.go`): drive the full ladder — fresh org → `next_step:"create_project"`; after `/onboarding/setup` → `"install_sdk"` and `POST /onboarding/complete` → 422 with `"first_event"`; after seeding an event (Task 5's seeding pattern) → `"connect_github"` and complete → 200; after complete: `state` reports `onboarding_complete:true` **and** `next_step:"done"` regardless of GitHub/Slack; `/auth/me` contains `"onboarding_complete":true`; a second `complete` → 200.

- [ ] **Step 3: Run to verify failure** (404 on the new routes).

- [ ] **Step 4: Implement** `handler/onboarding_state.go`:

```go
package handler

import (
	"net/http"
)

type onboardingStateJSON struct {
	OnboardingComplete bool    `json:"onboarding_complete"`
	NextStep           string  `json:"next_step"`
	ProjectID          *string `json:"project_id"`
	HasEvents          bool    `json:"has_events"`
	GitHubConnected    bool    `json:"github_connected"`
	GitHubMode         string  `json:"github_mode"`
	SlackConnected     bool    `json:"slack_connected"`
}

// evaluateOnboarding is the fact evaluator shared by state and the banners.
// Completion short-circuits BEFORE any fact query: an onboarded org is always
// "done", and a regressed or failing optional fact must never change that
// answer or turn it into a 500. Fact regressions belong to banners — and for
// the banner fields on an onboarded org, optional-fact errors degrade to
// "connected" (no nag) rather than failing the request.
func (d *Dependencies) evaluateOnboarding(r *http.Request, orgID string) (onboardingStateJSON, error) {
	state := onboardingStateJSON{GitHubMode: "app"}
	if d.GitHubAppSlug == "" {
		state.GitHubMode = "pat"
	}

	onboarded, err := d.Queries.OrgOnboarded(r.Context(), orgID)
	if err != nil {
		return state, err
	}
	state.OnboardingComplete = onboarded

	projectID, repo, err := d.Queries.NewestProjectIDAndRepo(r.Context(), orgID)
	if err != nil {
		if onboarded {
			state.NextStep = "done"
			return state, nil
		}
		return state, err
	}
	state.ProjectID = projectID

	if onboarded {
		state.NextStep = "done"
		state.HasEvents = true // moot post-completion; not re-queried
		state.GitHubConnected = d.optionalGitHubConnected(r, orgID, repo)
		if projectID != nil {
			if ok, err := d.Queries.HasEnabledDigestDestination(r.Context(), *projectID); err == nil {
				state.SlackConnected = ok
			} else {
				state.SlackConnected = true // degrade to no-nag on error
			}
		}
		return state, nil
	}

	if projectID == nil {
		state.NextStep = "create_project"
		return state, nil
	}

	state.HasEvents, err = d.Queries.HasEvents(r.Context(), *projectID)
	if err != nil {
		return state, err
	}

	state.GitHubConnected = d.optionalGitHubConnected(r, orgID, repo)
	state.SlackConnected, err = d.Queries.HasEnabledDigestDestination(r.Context(), *projectID)
	if err != nil {
		return state, err
	}

	switch {
	case !state.HasEvents:
		state.NextStep = "install_sdk"
	case !state.GitHubConnected:
		state.NextStep = "connect_github"
	case !state.SlackConnected:
		state.NextStep = "connect_slack"
	default:
		state.NextStep = "done"
	}
	return state, nil
}

// optionalGitHubConnected: installation (app mode) or nothing extra (pat mode),
// plus an attached repo. Matches the banner's definition exactly.
func (d *Dependencies) optionalGitHubConnected(r *http.Request, orgID string, repo *string) bool {
	repoAttached := repo != nil && *repo != ""
	if d.GitHubAppSlug == "" {
		return repoAttached
	}
	installationID, err := d.Queries.GetOrgGitHubInstallation(r.Context(), orgID)
	if err != nil {
		return true // degrade to no-nag on error; never fail state over an optional fact
	}
	return installationID > 0 && repoAttached
}

// GET /api/v1/onboarding/state
func (d *Dependencies) OnboardingState(w http.ResponseWriter, r *http.Request) {
	state, err := d.evaluateOnboarding(r, OrgIDFromCtx(r.Context()))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to compute onboarding state")
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// POST /api/v1/onboarding/complete — the single hard gate is a received event.
// Deliberately does NOT call the full evaluator: completion must not depend on
// (or fail because of) the optional GitHub/Slack fact queries.
func (d *Dependencies) OnboardingComplete(w http.ResponseWriter, r *http.Request) {
	orgID := OrgIDFromCtx(r.Context())
	onboarded, err := d.Queries.OrgOnboarded(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to compute onboarding state")
		return
	}
	if onboarded {
		writeJSON(w, http.StatusOK, map[string]any{"onboarding_complete": true})
		return
	}
	projectID, _, err := d.Queries.NewestProjectIDAndRepo(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to compute onboarding state")
		return
	}
	hasEvents := false
	if projectID != nil {
		hasEvents, err = d.Queries.HasEvents(r.Context(), *projectID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to compute onboarding state")
			return
		}
	}
	if !hasEvents {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": "missing_facts", "missing": []string{"first_event"},
		})
		return
	}
	if err := d.Queries.MarkOrgOnboarded(r.Context(), orgID); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to complete onboarding")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"onboarding_complete": true})
}
```

Routes (`routes.go`, after line 129):

```go
		r.With(deps.AuthenticateUserSession).Get("/onboarding/state", deps.OnboardingState)
		r.With(deps.AuthenticateUserSession, deps.RequireRoleIfCloud("admin")).Post("/onboarding/complete", deps.OnboardingComplete)
```

`auth_handlers.go` — `userJSON` gains `OnboardingComplete *bool \`json:"onboarding_complete,omitempty"\`` — a **pointer**, because `userJSON` is also serialized by the login/refresh token-issuance paths (~158-219) which don't populate it; a plain `bool` would emit a misleading `false` there. Only `AuthMe` sets it, and a failure is a 500 (a silent false would route a completed user back into setup):

```go
	onboarded, err := d.Queries.OrgOnboarded(r.Context(), OrgIDFromCtx(r.Context()))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to load onboarding state")
		return
	}
	response.OnboardingComplete = &onboarded
```

Dashboard side: `AuthUser.onboarding_complete` types as `boolean | undefined`; only `getMe()`'s response is consulted for routing (Task 10), where `undefined` never occurs.

Add a 404 spot-check for typos and, if `route_matrix_test.go`'s framework covers session-auth routes, the two new rows (read that file first — it covers project-key auth, not a full route matrix; add only what fits its shape).

- [ ] **Step 5: Run** — `go test ./handler ./db`. PASS, zero skips. **Step 6: Commit** — `git add packages/ingestion/handler/onboarding_state.go packages/ingestion/handler/onboarding_state_test.go packages/ingestion/handler/auth_handlers.go packages/ingestion/handler/routes.go packages/ingestion/db/queries.go && git commit -m "feat(ingestion): onboarding state/complete endpoints and auth/me onboarding_complete"`

### Task 7: PAT-mode repo attach

**Files:**
- Modify: `packages/ingestion/handler/github_settings.go:50-88`
- Modify: `packages/ingestion/github/app.go` (the package is `packages/ingestion/github/`, imported with alias `gh` — see `github_settings.go:10`; add `GetRepo` next to `ListInstallationRepos`, mirroring its HTTP client, base-URL variable, and the `url.PathEscape` treatment of owner/repo segments used elsewhere in that file, e.g. ~app.go:91-103)
- Test: `packages/ingestion/handler/github_settings_test.go` (extend)

**Interfaces:**
- Produces: with `d.GitHubAppSlug == ""`, `PUT /projects/{id}/github` validates via `GITHUB_TOKEN` and persists; `gh.GetRepo(token, owner, name string) (*Repo, error)`; `gh.ErrRepoNotFound`.

- [ ] **Step 1: Failing test** — in `github_settings_test.go`: with `deps.GitHubAppSlug = ""`. The `github` package has a **constant** API base and exposes `OverrideHTTPClientForTests` (`github/app.go:209-215`) — stub via a custom `http.RoundTripper` installed through that override (returning canned `/repos/{owner}/{repo}` responses), not via a base-URL swap. Assert: valid repo → 200 + persisted; stubbed 404 → 400 + nothing persisted; missing `GITHUB_TOKEN` → 400 naming the config gap. Use `t.Setenv("GITHUB_TOKEN", "test-token")`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — in `packages/ingestion/github/app.go` (adopt the file's actual client/base-URL names; split + escape path segments the way its existing request builders do):

```go
// ErrRepoNotFound reports a repository the token cannot see (missing or private without access).
var ErrRepoNotFound = errors.New("repository not found or not accessible")

// GetRepo fetches a single repository with a PAT (or any bearer token).
func GetRepo(token, owner, name string) (*Repo, error) {
	u := apiBase + "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrRepoNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github get repo: status %d", resp.StatusCode)
	}
	var repo Repo
	if err := json.NewDecoder(resp.Body).Decode(&repo); err != nil {
		return nil, err
	}
	return &repo, nil
}
```

In `SetGitHubConfig`, the handler already split/validated `parts := strings.Split(req.GithubRepo, "/")` at lines 44-48 — reuse `parts[0]`, `parts[1]`. Replace lines 50-88 with a mode branch:

```go
	orgID := OrgIDFromCtx(r.Context())
	var fullName, defaultBranch string
	if d.GitHubAppSlug == "" {
		token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
		if token == "" {
			writeJSONError(w, http.StatusBadRequest, "configure GITHUB_TOKEN or install the GitHub App")
			return
		}
		repo, err := gh.GetRepo(token, parts[0], parts[1])
		if errors.Is(err, gh.ErrRepoNotFound) {
			writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("%s is not reachable with the configured GITHUB_TOKEN", req.GithubRepo))
			return
		}
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, "could not reach GitHub, please retry")
			return
		}
		fullName, defaultBranch = repo.FullName, repo.DefaultBranch
	} else {
		// existing app-mode block (installation check → token → ListInstallationRepos → match), unchanged,
		// ending with: fullName, defaultBranch = matched.FullName, matched.DefaultBranch
	}
	if err := d.Queries.SetProjectGitHubConfig(r.Context(), orgID, projectID, fullName, defaultBranch); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to save GitHub config")
		return
	}
```

- [ ] **Step 4: Run** — `go test ./handler -run TestSetGitHubConfig -v && go test ./...` (zero skips). **Step 5: Commit** — `git add packages/ingestion/github/app.go packages/ingestion/handler/github_settings.go packages/ingestion/handler/github_settings_test.go && git commit -m "feat(ingestion): PAT-mode repo attach with token validation"`

**Milestone 1 gate:** full repo gate green; the **old** wizard still completes against the M1 server (manual check: create project through the current UI); spec Appendix A M1 items 1-8 each demonstrably true (1→T1, 2→T2, 3→T3, 4→T4, 5→T5, 6→T7, 7→T6, 8→gate).

---

## Milestone 2 — Wizard rewrite (Tasks 8–11)

### Task 8: API wrappers + types (additive only — nothing here may break the old wizard)

**Files:**
- Modify: `packages/dashboard/src/api.ts` (~458-579), `packages/dashboard/src/types/api.ts`

**Interfaces:**
- Produces (Tasks 9/10/11 consume):

```ts
export interface OnboardingState {
  onboarding_complete: boolean;
  next_step: 'create_project' | 'install_sdk' | 'connect_github' | 'connect_slack' | 'done';
  project_id: string | null;
  has_events: boolean;
  github_connected: boolean;
  github_mode: 'app' | 'pat';
  slack_connected: boolean;
}
export function getOnboardingState(): Promise<OnboardingState>;
export function completeOnboarding(): Promise<{ onboarding_complete: boolean }>;
```

- [ ] **Step 1: Implement in `api.ts`**

```ts
export function getOnboardingState(): Promise<OnboardingState> {
  return fetchJSON<OnboardingState>('/onboarding/state');
}

export function completeOnboarding(): Promise<{ onboarding_complete: boolean }> {
  return postJSON<{ onboarding_complete: boolean }>('/onboarding/complete', {});
}
```

**Do not change `onboardingSetup`'s signature here** — the old wizard still calls `onboardingSetup(name, selectedRepo)`; the signature changes in Task 9 together with its only caller. Additive edits only:

- `EventStatus` (api.ts ~201-203) gains `latest_error_group_id: string | null`.
- `createNotificationDestination`'s `data` gains `enabled?: boolean; event_types?: NotificationEventType[]` — and add `NotificationEventType` to the `types/api` import list at the top of `api.ts` (it is not currently imported).
- `createAPIKey`'s input gains `scope?: 'api' | 'ingest'`.
- `types/api.ts`: `AuthUser` gains `onboarding_complete: boolean`; `ManagedAPIKey.scope` and `CreatedAPIKey.scope` widen to `'api' | 'ingest'`; add `OnboardingState` (shape above).

- [ ] **Step 2: Build** — `pnpm --filter @opslane/dashboard build` (confirm the filter name in `packages/dashboard/package.json`). Expected: clean typecheck. Fix any caller broken by the widened `scope` (Settings.vue copy mentions `opslane_ak_` — text only, no type break expected).

- [ ] **Step 3: Commit** — `git add packages/dashboard/src/api.ts packages/dashboard/src/types/api.ts && git commit -m "feat(dashboard): onboarding state/complete wrappers and widened key types"`

### Task 9: SetupWizard rewrite

**Files:**
- Rewrite: `packages/dashboard/src/views/SetupWizard.vue`
- Modify: `packages/dashboard/src/api.ts` (`onboardingSetup` signature — changes here, with its only caller)
- Modify: `docs/install.md` (add the Next.js section in the same commit — a shipped tab can't be undocumented)
- Test: `packages/dashboard/src/views/__tests__/setup-wizard.test.ts` (new)

**Interfaces:**
- Consumes: Task 8 wrappers; `createAPIKey` (mint-on-resume); `createNotificationDestination`/`testNotificationDestination`/`updateNotificationDestination`; `getGitHubAppStatus`/`setGitHubConfig`; `listProjects` (to restore `localStorage` on resume/finish); `RepoSelector`, `CodeBlock`, `Button` components (note: `CodeBlock` renders its own copy control — do **not** add a separate `CopyButton` next to it).
- Produces: 4-step wizard (`Create project` → `Install SDK` → `Connect GitHub` → `Connect Slack`) + done screen. Steps 3 and 4 each have a "Do this later" link (session-local by design: reloading after a deferral re-offers the step — spec §5.3/§5.4). Completion calls `completeOnboarding()` and **must handle failure honestly** (no done-screen on error).

- [ ] **Step 1: Change `onboardingSetup` in `api.ts`**

```ts
export function onboardingSetup(
  projectName: string,
  idempotencyToken: string,
): Promise<OnboardingSetupResponse> {
  return postJSON<OnboardingSetupResponse>('/onboarding/setup', {
    project_name: projectName,
    idempotency_token: idempotencyToken,
  });
}
```

- [ ] **Step 2: Write the failing test** (`setup-wizard.test.ts`, conventions from `admin-view.test.ts`; the mock covers **every** api function the component imports — a missing mock entry throws on import):

```ts
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getOnboardingState: vi.fn(),
  onboardingSetup: vi.fn(),
  getEventStatus: vi.fn(),
  getGitHubAppStatus: vi.fn(),
  setGitHubConfig: vi.fn(),
  createAPIKey: vi.fn(),
  createNotificationDestination: vi.fn(),
  testNotificationDestination: vi.fn(),
  updateNotificationDestination: vi.fn(),
  completeOnboarding: vi.fn(),
  listProjects: vi.fn(),
}));
vi.mock('../../api', () => api);
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import SetupWizard from '../SetupWizard.vue';

const baseState = {
  onboarding_complete: false,
  next_step: 'create_project',
  project_id: null,
  has_events: false,
  github_connected: false,
  github_mode: 'app',
  slack_connected: false,
};

describe('SetupWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    api.getOnboardingState.mockResolvedValue({ ...baseState });
    api.listProjects.mockResolvedValue([{ id: 'p1', name: 'web' }]);
    api.getGitHubAppStatus.mockResolvedValue({ installed: false, installation_id: null, install_url: 'https://github.com/apps/x/installations/new' });
  });

  it('resumes at the server-derived step, restores localStorage, and mints a key', async () => {
    api.getOnboardingState.mockResolvedValue({ ...baseState, next_step: 'install_sdk', project_id: 'p1' });
    api.createAPIKey.mockResolvedValue({ key_id: 'k1', token: 'opslane_pk_resume', label: 'onboarding', scope: 'ingest', expires_at: null });
    api.getEventStatus.mockResolvedValue({ has_events: false, latest_error_group_id: null });
    const w = mount(SetupWizard);
    await flushPromises();
    expect(w.text()).toContain('Install the SDK');
    expect(api.createAPIKey).toHaveBeenCalledWith('p1', { label: 'onboarding', expires_at: null, scope: 'ingest' });
    expect(w.text()).toContain('opslane_pk_resume');
    expect(localStorage.getItem('opslane_project_id')).toBe('p1');
    expect(api.onboardingSetup).not.toHaveBeenCalled();
  });

  it('shows the event success state with the group link, then Continue advances', async () => {
    api.getOnboardingState.mockResolvedValue({ ...baseState, next_step: 'install_sdk', project_id: 'p1' });
    api.createAPIKey.mockResolvedValue({ key_id: 'k1', token: 'opslane_pk_x', label: 'onboarding', scope: 'ingest', expires_at: null });
    api.getEventStatus.mockResolvedValueOnce({ has_events: false, latest_error_group_id: null });
    api.getEventStatus.mockResolvedValue({ has_events: true, latest_error_group_id: 'g1' });
    const w = mount(SetupWizard);
    await flushPromises();
    expect(w.find('[data-testid="sdk-continue"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(6001);
    await flushPromises();
    expect(w.find('[data-testid="latest-group-link"]').attributes('href')).toContain('g1');
    await w.find('[data-testid="sdk-continue"]').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('Connect GitHub');
  });

  it('Slack step enables only after ok:true and completes onboarding', async () => {
    api.getOnboardingState.mockResolvedValue({ ...baseState, next_step: 'connect_slack', project_id: 'p1', has_events: true, github_connected: true });
    api.createNotificationDestination.mockResolvedValue({ id: 'd1', enabled: false });
    api.testNotificationDestination.mockResolvedValue({ ok: true, classification: 'delivered', status_code: 200 });
    api.updateNotificationDestination.mockResolvedValue({ id: 'd1', enabled: true });
    api.completeOnboarding.mockResolvedValue({ onboarding_complete: true });
    const w = mount(SetupWizard);
    await flushPromises();
    await w.find('#slack-webhook-url').setValue('https://hooks.slack.com/services/T0/B0/x');
    await w.find('[data-testid="slack-connect"]').trigger('submit');
    await flushPromises();
    expect(api.createNotificationDestination).toHaveBeenCalledWith('p1', expect.objectContaining({ enabled: false, delivery_policy: 'post_triage' }));
    expect(api.updateNotificationDestination).toHaveBeenCalledWith('p1', 'd1', { enabled: true });
    expect(api.completeOnboarding).toHaveBeenCalled();
    expect(w.text()).toContain('You are set up');
  });

  it('failed Slack test never enables and shows the error', async () => {
    api.getOnboardingState.mockResolvedValue({ ...baseState, next_step: 'connect_slack', project_id: 'p1', has_events: true, github_connected: true });
    api.createNotificationDestination.mockResolvedValue({ id: 'd1', enabled: false });
    api.testNotificationDestination.mockResolvedValue({ ok: false, classification: 'http_404', status_code: 404 });
    const w = mount(SetupWizard);
    await flushPromises();
    await w.find('#slack-webhook-url').setValue('https://hooks.slack.com/services/T0/B0/x');
    await w.find('[data-testid="slack-connect"]').trigger('submit');
    await flushPromises();
    expect(api.updateNotificationDestination).not.toHaveBeenCalled();
    expect(w.text()).toContain("couldn't reach that webhook");
  });

  it('completion failure shows an error, not the done screen', async () => {
    api.getOnboardingState.mockResolvedValue({ ...baseState, next_step: 'connect_github', project_id: 'p1', has_events: true });
    api.completeOnboarding.mockRejectedValue(new Error('server exploded'));
    const w = mount(SetupWizard);
    await flushPromises();
    await w.find('[data-testid="defer-github"]').trigger('click');
    await flushPromises();
    await w.find('[data-testid="defer-slack"]').trigger('click');
    await flushPromises();
    expect(w.text()).not.toContain('You are set up');
    expect(w.text()).toContain('server exploded');
  });

  it('an already-complete org is sent straight to the dashboard', async () => {
    api.getOnboardingState.mockResolvedValue({ ...baseState, onboarding_complete: true, next_step: 'done', project_id: 'p1' });
    mount(SetupWizard);
    await flushPromises();
    expect(localStorage.getItem('opslane_project_id')).toBe('p1');
    // router.push('/') asserted via the mocked useRouter if you capture it
  });

  it('facts-complete-but-unmarked calls completion instead of forcing steps backward', async () => {
    api.getOnboardingState.mockResolvedValue({ ...baseState, next_step: 'done', project_id: 'p1', has_events: true, github_connected: true, slack_connected: true });
    api.completeOnboarding.mockResolvedValue({ onboarding_complete: true });
    mount(SetupWizard);
    await flushPromises();
    expect(api.completeOnboarding).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @opslane/dashboard test -- setup-wizard`. Expected: FAIL (old component).

- [ ] **Step 4: Rewrite the component**

Replace `SetupWizard.vue` wholesale. Script (static imports only — no dynamic `import()`; every function referenced here is in the Task 2 test mock):

```ts
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  completeOnboarding, createAPIKey, createNotificationDestination, getEventStatus,
  getGitHubAppStatus, getOnboardingState, listProjects, onboardingSetup, setGitHubConfig,
  testNotificationDestination, updateNotificationDestination,
} from '../api';
import type { GitHubAppStatus, OnboardingState } from '../types/api';
import CodeBlock from '../components/CodeBlock.vue';
import RepoSelector from '../components/RepoSelector.vue';
import Button from '../components/ui/Button.vue';

const router = useRouter();

type Step = 'create_project' | 'install_sdk' | 'connect_github' | 'connect_slack' | 'done';
const step = ref<Step>('create_project');
const state = ref<OnboardingState | null>(null);
const projectId = ref('');
const apiKey = ref(''); // raw opslane_pk_, session-memory only
const error = ref('');
const loading = ref(false);

const steps: Array<{ id: Step; label: string }> = [
  { id: 'create_project', label: 'Create project' },
  { id: 'install_sdk', label: 'Install SDK' },
  { id: 'connect_github', label: 'Connect GitHub' },
  { id: 'connect_slack', label: 'Connect Slack' },
];

async function restoreProjectStorage(): Promise<void> {
  // The router's project guard reads localStorage; without this, a completed
  // org with cleared storage would loop /setup → / → /setup forever.
  try {
    const projects = await listProjects();
    const match = projects.find((p) => p.id === projectId.value) ?? projects[0];
    if (match) {
      localStorage.setItem('opslane_project_id', match.id);
      localStorage.setItem('opslane_project_name', match.name);
    }
  } catch { /* non-fatal; App.vue also syncs storage */ }
}

// --- resume from server facts ---
onMounted(async () => {
  try {
    const s = await getOnboardingState();
    state.value = s;
    projectId.value = s.project_id ?? '';
    if (projectId.value) await restoreProjectStorage();
    if (s.onboarding_complete) {
      localStorage.setItem('opslane_onboarding_complete', '1');
      void router.push('/');
      return;
    }
    if (s.next_step === 'done') {
      // Facts complete, mark not set: land on the last step so a failed
      // completion has a real screen (error + defer button retries finish),
      // not the create-project panel.
      step.value = 'connect_slack';
      await finish();
      return;
    }
    step.value = s.next_step;
    if (step.value === 'install_sdk') await ensureKeyAndPoll();
    if (step.value === 'connect_github' && s.github_mode === 'app') await loadGitHubStatus();
  } catch {
    step.value = 'create_project';
  }
});

// --- step 1: create project (token-idempotent) ---
const projectName = ref('');
const idempotencyToken = crypto.randomUUID();
async function submitProject(): Promise<void> {
  error.value = '';
  loading.value = true;
  try {
    const result = await onboardingSetup(projectName.value, idempotencyToken);
    projectId.value = result.project.id;
    apiKey.value = result.api_key.raw_key;
    localStorage.setItem('opslane_project_id', result.project.id);
    localStorage.setItem('opslane_project_name', result.project.name);
    step.value = 'install_sdk';
    startEventPolling();
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Setup failed';
  } finally {
    loading.value = false;
  }
}

// --- step 2: snippet + event gate ---
const framework = ref<'vue' | 'react' | 'nextjs' | 'other'>('vue');
const hasEvents = ref(false);
const latestGroupId = ref<string | null>(null);
const pollTimer = ref<ReturnType<typeof setInterval>>();

const hostedOrigin = 'https://app.opslane.com';
const endpointLine = computed(() =>
  window.location.origin === hostedOrigin ? '' : `\n  endpoint: '${window.location.origin}',`);

const initSnippet = computed(() => {
  const common = `init({\n  apiKey: '${apiKey.value}',\n  environment: 'development',${endpointLine.value}\n});`;
  switch (framework.value) {
    case 'vue':
      return `import { createApp } from 'vue';\nimport { init, opslaneVuePlugin } from '@opslane/sdk';\nimport App from './App.vue';\n\n${common}\n\ncreateApp(App).use(opslaneVuePlugin).mount('#app');`;
    case 'react':
      return `import { createRoot } from 'react-dom/client';\nimport { init } from '@opslane/sdk';\nimport { OpslaneErrorBoundary } from '@opslane/sdk/react';\nimport App from './App';\n\n${common}\n\ncreateRoot(document.getElementById('root')!).render(\n  <OpslaneErrorBoundary fallback={<p>Something went wrong.</p>}>\n    <App />\n  </OpslaneErrorBoundary>\n);`;
    case 'nextjs':
      return `// app/opslane-provider.tsx\n'use client';\nimport { useEffect } from 'react';\nimport { init } from '@opslane/sdk';\n\nexport function OpslaneProvider({ children }: { children: React.ReactNode }) {\n  useEffect(() => {\n    ${common.replaceAll('\n', '\n    ')}\n  }, []);\n  return <>{children}</>;\n}\n// then wrap {children} with <OpslaneProvider> in app/layout.tsx`;
    default:
      return `import { init } from '@opslane/sdk';\n\n${common}`;
  }
});
const installSnippet = 'npm install @opslane/sdk';
const testButtonSnippet = computed(() => {
  switch (framework.value) {
    case 'vue':
      return `<button @click="() => { throw new Error('opslane-test') }">Test Opslane</button>`;
    case 'react':
    case 'nextjs':
      return `<button onClick={() => { throw new Error('opslane-test'); }}>Test Opslane</button>`;
    default:
      return `<button onclick="throw new Error('opslane-test')">Test Opslane</button>`;
  }
});

const keyError = ref('');
async function ensureKeyAndPoll(): Promise<void> {
  if (!apiKey.value && projectId.value) {
    // Mint-on-resume: a fresh browser has no raw key in memory. On failure the
    // panel renders a Retry button (data-testid="retry-mint") re-calling this —
    // never the snippet with an empty apiKey.
    keyError.value = '';
    try {
      const minted = await createAPIKey(projectId.value, { label: 'onboarding', expires_at: null, scope: 'ingest' });
      apiKey.value = minted.token;
    } catch (err: unknown) {
      keyError.value = err instanceof Error ? err.message : 'Could not create an API key';
      return;
    }
  }
  startEventPolling();
}

let pollInFlight = false;
function startEventPolling(): void {
  if (pollTimer.value) clearInterval(pollTimer.value);
  pollTimer.value = setInterval(async () => {
    if (pollInFlight) return; // slow responses must not overlap
    pollInFlight = true;
    try {
      const status = await getEventStatus(projectId.value);
      if (status.has_events) {
        hasEvents.value = true;
        latestGroupId.value = status.latest_error_group_id;
        if (pollTimer.value) clearInterval(pollTimer.value);
      }
    } catch { /* keep polling */ } finally {
      pollInFlight = false;
    }
  }, 3000);
}

// Explicit continue: the success panel (group link + "delete the test button")
// must be seen, not skipped by an auto-advance.
async function continueFromSdk(): Promise<void> {
  step.value = 'connect_github';
  if (state.value?.github_mode !== 'pat') await loadGitHubStatus();
}

// --- step 3: GitHub (deferable; deferral is session-local by design) ---
const githubAppStatus = ref<GitHubAppStatus | null>(null);
const patRepo = ref('');
const selectedRepo = ref('');
const githubError = ref('');
async function loadGitHubStatus(): Promise<void> {
  try { githubAppStatus.value = await getGitHubAppStatus(); } catch { githubAppStatus.value = null; }
}
async function attachRepo(repo: string): Promise<void> {
  githubError.value = '';
  try {
    await setGitHubConfig(projectId.value, { github_repo: repo });
    window.dispatchEvent(new Event('opslane-integrations-changed'));
    step.value = 'connect_slack';
  } catch (err: unknown) {
    githubError.value = err instanceof Error ? err.message : 'Could not connect the repository';
  }
}
function deferGitHub(): void { step.value = 'connect_slack'; }

// --- step 4: Slack (deferable, create-disabled → test → enable) ---
const slackWebhookUrl = ref('');
const slackError = ref('');
const slackBusy = ref(false);
const slackDestId = ref('');
async function connectSlack(): Promise<void> {
  slackError.value = '';
  slackBusy.value = true;
  try {
    if (!slackDestId.value) {
      const created = await createNotificationDestination(projectId.value, {
        name: 'Daily digest', webhook_url: slackWebhookUrl.value,
        enabled: false, delivery_policy: 'post_triage',
      });
      slackDestId.value = created.id;
    } else {
      await updateNotificationDestination(projectId.value, slackDestId.value, { webhook_url: slackWebhookUrl.value });
    }
    const result = await testNotificationDestination(projectId.value, slackDestId.value, { eventType: 'issue.created' });
    if (!result.ok) {
      slackError.value = `We couldn't reach that webhook (${result.classification}). Check the URL and try again.`;
      return;
    }
    await updateNotificationDestination(projectId.value, slackDestId.value, { enabled: true });
    window.dispatchEvent(new Event('opslane-integrations-changed'));
    await finish();
  } catch (err: unknown) {
    slackError.value = err instanceof Error ? err.message : 'Could not connect Slack';
  } finally {
    slackBusy.value = false;
  }
}
async function deferSlack(): Promise<void> { await finish(); }

// finish() is honest: a failed completion shows the error and stays put.
async function finish(): Promise<void> {
  error.value = '';
  try {
    await completeOnboarding();
    localStorage.setItem('opslane_onboarding_complete', '1');
    await restoreProjectStorage(); // best-effort: App.vue's checkProject also syncs storage on mount
    step.value = 'done';
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Could not complete setup';
  }
}

function goToDashboard(): void { void router.push('/'); }
onUnmounted(() => { if (pollTimer.value) clearInterval(pollTimer.value); });
</script>
```

Template requirements (build with the old file's Tailwind idioms — progress circles over `steps`, `max-w-lg` card):

- Install panel: `installSnippet` + framework tabs + `initSnippet` + `testButtonSnippet` in `CodeBlock`s (no extra `CopyButton` — `CodeBlock` has its own); "Waiting for your first event…" spinner while `!hasEvents` with **no continue control**; when `hasEvents`: success block with `<a data-testid="latest-group-link" :href="latestGroupId ? '/issues/' + latestGroupId : '/'">` labeled "here's the latest error Opslane captured", a "you can delete the test button now" note, and `<Button data-testid="sdk-continue" @click="continueFromSdk">Continue</Button>`.
- Install panel key states: while `keyError` — the error plus `<Button data-testid="retry-mint" @click="ensureKeyAndPoll">Retry</Button>`, never a snippet with an empty key.
- GitHub panel: branch on `state?.github_mode`. App mode: install link bound through `safeUrl` exactly as the old wizard did (`import { GITHUB_PR_URL_OPTIONS, safeUrl } from '../utils'`; `const installHref = computed(() => safeUrl(githubAppStatus.value?.install_url ?? '', GITHUB_PR_URL_OPTIONS))` — verify those options admit `github.com/apps/...` URLs, else use the utils file's appropriate option set), a "Check again" button (`loadGitHubStatus`), and when `githubAppStatus?.installed` a `RepoSelector v-model="selectedRepo"` + attach Button calling `attachRepo(selectedRepo)`. PAT mode: text input bound to `patRepo`, submit calling `attachRepo(patRepo)`, `githubError` display. Both: `<button data-testid="defer-github" @click="deferGitHub">Do this later</button>`.
- Slack panel: `<form data-testid="slack-connect" @submit.prevent="connectSlack">` with `#slack-webhook-url` input, link to `docs/guides/slack-notifications.md` copy, `slackError` display, `<button type="button" data-testid="defer-slack" @click="deferSlack">Do this later</button>`.
- Done panel: heading "You are set up", `goToDashboard` Button. `error` renders on every panel.

- [ ] **Step 5: Add the Next.js section to `docs/install.md`** after the Vue section — mirror the wizard's provider snippet verbatim, with one sentence on why init lives in a client component.

- [ ] **Step 6: Run** — `pnpm --filter @opslane/dashboard test -- setup-wizard`, then the full dashboard suite. Expected: PASS. **Step 7: Commit** — `git add packages/dashboard/src/views/SetupWizard.vue packages/dashboard/src/views/__tests__/setup-wizard.test.ts packages/dashboard/src/api.ts docs/install.md && git commit -m "feat(dashboard): manual-first onboarding wizard with deferable GitHub/Slack"`

### Task 10: Entry routing on `onboarding_complete`

**Files:**
- Modify: `packages/dashboard/src/post-auth.ts` (full file, 26 lines)
- Test: `packages/dashboard/src/__tests__/post-auth.test.ts` (check `ls packages/dashboard/src/__tests__/` — create if absent)

**Interfaces:**
- Consumes: `getMe()` now returning `onboarding_complete` (Tasks 6+8).
- Also modify `packages/dashboard/src/router.ts` (guard, lines 57-63): the project guard alone is bypassable — an incomplete org with a stored project id could navigate straight to `/`. Add a cached completion flag (`opslane_onboarding_complete` in localStorage, written by post-auth and by the wizard's `finish()`/complete-detection; cleared in `clearAuth()` in `api.ts` alongside `opslane_authed`):

```ts
	if (authed && routeNeedsProject(to.name)) {
		const hasProject = !!localStorage.getItem('opslane_project_id');
		const onboarded = localStorage.getItem('opslane_onboarding_complete') === '1';
		if (!hasProject || !onboarded) {
			return { name: 'setup' };
		}
	}
```

The flag is a client-side cache, not the authority — the wizard itself re-checks `getOnboardingState()` on mount and immediately routes a completed org to `/` (setting the flag), so a stale-false costs one redirect hop and a stale-true only skips the nag until next login.
- Deliberate scope limit (documented so nobody "fixes" it): the invite-accept return path is honored **before** the onboarding check — a freshly invited member must land on the acceptance page; the onboarding gate applies from their next full navigation through the guard above.

- [ ] **Step 1: Failing test** — mock `getMe`/`listProjects`/`markAuthed`; assert: `onboarding_complete:false` + existing projects → storage set AND pushed to `/setup`; `onboarding_complete:true` + projects → storage set, pushed to `/`; saved `opslane_post_auth_path` → pushed there regardless.

- [ ] **Step 2: Implement** — `post-auth.ts` becomes:

```ts
import type { Router } from 'vue-router';
import { getMe, listProjects, markAuthed } from './api';

export async function completePostAuth(router: Pick<Router, 'push'>): Promise<void> {
  const me = await getMe();

  // Invitation flows land where they were headed; the onboarding gate
  // applies from their next navigation onward.
  const returnPath = sessionStorage.getItem('opslane_post_auth_path');
  if (returnPath) {
    markAuthed();
    sessionStorage.removeItem('opslane_post_auth_path');
    await router.push(returnPath);
    return;
  }

  const projects = await listProjects();
  if (projects.length > 0) {
    localStorage.setItem('opslane_project_id', projects[0].id);
    localStorage.setItem('opslane_project_name', projects[0].name);
  }
  if (me.onboarding_complete) {
    localStorage.setItem('opslane_onboarding_complete', '1');
  } else {
    localStorage.removeItem('opslane_onboarding_complete');
  }
  markAuthed();
  await router.push(me.onboarding_complete ? '/' : '/setup');
}
```

Also add `localStorage.removeItem('opslane_onboarding_complete')` to `clearAuth()` in `api.ts` (~43).

- [ ] **Step 3: Run, then commit** — `git add packages/dashboard/src/post-auth.ts packages/dashboard/src/__tests__/post-auth.test.ts && git commit -m "feat(dashboard): route on onboarding_complete after auth"`

### Task 11: Dashboard banners

**Files:**
- Create: `packages/dashboard/src/components/OnboardingBanners.vue`
- Modify: `packages/dashboard/src/App.vue` — mount just inside `<main id="main-content">` (~line 190, above `router-view`) **wrapped in `v-if="!isFullPage"`** so `/setup` (a `fullPageRoutes` member, App.vue:28) never shows it and the banner inherits the main content's margins/max-width.
- Modify: `packages/dashboard/src/components/IntegrationsSettings.vue` — dispatch `window.dispatchEvent(new Event('opslane-integrations-changed'))` after every successful create/update/delete/test-enable mutation (the wizard already dispatches it — Task 9).
- Test: `packages/dashboard/src/components/__tests__/onboarding-banners.test.ts` (new)

**Interfaces:**
- Consumes: `getOnboardingState()` — **the same fact source as the wizard**, so "GitHub connected" means installation+repo (app mode), never just the repo string (`getGitHubConfig().connected` only proves `projects.github_repo` is set and would keep the banner hidden after an App uninstall); window events `opslane-projects-changed` (project switch) and `opslane-integrations-changed` (mutations) for refresh; the Settings route path from `router.ts` (check the actual `path` string before writing the links).
- Error semantics: a failed refresh **keeps the previous banner state** — a transient API error must not silently clear a persistent nag (and the initial state is hidden, so first-load failures show nothing rather than false nags).

- [ ] **Step 1: Failing test** — mount `OnboardingBanners` with mocked api: state with `github_connected:false, slack_connected:false` → both banners with Settings links; both true → renders nothing; a resolved-then-rejected refresh (fire `opslane-integrations-changed` with the mock now rejecting) → banners unchanged from the last good state.

- [ ] **Step 2: Implement**

```ts
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { getOnboardingState } from '../api';

const githubMissing = ref(false);
const slackMissing = ref(false);

async function refresh(): Promise<void> {
  try {
    const s = await getOnboardingState();
    githubMissing.value = !s.github_connected;
    slackMissing.value = !s.slack_connected;
  } catch { /* keep last known state; a transient failure must not clear a nag */ }
}

onMounted(() => {
  void refresh();
  window.addEventListener('opslane-projects-changed', refresh);
  window.addEventListener('opslane-integrations-changed', refresh);
});
onUnmounted(() => {
  window.removeEventListener('opslane-projects-changed', refresh);
  window.removeEventListener('opslane-integrations-changed', refresh);
});
</script>

<template>
  <div v-if="githubMissing || slackMissing" class="space-y-2 px-4 pt-4">
    <div v-if="githubMissing" class="rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-text" role="status">
      Connect GitHub to get automated fix PRs.
      <RouterLink to="/settings" class="underline">Open Settings</RouterLink>
    </div>
    <div v-if="slackMissing" class="rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-text" role="status">
      Connect Slack to get your daily digest.
      <RouterLink to="/settings" class="underline">Open Settings</RouterLink>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Run, then commit** — `git add packages/dashboard/src/components/OnboardingBanners.vue packages/dashboard/src/components/__tests__/onboarding-banners.test.ts packages/dashboard/src/App.vue && git commit -m "feat(dashboard): persistent GitHub/Slack onboarding banners"`

**Milestone 2 gate:** dashboard suite green; live smoke per spec Appendix A M2 AC3 (worktree stack + `test-fixtures/vue-app`: paste snippet, click test button, listener flips, group linked); reload matrix (M2 AC4) checked by hand; full repo gate green.

---

## Milestone 3 — Delete the setup-PR path (Tasks 12–14)

Dashboard callers died in Task 9, so server and worker can go in any order — but the settlement migration lands in the **same commit** as the worker allowlist removal.

### Task 12: Worker deletion + settlement migration

**Files:**
- Delete: `packages/worker/src/setup-pr.ts`, `packages/worker/src/setup-agent.ts`, plus their tests (`ls packages/worker/src/__tests__/ | grep -i setup` for the exact filenames)
- Modify: `packages/worker/src/index.ts` (import line 30, dispatch block 338-341), `packages/worker/src/db.ts` (claim allowlist line 625, `recordSetupPrResult` 2425-2469 and its `SetupPrStatus` import), `packages/worker/src/__tests__/db.test.ts`, `__tests__/index.test.ts`, `__tests__/python-production-path.test.ts` (drop setup-pr cases)
- Create: `packages/ingestion/db/migrations/063_retire_setup_pr_jobs.sql`

**Interfaces:**
- Produces: worker with no `setup_pr` handling; migration settles legacy jobs terminally so queue-depth/health stay clean (`getQueueDepth` counts pending only, `db.ts:706-727`; `computeHealthStatus` reports `stalled` on eligible-but-unclaimable work, `index.ts:251-259`).

- [ ] **Step 1: Migration**

```sql
-- Onboarding v2 retired the setup_pr job type. Settle rows the retired path
-- would otherwise strand: pending rows (no worker claims this type anymore)
-- and claimed rows whose lease has expired (their worker is gone). A row still
-- under an ACTIVE lease is deliberately left alone — an old-version worker may
-- be mid-execution with GitHub side effects, and yanking it to dead_letter
-- would race its lease-fenced result write; it finishes or lease-expires into
-- pending, where a re-run of this settlement (or the guarded WHERE on the next
-- deploy's migration pass) catches it.
UPDATE error_group_jobs
   SET status = 'dead_letter',
       last_error = COALESCE(last_error, 'setup_pr retired by onboarding v2')
 WHERE job_type = 'setup_pr'
   AND (status = 'pending'
        OR (status = 'claimed' AND lease_expires_at < now()));
```

Apply twice to the dev DB (idempotent by construction).

**Deploy ordering (record in the PR description):** ship the new worker first and let old workers drain, then apply the migration (it runs with the ingestion deploy). The lease guard above makes the wrong order safe too — a still-leased job finishes under its old worker untouched.

- [ ] **Step 2: Delete + unwire.** Remove the source files and their tests; remove the import and the `if (job.jobType === 'setup_pr')` block in `index.ts`; remove `'setup_pr',` from the allowlist in `db.ts:625`; delete `recordSetupPrResult` and its type import. Build: `pnpm --filter @opslane/worker build`.

- [ ] **Step 3: Seeded-legacy-row test.** In `__tests__/db.test.ts`, replace deleted setup-pr cases with one that seeds a `job_type='setup_pr'` pending row, asserts the claim query never claims it, applies migration 063 to the test DB, and asserts `getQueueDepth()` then reports zero pending `setup_pr`.

- [ ] **Step 4: Run** — `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test` with `DATABASE_URL`. PASS.

- [ ] **Step 5: Commit** (explicit adds — `-am` would miss the untracked migration):

```bash
git add packages/ingestion/db/migrations/063_retire_setup_pr_jobs.sql packages/worker/src/index.ts packages/worker/src/db.ts packages/worker/src/__tests__/
git rm packages/worker/src/setup-pr.ts packages/worker/src/setup-agent.ts
git commit -m "feat(worker): delete setup_pr job path; settle legacy jobs terminally"
```

(Include the test files `ls | grep -i setup` found in the `git rm`.)

### Task 13: Ingestion deletion

**Files:**
- Delete: `packages/ingestion/handler/setup_pr.go`, `packages/ingestion/handler/setup_pr_test.go`
- Modify: `packages/ingestion/handler/routes.go:190-192`, `packages/ingestion/db/queries.go:1719-1792` (`EnqueueSetupPrJob`, `SetupPrInfo`, `GetSetupPrStatus`) and `queries.go:27` (`ErrNoGithubRepo` — delete only if `grep -rn ErrNoGithubRepo packages/ingestion` shows no other consumer), `packages/ingestion/handler/admin.go:15` (drop `"setup_pr": {}` from the job-type allowlist), `packages/ingestion/db/admin.go:98` (drop `"setup_pr": 0` from the `ByType` seed), `packages/ingestion/db/admin_test.go`

- [ ] **Step 1: Delete + unwire, then build** — `go build ./...`. Fix fallout. `projects.setup_pr_*` columns stay (spec §5.6).
- [ ] **Step 2: 404 assertion** — add to an existing handler test file (e.g. the routes-level test in `route_matrix_test.go` if its framework fits, otherwise `onboarding_state_test.go`) a spot check that `POST /api/v1/projects/{id}/setup-pr` now 404s. (`route_matrix_test.go` has no setup-pr rows to remove — it covers project-key auth.)
- [ ] **Step 3: Run** — `go test ./...` zero skips. **Step 4: Commit** — `git add -A packages/ingestion && git commit -m "feat(ingestion): delete setup-PR routes and queries"`

### Task 14: Dashboard + shared type deletion

**Files:**
- Modify: `packages/dashboard/src/api.ts:571-579` (delete `triggerSetupPR`, `getSetupPRStatus`), `packages/dashboard/src/types/api.ts:392-397` (delete `SetupPrStatus`), `shared/src/types.ts:479` (drop `'setup_pr'` from `JobType`) and `:509-515` (delete the shared `SetupPrStatus`)
- **Keep** `'setup_pr'` in the dashboard's `AdminJobType` (`types/api.ts` ~407): migration 063 leaves historical `dead_letter` rows, and the admin job queries enumerate stored types from the DB (`db/admin.go:233-249, 346-360`) — the admin view must still be able to render them. Add a comment `// historical only: retired job type, rows persist as dead_letter`.
- Leave `docs/design/dashboard-v1/api-baseline.d.ts` untouched (historical baseline).

- [ ] **Step 1: Delete, rebuild everything** — `rm -rf packages/*/dist shared/dist && pnpm -r build` (dist survival masks stale-type breakage per AGENTS.md). Fix fallout — `grep -rn "setup_pr\|SetupPrStatus" packages shared --include='*.ts' --include='*.vue'` must return only the `AdminJobType` historical entry and worker/ingestion test seeds you deliberately kept.
- [ ] **Step 2: Run full JS suite** — `pnpm test` with `DATABASE_URL`. **Step 3: Commit** — `git add packages/dashboard/src/api.ts packages/dashboard/src/types/api.ts shared/src/types.ts && git commit -m "feat: remove setup-PR types and wrappers from dashboard and shared"`

**Milestone 3 gate:** spec Appendix A M3 — 404 on the route, clean health on seeded legacy rows, references reduced to the documented historical entries, full repo gate.

---

## Milestone 4 — Docs sync (Task 15)

### Task 15: Documentation

**Files:**
- Modify: `docs/install.md` (quickstart alignment: inline-key caveat — "the key ships in your bundle; move it to an env var before committing", dev environment, test button; Next.js section review to parity), `docs/guides/github-app.md` (App vs PAT modes as the wizard presents them; `covers:` list loses `packages/worker/src/setup-pr.ts`), `docs/guides/slack-notifications.md` (wizard flow: create-disabled → test → enable), `docs/guides/api-keys.md` (ingest keys now visible/revocable in Settings; `scope` field), `docs/reference/http-routes.md` (drop the setup-pr rows; add `/onboarding/state`, `/onboarding/complete`; note the event-count response change)

- [ ] **Step 1: Make the edits.** Every claim must match shipped behavior — cite the route table from `routes.go` as changed in Tasks 6/13.
- [ ] **Step 2: Run the doc gates** — find the exact commands with `grep -rn "check-docs" package.json scripts/ | head` and run both drift and voice checks. Fix findings.
- [ ] **Step 3: Commit** — `git add docs && git commit -m "docs: onboarding v2 — wizard quickstart, PAT mode, Slack flow, route table"`

---

## Self-review record

- Spec coverage: M1 AC1→T1, AC2→T2, AC3→T3, AC4→T4, AC5→T5, AC6→T7, AC7→T6, AC8→gates; M2 AC1-8→T8-11 + live smoke; M3→T12-14; M4→T15. Sourcemap nudge, marker matching, v2 GitHub pending detection: out of scope per spec §10.
- Backward compatibility: every M1 task leaves the live wizard working (optional token, repo passthrough, additive response fields); the only breaking client change (`onboardingSetup` signature) ships in Task 9 with its only caller.
- Type consistency: `OnboardingState` field names match Go JSON tags; `scope: 'api' | 'ingest'` consistent across db/handler/dashboard; `EventStatus.latest_error_group_id` matches Task 5's JSON key; the wizard test mock covers every function the component imports.
- Deliberate non-goals restated where a reviewer might "fix" them: deferral is session-local (spec §5.3/§5.4); invite return-path precedes the onboarding gate; `AdminJobType` keeps `setup_pr` for historical rows; the router's completion flag is a client cache with a one-hop self-heal, not the authority.
- Round-2 fixes on this revision: evaluator short-circuits before fact queries and degrades optional-fact errors to no-nag; `complete` queries only its hard gate; `userJSON.onboarding_complete` is a pointer (token-issuance paths also serialize the struct); mint+cap is one transaction ordered by `created_at DESC, id DESC`; mint-on-resume failure renders a retry, not an empty-key snippet; facts-complete completion failure lands on the Slack panel; router gains the cached completion flag; banners read `getOnboardingState` (installation+repo, not repo-string) and refresh on `opslane-integrations-changed`, keeping last-known state on error; settlement migration spares actively-leased rows and documents deploy order; event polling has an in-flight guard; install link goes through `safeUrl`.
- Known verify-before-writing points (each task says how to resolve its own unknown): `ProjectProvisioning` field names (T2), uuid package import path (T2), `api_keys_test.go` helper names (T3), event-seeding helper (T5), `github/app.go` client/base-URL names (T7), dashboard build filter name (T8), Settings route path string (T11), worker setup test filenames (T12), doc-check script names (T15).
