# Agent-Driven Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Revision 4 (after Codex review rounds 1 and 2 and the post-review grill: decisions 14-18 in the spec).

**Goal:** A user pastes `Set up https://docs.opslane.com/INSTALL.md` into their coding agent; the agent installs the SDK, proves the first event, and connects GitHub, Slack, source maps, and MCP, stopping only for the approve click and the optional integrations.

**Architecture:** The agent talks to unauthenticated-start endpoints on the ingestion service (register, poll, session-scoped state and actions) using a poll token as its only credential. The human approves on a dashboard page behind normal sign-in, which creates or attaches the project and seals the keys to the session. Server facts (first event, GitHub, Slack, source maps) drive both the agent's `next` hints and a live progress panel; agent reports fill the steps the server cannot see.

**Tech Stack:** Go 1.24 + chi + pgx (ingestion), Vue 3 + Vite + Vitest (dashboard), TypeScript SDK built with Vite lib mode plus a Node post-build command (`packages/sdk`), Astro Starlight (`docs-site`).

**Spec:** `docs/research/2026-09-11-agent-driven-onboarding.md` (sections 3, 5, 6 are normative; section 5 is the decision table).

## Execution status (2026-09-12)

Tasks 1–13 are complete. Implementation is committed and independently reviewed; both agent runs, production source-map resolution, issue-page display, package verification, and isolated-stack cleanup passed. See [release smoke results](../../research/2026-09-11-agent-driven-onboarding.md#7-release-smoke) for measured results, test skips, and the external release checklist.

Implementation follows the contracts below with these verified adjustments: serialized polling tests replace the contradictory overlapping-poll example; session links include their project; source-map generation is conditional on the CI key; the CLI also removes unmatched JavaScript/CSS maps after complete success; SDK package resolution uses ESM; and source frames are read from the existing resolution envelope. Live smoke ports differ because the spike stack occupies the example ports.

## Global Constraints

- One release: onboarding, Vite source maps, and the Next.js post-build source-map command ship together (spec §5 #8).
- The agent's only credential during setup is the poll token `opt_…`; it authenticates `GET /api/v1/agent/poll/{id}` and every `/api/v1/agent/poll/{id}/…` route (spec §5 #4). Session TTL is 2 hours; every agent-facing route rejects an expired session before returning any fact or key.
- Long-poll: `?wait=N` caps at 30 seconds, server checks once per second, and the loop re-reads the session so a denial or expiry during the wait returns immediately (spec §5 #5).
- Keys minted on approve: ingest (`opslane_pk_`, label `agent setup`), api (`opslane_ak_`, label `agent-setup`), sourcemaps (`opslane_sk_`, label `agent-setup`). All three are listed and revocable in Settings.
- Secret hygiene: agent-facing JSON responses carry `Cache-Control: no-store`; the runbook never prints a key or the poll token and never passes one as a command argument; the source-map key reaches CI only through a consent-gated `gh secret set` / `vercel env add` read from stdin, or a freshly minted key from Settings (spec §5 #9).
- The old GitHub-App-as-identity path (`AgentAuthCallback`, `ProvisionAgentSession`, `agentReasonForErr`, the `FindRecentInstallationLandedByRepo` diagnosis, the `state=UUID` branch of `OAuthLoginCallback`) is deleted, not kept dormant (spec §5 #10). `containsInstallation`, `toInstallationRepos`, and `pickVerifiedEmail` stay because `github_oauth.go:344,373,641,652` still use them. The legacy `POST /api/v1/onboard/provision` bridge (the deleted CLI's second entry point) is deleted with it (spec §5 #16): handler, DB provisioning, tests, route, and the route-matrix entry. The poll endpoint decodes only the JSON key bundle.
- Runbook lives at `docs-site/public/INSTALL.md`, mirrored at `docs-site/public/SKILL.md`; hosted origin `https://app.opslane.com` is hardcoded (spec §5 #11). The landing page (opslane.com) is a separate repository; Task 12 hands it a snippet and the release checklist tracks it.
- Go tests: `db` tests are `package db_test` (`db.New(pool)`, `q.Pool()`), `handler` tests are `package handler_test`; both skip without `DATABASE_URL`, so export it before trusting a green run and count skips with `go test -json`. Every fixture uses a unique email and a unique `X-Forwarded-For` so global unique constraints and the process-wide rate limiters do not couple tests.
- Dashboard: `// @vitest-environment jsdom` first line in view tests; `unknown` plus narrowing, never `any`.
- Commit after every task with the trailer `Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv`.
- Migrations 074 and 075 are the next free numbers; both must be idempotent and are verified on a clean database and on the shared test database.

---

## File structure

**Ingestion (`packages/ingestion`)**
- `db/migrations/074_agent_session_approve.sql` (create): `project_name`, `git_remote`, 2-hour TTL default.
- `db/migrations/075_agent_session_steps.sql` (create): agent-reported progress table.
- `db/agent_steps.go` (create): `UpsertAgentStep`, `ListAgentSteps`, `AgentStepNames`; `db/sourcemaps.go` (modify): `HasSourcemapUploads`.
- `db/agent_provision.go` (rewrite): delete `ProvisionAgentSession` and its inputs/errors; add `ApproveAgentSession`, `DenyAgentSession`, `AgentKeyBundle`, `ErrAgentProjectNotInOrg`.
- `db/queries.go:4317-4390` (modify): `AgentSession` gains `ProjectName`, `GitRemote`.
- `db/project_keys.go` (modify): `CreateSourcemapKey`; list and revoke include `sourcemaps`.
- `handler/agent_setup.go` (modify): register, redirect, poll; delete callback-only code.
- `handler/agent_approve.go` (create): `AgentApproveInfo`, `AgentApprove`, `AgentDeny`, `loadApproveSession`.
- `handler/agent_facts.go` (create): `agentFacts`, `agentSessionFacts`, `mergeFacts`, `agentNextHint`, `parseWait`.
- `handler/agent_session_routes.go` (create): `AgentSessionAuth` middleware and the `state`, `github`, `slack`, `progress`, `complete` handlers.
- `handler/github_settings.go:46-130` (modify): extract `attachGitHubRepo`.
- `handler/notifications.go` (modify): extract `createTestEnableSlack`.
- `handler/api_keys.go` (modify): `sourcemaps` scope, `opslane_sk_` presentation.
- `handler/routes.go:68-74` (modify); `handler/github_oauth.go:131-147` (modify).
- Tests: `db/agent_session_v2_test.go` (extend), `db/agent_steps_test.go` (create), `db/agent_provision_test.go` (rewrite), `handler/agent_setup_test.go` (rewrite), `handler/agent_approve_test.go` (create), `handler/agent_poll_test.go` (create), `handler/agent_facts_test.go` (create), `handler/agent_session_routes_test.go` (create), `handler/api_keys_test.go` (extend), `handler/route_matrix_test.go` (modify), delete `handler/agent_callback_integration_test.go`.

**Dashboard (`packages/dashboard`)**
- `src/views/AgentApprove.vue` (rewrite), `src/components/AgentPasteBox.vue` (create).
- `src/views/SetupWizard.vue:466`, `src/views/IssuesList.vue:264-273`, `src/views/SessionsList.vue:343`, `src/views/Settings.vue:1041-1108` (modify).
- `src/api.ts`, `src/types/api.ts` (modify). `src/router.ts:21,46-48` and `src/route-project.ts:1` already carry the route from the spike.
- Delete `public/INSTALL.md` (spike artifact).
- Tests: `src/views/__tests__/agent-approve.test.ts`, `src/components/__tests__/agent-paste-box.test.ts` (create), `src/views/Settings.test.ts` (extend).

**SDK (`packages/sdk`)**
- `src/config.ts:84-101` (modify); `src/build/stamp.ts` (create, lifted from `vite-plugin/index.ts`); `vite-plugin/index.ts` (modify to import it); `sourcemaps-cli/index.ts`, `sourcemaps-cli/main.ts`, `bin/opslane-sourcemaps.mjs` (create); `package.json`, `vite.config.ts`, `tsconfig.json`, `scripts/check-package.mjs` (modify).
- Tests: `src/__tests__/config.test.ts` (extend), `src/__tests__/stamp.test.ts`, `sourcemaps-cli/__tests__/cli.test.ts` (create).

**Docs**
- `docs-site/public/INSTALL.md`, `docs-site/public/SKILL.md` (create); `docs/install.md`, `docs/guides/source-maps.md`, `docs/guides/mcp.md`, `docs/reference/http-routes.md`, `README.md` (modify).

---

## Milestone A: server session model

### Task 1: Migrations, session columns, steps store, source-map fact

**Files:**
- Create: `packages/ingestion/db/migrations/074_agent_session_approve.sql`, `packages/ingestion/db/migrations/075_agent_session_steps.sql`, `packages/ingestion/db/agent_steps.go`
- Modify: `packages/ingestion/db/queries.go:4317-4390`, `packages/ingestion/db/sourcemaps.go` (append)
- Test: `packages/ingestion/db/agent_session_v2_test.go` (append), `packages/ingestion/db/agent_steps_test.go` (create)

**Interfaces:**
- Produces: `AgentSession.ProjectName *string`, `AgentSession.GitRemote *string`; `CreateAgentSessionParams{RepoURL string; AgentName, ProjectName, GitRemote *string; PollTokenHash, AgentKeyPub string}`.
- Produces:

```go
type AgentStep struct{ SessionID, Step, Status, Note string; UpdatedAt time.Time }
var AgentStepNames = []string{"install_sdk", "first_event", "github", "slack", "sourcemaps", "mcp"}
func (q *Queries) UpsertAgentStep(ctx context.Context, sessionID, step, status, note string) error
func (q *Queries) ListAgentSteps(ctx context.Context, sessionID string) ([]AgentStep, error)
func (q *Queries) HasSourcemapUploads(ctx context.Context, projectID string) (bool, error)
```

- [x] **Step 1: Write the failing tests**

Append to `packages/ingestion/db/agent_session_v2_test.go` (package `db_test`; add imports `time`, `github.com/opslane/opslane/packages/ingestion/auth`, `github.com/opslane/opslane/packages/ingestion/db` if missing):

```go
func TestCreateAgentSession_ApproveFieldsAndTTL(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	_, hash, pub, err := auth.NewAgentPollToken()
	if err != nil {
		t.Fatal(err)
	}
	name := "acme-dashboard"
	remote := "acme/dashboard"
	s, err := q.CreateAgentSession(ctx, db.CreateAgentSessionParams{
		ProjectName: &name, GitRemote: &remote, PollTokenHash: hash, AgentKeyPub: pub,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, s.ID) })
	if s.ProjectName == nil || *s.ProjectName != name || s.GitRemote == nil || *s.GitRemote != remote {
		t.Fatalf("approve fields not stored: %+v", s)
	}
	if ttl := time.Until(s.ExpiresAt); ttl < 115*time.Minute || ttl > 125*time.Minute {
		t.Fatalf("expected ~2h TTL, got %s", ttl)
	}
	got, err := q.GetAgentSession(ctx, s.ID)
	if err != nil || got == nil || got.ProjectName == nil || *got.ProjectName != name || got.GitRemote == nil {
		t.Fatalf("GetAgentSession did not round-trip: %v %+v", err, got)
	}
}
```

Create `packages/ingestion/db/agent_steps_test.go`:

```go
package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

// newPendingSession creates a pending session with the given project name and
// returns it with the raw poll token. Shared by the approve and steps tests.
func newPendingSession(t *testing.T, q *db.Queries, name string) (*db.AgentSession, string) {
	t.Helper()
	raw, hash, pub, err := auth.NewAgentPollToken()
	if err != nil {
		t.Fatal(err)
	}
	s, err := q.CreateAgentSession(context.Background(), db.CreateAgentSessionParams{
		ProjectName: &name, PollTokenHash: hash, AgentKeyPub: pub,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { q.Pool().Exec(context.Background(), `DELETE FROM agent_sessions WHERE id = $1`, s.ID) })
	return s, raw
}

func TestAgentSteps_UpsertListAndEnum(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	s, _ := newPendingSession(t, q, "steps")
	if err := q.UpsertAgentStep(ctx, s.ID, "install_sdk", "running", ""); err != nil {
		t.Fatal(err)
	}
	if err := q.UpsertAgentStep(ctx, s.ID, "install_sdk", "done", "vite + vue"); err != nil {
		t.Fatal(err)
	}
	if err := q.UpsertAgentStep(ctx, s.ID, "mcp", "skipped", "headless"); err != nil {
		t.Fatal(err)
	}
	steps, err := q.ListAgentSteps(ctx, s.ID)
	if err != nil || len(steps) != 2 {
		t.Fatalf("list: %v %+v", err, steps)
	}
	if steps[0].Step != "install_sdk" || steps[0].Status != "done" || steps[0].Note != "vite + vue" || steps[1].Step != "mcp" {
		t.Fatalf("upsert/order wrong: %+v", steps)
	}
	if err := q.UpsertAgentStep(ctx, s.ID, "bogus", "done", ""); err == nil {
		t.Fatal("expected CHECK violation for unknown step")
	}
	if err := q.UpsertAgentStep(ctx, s.ID, "mcp", "bogus", ""); err == nil {
		t.Fatal("expected CHECK violation for unknown status")
	}
}

func TestHasSourcemapUploads(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('sm-fact') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1, 'sm-fact') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `DELETE FROM sourcemap_files WHERE project_id = $1`, projectID)
		pool.Exec(ctx, `DELETE FROM projects WHERE id = $1`, projectID)
		pool.Exec(ctx, `DELETE FROM orgs WHERE id = $1`, orgID)
	})
	if ok, err := q.HasSourcemapUploads(ctx, projectID); err != nil || ok {
		t.Fatalf("fresh project: %v %v", ok, err)
	}
	_, _, err := q.UpsertSourceMapFile(ctx, db.SourceMapFile{
		ProjectID: projectID, DebugID: "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f",
		ContentSHA256:     "0000000000000000000000000000000000000000000000000000000000000000",
		HasSourcesContent: true, SizeBytes: 12, ObjectKey: "sourcemaps/test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := q.HasSourcemapUploads(ctx, projectID); err != nil || !ok {
		t.Fatalf("after upload: %v %v", ok, err)
	}
}
```

`UpsertSourceMapFile` and `SourceMapFile` are in `db/sourcemaps.go:15-45`.

- [x] **Step 2: Run to verify they fail**

Run: `cd packages/ingestion && go test ./db -run 'TestCreateAgentSession_ApproveFieldsAndTTL|TestAgentSteps|TestHasSourcemapUploads' 2>&1 | head -5`
Expected: compile errors (`GitRemote`, `UpsertAgentStep`, `HasSourcemapUploads` undefined).

- [x] **Step 3: Write the migrations**

`packages/ingestion/db/migrations/074_agent_session_approve.sql`:

```sql
-- Agent-driven onboarding: sessions start without a repo, carry the agent's
-- proposed project name and git remote for the approve page, and live long
-- enough for a slow sign-up (2h, was 15m).
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS project_name TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS git_remote TEXT;
ALTER TABLE agent_sessions ALTER COLUMN expires_at SET DEFAULT now() + interval '2 hours';
```

`packages/ingestion/db/migrations/075_agent_session_steps.sql`:

```sql
-- Agent-reported progress for the live approve-page checklist. Server facts
-- (first event, GitHub, Slack, source maps) decide completion; this table
-- only holds what the agent says, including failure notes for those steps.
CREATE TABLE IF NOT EXISTS agent_session_steps (
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  step       TEXT NOT NULL CHECK (step IN ('install_sdk','first_event','github','slack','sourcemaps','mcp')),
  status     TEXT NOT NULL CHECK (status IN ('pending','running','done','skipped','failed')),
  note       TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, step)
);
```

- [x] **Step 4: Thread the columns and add the queries**

In `packages/ingestion/db/queries.go`: add `ProjectName *string` and `GitRemote *string` to `AgentSession` (after `ExpiresAt`) and to `CreateAgentSessionParams`. Change `CreateAgentSession` to insert `(repo_url, agent_name, poll_token_hash, agent_key_pub, project_name, git_remote) VALUES ($1..$6)`, add `project_name, git_remote` to the end of its `RETURNING` list, pass `p.ProjectName, p.GitRemote`, and scan into `&s.ProjectName, &s.GitRemote`. Add the same two columns to the end of the `SELECT` and `Scan` in `GetAgentSession`.

Create `packages/ingestion/db/agent_steps.go`:

```go
package db

import (
	"context"
	"fmt"
	"time"
)

// AgentStep is one agent-reported row of the approve-page checklist.
type AgentStep struct {
	SessionID string
	Step      string
	Status    string
	Note      string
	UpdatedAt time.Time
}

// AgentStepNames is the fixed checklist in display order. Migration 075's
// CHECK constraint is the source of truth; keep them equal.
var AgentStepNames = []string{"install_sdk", "first_event", "github", "slack", "sourcemaps", "mcp"}

func (q *Queries) UpsertAgentStep(ctx context.Context, sessionID, step, status, note string) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO agent_session_steps (session_id, step, status, note, updated_at)
		 VALUES ($1, $2, $3, $4, now())
		 ON CONFLICT (session_id, step) DO UPDATE
		 SET status = EXCLUDED.status, note = EXCLUDED.note, updated_at = now()`,
		sessionID, step, status, note)
	if err != nil {
		return fmt.Errorf("upsert agent step: %w", err)
	}
	return nil
}

func (q *Queries) ListAgentSteps(ctx context.Context, sessionID string) ([]AgentStep, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT session_id, step, status, note, updated_at
		 FROM agent_session_steps WHERE session_id = $1
		 ORDER BY array_position($2::text[], step)`,
		sessionID, AgentStepNames)
	if err != nil {
		return nil, fmt.Errorf("list agent steps: %w", err)
	}
	defer rows.Close()
	var out []AgentStep
	for rows.Next() {
		var s AgentStep
		if err := rows.Scan(&s.SessionID, &s.Step, &s.Status, &s.Note, &s.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
```

Append to `packages/ingestion/db/sourcemaps.go`:

```go
// HasSourcemapUploads reports whether any source map has been stored for the
// project. It backs the onboarding "sourcemaps" fact.
func (q *Queries) HasSourcemapUploads(ctx context.Context, projectID string) (bool, error) {
	var ok bool
	err := q.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sourcemap_files WHERE project_id = $1)`, projectID).Scan(&ok)
	return ok, err
}
```

- [x] **Step 5: Verify the migrations on a clean database and the shared one, then run the tests**

```bash
cd packages/ingestion && set -euo pipefail
PGPORT_LOCAL="${OPSLANE_POSTGRES_HOST_PORT:-5434}"
MIGDB="opslane_mig_check_$$_$(date +%s)"          # unique name: never touches an existing database
createdb -h localhost -p "$PGPORT_LOCAL" -U opslane "$MIGDB"
trap 'dropdb -h localhost -p "$PGPORT_LOCAL" -U opslane "$MIGDB"' EXIT   # registered only after creation succeeded
CLEAN="postgres://opslane:opslane_dev@localhost:$PGPORT_LOCAL/$MIGDB?sslmode=disable"
for f in db/migrations/*.sql; do psql "$CLEAN" -v ON_ERROR_STOP=1 -q -f "$f"; done   # clean apply, in order
for f in db/migrations/074_agent_session_approve.sql db/migrations/075_agent_session_steps.sql; do psql "$CLEAN" -v ON_ERROR_STOP=1 -q -f "$f"; done   # reapply
for f in db/migrations/074_agent_session_approve.sql db/migrations/075_agent_session_steps.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"; done   # representative DB
go test ./db -run 'TestCreateAgentSession|TestAgentSession|TestAgentSteps|TestHasSourcemapUploads' -v
```

If the migration runner applies files by a different mechanism than plain `psql` (check `db/migrate.go` or the `migrate` Compose service), use that mechanism for the clean-database pass. Expected: all applies succeed, reapply is a no-op, tests PASS.

- [x] **Step 6: Commit**

```bash
git add packages/ingestion/db
git commit -m "feat(db): agent sessions carry project name, git remote, steps table, 2h TTL

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

### Task 2: `ApproveAgentSession` and delete `ProvisionAgentSession`

**Files:**
- Rewrite: `packages/ingestion/db/agent_provision.go`
- Rewrite: `packages/ingestion/db/agent_provision_test.go`

**Interfaces:**
- Consumes: `CreateProjectTx(ctx, tx, orgID, name string, githubRepo *string) (*Project, error)` (`db/queries.go:4184`), `EnsureProjectDefaultEnvironmentTx` (`db/environments.go:29`), `CreateProjectKeyTx(ctx, tx, projectID, scope, label string, createdByUserID *string, endpoint string)` (`db/project_keys.go:240`), `MarkAgentSessionFailed(ctx, sessionID, reason) (bool, error)` (`db/queries.go:4440`), `ScopeIngest`, `ScopeAPI`, `ScopeSourcemaps`.
- Produces:

```go
var ErrAgentProjectNotInOrg = errors.New("project does not belong to the approving org")
type AgentKeyBundle struct {
	IngestKey    string `json:"ingest_key"`
	APIKey       string `json:"api_key"`
	SourcemapKey string `json:"sourcemap_key"`
}
type AgentApproveInput struct {
	SessionID, OrgID, UserID string
	ProjectName       string   // used when ExistingProjectID is nil
	ExistingProjectID *string  // attach instead of create
	SourcemapEndpoint string   // canonical origin sealed into the sk key
	SealKeys          func(bundleJSON string) (string, error)
}
func (q *Queries) ApproveAgentSession(ctx context.Context, in AgentApproveInput) (*Project, error)
func (q *Queries) DenyAgentSession(ctx context.Context, sessionID string) error
```

- [x] **Step 1: Write the failing tests**

Replace `packages/ingestion/db/agent_provision_test.go` with:

```go
package db_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

// approveTenant seeds an org with one user and cleans up in dependency order.
// Sessions are cleaned by newPendingSession (agent_steps_test.go).
func approveTenant(t *testing.T, q *db.Queries) (orgID, userID string) {
	t.Helper()
	ctx := context.Background()
	pool := q.Pool()
	email := fmt.Sprintf("approve-%d@test.local", time.Now().UnixNano())
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('approve-test') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO users (org_id, email, name) VALUES ($1, $2, 'Approver') RETURNING id`, orgID, email).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, stmt := range []string{
			`DELETE FROM project_api_keys WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`UPDATE projects SET default_environment_id = NULL WHERE org_id = $1`,
			`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM projects WHERE org_id = $1`,
			`DELETE FROM users WHERE org_id = $1`,
			`DELETE FROM orgs WHERE id = $1`,
		} {
			if _, err := pool.Exec(ctx, stmt, orgID); err != nil {
				t.Errorf("cleanup %q: %v", stmt, err)
			}
		}
	})
	return orgID, userID
}

func approveInput(s *db.AgentSession, orgID, userID string) db.AgentApproveInput {
	pub := *s.AgentKeyPub
	return db.AgentApproveInput{
		SessionID: s.ID, OrgID: orgID, UserID: userID, ProjectName: "approve-new",
		SourcemapEndpoint: "https://app.opslane.com",
		SealKeys: func(b string) (string, error) { return auth.SealAgentKey(pub, s.ID, b) },
	}
}

func createProject(t *testing.T, q *db.Queries, orgID, name string) *db.Project {
	t.Helper()
	ctx := context.Background()
	tx, err := q.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	p, err := q.CreateProjectTx(ctx, tx, orgID, name, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestApproveAgentSession_CreatesProjectAndThreeKeys(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, userID := approveTenant(t, q)
	s, raw := newPendingSession(t, q, "approve-new")

	project, err := q.ApproveAgentSession(ctx, approveInput(s, orgID, userID))
	if err != nil {
		t.Fatal(err)
	}
	if project.OrgID != orgID || project.Name != "approve-new" {
		t.Fatalf("unexpected project %+v", project)
	}
	got, _ := q.GetAgentSession(ctx, s.ID)
	if got.Status != "provisioned" || got.ProjectID == nil || *got.ProjectID != project.ID || got.OrgID == nil || *got.OrgID != orgID {
		t.Fatalf("session not provisioned: %+v", got)
	}
	opened, err := auth.OpenAgentKey(raw, s.ID, *got.APIKeySealed)
	if err != nil {
		t.Fatal(err)
	}
	var bundle db.AgentKeyBundle
	if err := json.Unmarshal([]byte(opened), &bundle); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(bundle.IngestKey, "opslane_pk_") || !strings.HasPrefix(bundle.APIKey, "opslane_ak_") || !strings.HasPrefix(bundle.SourcemapKey, "opslane_sk_") {
		t.Fatalf("bundle prefixes wrong: %+v", bundle)
	}
	var labels []string
	rows, err := q.Pool().Query(ctx, `SELECT scope || ':' || label FROM project_api_keys WHERE project_id = $1 ORDER BY scope`, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var l string
		if err := rows.Scan(&l); err != nil {
			t.Fatal(err)
		}
		labels = append(labels, l)
	}
	rows.Close()
	if want := "api:agent-setup,ingest:agent setup,sourcemaps:agent-setup"; strings.Join(labels, ",") != want {
		t.Fatalf("labels %v, want %s", labels, want)
	}
}

func TestApproveAgentSession_AttachesToExistingProject(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, userID := approveTenant(t, q)
	existing := createProject(t, q, orgID, "approve-existing")
	s, _ := newPendingSession(t, q, "ignored")
	in := approveInput(s, orgID, userID)
	in.ExistingProjectID = &existing.ID
	project, err := q.ApproveAgentSession(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	if project.ID != existing.ID {
		t.Fatalf("expected attach to %s, got %s", existing.ID, project.ID)
	}
	var n int
	q.Pool().QueryRow(ctx, `SELECT count(*) FROM projects WHERE org_id = $1`, orgID).Scan(&n)
	if n != 1 {
		t.Fatalf("expected no new project, have %d", n)
	}
	got, _ := q.GetAgentSession(ctx, s.ID)
	if got.ProjectName == nil || *got.ProjectName != "approve-existing" {
		t.Fatalf("session project_name should follow the attached project: %+v", got.ProjectName)
	}
}

func TestApproveAgentSession_ExistingProjectMustBelongToOrg(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, userID := approveTenant(t, q)
	otherOrg, _ := approveTenant(t, q)
	foreign := createProject(t, q, otherOrg, "foreign")
	s, _ := newPendingSession(t, q, "x")
	in := approveInput(s, orgID, userID)
	in.ExistingProjectID = &foreign.ID
	if _, err := q.ApproveAgentSession(ctx, in); !errors.Is(err, db.ErrAgentProjectNotInOrg) {
		t.Fatalf("expected ErrAgentProjectNotInOrg, got %v", err)
	}
	got, _ := q.GetAgentSession(ctx, s.ID)
	if got.Status != "pending" {
		t.Fatalf("rejected approve must leave the session pending: %s", got.Status)
	}
}

func TestApproveAgentSession_ConcurrentOneWinner(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, userID := approveTenant(t, q)
	s, _ := newPendingSession(t, q, "approve-race")
	var wg sync.WaitGroup
	results := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := q.ApproveAgentSession(ctx, approveInput(s, orgID, userID))
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	ok, notPending := 0, 0
	for err := range results {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, db.ErrAgentSessionNotPending):
			notPending++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if ok != 1 || notPending != 3 {
		t.Fatalf("want 1 winner and 3 not-pending, got %d/%d", ok, notPending)
	}
	var n int
	q.Pool().QueryRow(ctx, `SELECT count(*) FROM projects WHERE org_id = $1`, orgID).Scan(&n)
	if n != 1 {
		t.Fatalf("race created %d projects", n)
	}
}

func TestApproveAgentSession_ExpiredIsNotPending(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, userID := approveTenant(t, q)
	s, _ := newPendingSession(t, q, "approve-expired")
	q.Pool().Exec(ctx, `UPDATE agent_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, s.ID)
	if _, err := q.ApproveAgentSession(ctx, approveInput(s, orgID, userID)); !errors.Is(err, db.ErrAgentSessionNotPending) {
		t.Fatalf("expected not-pending for expired, got %v", err)
	}
}

func TestDenyAgentSession(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	s, _ := newPendingSession(t, q, "approve-deny")
	if err := q.DenyAgentSession(ctx, s.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := q.GetAgentSession(ctx, s.ID)
	if got.Status != "failed" || got.FailureReason == nil || *got.FailureReason != "authorization_denied" {
		t.Fatalf("deny did not mark failed: %+v", got)
	}
	if err := q.DenyAgentSession(ctx, s.ID); !errors.Is(err, db.ErrAgentSessionNotPending) {
		t.Fatalf("second deny should be not-pending, got %v", err)
	}
}
```

- [x] **Step 2: Run to verify they fail**

Run: `cd packages/ingestion && go test ./db -run 'TestApproveAgentSession|TestDenyAgentSession' 2>&1 | head -5`
Expected: compile failure, `db.AgentApproveInput` undefined.

- [x] **Step 3: Rewrite `agent_provision.go`**

Delete `AgentProvisionInput`, `AgentProvisionResult`, `InstallationRepo` helpers used only by it, `ProvisionAgentSession`, and the errors `ErrAgentIdentityUnverified`, `ErrAgentOrgExistsNeedsInvite`, `ErrAgentRepoAlreadyConfigured`. Keep `ErrAgentSessionNotPending`. The file becomes:

```go
package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

var (
	ErrAgentSessionNotPending = errors.New("agent session is not pending")
	ErrAgentProjectNotInOrg   = errors.New("project does not belong to the approving org")
)

// AgentKeyBundle is what the approve page seals to the session and the poll
// endpoint opens for the agent.
type AgentKeyBundle struct {
	IngestKey    string `json:"ingest_key"`
	APIKey       string `json:"api_key"`
	SourcemapKey string `json:"sourcemap_key"`
}

type AgentApproveInput struct {
	SessionID         string
	OrgID             string
	UserID            string
	ProjectName       string
	ExistingProjectID *string
	SourcemapEndpoint string
	SealKeys          func(bundleJSON string) (string, error)
}

// ApproveAgentSession completes a pending session from the dashboard approve
// page. It creates a project or attaches to one the org owns, mints the three
// keys, seals them to the session, and moves it to provisioned. The row lock
// plus the status guard on UPDATE give concurrent approvals exactly one winner.
func (q *Queries) ApproveAgentSession(ctx context.Context, in AgentApproveInput) (*Project, error) {
	if in.SealKeys == nil {
		return nil, fmt.Errorf("approve: no seal function")
	}
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin approve: %w", err)
	}
	defer tx.Rollback(ctx)

	var status string
	var expiresAt time.Time
	if err := tx.QueryRow(ctx,
		`SELECT status, expires_at FROM agent_sessions WHERE id = $1 FOR UPDATE`,
		in.SessionID).Scan(&status, &expiresAt); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrAgentSessionNotPending
		}
		return nil, fmt.Errorf("lock agent session: %w", err)
	}
	if status != "pending" || time.Now().After(expiresAt) {
		return nil, ErrAgentSessionNotPending
	}

	var project *Project
	if in.ExistingProjectID != nil {
		var p Project
		err := tx.QueryRow(ctx,
			`SELECT id, org_id, name, github_repo, default_environment_id FROM projects WHERE id = $1 AND org_id = $2`,
			*in.ExistingProjectID, in.OrgID).Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultEnvironmentID)
		if err == pgx.ErrNoRows {
			return nil, ErrAgentProjectNotInOrg
		}
		if err != nil {
			return nil, fmt.Errorf("load existing project: %w", err)
		}
		project = &p
	} else {
		project, err = q.CreateProjectTx(ctx, tx, in.OrgID, in.ProjectName, nil)
		if err != nil {
			return nil, err
		}
		production, err := q.EnsureProjectDefaultEnvironmentTx(ctx, tx, project.ID)
		if err != nil {
			return nil, err
		}
		project.DefaultEnvironmentID = &production.ID
	}

	userID := in.UserID
	ingest, err := q.CreateProjectKeyTx(ctx, tx, project.ID, ScopeIngest, "agent setup", &userID, "")
	if err != nil {
		return nil, err
	}
	api, err := q.CreateProjectKeyTx(ctx, tx, project.ID, ScopeAPI, "agent-setup", &userID, "")
	if err != nil {
		return nil, err
	}
	sk, err := q.CreateProjectKeyTx(ctx, tx, project.ID, ScopeSourcemaps, "agent-setup", &userID, in.SourcemapEndpoint)
	if err != nil {
		return nil, err
	}
	bundle, err := json.Marshal(AgentKeyBundle{IngestKey: ingest.Raw, APIKey: api.Raw, SourcemapKey: sk.Raw})
	if err != nil {
		return nil, fmt.Errorf("encode key bundle: %w", err)
	}
	sealed, err := in.SealKeys(string(bundle))
	if err != nil {
		return nil, fmt.Errorf("seal key bundle: %w", err)
	}
	tag, err := tx.Exec(ctx,
		`UPDATE agent_sessions
		 SET status = 'provisioned', org_id = $2, project_id = $3, api_key_sealed = $4,
		     project_name = $5, provisioned_by_user_id = $6
		 WHERE id = $1 AND status = 'pending'`,
		in.SessionID, in.OrgID, project.ID, sealed, project.Name, in.UserID)
	if err != nil {
		return nil, fmt.Errorf("approve agent session: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return nil, ErrAgentSessionNotPending
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit approve: %w", err)
	}
	return project, nil
}

// DenyAgentSession marks a pending session failed with the terminal reason
// the poll endpoint phrases for the agent.
func (q *Queries) DenyAgentSession(ctx context.Context, sessionID string) error {
	ok, err := q.MarkAgentSessionFailed(ctx, sessionID, "authorization_denied")
	if err != nil {
		return err
	}
	if !ok {
		return ErrAgentSessionNotPending
	}
	return nil
}
```

Match the `Project` struct's field names (`GithubRepo`, `DefaultEnvironmentID`) against `db/queries.go` and the `SELECT` column list to whatever `CreateProjectTx` scans. `provisioned_by_user_id` exists since migration 026.

- [x] **Step 4: Run the tests**

Run: `cd packages/ingestion && go build ./db && go test ./db -run 'TestApproveAgentSession|TestDenyAgentSession|TestAgentSession|TestAgentSteps' -v`
Expected: PASS. `go build ./...` fails in `handler` until Task 3 removes the callback; build only `./db` here.

- [x] **Step 5: Commit**

```bash
git add packages/ingestion/db/agent_provision.go packages/ingestion/db/agent_provision_test.go
git commit -m "feat(db): approve-page provisioning replaces GitHub-callback provisioning

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

### Task 3: Register, redirect, approve, and a bundle-aware poll; delete the GitHub callback

**Files:**
- Modify: `packages/ingestion/handler/agent_setup.go`
- Create: `packages/ingestion/handler/agent_approve.go`, `packages/ingestion/handler/agent_facts.go` (stub)
- Modify: `packages/ingestion/handler/github_oauth.go:131-147`, `packages/ingestion/handler/routes.go:68-74` and `:138` (remove the `/onboard/provision` route)
- Delete: `packages/ingestion/handler/onboard_provision.go`, `packages/ingestion/handler/onboard_provision_test.go`, `packages/ingestion/handler/onboard_provision_integration_test.go`, `packages/ingestion/db/onboard_provision.go`, `packages/ingestion/db/onboard_provision_test.go`; remove `onboardProvisionLimiter` and any `/onboard/provision` entry from `route_matrix_test.go` and the row at `docs/reference/http-routes.md:74`; `db/admin.go:57-121` counts sessions by status and keeps working unchanged
- Create: `packages/ingestion/handler/agent_test_helpers_test.go` (receives `handlerRoundTripperFunc` with its `RoundTrip` method, `callbackTestKey`, and `cleanupCallbackTenant` from the file below; `github_settings_test.go`, `github_oauth_test.go`, and `github_install_callback_test.go` still use them)
- Delete: `packages/ingestion/handler/agent_callback_integration_test.go` (after the move above); delete `TestAuthorizationDeniedAgentCallbackIsTerminal` and `TestAgentPollDiagnosesDivergentInstallWithoutMutation` from `packages/ingestion/handler/github_install_callback_test.go`; delete `TestOAuthLoginCallbackDispatchesAgentUUIDState` from `packages/ingestion/handler/github_oauth_test.go:138` (it asserts the dispatch this task removes and calls the deleted `createCallbackSession`) and replace it with `TestOAuthLoginCallbackRejectsBareUUIDState` below
- Test: `packages/ingestion/handler/agent_setup_test.go` (rewrite), `packages/ingestion/handler/agent_approve_test.go` (create)

**Interfaces:**
- Consumes: `db.ApproveAgentSession`, `db.DenyAgentSession`, `db.AgentKeyBundle`, `auth.SealAgentKey`, `auth.OpenAgentKey`, `OrgIDFromCtx`, `UserIDFromCtx`, `backendOrigin(r)` (`github_oauth.go:711`), `d.AuthCallbackOrigin`, `d.Queries.ListProjectsByOrg(ctx, orgID) ([]db.Project, error)` (`db/queries.go:3806`).
- Produces HTTP contracts:
  - `POST /api/v1/agent/setup` body `{project_name, agent_name, git_remote?, framework_hint?}` → 201 `{status:"auth_required", auth_url, poll_id, poll_token, expires_at, project_name, message}` with `Cache-Control: no-store`.
  - `GET /agent/auth/{id}` → 302 to `{publicOrigin}/agent/approve/{id}`; 410 plain text when expired; no GitHub App requirement.
  - `GET /api/v1/agent/approve/{id}` (cookie) → `{status, agent_name, project_name, git_remote, expires_at, projects:[{id,name,github_repo}], suggested_project_id}`; 403 when the session is bound to another org.
  - `POST /api/v1/agent/approve/{id}` (cookie, admin-if-cloud) body `{project_name?, existing_project_id?}` (empty body allowed; malformed JSON 400; non-UUID `existing_project_id` 400) → 200 `{status:"provisioned", project_id, project_name}`; 409 when not pending; 422 `{"error":"that project belongs to another organization","code":"project_not_in_org"}`.
  - `POST /api/v1/agent/approve/{id}/deny` (cookie, admin-if-cloud) → 200 `{status:"failed"}`; 409 when not pending.
  - `GET /api/v1/agent/poll/{id}` (header `X-Opslane-Poll-Token`): pending → `{status:"pending", approved:false, message}`; provisioned/key_ok/app_reporting → `{status, approved:true, project_id, project_name, org_id, dashboard_url, ingest_key, api_key, sourcemap_key}`; a sealed payload that is not a key bundle is a 500 (no legacy shapes remain once `/onboard/provision` is gone); failed → `{status:"failed", approved:false, failure_reason, message}`; expired, or any status past `expires_at` → 410 `{status:"expired", approved:false}`. Long-poll and facts are added in Task 4.
  - `func (d *Dependencies) publicOrigin(r *http.Request) string`.
  - `agentJSON` sets `Cache-Control: no-store`.

- [x] **Step 1: Write the failing tests**

Replace `packages/ingestion/handler/agent_setup_test.go` with:

```go
package handler_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

// Each fixture gets its own client IP so the process-wide agent limiters
// (5 registrations/min/IP) never couple tests.
var agentTestIP atomic.Int64

func nextAgentIP() string {
	n := agentTestIP.Add(1)
	return fmt.Sprintf("10.42.%d.%d", (n/250)%250, n%250+1)
}

func agentRequest(method, path, body, ip string) *http.Request {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", ip)
	return req
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("non-JSON body (%d): %s", rec.Code, rec.Body.String())
		}
	}
	return out
}

func TestAgentSetup_RequiresProjectName(t *testing.T) {
	deps, pool := testDeps(t)
	rec := httptest.NewRecorder()
	handler.NewRouterWithPool(deps, pool).ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"agent_name":"x"}`, nextAgentIP()))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "project_name is required") {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestAgentSetup_ContractAndRedirectWithoutGitHubApp(t *testing.T) {
	deps, pool := testDeps(t)
	deps.AuthCallbackOrigin = "https://app.example.test"
	deps.GitHubAppSlug = ""
	r := handler.NewRouterWithPool(deps, pool)
	ip := nextAgentIP()
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"project_name":"acme","agent_name":"Claude Code on box","git_remote":"acme/web"}`, ip))
	if rec.Code != http.StatusCreated {
		t.Fatalf("setup: %d %s", rec.Code, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control %q", cc)
	}
	body := decodeBody(t, rec)
	for _, k := range []string{"auth_url", "poll_id", "poll_token", "expires_at", "project_name", "message"} {
		if body[k] == nil {
			t.Fatalf("missing %s in %v", k, body)
		}
	}
	if body["status"] != "auth_required" {
		t.Fatalf("status %v", body["status"])
	}
	authURL, _ := body["auth_url"].(string)
	if !strings.HasPrefix(authURL, "https://app.example.test/agent/auth/") {
		t.Fatalf("auth_url %s", authURL)
	}
	rec2 := httptest.NewRecorder()
	r.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, strings.TrimPrefix(authURL, "https://app.example.test"), nil))
	if rec2.Code != http.StatusFound {
		t.Fatalf("redirect: %d %s", rec2.Code, rec2.Body.String())
	}
	if want := "https://app.example.test/agent/approve/" + body["poll_id"].(string); rec2.Header().Get("Location") != want {
		t.Fatalf("Location %s want %s", rec2.Header().Get("Location"), want)
	}
}

func TestAgentSetup_RejectsBadRemoteAndLongName(t *testing.T) {
	deps, pool := testDeps(t)
	r := handler.NewRouterWithPool(deps, pool)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"project_name":"a","git_remote":"not a remote"}`, nextAgentIP()))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("remote: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"project_name":"`+strings.Repeat("x", 101)+`"}`, nextAgentIP()))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("long: %d", rec.Code)
	}
}

func TestAgentSetup_RateLimitPerIP(t *testing.T) {
	deps, pool := testDeps(t)
	r := handler.NewRouterWithPool(deps, pool)
	ip := nextAgentIP()
	var last int
	for i := 0; i < 6; i++ {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"project_name":"rl"}`, ip))
		last = rec.Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("sixth registration from one IP should be 429, got %d", last)
	}
}

func TestAgentAuthCallbackRouteIsGone(t *testing.T) {
	deps, pool := testDeps(t)
	rec := httptest.NewRecorder()
	handler.NewRouterWithPool(deps, pool).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/agent/auth/callback?state=00000000-0000-0000-0000-000000000000", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 from the redirect handler for a non-UUID id, got %d", rec.Code)
	}
}

// TestOAuthLoginCallbackRejectsBareUUIDState replaces the deleted dispatch
// test: a real agent-session UUID in `state` now goes through ordinary OAuth
// state validation, fails it, and leaves the session untouched.
func TestOAuthLoginCallbackRejectsBareUUIDState(t *testing.T) {
	deps, pool := testDeps(t)
	r := handler.NewRouterWithPool(deps, pool)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"project_name":"state"}`, nextAgentIP()))
	body := decodeBody(t, rec)
	pollID, _ := body["poll_id"].(string)
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM agent_sessions WHERE id = $1`, pollID) })
	rec2 := httptest.NewRecorder()
	r.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/auth/callback?code=x&installation_id=1&state="+pollID, nil))
	if rec2.Code != http.StatusForbidden {
		t.Fatalf("bare UUID state must fail OAuth state validation, got %d %s", rec2.Code, rec2.Body.String())
	}
	var status string
	pool.QueryRow(context.Background(), `SELECT status FROM agent_sessions WHERE id = $1`, pollID).Scan(&status)
	if status != "pending" {
		t.Fatalf("session must be untouched, got %s", status)
	}
}

// Cloud mode: RequireRoleIfCloud only enforces roles under a cloud provider.
// cloudAuthStub is the WorkOS-mode stub notifications_test.go already uses.
func TestAgentApprove_CloudRequiresAdmin(t *testing.T) {
	a := newApproveRig(t)
	a.deps.AuthProvider = cloudAuthStub{}
	a.deps.Queries.Pool().Exec(context.Background(), `UPDATE memberships SET role = 'member' WHERE org_id = $1`, a.orgID)
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{}`, true); code != http.StatusForbidden {
		t.Fatalf("member approve in cloud must be 403, got %d", code)
	}
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID+"/deny", ``, true); code != http.StatusForbidden {
		t.Fatalf("member deny in cloud must be 403, got %d", code)
	}
	if code, info := a.do(t, http.MethodGet, "/api/v1/agent/approve/"+a.pollID, "", true); code != http.StatusOK || info["status"] != "pending" {
		t.Fatalf("rejected approve must leave the session pending: %d %v", code, info)
	}
	a.deps.Queries.Pool().Exec(context.Background(), `UPDATE memberships SET role = 'admin' WHERE org_id = $1`, a.orgID)
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{}`, true); code != http.StatusOK {
		t.Fatalf("admin approve in cloud must succeed, got %d", code)
	}
}
```

`agent_setup_test.go` needs `"context"` in its imports for these two tests. If `cloudAuthStub` lives in a file that is not compiled with these tests, move it into `agent_test_helpers_test.go`.

Create `packages/ingestion/handler/agent_approve_test.go`:

```go
package handler_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

type approveRig struct {
	deps    *handler.Dependencies
	r       http.Handler
	ip      string
	pollID  string
	token   string
	cookie  *http.Cookie
	orgID   string
	project string
	rawKey  string
}

// newApproveRig seeds a tenant (org, project, env, ingest key), an admin user
// with a unique email, registers one agent session, and returns everything a
// test needs to approve it and poll as the agent.
func newApproveRig(t *testing.T) approveRig {
	t.Helper()
	deps, pool := testDeps(t)
	ctx := context.Background()
	deps.AuthCallbackOrigin = "https://app.example.test"
	deps.JWTSecret = []byte(authTestJWTSecret)
	orgID, projectID, _, rawKey := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	// seedTenant attaches github_repo = "owner/repo"; a fresh onboarding project has none.
	if _, err := pool.Exec(ctx, `UPDATE projects SET github_repo = NULL WHERE id = $1`, projectID); err != nil {
		t.Fatal(err)
	}
	email := fmt.Sprintf("approver-%s@example.com", uuid.NewString())
	user, err := deps.Queries.CreateUserGitHub(ctx, orgID, email, "Approver", time.Now().UnixNano(), "approver", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := deps.Queries.CreateMembership(ctx, user.ID, orgID, "admin"); err != nil {
		t.Fatal(err)
	}
	tok, err := auth.SignAccessToken(deps.JWTSecret, user.ID, orgID, email)
	if err != nil {
		t.Fatal(err)
	}
	r := handler.NewRouterWithPool(deps, pool)
	ip := nextAgentIP()
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"project_name":"acme","agent_name":"Claude Code","git_remote":"acme/web"}`, ip))
	if rec.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	pollID, _ := body["poll_id"].(string)
	token, _ := body["poll_token"].(string)
	t.Cleanup(func() { pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, pollID) })
	return approveRig{deps: deps, r: r, ip: ip, pollID: pollID, token: token,
		cookie: &http.Cookie{Name: handler.AccessCookieName, Value: tok}, orgID: orgID, project: projectID, rawKey: rawKey}
}

func (a approveRig) do(t *testing.T, method, path, body string, cookie bool) (int, map[string]any) {
	t.Helper()
	req := agentRequest(method, path, body, a.ip)
	if cookie {
		req.AddCookie(a.cookie)
	}
	rec := httptest.NewRecorder()
	a.r.ServeHTTP(rec, req)
	return rec.Code, decodeBody(t, rec)
}

func (a approveRig) poll(t *testing.T, query string) (int, map[string]any) {
	t.Helper()
	req := agentRequest(http.MethodGet, "/api/v1/agent/poll/"+a.pollID+query, "", a.ip)
	req.Header.Set("X-Opslane-Poll-Token", a.token)
	rec := httptest.NewRecorder()
	a.r.ServeHTTP(rec, req)
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("poll Cache-Control %q", cc)
	}
	return rec.Code, decodeBody(t, rec)
}

func TestAgentApprove_InfoRequiresCookieAndListsProjects(t *testing.T) {
	a := newApproveRig(t)
	if code, _ := a.do(t, http.MethodGet, "/api/v1/agent/approve/"+a.pollID, "", false); code != http.StatusUnauthorized {
		t.Fatalf("no cookie: %d", code)
	}
	code, info := a.do(t, http.MethodGet, "/api/v1/agent/approve/"+a.pollID, "", true)
	if code != http.StatusOK || info["status"] != "pending" || info["project_name"] != "acme" || info["git_remote"] != "acme/web" {
		t.Fatalf("info: %d %v", code, info)
	}
	if projects, _ := info["projects"].([]any); len(projects) != 1 {
		t.Fatalf("expected the seeded project listed, got %v", info["projects"])
	}
}

func TestAgentApprove_CreateThenPollDeliversBundle(t *testing.T) {
	a := newApproveRig(t)
	code, out := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"project_name":"Acme Web"}`, true)
	if code != http.StatusOK || out["status"] != "provisioned" || out["project_name"] != "Acme Web" {
		t.Fatalf("approve: %d %v", code, out)
	}
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, ``, true); code != http.StatusConflict {
		t.Fatalf("second approve: %d", code)
	}
	code, poll := a.poll(t, "")
	if code != http.StatusOK || poll["approved"] != true || poll["status"] != "provisioned" {
		t.Fatalf("poll: %d %v", code, poll)
	}
	for _, k := range []string{"ingest_key", "api_key", "sourcemap_key", "project_id", "org_id", "dashboard_url"} {
		if poll[k] == nil {
			t.Fatalf("missing %s: %v", k, poll)
		}
	}
	if _, second := a.poll(t, ""); second["status"] != "key_ok" {
		t.Fatalf("second poll should report key_ok: %v", second)
	}
}

func TestAgentApprove_BodyValidation(t *testing.T) {
	a := newApproveRig(t)
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{not json`, true); code != http.StatusBadRequest {
		t.Fatalf("malformed: %d", code)
	}
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"nope"}`, true); code != http.StatusBadRequest {
		t.Fatalf("non-uuid: %d", code)
	}
	code, info := a.do(t, http.MethodGet, "/api/v1/agent/approve/"+a.pollID, "", true)
	if code != http.StatusOK || info["status"] != "pending" {
		t.Fatalf("session must still be pending after rejected bodies: %d %v", code, info)
	}
}

func TestAgentApprove_AttachExistingAndDeny(t *testing.T) {
	a := newApproveRig(t)
	code, out := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"`+a.project+`"}`, true)
	if code != http.StatusOK || out["project_id"] != a.project {
		t.Fatalf("attach: %d %v", code, out)
	}
	b := newApproveRig(t)
	if code, _ := b.do(t, http.MethodPost, "/api/v1/agent/approve/"+b.pollID+"/deny", ``, true); code != http.StatusOK {
		t.Fatalf("deny: %d", code)
	}
	if code, poll := b.poll(t, ""); code != http.StatusOK || poll["status"] != "failed" || poll["failure_reason"] != "authorization_denied" || poll["approved"] != false {
		t.Fatalf("poll after deny: %d %v", code, poll)
	}
	if code, _ := b.do(t, http.MethodPost, "/api/v1/agent/approve/"+b.pollID+"/deny", ``, true); code != http.StatusConflict {
		t.Fatalf("second deny: %d", code)
	}
}

func TestAgentApprove_ForeignProjectAndForeignOrgInfo(t *testing.T) {
	a := newApproveRig(t)
	b := newApproveRig(t)
	code, out := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"`+b.project+`"}`, true)
	if code != http.StatusUnprocessableEntity || out["code"] != "project_not_in_org" {
		t.Fatalf("foreign project: %d %v", code, out)
	}
	if code, _ := b.do(t, http.MethodPost, "/api/v1/agent/approve/"+b.pollID, `{}`, true); code != http.StatusOK {
		t.Fatalf("b approve: %d", code)
	}
	req := agentRequest(http.MethodGet, "/api/v1/agent/approve/"+b.pollID, "", a.ip)
	req.AddCookie(a.cookie)
	rec := httptest.NewRecorder()
	a.r.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("a reading b's bound session must be 403, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestAgentPoll_ExpiredAfterApprovalIsGone(t *testing.T) {
	a := newApproveRig(t)
	a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{}`, true)
	a.deps.Queries.Pool().Exec(context.Background(), `UPDATE agent_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, a.pollID)
	code, poll := a.poll(t, "")
	if code != http.StatusGone || poll["ingest_key"] != nil {
		t.Fatalf("expired provisioned session must be 410 with no keys: %d %v", code, poll)
	}
}
```

`authTestJWTSecret` is `handler/auth_middleware_test.go:26`; `cleanupTenantHandler` is `handler/auth_middleware_test.go:502`; `seedTenant` is `handler/error_event_test.go:51`; `CreateUserGitHub` is `db/queries.go:3112`; `CreateMembership` is `db/queries.go:3195`; `Queries.Pool()` is `db/queries.go:317`.

- [x] **Step 2: Run to verify they fail**

Run: `cd packages/ingestion && go test ./handler -run 'TestAgentSetup|TestAgentApprove|TestAgentPoll_Expired|TestAgentAuthCallbackRouteIsGone' 2>&1 | head -5`
Expected: compile failure (`ProvisionAgentSession` undefined in `agent_setup.go`).

- [x] **Step 3: Rewrite `agent_setup.go`**

Delete from the file: `AgentAuthCallback`, `agentReasonForErr` (`:545`), `agentResultPage` and its template (`:585`), and the `gh` import if no remaining use. Keep `pickVerifiedEmail` (`:558`) and `containsInstallation` (`:576`) because `github_oauth.go:344,641` call them; keep `repoURLPattern`, `agentSetupLimiter`, `agentPollLimiter`.

Change `agentJSON` to:

```go
func agentJSON(w http.ResponseWriter, code int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}
```

Replace `AgentSetup` from the request struct to the end of the function with:

```go
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req struct {
		ProjectName   string `json:"project_name"`
		AgentName     string `json:"agent_name"`
		GitRemote     string `json:"git_remote"`
		FrameworkHint string `json:"framework_hint"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.ProjectName = strings.TrimSpace(req.ProjectName)
	if req.ProjectName == "" {
		writeJSONError(w, http.StatusBadRequest, "project_name is required")
		return
	}
	if utf8.RuneCountInString(req.ProjectName) > 100 {
		writeJSONError(w, http.StatusBadRequest, "project_name must be 100 characters or less")
		return
	}
	if req.GitRemote != "" && !repoURLPattern.MatchString(req.GitRemote) {
		writeJSONError(w, http.StatusBadRequest, "git_remote must be in owner/repo format")
		return
	}
	if utf8.RuneCountInString(req.AgentName) > 100 {
		req.AgentName = string([]rune(req.AgentName)[:100])
	}

	pollToken, tokenHash, agentKeyPub, err := auth.NewAgentPollToken()
	if err != nil {
		slog.Error("agent setup: generate poll token", "error", err)
		agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error", "message": "internal error"})
		return
	}
	var agentName, gitRemote *string
	if req.AgentName != "" {
		agentName = &req.AgentName
	}
	if req.GitRemote != "" {
		gitRemote = &req.GitRemote
	}
	session, err := d.Queries.CreateAgentSession(r.Context(), db.CreateAgentSessionParams{
		RepoURL: req.GitRemote, AgentName: agentName, ProjectName: &req.ProjectName, GitRemote: gitRemote,
		PollTokenHash: tokenHash, AgentKeyPub: agentKeyPub,
	})
	if err != nil {
		slog.Error("agent setup: create session", "error", err)
		agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error", "message": "failed to create setup session"})
		return
	}
	authURL := d.publicOrigin(r) + "/agent/auth/" + session.ID
	agentJSON(w, http.StatusCreated, map[string]any{
		"status":       "auth_required",
		"auth_url":     authURL,
		"poll_id":      session.ID,
		"poll_token":   pollToken,
		"expires_at":   session.ExpiresAt.UTC().Format(time.RFC3339),
		"project_name": req.ProjectName,
		"message":      "Ask the user to open " + authURL + ", sign in or create an account, and click Approve. Then poll with ?wait=30 until approved is true; stop on failed or expired.",
	})
```

Add `"unicode/utf8"` to the imports. `RepoURL` keeps the `NOT NULL` column satisfied.

Rewrite `AgentAuthRedirect` entirely:

```go
// AgentAuthRedirect sends the human to the dashboard approve page. Sign-in
// happens there through the normal provider; the SPA parks this path and
// returns to it after login.
//
// GET /agent/auth/{sessionID}
func (d *Dependencies) AgentAuthRedirect(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	if _, err := uuid.Parse(sessionID); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid session ID")
		return
	}
	session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if session == nil {
		writeJSONError(w, http.StatusNotFound, "session not found")
		return
	}
	if time.Now().After(session.ExpiresAt) {
		http.Error(w, "This setup link has expired. Ask your agent to run setup again.", http.StatusGone)
		return
	}
	if err := d.Queries.MarkAgentSessionAuthClicked(r.Context(), sessionID); err != nil {
		slog.Warn("agent auth redirect: stamp click", "error", err)
	}
	http.Redirect(w, r, d.publicOrigin(r)+"/agent/approve/"+sessionID, http.StatusFound)
}

// publicOrigin is the origin humans use for links: the configured callback
// origin in production, the request's own origin in tests and dev.
func (d *Dependencies) publicOrigin(r *http.Request) string {
	if d.AuthCallbackOrigin != "" {
		return d.AuthCallbackOrigin
	}
	return backendOrigin(r)
}
```

Rewrite `AgentPoll` from the poll-token check to the end (Task 4 wraps this in the long-poll loop; keep the shape):

```go
	session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("agent poll: get session", "error", err)
		agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error", "message": "internal error"})
		return
	}
	if session == nil || session.PollTokenHash == nil ||
		!hmac.Equal([]byte(auth.HashToken(pollToken)), []byte(*session.PollTokenHash)) {
		agentJSON(w, http.StatusNotFound, map[string]any{"status": "not_found"})
		return
	}
	d.writeAgentPollResponse(w, r, session, pollToken)
}

// writeAgentPollResponse renders a session for the agent. Expiry is checked
// first for every status: nothing about an expired session is returned.
func (d *Dependencies) writeAgentPollResponse(w http.ResponseWriter, r *http.Request, session *db.AgentSession, pollToken string) {
	if session.Status == "expired" || time.Now().After(session.ExpiresAt) {
		agentJSON(w, http.StatusGone, map[string]any{"status": "expired", "approved": false, "message": "session expired; ask the user to run setup again"})
		return
	}
	switch session.Status {
	case "completed", "provisioned", "key_ok", "app_reporting":
		resp := map[string]any{
			"status":        session.Status,
			"approved":      true,
			"dashboard_url": d.publicOrigin(r),
		}
		if session.ProjectName != nil {
			resp["project_name"] = *session.ProjectName
		}
		if session.ProjectID != nil {
			resp["project_id"] = *session.ProjectID
		}
		if session.OrgID != nil {
			resp["org_id"] = *session.OrgID
		}
		if session.APIKeySealed == nil {
			resp["message"] = "key delivery window closed; ask the user to run setup again"
		} else {
			opened, openErr := auth.OpenAgentKey(pollToken, session.ID, *session.APIKeySealed)
			if openErr != nil {
				slog.Error("agent poll: open sealed key", "error", openErr, "session_id", session.ID)
				agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error", "message": "internal error"})
				return
			}
			var bundle db.AgentKeyBundle
			if err := json.Unmarshal([]byte(opened), &bundle); err != nil || bundle.IngestKey == "" {
				slog.Error("agent poll: sealed payload is not a key bundle", "session_id", session.ID)
				agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error", "message": "internal error"})
				return
			}
			resp["ingest_key"] = bundle.IngestKey
			resp["api_key"] = bundle.APIKey
			resp["sourcemap_key"] = bundle.SourcemapKey
			if err := d.Queries.MarkAgentKeyDelivered(r.Context(), session.ID); err != nil {
				slog.Warn("agent poll: mark delivered", "error", err)
			}
		}
		agentJSON(w, http.StatusOK, resp)
	case "failed":
		reason := ""
		if session.FailureReason != nil {
			reason = *session.FailureReason
		}
		agentJSON(w, http.StatusOK, map[string]any{
			"status": "failed", "approved": false, "failure_reason": reason, "message": agentFailureMessage(reason),
		})
	default:
		agentJSON(w, http.StatusOK, map[string]any{
			"status": "pending", "approved": false,
			"message": "Waiting for the user to approve in the browser. Poll again with ?wait=30.",
		})
	}
}

func agentFailureMessage(reason string) string {
	if reason == "authorization_denied" {
		return "The user declined this setup in Opslane. Stop here."
	}
	return "Setup failed. Ask the user to run setup again."
}
```

Delete the old `agentFailureMessage` with its GitHub cases and the `FindRecentInstallationLandedByRepo` diagnosis block. Delete the `/onboard/provision` bridge entirely: `handler/onboard_provision.go` (handler and `onboardProvisionLimiter`), `db/onboard_provision.go` (`ProvisionOnboardSession`, its input/result types), their three test files, the route at `routes.go:138`, and its row in `docs/reference/http-routes.md:74`. If `route_matrix_test.go` lists the route anywhere, remove that entry too.

In `github_oauth.go:131-147`, delete the block that parses `state` as a UUID and dispatches to `AgentAuthCallback`, and its comment.

- [x] **Step 4: Create the approve handlers and the facts stub**

`packages/ingestion/handler/agent_approve.go`:

```go
package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

type approveProjectJSON struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	GithubRepo *string `json:"github_repo"`
}

// loadApproveSession loads the session for a cookie-authenticated approve
// route and enforces org ownership once the session is bound to an org.
func (d *Dependencies) loadApproveSession(w http.ResponseWriter, r *http.Request) (*db.AgentSession, bool) {
	sessionID := chi.URLParam(r, "sessionID")
	if _, err := uuid.Parse(sessionID); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid session ID")
		return nil, false
	}
	session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("agent approve: get session", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return nil, false
	}
	if session == nil {
		writeJSONError(w, http.StatusNotFound, "session not found")
		return nil, false
	}
	if session.OrgID != nil && *session.OrgID != OrgIDFromCtx(r.Context()) {
		writeJSONError(w, http.StatusForbidden, "this setup belongs to another organization")
		return nil, false
	}
	return session, true
}

// AgentApproveInfo describes a session to the signed-in approver, with the
// org's projects so the page can offer "attach" next to "create".
//
// GET /api/v1/agent/approve/{sessionID}
func (d *Dependencies) AgentApproveInfo(w http.ResponseWriter, r *http.Request) {
	session, ok := d.loadApproveSession(w, r)
	if !ok {
		return
	}
	orgID := OrgIDFromCtx(r.Context())
	status := session.Status
	if status == "pending" && time.Now().After(session.ExpiresAt) {
		status = "expired"
	}
	resp := map[string]any{
		"status":     status,
		"expires_at": session.ExpiresAt.UTC().Format(time.RFC3339),
	}
	if session.AgentName != nil {
		resp["agent_name"] = *session.AgentName
	}
	if session.ProjectName != nil {
		resp["project_name"] = *session.ProjectName
	}
	if session.GitRemote != nil {
		resp["git_remote"] = *session.GitRemote
	}
	projects, err := d.Queries.ListProjectsByOrg(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list projects")
		return
	}
	list := make([]approveProjectJSON, 0, len(projects))
	var suggested *string
	for _, p := range projects {
		list = append(list, approveProjectJSON{ID: p.ID, Name: p.Name, GithubRepo: p.GithubRepo})
		if session.GitRemote != nil && p.GithubRepo != nil && strings.EqualFold(*p.GithubRepo, *session.GitRemote) {
			id := p.ID
			suggested = &id
		}
	}
	resp["projects"] = list
	resp["suggested_project_id"] = suggested
	if session.OrgID != nil && session.ProjectID != nil {
		resp["facts"] = d.agentSessionFacts(r, session)
	}
	writeJSON(w, http.StatusOK, resp)
}

// AgentApprove completes a pending session for the signed-in user's org.
//
// POST /api/v1/agent/approve/{sessionID}
func (d *Dependencies) AgentApprove(w http.ResponseWriter, r *http.Request) {
	session, ok := d.loadApproveSession(w, r)
	if !ok {
		return
	}
	var req struct {
		ProjectName       string  `json:"project_name"`
		ExistingProjectID *string `json:"existing_project_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ExistingProjectID != nil {
		if _, err := uuid.Parse(*req.ExistingProjectID); err != nil {
			writeJSONError(w, http.StatusBadRequest, "existing_project_id must be a UUID")
			return
		}
	}
	name := strings.TrimSpace(req.ProjectName)
	if name == "" && session.ProjectName != nil {
		name = *session.ProjectName
	}
	if name == "" {
		name = "My app"
	}
	if utf8.RuneCountInString(name) > 100 {
		writeJSONError(w, http.StatusBadRequest, "project_name must be 100 characters or less")
		return
	}
	agentKeyPub := ""
	if session.AgentKeyPub != nil {
		agentKeyPub = *session.AgentKeyPub
	}
	project, err := d.Queries.ApproveAgentSession(r.Context(), db.AgentApproveInput{
		SessionID: session.ID, OrgID: OrgIDFromCtx(r.Context()), UserID: UserIDFromCtx(r.Context()),
		ProjectName: name, ExistingProjectID: req.ExistingProjectID,
		SourcemapEndpoint: d.publicOrigin(r),
		SealKeys: func(bundle string) (string, error) {
			return auth.SealAgentKey(agentKeyPub, session.ID, bundle)
		},
	})
	switch {
	case errors.Is(err, db.ErrAgentSessionNotPending):
		writeJSONError(w, http.StatusConflict, "this setup session is no longer pending")
		return
	case errors.Is(err, db.ErrAgentProjectNotInOrg):
		writeJSONErrorCode(w, http.StatusUnprocessableEntity, "that project belongs to another organization", "project_not_in_org")
		return
	case err != nil:
		slog.Error("agent approve", "error", err, "session_id", session.ID)
		writeJSONError(w, http.StatusInternalServerError, "failed to approve")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "provisioned", "project_id": project.ID, "project_name": project.Name})
}

// AgentDeny marks the session failed so the agent stops waiting.
//
// POST /api/v1/agent/approve/{sessionID}/deny
func (d *Dependencies) AgentDeny(w http.ResponseWriter, r *http.Request) {
	session, ok := d.loadApproveSession(w, r)
	if !ok {
		return
	}
	if err := d.Queries.DenyAgentSession(r.Context(), session.ID); err != nil {
		if errors.Is(err, db.ErrAgentSessionNotPending) {
			writeJSONError(w, http.StatusConflict, "this setup session is no longer pending")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to deny")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "failed"})
}
```

`writeJSONErrorCode` (`auth.go:294`) writes `{"error": message, "code": code}`. Create `handler/agent_facts.go` as a stub Task 4 replaces:

```go
package handler

import (
	"net/http"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// agentFacts is filled in by Task 4. The empty struct keeps Task 3 buildable.
type agentFacts struct{}

func (d *Dependencies) agentSessionFacts(_ *http.Request, _ *db.AgentSession) agentFacts { return agentFacts{} }
```

Routes (`routes.go:68-74`):

```go
	// Agent-driven onboarding: unauthenticated start, poll-token polling,
	// cookie-authenticated approve page.
	r.Post("/api/v1/agent/setup", deps.AgentSetup)
	r.Get("/api/v1/agent/poll/{sessionID}", deps.AgentPoll)
	r.Get("/agent/auth/{sessionID}", deps.AgentAuthRedirect)
	r.With(deps.AuthenticateUserSession).Get("/api/v1/agent/approve/{sessionID}", deps.AgentApproveInfo)
	r.With(deps.AuthenticateUserSession, deps.RequireRoleIfCloud("admin")).Post("/api/v1/agent/approve/{sessionID}", deps.AgentApprove)
	r.With(deps.AuthenticateUserSession, deps.RequireRoleIfCloud("admin")).Post("/api/v1/agent/approve/{sessionID}/deny", deps.AgentDeny)
```

Delete `handler/agent_callback_integration_test.go`; delete the two named tests from `github_install_callback_test.go`. `route_matrix_test.go:260-263` (`handlerAuthenticatedRoutes`) keeps `GET /api/v1/agent/poll/{sessionID}` and `POST /api/v1/agent/setup`; nothing changes there in this task. If `db.FindRecentInstallationLandedByRepo` and `db.FindProjectByRepoURL` have no remaining callers (`grep -rn` across `packages/ingestion`), delete them and their tests.

- [x] **Step 5: Run the tests**

```bash
cd packages/ingestion && set -o pipefail
test -z "$(gofmt -l ./handler ./db)" && go vet ./handler ./db
go test ./handler -run 'TestAgentSetup|TestAgentApprove|TestAgentPoll_Expired|TestAgentAuthCallbackRouteIsGone|TestOAuthLoginCallback|TestRouteMatrix|TestEveryAPIRouteHasAnAuthenticator|TestGitHub|TestWebInstall|TestAdminRoutes' -v
go test ./db -run 'TestAdminOverviewOnboardingFunnel' -v
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/ingestion
git commit -m "feat(ingestion): approve-page agent onboarding; delete GitHub-callback identity path

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

### Task 4: Facts and long-poll on the poll endpoint

**Files:**
- Rewrite: `packages/ingestion/handler/agent_facts.go`
- Modify: `packages/ingestion/handler/agent_setup.go` (`AgentPoll`, `writeAgentPollResponse`)
- Test: `packages/ingestion/handler/agent_poll_test.go` (create), `packages/ingestion/handler/agent_facts_test.go` (create, `package handler`)

**Interfaces:**
- Consumes: `HasEvents`, `LatestErrorGroupID` (`db/queries.go:4061`, `:4074`; no status filter), `GetProjectGitHubConfig(ctx, orgID, projectID) (*string, error)` (`db/queries.go:4299`), `HasSourcemapUploads`, `ListAgentSteps`.
- Produces two new queries in `db/queries.go`, each with a test in `db/agent_facts_queries_test.go` (package `db_test`) written before the implementation:

```go
// OrgHasActiveGitHubInstallation is true only when the org's installation id
// resolves to a live row in github_app_installations. GetOrgGitHubInstallation
// only reads orgs.github_installation_id, so a dangling or suspended id would
// read as installed.
func (q *Queries) OrgHasActiveGitHubInstallation(ctx context.Context, orgID string) (bool, error)
// SQL: SELECT EXISTS(SELECT 1 FROM orgs o JOIN github_app_installations i ON i.installation_id = o.github_installation_id
//      WHERE o.id = $1 AND i.suspended_at IS NULL)   -- check the column names against migrations 001:342 and later
// HasEnabledSlackDestination is true for any enabled slack destination,
// whatever it subscribes to. HasEnabledDigestDestination additionally requires
// digest.daily, which is a digest fact, not a "Slack connected" fact.
func (q *Queries) HasEnabledSlackDestination(ctx context.Context, projectID string) (bool, error)
// SQL: SELECT EXISTS(SELECT 1 FROM notification_destinations WHERE project_id = $1 AND enabled AND type = 'slack')
```

Tests: an org whose `github_installation_id` points at no row reads false; a row with `suspended_at` set reads false; a live row reads true. An enabled slack destination subscribed only to `issue.created` reads true; a disabled one reads false.
- Produces:

```go
type agentStepJSON struct {
	Status    string `json:"status"`
	Note      string `json:"note"`
	UpdatedAt string `json:"updated_at"`
}
type agentFacts struct {
	HasEvents           bool                     `json:"has_events"`
	LatestErrorGroupURL *string                  `json:"latest_error_group_url"`
	IssuesURL           string                   `json:"issues_url"`
	GitHubConnected     bool                     `json:"github_connected"`
	GitHubInstalled     bool                     `json:"github_installed"`
	GitHubMode          string                   `json:"github_mode"`
	GitHubConnectURL    string                   `json:"github_connect_url"`
	GitHubRepo          *string                  `json:"github_repo"`
	SlackConnected      bool                     `json:"slack_connected"`
	SourcemapsUploaded  bool                     `json:"sourcemaps_uploaded"`
	Steps               map[string]agentStepJSON `json:"steps"`
}
func (d *Dependencies) agentSessionFacts(r *http.Request, s *db.AgentSession) agentFacts
func mergeFacts(resp map[string]any, f agentFacts)
func agentNextHint(status string, f agentFacts) string
func parseWait(raw string) int // 0..30
```

`github_connected` is strict: app mode requires an installation row **and** an attached repo; PAT mode requires an attached repo. `github_connect_url` is `{publicOrigin}/settings#github`, a dashboard page that starts the authenticated install flow, never the bare GitHub URL. Poll additions: `?wait=N` (`parseWait`), `?until=event`; the loop re-reads the session each second and stops on any terminal status; the response gains all `agentFacts` fields plus `next` and `status_help`.

- [x] **Step 1: Write the failing tests**

`packages/ingestion/handler/agent_facts_test.go` (internal package so it can reach the pure helpers):

```go
package handler

import "testing"

func TestParseWait(t *testing.T) {
	cases := map[string]int{"": 0, "abc": 0, "-3": 0, "0": 0, "7": 7, "30": 30, "31": 30, "999": 30}
	for in, want := range cases {
		if got := parseWait(in); got != want {
			t.Errorf("parseWait(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestAgentNextHint(t *testing.T) {
	if h := agentNextHint("provisioned", agentFacts{}); h == "" || h == agentNextHint("app_reporting", agentFacts{}) {
		t.Fatalf("hints must differ by status: %q", h)
	}
	if h := agentNextHint("app_reporting", agentFacts{HasEvents: true}); h != agentNextHint("provisioned", agentFacts{HasEvents: true}) {
		t.Fatal("once has_events is true the hint no longer depends on status")
	}
}
```

`packages/ingestion/handler/agent_poll_test.go`:

```go
package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// ingestTestEvent sends one error event through the real ingest route with
// the fixture's ingest key and attaches it to a group, the way
// read_api_event_count_test.go does, so has_events and LatestErrorGroupID flip.
func ingestTestEvent(t *testing.T, a approveRig) string {
	t.Helper()
	ctx := context.Background()
	pool := a.deps.Queries.Pool()
	event := `{"timestamp":"2026-08-26T00:00:00Z","error":{"type":"Error","message":"opslane-test","stack":"at test.js:1:1"},"breadcrumbs":[],"context":{"url":"https://example.test"},"sdk_version":"0.1.0"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(event))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", a.rawKey)
	rec := httptest.NewRecorder()
	a.r.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("ingest: %d %s", rec.Code, rec.Body.String())
	}
	var eventID string
	if err := pool.QueryRow(ctx, `SELECT id::text FROM error_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`, a.project).Scan(&eventID); err != nil {
		t.Fatal(err)
	}
	var groupID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, occurrence_count, sample_event_id, platform)
		VALUES ($1, $2, 'opslane-test', now(), now(), 1, $3, 'javascript') RETURNING id::text`,
		a.project, "agent-poll-"+uuid.NewString(), eventID).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_events SET error_group_id = $1 WHERE id = $2`, groupID, eventID); err != nil {
		t.Fatal(err)
	}
	return groupID
}

func timedPoll(t *testing.T, a approveRig, query string) (int, map[string]any, time.Duration) {
	t.Helper()
	start := time.Now()
	code, out := a.poll(t, query)
	return code, out, time.Since(start)
}

func TestAgentPoll_PendingLongPollReturnsOnApproval(t *testing.T) {
	a := newApproveRig(t)
	code, out, took := timedPoll(t, a, "")
	if code != http.StatusOK || out["status"] != "pending" || out["approved"] != false || took > time.Second {
		t.Fatalf("plain poll: %d %v %s", code, out, took)
	}
	go func() {
		time.Sleep(1500 * time.Millisecond)
		a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"`+a.project+`"}`, true)
	}()
	code, out, took = timedPoll(t, a, "?wait=10")
	if code != http.StatusOK || out["approved"] != true {
		t.Fatalf("long poll: %d %v", code, out)
	}
	if took < time.Second || took > 4*time.Second {
		t.Fatalf("long poll should return ~1s after approval, took %s", took)
	}
	for _, k := range []string{"ingest_key", "api_key", "sourcemap_key", "project_id", "dashboard_url", "next", "status_help", "issues_url", "github_connect_url", "steps"} {
		if _, present := out[k]; !present {
			t.Fatalf("missing %s: %v", k, out)
		}
	}
	if out["has_events"] != false || out["github_connected"] != false || out["slack_connected"] != false || out["sourcemaps_uploaded"] != false {
		t.Fatalf("fresh facts should all be false: %v", out)
	}
	if u, _ := out["github_connect_url"].(string); !strings.HasPrefix(u, "https://app.example.test/settings") {
		t.Fatalf("github_connect_url must be an Opslane page: %v", out["github_connect_url"])
	}
}

func TestAgentPoll_UntilEventHoldsThenFlips(t *testing.T) {
	a := newApproveRig(t)
	a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"`+a.project+`"}`, true)
	code, out, took := timedPoll(t, a, "?wait=2&until=event")
	if code != http.StatusOK || out["has_events"] != false || took < 1900*time.Millisecond {
		t.Fatalf("until=event should hold the full wait with no events: %d %v %s", code, out, took)
	}
	groupID := ingestTestEvent(t, a)
	code, out, _ = timedPoll(t, a, "?wait=5&until=event")
	if code != http.StatusOK || out["has_events"] != true {
		t.Fatalf("after event: %d %v", code, out)
	}
	if u, _ := out["latest_error_group_url"].(string); u != "https://app.example.test/issues/"+groupID {
		t.Fatalf("latest_error_group_url %v", out["latest_error_group_url"])
	}
	if next, _ := out["next"].(string); !strings.Contains(next, "Remove the test button") {
		t.Fatalf("next after event: %q", next)
	}
}

func TestAgentPoll_DenyAndExpiryDuringWaitReturnPromptly(t *testing.T) {
	a := newApproveRig(t)
	go func() {
		time.Sleep(1200 * time.Millisecond)
		a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID+"/deny", ``, true)
	}()
	code, out, took := timedPoll(t, a, "?wait=10")
	if code != http.StatusOK || out["status"] != "failed" || took > 4*time.Second {
		t.Fatalf("deny during wait: %d %v %s", code, out, took)
	}
	b := newApproveRig(t)
	b.do(t, http.MethodPost, "/api/v1/agent/approve/"+b.pollID, `{"existing_project_id":"`+b.project+`"}`, true)
	go func() {
		time.Sleep(1200 * time.Millisecond)
		b.deps.Queries.Pool().Exec(context.Background(), `UPDATE agent_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, b.pollID)
	}()
	code, out, took = timedPoll(t, b, "?wait=10&until=event")
	if code != http.StatusGone || out["status"] != "expired" || took > 4*time.Second {
		t.Fatalf("expiry during until=event wait: %d %v %s", code, out, took)
	}
}

func TestAgentPoll_CompletedSessionNeverHolds(t *testing.T) {
	a := newApproveRig(t)
	a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"`+a.project+`"}`, true)
	a.deps.Queries.Pool().Exec(context.Background(), `UPDATE agent_sessions SET status = 'completed' WHERE id = $1`, a.pollID)
	code, out, took := timedPoll(t, a, "?wait=10&until=event")
	if code != http.StatusOK || out["status"] != "completed" || took > 2*time.Second {
		t.Fatalf("completed must return at once: %d %v %s", code, out, took)
	}
}

func TestAgentPoll_CancelledRequestReturns(t *testing.T) {
	a := newApproveRig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	req := agentRequest(http.MethodGet, "/api/v1/agent/poll/"+a.pollID+"?wait=30", "", a.ip).WithContext(ctx)
	req.Header.Set("X-Opslane-Poll-Token", a.token)
	rec := httptest.NewRecorder()
	start := time.Now()
	a.r.ServeHTTP(rec, req)
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("cancelled request should return promptly, took %s", took)
	}
}
```

- [x] **Step 2: Run to verify they fail**

Run: `cd packages/ingestion && go test ./handler -run 'TestParseWait|TestAgentNextHint|TestAgentPoll' 2>&1 | head -5`
Expected: compile failure (`parseWait` undefined).

- [x] **Step 3: Implement**

Replace `packages/ingestion/handler/agent_facts.go`:

```go
package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

type agentStepJSON struct {
	Status    string `json:"status"`
	Note      string `json:"note"`
	UpdatedAt string `json:"updated_at"`
}

type agentFacts struct {
	HasEvents           bool                     `json:"has_events"`
	LatestErrorGroupURL *string                  `json:"latest_error_group_url"`
	IssuesURL           string                   `json:"issues_url"`
	GitHubConnected     bool                     `json:"github_connected"`
	GitHubInstalled     bool                     `json:"github_installed"`
	GitHubMode          string                   `json:"github_mode"`
	GitHubConnectURL    string                   `json:"github_connect_url"`
	GitHubRepo          *string                  `json:"github_repo"`
	SlackConnected      bool                     `json:"slack_connected"`
	SourcemapsUploaded  bool                     `json:"sourcemaps_uploaded"`
	Steps               map[string]agentStepJSON `json:"steps"`
}

// agentSessionFacts evaluates the server-side truth for a bound session.
// Every field is derived from tables, never from what the agent said, and a
// lookup error reads as "not connected", never as connected.
func (d *Dependencies) agentSessionFacts(r *http.Request, s *db.AgentSession) agentFacts {
	ctx := r.Context()
	origin := d.publicOrigin(r)
	f := agentFacts{GitHubMode: "app", GitHubConnectURL: origin + "/settings#github", Steps: map[string]agentStepJSON{}}
	if d.GitHubAppSlug == "" {
		f.GitHubMode = "pat"
	}
	if s.ProjectID == nil || s.OrgID == nil {
		return f
	}
	projectID, orgID := *s.ProjectID, *s.OrgID
	f.IssuesURL = origin + "/?project=" + projectID
	if has, err := d.Queries.HasEvents(ctx, projectID); err == nil {
		f.HasEvents = has
	}
	if f.HasEvents {
		if latest, err := d.Queries.LatestErrorGroupID(ctx, projectID); err == nil && latest != nil {
			u := origin + "/issues/" + *latest
			f.LatestErrorGroupURL = &u
		}
	}
	if repo, err := d.Queries.GetProjectGitHubConfig(ctx, orgID, projectID); err == nil {
		f.GitHubRepo = repo
	}
	repoAttached := f.GitHubRepo != nil && *f.GitHubRepo != ""
	if f.GitHubMode == "app" {
		if ok, err := d.Queries.OrgHasActiveGitHubInstallation(ctx, orgID); err == nil && ok {
			f.GitHubInstalled = true
		}
		f.GitHubConnected = f.GitHubInstalled && repoAttached
	} else {
		f.GitHubConnected = repoAttached
	}
	if ok, err := d.Queries.HasEnabledSlackDestination(ctx, projectID); err == nil {
		f.SlackConnected = ok
	}
	if ok, err := d.Queries.HasSourcemapUploads(ctx, projectID); err == nil {
		f.SourcemapsUploaded = ok
	}
	if steps, err := d.Queries.ListAgentSteps(ctx, s.ID); err == nil {
		for _, st := range steps {
			f.Steps[st.Step] = agentStepJSON{Status: st.Status, Note: st.Note, UpdatedAt: st.UpdatedAt.UTC().Format(time.RFC3339)}
		}
	}
	return f
}

// mergeFacts flattens agentFacts into a response map.
func mergeFacts(resp map[string]any, f agentFacts) {
	b, _ := json.Marshal(f)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for k, v := range m {
		resp[k] = v
	}
}

func agentNextHint(status string, f agentFacts) string {
	switch {
	case f.HasEvents:
		return "First event received. Remove the test button and show latest_error_group_url, or issues_url while grouping catches up."
	case status == "app_reporting":
		return "The SDK is loaded in a browser. Trigger the test error, then poll state with ?wait=30&until=event."
	default:
		return "Install the SDK with ingest_key, load the app, trigger the test error, then poll state with ?wait=30&until=event."
	}
}

const agentStatusHelp = "provisioned: approved, keys ready. key_ok: keys delivered. app_reporting: the SDK has loaded in a browser. Only has_events proves an error arrived."

// parseWait clamps the ?wait query value to 0..30 seconds.
func parseWait(raw string) int {
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0
	}
	if n > 30 {
		return 30
	}
	return n
}
```

In `agent_setup.go`, replace the tail of `AgentPoll` (from the first `GetAgentSession`) with the long-poll loop:

```go
	wait := parseWait(r.URL.Query().Get("wait"))
	untilEvent := r.URL.Query().Get("until") == "event"
	deadline := time.Now().Add(time.Duration(wait) * time.Second)
	for {
		session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
		if err != nil {
			slog.Error("agent poll: get session", "error", err)
			agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error", "message": "internal error"})
			return
		}
		if session == nil || session.PollTokenHash == nil ||
			!hmac.Equal([]byte(auth.HashToken(pollToken)), []byte(*session.PollTokenHash)) {
			agentJSON(w, http.StatusNotFound, map[string]any{"status": "not_found"})
			return
		}
		terminal := session.Status == "failed" || session.Status == "expired" || time.Now().After(session.ExpiresAt)
		approved := session.Status != "pending" && !terminal
		var facts agentFacts
		if approved {
			facts = d.agentSessionFacts(r, session)
		}
		// completed is approved and final: never hold a wait on it.
		done := terminal || session.Status == "completed" || (approved && (!untilEvent || facts.HasEvents))
		if done || wait == 0 || time.Now().After(deadline) {
			d.writeAgentPollResponse(w, r, session, pollToken, facts)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Second):
		}
	}
}
```

Change `writeAgentPollResponse` to take `facts agentFacts` as its last parameter and, in the approved branch after `dashboard_url`, add:

```go
		mergeFacts(resp, facts)
		resp["next"] = agentNextHint(session.Status, facts)
		resp["status_help"] = agentStatusHelp
```

Raise `agentPollLimiter` from `newRateLimiter(30)` to `newRateLimiter(60)` (`agent_setup.go:26`); the session routes in Task 5 share it and a burst after approval (poll, state, progress) must not trip it.

- [x] **Step 4: Run the tests**

```bash
cd packages/ingestion && set -o pipefail
test -z "$(gofmt -l ./handler)" && go vet ./handler
go test ./db -run 'TestOrgHasActiveGitHubInstallation|TestHasEnabledSlackDestination' -v
go test ./handler -run 'TestParseWait|TestAgentNextHint|TestAgentPoll|TestAgentApprove|TestAgentSetup' -v
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/ingestion/handler
git commit -m "feat(ingestion): long-poll agent sessions with strict server facts

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

### Task 5: Session-scoped routes: state, github, slack, progress, complete

**Files:**
- Create: `packages/ingestion/handler/agent_session_routes.go`
- Modify: `packages/ingestion/handler/github_settings.go:46-130` (extract `attachGitHubRepo`), `packages/ingestion/handler/notifications.go` (extract `createTestEnableSlack`), `packages/ingestion/handler/routes.go`, `packages/ingestion/handler/route_matrix_test.go:283` (authenticator markers)
- Test: `packages/ingestion/handler/agent_session_routes_test.go` (create)

**Interfaces:**
- Produces, all under `/api/v1/agent/poll/{sessionID}/` behind `d.AgentSessionAuth` (poll token header; 404 on bad token; 410 expired; 409 when the session is not approved):
  - `GET state?wait=30&until=event|github|slack|change` → `{status, project_id, project_name, dashboard_url, expires_at, ...agentFacts}`. `until` defaults to `change` (return when any fact or reported step differs from the first evaluation); an unknown `until` is a 400. The loop re-reads the session each second and returns 410 the moment it expires. Every response from these routes, including gate rejections and the bare 204, carries `Cache-Control: no-store` (set at the top of `AgentSessionAuth`).
  - `POST github` `{repo}` → 200 `{github_connected:true, github_repo}`; 400 with the same messages `SetGitHubConfig` produces.
  - `POST slack` `{webhook_url}` → 200 `{ok:true, destination_id}` only after enabling succeeded, or 200 `{ok:false, error, classification}` for a failed test send; 400 for a bad URL or blocked host (`errSlackValidation`), 503 when the cipher or sender is not configured, 500 for storage failures. On a failed test the disabled row is deleted (best effort) so nothing can enable it later.
  - `POST progress` `{step, status, note?}` → 204. `install_sdk` and `mcp` accept any status; `first_event`, `github`, `slack`, `sourcemaps` accept only `failed` or `skipped` (diagnostics), never `done` or `running` (400). `note` over 500 runes → 400.
  - `POST complete` → 200 `{onboarding_complete:true}` when the org is already onboarded or the project has events; 422 `{error:"missing_facts", missing:["first_event"]}` otherwise; 500 when the onboarded lookup itself fails (never treated as "not onboarded").
  - Helpers: `func (d *Dependencies) attachGitHubRepo(ctx context.Context, orgID, projectID, repo string) (canonical string, status int, msg string)` and `func (d *Dependencies) createTestEnableSlack(ctx context.Context, orgID, projectID, webhookURL string) (destID string, ok bool, errMsg, classification string, err error)` where `err` is either `errSlackValidation` (wrapped, → 400 with its message), `errSlackUnavailable` (→ 503), or any other error (→ 500 "failed to save destination").

- [x] **Step 1: Write the failing tests**

`packages/ingestion/handler/agent_session_routes_test.go`:

```go
package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/handler"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

func sessionCall(t *testing.T, a approveRig, method, sub, body, token string) (int, map[string]any) {
	t.Helper()
	req := agentRequest(method, "/api/v1/agent/poll/"+a.pollID+"/"+sub, body, a.ip)
	if token != "" {
		req.Header.Set("X-Opslane-Poll-Token", token)
	}
	rec := httptest.NewRecorder()
	a.r.ServeHTTP(rec, req)
	return rec.Code, decodeBody(t, rec)
}

func approvedRig(t *testing.T) approveRig {
	t.Helper()
	a := newApproveRig(t)
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"`+a.project+`"}`, true); code != http.StatusOK {
		t.Fatalf("approve: %d", code)
	}
	return a
}

func expireSession(a approveRig) {
	a.deps.Queries.Pool().Exec(context.Background(), `UPDATE agent_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, a.pollID)
}

func TestAgentSessionRoutes_AuthGate(t *testing.T) {
	a := newApproveRig(t)
	if code, _ := sessionCall(t, a, http.MethodGet, "state", "", ""); code != http.StatusNotFound {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodGet, "state", "", "opt_wrong"); code != http.StatusNotFound {
		t.Fatalf("wrong token: %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodGet, "state", "", a.token); code != http.StatusConflict {
		t.Fatalf("pending session on state: %d", code)
	}
	b := approvedRig(t)
	expireSession(b)
	if code, _ := sessionCall(t, b, http.MethodGet, "state", "", b.token); code != http.StatusGone {
		t.Fatalf("expired session on state: %d", code)
	}
}

func TestAgentSessionRoutes_ProgressAndState(t *testing.T) {
	a := approvedRig(t)
	if code, _ := sessionCall(t, a, http.MethodPost, "progress", `{"step":"install_sdk","status":"running"}`, a.token); code != http.StatusNoContent {
		t.Fatalf("progress: %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodPost, "progress", `{"step":"first_event","status":"done"}`, a.token); code != http.StatusBadRequest {
		t.Fatalf("server-derived done must be refused: %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodPost, "progress", `{"step":"sourcemaps","status":"failed","note":"no CI access"}`, a.token); code != http.StatusNoContent {
		t.Fatalf("server-derived failure note must be accepted: %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodPost, "progress", `{"step":"mcp","status":"nope"}`, a.token); code != http.StatusBadRequest {
		t.Fatalf("bad status: %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodPost, "progress", `{"step":"mcp","status":"done","note":"`+strings.Repeat("é", 501)+`"}`, a.token); code != http.StatusBadRequest {
		t.Fatalf("501-rune note must be refused: %d", code)
	}
	code, out := sessionCall(t, a, http.MethodGet, "state", "", a.token)
	if code != http.StatusOK || out["has_events"] != false || out["slack_connected"] != false || out["project_id"] != a.project {
		t.Fatalf("state: %d %v", code, out)
	}
	steps, _ := out["steps"].(map[string]any)
	install, _ := steps["install_sdk"].(map[string]any)
	sm, _ := steps["sourcemaps"].(map[string]any)
	if install["status"] != "running" || sm["status"] != "failed" || sm["note"] != "no CI access" {
		t.Fatalf("steps in state: %v", out["steps"])
	}
}

func TestAgentSessionRoutes_StateLongPollExpiresMidWait(t *testing.T) {
	a := approvedRig(t)
	go func() {
		time.Sleep(1200 * time.Millisecond)
		expireSession(a)
	}()
	start := time.Now()
	code, _ := sessionCall(t, a, http.MethodGet, "state?wait=10&until=event", "", a.token)
	if code != http.StatusGone || time.Since(start) > 4*time.Second {
		t.Fatalf("state must return 410 promptly on expiry: %d after %s", code, time.Since(start))
	}
}

func TestAgentSessionRoutes_CompleteRequiresEventOrOnboardedOrg(t *testing.T) {
	a := approvedRig(t)
	code, out := sessionCall(t, a, http.MethodPost, "complete", "", a.token)
	if code != http.StatusUnprocessableEntity || out["error"] != "missing_facts" {
		t.Fatalf("complete without event: %d %v", code, out)
	}
	ingestTestEvent(t, a)
	if code, out = sessionCall(t, a, http.MethodPost, "complete", "", a.token); code != http.StatusOK || out["onboarding_complete"] != true {
		t.Fatalf("complete with event: %d %v", code, out)
	}
	ctx := context.Background()
	if _, err := a.deps.Queries.Pool().Exec(ctx, `DELETE FROM error_events WHERE project_id = $1`, a.project); err != nil {
		t.Fatal(err)
	}
	if has, err := a.deps.Queries.HasEvents(ctx, a.project); err != nil || has {
		t.Fatalf("events must be gone before the retry: %v %v", has, err)
	}
	if code, _ = sessionCall(t, a, http.MethodPost, "complete", "", a.token); code != http.StatusOK {
		t.Fatalf("complete on an already-onboarded org must stay 200: %d", code)
	}
}

func TestAgentSessionRoutes_StateDefaultWaitsForChangeAndRejectsUnknownUntil(t *testing.T) {
	a := approvedRig(t)
	if code, _ := sessionCall(t, a, http.MethodGet, "state?until=bogus", "", a.token); code != http.StatusBadRequest {
		t.Fatalf("unknown until: %d", code)
	}
	go func() {
		time.Sleep(1200 * time.Millisecond)
		sessionCall(t, a, http.MethodPost, "progress", `{"step":"install_sdk","status":"running"}`, a.token)
	}()
	start := time.Now()
	code, out := sessionCall(t, a, http.MethodGet, "state?wait=10", "", a.token)
	steps, _ := out["steps"].(map[string]any)
	if code != http.StatusOK || steps["install_sdk"] == nil || time.Since(start) > 4*time.Second {
		t.Fatalf("default wait must return on a progress change: %d %v after %s", code, out, time.Since(start))
	}
	rec := httptest.NewRecorder()
	req := agentRequest(http.MethodGet, "/api/v1/agent/poll/"+a.pollID+"/state", "", a.ip)
	req.Header.Set("X-Opslane-Poll-Token", a.token)
	a.r.ServeHTTP(rec, req)
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("state must be no-store")
	}
	rec = httptest.NewRecorder()
	a.r.ServeHTTP(rec, agentRequest(http.MethodGet, "/api/v1/agent/poll/"+a.pollID+"/state", "", a.ip))
	if rec.Code != http.StatusNotFound || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("gate rejection must be no-store: %d %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
}

func TestAgentSessionRoutes_GitHubAttachPATModeWithoutToken(t *testing.T) {
	a := approvedRig(t) // testDeps leaves GitHubAppSlug empty → PAT mode
	t.Setenv("GITHUB_TOKEN", "")
	code, out := sessionCall(t, a, http.MethodPost, "github", `{"repo":"acme/web"}`, a.token)
	if code != http.StatusBadRequest || out["error"] == nil {
		t.Fatalf("PAT mode without token must fail loudly: %d %v", code, out)
	}
	if code, _ := sessionCall(t, a, http.MethodPost, "github", `{"repo":"not a repo"}`, a.token); code != http.StatusBadRequest {
		t.Fatalf("bad repo: %d", code)
	}
}

func mustHost(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Host
}

// wireNotifySender mirrors notificationRouter (notifications_test.go:34): the
// sender and the extra-host allowlist must both carry the exact host:port.
// Dependencies is a pointer captured by the router, so mutating it after the
// router was built is visible to the handlers.
func wireNotifySender(t *testing.T, deps *handler.Dependencies, hosts []string) {
	t.Helper()
	cipher, err := notify.NewConfigCipher([]byte(notificationCipherSecret))
	if err != nil {
		t.Fatal(err)
	}
	deps.ConfigCipher = cipher
	deps.NotifyExtraHosts = hosts
	deps.NotifySender = notify.NewSender(time.Second, hosts)
}

func TestAgentSessionRoutes_SlackCreateDisabledTestEnable(t *testing.T) {
	okSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer okSrv.Close()
	badSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }))
	defer badSrv.Close()
	hosts := []string{mustHost(t, okSrv.URL), mustHost(t, badSrv.URL)}

	a := approvedRig(t)
	wireNotifySender(t, a.deps, hosts)
	// While the test message is in flight the destination must still be disabled.
	var enabledDuringSend []bool
	okSrv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		var enabled bool
		if err := a.deps.Queries.Pool().QueryRow(context.Background(), `SELECT enabled FROM notification_destinations WHERE project_id = $1`, a.project).Scan(&enabled); err != nil {
			enabled = true // a missing row reads as the worst case
		}
		enabledDuringSend = append(enabledDuringSend, enabled)
		w.WriteHeader(http.StatusOK)
	})
	code, out := sessionCall(t, a, http.MethodPost, "slack", `{"webhook_url":"`+okSrv.URL+`/hook"}`, a.token)
	if code != http.StatusOK || out["ok"] != true || out["destination_id"] == nil {
		t.Fatalf("slack ok: %d %v", code, out)
	}
	if len(enabledDuringSend) != 1 || enabledDuringSend[0] {
		t.Fatalf("destination must be disabled while the test sends: %v", enabledDuringSend)
	}
	if _, out = sessionCall(t, a, http.MethodGet, "state", "", a.token); out["slack_connected"] != true {
		t.Fatalf("slack_connected after enable: %v", out)
	}

	b := approvedRig(t)
	wireNotifySender(t, b.deps, hosts)
	code, out = sessionCall(t, b, http.MethodPost, "slack", `{"webhook_url":"`+badSrv.URL+`/hook"}`, b.token)
	if code != http.StatusOK || out["ok"] != false || out["error"] == nil {
		t.Fatalf("slack failure must be ok:false with error: %d %v", code, out)
	}
	if _, out = sessionCall(t, b, http.MethodGet, "state", "", b.token); out["slack_connected"] != false {
		t.Fatalf("failed test must not enable: %v", out)
	}
	var n int
	if err := b.deps.Queries.Pool().QueryRow(context.Background(), `SELECT count(*) FROM notification_destinations WHERE project_id = $1`, b.project).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("failed test must leave no destination row, found %d", n)
	}
	c := approvedRig(t) // no cipher or sender wired → 503, never a 400 blaming the URL
	if code, _ := sessionCall(t, c, http.MethodPost, "slack", `{"webhook_url":"`+okSrv.URL+`/hook"}`, c.token); code != http.StatusServiceUnavailable {
		t.Fatalf("missing notify config must be 503, got %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodPost, "slack", `{"webhook_url":"not a url"}`, a.token); code != http.StatusBadRequest {
		t.Fatalf("bad webhook url must be 400, got %d", code)
	}
}
```

`notificationCipherSecret` is declared in `notifications_test.go`.

- [x] **Step 2: Run to verify they fail**

Run: `cd packages/ingestion && go test ./handler -run TestAgentSessionRoutes 2>&1 | head -5`
Expected: 404s (routes do not exist).

- [x] **Step 3: Extract the two shared helpers**

In `handler/github_settings.go`, extract from `SetGitHubConfig` the repo validation (`:46-54`), both credential branches (PAT `:55-80` minus the cloud-admin gate at `:59-62`, App `:81-130`), and the persist call into:

```go
// attachGitHubRepo validates repo against the org's installation (app mode)
// or GITHUB_TOKEN (PAT mode), persists it on the project, and returns the
// canonical owner/repo. On rejection it returns the HTTP status and message
// SetGitHubConfig has always produced.
func (d *Dependencies) attachGitHubRepo(ctx context.Context, orgID, projectID, repo string) (canonical string, status int, msg string)
```

Inside the helper, `req.GithubRepo` becomes `repo` and `r.Context()` becomes `ctx`; every `writeJSONError(w, code, m); return` becomes `return "", code, m`; the success path returns `fullName, 0, ""`. `SetGitHubConfig` keeps its decode, keeps the cloud-admin gate exactly where it is today (applied only in PAT mode, `d.GitHubAppSlug == ""`, before calling the helper), then does `canonical, code, msg := d.attachGitHubRepo(...)`, writes the error when `code != 0`, and builds its response from `canonical`. The session route inherits the approver's authority and does not re-check the role.

In `handler/notifications.go`, add:

```go
var (
	errSlackValidation  = errors.New("slack validation")   // wrap with fmt.Errorf("%w: %s", errSlackValidation, reason)
	errSlackUnavailable = errors.New("notifications are not configured")
)

// createTestEnableSlack implements the onboarding rule: create the destination
// disabled, send an issue.created test, and enable only on ok. On a failed
// test the disabled row is deleted (best effort) so it can never be enabled
// later; a disabled orphan left by a crash is harmless since the scheduler
// skips it. ok is true only after the enable UPDATE succeeded. err is
// errSlackValidation for a bad URL or blocked host, errSlackUnavailable when
// ConfigCipher or NotifySender is nil, and any other error for storage
// failures; a failed delivery is never an err, it is ok=false.
func (d *Dependencies) createTestEnableSlack(ctx context.Context, orgID, projectID, webhookURL string) (destID string, ok bool, errMsg, classification string, err error)
```

Build it from the three existing code paths: the create path of `CreateNotificationDestinationEndpoint` (`:134-203`) with `Name: "Slack (agent setup)"`, `Enabled: false`, `EventTypes: []string{"issue.created", "digest.daily"}`, `DeliveryPolicy: "post_triage"`; the send path of `TestNotificationDestinationEndpoint` (`:318-396`) with event type `issue.created`, returning its `ok`, `classification`, and error text; then `UpdateNotificationDestination(ctx, orgID, projectID, destID, nil, nil, nil, &enabled, nil, nil)` with `enabled = true`, or `DeleteNotificationDestination` on `ok == false`. Refactor the two endpoints to call the shared pieces rather than copying them.

- [x] **Step 4: Write the session routes**

`packages/ingestion/handler/agent_session_routes.go`:

```go
package handler

import (
	"context"
	"crypto/hmac"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"reflect"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

type agentSessionCtxKey struct{}

func agentSessionFromCtx(ctx context.Context) *db.AgentSession {
	s, _ := ctx.Value(agentSessionCtxKey{}).(*db.AgentSession)
	return s
}

// loadAgentSessionForToken returns the session when the poll token matches,
// classifying the outcome as one of the HTTP statuses the routes share.
func (d *Dependencies) loadAgentSessionForToken(ctx context.Context, sessionID, token string) (*db.AgentSession, int) {
	session, err := d.Queries.GetAgentSession(ctx, sessionID)
	if err != nil {
		return nil, http.StatusInternalServerError
	}
	if token == "" || session == nil || session.PollTokenHash == nil ||
		!hmac.Equal([]byte(auth.HashToken(token)), []byte(*session.PollTokenHash)) {
		return nil, http.StatusNotFound
	}
	if session.Status == "expired" || time.Now().After(session.ExpiresAt) {
		return session, http.StatusGone
	}
	if session.ProjectID == nil || session.OrgID == nil || session.Status == "pending" || session.Status == "failed" {
		return session, http.StatusConflict
	}
	return session, http.StatusOK
}

func writeSessionGate(w http.ResponseWriter, session *db.AgentSession, status int) {
	switch status {
	case http.StatusNotFound:
		agentJSON(w, status, map[string]any{"status": "not_found"})
	case http.StatusGone:
		agentJSON(w, status, map[string]any{"status": "expired", "message": "session expired; ask the user to run setup again"})
	case http.StatusConflict:
		agentJSON(w, status, map[string]any{"status": session.Status, "message": "session is not approved yet"})
	default:
		agentJSON(w, status, map[string]any{"status": "internal_error", "message": "internal error"})
	}
}

// AgentSessionAuth authenticates a session-scoped route with the poll token
// and requires an approved, unexpired session.
func (d *Dependencies) AgentSessionAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store") // every response on these routes, including rejections and the bare 204
		if !agentPollLimiter.allow(clientIP(r)) {
			w.Header().Set("Retry-After", "60")
			agentJSON(w, http.StatusTooManyRequests, map[string]any{"status": "rate_limited", "retry_after": 60})
			return
		}
		sessionID := chi.URLParam(r, "sessionID")
		if _, err := uuid.Parse(sessionID); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid session ID")
			return
		}
		session, status := d.loadAgentSessionForToken(r.Context(), sessionID, r.Header.Get("X-Opslane-Poll-Token"))
		if status != http.StatusOK {
			writeSessionGate(w, session, status)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), agentSessionCtxKey{}, session)))
	})
}

// AgentSessionState returns the server facts, optionally holding until one
// flips. The session is re-read every second so expiry ends the wait.
//
// GET /api/v1/agent/poll/{sessionID}/state?wait=30&until=event|github|slack|change
func (d *Dependencies) AgentSessionState(w http.ResponseWriter, r *http.Request) {
	s := agentSessionFromCtx(r.Context())
	token := r.Header.Get("X-Opslane-Poll-Token")
	wait := parseWait(r.URL.Query().Get("wait"))
	until := r.URL.Query().Get("until")
	if until == "" {
		until = "change"
	}
	switch until {
	case "event", "github", "slack", "change":
	default:
		writeJSONError(w, http.StatusBadRequest, "until must be event, github, slack, or change")
		return
	}
	deadline := time.Now().Add(time.Duration(wait) * time.Second)
	var first *agentFacts
	for {
		f := d.agentSessionFacts(r, s)
		if first == nil {
			snapshot := f
			first = &snapshot
		}
		done := true
		switch until {
		case "event":
			done = f.HasEvents
		case "github":
			done = f.GitHubConnected
		case "slack":
			done = f.SlackConnected
		case "change":
			done = !reflect.DeepEqual(f, *first)
		}
		if done || wait == 0 || time.Now().After(deadline) {
			resp := map[string]any{
				"status": s.Status, "project_id": *s.ProjectID, "dashboard_url": d.publicOrigin(r),
				"expires_at": s.ExpiresAt.UTC().Format(time.RFC3339),
			}
			if s.ProjectName != nil {
				resp["project_name"] = *s.ProjectName
			}
			mergeFacts(resp, f)
			agentJSON(w, http.StatusOK, resp)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Second):
		}
		var status int
		if s, status = d.loadAgentSessionForToken(r.Context(), s.ID, token); status != http.StatusOK {
			writeSessionGate(w, s, status)
			return
		}
	}
}

// POST /api/v1/agent/poll/{sessionID}/github  {"repo":"owner/repo"}
func (d *Dependencies) AgentSessionGitHub(w http.ResponseWriter, r *http.Request) {
	s := agentSessionFromCtx(r.Context())
	var req struct {
		Repo string `json:"repo"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req); err != nil || !repoURLPattern.MatchString(req.Repo) {
		writeJSONError(w, http.StatusBadRequest, "repo must be in owner/repo format")
		return
	}
	canonical, code, msg := d.attachGitHubRepo(r.Context(), *s.OrgID, *s.ProjectID, req.Repo)
	if code != 0 {
		writeJSONError(w, code, msg)
		return
	}
	agentJSON(w, http.StatusOK, map[string]any{"github_connected": true, "github_repo": canonical})
}

// POST /api/v1/agent/poll/{sessionID}/slack  {"webhook_url":"https://hooks.slack.com/..."}
func (d *Dependencies) AgentSessionSlack(w http.ResponseWriter, r *http.Request) {
	s := agentSessionFromCtx(r.Context())
	var req struct {
		WebhookURL string `json:"webhook_url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req); err != nil || req.WebhookURL == "" {
		writeJSONError(w, http.StatusBadRequest, "webhook_url is required")
		return
	}
	destID, ok, errMsg, classification, err := d.createTestEnableSlack(r.Context(), *s.OrgID, *s.ProjectID, req.WebhookURL)
	switch {
	case errors.Is(err, errSlackValidation):
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	case errors.Is(err, errSlackUnavailable):
		writeJSONError(w, http.StatusServiceUnavailable, "notifications are not configured on this server")
		return
	case err != nil:
		slog.Error("agent slack: create/test/enable", "error", err, "session_id", s.ID)
		writeJSONError(w, http.StatusInternalServerError, "failed to save destination")
		return
	}
	resp := map[string]any{"ok": ok}
	if ok {
		resp["destination_id"] = destID
	} else {
		resp["error"] = errMsg
		resp["classification"] = classification
	}
	agentJSON(w, http.StatusOK, resp)
}

// POST /api/v1/agent/poll/{sessionID}/progress  {"step":"install_sdk","status":"running","note":""}
func (d *Dependencies) AgentSessionProgress(w http.ResponseWriter, r *http.Request) {
	s := agentSessionFromCtx(r.Context())
	var req struct {
		Step   string `json:"step"`
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	switch req.Status {
	case "pending", "running", "done", "skipped", "failed":
	default:
		writeJSONError(w, http.StatusBadRequest, "unknown status")
		return
	}
	switch req.Step {
	case "install_sdk", "mcp":
	case "first_event", "github", "slack", "sourcemaps":
		if req.Status != "failed" && req.Status != "skipped" {
			writeJSONError(w, http.StatusBadRequest, "server-derived step accepts only failed or skipped")
			return
		}
	default:
		writeJSONError(w, http.StatusBadRequest, "unknown step")
		return
	}
	if utf8.RuneCountInString(req.Note) > 500 {
		writeJSONError(w, http.StatusBadRequest, "note must be 500 characters or less")
		return
	}
	if err := d.Queries.UpsertAgentStep(r.Context(), s.ID, req.Step, req.Status, req.Note); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to record progress")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// POST /api/v1/agent/poll/{sessionID}/complete
func (d *Dependencies) AgentSessionComplete(w http.ResponseWriter, r *http.Request) {
	s := agentSessionFromCtx(r.Context())
	onboarded, err := d.Queries.OrgOnboarded(r.Context(), *s.OrgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to check onboarding")
		return
	}
	if onboarded {
		agentJSON(w, http.StatusOK, map[string]any{"onboarding_complete": true})
		return
	}
	has, err := d.Queries.HasEvents(r.Context(), *s.ProjectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to check events")
		return
	}
	if !has {
		agentJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "missing_facts", "missing": []string{"first_event"}})
		return
	}
	if err := d.Queries.MarkOrgOnboarded(r.Context(), *s.OrgID); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to complete onboarding")
		return
	}
	agentJSON(w, http.StatusOK, map[string]any{"onboarding_complete": true})
}
```

`OrgOnboarded` is `db/queries.go:4090`, `MarkOrgOnboarded` is `:4139`; match their signatures. Mount in `routes.go` after the approve routes:

```go
	r.Route("/api/v1/agent/poll/{sessionID}", func(sr chi.Router) {
		sr.Use(deps.AgentSessionAuth)
		sr.Get("/state", deps.AgentSessionState)
		sr.Post("/github", deps.AgentSessionGitHub)
		sr.Post("/slack", deps.AgentSessionSlack)
		sr.Post("/progress", deps.AgentSessionProgress)
		sr.Post("/complete", deps.AgentSessionComplete)
	})
```

Keep the bare `r.Get("/api/v1/agent/poll/{sessionID}", …)` registered before the `Route`. In `route_matrix_test.go:283`, add `"AgentSessionAuth"` to the `authenticators` slice so the five routes are recognised as authenticated by middleware; do not add prefix exemptions.

- [x] **Step 5: Run the tests**

```bash
cd packages/ingestion && set -o pipefail
test -z "$(gofmt -l ./handler)" && go vet ./handler
go test ./handler -run 'TestAgentSessionRoutes|TestAgentPoll|TestAgentApprove|TestSetGitHubConfig|TestGitHub|TestNotificationDestination|TestCreateDisabledNotificationDestination|TestRouteMatrix|TestEveryAPIRouteHasAnAuthenticator' -v
```

Expected: PASS, including the pre-existing GitHub-settings and notification tests, which prove the extractions changed nothing.

- [x] **Step 6: Commit**

```bash
git add packages/ingestion
git commit -m "feat(ingestion): poll-token session routes for state, GitHub, Slack, progress, complete

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

### Task 6: Source-map keys become self-serve

**Files:**
- Modify: `packages/ingestion/handler/api_keys.go:29-116`, `packages/ingestion/db/project_keys.go:344-420`
- Test: `packages/ingestion/handler/api_keys_test.go` (extend)

**Interfaces:**
- `POST /api/v1/projects/{id}/api-keys` accepts `scope: "sourcemaps"` (no `expires_at`); mints via a new `db.CreateSourcemapKey(ctx, orgID, projectID, label, createdByUserID, endpoint string) (*MintedProjectKey, *APIKeyRecord, error)` modelled on `CreateAPIKey` (`db/project_keys.go:344`) but calling `NewProjectKey(ScopeSourcemaps, endpoint)`; the response `token` starts `opslane_sk_`.
- `presentAPIKey` redacts `sourcemaps` keys as `opslane_sk_<key_id>_…`.
- `ListAPIKeys` (`db/project_keys.go:380`) and `RevokeAPIKey` (`:412`) include `'sourcemaps'` in their `scope IN (...)` filters.

- [x] **Step 1: Write the failing test**

Append to `packages/ingestion/handler/api_keys_test.go`. `TestAPIKeyCreateListRevokeScoped` (`:18`) builds its fixture inline with a bearer token and has no reusable helper, so add one first, built the way `newApproveRig` (Task 3) builds its admin cookie:

```go
// apiKeyRouter seeds a tenant with an admin user and returns a router, the
// project id, an admin session cookie, and the raw ingest key.
func apiKeyRouter(t *testing.T) (deps *handler.Dependencies, router http.Handler, projectID string, cookie *http.Cookie) {
	t.Helper()
	deps, pool := testDeps(t)
	ctx := context.Background()
	deps.JWTSecret = []byte(authTestJWTSecret)
	deps.SourceMapStore = newMemorySourceMapStore() // the store sourcemap_upload_test.go:104 uses; needed for the upload round-trip below
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	email := fmt.Sprintf("keys-%s@example.com", uuid.NewString())
	user, err := deps.Queries.CreateUserGitHub(ctx, orgID, email, "Keys", time.Now().UnixNano(), "keys", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := deps.Queries.CreateMembership(ctx, user.ID, orgID, "admin"); err != nil {
		t.Fatal(err)
	}
	tok, err := auth.SignAccessToken(deps.JWTSecret, user.ID, orgID, email)
	if err != nil {
		t.Fatal(err)
	}
	return deps, handler.NewRouterWithPool(deps, pool), projectID, &http.Cookie{Name: handler.AccessCookieName, Value: tok}
}

func TestAPIKeySourcemapsScopeMintsListsRevokes(t *testing.T) {
	deps, router, projectID, cookie := apiKeyRouter(t)
	deps.AuthCallbackOrigin = "https://app.example.test"

	create := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+projectID+"/api-keys", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	rec := create(`{"label":"ci","scope":"sourcemaps"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		KeyID string `json:"key_id"`
		Token string `json:"token"`
		Scope string `json:"scope"`
	}
	json.Unmarshal(rec.Body.Bytes(), &created)
	if !strings.HasPrefix(created.Token, "opslane_sk_") || created.Scope != "sourcemaps" {
		t.Fatalf("token %q scope %q", created.Token, created.Scope)
	}
	if rec := create(`{"label":"ci","scope":"sourcemaps","expires_at":"2030-01-01T00:00:00Z"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("expires_at on sourcemaps must be refused: %d", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectID+"/api-keys", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), `"scope":"sourcemaps"`) || !strings.Contains(rec.Body.String(), `"redacted":"opslane_sk_`+created.KeyID) {
		t.Fatalf("listing: %s", rec.Body.String())
	}

	// The minted key must work before revocation, or the 401 below proves nothing.
	mapBody := []byte(`{"version":3,"file":"a.js","sources":["a.ts"],"names":[],"mappings":"AAAA"}`)
	debugID := computeTestDebugID(t, mapBody) // the helper sourcemap_upload_test.go:104 uses to derive the id from the bytes
	upload := func() *httptest.ResponseRecorder {
		up := httptest.NewRequest(http.MethodPut, "/api/v1/sourcemaps/"+debugID, bytes.NewReader(mapBody))
		up.Header.Set("Content-Type", "application/json")
		up.Header.Set("X-API-Key", created.Token)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, up)
		return rec
	}
	if rec := upload(); rec.Code != http.StatusCreated {
		t.Fatalf("upload with the fresh sourcemaps key: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/projects/"+projectID+"/api-keys/"+created.KeyID, nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent && rec.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body.String())
	}
	if rec := upload(); rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked sourcemaps key must be rejected on upload, got %d", rec.Code)
	}
}
```

`computeTestDebugID` and `newMemorySourceMapStore` are whatever `sourcemap_upload_test.go:104` uses to compute the id and to satisfy the store dependency; use their real names. Check the revoke route's method, path, and status in `routes.go:147-149` and adjust the two assertions to match.

- [x] **Step 2: Run to verify it fails**

Run: `cd packages/ingestion && go test ./handler -run TestAPIKeySourcemapsScope -v`
Expected: FAIL, 400 `scope must be api or ingest`.

- [x] **Step 3: Implement**

`db/project_keys.go`: add next to `CreateAPIKey`:

```go
// CreateSourcemapKey mints a sourcemaps-scoped key whose payload carries the
// upload endpoint. Tenant-scoped like CreateAPIKey.
func (q *Queries) CreateSourcemapKey(ctx context.Context, orgID, projectID, label, createdByUserID, endpoint string) (*MintedProjectKey, *APIKeyRecord, error)
```

with the same shape as `CreateAPIKey` (`:344-372`) except: `NewProjectKey(ScopeSourcemaps, endpoint)`, no expiry, and the INSERT writes `minted.Scope` and `minted.TokenPrefix` instead of the literals `'api'` and `'opslane_ak'` that `CreateAPIKey` hardcodes at `:358` (a copied literal would store an `opslane_sk_` token under the api scope and it would never authenticate an upload). Change the `scope IN ('api', 'ingest')` filters at `:380` and `:412` to `scope IN ('api', 'ingest', 'sourcemaps')`.

`handler/api_keys.go`: in `presentAPIKey` (`:29`) add `if key.Scope == db.ScopeSourcemaps { prefix = "opslane_sk_" }`. Replace the scope block at `:75-87` and the mint branch at `:89-99` with:

```go
	if input.Scope == "" {
		input.Scope = db.ScopeAPI
	}
	switch input.Scope {
	case db.ScopeAPI, db.ScopeIngest, db.ScopeSourcemaps:
	default:
		writeJSONError(w, http.StatusBadRequest, "scope must be api, ingest, or sourcemaps")
		return
	}
	if input.Scope != db.ScopeAPI && input.ExpiresAt != nil {
		writeJSONError(w, http.StatusBadRequest, "expires_at is only supported for api keys")
		return
	}

	var minted *db.MintedProjectKey
	var record *db.APIKeyRecord
	var err error
	orgID, userID := OrgIDFromCtx(r.Context()), UserIDFromCtx(r.Context())
	switch input.Scope {
	case db.ScopeIngest:
		minted, record, err = d.Queries.CreateIngestKeyCapped(r.Context(), orgID, projectID, input.Label, &userID)
	case db.ScopeSourcemaps:
		minted, record, err = d.Queries.CreateSourcemapKey(r.Context(), orgID, projectID, input.Label, userID, d.publicOrigin(r))
	default:
		minted, record, err = d.Queries.CreateAPIKey(r.Context(), orgID, projectID, input.Label, userID, input.ExpiresAt)
	}
```

- [x] **Step 4: Run the tests**

```bash
cd packages/ingestion && set -o pipefail
go test ./handler -run 'TestAPIKey|TestIngestScopeKeyLifecycleAndCap' -v
go test ./db -run 'ProjectKey|APIKey|Sourcemap' -v
```

Expected: PASS, including `TestAPIKeyCreateListRevokeScoped` and `TestIngestScopeKeyLifecycleAndCap`.

- [x] **Step 5: Commit**

```bash
git add packages/ingestion/handler/api_keys.go packages/ingestion/handler/api_keys_test.go packages/ingestion/db/project_keys.go
git commit -m "feat(ingestion): self-serve sourcemaps keys, listed and revocable

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

### Task 7: Ingestion package gate and route docs

- [x] **Step 1: Full package verification with skips counted**

```bash
cd packages/ingestion && set -euo pipefail
export DATABASE_URL="${DATABASE_URL:?export DATABASE_URL first}"
export MINIO_ENDPOINT="${MINIO_ENDPOINT:?}" MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:?}" MINIO_SECRET_KEY="${MINIO_SECRET_KEY:?}" MINIO_BUCKET="${MINIO_BUCKET:?}"
test -z "$(gofmt -l .)"
go vet ./...
go test -count=1 -json ./... > /tmp/ingestion-test.jsonl || true   # the JSON is inspected below; do not let grep's exit status stand in for the run
skips=$(grep -c '"Action":"skip"' /tmp/ingestion-test.jsonl || true)
fails=$(grep -c '"Action":"fail"' /tmp/ingestion-test.jsonl || true)
echo "skips=$skips fails=$fails"
[ "$skips" = "0" ] && [ "$fails" = "0" ]
```

Expected: the last line exits 0 (both counts zero). A non-zero skip count means the storage or database env is missing; fix the env, do not proceed.

- [x] **Step 2: Docs for the routes**

In `docs/reference/http-routes.md`: remove the `/agent/auth/callback` row and rewrite the paragraph at `:37` that describes the automated callback (`code`, `installation_id`, UUID `state`, and `/auth/callback` dispatching UUID state) to describe dashboard approval and poll-token routes instead; add `GET /agent/auth/{id}` (redirect), `GET|POST /api/v1/agent/approve/{id}`, `POST /api/v1/agent/approve/{id}/deny`, `GET /api/v1/agent/poll/{id}` (`wait`, `until`), and the five session routes, each with its auth (`cookie`, `cookie + admin (cloud)`, `poll token`); update the API-key rows at `:85-87` to list the `sourcemaps` scope. Commit:

```bash
git add docs/reference/http-routes.md
git commit -m "docs: agent onboarding routes

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

---

## Milestone B: dashboard

### Task 8: Approve page with picker, decline, and the live checklist

**Files:**
- Rewrite: `packages/dashboard/src/views/AgentApprove.vue`
- Modify: `packages/dashboard/src/api.ts` (replace the spike's two wrappers), `packages/dashboard/src/types/api.ts` (append)
- Test: `packages/dashboard/src/views/__tests__/agent-approve.test.ts` (create)

**Interfaces:**
- Consumes (Tasks 3–5): `GET /api/v1/agent/approve/{id}` → `AgentApproveInfo`; `POST /api/v1/agent/approve/{id}` body `{project_name?, existing_project_id?}`; `POST /api/v1/agent/approve/{id}/deny`.
- Produces types in `src/types/api.ts`:

```ts
export interface AgentApproveProject { id: string; name: string; github_repo: string | null }
export type AgentStepName = 'approve' | 'install_sdk' | 'first_event' | 'github' | 'slack' | 'sourcemaps' | 'mcp';
export type AgentStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export interface AgentStepState { status: AgentStepStatus; note: string; updated_at: string }
export interface AgentFacts {
  has_events: boolean; latest_error_group_url: string | null; issues_url: string;
  github_connected: boolean; github_installed: boolean; github_mode: 'app' | 'pat';
  github_connect_url: string; github_repo: string | null; slack_connected: boolean;
  sourcemaps_uploaded: boolean; steps: Partial<Record<Exclude<AgentStepName, 'approve'>, AgentStepState>>;
}
export type AgentSessionStatus = 'pending' | 'provisioned' | 'key_ok' | 'app_reporting' | 'completed' | 'failed' | 'expired';
export interface AgentApproveInfo {
  status: AgentSessionStatus; agent_name?: string; project_name?: string; git_remote?: string; expires_at: string;
  projects: AgentApproveProject[]; suggested_project_id: string | null; facts?: AgentFacts;
}
```

and wrappers in `src/api.ts`:

```ts
export function getAgentApproveInfo(sessionId: string): Promise<AgentApproveInfo>
export function approveAgentSession(sessionId: string, body: { project_name?: string; existing_project_id?: string }): Promise<{ status: string; project_id: string; project_name: string }>
export function denyAgentSession(sessionId: string): Promise<{ status: string }>
```

Checklist derivation, exported from the view's plain `<script>` block for testing:

```ts
export function deriveChecklist(info: AgentApproveInfo): Array<{ step: AgentStepName; label: string; status: AgentStepStatus; note: string }>
```

Rules (server facts win): `approve` = `done` when status is not `pending`/`failed`/`expired`, `failed` when `failed`, else `running`; `first_event` = `has_events ? done : (reported failed/skipped ? that : install_sdk done ? running : pending)`; `github`/`slack`/`sourcemaps` = `done` when the fact is true, otherwise the agent's reported status if any (only `failed`/`skipped` are storable), else `pending`; `install_sdk` and `mcp` = the agent's report, else `pending`. The list is rendered on the choose screen too (all rows pending except `approve` running), so the user sees the whole plan before clicking.

Phase handling: one `applyInfo(info)` maps status to phase (`pending` → choose, `failed` → denied, `expired` → error, anything else → progress). Polling runs in every non-terminal phase, including `choose` (approval or denial in another tab, and expiry while the picker is open, must show up), and stops on `failed`, `expired`, and `completed`. Refreshes are serialized and generation-stamped: a response from a request started before unmount or before a terminal transition is discarded, so a late `provisioned` can never restart the interval. `deny()` applies `{...info, status: 'failed'}` through `applyInfo` so the `approve` row reads `failed`.

- [x] **Step 1: Write the failing test**

`packages/dashboard/src/views/__tests__/agent-approve.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { AgentApproveInfo, AgentFacts } from '../../types/api';

const api = vi.hoisted(() => ({
  getAgentApproveInfo: vi.fn(),
  approveAgentSession: vi.fn(),
  denyAgentSession: vi.fn(),
}));
vi.mock('../../api', () => api);
const routerPush = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
  useRoute: () => ({ params: { id: 'sess-1' } }),
}));

import AgentApprove, { deriveChecklist } from '../AgentApprove.vue';

const emptyFacts: AgentFacts = {
  has_events: false, latest_error_group_url: null, issues_url: 'http://x/', github_connected: false, github_installed: false,
  github_mode: 'app', github_connect_url: 'http://x/settings#github', github_repo: null, slack_connected: false,
  sourcemaps_uploaded: false, steps: {},
};

function pending(overrides: Partial<AgentApproveInfo> = {}): AgentApproveInfo {
  return {
    status: 'pending', agent_name: 'Claude Code on box', project_name: 'acme-web', git_remote: 'acme/web',
    expires_at: '2030-01-01T00:00:00Z',
    projects: [{ id: 'p-old', name: 'Old', github_repo: 'acme/web' }, { id: 'p-2', name: 'Other', github_repo: null }],
    suggested_project_id: 'p-old',
    ...overrides,
  };
}

const statuses = (w: ReturnType<typeof mount>) => w.findAll('[data-testid^="step-"]').map((r) => r.attributes('data-status'));

describe('AgentApprove', () => {
  beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows the whole checklist before approval, preselects the matching project, and approves as attach', async () => {
    api.getAgentApproveInfo.mockResolvedValue(pending());
    api.approveAgentSession.mockResolvedValue({ status: 'provisioned', project_id: 'p-old', project_name: 'Old' });
    const w = mount(AgentApprove);
    await flushPromises();
    expect(w.text()).toContain('Claude Code on box');
    expect(statuses(w)).toEqual(['running', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(w.find('input[type="radio"]:checked').attributes('value')).toBe('p-old');
    await w.find('[data-testid="agent-approve-button"]').trigger('click');
    await flushPromises();
    expect(api.approveAgentSession).toHaveBeenCalledWith('sess-1', { existing_project_id: 'p-old' });
    w.unmount();
  });

  it('creates a new project when no repo matches, using the typed name', async () => {
    api.getAgentApproveInfo.mockResolvedValue(pending({ suggested_project_id: null, projects: [] }));
    api.approveAgentSession.mockResolvedValue({ status: 'provisioned', project_id: 'p-new', project_name: 'Acme Web' });
    const w = mount(AgentApprove);
    await flushPromises();
    await w.find('[data-testid="agent-project-name"]').setValue('Acme Web');
    await w.find('[data-testid="agent-approve-button"]').trigger('click');
    await flushPromises();
    expect(api.approveAgentSession).toHaveBeenCalledWith('sess-1', { project_name: 'Acme Web' });
    w.unmount();
  });

  it('decline marks the session failed and says so', async () => {
    api.getAgentApproveInfo.mockResolvedValue(pending());
    api.denyAgentSession.mockResolvedValue({ status: 'failed' });
    const w = mount(AgentApprove);
    await flushPromises();
    await w.find('[data-testid="agent-deny-button"]').trigger('click');
    await flushPromises();
    expect(api.denyAgentSession).toHaveBeenCalledWith('sess-1');
    expect(w.text()).toContain('declined');
    expect(statuses(w)[0]).toBe('failed');
    w.unmount();
  });

  it('polls while the picker is open and reacts to approval from another tab', async () => {
    vi.useFakeTimers();
    api.getAgentApproveInfo
      .mockResolvedValueOnce(pending())
      .mockResolvedValue(pending({ status: 'provisioned', facts: emptyFacts }));
    const w = mount(AgentApprove);
    await flushPromises();
    expect(w.find('[data-testid="agent-approve-button"]').exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(3100);
    await flushPromises();
    expect(w.find('[data-testid="agent-approve-button"]').exists()).toBe(false);
    expect(statuses(w)[0]).toBe('done');
    w.unmount();
  });

  it('discards a refresh that resolves after unmount or after a terminal state', async () => {
    vi.useFakeTimers();
    let resolveLate: (v: AgentApproveInfo) => void = () => undefined;
    api.getAgentApproveInfo
      .mockResolvedValueOnce(pending({ status: 'provisioned', facts: emptyFacts }))
      .mockImplementationOnce(() => new Promise<AgentApproveInfo>((res) => { resolveLate = res; }))
      .mockResolvedValue(pending({ status: 'expired' }));
    const w = mount(AgentApprove);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3100); // second call: the deferred one
    await vi.advanceTimersByTimeAsync(3100); // third call: expired → terminal, polling stops
    await flushPromises();
    expect(w.text()).toContain('expired');
    const calls = api.getAgentApproveInfo.mock.calls.length;
    resolveLate(pending({ status: 'provisioned', facts: emptyFacts })); // stale response
    await flushPromises();
    expect(w.text()).toContain('expired');
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.getAgentApproveInfo.mock.calls.length).toBe(calls);
    w.unmount();
  });

  it('refreshes the checklist after approval and applies terminal states from polling', async () => {
    vi.useFakeTimers();
    api.getAgentApproveInfo
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(pending({ status: 'provisioned', facts: emptyFacts }))
      .mockResolvedValueOnce(pending({
        status: 'key_ok',
        facts: { ...emptyFacts, has_events: true, latest_error_group_url: 'http://x/issues/g1',
          steps: { install_sdk: { status: 'done', note: 'vite', updated_at: '' }, mcp: { status: 'skipped', note: 'headless', updated_at: '' } } },
      }))
      .mockResolvedValue(pending({ status: 'expired' }));
    api.approveAgentSession.mockResolvedValue({ status: 'provisioned', project_id: 'p-old', project_name: 'Old' });
    const w = mount(AgentApprove);
    await flushPromises();
    await w.find('[data-testid="agent-approve-button"]').trigger('click');
    await flushPromises();
    expect(statuses(w)).toEqual(['done', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
    await vi.advanceTimersByTimeAsync(3100);
    await flushPromises();
    expect(statuses(w)).toEqual(['done', 'done', 'done', 'pending', 'pending', 'pending', 'skipped']);
    expect(w.find('[data-testid="agent-latest-issue"]').attributes('href')).toBe('http://x/issues/g1');
    await vi.advanceTimersByTimeAsync(3100);
    await flushPromises();
    expect(w.text()).toContain('expired');
    const calls = api.getAgentApproveInfo.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6500);
    expect(api.getAgentApproveInfo.mock.calls.length).toBe(calls); // polling stopped on a terminal state
    w.unmount();
  });

  it('a session that is already approved on load goes straight to the checklist', async () => {
    api.getAgentApproveInfo.mockResolvedValue(pending({ status: 'app_reporting', facts: emptyFacts }));
    const w = mount(AgentApprove);
    await flushPromises();
    expect(w.find('[data-testid="agent-approve-button"]').exists()).toBe(false);
    expect(statuses(w)[0]).toBe('done');
    w.unmount();
  });
});

describe('deriveChecklist', () => {
  it('lets server facts override agent reports and keeps agent failure notes', () => {
    const info = pending({
      status: 'app_reporting',
      facts: { ...emptyFacts, has_events: true, github_connected: true, github_installed: true, github_repo: 'acme/web',
        steps: { install_sdk: { status: 'done', note: '', updated_at: '' }, sourcemaps: { status: 'failed', note: 'no CI access', updated_at: '' }, mcp: { status: 'skipped', note: 'headless', updated_at: '' } } },
    });
    const list = deriveChecklist(info);
    expect(list.map((s) => `${s.step}:${s.status}`)).toEqual([
      'approve:done', 'install_sdk:done', 'first_event:done', 'github:done', 'slack:pending', 'sourcemaps:failed', 'mcp:skipped',
    ]);
    expect(list.find((s) => s.step === 'sourcemaps')?.note).toBe('no CI access');
  });
  it('honours a reported first_event failure until the server fact overrides it', () => {
    const reported = pending({ status: 'key_ok', facts: { ...emptyFacts, steps: { install_sdk: { status: 'done', note: '', updated_at: '' }, first_event: { status: 'failed', note: 'CSP blocked', updated_at: '' } } } });
    expect(deriveChecklist(reported).find((s) => s.step === 'first_event')).toMatchObject({ status: 'failed', note: 'CSP blocked' });
    const overridden = pending({ status: 'key_ok', facts: { ...reported.facts!, has_events: true } });
    expect(deriveChecklist(overridden).find((s) => s.step === 'first_event')?.status).toBe('done');
  });
  it('marks approve failed on a declined session', () => {
    expect(deriveChecklist(pending({ status: 'failed' }))[0]).toMatchObject({ step: 'approve', status: 'failed' });
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/views/__tests__/agent-approve.test.ts`
Expected: FAIL (no `deriveChecklist` export, no radio inputs, no decline button).

- [x] **Step 3: Implement the view**

Replace `packages/dashboard/src/views/AgentApprove.vue`:

```vue
<script lang="ts">
import type { AgentApproveInfo, AgentStepName, AgentStepStatus } from '../types/api';

const STEP_LABELS: Record<AgentStepName, string> = {
  approve: 'Approve this setup',
  install_sdk: 'Install the SDK',
  first_event: 'First event received',
  github: 'GitHub connected',
  slack: 'Slack digest connected',
  sourcemaps: 'Source maps uploading',
  mcp: 'Agent connected to Opslane',
};
const STEP_ORDER: AgentStepName[] = ['approve', 'install_sdk', 'first_event', 'github', 'slack', 'sourcemaps', 'mcp'];

export function deriveChecklist(info: AgentApproveInfo) {
  const facts = info.facts;
  const steps = facts?.steps ?? {};
  const reported = (s: Exclude<AgentStepName, 'approve'>): AgentStepStatus => steps[s]?.status ?? 'pending';
  const note = (s: AgentStepName): string => (s === 'approve' ? '' : steps[s]?.note ?? '');
  const approveStatus: AgentStepStatus =
    info.status === 'failed' ? 'failed' : info.status === 'pending' || info.status === 'expired' ? 'running' : 'done';
  const status = (s: AgentStepName): AgentStepStatus => {
    switch (s) {
      case 'approve':
        return approveStatus;
      case 'first_event': {
        if (facts?.has_events) return 'done';
        const r = reported('first_event');
        if (r === 'failed' || r === 'skipped') return r;
        return reported('install_sdk') === 'done' ? 'running' : 'pending';
      }
      case 'github':
        return facts?.github_connected ? 'done' : reported(s);
      case 'slack':
        return facts?.slack_connected ? 'done' : reported(s);
      case 'sourcemaps':
        return facts?.sourcemaps_uploaded ? 'done' : reported(s);
      default:
        return reported(s);
    }
  };
  return STEP_ORDER.map((step) => ({ step, label: STEP_LABELS[step], status: status(step), note: note(step) }));
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { approveAgentSession, denyAgentSession, getAgentApproveInfo } from '../api';
import Button from '../components/ui/Button.vue';

type Phase = 'loading' | 'choose' | 'working' | 'progress' | 'denied' | 'error';

const route = useRoute();
const router = useRouter();
const sessionId = typeof route.params.id === 'string' ? route.params.id : '';

const info = ref<AgentApproveInfo | null>(null);
const choice = ref<string>('__new__');
const projectName = ref('');
const phase = ref<Phase>('loading');
const message = ref('');
let timer: ReturnType<typeof setInterval> | null = null;
let generation = 0;          // bumped on unmount and on terminal states; stale responses are discarded
let inFlight = false;        // one refresh at a time

const checklist = computed(() => (info.value ? deriveChecklist(info.value) : []));
const latestIssue = computed(() => info.value?.facts?.latest_error_group_url ?? null);
const TERMINAL = new Set(['failed', 'expired', 'completed']);

function stopPolling(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
function startPolling(): void {
  if (!timer) timer = setInterval(() => { void refresh(); }, 3000);
}

function applyInfo(next: AgentApproveInfo): void {
  info.value = next;
  switch (next.status) {
    case 'pending':
      if (phase.value === 'loading') {
        projectName.value = next.project_name ?? '';
        choice.value = next.suggested_project_id ?? '__new__';
        phase.value = 'choose';
      }
      startPolling();
      break;
    case 'failed':
      phase.value = 'denied';
      break;
    case 'expired':
      phase.value = 'error';
      message.value = 'This setup link has expired. Ask your agent to run setup again.';
      break;
    default:
      phase.value = 'progress';
      startPolling();
  }
  if (TERMINAL.has(next.status)) {
    stopPolling();
    generation++;
  }
}

async function refresh(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const gen = generation;
  try {
    const next = await getAgentApproveInfo(sessionId);
    if (gen !== generation) return; // unmounted or terminal since this request started
    applyInfo(next);
  } catch (err: unknown) {
    if (gen !== generation) return;
    stopPolling();
    generation++;
    phase.value = 'error';
    message.value = err instanceof Error ? err.message : 'Could not load this setup request.';
  } finally {
    inFlight = false;
  }
}

onMounted(async () => {
  sessionStorage.removeItem('opslane_post_auth_path');
  await refresh();
});
onBeforeUnmount(() => { stopPolling(); generation++; });

async function approve(): Promise<void> {
  phase.value = 'working';
  try {
    const body = choice.value === '__new__' ? { project_name: projectName.value.trim() } : { existing_project_id: choice.value };
    await approveAgentSession(sessionId, body);
    await refresh();
  } catch (err: unknown) {
    phase.value = 'error';
    message.value = err instanceof Error ? err.message : 'Approval failed.';
  }
}

async function deny(): Promise<void> {
  phase.value = 'working';
  try {
    await denyAgentSession(sessionId);
    if (info.value) applyInfo({ ...info.value, status: 'failed' });
    else phase.value = 'denied';
  } catch (err: unknown) {
    phase.value = 'error';
    message.value = err instanceof Error ? err.message : 'Could not decline.';
  }
}
</script>

<template>
  <div class="min-h-screen bg-background flex items-center justify-center px-6">
    <div class="max-w-lg w-full rounded-lg border border-border bg-surface p-8" data-testid="agent-approve">
      <p v-if="phase === 'loading'" class="text-sm text-muted">Loading setup request…</p>

      <template v-else-if="phase === 'choose' || phase === 'working'">
        <h1 class="text-lg font-medium text-text">Approve agent setup</h1>
        <p class="mt-3 text-sm text-muted">
          <strong class="text-text">{{ info?.agent_name || 'A coding agent' }}</strong>
          wants to set up Opslane<span v-if="info?.git_remote"> for <code>{{ info?.git_remote }}</code></span>. It will do the steps below and stop only for what it cannot do alone.
        </p>

        <fieldset class="mt-6 space-y-3">
          <legend class="text-xs font-medium text-muted">Project</legend>
          <label class="flex items-start gap-3 rounded border border-border p-3">
            <input type="radio" value="__new__" v-model="choice" class="mt-1" />
            <span class="flex-1">
              <span class="block text-sm text-text">Create a new project</span>
              <input
                id="agent-project-name"
                v-model="projectName"
                :disabled="choice !== '__new__'"
                class="mt-2 w-full rounded border border-border bg-background px-3 py-2 text-sm text-text disabled:opacity-50"
                data-testid="agent-project-name"
              />
            </span>
          </label>
          <label v-for="p in info?.projects ?? []" :key="p.id" class="flex items-start gap-3 rounded border border-border p-3">
            <input type="radio" :value="p.id" v-model="choice" class="mt-1" />
            <span class="flex-1">
              <span class="block text-sm text-text">Use <strong>{{ p.name }}</strong></span>
              <span v-if="p.github_repo" class="block text-xs text-muted">{{ p.github_repo }}<span v-if="p.id === info?.suggested_project_id"> · matches this repo</span></span>
            </span>
          </label>
        </fieldset>

        <p class="mt-4 text-xs text-muted">
          Approving mints an ingest key for the browser SDK, an API key for the agent's MCP connection, and a source-map upload key. All three are listed under Settings and can be revoked there.
        </p>
        <div class="mt-6 flex gap-3">
          <Button variant="primary" class="flex-1" :disabled="phase === 'working' || (choice === '__new__' && !projectName.trim())" data-testid="agent-approve-button" @click="approve">
            {{ phase === 'working' ? 'Working…' : 'Approve' }}
          </Button>
          <Button variant="ghost" :disabled="phase === 'working'" data-testid="agent-deny-button" @click="deny">Decline</Button>
        </div>
      </template>

      <template v-else-if="phase === 'progress'">
        <h1 class="text-lg font-medium text-text">Your agent is setting up Opslane</h1>
        <p class="mt-2 text-sm text-muted">This page updates as the agent works. You can go back to your terminal.</p>
      </template>

      <template v-else-if="phase === 'denied'">
        <h1 class="text-lg font-medium text-text">Setup declined</h1>
        <p class="mt-3 text-sm text-muted">You declined this setup. The agent will stop.</p>
      </template>

      <template v-else>
        <h1 class="text-lg font-medium text-text">Agent setup</h1>
        <p class="mt-3 text-sm text-danger" v-text="message"></p>
        <router-link to="/" class="mt-6 inline-block text-sm text-accent hover:underline">Back to Opslane</router-link>
      </template>

      <ol v-if="phase === 'choose' || phase === 'working' || phase === 'progress' || phase === 'denied'" class="mt-6 space-y-3" data-testid="agent-checklist">
        <li v-for="item in checklist" :key="item.step" :data-testid="`step-${item.step}`" :data-status="item.status" class="flex items-start gap-3 text-sm">
          <span class="mt-0.5 inline-block h-4 w-4 rounded-full border"
            :class="{ 'bg-success border-success': item.status === 'done', 'border-accent animate-pulse': item.status === 'running', 'bg-danger border-danger': item.status === 'failed', 'border-border': item.status === 'pending' || item.status === 'skipped' }"
          ></span>
          <span class="flex-1">
            <span class="text-text" :class="{ 'line-through text-muted': item.status === 'skipped' }">{{ item.label }}</span>
            <span v-if="item.note" class="block text-xs text-muted">{{ item.note }}</span>
          </span>
        </li>
      </ol>
      <a v-if="phase === 'progress' && latestIssue" :href="latestIssue" class="mt-6 inline-block text-sm text-accent hover:underline" data-testid="agent-latest-issue">Open the test error</a>
      <Button v-if="phase === 'progress'" variant="secondary" class="mt-6" @click="router.push('/')">Open dashboard</Button>
    </div>
  </div>
</template>
```

Replace the spike's two wrappers in `src/api.ts` with the three under Interfaces and append the types to `src/types/api.ts`. Check the Tailwind token names (`bg-success`, `text-danger`, `border-accent`) against `packages/dashboard/tailwind.config.*` and use the project's names.

- [x] **Step 4: Run the tests and the typecheck**

Run: `cd packages/dashboard && npx vitest run src/views/__tests__/agent-approve.test.ts && npx vue-tsc --noEmit`
Expected: PASS, no type errors.

- [x] **Step 5: Commit**

```bash
git add packages/dashboard/src/views/AgentApprove.vue packages/dashboard/src/views/__tests__/agent-approve.test.ts packages/dashboard/src/api.ts packages/dashboard/src/types/api.ts
git commit -m "feat(dashboard): agent approve page with project picker, decline, and live checklist

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

### Task 9: The paste box on the wizard and empty states; key scopes in Settings

**Files:**
- Create: `packages/dashboard/src/components/AgentPasteBox.vue`
- Modify: `packages/dashboard/src/views/SetupWizard.vue:466`, `packages/dashboard/src/views/IssuesList.vue:264-273`, `packages/dashboard/src/views/SessionsList.vue:343`
- Modify: `packages/dashboard/src/views/Settings.vue:1041-1108`, `packages/dashboard/src/types/api.ts:62,77`, `packages/dashboard/src/api.ts:493-498`
- Delete: `packages/dashboard/public/INSTALL.md`
- Test: `packages/dashboard/src/components/__tests__/agent-paste-box.test.ts` (create), `packages/dashboard/src/views/Settings.test.ts` (extend; update the assertion at `:315`)

**Interfaces:**
- `AgentPasteBox` prop `variant: 'wizard' | 'empty'` (default `'empty'`). Renders `Set up https://docs.opslane.com/INSTALL.md` in a dark code box with `CopyButton` and the caption "Paste into your agent". `wizard` adds "Prefer to do it by hand? The snippet is below."; `empty` adds "Prefer the manual setup?" with a `/setup` link labelled "Setup guide".
- Types: `ManagedAPIKey.scope` (`types/api.ts:62`) and `CreatedAPIKey.scope` (`:77`) widen to `'api' | 'ingest' | 'sourcemaps'`; `createAPIKey`'s input `scope?` (`api.ts:493-498`) widens the same way.
- Settings: the create form gains `<select data-testid="api-key-scope">` with options `api` ("Remote MCP") and `sourcemaps` ("Source-map upload, for CI"); `handleCreateAPIKey` (`:556-575`) passes `scope`; the reveal panel (`:1067-1080`) shows "Set this as `OPSLANE_SOURCEMAP_KEY` in your CI. It never goes in the browser." for sourcemaps keys; each row (`:1086-1106`) shows `<StatusLabel>{{ key.scope }}</StatusLabel>`; the heading at `:1043` becomes "API keys"; the label input gets `data-testid="api-key-label"` and the form `data-testid="api-key-create"`.

- [x] **Step 1: Write the failing tests**

`packages/dashboard/src/components/__tests__/agent-paste-box.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import AgentPasteBox from '../AgentPasteBox.vue';

const stubs = { RouterLink: { template: '<a><slot /></a>' } };

describe('AgentPasteBox', () => {
  it('shows the one-line prompt with a copy button', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    const w = mount(AgentPasteBox, { props: { variant: 'wizard' }, global: { stubs } });
    expect(w.text()).toContain('Paste into your agent');
    expect(w.find('[data-testid="agent-paste-line"]').text()).toBe('Set up https://docs.opslane.com/INSTALL.md');
    await w.find('button').trigger('click');
    expect(write).toHaveBeenCalledWith('Set up https://docs.opslane.com/INSTALL.md');
    expect(w.text()).toContain('The snippet is below');
  });
  it('empty variant links to the wizard instead of pointing at a snippet', () => {
    const w = mount(AgentPasteBox, { global: { stubs } });
    expect(w.text()).toContain('Setup guide');
    expect(w.text()).not.toContain('The snippet is below');
  });
});
```

In `packages/dashboard/src/views/Settings.test.ts`, change the assertion at `:315` to `expect(createAPIKey).toHaveBeenCalledWith(project.id, { label: 'Codex', expires_at: null, scope: 'api' });` and add, in the same describe, using that file's `mountSettings('admin')` helper (`:62`) and the `#settings-api-keys-tab` click (`:290`):

```ts
it('lists key scopes and can mint a sourcemaps key', async () => {
  vi.mocked(listAPIKeys).mockResolvedValue([
    { key_id: 'k1', scope: 'api', label: 'mcp', status: 'active', redacted: 'opslane_ak_k1_…', created_by: null, created_at: '2030-01-01T00:00:00Z', last_used_at: null, expires_at: null, revoked_at: null },
    { key_id: 'k2', scope: 'sourcemaps', label: 'ci', status: 'active', redacted: 'opslane_sk_k2_…', created_by: null, created_at: '2030-01-01T00:00:00Z', last_used_at: null, expires_at: null, revoked_at: null },
  ]);
  vi.mocked(createAPIKey).mockResolvedValue({ key_id: 'k3', token: 'opslane_sk_new', label: 'ci2', scope: 'sourcemaps', expires_at: null });
  const wrapper = await mountSettings('admin');
  await wrapper.get('#settings-api-keys-tab').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('sourcemaps');
  await wrapper.get('[data-testid="api-key-scope"]').setValue('sourcemaps');
  await wrapper.get('[data-testid="api-key-label"]').setValue('ci2');
  await wrapper.get('[data-testid="api-key-create"]').trigger('submit');
  await flushPromises();
  expect(createAPIKey).toHaveBeenCalledWith(expect.any(String), { label: 'ci2', expires_at: null, scope: 'sourcemaps' });
  expect(wrapper.text()).toContain('OPSLANE_SOURCEMAP_KEY');
  wrapper.unmount();
});
```

If `mountSettings` takes different arguments, copy the exact call from the test at `:297-316`.

- [x] **Step 2: Run to verify they fail**

Run: `cd packages/dashboard && npx vitest run src/components/__tests__/agent-paste-box.test.ts src/views/Settings.test.ts`
Expected: FAIL (component missing; no scope select; `scope: 'api'` not passed).

- [x] **Step 3: Implement**

`packages/dashboard/src/components/AgentPasteBox.vue`:

```vue
<script setup lang="ts">
import CopyButton from './CopyButton.vue';

withDefaults(defineProps<{ variant?: 'wizard' | 'empty' }>(), { variant: 'empty' });
const line = 'Set up https://docs.opslane.com/INSTALL.md';
</script>

<template>
  <div class="rounded-lg border border-border bg-surface p-4 text-left" data-testid="agent-paste-box">
    <p class="text-sm font-medium text-text">Paste into your agent</p>
    <p class="mt-1 text-xs text-muted">Claude Code, Codex, Cursor, or any agent with a shell. It installs the SDK, proves the first event, and only asks you to approve.</p>
    <div class="mt-3 flex items-center gap-3 rounded bg-black px-4 py-3 font-mono text-sm text-white">
      <span class="text-muted">&gt;</span>
      <span class="flex-1 truncate" data-testid="agent-paste-line">{{ line }}</span>
      <CopyButton :text="line" />
    </div>
    <p v-if="variant === 'wizard'" class="mt-3 text-xs text-muted">Prefer to do it by hand? The snippet is below.</p>
    <p v-else class="mt-3 text-xs text-muted">Prefer the manual setup? <router-link to="/setup" class="text-accent hover:underline">Setup guide</router-link></p>
  </div>
</template>
```

Mount it: in `SetupWizard.vue` import it and insert `<AgentPasteBox variant="wizard" />` as the first child of the `<div v-else class="mt-6 space-y-5">` at `:466`; in `IssuesList.vue:264-273` and `SessionsList.vue:343` replace the "Setup guide" router-link inside the empty state with `<AgentPasteBox />`.

Types and Settings as listed under Interfaces. Delete `packages/dashboard/public/INSTALL.md`.

- [x] **Step 4: Run the dashboard suite and build**

Run: `cd packages/dashboard && npx vitest run && pnpm --filter @opslane/dashboard build`
Expected: all green, build succeeds.

- [x] **Step 5: Commit**

```bash
git add -A packages/dashboard
git commit -m "feat(dashboard): agent paste box on wizard and empty states; key scopes in Settings

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

---

## Milestone C: SDK

### Task 10: Same-origin `endpoint` for tunnelling

**Files:**
- Modify: `packages/sdk/src/config.ts:84-101`
- Test: `packages/sdk/src/__tests__/config.test.ts` (extend at `:147-170`)

**Files (additional):** `packages/sdk/src/transport.ts:124,222`, `packages/sdk/src/replay.ts:147`, `packages/sdk/src/chunk-upload.ts:42` (add `credentials: 'omit'`); `packages/sdk/src/__tests__/network.test.ts` or a new `src/__tests__/credentials.test.ts`.

**Interfaces:**
- `loadConfig({ endpoint: '/opslane' })` in a browser resolves to `${location.origin}/opslane` (no trailing slash) and stores the absolute string, so `transport.ts:124,222`, `replay.ts:147`, `chunk-upload.ts:42`, and the `startsWith` check in `network.ts:26` keep working unchanged. Outside a browser (no `location`), a path endpoint throws `endpoint path requires a browser origin; pass an absolute URL`.
- Every SDK request passes `credentials: 'omit'`. A same-origin endpoint would otherwise attach the application's own cookies (session cookies included) to requests that a rewrite forwards to Opslane. The runbook's Next.js rewrite additionally never forwards `Cookie` or `Authorization` (Next.js rewrites forward request headers; the recipe therefore routes through a `middleware.ts`/route handler that strips them, or documents that the SDK sends none and the CSP recipe only covers SDK traffic). Test: with an HttpOnly cookie set on the page origin and a mocked `fetch`, every SDK call's `init.credentials` is `'omit'`.

- [x] **Step 1: Write the failing tests**

Add to `packages/sdk/src/__tests__/config.test.ts` next to the endpoint tests, using the same valid-key constant that file already uses:

```ts
it('resolves a same-origin path endpoint against location.origin', () => {
  loadConfig({ apiKey: VALID_KEY, endpoint: '/opslane/' });
  expect(getConfig().endpoint).toBe(`${window.location.origin}/opslane`);
});

it('rejects a path endpoint when there is no browser origin', () => {
  const saved = globalThis.location;
  Object.defineProperty(globalThis, 'location', { value: undefined, configurable: true });
  try {
    expect(() => loadConfig({ apiKey: VALID_KEY, endpoint: '/opslane' })).toThrow('endpoint path requires a browser origin');
  } finally {
    Object.defineProperty(globalThis, 'location', { value: saved, configurable: true });
  }
});

it('still rejects relative non-path strings', () => {
  expect(() => loadConfig({ apiKey: VALID_KEY, endpoint: 'opslane' })).toThrow('endpoint must be a valid http(s) URL');
});
```

- [x] **Step 2: Run to verify it fails**

Run: `cd packages/sdk && npx vitest run src/__tests__/config.test.ts`
Expected: FAIL on the first new test.

- [x] **Step 3: Implement**

Replace `config.ts:87-98` with:

```ts
  let endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  if (endpoint.startsWith('/')) {
    const origin = typeof location !== 'undefined' && location && typeof location.origin === 'string' ? location.origin : '';
    if (!origin || origin === 'null') {
      throw new Error('endpoint path requires a browser origin; pass an absolute URL');
    }
    endpoint = origin + endpoint.replace(/\/+$/, '');
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('endpoint must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('endpoint must be a valid http(s) URL');
  }
```

Leave `:101` storing `endpoint` (now absolute). Update the doc comment on `SdkInitOptions.endpoint` (`config.ts:32`): "Absolute URL of the Opslane server, or a same-origin path such as `/opslane` when your app proxies to Opslane (see Tunnelling in the install guide)."

- [x] **Step 3b: Failing test for `credentials: 'omit'`, then the four call sites**

Add `packages/sdk/src/__tests__/credentials.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadConfig, resetConfig } from '../config';
import { VALID_KEY } from './config.test'; // or duplicate the constant

describe('SDK requests never carry the page cookies', () => {
  beforeEach(() => { resetConfig(); document.cookie = 'app_session=secret'; });
  it('event transport, session init, and chunk upload all pass credentials: omit', async () => {
    const calls: RequestInit[] = [];
    const fetchMock = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => { calls.push(init ?? {}); return new Response('{}', { status: 202 }); });
    vi.stubGlobal('fetch', fetchMock);
    loadConfig({ apiKey: VALID_KEY, endpoint: '/opslane' });
    const transport = await import('../transport');
    const replay = await import('../replay');
    await transport.sendEvents([{ /* minimal event per transport.ts's type */ } as never]);
    await replay.initSession?.(); // call whatever replay.ts:147 exposes that hits /api/v1/sessions/init
    expect(calls.length).toBeGreaterThan(0);
    for (const init of calls) expect(init.credentials).toBe('omit');
  });
});
```

Use the real exported function names from `transport.ts` and `replay.ts` (read the two files; the test names the call sites, not the exports). Then add `credentials: 'omit'` to the `fetch` and `sdkFetch` calls at `transport.ts:124`, `transport.ts:222`, `replay.ts:147`, and `chunk-upload.ts:42`.

- [x] **Step 4: Run the SDK suite**

Run: `cd packages/sdk && npx vitest run && pnpm --filter @opslane/sdk build && pnpm --filter @opslane/sdk check:package`
Expected: PASS, build and package check clean.

- [x] **Step 5: Commit**

```bash
git add packages/sdk/src
git commit -m "feat(sdk): accept a same-origin path as endpoint for proxied delivery; never send page cookies

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

