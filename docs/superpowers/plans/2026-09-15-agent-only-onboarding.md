# Agent-only Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-step `/setup` wizard with one screen that shows the `Set up https://docs.opslane.com/INSTALL.md` agent prompt, and let the dashboard mark onboarding complete as soon as any project in the org receives an event.

**Architecture:** The Go ingestion service loses `POST /api/v1/onboarding/setup` and its provisioning query, and its onboarding event gate becomes org-wide through a new `db.OrgHasEvents`. The Vue dashboard replaces `SetupWizard.vue` with a small polling page (`Setup.vue`) and teaches the agent approve page to complete onboarding from the session's event. Tests, the e2e mock harness, and docs follow.

**Tech Stack:** Go 1.25 (chi, pgx), Vue 3 `<script setup>` + TypeScript, Vitest + @vue/test-utils (jsdom), Playwright-backed e2e harness in `test-e2e`.

**Spec:** `docs/superpowers/specs/2026-09-15-agent-only-onboarding-design.md` (revision 3). Read it before starting; acceptance criteria numbers (AC1–AC15) below refer to it.

## Implementation status (2026-09-15)

- [x] Tasks 1–2: org-wide event gate and removal of the wizard setup endpoint (`1238542`).
- [x] Tasks 3–4: agent-only setup page and approve-page completion (`b202748`).
- [x] Task 5: waiting-state browser mocks and request manifest (`a03a959`). All 14 browser smoke tests and 46 screenshot captures passed without skips.
- [x] Task 6: documentation and stale comment cleanup (`5644304`, `4235fab`). `pnpm test:repo` passed.
- [x] Live smoke: a headless agent installed the published SDK in a disposable Vue app; browser approval updated the waiting tab; its test error opened the dashboard automatically. The selected project belonged to the fresh org, both storage flags were set, and the agent's later completion request returned 200.
- [x] Go gate: `go build ./...` and `go test -count=1 -timeout=20m -json ./...` passed: 2,025 tests including subtests, zero test skips (660 handler and 483 database tests).
- [x] Workspace install/build and Node verification: dashboard 456 passed, SDK 410 passed in the Playwright container, worker 2,149 passed with 11 separately gated tests skipped (6 poller reliability, 5 live-provider). Remaining workspace suites and `pnpm test:repo` passed. The worker used a fresh database.
- [x] Cleanup: stopped the runbook server and ran `docker compose -p agentonly down`; screenshots and logs remain outside tracked source.
- [x] Follow-up issue drafts prepared and approval requested as required by Task 7, step 4. No issues filed without approval.

Implementation notes:

- The two ingestion tasks and the two dashboard tasks were committed together. The named Superpowers skills were unavailable, so the plan was executed directly.
- Added coverage for a late account response, project-selection fallback, and an agent attached to an older project. The docs voice gate requires “creates” instead of “mints” in the API-key guide.
- The docs snippet check needs workspace build outputs. Run `pnpm -r build` first. Unset `REPLAY_STORE_PUBLIC_ENDPOINT` for the Compose-port checker, which deliberately changes the MinIO port.
- The host's `pnpm test` stopped at the SDK browser matrix because WebKit libraries were missing and sudo required a password. The full SDK suite passed in the existing `mcr.microsoft.com/playwright:v1.62.1-noble` container, including Chromium, Firefox, and WebKit; remaining workspace suites were verified separately.
- Worker queue tests require a separate empty database: Go tests and the live smoke leave jobs that their global queue can claim. The worker suite passed after migrating a fresh database.

## Global Constraints

- The prompt line is exactly `Set up https://docs.opslane.com/INSTALL.md` (unchanged; it lives in `AgentPasteBox.vue`).
- Status lines, verbatim: `Waiting for your agent. It will give you a link to approve.` / `Project ready. Waiting for the first event from your app.` / `First event received. Opening your dashboard…` / `Could not check setup status. Retrying.`
- Error lines, verbatim: `Could not load your account.` / `Could not load your projects.`; completion failures show the error message under `Could not finish setup.`
- Setup page heading, verbatim: `Set up Opslane with your coding agent`.
- Poll interval: 3000 ms, one state request in flight at a time.
- Route name stays `setup`, path stays `/setup`.
- No migration. Do not touch `docs-site/public/INSTALL.md`.
- Keep `provisionProjectTx`, `EnsureProjectDefaultEnvironmentTx`, `CreateProjectKeyTx`, `RevokeExcessOnboardingKeysTx`, `HasEvents`, `HasEventsSince`, `GET /projects/{projectID}/event-count`.
- Use ESM, strict TypeScript, `unknown` plus narrowing instead of `any`. Vitest tests live in `__tests__` (existing colocated `*.test.ts` files stay where they are).
- Commit author for this repo is `abhishek@opslane.com` (already the worktree's `user.email`).

## Environment for Go and e2e steps

Go database tests silently `t.Skip` without these. From the worktree root, pick free ports (check with `ss -ltn` first; another stack may own 5444/8092/9022) and export the block from the root `AGENTS.md` as one unit, for example:

```bash
export INGESTION_PORT=8312 OPSLANE_POSTGRES_HOST_PORT=5712 OPSLANE_MINIO_HOST_PORT=9312
export INGESTION_URL="http://localhost:$INGESTION_PORT"
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:$OPSLANE_POSTGRES_HOST_PORT/opslane?sslmode=disable"
export MINIO_ENDPOINT="http://localhost:$OPSLANE_MINIO_HOST_PORT"
export REPLAY_STORE_ENDPOINT="$MINIO_ENDPOINT" REPLAY_STORE_PUBLIC_ENDPOINT="$MINIO_ENDPOINT"
export MINIO_ACCESS_KEY=minio MINIO_SECRET_KEY=minio12345 MINIO_BUCKET=opslane-replays
export REPLAY_STORE_ACCESS_KEY=minio REPLAY_STORE_SECRET_KEY=minio12345 REPLAY_STORE_BUCKET=opslane-replays
docker compose -p agentonly up -d --wait postgres minio
docker compose -p agentonly run --rm minio-setup
MIGRATION_DIR=packages/ingestion/db/migrations ./scripts/run-migrations.sh
export SCRATCH="${SCRATCH:-$(mktemp -d)}"   # use the session scratchpad when one exists
mkdir -p "$SCRATCH/runbook"
```

`psql` must be on `PATH` (`db/migrations_test.go` skips without it). `run-migrations.sh` applies every file in `MIGRATION_DIR` to `DATABASE_URL` in order. Run every command in this plan from the repository root; Go commands use a `(cd packages/ingestion && …)` subshell so the shell stays at the root.

---

## File map

| File | Change | Responsibility after the change |
| --- | --- | --- |
| `packages/ingestion/db/queries.go` | modify | add `OrgHasEvents`; delete `ErrOrgOnboarded`, `OnboardingProvision`; simplify `MarkOrgOnboarded` |
| `packages/ingestion/db/org_has_events_test.go` | create | `OrgHasEvents` contract |
| `packages/ingestion/handler/onboarding_state.go` | modify | org-wide event gate, no `next_step` |
| `packages/ingestion/handler/onboarding.go` | delete | (survivors move to `read_api.go`) |
| `packages/ingestion/handler/read_api.go` | modify | owns `projectCreateLimiter` and `environmentJSON` |
| `packages/ingestion/handler/routes.go` | modify | drop the setup route |
| `packages/ingestion/handler/onboarding_test.go` | modify | helpers + GitHub coverage test via `POST /projects` |
| `packages/ingestion/handler/onboarding_state_test.go` | modify | facts-based state/complete tests, older-project case, 404 |
| `packages/ingestion/handler/project_provisioning_test.go` | modify | drop setup route from member 403 table |
| `packages/ingestion/handler/agent_session_routes_test.go` | modify | agent complete after dashboard completion |
| `packages/dashboard/src/views/Setup.vue` | create | agent-only setup page |
| `packages/dashboard/src/views/__tests__/setup.test.ts` | create | setup page behaviour |
| `packages/dashboard/src/views/SetupWizard.vue`, `views/__tests__/setup-wizard.test.ts` | delete | |
| `packages/dashboard/src/router.ts` | modify | route `setup` → `Setup.vue` |
| `packages/dashboard/src/components/AgentPasteBox.vue` (+ test) | modify | prompt box only, no variants |
| `packages/dashboard/src/views/AgentApprove.vue` (+ test) | modify | complete onboarding from the session event |
| `packages/dashboard/src/api.ts`, `src/types/api.ts` | modify | delete wizard-only client code and `next_step` |
| `packages/dashboard/src/components/__tests__/onboarding-banners.test.ts` | modify | fixture without `next_step` |
| `packages/dashboard/src/views/SessionsList.test.ts`, `views/__tests__/issues-list-filters.test.ts` | modify | empty states assert the prompt box, not "Setup guide" |
| `test-e2e/dashboard-mock-harness.ts`, `dashboard-design-system.test.ts`, `dashboard-screenshots.test.ts` | modify | waiting-state mock and new identity |
| `docs/design/dashboard-v1/request-manifest.json` | modify | drop removed requests; state polls every 3000 ms |
| `docs/install.md`, `docs/guides/{api-keys,github-app,slack-notifications}.md`, `docs/reference/http-routes.md`, `TODOS.md` | modify | no wizard references |

---

### Task 1: Org-wide onboarding event gate

Makes `GET /onboarding/state` and `POST /onboarding/complete` count an event on any project of the org, drops `next_step`, and moves the handler tests off `/onboarding/setup` (the route still exists until Task 2).

**Files:**
- Modify: `packages/ingestion/db/queries.go` (add after `HasEventsSince`, around line 4170)
- Create: `packages/ingestion/db/org_has_events_test.go`
- Modify: `packages/ingestion/handler/onboarding_state.go`
- Modify: `packages/ingestion/handler/onboarding_test.go`
- Modify: `packages/ingestion/handler/onboarding_state_test.go`

**Interfaces:**
- Consumes: `db.New(pool)`, `q.CreateOrg`, `q.CreateProject(ctx, orgID, name string, githubRepo *string)`, `q.CreateEnvironment(ctx, projectID, name)`, test helpers `testPool`, `cleanupTenant` (db package) and `testDeps`, `cleanupTenantHandler`, `seedTenantNoProject`, `onboardingHTTP`, `mustDecodeOnboarding`, `authTestJWTSecret`, `cloudAuthStub` (handler package).
- Produces: `func (q *Queries) OrgHasEvents(ctx context.Context, orgID string) (bool, error)`; handler test helpers `createProjectForOnboarding(t, router, token, body) onboardingCreatedProject` and `ingestOnboardingEvent(t, router, rawKey)`; `onboardingStateJSON` without `NextStep`.

- [ ] **Step 1: Write the failing db test**

Create `packages/ingestion/db/org_has_events_test.go`:

```go
package db_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestOrgHasEvents(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())

	org, err := q.CreateOrg(ctx, "org-has-events-"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	older, err := q.CreateProject(ctx, org.ID, "older", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.CreateProject(ctx, org.ID, "newer", nil); err != nil {
		t.Fatal(err)
	}
	olderEnv, err := q.CreateEnvironment(ctx, older.ID, "production")
	if err != nil {
		t.Fatal(err)
	}

	otherOrg, err := q.CreateOrg(ctx, "org-has-events-other-"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, otherOrg.ID) })
	otherProject, err := q.CreateProject(ctx, otherOrg.ID, "other", nil)
	if err != nil {
		t.Fatal(err)
	}
	otherEnv, err := q.CreateEnvironment(ctx, otherProject.ID, "production")
	if err != nil {
		t.Fatal(err)
	}

	insertEvent := func(projectID, environmentID string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `
			INSERT INTO error_events
				(project_id, environment_id, timestamp, error_type, error_message, stack_trace_raw, created_at)
			VALUES ($1, $2, now(), 'OrgHasEventsTest', 'org has events', 'stack', now())`,
			projectID, environmentID); err != nil {
			t.Fatalf("insert event: %v", err)
		}
	}

	if has, err := q.OrgHasEvents(ctx, org.ID); err != nil || has {
		t.Fatalf("no events: got (%v, %v), want (false, nil)", has, err)
	}
	insertEvent(otherProject.ID, otherEnv.ID)
	if has, err := q.OrgHasEvents(ctx, org.ID); err != nil || has {
		t.Fatalf("another org's event must not count: got (%v, %v)", has, err)
	}
	insertEvent(older.ID, olderEnv.ID)
	if has, err := q.OrgHasEvents(ctx, org.ID); err != nil || !has {
		t.Fatalf("event on the older project: got (%v, %v), want (true, nil)", has, err)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `(cd packages/ingestion && go test -count=1 ./db -run TestOrgHasEvents -v)`
Expected: build failure `q.OrgHasEvents undefined`. If it prints `--- SKIP`, the environment block above is not exported; fix that before continuing.

- [ ] **Step 3: Implement `OrgHasEvents`**

In `packages/ingestion/db/queries.go`, directly after the `HasEventsSince` function, add:

```go
// OrgHasEvents reports whether any project in the org has received an error
// event. Onboarding completion uses it so the first event counts whichever
// project an agent attached.
func (q *Queries) OrgHasEvents(ctx context.Context, orgID string) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM projects p
			WHERE p.org_id = $1
			  AND EXISTS(SELECT 1 FROM error_events e WHERE e.project_id = p.id)
		)`, orgID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("org has events: %w", err)
	}
	return exists, nil
}
```