### Task 11: Shared stamping module and the `opslane-sourcemaps` post-build command

**Files:**
- Create: `packages/sdk/src/build/stamp.ts` (lifted from `vite-plugin/index.ts`)
- Modify: `packages/sdk/vite-plugin/index.ts` (import from `../src/build/stamp`)
- Create: `packages/sdk/sourcemaps-cli/index.ts`, `packages/sdk/sourcemaps-cli/main.ts`, `packages/sdk/bin/opslane-sourcemaps.mjs`
- Modify: `packages/sdk/package.json` (`bin`, `files`, `exports`), `packages/sdk/vite.config.ts:14-40` (entry + dts include), `packages/sdk/tsconfig.json` (`include`), `packages/sdk/scripts/check-package.mjs:35-53`
- Test: `packages/sdk/src/__tests__/stamp.test.ts`, `packages/sdk/sourcemaps-cli/__tests__/cli.test.ts` (create)

**Interfaces:**

```ts
// src/build/stamp.ts — everything moved from vite-plugin/index.ts keeps its current signature
export const DEBUG_ID_TRAILER: RegExp;                                        // index.ts:65-66
export function preludeForFormat(format: string | undefined): string | null;  // :794 ('es' → ESM prelude; 'iife'|'umd'|'cjs'|'system' → script prelude; else null)
export function stripMapSuffix(filePath: string): string;                     // :678
export function stripSourceMappingURLDirectives(code: string): string;        // :690
export function unstamp(code: string, debugId: string, format: string | undefined): { code: string; prelude: string } | null; // :713
export class MapTooLargeError extends Error { … }                             // moved with formatBytes
export interface StampInput { code: string; mapSource: string; mapFileName: string; format: string | undefined; projectRoot: string | undefined; outDir: string; maxMapBytes: number }
export interface StampResult { code: string; mapSource: string; debugId: string; contentSha256: string }
export async function stampCodeAndMap(input: StampInput): Promise<StampResult>; // the whole of stampOne (:145-190: byte conversion, size check, strict fingerprint and parsed-map validation, then stamping) with the closure values as inputs; throws Error('unsupported output format') when preludeForFormat returns null; projectRoot stays `string | undefined` because index.ts:107 declares it so and normalizeSources handles undefined on purpose
export function flattenIndexedMap(map: unknown): unknown; // sectioned ("indexed") maps, which Turbopack emits and computeDebugId rejects (src/build/debug-id.ts:264), are flattened first: sections' offsets are applied, sources/sourcesContent/names concatenated, mappings re-encoded; non-indexed maps pass through
// also moved, unexported unless the plugin needs them: preludeInsertion (:818), insertMappingLines (:871), assetBytes (:882), isSourceMapObject (:890), normalizeSources (:896), normalizePath (:951), directoryOf (:977), canonicalFilesystemPath (:983), isAbsolutePath, formatBytes (:1009)

// sourcemaps-cli/index.ts
export interface CliOptions { dir: string; key: string; format: string; keepMaps: boolean; dryRun: boolean; requireKey: boolean; projectRoot: string; logger: (line: string) => void; fetchImpl?: typeof fetch }
export interface CliSummary { stamped: number; uploaded: number; failed: Array<{ fileName: string; reason: string }>; removed: number; skipped: number }
export async function runSourcemapsCli(opts: CliOptions): Promise<CliSummary>
export function parseArgs(argv: string[], env: Record<string, string | undefined>): CliOptions | { error: string } | { skip: string }
```