- [ ] **Step 4: Run the db test to verify it passes**

Run: `(cd packages/ingestion && go test -count=1 ./db -run TestOrgHasEvents -v)`
Expected: `--- PASS: TestOrgHasEvents`.

- [ ] **Step 5: Add handler test helpers and migrate the GitHub coverage test**

Confirm the new names are free: `grep -rn "createProjectForOnboarding\|ingestOnboardingEvent\|onboardingCreatedProject" packages/ingestion` must print nothing.

In `packages/ingestion/handler/onboarding_test.go`, add after `mustDecodeOnboarding`:

```go
type onboardingCreatedProject struct {
	Project struct {
		ID string `json:"id"`
	} `json:"project"`
	APIKey struct {
		RawKey string `json:"raw_key"`
	} `json:"api_key"`
}

// createProjectForOnboarding creates a project the way Settings does. The
// endpoint requires an idempotency token, so every body must carry one.
func createProjectForOnboarding(t *testing.T, router http.Handler, token, body string) onboardingCreatedProject {
	t.Helper()
	response := onboardingHTTP(t, router, http.MethodPost, "/api/v1/projects", token, body)
	if response.Code != http.StatusCreated {
		t.Fatalf("create project: got %d body=%s", response.Code, response.Body.String())
	}
	var created onboardingCreatedProject
	mustDecodeOnboarding(t, response.Body, &created)
	return created
}

func ingestOnboardingEvent(t *testing.T, router http.Handler, rawKey string) {
	t.Helper()
	body := `{
		"timestamp":"2026-08-26T00:00:00Z",
		"error":{"type":"Error","message":"onboarding event","stack":"at onboarding.js:1:1"},
		"breadcrumbs":[],"context":{"url":"https://example.test"},"sdk_version":"0.1.0"
	}`
	request := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-API-Key", rawKey)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("event: got %d body=%s", response.Code, response.Body.String())
	}
}
```

In `TestOnboardingState_GitHubConnectedRequiresRepoCoverage`, replace:

```go
	setup := onboardingHTTP(t, router, http.MethodPost, "/api/v1/onboarding/setup", cred,
		`{"project_name":"web","github_repo":"acme/web"}`)
	if setup.Code != http.StatusCreated {
		t.Fatalf("setup: got %d body=%s", setup.Code, setup.Body.String())
	}
```

with:

```go
	createProjectForOnboarding(t, router, cred,
		`{"name":"web","github_repo":"acme/web","idempotency_token":"coverage-test"}`)
```

- [ ] **Step 6: Rewrite the state/complete handler test**

Replace the whole body of `packages/ingestion/handler/onboarding_state_test.go` with:

```go
package handler_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

type onboardingStateResponse struct {
	OnboardingComplete bool    `json:"onboarding_complete"`
	ProjectID          *string `json:"project_id"`
	HasEvents          bool    `json:"has_events"`
	GitHubConnected    bool    `json:"github_connected"`
	GitHubMode         string  `json:"github_mode"`
	SlackConnected     bool    `json:"slack_connected"`
}

func readOnboardingState(t *testing.T, router http.Handler, token string) (onboardingStateResponse, string) {
	t.Helper()
	response := onboardingHTTP(t, router, http.MethodGet, "/api/v1/onboarding/state", token, "")
	if response.Code != http.StatusOK {
		t.Fatalf("state status=%d body=%s", response.Code, response.Body.String())
	}
	raw := response.Body.String()
	var state onboardingStateResponse
	if err := json.NewDecoder(strings.NewReader(raw)).Decode(&state); err != nil {
		t.Fatal(err)
	}
	return state, raw
}

func TestOnboardingStateAndCompleteShareTheEventGate(t *testing.T) {
	deps, pool := testDeps(t)
	deps.JWTSecret = []byte(authTestJWTSecret)
	deps.AuthProvider = cloudAuthStub{}
	router := handler.NewRouterWithPool(deps, pool)
	orgID, token := seedTenantNoProject(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		return onboardingHTTP(t, router, method, path, token, body)
	}

	state, raw := readOnboardingState(t, router, token)
	if state.ProjectID != nil || state.HasEvents || state.OnboardingComplete {
		t.Fatalf("fresh state=%+v", state)
	}
	if strings.Contains(raw, "next_step") {
		t.Fatalf("state must not carry next_step: %s", raw)
	}

	created := createProjectForOnboarding(t, router, token, `{"name":"web","idempotency_token":"state-test"}`)
	if state, _ := readOnboardingState(t, router, token); state.ProjectID == nil || *state.ProjectID != created.Project.ID || state.HasEvents {
		t.Fatalf("pre-event state=%+v", state)
	}
	blocked := request(http.MethodPost, "/api/v1/onboarding/complete", `{}`)
	if blocked.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(blocked.Body.String(), `"missing":["first_event"]`) {
		t.Fatalf("blocked complete status=%d body=%s", blocked.Code, blocked.Body.String())
	}

	ingestOnboardingEvent(t, router, created.APIKey.RawKey)
	if state, _ := readOnboardingState(t, router, token); !state.HasEvents || state.OnboardingComplete {
		t.Fatalf("post-event state=%+v", state)
	}

	completed := request(http.MethodPost, "/api/v1/onboarding/complete", `{}`)
	if completed.Code != http.StatusOK || !strings.Contains(completed.Body.String(), `"onboarding_complete":true`) {
		t.Fatalf("complete status=%d body=%s", completed.Code, completed.Body.String())
	}
	if state, _ := readOnboardingState(t, router, token); !state.OnboardingComplete || !state.HasEvents {
		t.Fatalf("completed state=%+v", state)
	}
	me := request(http.MethodGet, "/api/v1/auth/me", "")
	if me.Code != http.StatusOK || !strings.Contains(me.Body.String(), `"onboarding_complete":true`) {
		t.Fatalf("auth/me status=%d body=%s", me.Code, me.Body.String())
	}
	second := request(http.MethodPost, "/api/v1/onboarding/complete", `{}`)
	if second.Code != http.StatusOK {
		t.Fatalf("second complete status=%d body=%s", second.Code, second.Body.String())
	}
	retiredSetupPR := request(http.MethodPost, "/api/v1/projects/"+created.Project.ID+"/setup-pr", `{}`)
	if retiredSetupPR.Code != http.StatusNotFound {
		t.Fatalf("retired setup-pr route status=%d body=%s", retiredSetupPR.Code, retiredSetupPR.Body.String())
	}
}

func TestOnboardingCompleteCountsAnEventOnAnOlderProject(t *testing.T) {
	deps, pool := testDeps(t)
	deps.JWTSecret = []byte(authTestJWTSecret)
	deps.AuthProvider = cloudAuthStub{}
	router := handler.NewRouterWithPool(deps, pool)
	orgID, token := seedTenantNoProject(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	older := createProjectForOnboarding(t, router, token, `{"name":"older","idempotency_token":"older-project"}`)
	newer := createProjectForOnboarding(t, router, token, `{"name":"newer","idempotency_token":"newer-project"}`)
	ingestOnboardingEvent(t, router, older.APIKey.RawKey)

	state, _ := readOnboardingState(t, router, token)
	if state.ProjectID == nil || *state.ProjectID != newer.Project.ID || !state.HasEvents {
		t.Fatalf("state must name the newest project and count the older project's event: %+v", state)
	}
	completed := onboardingHTTP(t, router, http.MethodPost, "/api/v1/onboarding/complete", token, `{}`)
	if completed.Code != http.StatusOK {
		t.Fatalf("complete status=%d body=%s", completed.Code, completed.Body.String())
	}
}
```