CLI behaviour: walk `dir` recursively for `*.js`/`*.mjs`/`*.cjs`; a file's map is the `//# sourceMappingURL=` target when present (any relative path is allowed, including `../`, as long as its `realpath` lies inside `dir`'s `realpath`; URLs with a scheme, absolute paths, and anything resolving outside are per-file failures), else the sibling `<file>.map`; files with no map are `skipped`. Indexed maps are flattened before stamping. Files already carrying `//# debugId=` are validated, not trusted: the map on disk is re-fingerprinted (`computeDebugId`) and must equal both the trailer and the map's `debugId`; a match means "already stamped" (upload the map again, the server answers 200 `exists`, then strip and delete as usual), a mismatch is a per-file failure `stale stamp` with no mutation. Every per-artifact failure (unparseable map, oversized map, unsupported map, stale stamp, containment) is recorded under the map's relative path and the run continues with the other files. `fileName` everywhere is the map's path relative to `dir`. Default `format` is `iife`; `--format` accepts `es|iife|umd|cjs|system` and anything else is a usage error at parse time. After a successful upload the JS always loses its `sourceMappingURL` line; the map file is deleted unless `--keep-maps`. `--dry-run` writes nothing. Missing `OPSLANE_SOURCEMAP_KEY` is not an error: the command prints `opslane-sourcemaps: OPSLANE_SOURCEMAP_KEY not set, skipping (maps left untouched)` and exits 0, so a build that has not been given the secret yet still succeeds; `--require-key` turns that into exit 2 for CI that wants to fail loudly. `--project-root <dir>` (default `process.cwd()`) is what `normalizeSources` makes source paths relative to. Exit codes: 0 clean or skipped, 1 any per-file failure, 2 usage. The key is never logged.

- [x] **Step 1: Write the failing stamp test**

`packages/sdk/src/__tests__/stamp.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stampCodeAndMap, unstamp, DEBUG_ID_TRAILER } from '../build/stamp';

const code = 'console.log("hi");\n//# sourceMappingURL=app.js.map\n';
const map = JSON.stringify({ version: 3, file: 'app.js', sources: ['../src/app.ts'], names: [], mappings: 'AAAA' });
const base = { code, mapSource: map, mapFileName: 'app.js.map', projectRoot: '/repo', outDir: '/repo/dist', maxMapBytes: 32 << 20 };

describe('stampCodeAndMap', () => {
  it('stamps a script chunk with a trailer, a prelude, and a debugId in the map', async () => {
    const out = await stampCodeAndMap({ ...base, format: 'iife' });
    expect(out.code.endsWith(`\n//# debugId=${out.debugId}`)).toBe(true);
    expect(out.code).toContain('document.currentScript');
    expect(out.code).toContain(out.debugId);
    expect(JSON.parse(out.mapSource).debugId).toBe(out.debugId);
    expect(out.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(DEBUG_ID_TRAILER.test(out.code)).toBe(true);
  });
  it('is deterministic and unstamps cleanly for es output', async () => {
    const a = await stampCodeAndMap({ ...base, format: 'es' });
    const b = await stampCodeAndMap({ ...base, format: 'es' });
    expect(a.debugId).toBe(b.debugId);
    expect(unstamp(a.code, a.debugId, 'es')?.code).toBe(code);
  });
  it('refuses an unsupported format', async () => {
    await expect(stampCodeAndMap({ ...base, format: 'amd' })).rejects.toThrow('unsupported output format');
  });
  it('flattens an indexed (sectioned) map before stamping', async () => {
    const indexed = JSON.stringify({
      version: 3, file: 'app.js',
      sections: [
        { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['../src/a.ts'], names: [], mappings: 'AAAA' } },
        { offset: { line: 1, column: 0 }, map: { version: 3, sources: ['../src/b.ts'], names: [], mappings: 'AAAA' } },
      ],
    });
    const out = await stampCodeAndMap({ ...base, mapSource: indexed, code: 'a();\nb();\n//# sourceMappingURL=app.js.map\n', format: 'iife' });
    const flat = JSON.parse(out.mapSource);
    expect(flat.sections).toBeUndefined();
    expect(flat.sources).toEqual(expect.arrayContaining([expect.stringContaining('a.ts'), expect.stringContaining('b.ts')]));
    expect(flat.debugId).toBe(out.debugId);
  });
});
```

The flattening test is the specification for `flattenIndexedMap`; implement it with `@jridgewell/trace-mapping` (MIT; `AnyMap` accepts sectioned maps and `encodedMappings`, `sourcesContent`, `names` read back the flat form). Add it as a dependency of `@opslane/sdk` and record the license review in the PR description. Bundle it into `dist/sourcemaps-cli.js` and `dist/vite-plugin.js` (it is not in `rollupOptions.external`).

- [x] **Step 2: Run to verify it fails**

Run: `cd packages/sdk && npx vitest run src/__tests__/stamp.test.ts`
Expected: FAIL, module not found.

- [x] **Step 3: Extract the stamping module**

Create `packages/sdk/src/build/stamp.ts` by moving, unchanged in behaviour, from `vite-plugin/index.ts`: the two prelude constants (`:35-36`), `DEBUG_ID_TRAILER` (`:65-66`), `stripMapSuffix` (`:678`), `stripSourceMappingURLDirectives` (`:690`), `unstamp` (`:713`), `preludeForFormat` (`:794`), `preludeInsertion` (`:818`), `insertMappingLines` (`:871`), `assetBytes` (`:882`), `isSourceMapObject` (`:890`), `normalizeSources` (`:896`), `normalizePath` (`:951`), `directoryOf` (`:977`), `canonicalFilesystemPath` (`:983`), `isAbsolutePath`, `formatBytes` (`:1009`), `MapTooLargeError`, and the whole of `stampOne` (`:145-190`: the raw-byte conversion, size check, strict fingerprint validation, and parsed-map validation at `:150-159` included) as `stampCodeAndMap`, taking `projectRoot` (`string | undefined`), `outDir`, `maxMapBytes`, and `format` from the input; after parsing and before fingerprinting it calls `flattenIndexedMap`; it calls `preludeForFormat(format)` and throws `Error('unsupported output format')` on `null`; it returns `fingerprint.contentSha256` alongside `debugId`. `computeDebugId` stays in `src/build/debug-id.ts`. In `vite-plugin/index.ts`, import these names from `'../src/build/stamp'`, delete the local copies, and reduce `stampOne(code, mapAsset, prelude)` to a wrapper that calls `stampCodeAndMap` with the closure values (the plugin already resolved the prelude from the Rollup format; pass the format string it derived it from, or, if the plugin only holds the prelude string, add an optional `prelude` override to `StampInput` that bypasses `preludeForFormat`). Keep every existing export of `vite-plugin/index.ts`.

Run: `cd packages/sdk && npx vitest run src/__tests__/stamp.test.ts src/__tests__/vite-plugin.test.ts vite-plugin` → PASS (the plugin tests prove the extraction changed nothing).

- [x] **Step 4: Write the failing CLI test**

`packages/sdk/sourcemaps-cli/__tests__/cli.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSourcemapsCli, parseArgs } from '../index';
import { makeSourceMapKey } from '../../vite-plugin/__tests__/helpers';