- [ ] **Step 7: Run the handler tests to verify the new cases fail**

Run: `(cd packages/ingestion && go test -count=1 ./handler -run 'TestOnboarding' -v)`
Expected: `TestOnboardingStateAndCompleteShareTheEventGate` FAILS on `state must not carry next_step`, and `TestOnboardingCompleteCountsAnEventOnAnOlderProject` FAILS on the state check (newest project has no events). `TestOnboardingSetupIdempotency` and `TestOnboardingState_GitHubConnectedRequiresRepoCoverage` pass.

- [ ] **Step 8: Rewrite `onboarding_state.go`**

Replace the top of `packages/ingestion/handler/onboarding_state.go` from `type onboardingStateJSON struct` through the end of `evaluateOnboarding` with:

```go
type onboardingStateJSON struct {
	OnboardingComplete bool    `json:"onboarding_complete"`
	ProjectID          *string `json:"project_id"`
	HasEvents          bool    `json:"has_events"`
	GitHubConnected    bool    `json:"github_connected"`
	GitHubMode         string  `json:"github_mode"`
	SlackConnected     bool    `json:"slack_connected"`
}

// evaluateOnboarding derives onboarding facts from the server. has_events is
// org-wide because an agent may attach any project. Stored completion wins
// over fact regression; optional integration failures degrade to no nag.
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
			return state, nil
		}
		return state, err
	}
	state.ProjectID = projectID
	if projectID == nil {
		// No project means no events; integrations cannot be connected yet.
		return state, nil
	}

	if onboarded {
		// has_events stays a truthful data fact after completion (a backfilled
		// org may never have ingested). Degrade open on error: completion is
		// already set.
		if hasEvents, optionalErr := d.Queries.OrgHasEvents(r.Context(), orgID); optionalErr == nil {
			state.HasEvents = hasEvents
		} else {
			state.HasEvents = true
		}
		state.GitHubConnected = d.optionalGitHubConnected(r, orgID, repo)
		if connected, optionalErr := d.Queries.HasEnabledDigestDestination(r.Context(), *projectID); optionalErr == nil {
			state.SlackConnected = connected
		} else {
			state.SlackConnected = true
		}
		return state, nil
	}

	state.HasEvents, err = d.Queries.OrgHasEvents(r.Context(), orgID)
	if err != nil {
		return state, err
	}
	state.GitHubConnected = d.optionalGitHubConnected(r, orgID, repo)
	state.SlackConnected, err = d.Queries.HasEnabledDigestDestination(r.Context(), *projectID)
	if err != nil {
		return state, err
	}
	return state, nil
}
```

Keep `optionalGitHubConnected` and `OnboardingState` unchanged. Replace the body of `OnboardingComplete` (and its comment) with:

```go
// OnboardingComplete records completion when the sole hard gate is met: any
// project in the org has received an event.
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

	hasEvents, err := d.Queries.OrgHasEvents(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to compute onboarding state")
		return
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

- [ ] **Step 9: Run the handler and db tests to verify they pass**

Run: `(cd packages/ingestion && go build ./... && go test -count=1 -v ./db -run TestOrgHasEvents && go test -count=1 -v ./handler -run 'TestOnboarding|TestAgentSessionRoutes|TestAgentApprove')`
Expected: the command exits 0. Read the whole output, including indented subtests: every test shows `--- PASS`, and there is no `--- SKIP` or `--- FAIL`.

- [ ] **Step 10: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/db/org_has_events_test.go \
  packages/ingestion/handler/onboarding_state.go packages/ingestion/handler/onboarding_test.go \
  packages/ingestion/handler/onboarding_state_test.go
git commit -m "feat(ingestion): count onboarding's first event on any project in the org

An agent can attach an older project, and the approve page then saw an
event while completion checked only the newest project and returned 422.
State and complete now ask whether any project in the org has an event.
The state response drops next_step, which only the wizard read."
```

---

### Task 2: Remove `POST /onboarding/setup`

**Files:**
- Modify: `packages/ingestion/handler/routes.go:146`
- Delete: `packages/ingestion/handler/onboarding.go`
- Modify: `packages/ingestion/handler/read_api.go` (above `CreateProjectEndpoint`, around line 1050)
- Modify: `packages/ingestion/db/queries.go` (lines 26-27, 845-913, `MarkOrgOnboarded` near 4235)
- Modify: `packages/ingestion/handler/onboarding_test.go`, `onboarding_state_test.go`, `project_provisioning_test.go:108`, `agent_session_routes_test.go`

**Interfaces:**
- Consumes: Task 1 helpers `createProjectForOnboarding`, `readOnboardingState`; approve rig `approvedRig`, `ingestTestEvent`, `sessionCall`, `approveRig.do` (in `agent_approve_test.go`, `agent_poll_test.go`, `agent_session_routes_test.go`).
- Produces: `var projectCreateLimiter` and `type environmentJSON` in `read_api.go`. No exported API change beyond the removed route and the removed `db.OnboardingProvision`/`db.ErrOrgOnboarded`.

- [ ] **Step 1: Write the failing tests**

In `onboarding_state_test.go`, inside `TestOnboardingStateAndCompleteShareTheEventGate`, after the `retiredSetupPR` check, add:

```go
	retiredSetup := request(http.MethodPost, "/api/v1/onboarding/setup", `{"project_name":"web","idempotency_token":"retired"}`)
	if retiredSetup.Code != http.StatusNotFound {
		t.Fatalf("retired onboarding setup route status=%d body=%s", retiredSetup.Code, retiredSetup.Body.String())
	}
```

In `agent_session_routes_test.go`, after `TestAgentSessionRoutes_CompleteRequiresSessionEventEvenWhenOrgOnboarded`, add:

```go
func TestAgentSessionRoutes_CompleteAfterDashboardCompletedOnboarding(t *testing.T) {
	a := approvedRig(t)
	ingestTestEvent(t, a)
	if code, out := a.do(t, http.MethodPost, "/api/v1/onboarding/complete", `{}`, true); code != http.StatusOK || out["onboarding_complete"] != true {
		t.Fatalf("dashboard complete: %d %v", code, out)
	}
	if code, out := sessionCall(t, a, http.MethodPost, "complete", "", a.token); code != http.StatusOK || out["onboarding_complete"] != true {
		t.Fatalf("agent complete after the dashboard completed onboarding: %d %v", code, out)
	}
}
```

- [ ] **Step 2: Run to verify the 404 assertion fails and the agent test passes**

Run: `(cd packages/ingestion && go test -count=1 ./handler -run 'TestOnboardingStateAndCompleteShareTheEventGate|TestAgentSessionRoutes_CompleteAfterDashboardCompletedOnboarding' -v)`
Expected: the state test FAILS with `retired onboarding setup route status=409` (the org is already onboarded at that point, so the old handler answers 409); the agent test PASSES (it pins behaviour this task must keep).

- [ ] **Step 3: Delete the route, handler, and query**

1. In `packages/ingestion/handler/routes.go`, delete the line
   `r.With(deps.AuthenticateUserSession, deps.RequireRoleIfCloud("admin")).Post("/onboarding/setup", deps.OnboardingSetup)`.
2. In `packages/ingestion/handler/read_api.go`, directly above the `// CreateProjectEndpoint creates a new project` comment, add:

```go
// projectCreateLimiter caps project creation per client IP.
var projectCreateLimiter = newRateLimiter(5) // 5/min

// environmentJSON is the JSON representation of an environment.
type environmentJSON struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
}
```

   and in `CreateProjectEndpoint` change `if !onboardingLimiter.allow(ip) {` to `if !projectCreateLimiter.allow(ip) {`.
3. Delete `packages/ingestion/handler/onboarding.go`.
4. In `packages/ingestion/db/queries.go`, delete the two lines

```go
// ErrOrgOnboarded rejects onboarding setup for an org whose wizard already completed.
var ErrOrgOnboarded = errors.New("org already onboarded")
```

   and delete the whole `OnboardingProvision` function together with its two-line comment (`// OnboardingProvision is the wizard's project bootstrap...` through the closing `}` before `// provisionProjectTx performs`).
5. Replace `MarkOrgOnboarded` (and its comment) with:

```go
// MarkOrgOnboarded records completion once; replays are no-ops.
func (q *Queries) MarkOrgOnboarded(ctx context.Context, orgID string) error {
	if _, err := q.pool.Exec(ctx,
		`UPDATE orgs SET onboarded_at = now() WHERE id = $1 AND onboarded_at IS NULL`, orgID,
	); err != nil {
		return fmt.Errorf("mark onboarded: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Delete the setup tests**

1. In `onboarding_test.go`, delete the whole `TestOnboardingSetupIdempotency` function. Then run `goimports`-style cleanup by building: if `context`, `fmt`, `time`, `uuid`, or `auth` become unused the build says so; they are still used by `seedTenantNoProject` and the coverage test, so expect none.
2. In `project_provisioning_test.go`, delete the table row `{http.MethodPost, "/api/v1/onboarding/setup"},`.
3. Confirm nothing else references the removed code:

Run: `grep -rn "OnboardingSetup\b\|OnboardingProvision\|ErrOrgOnboarded\|onboardingLimiter\|onboarding/setup" packages/ingestion`
Expected: only the `retiredSetup` 404 assertion in `onboarding_state_test.go`.

- [ ] **Step 5: Build and run the affected packages**

Run: `(cd packages/ingestion && go vet ./handler ./db && go build ./... && go test -count=1 -v ./db -run TestOrgHasEvents && go test -count=1 -v ./handler -run 'TestOnboarding|TestAgentSessionRoutes|TestAgentApprove|TestRequireRoleIfCloud|TestCreateProjectEndpoint')`
Expected: the command exits 0. Read the whole output: every test shows `--- PASS`, and there is no `--- SKIP` or `--- FAIL`.

- [ ] **Step 6: Commit**

```bash
git add -A packages/ingestion
git commit -m "feat(ingestion)!: remove the onboarding wizard's setup endpoint