// makeSourceMapKey builds a syntactically valid opslane_sk_ key whose payload
// points at the given origin. If vite-plugin/__tests__/helpers does not export
// it yet, add it there using the vectors in test-fixtures/sourcemap-key/vectors.json.
const KEY = makeSourceMapKey('https://app.example.test');
const MAP = (file: string, src: string) => JSON.stringify({ version: 3, file, sources: [src], names: [], mappings: 'AAAA' });

// Layout: <project>/src/{a,b}.ts and <project>/dist/chunks/{a,b}/main.js(.map).
// The maps reference sources as ../../../src/x.ts relative to their own
// directory, which is what bundlers emit; normalizeSources makes them
// project-root-relative ("src/a.ts").
let project: string;
let dir: string;
let outside: string;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'opslane-proj-'));
  dir = join(project, 'dist');
  outside = await mkdtemp(join(tmpdir(), 'opslane-outside-'));
  await mkdir(join(project, 'src'), { recursive: true });
  await writeFile(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(project, 'src', 'b.ts'), 'export const b = 2;\n');
  await mkdir(join(dir, 'chunks', 'a'), { recursive: true });
  await mkdir(join(dir, 'chunks', 'b'), { recursive: true });
  await mkdir(join(dir, 'maps'), { recursive: true });
  await writeFile(join(dir, 'chunks', 'a', 'main.js'), 'console.log(1);\n//# sourceMappingURL=main.js.map\n');
  await writeFile(join(dir, 'chunks', 'a', 'main.js.map'), MAP('main.js', '../../../src/a.ts'));
  await writeFile(join(dir, 'chunks', 'b', 'main.js'), 'console.log(2);\n//# sourceMappingURL=../../maps/b.js.map\n'); // parent traversal that stays inside dist
  await writeFile(join(dir, 'maps', 'b.js.map'), MAP('main.js', '../../src/b.ts'));
  await writeFile(join(dir, 'chunks', 'nomap.js'), 'console.log(3);\n');
  await writeFile(join(outside, 'evil.map'), MAP('evil.js', 'x'));
  await writeFile(join(dir, 'chunks', 'escape.js'), `console.log(4);\n//# sourceMappingURL=${join(outside, 'evil.map')}\n`);
  await symlink(join(outside, 'evil.map'), join(dir, 'chunks', 'link.js.map'));
  await writeFile(join(dir, 'chunks', 'link.js'), 'console.log(5);\n//# sourceMappingURL=link.js.map\n');
});
afterEach(async () => { await rm(project, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
const run = (extra: Partial<CliOptions>) => runSourcemapsCli({ dir, key: KEY, format: 'iife', keepMaps: false, dryRun: false, requireKey: false, projectRoot: project, logger: () => undefined, ...extra });

function recorder(status: (fileName: string) => number) {
  const puts: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const id = url.slice(url.lastIndexOf('/') + 1);
    const hasKey = (init?.headers as Record<string, string>)['X-API-Key'] === KEY;
    puts.push(`${init?.method} ${url} key=${hasKey}`);
    const body = String(init?.body ?? '');
    const which = body.includes('a.ts') ? 'chunks/a/main.js.map' : body.includes('b.ts') ? 'maps/b.js.map' : id;
    return new Response(status(which) === 201 ? '{"status":"created"}' : 'nope', { status: status(which) });
  }) as typeof fetch;
  return { puts, fetchImpl };
}

describe('opslane-sourcemaps', () => {
  it('stamps nested chunks, follows in-tree parent traversal, uploads with relative names, strips directives, never logs the key, and refuses escapes', async () => {
    const { puts, fetchImpl } = recorder(() => 201);
    const lines: string[] = [];
    const summary = await run({ logger: (l) => lines.push(l), fetchImpl });
    expect(summary).toMatchObject({ stamped: 2, uploaded: 2, removed: 2, skipped: 1 });
    expect(summary.failed.map((f) => f.fileName).sort()).toEqual(['chunks/escape.js', 'chunks/link.js']);
    expect(summary.failed.every((f) => /outside/.test(f.reason))).toBe(true);
    expect(puts).toHaveLength(2);
    expect(puts[0]).toMatch(/^PUT https:\/\/app\.example\.test\/api\/v1\/sourcemaps\/[0-9a-f-]{36} key=true$/);
    for (const p of ['a', 'b']) {
      const js = await readFile(join(dir, 'chunks', p, 'main.js'), 'utf8');
      expect(js).toMatch(/\/\/# debugId=[0-9a-f-]{36}$/);
      expect(js).not.toContain('sourceMappingURL');
    }
    expect(await readdir(join(dir, 'chunks', 'a'))).not.toContain('main.js.map');
    expect(await readdir(join(dir, 'maps'))).not.toContain('b.js.map');
    expect(lines.join('\n')).not.toContain(KEY);
    expect(lines.join('\n')).toContain('chunks/a/main.js');
  });

  it('keeps the map on a failed upload and finishes the job on the next run without re-stamping', async () => {
    const first = recorder((f) => (f === 'maps/b.js.map' ? 500 : 201));
    const s1 = await run({ fetchImpl: first.fetchImpl });
    expect(s1.failed.map((f) => f.fileName)).toContain('maps/b.js.map');
    expect(await readdir(join(dir, 'maps'))).toContain('b.js.map');
    expect(await readdir(join(dir, 'chunks', 'a'))).not.toContain('main.js.map');
    const stampedB = await readFile(join(dir, 'chunks', 'b', 'main.js'), 'utf8');
    const second = recorder(() => 201);
    const s2 = await run({ fetchImpl: second.fetchImpl });
    expect(s2.stamped).toBe(0);
    expect(s2.uploaded).toBe(1);
    expect(s2.failed.map((f) => f.fileName).sort()).toEqual(['chunks/escape.js', 'chunks/link.js']);
    expect(await readdir(join(dir, 'maps'))).not.toContain('b.js.map');
    const afterB = await readFile(join(dir, 'chunks', 'b', 'main.js'), 'utf8');
    expect(afterB.match(/__OPSLANE_DEBUG_IDS__/g)?.length).toBe(stampedB.match(/__OPSLANE_DEBUG_IDS__/g)?.length); // one prelude, not two
  });

  it('refuses a stale stamp (trailer and map disagree) without touching the files', async () => {
    const { fetchImpl } = recorder(() => 201);
    await run({ keepMaps: true, fetchImpl });
    const mapPath = join(dir, 'maps', 'b.js.map');
    const tampered = { ...JSON.parse(await readFile(mapPath, 'utf8')), names: ['x'] };
    await writeFile(mapPath, JSON.stringify(tampered));
    const before = await readFile(join(dir, 'chunks', 'b', 'main.js'), 'utf8');
    const s = await run({ keepMaps: true, fetchImpl });
    expect(s.failed.find((f) => f.fileName === 'maps/b.js.map')?.reason).toContain('stale');
    expect(await readFile(join(dir, 'chunks', 'b', 'main.js'), 'utf8')).toBe(before);
  });

  it('--keep-maps keeps the map file but still strips the directive after a successful upload', async () => {
    const { fetchImpl } = recorder(() => 201);
    await run({ keepMaps: true, fetchImpl });
    expect(await readdir(join(dir, 'chunks', 'a'))).toContain('main.js.map');
    expect(await readFile(join(dir, 'chunks', 'a', 'main.js'), 'utf8')).not.toContain('sourceMappingURL');
  });

  it('records a per-file failure for an invalid map and still processes the others', async () => {
    await writeFile(join(dir, 'chunks', 'a', 'main.js.map'), JSON.stringify({ version: 3, sources: ['x'], names: [], mappings: 'not-vlq-!!!' }));
    const { fetchImpl } = recorder(() => 201);
    const s = await run({ fetchImpl });
    expect(s.failed.some((f) => f.fileName === 'chunks/a/main.js.map')).toBe(true);
    expect(s.uploaded).toBe(1);
  });

  it('normalizes nested source paths to the project root', async () => {
    const { fetchImpl } = recorder(() => 201);
    const uploaded: string[] = [];
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => { uploaded.push(String(init?.body ?? '')); return fetchImpl(input, init); }) as typeof fetch;
    await run({ keepMaps: true, fetchImpl: spy });
    const all = uploaded.map((b) => (JSON.parse(b).sources as string[])[0]).sort();
    expect(all).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('parseArgs: missing key skips with exit 0 unless --require-key; bad format is a usage error', () => {
    expect(parseArgs(['.next/static'], {})).toMatchObject({ skip: expect.stringContaining('OPSLANE_SOURCEMAP_KEY') });
    expect(parseArgs(['.next/static', '--require-key'], {})).toMatchObject({ error: expect.stringContaining('OPSLANE_SOURCEMAP_KEY') });
    expect(parseArgs(['.next/static', '--format', 'nonsense'], { OPSLANE_SOURCEMAP_KEY: KEY })).toMatchObject({ error: expect.stringContaining('--format') });
    const ok = parseArgs(['.next/static', '--format', 'es', '--keep-maps', '--dry-run', '--project-root', '/p'], { OPSLANE_SOURCEMAP_KEY: KEY });
    expect(ok).toMatchObject({ dir: '.next/static', format: 'es', keepMaps: true, dryRun: true, projectRoot: '/p' });
    expect(parseArgs([], { OPSLANE_SOURCEMAP_KEY: KEY })).toMatchObject({ error: expect.stringContaining('usage') });
  });
});
```

The project-relative expectation (`src/a.ts`) is what `normalizeSources` (`index.ts:896`) produces for the Vite plugin when `projectRoot` is set; if its exact output differs (for example a leading `./`), assert that exact string. Import `CliOptions` as a type from `../index`.

- [x] **Step 5: Run to verify it fails**

Run: `cd packages/sdk && npx vitest run sourcemaps-cli`
Expected: FAIL, module not found.

- [x] **Step 6: Implement the CLI**

`packages/sdk/sourcemaps-cli/index.ts`:

```ts
import { readFile, writeFile, readdir, rm, realpath, stat } from 'node:fs/promises';
import { join, dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { stampCodeAndMap, stripSourceMappingURLDirectives, DEBUG_ID_TRAILER } from '../src/build/stamp';
import { computeDebugId } from '../src/build/debug-id';
import { uploadSourceMaps, type UploadEntry } from '../vite-plugin/upload';
import { parseSourceMapKey } from '../vite-plugin/sk-key';

export interface CliOptions { dir: string; key: string; format: string; keepMaps: boolean; dryRun: boolean; requireKey: boolean; projectRoot: string; logger: (line: string) => void; fetchImpl?: typeof fetch }
export interface CliSummary { stamped: number; uploaded: number; failed: Array<{ fileName: string; reason: string }>; removed: number; skipped: number }

const MAX_MAP_BYTES = 32 << 20;
const JS_FILE = /\.(m|c)?js$/;
const SOURCEMAPPING = /^\/\/# sourceMappingURL=(\S+)\s*$/m;
const FORMATS = new Set(['es', 'iife', 'umd', 'cjs', 'system']);

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && JS_FILE.test(entry.name)) yield full;
  }
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// mapFor resolves the map for a chunk: the sourceMappingURL target when it is
// a relative path (parent segments allowed) whose realpath stays inside the
// build directory, else the sibling .map. Schemes, absolute paths, and
// anything resolving outside (including through a symlink) are errors.
async function mapFor(root: string, jsPath: string, code: string): Promise<{ mapPath: string } | { error: string } | null> {
  const m = SOURCEMAPPING.exec(code);
  let candidate = jsPath + '.map';
  if (m) {
    const target = m[1];
    if (target.startsWith('data:')) return null;
    if (/^[a-z]+:/i.test(target) || isAbsolute(target)) {
      return { error: `sourceMappingURL points outside the build directory: ${target}` };
    }
    candidate = resolve(dirname(jsPath), target);
  }
  try {
    const real = await realpath(candidate);
    if (!insideRoot(root, real)) return { error: `map resolves outside the build directory: ${candidate}` };
    if (!(await stat(real)).isFile()) return null;
    return { mapPath: real };
  } catch {
    return m ? { error: `map not found: ${m[1]}` } : null;
  }
}

export function parseArgs(argv: string[], env: Record<string, string | undefined>): CliOptions | { error: string } | { skip: string } {
  let dir = '';
  let format = 'iife';
  let keepMaps = false;
  let dryRun = false;
  let requireKey = false;
  let projectRoot = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') { const v = argv[++i]; if (!v || !FORMATS.has(v)) return { error: '--format must be one of es, iife, umd, cjs, system' }; format = v; }
    else if (a === '--project-root') { const v = argv[++i]; if (!v) return { error: '--project-root needs a value' }; projectRoot = v; }
    else if (a === '--keep-maps') keepMaps = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--require-key') requireKey = true;
    else if (a.startsWith('--')) return { error: `unknown flag ${a}` };
    else if (!dir) dir = a;
    else return { error: 'only one directory is accepted' };
  }
  if (!dir) return { error: 'usage: opslane-sourcemaps <build-dir> [--format es|iife|umd|cjs|system] [--project-root <dir>] [--keep-maps] [--dry-run] [--require-key]' };
  const key = env['OPSLANE_SOURCEMAP_KEY'] ?? '';
  if (!key) {
    const msg = 'OPSLANE_SOURCEMAP_KEY is not set; mint one under Settings > API keys (scope: sourcemaps)';
    return requireKey ? { error: msg } : { skip: `opslane-sourcemaps: ${msg}, skipping (maps left untouched)` };
  }
  const parsed = parseSourceMapKey(key);
  if (!parsed.ok) return { error: `OPSLANE_SOURCEMAP_KEY is not a valid source-map key (${parsed.reason})` };
  return { dir, key, format, keepMaps, dryRun, requireKey, projectRoot, logger: (l) => console.log(l) };
}

export async function runSourcemapsCli(opts: CliOptions): Promise<CliSummary> {
  const parsedKey = parseSourceMapKey(opts.key);
  if (!parsedKey.ok) throw new Error(`invalid source-map key (${parsedKey.reason})`);
  const root = await realpath(resolve(opts.dir));
  const summary: CliSummary = { stamped: 0, uploaded: 0, failed: [], removed: 0, skipped: 0 };
  type Work = UploadEntry & { jsPath: string; mapPath: string; code: string; dirty: boolean };
  const work: Work[] = [];

  for await (const jsPath of walk(root)) {
    const rel = relative(root, jsPath).split(sep).join('/');
    const code = await readFile(jsPath, 'utf8');
    const found = await mapFor(root, jsPath, code);
    if (found === null) { summary.skipped++; continue; }
    if ('error' in found) { summary.failed.push({ fileName: rel, reason: found.error }); continue; }
    const mapRel = relative(root, found.mapPath).split(sep).join('/');
    const mapSource = await readFile(found.mapPath, 'utf8');
    let parsedMap: { debugId?: string };
    try { parsedMap = JSON.parse(mapSource) as { debugId?: string }; } catch { summary.failed.push({ fileName: mapRel, reason: 'map is not JSON' }); continue; }
    const trailer = DEBUG_ID_TRAILER.exec(code);
    if (trailer || parsedMap.debugId) {
      // Already stamped: validate before trusting. The map on disk must
      // fingerprint to the id in both the trailer and the map, or the pair is
      // stale and we leave both files alone.
      let recomputed = '';
      try { recomputed = (await computeDebugId(new TextEncoder().encode(mapSource))).debugId; } catch (e) { summary.failed.push({ fileName: mapRel, reason: `stale stamp: ${(e as Error).message}` }); continue; }
      if (!trailer || trailer[1] !== parsedMap.debugId || recomputed !== trailer[1]) {
        summary.failed.push({ fileName: mapRel, reason: 'stale stamp: trailer, map debugId, and fingerprint disagree' });
        continue;
      }
      work.push({ debugId: trailer[1], mapSource, fileName: mapRel, jsPath, mapPath: found.mapPath, code, dirty: false });
      continue;
    }
    try {
      const out = await stampCodeAndMap({ code, mapSource, mapFileName: mapRel, format: opts.format, projectRoot: opts.projectRoot, outDir: root, maxMapBytes: MAX_MAP_BYTES });
      summary.stamped++;
      work.push({ debugId: out.debugId, mapSource: out.mapSource, fileName: mapRel, jsPath, mapPath: found.mapPath, code: out.code, dirty: true });
      opts.logger(`stamped ${rel} ${out.debugId}`);
    } catch (e) {
      summary.failed.push({ fileName: mapRel, reason: (e as Error).message });
    }
  }
  if (opts.dryRun) { opts.logger(`dry run: ${summary.stamped} to stamp, ${work.length} to upload, ${summary.skipped} skipped`); return summary; }

  for (const w of work) {
    if (!w.dirty) continue;
    await writeFile(w.jsPath, w.code);
    await writeFile(w.mapPath, w.mapSource);
  }
  const outcome = await uploadSourceMaps(work.map(({ debugId, mapSource, fileName }) => ({ debugId, mapSource, fileName })), { endpoint: parsedKey.url, key: opts.key, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  summary.uploaded = outcome.uploaded;
  summary.failed.push(...outcome.failed);
  const failed = new Set(outcome.failed.map((f) => f.fileName));
  for (const w of work) {
    if (failed.has(w.fileName)) { opts.logger(`kept ${w.fileName}: upload failed`); continue; }
    await writeFile(w.jsPath, stripSourceMappingURLDirectives(w.code)); // the browser must never look for a map we uploaded
    if (!opts.keepMaps) {
      await rm(w.mapPath, { force: true });
      summary.removed++;
    }
  }
  opts.logger(`opslane-sourcemaps: stamped ${summary.stamped}, uploaded ${summary.uploaded}, removed ${summary.removed}, skipped ${summary.skipped}, failed ${summary.failed.length}`);
  return summary;
}
```

`packages/sdk/sourcemaps-cli/main.ts`:

```ts
import { parseArgs, runSourcemapsCli } from './index';

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv, process.env);
  if ('error' in opts) { console.error(opts.error); return 2; }
  if ('skip' in opts) { console.warn(opts.skip); return 0; }
  const summary = await runSourcemapsCli(opts);
  return summary.failed.length ? 1 : 0;
}
```

`packages/sdk/bin/opslane-sourcemaps.mjs`:

```js
#!/usr/bin/env node
import('../dist/sourcemaps-cli.js').then(({ main }) => main(process.argv.slice(2))).then((code) => process.exit(code), (err) => { console.error(err?.message ?? err); process.exit(1); });
```

Package wiring: `package.json` gains `"bin": { "opslane-sourcemaps": "bin/opslane-sourcemaps.mjs" }`, `"bin"` in `files`, and `"./sourcemaps-cli": { "types": "./dist/sourcemaps-cli.d.ts", "import": "./dist/sourcemaps-cli.js" }` in `exports`. `vite.config.ts`: add entry `'sourcemaps-cli': resolve(__dirname, 'sourcemaps-cli/main.ts')`, add `/^node:/` to `rollupOptions.external`, and add `'sourcemaps-cli/**/*.ts'` to the `dts` plugin's `include`. `tsconfig.json`: `"include": ["src", "vite-plugin", "sourcemaps-cli"]`. `scripts/check-package.mjs:35-53`: skip the `node:` import assertion for `dist/sourcemaps-cli.js` only, with a comment that the CLI is Node-only by definition. `chmod +x bin/opslane-sourcemaps.mjs`.

- [x] **Step 7: Run the SDK gate and the bin's exit codes**

```bash
cd packages/sdk && set -o pipefail
npx vitest run && pnpm --filter @opslane/sdk build && pnpm --filter @opslane/sdk check:package
test -f dist/sourcemaps-cli.d.ts
node bin/opslane-sourcemaps.mjs; echo "usage exit=$?"                          # expect 2
OPSLANE_SOURCEMAP_KEY=bad node bin/opslane-sourcemaps.mjs .; echo "badkey exit=$?" # expect 2
env -u OPSLANE_SOURCEMAP_KEY node bin/opslane-sourcemaps.mjs dist; echo "nokey exit=$?"   # expect 0 with the skip warning
env -u OPSLANE_SOURCEMAP_KEY node bin/opslane-sourcemaps.mjs dist --require-key; echo "nokey-required exit=$?"   # expect 2
```

Expected: tests PASS, build emits `dist/sourcemaps-cli.js` and its `.d.ts`, package check clean, exit codes 2, 2, 0, 2.

- [x] **Step 8: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): opslane-sourcemaps post-build command sharing the Vite plugin's stamping

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

---

## Milestone D: runbook and docs

### Task 12: INSTALL.md, SKILL.md, and the user docs

**Files:**
- Create: `docs-site/public/INSTALL.md`, `docs-site/public/SKILL.md` (identical body)
- Modify: `docs/install.md:12-20` (paste line), `:80-105` (Next.js tunnel), new section before `:127` (CSP); `docs/guides/source-maps.md:39-52`; `docs/guides/mcp.md`; `README.md:19-24` and after `:128`
- Test: `pnpm --filter docs-site build` and `pnpm docs:check`

- [x] **Step 1: Write the runbook**

`docs-site/public/INSTALL.md` (copy to `SKILL.md` verbatim). The literal origin `https://app.opslane.com` appears in the file; `BASE` below is only a placeholder for this plan.

````markdown
---
name: opslane-setup
description: Install the Opslane browser SDK, verify the first event, and connect GitHub, Slack, source maps, and MCP.
---

# Install Opslane

Opslane captures production browser errors and friction, investigates them, and opens verified fix PRs.

Read this file with `curl -sL`; summarizing fetch tools drop details. BASE is `https://app.opslane.com`.

Rules for this whole runbook:
- Do everything yourself. Stop only where a step says STOP.
- Secrets never appear in your output and never in a command's arguments (arguments are visible to other processes and to your own transcript; `$(...)` substitution does not help). Write every API response that carries a token to a private file under `.opslane-setup/` (`umask 077`), send the poll token with `curl -H @.opslane-setup/headers` (curl reads header lines from that file), and read other fields with `python3 -c`. Never `cat` those files, never echo a field that ends in `_key` or `_token`. Refer to env vars by name.
- Two tries to fix any failing step, then show the error and stop. Say what is about to happen in one line before opening a link, starting a server, or changing CI.
- If your harness cannot ask questions, treat every optional step as "later" and say so at the end.

## 1. Preflight

Detect the framework from the manifest: Next.js, Vue, React, or plain. Read `git remote get-url origin` and reduce it to `owner/repo` if it is GitHub. In a workspace with several apps, ask which app to instrument.

Search every `package.json` for `@opslane/sdk`. If it is already installed, you still do steps 2 and 3 (a session is required for everything after); in step 4 skip the install and the snippet, but always overwrite the existing `VITE_OPSLANE_API_KEY` / `NEXT_PUBLIC_OPSLANE_API_KEY` value with the approved session's `ingest_key` (an old key may belong to a different project, and events would land there while this session waits) and restart the dev server.

## 2. Register

Say: "I'm registering this setup with Opslane and will give you a link to approve it." Then:

```bash
umask 077; mkdir -p .opslane-setup; grep -qx '.opslane-setup' .gitignore 2>/dev/null || echo '.opslane-setup' >> .gitignore
curl -s -X POST BASE/api/v1/agent/setup -H 'content-type: application/json' \
  -d '{"project_name":"<app name>","agent_name":"<harness> on <hostname>","git_remote":"<owner/repo or empty>","framework_hint":"<nextjs|vue|react|other>"}' \
  -o .opslane-setup/register.json
python3 -c "import json;d=json.load(open('.opslane-setup/register.json'));print(d['status'], d.get('auth_url',''), d.get('expires_at',''))"
```

`poll_id` and `poll_token` stay in that file. Build the header file once and define shell helpers for the rest of the session; never print their output raw:

```bash
PID=$(python3 -c "import json;print(json.load(open('.opslane-setup/register.json'))['poll_id'])")
python3 -c "import json;print('X-Opslane-Poll-Token: '+json.load(open('.opslane-setup/register.json'))['poll_token'])" > .opslane-setup/headers
opslane_poll()  { curl -s "BASE/api/v1/agent/poll/$PID$1" -H @.opslane-setup/headers -o .opslane-setup/approve.json -w '%{http_code}'; }
opslane_state() { curl -s "BASE/api/v1/agent/poll/$PID/state$1" -H @.opslane-setup/headers -o .opslane-setup/state.json -w '%{http_code}'; }
opslane_field() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));v=d.get(sys.argv[2]);print('' if v is None else v)" ".opslane-setup/$1.json" "$2"; }
opslane_post()  { python3 -c "import json,sys;json.dump(dict(a.split('=',1) for a in sys.argv[1:]),open('.opslane-setup/body.json','w'))" "${@:2}"; curl -s -X POST "BASE/api/v1/agent/poll/$PID/$1" -H @.opslane-setup/headers -H 'content-type: application/json' --data-binary @.opslane-setup/body.json -o .opslane-setup/last.json -w '%{http_code}'; }
```

`approve.json` holds the approval and keys; `state.json` holds facts; `opslane_field approve ingest_key` reads the former, `opslane_field state has_events` the latter.

## 3. STOP: approve

Show `auth_url` and say exactly: "Open this link, sign in or create an account, and click Approve. I'll wait." Then wait. Each call holds up to 30 seconds and returns as soon as the status changes; stop on failure or expiry:

```bash
tries=0
while :; do
  code=$(opslane_poll '?wait=30')
  case "$code" in
    200) status=$(opslane_field approve status); approved=$(opslane_field approve approved)
         [ "$approved" = "True" ] && break
         [ "$status" = "failed" ] && { opslane_field approve message; exit 1; } ;;
    404|410) opslane_field approve message; exit 1 ;;            # bad token or expired: never retry
    429) sleep "$(opslane_field approve retry_after || echo 60)" ;;
    *)   tries=$((tries+1)); [ "$tries" -ge 6 ] && { echo "Opslane did not answer (HTTP $code) after 6 tries"; exit 1; }; sleep 10 ;;
  esac
done
```

On `failed`, `expired`, or a bad token, show `message` verbatim and stop. After approval `.opslane-setup/approve.json` holds `ingest_key`, `api_key`, `sourcemap_key`, `project_id`, `dashboard_url`, `issues_url`, `github_connect_url`, the facts, and `next`. Print only `project_name`, `dashboard_url`, and `next`. `status` help: `provisioned` approved and keys ready; `key_ok` keys delivered; `app_reporting` the SDK loaded in a browser. Only `has_events` proves an error arrived.

Report progress as you go (steps `install_sdk` and `mcp` take any status; `github`, `slack`, `sourcemaps`, `first_event` take only `failed` or `skipped` with a short `note`); the body is JSON-encoded by python, so notes may contain quotes or newlines, and a non-204 answer is shown rather than ignored:

```bash
opslane_progress() { c=$(opslane_post progress "step=$1" "status=$2" "note=$3"); [ "$c" = "204" ] || echo "progress report failed: HTTP $c"; }
opslane_progress install_sdk running ""
```

## 4. Install the SDK

Install `@opslane/sdk` with the repo's package manager. Write `ingest_key` from `.opslane-setup/approve.json` into the framework's public env var in a gitignored env file without echoing it, for example `python3 -c "import json;print('VITE_OPSLANE_API_KEY='+json.load(open('.opslane-setup/approve.json'))['ingest_key'])" >> .env.local`. Use `NEXT_PUBLIC_OPSLANE_API_KEY` for Next.js. Tell the user the production value is the same variable, with `environment` set to `production` in their deploy.

**Next.js**: tunnel through your own origin so CSPs and ad blockers do not drop events. In `next.config.*` add `async rewrites() { return [{ source: '/opslane/:path*', destination: 'https://app.opslane.com/:path*' }]; }`. The SDK sends requests with `credentials: 'omit'`, so no application cookie rides along; if the app also has a `middleware.ts`, make sure it does not add `Authorization` or `Cookie` headers to `/opslane/*`. Create `app/opslane-provider.tsx`:

```tsx
'use client';
import { useEffect } from 'react';
import { init } from '@opslane/sdk';
export function OpslaneProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_OPSLANE_API_KEY;
    if (!apiKey) throw new Error('NEXT_PUBLIC_OPSLANE_API_KEY is not set: add it to .env.local and restart the dev server');
    init({ apiKey, endpoint: '/opslane', environment: process.env.NEXT_PUBLIC_OPSLANE_ENVIRONMENT ?? 'development' });
  }, []);
  return <>{children}</>;
}
```

Wrap `{children}` in `app/layout.tsx` with it. The explicit throw matters: `init` itself swallows a configuration error unless debug logging is on, so a missing key would otherwise be invisible.

**Vue 3 (Vite)**:

```ts
import { init, opslaneVuePlugin } from '@opslane/sdk';
init({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY, endpoint: 'BASE', environment: 'development' });
app.use(opslaneVuePlugin);
```

**React (Vite)**: same `init`, then wrap the app in `OpslaneErrorBoundary` from `@opslane/sdk/react`.

**Plain**: call `init` before any other script runs.

If the site sets a Content-Security-Policy and you are not tunnelling, add `BASE` to `connect-src`. If a dev server was already running before the env file was written, restart it; public env vars are inlined at start. Then `opslane_progress install_sdk done "<framework>"`.

## 5. Verify with a real event

Add a temporary button that throws `new Error('opslane-test')` on click, so the error goes through the real `window.onerror` path. Start the dev server.

If you have a browser tool, open the app and click the button yourself. Otherwise STOP and ask: "Open <dev url> and click the red Test Opslane button, then tell me." Then wait for the fact to flip:

```bash
for i in 1 2 3 4; do
  code=$(opslane_state '?wait=30&until=event')
  case "$code" in 404|410) opslane_field state message; exit 1 ;; esac
  [ "$(opslane_field state has_events)" = "True" ] && break
done
```

The task is not done until `has_events` is `True`. If it stays false: check the key from the terminal with `python3 -c "import json;print('X-API-Key: '+json.load(open('.opslane-setup/approve.json'))['ingest_key'])" > .opslane-setup/ingest-header; curl -s -o /dev/null -w '%{http_code}' -X POST BASE/api/v1/ingest/ping -H @.opslane-setup/ingest-header` (204 means the key works), then ask for the browser console output and fix what it shows. Never tell the user to check the dashboard.

When it is true, remove the test button and show `latest_error_group_url` (or `issues_url` if it is empty). If it never flips, `opslane_progress first_event failed "<what the console showed>"` before stopping.

## 6. STOP: GitHub (optional)

Read `github_connected`, `github_installed`, `github_repo`, and `github_connect_url` from the state:
- `github_connected` True: skip.
- `github_installed` True but `github_repo` empty: ask "Opslane's GitHub App is installed on your org. Attach `<owner/repo>`?" On yes, `opslane_post github "repo=<owner/repo>"` and show `.opslane-setup/last.json`'s `error` verbatim on a non-200.
- Not installed: show `github_connect_url` and ask "connect now, or later?" On now: loop `opslane_state '?wait=30'` until `github_installed` is True (up to 10 minutes; the default wait returns on any change), then attach the repo as above, then confirm `github_connected` is True. On later: `opslane_progress github skipped "later"` and continue.

## 7. STOP: Slack (optional)

Ask for a Slack incoming-webhook URL, or later. On a URL, `opslane_post slack "webhook_url=<url>"` and read `.opslane-setup/last.json`. `ok: true` means a test message landed and the digest is enabled. On `ok: false` report `error` verbatim; one retry with a corrected URL, then `opslane_progress slack failed "<error>"` and move on. On later: `opslane_progress slack skipped "later"`.

## 8. Source maps

Add the upload to the production build so stack traces resolve to source. Both recipes are safe to ship before the CI secret exists: without `OPSLANE_SOURCEMAP_KEY` the Vite plugin does nothing and `opslane-sourcemaps` prints a skip line and exits 0, and the Next.js config only generates maps when the key is present, so a deferred secret never publishes maps or breaks a build.
- Vite: add `opslane()` from `@opslane/sdk/vite-plugin` to `plugins` (and `worker.plugins`).
- Next.js: in `next.config.*` set `productionBrowserSourceMaps: Boolean(process.env.OPSLANE_SOURCEMAP_KEY)` and change the build script to `next build && opslane-sourcemaps .next/static`.
- Other bundlers: emit maps only when the key is set and run `opslane-sourcemaps <build-dir>` after the build (`--format es` for ESM output).

The upload needs `OPSLANE_SOURCEMAP_KEY` in the CI environment. STOP and ask where they deploy from.
- GitHub Actions with `gh` authenticated: say "I'll set the repository secret OPSLANE_SOURCEMAP_KEY with `gh secret set` (value from the session file, not shown) and add it to the build step's env. Ok?" On yes: `python3 -c "import json;print(json.load(open('.opslane-setup/approve.json'))['sourcemap_key'])" | gh secret set OPSLANE_SOURCEMAP_KEY -R <owner/repo>`, then add `OPSLANE_SOURCEMAP_KEY: ${{ secrets.OPSLANE_SOURCEMAP_KEY }}` to the `env` of the workflow step that runs the build, and confirm by name only.
- Vercel with `vercel` authenticated: the same with `... | vercel env add OPSLANE_SOURCEMAP_KEY production`.
- Anything else, or a no: say "Create a source-map key under Settings > API keys (scope: sourcemaps) and add its one-time value to your CI as OPSLANE_SOURCEMAP_KEY." Then `opslane_progress sourcemaps skipped "CI secret pending"`.

The server marks this step done after the first upload; do not report it done yourself.

## 9. MCP (optional)

Offer to connect this terminal to Opslane so it can read what breaks in production. On yes, the key goes into an environment variable file, never into a command argument or a committed file:

```bash
umask 077; mkdir -p ~/.opslane
python3 -c "import json;print('export OPSLANE_API_KEY='+json.load(open('.opslane-setup/approve.json'))['api_key'])" > ~/.opslane/env
```

Then tell the user to add `source ~/.opslane/env` to their shell profile, and register the server with an env reference the harness expands at runtime: Claude Code `claude mcp add --transport http opslane BASE/mcp --header 'Authorization: Bearer ${OPSLANE_API_KEY}'` (single quotes: the literal `${OPSLANE_API_KEY}` is stored and expanded by Claude Code when it connects); Codex: add the server to `~/.codex/config.toml` with `bearer_token_env_var = "OPSLANE_API_KEY"`. Then `opslane_progress mcp done ""` or `opslane_progress mcp skipped "<why>"`.

## 10. Finish

```bash
code=$(opslane_post complete)
if [ "$code" = "200" ]; then rm -rf .opslane-setup; else echo "complete failed: HTTP $code"; python3 -c "import json;print(json.load(open('.opslane-setup/last.json')))"; exit 1; fi
```

Only after a 200: say "Opslane is set up. Your first real error will show up in the daily digest." List what was deferred with one line each on how to do it later from Settings. Then stop. On a 422 the first event never arrived; go back to step 5.
````

- [x] **Step 2: User docs and the landing-page handoff**

- `docs/install.md`: after `:12` add "## Let your agent do it" with the one-line paste and two sentences (what it does, what it asks). Replace the Next.js provider snippet (`:84-101`) with the tunnel version from the runbook plus the `rewrites()` block and one sentence on why (CSP and ad blockers). Before `:127` add "## Content-Security-Policy" with the `connect-src` line for non-tunnelled setups. `covers:` already lists `src/config.ts`, so `pnpm docs:check` expects this file to change with Task 10.
- `docs/guides/source-maps.md`: replace `:39-52` with "Get a source-map key" from Settings > API keys (scope `sourcemaps`, shown once), keep `mint-key` as the self-host alternative, and add "## Next.js and other bundlers" with `productionBrowserSourceMaps: true`, `next build && opslane-sourcemaps .next/static`, the `--format es` and `--keep-maps` flags, and exit codes 0/1/2.
- `docs/guides/mcp.md`: one paragraph saying the agent runbook configures the server during onboarding; the manual path stays.
- `README.md`: add the paste line to the nav (`:19-24`) and an "## Add it to your app" block after `:128` with the same line and the manual pointer.
- Landing page: opslane.com is not in this repository. Add to the PR description a "Release checklist" item with this snippet for the marketing site, to be merged the same day: a "Paste into your agent" box containing `Set up https://docs.opslane.com/INSTALL.md` with a copy button, agent logos, and a one-line manual fallback linking to `https://docs.opslane.com/install/`. The release is not done until that box is live.

- [x] **Step 3: Build the docs site and run the drift check**

Run: `pnpm --filter docs-site build && test -f docs-site/dist/INSTALL.md && test -f docs-site/dist/SKILL.md && pnpm docs:check`
Expected: build passes and both files are in `dist/` (Astro copies `public/` verbatim; `llms.txt` already proves the host serves static text), drift check passes.

- [x] **Step 4: Commit**

```bash
git add docs-site/public/INSTALL.md docs-site/public/SKILL.md docs/install.md docs/guides/source-maps.md docs/guides/mcp.md README.md
git commit -m "docs: agent-driven install runbook, tunnel recipe, Next.js source maps

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

---

## Milestone E: end-to-end proof

### Task 13: Live smoke on the compose stack with a real agent

Verification, not TDD. It reproduces the spike rig from spec §6 against the finished code, with the SDK under review rather than the published one.

- [x] **Step 1: Stack first, then the repository gate with skips counted**

```bash
set -o pipefail
export INGESTION_PORT=8202 OPSLANE_POSTGRES_HOST_PORT=5602 OPSLANE_MINIO_HOST_PORT=9202
export INGESTION_URL="http://localhost:$INGESTION_PORT"
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:$OPSLANE_POSTGRES_HOST_PORT/opslane?sslmode=disable"
export MINIO_ENDPOINT="http://localhost:$OPSLANE_MINIO_HOST_PORT"
export REPLAY_STORE_ENDPOINT="$MINIO_ENDPOINT" REPLAY_STORE_PUBLIC_ENDPOINT="$MINIO_ENDPOINT"
export MINIO_ACCESS_KEY=minio MINIO_SECRET_KEY=minio12345 MINIO_BUCKET=opslane-replays
export REPLAY_STORE_ACCESS_KEY=minio REPLAY_STORE_SECRET_KEY=minio12345 REPLAY_STORE_BUCKET=opslane-replays
docker compose -p agentsmoke up -d --build postgres minio ingestion worker
until curl -sf "$INGESTION_URL/health" >/dev/null; do sleep 2; done
pnpm install --frozen-lockfile && pnpm -r build && pnpm test
(cd packages/ingestion && go build ./... && go test -count=1 -json ./... > /tmp/smoke-go.jsonl; grep -c '"Action":"skip"' /tmp/smoke-go.jsonl; grep -c '"Action":"fail"' /tmp/smoke-go.jsonl)
docker compose config --quiet
```

Expected: both greps print 0. (The two `export` lines for the replay endpoints are separate from the `MINIO_ENDPOINT` line on purpose; a single combined `export` would expand the old value.)

- [x] **Step 2: Seed the human**

Seed a projectless org and a user, mint a session cookie the way the spike did (HS256 JWT with the compose `JWT_SECRET`, claims `sub`, `org_id`, `email`, `iat`, `exp`), and keep it for the approve step.

- [x] **Step 3: Serve the runbook locally and pack the SDK**

`cd packages/sdk && pnpm pack --pack-destination /tmp/smoke-sdk` and note the tarball path. Copy `docs-site/public/INSTALL.md` to a scratch directory with `https://app.opslane.com` replaced by `http://localhost:8202` **and** the two install instructions (`Install \`@opslane/sdk\``) replaced by `npm install /tmp/smoke-sdk/opslane-sdk-<version>.tgz`, so the agent installs the SDK under review from the outset; serve it with `python3 -m http.server 8299` from there. After each run, `npm ls @opslane/sdk` in the fixture must show the packed version and `node -e "console.log(require.resolve('@opslane/sdk'))"` must point into `node_modules/@opslane/sdk` from that tarball.

- [x] **Step 4: Two agent runs**

Scaffold two throwaway apps outside the workspace: a bare Vite+Vue app, and a bare Next.js app (`npx create-next-app@latest --ts --app --no-eslint`) whose `middleware.ts` sets a CSP that Next.js dev can run under: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:`. Load the Next.js app once before the run to confirm it hydrates under that policy.

In each, run:

```bash
claude -p "Set up http://localhost:8299/INSTALL.md" --dangerously-skip-permissions --mcp-config <playwright mcp json> --output-format stream-json --verbose > run.jsonl
```

Approve each session from the dashboard approve page in a browser with the minted cookie. Expected for both runs:
- exactly one required human stop (approve), and the agent asks rather than guesses for GitHub, Slack, source maps, MCP (in `-p` mode it reports them as skipped);
- `has_events` flips and the agent shows an issue URL (the worker is up, so `latest_error_group_url` is set);
- the Next.js run sends events through `/opslane/...` on the app's own origin with the CSP unchanged (check the dev server log);
- `grep -cE 'opt_[0-9a-f]{64}|opslane_(pk|ak|sk)_[A-Za-z0-9_-]{20,}' run.jsonl` prints 0 for the transcript, and the `.opslane-setup` directory is gone afterwards;
- the approve page shows all seven rows before approval, and afterwards `approve`, `install_sdk`, and `first_event` done, `mcp` skipped with the agent's note.

- [x] **Step 5: Source-map proof, one key per project, judged by a resolved frame**

The runbook has deleted the poll token by now, so this step uses the dashboard and the database, not the session routes. For each of the two projects the runs created: mint a sourcemaps key from that project's Settings > API keys, export it as `OPSLANE_SOURCEMAP_KEY` in that app only, run `npm run build`, and confirm:
- at least one row in `sourcemap_files` for that `project_id` (`psql "$DATABASE_URL" -c "select count(*) from sourcemap_files where project_id = '<id>'"`);
- for Next.js, `.next/static/chunks` holds no `.map` files, and every chunk that had a map before the command ran (list them first with `find .next/static -name '*.map'`) now ends with `//# debugId=`; chunks that never had a map are untouched;
- correctness, not just presence: serve the production build (`vite preview` / `next start`), trigger the test error once, and check that the stored event resolved to source: `select resolved_file, resolved_line from error_event_resolutions where event_id = (select id from error_events where project_id = '<id>' order by created_at desc limit 1)` shows the original file (`src/App.vue` or `app/opslane-provider.tsx`) and a plausible line, and the issue page shows the original frame. (`sourcemap_files` and `error_event_resolutions` are the live tables; `source_maps` and `stack_trace_resolved` are dead legacy.)

- [x] **Step 6: Record and clean up**

Write the run numbers (turns, seconds, cost, stops) into `docs/research/2026-09-11-agent-driven-onboarding.md` under a new "§7 Release smoke" heading, then `docker compose -p agentsmoke down -v`. Commit the doc update.