POST /api/v1/onboarding/setup only served the web wizard, which agent
setup replaces. Its rate limiter and environment JSON type move to the
project endpoint that still uses them, and MarkOrgOnboarded drops the
advisory lock that only serialized it against the deleted provisioning."
```

---

### Task 3: Agent-only `/setup` page

**Files:**
- Create: `packages/dashboard/src/views/Setup.vue`
- Create: `packages/dashboard/src/views/__tests__/setup.test.ts`
- Delete: `packages/dashboard/src/views/SetupWizard.vue`, `packages/dashboard/src/views/__tests__/setup-wizard.test.ts`
- Modify: `packages/dashboard/src/router.ts:8,25,62`
- Modify: `packages/dashboard/src/components/AgentPasteBox.vue`, `components/__tests__/agent-paste-box.test.ts`
- Modify: `packages/dashboard/src/api.ts` (lines 238-247, 590-610), `packages/dashboard/src/types/api.ts:429`
- Modify: `packages/dashboard/src/components/__tests__/onboarding-banners.test.ts:13`
- Modify: `packages/dashboard/src/views/SessionsList.test.ts:294`, `packages/dashboard/src/views/__tests__/issues-list-filters.test.ts:383-407`

**Interfaces:**
- Consumes: `getMe(): Promise<AuthUser>` (`active_role?: 'owner' | 'admin' | 'member'`), `getOnboardingState(): Promise<OnboardingState>`, `completeOnboarding(): Promise<{ onboarding_complete: boolean }>`, `listProjects(): Promise<Project[]>` from `src/api.ts`; `applyProjectSelection(storage, { id, name })` from `src/components/project-switcher.ts`; `Button` (`variant`, `busy`, emits `click`); `AgentPasteBox` (no props after this task).
- Produces: `views/Setup.vue` (default export, no props); `OnboardingState` = `{ onboarding_complete: boolean; project_id: string | null; has_events: boolean; github_connected: boolean; github_mode: 'app' | 'pat'; slack_connected: boolean }`. Test ids: `setup-status`, `setup-retry-account`, `setup-retry-complete`, `setup-retry-enter`, `setup-member`.

- [ ] **Step 1: Write the failing page test**

Create `packages/dashboard/src/views/__tests__/setup.test.ts`:

```ts
// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getMe: vi.fn(),
  getOnboardingState: vi.fn(),
  completeOnboarding: vi.fn(),
  listProjects: vi.fn(),
}));
const routerPush = vi.hoisted(() => vi.fn());

vi.mock('../../api', () => api);
vi.mock('vue-router', () => ({ useRouter: () => ({ push: routerPush }) }));

import Setup from '../Setup.vue';

const waiting = {
  onboarding_complete: false,
  project_id: null as string | null,
  has_events: false,
  github_connected: false,
  github_mode: 'app' as const,
  slack_connected: false,
};

async function advance(ms = 3000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flushPromises();
}

function status(w: ReturnType<typeof mount>): string {
  return w.get('[data-testid="setup-status"]').text();
}

describe('Setup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    api.getMe.mockResolvedValue({ active_role: 'admin' });
    api.getOnboardingState.mockResolvedValue({ ...waiting });
    api.completeOnboarding.mockResolvedValue({ onboarding_complete: true });
    api.listProjects.mockResolvedValue([{ id: 'p1', name: 'web' }]);
    routerPush.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows only the agent prompt and the waiting status', async () => {
    const w = mount(Setup);
    await flushPromises();
    expect(w.text()).toContain('Set up Opslane with your coding agent');
    expect(w.get('[data-testid="agent-paste-line"]').text()).toBe('Set up https://docs.opslane.com/INSTALL.md');
    expect(status(w)).toContain('Waiting for your agent. It will give you a link to approve.');
    expect(w.find('input').exists()).toBe(false);
    expect(w.text()).not.toMatch(/Connect GitHub|Connect Slack|Do this later|Create project/);
    w.unmount();
  });

  it('moves through the status lines as server facts change and keeps polling through a failure', async () => {
    api.getOnboardingState
      .mockResolvedValueOnce({ ...waiting })
      .mockResolvedValueOnce({ ...waiting, project_id: 'p1' })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ...waiting, project_id: 'p1' });
    const w = mount(Setup);
    await flushPromises();
    expect(status(w)).toContain('Waiting for your agent');
    await advance();
    expect(status(w)).toContain('Project ready. Waiting for the first event from your app.');
    await advance();
    expect(status(w)).toContain('Could not check setup status. Retrying.');
    await advance();
    expect(status(w)).toContain('Project ready');
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    w.unmount();
  });

  it('never overlaps state requests', async () => {
    let resolveState: (value: typeof waiting) => void = () => undefined;
    api.getOnboardingState.mockImplementationOnce(() => new Promise((resolve) => { resolveState = resolve; }));
    const w = mount(Setup);
    await flushPromises();
    await advance(10_000);
    expect(api.getOnboardingState).toHaveBeenCalledTimes(1);
    resolveState({ ...waiting });
    await flushPromises();
    await advance();
    expect(api.getOnboardingState).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it('completes onboarding on the first event, selects the project, and opens the dashboard', async () => {
    api.getOnboardingState
      .mockResolvedValueOnce({ ...waiting, project_id: 'p2' })
      .mockResolvedValue({ ...waiting, project_id: 'p2', has_events: true });
    api.listProjects.mockResolvedValue([{ id: 'p1', name: 'old' }, { id: 'p2', name: 'web' }]);
    localStorage.setItem('opslane_environment_id', 'env-stale');
    let finishComplete: () => void = () => undefined;
    api.completeOnboarding.mockImplementationOnce(() => new Promise((resolve) => { finishComplete = () => resolve({ onboarding_complete: true }); }));
    const w = mount(Setup);
    await flushPromises();
    await advance();
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
    expect(status(w)).toContain('First event received. Opening your dashboard…');
    expect(routerPush).not.toHaveBeenCalled();
    finishComplete();
    await flushPromises();
    expect(localStorage.getItem('opslane_onboarding_complete')).toBe('1');
    expect(localStorage.getItem('opslane_project_id')).toBe('p2');
    expect(localStorage.getItem('opslane_project_name')).toBe('web');
    expect(localStorage.getItem('opslane_environment_id')).toBeNull();
    expect(routerPush).toHaveBeenCalledWith('/');
    await advance(10_000);
    expect(api.getOnboardingState).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it('shows Try again when completion fails, stays on setup, and retries', async () => {
    api.getOnboardingState.mockResolvedValue({ ...waiting, project_id: 'p1', has_events: true });
    api.completeOnboarding.mockRejectedValueOnce(new Error('API 500')).mockResolvedValue({ onboarding_complete: true });
    const w = mount(Setup);
    await flushPromises();
    expect(w.text()).toContain('Could not finish setup.');
    expect(w.text()).toContain('API 500');
    expect(routerPush).not.toHaveBeenCalled();
    expect(localStorage.getItem('opslane_onboarding_complete')).toBeNull();
    await advance(10_000);
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
    await w.get('[data-testid="setup-retry-complete"]').trigger('click');
    await flushPromises();
    expect(api.completeOnboarding).toHaveBeenCalledTimes(2);
    expect(routerPush).toHaveBeenCalledWith('/');
    w.unmount();
  });

  it('enters an onboarded org that has a project without calling complete', async () => {
    api.getOnboardingState.mockResolvedValue({ ...waiting, onboarding_complete: true, project_id: 'p1', has_events: true });
    const w = mount(Setup);
    await flushPromises();
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    expect(localStorage.getItem('opslane_project_id')).toBe('p1');
    expect(routerPush).toHaveBeenCalledWith('/');
    w.unmount();
  });

  it('keeps an onboarded org with no project on the prompt, then enters once a project exists', async () => {
    api.getOnboardingState
      .mockResolvedValueOnce({ ...waiting, onboarding_complete: true })
      .mockResolvedValue({ ...waiting, onboarding_complete: true, project_id: 'p1' });
    const w = mount(Setup);
    await flushPromises();
    expect(routerPush).not.toHaveBeenCalled();
    expect(w.find('[data-testid="agent-paste-line"]').exists()).toBe(true);
    await advance();
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    expect(routerPush).toHaveBeenCalledWith('/');
    w.unmount();
  });

  it('shows members the ask-an-admin screen, never completes, and enters once the org is ready', async () => {
    api.getMe.mockResolvedValue({ active_role: 'member' });
    api.getOnboardingState
      .mockResolvedValueOnce({ ...waiting, project_id: 'p1', has_events: true })
      .mockResolvedValue({ ...waiting, onboarding_complete: true, project_id: 'p1', has_events: true });
    const w = mount(Setup);
    await flushPromises();
    expect(w.get('[data-testid="setup-member"]').text()).toContain('Ask an organization admin to finish setup');
    expect(w.find('[data-testid="agent-paste-line"]').exists()).toBe(false);
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    await advance();
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    expect(routerPush).toHaveBeenCalledWith('/');
    w.unmount();
  });

  it('keeps members on their own screen when loading projects fails', async () => {
    api.getMe.mockResolvedValue({ active_role: 'member' });
    api.getOnboardingState.mockResolvedValue({ ...waiting, onboarding_complete: true, project_id: 'p1', has_events: true });
    api.listProjects.mockRejectedValueOnce(new Error('API 500'));
    const w = mount(Setup);
    await flushPromises();
    expect(w.get('[data-testid="setup-member"]').text()).toContain('Could not load your projects.');
    expect(w.find('[data-testid="agent-paste-line"]').exists()).toBe(false);
    await w.get('[data-testid="setup-retry-enter"]').trigger('click');
    await flushPromises();
    expect(routerPush).toHaveBeenCalledWith('/');
    w.unmount();
  });

  it.each([
    ['rejects', () => { api.listProjects.mockRejectedValueOnce(new Error('API 500')); }],
    ['is empty', () => { api.listProjects.mockResolvedValueOnce([]); }],
  ])('stays on setup with Try again when listing projects %s', async (_label, arrange) => {
    arrange();
    api.getOnboardingState.mockResolvedValue({ ...waiting, onboarding_complete: true, project_id: 'p1' });
    const w = mount(Setup);
    await flushPromises();
    expect(w.text()).toContain('Could not load your projects.');
    expect(routerPush).not.toHaveBeenCalled();
    expect(localStorage.getItem('opslane_project_id')).toBeNull();
    expect(localStorage.getItem('opslane_onboarding_complete')).toBeNull();
    await w.get('[data-testid="setup-retry-enter"]').trigger('click');
    await flushPromises();
    expect(routerPush).toHaveBeenCalledWith('/');
    w.unmount();
  });

  it('reads no setup state until the account loads', async () => {
    api.getMe.mockRejectedValueOnce(new Error('API 500')).mockResolvedValue({ active_role: 'admin' });
    const w = mount(Setup);
    await flushPromises();
    expect(w.text()).toContain('Could not load your account.');
    await advance(10_000);
    expect(api.getOnboardingState).not.toHaveBeenCalled();
    await w.get('[data-testid="setup-retry-account"]').trigger('click');
    await flushPromises();
    expect(api.getOnboardingState).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it.each(['state', 'complete', 'projects'] as const)('ignores a %s response that arrives after unmount', async (which) => {
    let release: () => void = () => undefined;
    function deferred<T>(value: T): Promise<T> {
      return new Promise<T>((resolve) => { release = () => resolve(value); });
    }
    const ready = { ...waiting, project_id: 'p1', has_events: true };
    api.getOnboardingState.mockResolvedValue(ready);
    if (which === 'state') api.getOnboardingState.mockImplementationOnce(() => deferred(ready));
    if (which === 'complete') api.completeOnboarding.mockImplementationOnce(() => deferred({ onboarding_complete: true }));
    if (which === 'projects') api.listProjects.mockImplementationOnce(() => deferred([{ id: 'p1', name: 'web' }]));
    const w = mount(Setup);
    await flushPromises();
    w.unmount();
    release();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(localStorage.getItem('opslane_onboarding_complete')).toBeNull();
    expect(localStorage.getItem('opslane_project_id')).toBeNull();
    expect(localStorage.getItem('opslane_project_name')).toBeNull();
    expect(routerPush).not.toHaveBeenCalled();
    if (which === 'state') expect(api.completeOnboarding).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @opslane/dashboard exec vitest run src/views/__tests__/setup.test.ts`
Expected: FAIL with `Failed to resolve import "../Setup.vue"`.

- [ ] **Step 3: Implement `Setup.vue`**

Create `packages/dashboard/src/views/Setup.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { completeOnboarding, getMe, getOnboardingState, listProjects } from '../api';
import type { OnboardingState } from '../types/api';
import AgentPasteBox from '../components/AgentPasteBox.vue';
import { applyProjectSelection } from '../components/project-switcher';
import Button from '../components/ui/Button.vue';

type Phase = 'loading' | 'account_error' | 'member' | 'setup' | 'completing' | 'complete_error' | 'entering' | 'enter_error';

const POLL_MS = 3000;

const router = useRouter();
const phase = ref<Phase>('loading');
const state = ref<OnboardingState | null>(null);
const stateFailed = ref(false);
const completeError = ref('');

const member = ref(false);
let polling = false;
let timer: ReturnType<typeof setTimeout> | undefined;
// Bumped on unmount and on every user retry. An awaited call whose
// generation is stale must not write storage or navigate: App.vue keys the
// route component on the active project, so this page can remount mid-request.
let generation = 0;

const statusLine = computed(() => {
  if (stateFailed.value) return 'Could not check setup status. Retrying.';
  const current = state.value;
  if (!current?.project_id) return 'Waiting for your agent. It will give you a link to approve.';
  if (!current.has_events) return 'Project ready. Waiting for the first event from your app.';
  return 'First event received. Opening your dashboard…';
});

function stopPolling(): void {
  polling = false;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
}

function schedulePoll(): void {
  if (!polling) return;
  timer = setTimeout(() => { void poll(); }, POLL_MS);
}

async function loadAccount(): Promise<void> {
  stopPolling();
  const gen = ++generation;
  phase.value = 'loading';
  try {
    const me = await getMe();
    if (gen !== generation) return;
    member.value = me.active_role === 'member';
  } catch {
    // An expired session never reaches here: the API client refreshes or
    // redirects to /login first.
    if (gen !== generation) return;
    phase.value = 'account_error';
    return;
  }
  polling = true;
  await poll();
}

async function poll(): Promise<void> {
  timer = undefined;
  const gen = generation;
  let next: OnboardingState;
  try {
    next = await getOnboardingState();
  } catch {
    if (gen !== generation || !polling) return;
    stateFailed.value = true;
    if (phase.value === 'loading') phase.value = member.value ? 'member' : 'setup';
    schedulePoll();
    return;
  }
  if (gen !== generation || !polling) return;
  state.value = next;
  stateFailed.value = false;

  if (next.onboarding_complete && next.project_id) {
    await enter();
    return;
  }
  if (member.value) {
    phase.value = 'member';
    schedulePoll();
    return;
  }
  phase.value = 'setup';
  if (next.has_events && !next.onboarding_complete) {
    await complete();
    return;
  }
  // Includes an onboarded org with no project: sending it to / would loop,
  // because App.vue routes a project-less org back to /setup.
  schedulePoll();
}

async function complete(): Promise<void> {
  stopPolling();
  const gen = generation;
  phase.value = 'completing';
  try {
    await completeOnboarding();
  } catch (err: unknown) {
    if (gen !== generation) return;
    completeError.value = err instanceof Error ? err.message : '';
    phase.value = 'complete_error';
    return;
  }
  if (gen !== generation) return;
  await enter();
}

async function enter(): Promise<void> {
  stopPolling();
  const gen = generation;
  phase.value = 'entering';
  let selected: { id: string; name: string } | undefined;
  try {
    const projects = await listProjects();
    if (gen !== generation) return;
    selected = projects.find((project) => project.id === state.value?.project_id) ?? projects[0];
  } catch {
    if (gen !== generation) return;
  }
  if (!selected) {
    phase.value = 'enter_error';
    return;
  }
  applyProjectSelection(localStorage, { id: selected.id, name: selected.name });
  localStorage.setItem('opslane_onboarding_complete', '1');
  await router.push('/');
}

function retryAccount(): void {
  void loadAccount();
}

function retryComplete(): void {
  generation++;
  void complete();
}

function retryEnter(): void {
  generation++;
  void enter();
}

onMounted(() => {
  void loadAccount();
});

onUnmounted(() => {
  generation++;
  stopPolling();
});
</script>

<template>
  <div class="min-h-screen bg-background flex items-start justify-center px-6 py-12">
    <p v-if="phase === 'loading'" class="text-sm text-muted" role="status">Loading…</p>

    <div v-else-if="phase === 'account_error'" class="w-full max-w-lg space-y-3" role="alert">
      <p class="text-sm text-danger">Could not load your account.</p>
      <Button data-testid="setup-retry-account" variant="primary" @click="retryAccount">Try again</Button>
    </div>

    <div v-else-if="member" class="max-w-lg rounded-lg border border-border bg-surface p-8 text-center" data-testid="setup-member">
      <h1 class="text-2xl font-semibold text-text">Ask an organization admin to finish setup</h1>
      <p class="mt-3 text-sm text-muted">An admin sets up Opslane with a coding agent. This page opens your dashboard when they finish.</p>
      <div v-if="phase === 'enter_error'" class="mt-6 space-y-3" role="alert">
        <p class="text-sm text-danger">Could not load your projects.</p>
        <Button data-testid="setup-retry-enter" variant="primary" @click="retryEnter">Try again</Button>
      </div>
    </div>

    <div v-else class="w-full max-w-lg">
      <h1 class="text-2xl font-semibold text-text">Set up Opslane with your coding agent</h1>
      <AgentPasteBox class="mt-6" />

      <div v-if="phase === 'complete_error'" class="mt-6 space-y-3" role="alert">
        <p class="text-sm text-danger">Could not finish setup.</p>
        <p v-if="completeError" class="text-sm text-danger" v-text="completeError"></p>
        <Button data-testid="setup-retry-complete" variant="primary" @click="retryComplete">Try again</Button>
      </div>
      <div v-else-if="phase === 'enter_error'" class="mt-6 space-y-3" role="alert">
        <p class="text-sm text-danger">Could not load your projects.</p>
        <Button data-testid="setup-retry-enter" variant="primary" @click="retryEnter">Try again</Button>
      </div>
      <p v-else class="mt-6 flex items-center gap-3 text-sm text-muted" role="status" data-testid="setup-status">
        <span class="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent border-r-transparent" aria-hidden="true"></span>
        <span>{{ statusLine }}</span>
      </p>
    </div>
  </div>
</template>
```

- [ ] **Step 4: Switch the route and delete the wizard**

In `packages/dashboard/src/router.ts`:
- change `import SetupWizard from './views/SetupWizard.vue';` to `import Setup from './views/Setup.vue';`
- change `{ path: '/setup', name: 'setup', component: SetupWizard },` to `{ path: '/setup', name: 'setup', component: Setup },`
- in the guard comment, change `// The completion flag is a cache for the synchronous guard. SetupWizard` to `// The completion flag is a cache for the synchronous guard. Setup`, and change `// onboarded session back to /setup: the wizard's push('/') would then loop` to `// onboarded session back to /setup: the setup page's push('/') would then loop`.

Then: `git rm packages/dashboard/src/views/SetupWizard.vue packages/dashboard/src/views/__tests__/setup-wizard.test.ts`

- [ ] **Step 5: Simplify `AgentPasteBox` and delete wizard-only client code**

Replace `packages/dashboard/src/components/AgentPasteBox.vue` with:

```vue
<script setup lang="ts">
import CopyButton from './CopyButton.vue';

const line = 'Set up https://docs.opslane.com/INSTALL.md';
</script>

<template>
  <div class="rounded-lg border border-border bg-surface p-4 text-left" data-testid="agent-paste-box">
    <p class="text-sm font-medium text-text">Paste into your agent</p>
    <p class="mt-1 text-xs text-muted">Claude Code, Codex, Cursor, or any agent with a shell. It installs the SDK, proves the first event, and guides you through optional integrations.</p>
    <div class="mt-3 flex items-center gap-3 rounded bg-black px-4 py-3 font-mono text-sm text-white">
      <span class="text-muted">&gt;</span>
      <span class="flex-1 truncate" data-testid="agent-paste-line">{{ line }}</span>
      <CopyButton :text="line" />
    </div>
  </div>
</template>
```

Replace `packages/dashboard/src/components/__tests__/agent-paste-box.test.ts` with:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import AgentPasteBox from '../AgentPasteBox.vue';

describe('AgentPasteBox', () => {
  it('shows the one-line prompt with a copy button and no manual-setup link', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    const w = mount(AgentPasteBox);
    expect(w.text()).toContain('Paste into your agent');
    expect(w.find('[data-testid="agent-paste-line"]').text()).toBe('Set up https://docs.opslane.com/INSTALL.md');
    await w.find('button').trigger('click');
    expect(write).toHaveBeenCalledWith('Set up https://docs.opslane.com/INSTALL.md');
    expect(w.find('a').exists()).toBe(false);
    expect(w.text()).not.toMatch(/Setup guide|snippet/i);
  });
});
```

In `packages/dashboard/src/api.ts`, delete the `OnboardingSetupResponse` interface, the `EventStatus` interface, the `onboardingSetup` function, and the `getEventStatus` function. Keep `getOnboardingState` and `completeOnboarding`.

In `packages/dashboard/src/types/api.ts`, delete the line
`next_step: 'create_project' | 'install_sdk' | 'connect_github' | 'connect_slack' | 'done';` from `OnboardingState`.

In `packages/dashboard/src/components/__tests__/onboarding-banners.test.ts`, delete `  next_step: 'done',` from the `state` fixture.

In `packages/dashboard/src/views/SessionsList.test.ts:294`, change `expect(wrapper.text()).toContain('Setup guide');` to `expect(wrapper.text()).toContain('Paste into your agent');`.

In `packages/dashboard/src/views/__tests__/issues-list-filters.test.ts`:
- rename the test `'renders the unfiltered empty state with its Setup guide action'` to `'renders the unfiltered empty state with the agent setup prompt'` and change its `toContain('Setup guide')` to `toContain('Paste into your agent')`;
- in `'renders a filtered empty state and clears controls plus URL filters'` change `not.toContain('Setup guide')` to `not.toContain('Paste into your agent')`.

- [ ] **Step 6: Run the dashboard suite and build**

Run: `grep -rn "SetupWizard\|onboardingSetup\|getEventStatus\|EventStatus\|OnboardingSetupResponse\|next_step\|variant=\"wizard\"" packages/dashboard/src` and `grep -rn "Setup guide" packages/dashboard/src --include=*.vue --include=*.ts --exclude=*.test.ts`
Expected: no output from either. (The paste-box test deliberately asserts that `Setup guide` is absent, so tests are excluded from the second search.)

Run: `pnpm --filter @opslane/dashboard test && pnpm --filter @opslane/dashboard build`
Expected: all test files pass (including `setup.test.ts`, `router.test.ts`, `agent-paste-box.test.ts`, `onboarding-banners.test.ts`, `SessionsList.test.ts`, `issues-list-filters.test.ts`); `vue-tsc` reports no errors; `vite build` succeeds.

- [ ] **Step 7: Commit**

```bash
git add -A packages/dashboard/src
git commit -m "feat(dashboard)!: replace the setup wizard with the agent setup prompt

/setup now shows one screen: the Set up INSTALL.md prompt and a status
line polled from onboarding state. It completes onboarding itself when
the org's first event arrives, then selects a project and opens the
dashboard, so a user no longer waits for the agent's last runbook step.
Members wait on an ask-an-admin screen and enter once setup is done."
```

---

### Task 4: Approve page completes onboarding from the session event

**Files:**
- Modify: `packages/dashboard/src/views/AgentApprove.vue:50` (imports) and `openDestination` (`:148-176`)
- Modify: `packages/dashboard/src/views/__tests__/agent-approve.test.ts`

**Interfaces:**
- Consumes: `completeOnboarding()` from `src/api.ts`; existing `info.value?.facts?.has_events`, `mounted`, `navigationMessage`, `pendingDestination`.
- Produces: no new exports.

- [ ] **Step 1: Update the tests first**

In `agent-approve.test.ts`, add `completeOnboarding: vi.fn(),` to the hoisted `api` mock object.

In `it.each(['approve', 'revisit'])('opens project B dashboard after %s while project A was selected'`, add after `expect(api.getMe).toHaveBeenCalledTimes(1);`:

```ts
    expect(api.completeOnboarding).not.toHaveBeenCalled();
```

Replace the whole test `'preserves the error destination while setup is pending, then rechecks before opening it'` with these three tests:

```ts
  it('completes onboarding from the session event and keeps the destination when completion fails', async () => {
    api.getAgentApproveInfo.mockResolvedValue(pending({ status: 'app_reporting', project_id: 'p-b', facts: {
      ...emptyFacts, has_events: true, latest_error_group_url: 'http://x/issues/g-b',
    } }));
    api.getMe.mockResolvedValue({ onboarding_complete: false });
    api.completeOnboarding.mockRejectedValueOnce(new Error('API 500')).mockResolvedValue({ onboarding_complete: true });
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    await w.get('[data-testid="agent-latest-issue"]').trigger('click');
    await flushPromises();
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
    expect(routerPush).not.toHaveBeenCalled();
    expect(localStorage.getItem('opslane_onboarding_complete')).toBeNull();
    expect(w.text()).toContain('API 500');
    await w.get('[data-testid="agent-navigation-retry"]').trigger('click');
    await flushPromises();
    expect(api.completeOnboarding).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('opslane_onboarding_complete')).toBe('1');
    expect(routerPush).toHaveBeenCalledWith('/issues/g-b?project_id=p-b');
    w.unmount();
  });

  it('keeps Open dashboard closed while the session has no event', async () => {
    api.getAgentApproveInfo.mockResolvedValue(pending({ status: 'app_reporting', project_id: 'p-b', facts: emptyFacts }));
    api.getMe.mockResolvedValue({ onboarding_complete: false });
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    await w.get('[data-testid="agent-dashboard"]').trigger('click');
    await flushPromises();
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(w.text()).toContain('Your agent is still finishing setup');
    w.unmount();
  });

  it('opens the dashboard for a not-yet-onboarded org once the session has an event', async () => {
    localStorage.setItem('opslane_project_id', 'p-a');
    api.getAgentApproveInfo.mockResolvedValue(pending({ status: 'app_reporting', project_id: 'p-b', project_name: 'B', facts: { ...emptyFacts, has_events: true } }));
    api.getMe.mockResolvedValue({ onboarding_complete: false });
    api.completeOnboarding.mockResolvedValue({ onboarding_complete: true });
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    await w.get('[data-testid="agent-dashboard"]').trigger('click');
    await flushPromises();
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('opslane_onboarding_complete')).toBe('1');
    expect(localStorage.getItem('opslane_project_id')).toBe('p-b');
    expect(routerPush).toHaveBeenCalledWith('/?project_id=p-b');
    w.unmount();
  });

  it('does not navigate when completion finishes after unmount', async () => {
    api.getAgentApproveInfo.mockResolvedValue(pending({ status: 'app_reporting', project_id: 'p-b', facts: { ...emptyFacts, has_events: true } }));
    api.getMe.mockResolvedValue({ onboarding_complete: false });
    let finish: () => void = () => undefined;
    api.completeOnboarding.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ onboarding_complete: true }); }));
    const w = mount(AgentApprove, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    await w.get('[data-testid="agent-dashboard"]').trigger('click');
    await flushPromises();
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
    w.unmount();
    finish();
    await flushPromises();
    expect(routerPush).not.toHaveBeenCalled();
    expect(localStorage.getItem('opslane_onboarding_complete')).toBeNull();
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm --filter @opslane/dashboard exec vitest run src/views/__tests__/agent-approve.test.ts`
Expected: `completes onboarding from the session event...`, `opens the dashboard for a not-yet-onboarded org once the session has an event` and `does not navigate when completion finishes after unmount` FAIL (`completeOnboarding` is never called); the others pass.

- [ ] **Step 3: Implement**

In `AgentApprove.vue`, change the import to:

```ts
import { approveAgentSession, completeOnboarding, denyAgentSession, getAgentApproveInfo, getMe } from '../api';
```

In `openDestination`, replace:

```ts
    if (!me.onboarding_complete) {
      localStorage.removeItem('opslane_onboarding_complete');
      navigationMessage.value = 'Your agent is still finishing setup. Stay here, then check again to open this page.';
      return;
    }
```

with:

```ts
    if (!me.onboarding_complete) {
      localStorage.removeItem('opslane_onboarding_complete');
      if (!info.value?.facts?.has_events) {
        navigationMessage.value = 'Your agent is still finishing setup. Stay here, then check again to open this page.';
        return;
      }
      // The first event is onboarding's only gate. Waiting for the agent's
      // last runbook step would keep the user out of a ready dashboard.
      await completeOnboarding();
      if (!mounted) return;
    }
```

The existing `catch` already shows a thrown message in `navigationMessage`, which renders **Check again** with the saved destination.

- [ ] **Step 4: Run the tests and build**

Run: `pnpm --filter @opslane/dashboard exec vitest run src/views/__tests__/agent-approve.test.ts && pnpm --filter @opslane/dashboard build`
Expected: all AgentApprove and deriveChecklist tests pass; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/views/AgentApprove.vue packages/dashboard/src/views/__tests__/agent-approve.test.ts
git commit -m "feat(dashboard): open the dashboard from the approve page once the first event lands

The approve page refused to navigate until the agent finished every
optional runbook step. Once the session has an event it now completes
onboarding itself, so a user who closed the /setup tab gets in too."
```

---

### Task 5: E2E mock harness, request manifest, and browser smoke

**Files:**
- Modify: `test-e2e/dashboard-mock-harness.ts:111-114,138-139`
- Modify: `docs/design/dashboard-v1/request-manifest.json` (entries at `:232-245` and `:429-435`)
- Modify: `test-e2e/dashboard-design-system.test.ts:82`
- Modify: `test-e2e/dashboard-screenshots.test.ts:60`

**Interfaces:**
- Consumes: Task 3's page heading `Set up Opslane with your coding agent` and its requests (`GET /api/v1/auth/me`, `GET /api/v1/onboarding/state` every 3000 ms).
- Produces: nothing new.

- [ ] **Step 1: Point the smoke at the new page (failing first)**

In `test-e2e/dashboard-design-system.test.ts`, change `{ path: '/setup', identity: /Connect GitHub/i },` to `{ path: '/setup', identity: /Set up Opslane with your coding agent/i },`.

In `test-e2e/dashboard-screenshots.test.ts`, change `{ path: '/setup', fixture: 'setup-github-mock', identity: /Connect GitHub/i, harness: 'success' },` to `{ path: '/setup', fixture: 'setup-waiting-mock', identity: /Set up Opslane with your coding agent/i, harness: 'success' },`.

Run: `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/test-e2e exec vitest run dashboard-design-system.test.ts -t "/setup"`
Expected: FAIL or flaky. The mocked state (`has_events: true`, not complete) makes the page complete onboarding and navigate away from `/setup`; the heading may still be caught before navigation, so a pass here proves nothing. Continue to Step 2 either way. If the suite reports the smoke as skipped, Chromium is unavailable here: install it with `pnpm --filter @opslane/test-e2e exec playwright install chromium` and rerun.

- [ ] **Step 2: Make the mock a waiting org and update the manifest**

In `test-e2e/dashboard-mock-harness.ts`, replace the comment above the `/api/v1/auth/me` mock with:

```ts
    // onboarding_complete stays false so the /setup smoke renders the setup
    // page instead of bouncing to the dashboard; the seeded localStorage flag
    // keeps the router guard open for every other route.
```

and replace the onboarding state mock body with:

```ts
    return { onboarding_complete: false, project_id: null, has_events: false, github_connected: false, github_mode: 'app', slack_connected: false };
```

In `docs/design/dashboard-v1/request-manifest.json`, delete the two entries whose `source` is `api.ts:onboardingSetup` and `api.ts:getEventStatus` (keep valid JSON: remove the trailing comma of the preceding entry if needed), and in the `api.ts:getOnboardingState` entry change `"pollIntervalMs": null` to `"pollIntervalMs": 3000`. Validate with `node -e "JSON.parse(require('fs').readFileSync('docs/design/dashboard-v1/request-manifest.json','utf8'))"`.

- [ ] **Step 3: Run the e2e dashboard suites**

Run: `pnpm --filter @opslane/test-e2e exec vitest run dashboard-design-system.test.ts`
Expected: all pass, and `/setup has one main landmark and no page-level overflow` ran rather than being skipped. (`dashboard-projects.test.ts` and `dashboard-environment-filter.test.ts` only plant the completion flag; their browser tests are `it.skip` until Slice 4, so they are not evidence for this change.)

Run: `CAPTURE_DASHBOARD_SCREENSHOTS=1 pnpm --filter @opslane/test-e2e exec vitest run dashboard-screenshots.test.ts`
Expected: all captures pass including `captures setup-waiting-mock at 390x844`. The PNGs, `manifest.json`, and `index.html` it writes under `docs/design/dashboard-v1/screenshots/after/` are not tracked; do not commit them (`git status` must not list that directory as staged).

- [ ] **Step 4: Commit**

```bash
git add test-e2e/dashboard-mock-harness.ts test-e2e/dashboard-design-system.test.ts \
  test-e2e/dashboard-screenshots.test.ts docs/design/dashboard-v1/request-manifest.json
git commit -m "test(e2e): smoke the agent setup page instead of the wizard's GitHub step"
```

---

### Task 6: Docs and backlog references

**Files:**
- Modify: `docs/install.md:28`
- Modify: `docs/guides/api-keys.md:26`
- Modify: `docs/guides/github-app.md:26,34,77`
- Modify: `docs/guides/slack-notifications.md:7,30`
- Modify: `docs/reference/http-routes.md:87-89`
- Modify: `TODOS.md:108,111`
- Modify: `docs/superpowers/specs/2026-09-15-agent-only-onboarding-design.md` (one caller correction)

**Interfaces:** none.

- [ ] **Step 1: Edit the docs**

`docs/install.md`: delete the paragraph
`The onboarding wizard puts this key directly in its setup snippet so you can send a test event immediately. The key ships in your bundle; move it to an environment variable before committing.`
and the blank line after it. Then change the preceding paragraph to end with one extra sentence, so it reads:
`Before you start, you need an ingest key for your project. The SDK accepts only keys beginning with `opslane_pk_`. See [API keys](guides/api-keys.md). The key ships in your bundle, so keep it in an environment variable rather than in committed code.`

`docs/guides/api-keys.md:26`: replace
`The onboarding wizard can create another ingest key when you resume on a different browser.`
with
`Agent setup mints one for the project you approve.`

`docs/guides/github-app.md:26`: replace
`During onboarding, enter the repository as `owner/repo`; Opslane verifies that `GITHUB_TOKEN` can reach it before saving the project setting.`
with
`Ask your coding agent to attach the repository as `owner/repo`; Opslane verifies that `GITHUB_TOKEN` can reach it before saving the project setting.`

`docs/guides/github-app.md:34`: replace the sentence pair
`The onboarding wizard presents the App install link, waits for the installation, and then opens the repo picker. If a GitHub organization admin must approve the installation, choose **Do this later** and finish onboarding; the dashboard keeps a GitHub reminder visible until the installation and repository connection are complete.`
with
`Agent setup gives you the App install link and attaches the repository once the App can see it. If a GitHub organization admin must approve the installation, tell the agent to do it later; the dashboard keeps a GitHub reminder visible until the installation and repository connection are complete.`

`docs/guides/github-app.md:77`: replace
`In PAT mode, enter `owner/repo` in the onboarding wizard or call the project GitHub endpoint.`
with
`In PAT mode, let agent setup attach the repository or call the project GitHub endpoint.`

`docs/guides/slack-notifications.md`: delete the frontmatter line `  - packages/dashboard/src/views/SetupWizard.vue`, and replace the paragraph at line 30 with:
`Agent setup can connect a daily digest the same way: it sends a test message and enables the digest only when Slack accepts it. If you skip that step, the dashboard keeps a Slack reminder visible until an enabled daily-digest destination exists.`

`docs/reference/http-routes.md`: delete the row for `POST | /api/v1/onboarding/setup`; change the state row description to `Read server-derived onboarding facts: completion, the newest project, whether any project has an event, and GitHub and Slack connection`; change the complete row description to `Mark onboarding complete after any project in the org receives its first event; GitHub and Slack are optional (admin on cloud)`.

`TODOS.md`: in the `safeUrl` item, change `guarding four render sites` to `guarding three render sites`, and change ``, `IncidentConclusion.vue:20`, and `SetupWizard.vue:361` all bind`` to `` and `IncidentConclusion.vue:20` all bind``. If the item's heading or other lines say "four", change them to "three".

Spec correction: in `docs/superpowers/specs/2026-09-15-agent-only-onboarding-design.md`, change ``CodeBlock` (Settings, IncidentDetail)`` to ``CodeBlock` (IncidentDetail)``.

- [ ] **Step 2: Check for leftovers and run the docs gates**

Run: `grep -rn -i "onboarding wizard\|setup wizard\|SetupWizard\|onboarding/setup\|Do this later\|During onboarding" docs README.md TODOS.md --include=*.md | grep -v "^docs/plans/\|^docs/design/\|^docs/research/\|^docs/superpowers/"`
Expected: no output.

Run: `pnpm test:repo`
Expected: exits 0. If `check-docs-voice.mjs` or `check-docs-drift.mjs` rejects a sentence, reword that sentence only and rerun. Do not add `Setup.vue` to any doc's `covers:` list unless `check-docs-drift` requires it.

- [ ] **Step 3: Commit**

```bash
git add docs/install.md docs/guides/api-keys.md docs/guides/github-app.md docs/guides/slack-notifications.md \
  docs/reference/http-routes.md TODOS.md docs/superpowers/specs/2026-09-15-agent-only-onboarding-design.md
git commit -m "docs: describe agent setup instead of the retired onboarding wizard"
```

---

### Task 7: Full gates and live smoke

Proves AC13 and AC14. No code changes unless a gate fails; fix the cause in the owning task's files and commit with a message naming the failure.

**Files:** none (scratch files go in the session scratchpad, not the repo).

**Interfaces:** consumes everything above.

- [ ] **Step 1: Go gate with zero skips**

With the environment block exported and `psql` on `PATH`:

```bash
(cd packages/ingestion && go build ./... && go test -count=1 -timeout=20m -json ./handler ./db) > "$SCRATCH/go-test.jsonl"; echo "exit=$?"
python3 - "$SCRATCH/go-test.jsonl" <<'PY'
import json, sys
skips = [e for e in map(json.loads, open(sys.argv[1])) if e.get("Action") == "skip" and e.get("Test")]
for e in skips: print("SKIP", e["Package"], e["Test"])
print("skips:", len(skips))
PY
```

Expected: `exit=0` and `skips: 0`. (`$SCRATCH` comes from the environment block. `go test ./db` can take over 10 minutes; the `-timeout=20m` flag covers the test binary; give the shell call an outer timeout of at least 25 minutes and run it in the foreground. Do not run the worker test suite concurrently against the same database.)

- [ ] **Step 2: Dashboard, e2e, and repo gates**

```bash
pnpm --filter @opslane/dashboard build
pnpm --filter @opslane/dashboard test
pnpm --filter @opslane/test-e2e exec vitest run dashboard-design-system.test.ts
CAPTURE_DASHBOARD_SCREENSHOTS=1 pnpm --filter @opslane/test-e2e exec vitest run dashboard-screenshots.test.ts
pnpm test:repo
```

Expected: every command exits 0 with no skipped `/setup` smoke.

- [ ] **Step 3: Live smoke on a local stack (AC14)**

Stay in the repository root. Record evidence while the flow runs: the `/setup` states are transient.

1. Start the stack with the exported ports and wait for health: `docker compose -p agentonly up -d --build --wait ingestion`, then `curl -sf "$INGESTION_URL/health"`.
2. Seed a fresh org and admin, and mint a session cookie (the local GitHub auth provider has no sign-up):

```bash
EMAIL="agentonly-$(date +%s)@example.test"
read ORG_ID USER_ID < <(psql "$DATABASE_URL" -tA -F' ' -c "
WITH o AS (INSERT INTO orgs (name) VALUES ('agent-only smoke') RETURNING id),
     u AS (INSERT INTO users (org_id, email, name, github_id, github_username, avatar_url)
           SELECT id, '$EMAIL', 'Smoke Admin', $(date +%s%N | cut -c1-15), 'smoke-admin', '' FROM o RETURNING id, org_id)
SELECT org_id, id FROM u;" | head -1)
psql "$DATABASE_URL" -c "INSERT INTO memberships (user_id, org_id, role) VALUES ('$USER_ID', '$ORG_ID', 'admin')"
ACCESS=$(ORG_ID=$ORG_ID USER_ID=$USER_ID EMAIL=$EMAIL python3 - <<'PY'
import base64, hashlib, hmac, json, os, time
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
now = int(time.time())
head = b64(b'{"alg":"HS256","typ":"JWT"}')
body = b64(json.dumps({"sub": os.environ["USER_ID"], "org_id": os.environ["ORG_ID"], "email": os.environ["EMAIL"], "iat": now, "exp": now + 3600}).encode())
sig = b64(hmac.new(b"opslane-dev-jwt-secret-key-minimum-32-bytes-long", f"{head}.{body}".encode(), hashlib.sha256).digest())
print(f"{head}.{body}.{sig}")
PY
)
echo "org=$ORG_ID user=$USER_ID"
```

   If the `users` insert fails on a column, read `CreateUserGitHub` in `packages/ingestion/db/queries.go` and match its column list.
3. Serve a runbook copy pointed at this stack. The hosted runbook tells the agent that the SDK's default endpoint is right, which is false for a local stack, so replace that sentence before replacing the origin:

```bash
python3 - "$INGESTION_URL" "$SCRATCH/runbook/INSTALL.md" <<'PY'
import sys
origin, out = sys.argv[1], sys.argv[2]
text = open("docs-site/public/INSTALL.md").read()
old = "The SDK already defaults to `https://app.opslane.com`, so no `endpoint` is needed outside the Next.js tunnel."
assert old in text, "runbook endpoint sentence changed; update this smoke step"
text = text.replace(old, f"This is a local test stack: pass `endpoint: '{origin}'` to `init`.")
open(out, "w").write(text.replace("https://app.opslane.com", origin))
PY
RUNBOOK_PORT=$(python3 -c "import socket; s = socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1]); s.close()")
python3 -m http.server "$RUNBOOK_PORT" --directory "$SCRATCH/runbook" > "$SCRATCH/runbook.log" 2>&1 &
RUNBOOK_PID=$!
for _ in $(seq 1 20); do curl -sf "http://localhost:$RUNBOOK_PORT/INSTALL.md" > /dev/null && break; sleep 0.5; done
curl -sf "http://localhost:$RUNBOOK_PORT/INSTALL.md" | grep -c "$INGESTION_URL"
```

   Expected: a non-zero count.
4. Scaffold a throwaway Vue app outside the repository (the `test-fixtures/vue-app` fixture depends on `workspace:*` and cannot install outside the workspace). The agent installs the published `@opslane/sdk` into it:

```bash
(cd "$SCRATCH" && npm create vite@latest smoke-app -- --template vue && cd smoke-app && npm install \
  && git init -q && git add -A && git -c user.email=smoke@example.test -c user.name=smoke commit -qm init)
```

   If `create-vite` asks whether to install and start the app, answer no.
5. Browser tab 1 (the `browse` skill or Playwright MCP): add cookie `__opslane_at=$ACCESS` for `localhost`, open `$INGESTION_URL/auth/complete`, then `$INGESTION_URL/setup`. Screenshot `$SCRATCH/setup-waiting.png` and confirm the heading, the prompt line and `Waiting for your agent` (AC1).
6. Start the agent in the background. Give it a browser tool so it can click its own test button; without one the runbook stops to ask a human:

```bash
(cd "$SCRATCH/smoke-app" && claude -p "Set up http://localhost:$RUNBOOK_PORT/INSTALL.md" \
  --mcp-config '{"mcpServers":{"playwright":{"command":"npx","args":["-y","@playwright/mcp@latest","--headless"]}}}' \
  --allowedTools "Bash,Read,Write,Edit,mcp__playwright" \
  --output-format stream-json --verbose > "$SCRATCH/agent.jsonl" 2>&1 &)
```

7. `claude -p` only prints its result at the end, so read this run's session id from the file the runbook writes. Poll every 5 s until `$SCRATCH/smoke-app/.opslane-setup/register.json` exists, then print only the id: `python3 -c "import json, sys; print(json.load(open(sys.argv[1]))['poll_id'])" "$SCRATCH/smoke-app/.opslane-setup/register.json"`. Never print the whole file; it holds the poll token. In browser tab 2 open `$INGESTION_URL/agent/approve/<poll_id>`, keep **Create a new project**, and click **Approve**.
8. On tab 1, without reloading: within 6 s the status reads `Project ready. Waiting for the first event from your app.` Screenshot `$SCRATCH/setup-project-ready.png` (AC3).
9. Wait for the test error. Watch `$SCRATCH/agent.jsonl` for the agent's Playwright click; if the agent instead asks a human to click, open the dev-server URL it printed in tab 3 and click **Test Opslane**. Poll `psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM error_events e JOIN projects p ON p.id = e.project_id WHERE p.org_id = '$ORG_ID'"`. Within 6 s of it turning non-zero, tab 1 is on `/` showing the issues list. Record tab 1's URL, `localStorage.opslane_onboarding_complete` (must be `1`) and `localStorage.opslane_project_id` (must be a project of `$ORG_ID`: check with `SELECT org_id FROM projects WHERE id = '<value>'`), and screenshot `$SCRATCH/dashboard.png` (AC4, AC14). Confirm `SELECT onboarded_at FROM orgs WHERE id = '$ORG_ID'` is not null.
10. Let the agent finish; in `-p` mode it treats optional steps as later. Its final message in `agent.jsonl` should list `first_event: done`. Then stop the runbook server (`kill "$RUNBOOK_PID"`) and tear down with `docker compose -p agentonly down`.

- [ ] **Step 4: Follow-up issues (ask first)**

Ask the user before filing. On approval, from the repository root:

```bash
gh issue create --title "Self-hosted /setup points at the hosted INSTALL.md" \
  --body "Agent-only onboarding (docs/superpowers/specs/2026-09-15-agent-only-onboarding-design.md) shows \`Set up https://docs.opslane.com/INSTALL.md\` on every instance. That runbook targets https://app.opslane.com, so a self-hosted /setup registers against the hosted service. Proposed fix: ingestion serves /INSTALL.md from the same source with its own origin substituted and an endpoint line when it is not the hosted origin; the prompt uses window.location.origin."
gh issue create --title "No way to get an ingest key without a coding agent" \
  --body "After agent-only onboarding, /setup has no manual path, Settings is behind the onboarding guard, and Settings' key form offers only MCP and source-map scopes. Someone without a coding agent cannot onboard from the app."
```

---

## Review log

**Codex round 1 (medium reasoning, plan split into three parts): 5 P1, 6 P2, all accepted.**
- Compose startup raced migrations; now `up -d --wait postgres minio`, then a one-shot `minio-setup`.
- Go verification pipelines hid failures behind `grep`; commands now run unfiltered in `(cd packages/ingestion && …)` subshells, and Task 1 Step 9 includes the db test.
- Task 2 Step 2 predicted 201 for the retired route; the org is onboarded by then, so the old handler answers 409.
- Task 3's leftover search matched the paste-box test's own negative assertion; tests are excluded from the `Setup guide` search.
- The first-event status line was never asserted; the completion test now holds completion pending and checks it.
- Task 4 lacked a successful **Open dashboard** case for a not-yet-onboarded org; added.
- `dashboard-projects` and `dashboard-environment-filter` browser tests are `it.skip`; removed from the gates.
- Live smoke: the fixture app depends on `workspace:*` and hardcodes `localhost:8082`, the runbook's "no endpoint needed" sentence is wrong locally, `$SCRATCH/runbook` was never created, `-p` hides the approve link until the end, and nothing clicked the test button. Rewritten: scaffolded Vite app, runbook sentence replaced, approve link read from `agent_sessions`, Playwright MCP for the agent, evidence captured during the flow.

**Codex round 2 (medium reasoning, three parts): all round-1 fixes confirmed; 2 P1, 3 P2, all accepted.**
- The Go gate lacked `-timeout=20m`, so the db suite would hit Go's 10-minute default.
- `docs/guides/github-app.md:26` still told PAT users to enter the repository "during onboarding"; added to Task 6 and to the leftover search.
- Members hitting a project-list failure saw the admin prompt; the member screen now owns its retry, with a test.
- The runbook server check raced startup on a fixed port; it now takes a free port, waits for it, and kills its own pid.
- The approve step picked the newest pending session globally; it now reads this run's `poll_id` from `.opslane-setup/register.json`.
