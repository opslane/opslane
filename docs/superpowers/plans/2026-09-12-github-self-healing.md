# GitHub Connection Self-Healing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GitHub App installation that is deleted, suspended, or changed on GitHub no longer strands onboarding: the server notices (webhook or on first use), heals its records, answers with JSON the agent and dashboard can act on, and the runbook finishes the GitHub step and opens a pull request.

**Architecture:** The `github` package classifies GitHub's answers into sentinel errors. A handler-level `githubFailure` type carries status, machine code, message, and extra fields to one writer, replacing every 502 on GitHub paths with 503 or a 4xx that names the fix. `attachGitHubRepo` and `ListGitHubRepos` self-heal on a gone installation by suspending the row and clearing the org pointer in one transaction. `HandleWebhook` gains `installation` and `installation_repositories` branches that keep the same rows current. The runbook's GitHub step becomes a resumable function that branches on the new codes, the finish step reports from recorded state, and a new step commits the setup on a branch and opens a PR.

**Tech Stack:** Go 1.24 (chi, pgx), Vitest + Vue 3 dashboard, Markdown runbook served from `docs-site/public/`.

**Spec:** `docs/superpowers/specs/2026-09-12-github-self-healing-design.md`

**Revision:** 2 (after Codex round 1: 24 findings applied; see the change log at the end).

## Global Constraints

- Every GitHub-path error body keeps the existing shape: `error` is the human sentence, `code` is the machine string (spec §Status codes).
- No handler on a GitHub path may write `http.StatusBadGateway` after this plan (spec R3). The generic identity-provider callback gets a provider-neutral 503 for the same Cloudflare reason.
- `orgs.github_installation_id` is only ever nulled when it equals the installation being retired (spec R1), and the suspend plus the pointer clear happen in one transaction.
- Webhook branches must be idempotent under GitHub redelivery, decide "known installation" by looking the row up, and never touch an installation Opslane has not mapped to an org (spec R2).
- The runbook files `docs-site/public/INSTALL.md` and `docs-site/public/SKILL.md` stay byte-identical (`scripts/check-docs-drift.mjs` enforces it).
- Runbook shell must survive `bash -e`: every `code=$(...)` capture ends in `|| true`, every field read that may be absent ends in `|| true`, and no human wait uses `exit`.
- Runbook secrets rules stand: never commit the env file or `.opslane-setup/`, never put a token in a command argument (spec R6).
- Docs tables are checked against source on every `pnpm test` (`docs:check`); `docs/reference/http-routes.md` must describe any changed status.
- Database tests use a disposable database (`DATABASE_URL` exported); the shared verify database has live sweepers that steal job leases.

---

## File structure

| File | Responsibility after this plan |
|---|---|
| `packages/ingestion/github/app.go` | GitHub REST client. Gains `ErrInstallationGone`, `ErrInstallationSuspended`, `HTMLURL` on `InstallationInfo`. |
| `packages/ingestion/github/app_test.go` | Client tests (existing `roundTripperFunc`, package-level `httpClient` swap). |
| `packages/ingestion/db/installations.go` | Installation writes: `PersistInstallation` (now un-suspends on conflict); new `RetireGitHubInstallation`, `SetGitHubInstallationSuspended`, `ReplaceGitHubInstallationRepos`, `AddGitHubInstallationRepos`, `RemoveGitHubInstallationRepos`. |
| `packages/ingestion/db/installations_test.go` | New. Tests for the writes above (`package db_test`, `testPool`). |
| `packages/ingestion/db/migrations/076_agent_step_pull_request.sql` | New. Widens the `agent_session_steps.step` CHECK to include `pull_request`. |
| `packages/ingestion/db/agent_steps.go` | `AgentStepNames` gains `pull_request`. |
| `packages/ingestion/handler/github_failure.go` | New. `githubFailure` type, classification of client errors, `writeGitHubFailure`. |
| `packages/ingestion/handler/github_failure_test.go` | New. Classification table test. |
| `packages/ingestion/handler/github_settings.go` | `attachGitHubRepo` returns `*githubFailure`; self-heals; adds `add_repo_url`. |
| `packages/ingestion/handler/github_settings_test.go` | Existing rig; 502 expectation becomes 503; new 409 and `add_repo_url` tests. |
| `packages/ingestion/handler/github_oauth.go` | `ListGitHubRepos` and `GetGitHubAppStatus` self-heal and use the writer; callbacks answer 503, never 502. |
| `packages/ingestion/handler/oauth_verify_test.go` | 502 expectation becomes 503. |
| `packages/ingestion/handler/agent_session_routes.go` | `AgentSessionGitHub` uses the writer; progress accepts `pull_request`. |
| `packages/ingestion/handler/webhook.go` | `installation` and `installation_repositories` branches. |
| `packages/ingestion/handler/webhook_test.go` | New webhook branch tests via `sendSignedGitHubEvent`. |
| `packages/dashboard/src/api.ts` | `APIError` parses `code` and extra fields; non-JSON bodies collapse to one line. |
| `packages/dashboard/src/__tests__/api-error.test.ts` | New. |
| `packages/dashboard/src/components/RepoSelector.vue` | Emits `load-error` with the `APIError` so parents can react. |
| `packages/dashboard/src/views/Settings.vue`, `SetupWizard.vue` | Render `add_repo_url`; reload app status on `github_installation_gone`. |
| `packages/dashboard/src/views/AgentApprove.vue`, `types/api.ts` | Checklist gains `pull_request`. |
| `docs-site/public/INSTALL.md`, `docs-site/public/SKILL.md` | Preflight snapshot, rules, step 6 rewrite, new step 10 (pull request), Finish becomes 11 with a recorded summary. |
| `docs/reference/http-routes.md`, `docs/guides/github-app.md` | Status changes; webhook events list. |

---

### Task 1: Classify GitHub installation errors in the client

**Files:**
- Modify: `packages/ingestion/github/app.go:93-120` (`GetInstallationToken`), `:294-333` (`InstallationInfo`, `VerifyInstallation`)
- Test: `packages/ingestion/github/app_test.go`

**Interfaces:**
- Produces: `var ErrInstallationGone = errors.New("github installation no longer exists")`, `var ErrInstallationSuspended = errors.New("github installation is suspended")`. `GetInstallationToken` wraps them with `%w` on 404 and on 403 whose body contains `suspended`. `VerifyInstallation` wraps `ErrInstallationGone` on 404. `InstallationInfo` gains `HTMLURL string \`json:"html_url"\`` (the only new field; `target_type` is not needed because `html_url` already points at the right settings page).

- [ ] **Step 1: Write the failing tests**

Append to `packages/ingestion/github/app_test.go`:

```go
func TestGetInstallationToken_ClassifiesGoneAndSuspended(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"deleted installation", http.StatusNotFound, `{"message":"Not Found"}`, ErrInstallationGone},
		{"suspended installation", http.StatusForbidden, `{"message":"This installation has been suspended"}`, ErrInstallationSuspended},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			orig := httpClient
			httpClient = &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: tc.status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}
			defer func() { httpClient = orig }()
			_, err := GetInstallationToken("jwt", 42)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestGetInstallationToken_OtherErrorsAreNotClassified(t *testing.T) {
	orig := httpClient
	httpClient = &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusBadGateway, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`upstream`))}, nil
	})}
	defer func() { httpClient = orig }()
	_, err := GetInstallationToken("jwt", 42)
	if err == nil || errors.Is(err, ErrInstallationGone) || errors.Is(err, ErrInstallationSuspended) {
		t.Fatalf("502 must stay a generic error, got %v", err)
	}
}

func TestVerifyInstallation_ReturnsHTMLURLAndGone(t *testing.T) {
	orig := httpClient
	httpClient = &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/app/installations/7" {
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(
				`{"id":7,"account":{"login":"acme","id":9},"html_url":"https://github.com/organizations/acme/settings/installations/7"}`))}, nil
		}
		return &http.Response{StatusCode: http.StatusNotFound, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}
	defer func() { httpClient = orig }()
	info, err := VerifyInstallation("jwt", 7)
	if err != nil || info.HTMLURL != "https://github.com/organizations/acme/settings/installations/7" {
		t.Fatalf("info=%+v err=%v", info, err)
	}
	if _, err := VerifyInstallation("jwt", 8); !errors.Is(err, ErrInstallationGone) {
		t.Fatalf("404 must be ErrInstallationGone, got %v", err)
	}
}
```

Add `"errors"` to the test file imports if missing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ingestion && go test ./github -run 'TestGetInstallationToken_|TestVerifyInstallation_' -v`
Expected: compile error `undefined: ErrInstallationGone`.

- [ ] **Step 3: Implement the sentinels and classification**

In `packages/ingestion/github/app.go`, add after the imports:

```go
var (
	// ErrInstallationGone means GitHub no longer has this installation: it was
	// uninstalled, or recreated under a new ID.
	ErrInstallationGone = errors.New("github installation no longer exists")
	// ErrInstallationSuspended means the installation exists but GitHub refuses
	// tokens for it until it is unsuspended.
	ErrInstallationSuspended = errors.New("github installation is suspended")
)
```

Replace the error branch in `GetInstallationToken`:

```go
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		switch {
		case resp.StatusCode == http.StatusNotFound:
			return nil, fmt.Errorf("%w: installation %d: %s", ErrInstallationGone, installationID, string(body))
		case resp.StatusCode == http.StatusForbidden && strings.Contains(strings.ToLower(string(body)), "suspended"):
			return nil, fmt.Errorf("%w: installation %d: %s", ErrInstallationSuspended, installationID, string(body))
		}
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}
```

Extend `InstallationInfo` and the 404 branch of `VerifyInstallation`:

```go
type InstallationInfo struct {
	ID      int64 `json:"id"`
	Account struct {
		Login string `json:"login"`
		ID    int64  `json:"id"`
	} `json:"account"`
	// HTMLURL is the GitHub page where a human edits this installation's
	// repository access. Users get /settings/installations/{id}; organizations
	// get /organizations/{login}/settings/installations/{id}.
	HTMLURL string `json:"html_url"`
}
```

```go
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%w: installation %d", ErrInstallationGone, installationID)
	}
```

Add `"errors"` and `"strings"` to the imports if not present.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/ingestion && go test ./github -count=1`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/github/app.go packages/ingestion/github/app_test.go
git commit -m "feat(github): classify gone and suspended installations, expose the installation page URL"
```

---

### Task 2: Installation write helpers in `db`

**Files:**
- Modify: `packages/ingestion/db/installations.go` (the `ON CONFLICT` clause at lines 62-72, plus new functions)
- Create: `packages/ingestion/db/installations_test.go`

**Interfaces:**
- Produces:
  - `func (q *Queries) RetireGitHubInstallation(ctx context.Context, installationID int64, orgID string) (bool, error)` — in one transaction: sets `suspended = true` on the row if it exists, and nulls `orgs.github_installation_id` where it equals `installationID` (restricted to `orgID` when non-empty, any org when empty). Returns true when either write changed a row. Idempotent.
  - `func (q *Queries) SetGitHubInstallationSuspended(ctx context.Context, installationID int64, suspended bool) (bool, error)` — flips the flag; returns whether a row existed.
  - `func (q *Queries) ReplaceGitHubInstallationRepos(ctx context.Context, installationID int64, repos []string) (bool, error)`
  - `func (q *Queries) AddGitHubInstallationRepos(ctx context.Context, installationID int64, repos []string) (bool, error)` — set union; incoming duplicates collapsed; existing order preserved.
  - `func (q *Queries) RemoveGitHubInstallationRepos(ctx context.Context, installationID int64, repos []string) (bool, error)`
  - `PersistInstallation` now sets `suspended = false` on conflict, so reconnecting a retired installation reactivates it.

- [ ] **Step 1: Write the failing tests**

Create `packages/ingestion/db/installations_test.go`:

```go
package db_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func seedInstallation(t *testing.T, q *db.Queries, repos []string) (orgID string, installationID int64) {
	t.Helper()
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "inst-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	installationID = time.Now().UnixNano()
	reposJSON, _ := json.Marshal(repos)
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, $3)`, installationID, org.ID, reposJSON); err != nil {
		t.Fatal(err)
	}
	if err := q.SetOrgGitHubInstallation(ctx, org.ID, installationID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = q.Pool().Exec(context.Background(), `DELETE FROM github_app_installations WHERE org_id = $1`, org.ID)
		_, _ = q.Pool().Exec(context.Background(), `DELETE FROM orgs WHERE id = $1`, org.ID)
	})
	return org.ID, installationID
}

func installationRepos(t *testing.T, q *db.Queries, installationID int64) []string {
	t.Helper()
	var raw []byte
	if err := q.Pool().QueryRow(context.Background(),
		`SELECT repos FROM github_app_installations WHERE installation_id = $1`, installationID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var repos []string
	if err := json.Unmarshal(raw, &repos); err != nil {
		t.Fatal(err)
	}
	return repos
}

func TestRetireGitHubInstallation_SuspendsAndClearsMatchingOrgPointer(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, installationID := seedInstallation(t, q, []string{"acme/web"})

	applied, err := q.RetireGitHubInstallation(ctx, installationID, orgID)
	if err != nil || !applied {
		t.Fatalf("applied=%v err=%v", applied, err)
	}
	if active, _ := q.OrgHasActiveGitHubInstallation(ctx, orgID); active {
		t.Fatal("installation must read inactive")
	}
	if pointer, _ := q.GetOrgGitHubInstallation(ctx, orgID); pointer != 0 {
		t.Fatalf("org pointer must be cleared: %d", pointer)
	}
	// Idempotent: a second retire changes nothing but still succeeds.
	if applied, err := q.RetireGitHubInstallation(ctx, installationID, orgID); err != nil || applied {
		t.Fatalf("second retire: applied=%v err=%v", applied, err)
	}
	// Unknown id: nothing to do, no error.
	if applied, err := q.RetireGitHubInstallation(ctx, installationID+1, ""); err != nil || applied {
		t.Fatalf("unknown retire: applied=%v err=%v", applied, err)
	}
}

func TestRetireGitHubInstallation_LegacyPointerWithoutRow(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "legacy-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = q.Pool().Exec(context.Background(), `DELETE FROM orgs WHERE id = $1`, org.ID) })
	legacyID := time.Now().UnixNano()
	if err := q.SetOrgGitHubInstallation(ctx, org.ID, legacyID); err != nil {
		t.Fatal(err)
	}
	// On-use healing knows the org, so the pointer is cleared even with no rich row.
	if applied, err := q.RetireGitHubInstallation(ctx, legacyID, org.ID); err != nil || !applied {
		t.Fatalf("legacy retire: applied=%v err=%v", applied, err)
	}
	if pointer, _ := q.GetOrgGitHubInstallation(ctx, org.ID); pointer != 0 {
		t.Fatalf("legacy pointer must be cleared: %d", pointer)
	}
}

func TestRetireGitHubInstallation_LeavesOtherPointerAlone(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, first := seedInstallation(t, q, []string{"acme/web"})
	second := first + 1
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '["acme/api"]')`, second, orgID); err != nil {
		t.Fatal(err)
	}
	if err := q.SetOrgGitHubInstallation(ctx, orgID, second); err != nil {
		t.Fatal(err)
	}
	if _, err := q.RetireGitHubInstallation(ctx, first, ""); err != nil {
		t.Fatal(err)
	}
	if pointer, _ := q.GetOrgGitHubInstallation(ctx, orgID); pointer != second {
		t.Fatalf("pointer at another installation must survive: %d", pointer)
	}
}

func TestPersistInstallation_ReconnectUnsuspends(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, installationID := seedInstallation(t, q, []string{"acme/web"})
	if _, err := q.RetireGitHubInstallation(ctx, installationID, orgID); err != nil {
		t.Fatal(err)
	}
	tx, err := q.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := q.PersistInstallation(ctx, tx, db.PersistInstallationParams{
		InstallationID: installationID, GitHubOrgName: "acme", GitHubOrgID: 1, OrgID: orgID,
		Repos: []db.InstallationRepo{{FullName: "acme/web", DefaultBranch: "main"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if active, _ := q.OrgHasActiveGitHubInstallation(ctx, orgID); !active {
		t.Fatal("reconnecting the same installation must reactivate it")
	}
}

func TestGitHubInstallationRepoWrites(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	_, installationID := seedInstallation(t, q, []string{"acme/web"})

	if ok, err := q.AddGitHubInstallationRepos(ctx, installationID, []string{"acme/api", "acme/web", "acme/api"}); err != nil || !ok {
		t.Fatalf("add: %v %v", ok, err)
	}
	if got := installationRepos(t, q, installationID); len(got) != 2 || got[0] != "acme/web" || got[1] != "acme/api" {
		t.Fatalf("after add (duplicates collapsed): %v", got)
	}
	if ok, err := q.RemoveGitHubInstallationRepos(ctx, installationID, []string{"acme/web", "acme/missing"}); err != nil || !ok {
		t.Fatalf("remove: %v %v", ok, err)
	}
	if got := installationRepos(t, q, installationID); len(got) != 1 || got[0] != "acme/api" {
		t.Fatalf("after remove: %v", got)
	}
	if ok, err := q.ReplaceGitHubInstallationRepos(ctx, installationID, []string{"acme/one", "acme/two"}); err != nil || !ok {
		t.Fatalf("replace: %v %v", ok, err)
	}
	if got := installationRepos(t, q, installationID); len(got) != 2 || got[0] != "acme/one" {
		t.Fatalf("after replace: %v", got)
	}
	if ok, err := q.ReplaceGitHubInstallationRepos(ctx, installationID+1, []string{"x/y"}); err != nil || ok {
		t.Fatalf("unknown installation must report false: %v %v", ok, err)
	}
	if ok, err := q.SetGitHubInstallationSuspended(ctx, installationID, true); err != nil || !ok {
		t.Fatalf("suspend: %v %v", ok, err)
	}
	if ok, err := q.SetGitHubInstallationSuspended(ctx, installationID, false); err != nil || !ok {
		t.Fatalf("unsuspend: %v %v", ok, err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ingestion && go test ./db -run 'TestRetireGitHubInstallation|TestPersistInstallation_Reconnect|TestGitHubInstallationRepoWrites' -v`
Expected: compile error `q.RetireGitHubInstallation undefined`.

- [ ] **Step 3: Implement the helpers**

In `PersistInstallation`, change the conflict clause to:

```go
		 ON CONFLICT (installation_id) DO UPDATE
		 SET github_org_name = EXCLUDED.github_org_name,
		     github_org_id = EXCLUDED.github_org_id,
		     repos = EXCLUDED.repos,
		     suspended = false,
		     updated_at = now()`,
```

Append to `packages/ingestion/db/installations.go`:

```go
// RetireGitHubInstallation records that GitHub no longer honours an
// installation. In one transaction it suspends the rich row (if any) and
// clears the legacy org pointer where it equals installationID, limited to
// orgID when the caller knows it. Both writes are idempotent so a webhook
// redelivery and an on-use discovery can race safely. Returns true when
// anything changed.
func (q *Queries) RetireGitHubInstallation(ctx context.Context, installationID int64, orgID string) (bool, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin retire installation: %w", err)
	}
	defer tx.Rollback(ctx)
	rowTag, err := tx.Exec(ctx,
		`UPDATE github_app_installations SET suspended = true, updated_at = now()
		 WHERE installation_id = $1 AND NOT suspended`, installationID)
	if err != nil {
		return false, fmt.Errorf("retire github installation: %w", err)
	}
	orgTag, err := tx.Exec(ctx,
		`UPDATE orgs SET github_installation_id = NULL
		 WHERE github_installation_id = $1 AND ($2 = '' OR id = $2::uuid)`, installationID, orgID)
	if err != nil {
		return false, fmt.Errorf("clear org github installation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit retire installation: %w", err)
	}
	return rowTag.RowsAffected()+orgTag.RowsAffected() > 0, nil
}

// SetGitHubInstallationSuspended mirrors GitHub's suspend/unsuspend state.
func (q *Queries) SetGitHubInstallationSuspended(ctx context.Context, installationID int64, suspended bool) (bool, error) {
	tag, err := q.pool.Exec(ctx,
		`UPDATE github_app_installations SET suspended = $2, updated_at = now() WHERE installation_id = $1`,
		installationID, suspended)
	if err != nil {
		return false, fmt.Errorf("set github installation suspended: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// ReplaceGitHubInstallationRepos overwrites the repo list, the shape GitHub's
// installation.created payload carries.
func (q *Queries) ReplaceGitHubInstallationRepos(ctx context.Context, installationID int64, repos []string) (bool, error) {
	reposJSON, err := json.Marshal(dedupeRepoNames(repos))
	if err != nil {
		return false, fmt.Errorf("encode installation repos: %w", err)
	}
	tag, err := q.pool.Exec(ctx,
		`UPDATE github_app_installations SET repos = $2, updated_at = now() WHERE installation_id = $1`,
		installationID, reposJSON)
	if err != nil {
		return false, fmt.Errorf("replace github installation repos: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// AddGitHubInstallationRepos appends names not already present, keeping the
// existing order and collapsing duplicates in the input.
func (q *Queries) AddGitHubInstallationRepos(ctx context.Context, installationID int64, repos []string) (bool, error) {
	reposJSON, err := json.Marshal(dedupeRepoNames(repos))
	if err != nil {
		return false, fmt.Errorf("encode installation repos: %w", err)
	}
	tag, err := q.pool.Exec(ctx,
		`UPDATE github_app_installations i
		 SET repos = (
		   SELECT COALESCE(jsonb_agg(name ORDER BY ord), '[]'::jsonb)
		   FROM (
		     SELECT name, ord FROM jsonb_array_elements_text(i.repos) WITH ORDINALITY AS e(name, ord)
		     UNION ALL
		     SELECT name, 1000000 + ord FROM jsonb_array_elements_text($2::jsonb) WITH ORDINALITY AS n(name, ord)
		       WHERE NOT i.repos ? name
		   ) merged
		 ), updated_at = now()
		 WHERE i.installation_id = $1`,
		installationID, reposJSON)
	if err != nil {
		return false, fmt.Errorf("add github installation repos: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// RemoveGitHubInstallationRepos drops names; unknown names are ignored.
func (q *Queries) RemoveGitHubInstallationRepos(ctx context.Context, installationID int64, repos []string) (bool, error) {
	reposJSON, err := json.Marshal(dedupeRepoNames(repos))
	if err != nil {
		return false, fmt.Errorf("encode installation repos: %w", err)
	}
	tag, err := q.pool.Exec(ctx,
		`UPDATE github_app_installations i
		 SET repos = (
		   SELECT COALESCE(jsonb_agg(name ORDER BY ord), '[]'::jsonb)
		   FROM jsonb_array_elements_text(i.repos) WITH ORDINALITY AS e(name, ord)
		   WHERE NOT ($2::jsonb ? name)
		 ), updated_at = now()
		 WHERE i.installation_id = $1`,
		installationID, reposJSON)
	if err != nil {
		return false, fmt.Errorf("remove github installation repos: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// dedupeRepoNames keeps first occurrences, drops empties, never returns nil.
func dedupeRepoNames(names []string) []string {
	out := make([]string, 0, len(names))
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		if name == "" {
			continue
		}
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out
}
```

`encoding/json` and `fmt` are already imported in this file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/ingestion && go test ./db -run 'TestRetireGitHubInstallation|TestPersistInstallation|TestGitHubInstallationRepoWrites' -count=1`
Expected: `ok` (the existing `TestPersistInstallation*` tests still pass).

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/installations.go packages/ingestion/db/installations_test.go
git commit -m "feat(db): retire, suspend, edit, and reactivate GitHub App installation records"
```

---

### Task 3: One failure type and writer for GitHub paths

**Files:**
- Create: `packages/ingestion/handler/github_failure.go`
- Create: `packages/ingestion/handler/github_failure_test.go`

**Interfaces:**
- Produces:

```go
type githubFailure struct {
	Status  int
	Code    string            // machine string from the spec table
	Message string            // human sentence
	Extra   map[string]string // add_repo_url, github_connect_url
}
func (f *githubFailure) Error() string
func classifyGitHubError(err error) *githubFailure   // gone/suspended → 409 github_installation_gone; anything else → 503 github_unreachable
func writeGitHubFailure(w http.ResponseWriter, f *githubFailure)
```

- [ ] **Step 1: Write the failing test**

Create `packages/ingestion/handler/github_failure_test.go`:

```go
package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	gh "github.com/opslane/opslane/packages/ingestion/github"
)

func TestClassifyGitHubError(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{fmt.Errorf("wrap: %w", gh.ErrInstallationGone), http.StatusConflict, "github_installation_gone"},
		{fmt.Errorf("wrap: %w", gh.ErrInstallationSuspended), http.StatusConflict, "github_installation_gone"},
		{errors.New("dial tcp: i/o timeout"), http.StatusServiceUnavailable, "github_unreachable"},
		{errors.New("GitHub API error (status 502): upstream"), http.StatusServiceUnavailable, "github_unreachable"},
	}
	for _, tc := range cases {
		f := classifyGitHubError(tc.err)
		if f.Status != tc.status || f.Code != tc.code {
			t.Fatalf("%v → %d %s, want %d %s", tc.err, f.Status, f.Code, tc.status, tc.code)
		}
	}
}

func TestWriteGitHubFailure_ShapeAndRetryAfter(t *testing.T) {
	rec := httptest.NewRecorder()
	writeGitHubFailure(rec, &githubFailure{
		Status: http.StatusBadRequest, Code: "repo_not_in_installation",
		Message: "the Opslane GitHub App cannot see acme/web",
		Extra:   map[string]string{"add_repo_url": "https://github.com/settings/installations/7", "empty": ""},
	})
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusBadRequest || body["error"] != "the Opslane GitHub App cannot see acme/web" ||
		body["code"] != "repo_not_in_installation" || body["add_repo_url"] != "https://github.com/settings/installations/7" {
		t.Fatalf("code=%d body=%v", rec.Code, body)
	}
	if _, present := body["empty"]; present {
		t.Fatal("empty extras must be omitted")
	}
	if rec.Header().Get("Content-Type") != "application/json" || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("headers: %v", rec.Header())
	}

	rec = httptest.NewRecorder()
	writeGitHubFailure(rec, classifyGitHubError(errors.New("boom")))
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "10" {
		t.Fatalf("unreachable must be 503 with Retry-After: %d %v", rec.Code, rec.Header())
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/ingestion && go test ./handler -run 'TestClassifyGitHubError|TestWriteGitHubFailure' -v`
Expected: compile error `undefined: classifyGitHubError`.

- [ ] **Step 3: Implement**

Create `packages/ingestion/handler/github_failure.go`:

```go
package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	gh "github.com/opslane/opslane/packages/ingestion/github"
)

// githubFailure is the one shape every GitHub-backed route answers with when
// GitHub, not the caller, is the reason. Status is never 502: Cloudflare swaps
// an origin 502 for its own HTML page, which is what the agent and the
// dashboard saw on 2026-09-12. `error` stays the human sentence and `code`
// the machine string, matching writeJSONErrorCode.
type githubFailure struct {
	Status  int
	Code    string
	Message string
	Extra   map[string]string
}

func (f *githubFailure) Error() string { return f.Message }

// classifyGitHubError maps a client error to a response. A gone or suspended
// installation is the caller's problem to fix (reinstall), so it is a 409
// rather than a retryable 503.
func classifyGitHubError(err error) *githubFailure {
	if errors.Is(err, gh.ErrInstallationGone) || errors.Is(err, gh.ErrInstallationSuspended) {
		return &githubFailure{
			Status:  http.StatusConflict,
			Code:    "github_installation_gone",
			Message: "the Opslane GitHub App installation was removed or suspended on GitHub; install it again from Settings",
		}
	}
	return &githubFailure{
		Status:  http.StatusServiceUnavailable,
		Code:    "github_unreachable",
		Message: "could not reach GitHub, please retry",
	}
}

func writeGitHubFailure(w http.ResponseWriter, f *githubFailure) {
	body := map[string]string{"error": f.Message, "code": f.Code}
	for k, v := range f.Extra {
		if v != "" {
			body[k] = v
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if f.Status == http.StatusServiceUnavailable {
		w.Header().Set("Retry-After", "10")
	}
	w.WriteHeader(f.Status)
	_ = json.NewEncoder(w).Encode(body)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/ingestion && go test ./handler -run 'TestClassifyGitHubError|TestWriteGitHubFailure' -count=1`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/github_failure.go packages/ingestion/handler/github_failure_test.go
git commit -m "feat(handler): one failure shape for GitHub-backed routes, never a 502"
```

---

### Task 4: `attachGitHubRepo` self-heals and names the add-repo page

**Files:**
- Modify: `packages/ingestion/handler/github_settings.go:106-175` (`attachGitHubRepo`), the caller at `:51` (`SetGitHubConfig`), and `packages/ingestion/handler/agent_session_routes.go:249-253` (`AgentSessionGitHub`)
- Test: `packages/ingestion/handler/github_settings_test.go`

**Interfaces:**
- Consumes: Task 1 sentinels and `InstallationInfo.HTMLURL`; Task 2 `RetireGitHubInstallation`; Task 3 `githubFailure`, `classifyGitHubError`, `writeGitHubFailure`.
- Produces: `func (d *Dependencies) attachGitHubRepo(ctx context.Context, orgID, projectID, repoName, connectURL string) (canonical string, failure *githubFailure)` and `func (d *Dependencies) githubTokenFailure(ctx context.Context, err error, installationID int64, orgID, connectURL string) *githubFailure`. `connectURL` is the org's GitHub settings page; it is carried on `github_not_installed` and `github_installation_gone` failures.

- [ ] **Step 1: Update and add tests**

In `packages/ingestion/handler/github_settings_test.go`:

Rename `TestSetGitHubConfigReturnsBadGatewayWhenGitHubIsUnreachable` to `TestSetGitHubConfigReturnsServiceUnavailableWhenGitHubIsUnreachable` and replace its assertion:

```go
	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("Retry-After") != "10" {
		t.Fatalf("code=%d, want 503 with Retry-After; body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"code":"github_unreachable"`) {
		t.Fatalf("body=%s", recorder.Body.String())
	}
```

Add a fake client and three tests:

```go
func githubGoneOrMissingClient(installationID int64, tokenStatus int, reposJSON, htmlURL string) *http.Client {
	return &http.Client{Transport: handlerRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		respond := func(status int, body string) (*http.Response, error) {
			return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
		}
		switch {
		case req.Method == http.MethodPost && req.URL.Path == fmt.Sprintf("/app/installations/%d/access_tokens", installationID):
			if tokenStatus != http.StatusCreated {
				return respond(tokenStatus, `{"message":"Not Found"}`)
			}
			return respond(http.StatusCreated, `{"token":"installation-token","expires_at":"2099-01-01T00:00:00Z"}`)
		case req.Method == http.MethodGet && req.URL.Path == fmt.Sprintf("/app/installations/%d", installationID):
			return respond(http.StatusOK, fmt.Sprintf(`{"id":%d,"account":{"login":"acme","id":1},"html_url":%q}`, installationID, htmlURL))
		case req.Method == http.MethodGet && req.URL.Path == "/installation/repositories":
			return respond(http.StatusOK, reposJSON)
		default:
			return respond(http.StatusNotFound, `{}`)
		}
	})}
}

func TestSetGitHubConfigRetiresGoneInstallation(t *testing.T) {
	deps, q, orgID, projectID, installationID := setGitHubConfigFixture(t)
	ctx := context.Background()
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '["owner/repo"]')`, installationID, orgID); err != nil {
		t.Fatal(err)
	}
	restore := gh.OverrideHTTPClientForTests(githubGoneOrMissingClient(installationID, http.StatusNotFound, `{"repositories":[]}`, ""))
	defer restore()

	recorder := httptest.NewRecorder()
	deps.SetGitHubConfig(recorder, newSetGitHubConfigRequest(orgID, projectID, "owner/repo"))
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"github_installation_gone"`) ||
		!strings.Contains(recorder.Body.String(), `"github_connect_url"`) {
		t.Fatalf("code=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if pointer, _ := q.GetOrgGitHubInstallation(ctx, orgID); pointer != 0 {
		t.Fatalf("org pointer must be cleared after a gone installation: %d", pointer)
	}
	if active, _ := q.OrgHasActiveGitHubInstallation(ctx, orgID); active {
		t.Fatal("installation must read inactive")
	}
	// A second attempt now reads "not installed", not a retry loop.
	recorder = httptest.NewRecorder()
	deps.SetGitHubConfig(recorder, newSetGitHubConfigRequest(orgID, projectID, "owner/repo"))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"github_not_installed"`) ||
		!strings.Contains(recorder.Body.String(), `"github_connect_url"`) {
		t.Fatalf("second attempt: code=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestSetGitHubConfigLegacyPointerWithoutRowIsAlsoRetired(t *testing.T) {
	// setGitHubConfigFixture sets the org pointer without a rich row: the
	// pre-2026-08 shape. A gone installation must still clear it.
	deps, q, orgID, projectID, installationID := setGitHubConfigFixture(t)
	restore := gh.OverrideHTTPClientForTests(githubGoneOrMissingClient(installationID, http.StatusNotFound, `{"repositories":[]}`, ""))
	defer restore()
	recorder := httptest.NewRecorder()
	deps.SetGitHubConfig(recorder, newSetGitHubConfigRequest(orgID, projectID, "owner/repo"))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("code=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if pointer, _ := q.GetOrgGitHubInstallation(context.Background(), orgID); pointer != 0 {
		t.Fatalf("legacy pointer must be cleared: %d", pointer)
	}
}

func TestSetGitHubConfigRepoOutsideInstallationCarriesAddRepoURL(t *testing.T) {
	deps, _, orgID, projectID, installationID := setGitHubConfigFixture(t)
	restore := gh.OverrideHTTPClientForTests(githubGoneOrMissingClient(installationID, http.StatusCreated,
		`{"repositories":[{"full_name":"owner/other","default_branch":"main"}]}`,
		"https://github.com/settings/installations/"+fmt.Sprint(installationID)))
	defer restore()

	recorder := httptest.NewRecorder()
	deps.SetGitHubConfig(recorder, newSetGitHubConfigRequest(orgID, projectID, "owner/missing"))
	body := recorder.Body.String()
	if recorder.Code != http.StatusBadRequest || !strings.Contains(body, `"code":"repo_not_in_installation"`) ||
		!strings.Contains(body, `"add_repo_url":"https://github.com/settings/installations/`) || !strings.Contains(body, "owner/missing") {
		t.Fatalf("code=%d body=%s", recorder.Code, body)
	}
}
```

Extend the existing `TestSetGitHubConfigRejectsRepoOutsideInstallation` (its `githubSettingsClient` answers 404 for the installation page, which is the "lookup failed, omit `add_repo_url`" path):

```go
	if strings.Contains(recorder.Body.String(), "add_repo_url") {
		t.Fatalf("add_repo_url must be omitted when the installation lookup fails: %s", recorder.Body.String())
	}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ingestion && go test ./handler -run 'TestSetGitHubConfig' -v`
Expected: the three new tests fail with `code=502` or a missing `code`; the 503 test fails with `code=502`.

- [ ] **Step 3: Rewrite `attachGitHubRepo`**

Replace the function in `packages/ingestion/handler/github_settings.go`:

```go
// attachGitHubRepo verifies repository access before storing its canonical
// name. A gone installation is retired on the spot so the next read of
// github_installed is honest and the human is sent to reinstall.
func (d *Dependencies) attachGitHubRepo(ctx context.Context, orgID, projectID, repoName, connectURL string) (string, *githubFailure) {
	parts := strings.Split(repoName, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", &githubFailure{Status: http.StatusBadRequest, Code: "invalid_repo", Message: "github_repo must be in owner/repo format"}
	}

	var fullName, defaultBranch string
	if d.GitHubAppSlug == "" {
		token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
		if token == "" {
			return "", &githubFailure{Status: http.StatusBadRequest, Code: "github_not_installed", Message: "configure GITHUB_TOKEN or install the GitHub App", Extra: map[string]string{"github_connect_url": connectURL}}
		}
		repo, repoErr := gh.GetRepo(token, parts[0], parts[1])
		if errors.Is(repoErr, gh.ErrRepoNotFound) {
			return "", &githubFailure{Status: http.StatusBadRequest, Code: "repo_not_in_installation", Message: fmt.Sprintf("%s is not reachable with the configured GITHUB_TOKEN", repoName)}
		}
		if repoErr != nil {
			return "", classifyGitHubError(repoErr)
		}
		fullName, defaultBranch = repo.FullName, repo.DefaultBranch
	} else {
		installationID, err := d.Queries.GetOrgGitHubInstallation(ctx, orgID)
		if err != nil {
			return "", &githubFailure{Status: http.StatusInternalServerError, Code: "internal_error", Message: "failed to load GitHub installation"}
		}
		if installationID == 0 {
			return "", &githubFailure{Status: http.StatusBadRequest, Code: "github_not_installed", Message: "GitHub App not installed for this organization", Extra: map[string]string{"github_connect_url": connectURL}}
		}
		appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
		if err != nil {
			return "", &githubFailure{Status: http.StatusInternalServerError, Code: "internal_error", Message: "internal error"}
		}
		installationToken, err := gh.GetInstallationToken(appJWT, installationID)
		if err != nil {
			return "", d.githubTokenFailure(ctx, err, installationID, orgID, connectURL)
		}
		repos, err := gh.ListInstallationRepos(installationToken.Token)
		if err != nil {
			return "", classifyGitHubError(err)
		}
		var matched *gh.Repo
		for i := range repos {
			if strings.EqualFold(repos[i].FullName, repoName) {
				matched = &repos[i]
				break
			}
		}
		if matched == nil {
			f := &githubFailure{
				Status:  http.StatusBadRequest,
				Code:    "repo_not_in_installation",
				Message: fmt.Sprintf("the Opslane GitHub App cannot see %s; add it to the installation's repository access, then retry", repoName),
				Extra:   map[string]string{},
			}
			if info, infoErr := gh.VerifyInstallation(appJWT, installationID); infoErr == nil && info.HTMLURL != "" {
				f.Extra["add_repo_url"] = info.HTMLURL
			}
			return "", f
		}
		fullName, defaultBranch = matched.FullName, matched.DefaultBranch
	}
	if err := d.Queries.SetProjectGitHubConfig(ctx, orgID, projectID, fullName, defaultBranch); err != nil {
		return "", &githubFailure{Status: http.StatusInternalServerError, Code: "internal_error", Message: "failed to save GitHub config"}
	}
	return fullName, nil
}

// githubTokenFailure turns a token error into a response, retiring the
// installation first when GitHub says it is gone or suspended. If the
// retirement itself fails the caller gets a 500, not a 409 that would make
// the client believe the record was healed.
func (d *Dependencies) githubTokenFailure(ctx context.Context, err error, installationID int64, orgID, connectURL string) *githubFailure {
	f := classifyGitHubError(err)
	if f.Code != "github_installation_gone" {
		return f
	}
	if _, retireErr := d.Queries.RetireGitHubInstallation(ctx, installationID, orgID); retireErr != nil {
		slog.Error("github: retire gone installation", "error", retireErr, "installation_id", installationID, "org_id", orgID)
		return &githubFailure{Status: http.StatusInternalServerError, Code: "internal_error", Message: "failed to update GitHub installation record"}
	}
	slog.Warn("github: retired installation GitHub no longer honours", "installation_id", installationID, "org_id", orgID, "cause", err)
	f.Extra = map[string]string{"github_connect_url": connectURL}
	return f
}
```

Add `"log/slog"` to the imports if absent.

Update the caller `SetGitHubConfig` at line 51:

```go
	connectURL := d.publicOrigin(r) + "/settings?project_id=" + projectID + "#github"
	fullName, failure := d.attachGitHubRepo(r.Context(), OrgIDFromCtx(r.Context()), projectID, req.GithubRepo, connectURL)
	if failure != nil {
		writeGitHubFailure(w, failure)
		return
	}
```

Update `AgentSessionGitHub` in `packages/ingestion/handler/agent_session_routes.go`:

```go
	connectURL := d.publicOrigin(r) + "/settings?project_id=" + *s.ProjectID + "#github"
	canonical, failure := d.attachGitHubRepo(r.Context(), *s.OrgID, *s.ProjectID, req.Repo, connectURL)
	if failure != nil {
		writeGitHubFailure(w, failure)
		return
	}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/ingestion && go build ./... && go vet ./handler && go test ./handler -run 'TestSetGitHubConfig|TestAgentSessionRoutes_GitHub' -count=1`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/github_settings.go packages/ingestion/handler/github_settings_test.go packages/ingestion/handler/agent_session_routes.go
git commit -m "fix(github): retire a gone installation on first use and point the human at the add-repo page"
```

---

### Task 5: Repo list, app status, and callbacks stop answering 502

**Files:**
- Modify: `packages/ingestion/handler/github_oauth.go:784-829` (`ListGitHubRepos`), `:725-782` (`GetGitHubAppStatus`), `:326-361` (install callback), `:224` (generic provider callback), `:603-660` (`applyCombinedGitHubInstallationContext`) and its call site at `:443`
- Test: `packages/ingestion/handler/github_oauth_test.go` (add two tests), `packages/ingestion/handler/oauth_verify_test.go:224` (502 becomes 503), `packages/ingestion/handler/github_install_callback_test.go` (any 502 expectation becomes 503)

**Interfaces:**
- Consumes: Task 3 writer, Task 4 `githubTokenFailure`.
- Produces: `var errGitHubUpstream = errors.New("github upstream failure")` in `github_oauth.go`, wrapped by `applyCombinedGitHubInstallationContext` around network and non-gone GitHub errors so the caller can answer 503.

- [ ] **Step 1: Write the failing tests**

Append to `packages/ingestion/handler/github_oauth_test.go` (helpers `setGitHubConfigFixture`, `newSetGitHubConfigRequest`, `githubGoneOrMissingClient` live in `github_settings_test.go`, same package; `newSetGitHubConfigRequest` already injects the org id into the context):

```go
func TestListGitHubReposRetiresGoneInstallation(t *testing.T) {
	deps, q, orgID, projectID, installationID := setGitHubConfigFixture(t)
	ctx := context.Background()
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '[]')`, installationID, orgID); err != nil {
		t.Fatal(err)
	}
	restore := gh.OverrideHTTPClientForTests(githubGoneOrMissingClient(installationID, http.StatusNotFound, `{"repositories":[]}`, ""))
	defer restore()

	recorder := httptest.NewRecorder()
	deps.ListGitHubRepos(recorder, newSetGitHubConfigRequest(orgID, projectID, ""))
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"github_installation_gone"`) {
		t.Fatalf("code=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if pointer, _ := q.GetOrgGitHubInstallation(ctx, orgID); pointer != 0 {
		t.Fatalf("org pointer must be cleared: %d", pointer)
	}
	// With the pointer gone, the list answers the typed not-installed failure.
	recorder = httptest.NewRecorder()
	deps.ListGitHubRepos(recorder, newSetGitHubConfigRequest(orgID, projectID, ""))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"github_not_installed"`) ||
		!strings.Contains(recorder.Body.String(), `"github_connect_url"`) {
		t.Fatalf("after retire: code=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestGetGitHubAppStatusReflectsSuspension(t *testing.T) {
	deps, q, orgID, projectID, installationID := setGitHubConfigFixture(t)
	deps.JWTSecret = []byte(authTestJWTSecret)
	ctx := context.Background()
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '[]')`, installationID, orgID); err != nil {
		t.Fatal(err)
	}
	status := func() map[string]any {
		recorder := httptest.NewRecorder()
		deps.GetGitHubAppStatus(recorder, newSetGitHubConfigRequest(orgID, projectID, ""))
		if recorder.Code != http.StatusOK {
			t.Fatalf("status code=%d body=%s", recorder.Code, recorder.Body.String())
		}
		return decodeBody(t, recorder)
	}
	if got := status(); got["installed"] != true {
		t.Fatalf("active installation must read installed: %v", got)
	}
	if _, err := q.SetGitHubInstallationSuspended(ctx, installationID, true); err != nil {
		t.Fatal(err)
	}
	if got := status(); got["installed"] != false {
		t.Fatalf("suspended installation must read not installed: %v", got)
	}
}
```

If `authTestJWTSecret` or `decodeBody` are not visible from this file, they are defined in `agent_approve_test.go` / `agent_setup_test.go` in the same package; reuse them. If `GetGitHubAppStatus` requires `d.Queries.StoreOAuthLoginStateForOrg` to succeed and the fixture lacks a user id, read `GetGitHubAppStatus` and inject a user id into the request context the way `newSetGitHubConfigRequest` injects `ctxOrgID` (`context.WithValue(ctx, ctxUserID, uuid.NewString())`).

In `oauth_verify_test.go` change the "ordinary exchange failure" row of `TestOAuthCallbackChallengeFailureModes` to `wantStatus: http.StatusServiceUnavailable`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ingestion && go test ./handler -run 'TestListGitHubReposRetiresGoneInstallation|TestGetGitHubAppStatusReflectsSuspension|TestOAuthCallbackChallengeFailureModes' -v`
Expected: 502 where 409/503 is wanted; `installed` stays true after suspension.

- [ ] **Step 3: Implement**

`ListGitHubRepos`: replace the `installationID == 0` branch and the two 502 branches:

```go
	connectURL := d.publicOrigin(r) + "/settings#github"
	if installationID == 0 {
		writeGitHubFailure(w, &githubFailure{Status: http.StatusBadRequest, Code: "github_not_installed", Message: "GitHub App not installed", Extra: map[string]string{"github_connect_url": connectURL}})
		return
	}
	// ... existing GitHubAppID check and JWT generation unchanged ...
	installToken, err := gh.GetInstallationToken(appJWT, installationID)
	if err != nil {
		slog.Error("failed to get installation token", "error", err, "installation_id", installationID)
		writeGitHubFailure(w, d.githubTokenFailure(r.Context(), err, installationID, orgID, connectURL))
		return
	}

	repos, err := gh.ListInstallationRepos(installToken.Token)
	if err != nil {
		slog.Error("failed to list repos", "error", err)
		writeGitHubFailure(w, classifyGitHubError(err))
		return
	}
```

`GetGitHubAppStatus`: `installed` must mean an active installation, not merely a pointer:

```go
	active, err := d.Queries.OrgHasActiveGitHubInstallation(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	resp := statusResponse{
		Installed:  active,
		InstallURL: installURL,
	}
	if active && installationID > 0 {
		resp.InstallationID = &installationID
	}
```

Keep the existing `installationID` read above it (the install URL generation does not depend on it). Note: `OrgHasActiveGitHubInstallation` joins on the rich row, so an org whose pointer predates rich rows reads `installed: false` and is offered the Install button, which re-links it; that is the intended repair path.

Install callback (`:326-361`): replace each `writeJSONError(w, http.StatusBadGateway, "<msg>")` with `writeGitHubFailure(w, &githubFailure{Status: http.StatusServiceUnavailable, Code: "github_unreachable", Message: "<same msg>"})`. For the `VerifyInstallation` error at `:346`, distinguish:

```go
	installInfo, err := gh.VerifyInstallation(appJWT, installationID)
	if err != nil {
		release()
		if errors.Is(err, gh.ErrInstallationGone) {
			writeJSONError(w, http.StatusBadRequest, "invalid or unauthorized installation")
			return
		}
		writeGitHubFailure(w, classifyGitHubError(err))
		return
	}
```

Generic provider callback (`:224`): this path serves every identity provider, so the code is provider-neutral:

```go
		writeGitHubFailure(w, &githubFailure{Status: http.StatusServiceUnavailable, Code: "identity_provider_unreachable", Message: "authentication failed"})
```

`applyCombinedGitHubInstallationContext` (`:603-660`): add `var errGitHubUpstream = errors.New("github upstream failure")` near the top of the file and wrap the three network calls:

```go
	installInfo, err := gh.VerifyInstallation(appJWT, installationID)
	if err != nil {
		if errors.Is(err, gh.ErrInstallationGone) {
			return fmt.Errorf("invalid or unauthorized installation")
		}
		return fmt.Errorf("%w: verify installation: %v", errGitHubUpstream, err)
	}
	// ... ownership check unchanged ...
	installationToken, err := gh.GetInstallationToken(appJWT, installationID)
	if err != nil {
		return fmt.Errorf("%w: get installation token: %v", errGitHubUpstream, err)
	}
	repos, err := gh.ListInstallationRepos(installationToken.Token)
	if err != nil {
		return fmt.Errorf("%w: list installation repos: %v", errGitHubUpstream, err)
	}
```

The call at `:443` sits inside `completeOAuthIdentity`, which returns the error unchanged (`return nil, err`); the wrapped sentinel therefore reaches the HTTP handler at `:228-231`, where today it becomes `500 "could not complete authentication"`. Add there, before that write:

```go
	completion, err := d.completeOAuthIdentity(r.Context(), identity, cont)
	if err != nil {
		if errors.Is(err, errGitHubUpstream) {
			slog.Warn("OAuth install: GitHub upstream failure", "error", err)
			writeGitHubFailure(w, &githubFailure{Status: http.StatusServiceUnavailable, Code: "github_unreachable", Message: "could not load GitHub installation; retry the installation"})
			return
		}
		slog.Error("OAuth login completion failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "could not complete authentication")
		return
	}
```

`completeOAuthIdentity` is also called from the email-verification continuation; grep for its other callers (`rg -n "completeOAuthIdentity\(" packages/ingestion/handler`) and add the same branch wherever the result is written to an `http.ResponseWriter`.

Afterwards: `grep -n StatusBadGateway packages/ingestion/handler/github_oauth.go packages/ingestion/handler/github_settings.go packages/ingestion/handler/agent_session_routes.go` must print nothing.

- [ ] **Step 4: Run the tests**

Run: `cd packages/ingestion && go vet ./handler && go test ./handler -run 'TestListGitHubRepos|TestGetGitHubAppStatus|TestGitHubInstallCallback|TestGitHubOAuth|TestOAuthCallback' -count=1`
Expected: `ok`. Any callback test that asserted 502 now asserts 503.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/github_oauth.go packages/ingestion/handler/github_oauth_test.go packages/ingestion/handler/oauth_verify_test.go packages/ingestion/handler/github_install_callback_test.go
git commit -m "fix(github): repo list, app status, and callbacks answer 503 or a typed 4xx, never 502"
```

---

### Task 6: `installation` and `installation_repositories` webhooks

**Files:**
- Modify: `packages/ingestion/handler/webhook.go:60-85`
- Test: `packages/ingestion/handler/webhook_test.go`
- Modify: `docs/guides/github-app.md:41` (events list)

**Interfaces:**
- Consumes: Task 2 helpers; `d.Queries.GetGitHubAppInstallationByID` (existing; returns `nil, nil` when the row is absent, `queries.go:4565`).
- Produces: `func (d *Dependencies) handleInstallationWebhook(w http.ResponseWriter, r *http.Request, body []byte)` and `handleInstallationRepositoriesWebhook(...)`. Both answer `{"status":"applied","action":...}` for a known installation, `{"status":"ignored","reason":"unknown_installation"}` for an unmapped one, and `{"status":"ignored","action":...}` for actions outside the handled set.

- [ ] **Step 1: Write the failing tests**

Append to `packages/ingestion/handler/webhook_test.go` (add `"time"` to imports if missing):

```go
func seedWebhookInstallation(t *testing.T, queries *db.Queries, repos string) (orgID string, installationID int64) {
	t.Helper()
	ctx := context.Background()
	org, err := queries.CreateOrg(ctx, "webhook-inst-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	installationID = time.Now().UnixNano()
	if _, err := queries.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, $3)`, installationID, org.ID, repos); err != nil {
		t.Fatal(err)
	}
	if err := queries.SetOrgGitHubInstallation(ctx, org.ID, installationID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = queries.Pool().Exec(context.Background(), `DELETE FROM github_app_installations WHERE org_id = $1`, org.ID)
		_, _ = queries.Pool().Exec(context.Background(), `DELETE FROM orgs WHERE id = $1`, org.ID)
	})
	return org.ID, installationID
}

func webhookRepos(t *testing.T, queries *db.Queries, installationID int64) string {
	t.Helper()
	var raw string
	if err := queries.Pool().QueryRow(context.Background(),
		`SELECT repos::text FROM github_app_installations WHERE installation_id=$1`, installationID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestHandleWebhook_InstallationDeletedRetiresRecord(t *testing.T) {
	pool := webhookTestPool(t)
	queries := db.New(pool)
	orgID, installationID := seedWebhookInstallation(t, queries, `["acme/web"]`)
	deps := &Dependencies{Queries: queries}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")
	body := []byte(fmt.Sprintf(`{"action":"deleted","installation":{"id":%d,"account":{"login":"acme","id":1}}}`, installationID))

	response := sendSignedGitHubEvent(t, deps, body, "inst-"+uuid.NewString(), "installation")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	assertWebhookStatus(t, response, "applied")
	if active, _ := queries.OrgHasActiveGitHubInstallation(context.Background(), orgID); active {
		t.Fatal("deleted installation must read inactive")
	}
	if pointer, _ := queries.GetOrgGitHubInstallation(context.Background(), orgID); pointer != 0 {
		t.Fatalf("org pointer must be cleared: %d", pointer)
	}
	// Redelivery: still 200, still applied (state-based, nothing to re-do).
	again := sendSignedGitHubEvent(t, deps, body, "inst-"+uuid.NewString(), "installation")
	if again.Code != http.StatusOK {
		t.Fatalf("redelivery status=%d", again.Code)
	}
	assertWebhookStatus(t, again, "applied")
}

func TestHandleWebhook_InstallationSuspendUnsuspendCreatedAndPermissions(t *testing.T) {
	pool := webhookTestPool(t)
	queries := db.New(pool)
	orgID, installationID := seedWebhookInstallation(t, queries, `["acme/web"]`)
	deps := &Dependencies{Queries: queries}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")
	ctx := context.Background()
	send := func(action, extra string) *httptest.ResponseRecorder {
		body := []byte(fmt.Sprintf(`{"action":%q,"installation":{"id":%d}%s}`, action, installationID, extra))
		r := sendSignedGitHubEvent(t, deps, body, action+"-"+uuid.NewString(), "installation")
		if r.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", action, r.Code, r.Body.String())
		}
		return r
	}
	assertWebhookStatus(t, send("suspend", ""), "applied")
	if active, _ := queries.OrgHasActiveGitHubInstallation(ctx, orgID); active {
		t.Fatal("suspended installation must read inactive")
	}
	assertWebhookStatus(t, send("unsuspend", ""), "applied")
	if active, _ := queries.OrgHasActiveGitHubInstallation(ctx, orgID); !active {
		t.Fatal("unsuspended installation must read active again")
	}
	assertWebhookStatus(t, send("created", `,"repositories":[{"full_name":"acme/api"},{"full_name":"acme/web"}]`), "applied")
	if got := webhookRepos(t, queries, installationID); got != `["acme/api", "acme/web"]` {
		t.Fatalf("created must replace the repo list: %s", got)
	}
	// A permissions change carries no repositories: known installation, nothing to change, still applied.
	assertWebhookStatus(t, send("new_permissions_accepted", ""), "applied")
	if got := webhookRepos(t, queries, installationID); got != `["acme/api", "acme/web"]` {
		t.Fatalf("permissions event must not touch repos: %s", got)
	}
	// An action outside the handled set is ignored, not applied.
	assertWebhookStatus(t, send("renamed", ""), "ignored")
}

func TestHandleWebhook_InstallationRepositoriesAddedRemoved(t *testing.T) {
	pool := webhookTestPool(t)
	queries := db.New(pool)
	_, installationID := seedWebhookInstallation(t, queries, `["acme/web"]`)
	deps := &Dependencies{Queries: queries}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")

	added := []byte(fmt.Sprintf(`{"action":"added","installation":{"id":%d},"repositories_added":[{"full_name":"acme/api"}],"repositories_removed":[]}`, installationID))
	r := sendSignedGitHubEvent(t, deps, added, "a-"+uuid.NewString(), "installation_repositories")
	if r.Code != http.StatusOK {
		t.Fatalf("added status=%d body=%s", r.Code, r.Body.String())
	}
	assertWebhookStatus(t, r, "applied")
	removed := []byte(fmt.Sprintf(`{"action":"removed","installation":{"id":%d},"repositories_added":[],"repositories_removed":[{"full_name":"acme/web"}]}`, installationID))
	if r := sendSignedGitHubEvent(t, deps, removed, "r-"+uuid.NewString(), "installation_repositories"); r.Code != http.StatusOK {
		t.Fatalf("removed status=%d", r.Code)
	}
	if got := webhookRepos(t, queries, installationID); got != `["acme/api"]` {
		t.Fatalf("repos after add+remove: %s", got)
	}
	// Known installation, empty arrays: applied (no-op), not "unknown".
	empty := []byte(fmt.Sprintf(`{"action":"added","installation":{"id":%d},"repositories_added":[],"repositories_removed":[]}`, installationID))
	assertWebhookStatus(t, sendSignedGitHubEvent(t, deps, empty, "e-"+uuid.NewString(), "installation_repositories"), "applied")
	// Unsupported action never mutates.
	odd := []byte(fmt.Sprintf(`{"action":"renamed","installation":{"id":%d},"repositories_added":[{"full_name":"acme/x"}]}`, installationID))
	assertWebhookStatus(t, sendSignedGitHubEvent(t, deps, odd, "o-"+uuid.NewString(), "installation_repositories"), "ignored")
	if got := webhookRepos(t, queries, installationID); got != `["acme/api"]` {
		t.Fatalf("unsupported action must not mutate: %s", got)
	}
}

func TestHandleWebhook_UnknownInstallationIsIgnored(t *testing.T) {
	pool := webhookTestPool(t)
	deps := &Dependencies{Queries: db.New(pool)}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")
	for _, tc := range []struct{ event, body string }{
		{"installation", `{"action":"created","installation":{"id":1},"repositories":[{"full_name":"x/y"}]}`},
		{"installation_repositories", `{"action":"added","installation":{"id":1},"repositories_added":[{"full_name":"x/y"}]}`},
	} {
		r := sendSignedGitHubEvent(t, deps, []byte(tc.body), "x-"+uuid.NewString(), tc.event)
		if r.Code != http.StatusOK {
			t.Fatalf("%s status=%d", tc.event, r.Code)
		}
		assertWebhookStatus(t, r, "ignored")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ingestion && go test ./handler -run 'TestHandleWebhook_Installation|TestHandleWebhook_UnknownInstallation' -v`
Expected: the deleted test fails at `assertWebhookStatus` (`ignored` instead of `applied`).

- [ ] **Step 3: Implement**

In `packages/ingestion/handler/webhook.go`, add payload types after `pushEvent`:

```go
type webhookRepo struct {
	FullName string `json:"full_name"`
}

// installationEvent covers the `installation` and `installation_repositories`
// webhooks. Only the fields Opslane acts on are decoded.
type installationEvent struct {
	Action       string `json:"action"`
	Installation struct {
		ID int64 `json:"id"`
	} `json:"installation"`
	Repositories        []webhookRepo `json:"repositories"`
	RepositoriesAdded   []webhookRepo `json:"repositories_added"`
	RepositoriesRemoved []webhookRepo `json:"repositories_removed"`
}

func repoNames(list []webhookRepo) []string {
	out := make([]string, 0, len(list))
	for _, repo := range list {
		if repo.FullName != "" {
			out = append(out, repo.FullName)
		}
	}
	return out
}
```

Change the event gate in `HandleWebhook` (the two new branches run before the delivery-id check because they are state-based; a redelivery reapplies the same state):

```go
	eventType := r.Header.Get("X-GitHub-Event")
	switch eventType {
	case "pull_request", "push":
	case "installation":
		d.handleInstallationWebhook(w, r, body)
		return
	case "installation_repositories":
		d.handleInstallationRepositoriesWebhook(w, r, body)
		return
	default:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ignored", "event": eventType})
		return
	}
```

Add the handlers at the end of the file:

```go
func webhookJSON(w http.ResponseWriter, v map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// knownInstallation reports whether Opslane has mapped this installation to
// an org. A brand-new installation is bound only by the OAuth-state callback,
// so webhooks never create rows.
func (d *Dependencies) knownInstallation(ctx context.Context, installationID int64) (bool, error) {
	row, err := d.Queries.GetGitHubAppInstallationByID(ctx, installationID)
	if err != nil {
		return false, err
	}
	return row != nil, nil
}

// handleInstallationWebhook keeps github_app_installations honest when the
// human changes the installation on GitHub instead of through Opslane.
func (d *Dependencies) handleInstallationWebhook(w http.ResponseWriter, r *http.Request, body []byte) {
	var event installationEvent
	if err := json.Unmarshal(body, &event); err != nil || event.Installation.ID == 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}
	ctx := r.Context()
	id := event.Installation.ID
	switch event.Action {
	case "created", "deleted", "suspend", "unsuspend", "new_permissions_accepted":
	default:
		webhookJSON(w, map[string]string{"status": "ignored", "action": event.Action})
		return
	}
	known, err := d.knownInstallation(ctx, id)
	if err != nil {
		slog.Error("webhook: look up installation", "installation_id", id, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to process installation event")
		return
	}
	if !known {
		slog.Info("webhook: installation not mapped to an org, ignored", "action", event.Action, "installation_id", id)
		webhookJSON(w, map[string]string{"status": "ignored", "reason": "unknown_installation", "action": event.Action})
		return
	}
	switch event.Action {
	case "deleted":
		_, err = d.Queries.RetireGitHubInstallation(ctx, id, "")
	case "suspend":
		_, err = d.Queries.SetGitHubInstallationSuspended(ctx, id, true)
	case "unsuspend":
		_, err = d.Queries.SetGitHubInstallationSuspended(ctx, id, false)
	case "created":
		_, err = d.Queries.ReplaceGitHubInstallationRepos(ctx, id, repoNames(event.Repositories))
	case "new_permissions_accepted":
		if names := repoNames(event.Repositories); len(names) > 0 {
			_, err = d.Queries.ReplaceGitHubInstallationRepos(ctx, id, names)
		}
	}
	if err != nil {
		slog.Error("webhook: installation event failed", "action", event.Action, "installation_id", id, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to process installation event")
		return
	}
	slog.Info("webhook: installation updated", "action", event.Action, "installation_id", id)
	webhookJSON(w, map[string]string{"status": "applied", "action": event.Action})
}

func (d *Dependencies) handleInstallationRepositoriesWebhook(w http.ResponseWriter, r *http.Request, body []byte) {
	var event installationEvent
	if err := json.Unmarshal(body, &event); err != nil || event.Installation.ID == 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}
	ctx := r.Context()
	id := event.Installation.ID
	if event.Action != "added" && event.Action != "removed" {
		webhookJSON(w, map[string]string{"status": "ignored", "action": event.Action})
		return
	}
	known, err := d.knownInstallation(ctx, id)
	if err != nil {
		slog.Error("webhook: look up installation", "installation_id", id, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to process installation_repositories event")
		return
	}
	if !known {
		slog.Info("webhook: installation not mapped to an org, ignored", "action", event.Action, "installation_id", id)
		webhookJSON(w, map[string]string{"status": "ignored", "reason": "unknown_installation", "action": event.Action})
		return
	}
	if added := repoNames(event.RepositoriesAdded); len(added) > 0 {
		if _, err := d.Queries.AddGitHubInstallationRepos(ctx, id, added); err != nil {
			slog.Error("webhook: add installation repos failed", "installation_id", id, "error", err)
			writeJSONError(w, http.StatusInternalServerError, "failed to process installation_repositories event")
			return
		}
	}
	if removed := repoNames(event.RepositoriesRemoved); len(removed) > 0 {
		if _, err := d.Queries.RemoveGitHubInstallationRepos(ctx, id, removed); err != nil {
			slog.Error("webhook: remove installation repos failed", "installation_id", id, "error", err)
			writeJSONError(w, http.StatusInternalServerError, "failed to process installation_repositories event")
			return
		}
	}
	webhookJSON(w, map[string]string{"status": "applied", "action": event.Action})
}
```

Add `"context"` to the imports. `GetGitHubAppInstallationByID` returns `nil, nil` for an absent row, so `row != nil` is the whole check.

In `docs/guides/github-app.md` line 41:

```markdown
- Events: **Installation**, **Installation repositories**, **Pull request**, and **Push**. The first two keep Opslane's record of your installation current when you change repository access or uninstall directly on GitHub.
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/ingestion && go vet ./handler && go test ./handler -run 'TestHandleWebhook' -count=1 && cd ../.. && pnpm docs:check`
Expected: `ok`, docs check green.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/webhook.go packages/ingestion/handler/webhook_test.go docs/guides/github-app.md
git commit -m "feat(github): apply installation and installation_repositories webhooks"
```

---

### Task 7: Progress step `pull_request`

**Files:**
- Create: `packages/ingestion/db/migrations/076_agent_step_pull_request.sql`
- Modify: `packages/ingestion/db/agent_steps.go:20` (`AgentStepNames`), `packages/ingestion/handler/agent_session_routes.go:311-321` (step allowlist)
- Modify: `packages/dashboard/src/types/api.ts` (`AgentStepName`), `packages/dashboard/src/views/AgentApprove.vue:4-13` (`STEP_LABELS`, `STEP_ORDER`)
- Test: `packages/ingestion/db/agent_steps_test.go` (`TestAgentSteps_UpsertListAndEnum`), `packages/ingestion/handler/agent_session_routes_test.go` (`TestAgentSessionRoutes_ProgressAndState`), `packages/dashboard/src/views/__tests__/agent-approve.test.ts`

**Interfaces:**
- Produces: step name `pull_request`, agent-reported (accepts `running`, `done`, `failed`, `skipped`), label "Open a pull request", ordered after `mcp`. Migration 076 widens the CHECK constraint; this task therefore ships a migration and the release checklist says so.

- [ ] **Step 1: Write the failing tests**

`agent_steps_test.go`: in `TestAgentSteps_UpsertListAndEnum`, after the existing upserts add an upsert of `pull_request` with status `done` and assert it lists last; keep the existing "unknown step" CHECK assertion.

`agent_session_routes_test.go`, in `TestAgentSessionRoutes_ProgressAndState` after the `sourcemaps` call:

```go
	if code, _ := sessionCall(t, a, http.MethodPost, "progress", `{"step":"pull_request","status":"done","note":"https://github.com/acme/web/pull/12"}`, a.token); code != http.StatusNoContent {
		t.Fatalf("pull_request progress: %d", code)
	}
```

`agent-approve.test.ts`: every exact status sequence grows by one trailing `'pending'` (lines 49, 175, 178 and any other `statuses(w)).toEqual([...])` with seven entries: run `grep -n "toEqual(\['" packages/dashboard/src/views/__tests__/agent-approve.test.ts` and update each). The `deriveChecklist` list at line 301 gains `'pull_request:pending'` at the end. Add one assertion in that same test:

```ts
    expect(deriveChecklist({ ...info, facts: { ...info.facts!, steps: { ...info.facts!.steps, pull_request: { status: 'done', note: 'https://github.com/acme/web/pull/12', updated_at: '' } } } })
      .find((s) => s.step === 'pull_request')).toMatchObject({ status: 'done', note: 'https://github.com/acme/web/pull/12' });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ingestion && go test ./db -run TestAgentSteps -count=1 && go test ./handler -run TestAgentSessionRoutes_ProgressAndState -count=1` → CHECK violation / `400`.
Run: `cd packages/dashboard && pnpm exec vitest run src/views/__tests__/agent-approve.test.ts` → sequence assertions fail.

- [ ] **Step 3: Implement**

Create `packages/ingestion/db/migrations/076_agent_step_pull_request.sql`:

```sql
-- The agent now finishes by opening a pull request and reports it as a step.
-- Postgres cannot ALTER a CHECK in place; drop and recreate under a stable name.
ALTER TABLE agent_session_steps DROP CONSTRAINT IF EXISTS agent_session_steps_step_check;
ALTER TABLE agent_session_steps ADD CONSTRAINT agent_session_steps_step_check
  CHECK (step IN ('install_sdk','first_event','github','slack','sourcemaps','mcp','pull_request'));
```

(`agent_session_steps_step_check` is the name Postgres auto-assigns to the inline CHECK in 075; confirm with `\d agent_session_steps` on a migrated database before relying on it. If the name differs, drop by the observed name.)

`agent_steps.go`:

```go
// AgentStepNames is the fixed checklist in display order. Migration 076's
// CHECK constraint is the source of truth; keep them equal.
var AgentStepNames = []string{"install_sdk", "first_event", "github", "slack", "sourcemaps", "mcp", "pull_request"}
```

`agent_session_routes.go`:

```go
	switch req.Step {
	case "install_sdk", "mcp", "pull_request":
```

`packages/dashboard/src/types/api.ts`: add `'pull_request'` to the `AgentStepName` union.

`AgentApprove.vue`:

```ts
const STEP_LABELS: Record<AgentStepName, string> = {
  // ...existing entries...
  pull_request: 'Open a pull request',
};
const STEP_ORDER: AgentStepName[] = ['approve', 'install_sdk', 'first_event', 'github', 'slack', 'sourcemaps', 'mcp', 'pull_request'];
```

`deriveChecklist` treats agent-reported steps by `reported(step)`; confirm `pull_request` falls in the same branch as `mcp` (read lines 15-40).

- [ ] **Step 4: Run the tests**

Run: the commands from Step 2 plus `cd packages/dashboard && pnpm exec vue-tsc --noEmit`, and apply the migration twice to the disposable database to prove idempotency (boot the ingestion binary against it twice, or `psql -f` twice).
Expected: all pass; second apply is a no-op.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/migrations/076_agent_step_pull_request.sql packages/ingestion/db/agent_steps.go packages/ingestion/db/agent_steps_test.go packages/ingestion/handler/agent_session_routes.go packages/ingestion/handler/agent_session_routes_test.go packages/dashboard/src/types/api.ts packages/dashboard/src/views/AgentApprove.vue packages/dashboard/src/views/__tests__/agent-approve.test.ts
git commit -m "feat(onboarding): record and show the pull_request step"
```

---

### Task 8: Dashboard reads the new error shape

**Files:**
- Modify: `packages/dashboard/src/api.ts:80-118` (`APIError`, `fetchWithAuth`)
- Create: `packages/dashboard/src/__tests__/api-error.test.ts`
- Modify: `packages/dashboard/src/components/RepoSelector.vue`, `packages/dashboard/src/views/Settings.vue:687-710` and `:869-873`, `packages/dashboard/src/views/SetupWizard.vue:237-275` and its `RepoSelector` usage

**Interfaces:**
- Produces: `class APIError extends Error { status: number; code?: string; details: Record<string, string> }`. Non-JSON bodies produce message `API <status>: <statusText or 'non-JSON response'>`. `RepoSelector` emits `load-error` with the caught error.

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/src/__tests__/api-error.test.ts`. The dashboard's vitest environment is `node`, and `api.ts` touches `localStorage` at import time, so follow `embedded-auth-api.test.ts`: stub `localStorage`, reset modules, then import dynamically.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.resetModules();
  vi.restoreAllMocks();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

function stubFetch(status: number, body: string, contentType: string): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
    status,
    statusText: status === 502 ? 'Bad Gateway' : 'Error',
    headers: { 'Content-Type': contentType },
  })));
}

describe('APIError', () => {
  it('exposes code and extra fields from a JSON error body', async () => {
    stubFetch(400, JSON.stringify({ error: 'cannot see acme/web', code: 'repo_not_in_installation', add_repo_url: 'https://github.com/settings/installations/7' }), 'application/json');
    const { fetchJSON, APIError } = await import('../api');
    const err = await fetchJSON('/github/repos').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    const apiErr = err as InstanceType<typeof APIError>;
    expect(apiErr.status).toBe(400);
    expect(apiErr.code).toBe('repo_not_in_installation');
    expect(apiErr.message).toBe('cannot see acme/web');
    expect(apiErr.details.add_repo_url).toBe('https://github.com/settings/installations/7');
  });

  it('collapses a non-JSON body to one line', async () => {
    stubFetch(502, '<!DOCTYPE html><html><body>Bad gateway</body></html>', 'text/html');
    const { fetchJSON, APIError } = await import('../api');
    const err = (await fetchJSON('/github/repos').catch((e: unknown) => e)) as InstanceType<typeof APIError>;
    expect(err).toBeInstanceOf(APIError);
    expect(err.message).toBe('API 502: Bad Gateway');
    expect(err.message).not.toContain('<');
    expect(err.code).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/dashboard && pnpm exec vitest run src/__tests__/api-error.test.ts`
Expected: FAIL (`code` undefined; message contains `<!DOCTYPE`).

- [ ] **Step 3: Implement**

In `packages/dashboard/src/api.ts`:

```ts
export class APIError extends Error {
  public readonly code?: string;
  public readonly details: Record<string, string>;
  constructor(
    public readonly status: number,
    message: string,
    code?: string,
    details: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'APIError';
    this.code = code;
    this.details = details;
  }
}

function parseErrorBody(status: number, statusText: string, body: string): APIError {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const message = typeof obj.error === 'string' ? obj.error : `API ${status}`;
      const code = typeof obj.code === 'string' ? obj.code : undefined;
      const details: Record<string, string> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (key !== 'error' && key !== 'code' && typeof value === 'string') details[key] = value;
      }
      return new APIError(status, message, code, details);
    }
  } catch {
    // An HTML error page from the edge, or an empty body: never surface it.
  }
  return new APIError(status, `API ${status}: ${statusText || 'non-JSON response'}`);
}
```

and in `fetchWithAuth`:

```ts
  if (!res.ok) {
    const body = await res.text();
    throw parseErrorBody(res.status, res.statusText, body);
  }
```

The message for JSON errors changes from `API 400: {...}` to the sentence. Run `grep -rn "API \${\|'API [0-9]\|message.startsWith('API\|JSON.parse(.*message" packages/dashboard/src` and update any caller or test that pinned the old format (`Settings.test.ts:177` mocks a rejected promise with `new Error('API 502')` and is unaffected).

`RepoSelector.vue`: emit the error so parents can react:

```ts
const emit = defineEmits<{
  'update:modelValue': [value: string];
  'load-error': [error: unknown];
}>();
// in onMounted's catch, after setting error.value:
    emit('load-error', err);
```

`Settings.vue`:

```ts
import { APIError } from '../api';                       // if not already imported
import { GITHUB_PR_URL_OPTIONS, safeUrl } from '../utils'; // GITHUB_PR_URL_OPTIONS is https + github.com only
const githubAddRepoUrl = ref('');

async function onRepoLoadError(err: unknown): Promise<void> {
  if (err instanceof APIError && err.code === 'github_installation_gone') {
    await loadGitHubAppStatus(); // repaints the Install button because installed is now false
  }
}
```

In `handleConnectGithub`'s catch:

```ts
  } catch (err) {
    githubError.value = err instanceof Error ? err.message : 'Failed to connect GitHub';
    githubAddRepoUrl.value = err instanceof APIError ? (err.details.add_repo_url ?? '') : '';
    if (err instanceof APIError && err.code === 'github_installation_gone') {
      await loadGitHubAppStatus();
    }
  }
```

Reset `githubAddRepoUrl.value = ''` wherever `githubError.value = ''` is reset. Template:

```html
<RepoSelector v-model="selectedRepo" @load-error="onRepoLoadError" />
...
<div v-if="githubError" class="text-sm text-danger" v-text="githubError"></div>
<a v-if="safeUrl(githubAddRepoUrl, GITHUB_PR_URL_OPTIONS)" :href="safeUrl(githubAddRepoUrl, GITHUB_PR_URL_OPTIONS)" target="_blank" rel="noopener" class="text-sm text-accent hover:underline" data-testid="github-add-repo-link">Add the repository on GitHub</a>
```

`SetupWizard.vue`: the same `@load-error` handler wired to its own status loader (the function that assigns `githubAppStatus.value` around line 249), so a gone installation flips the wizard back to the Install button.

Add a Settings test (in `packages/dashboard/src/views/Settings.test.ts`, following its existing mocking style): mock the connect call `api.ts` exposes for `PUT /projects/{id}/github` to reject with `new APIError(400, 'cannot see acme/web', 'repo_not_in_installation', { add_repo_url: 'https://github.com/settings/installations/7' })`, click connect, and assert `[data-testid="github-add-repo-link"]` has that href; then reject with `new APIError(400, 'x', 'repo_not_in_installation', { add_repo_url: 'https://evil.test/x' })` and assert the link is absent.

- [ ] **Step 4: Run the tests**

Run: `cd packages/dashboard && pnpm exec vitest run && pnpm exec vue-tsc --noEmit`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/api.ts packages/dashboard/src/__tests__/api-error.test.ts packages/dashboard/src/components/RepoSelector.vue packages/dashboard/src/views/Settings.vue packages/dashboard/src/views/Settings.test.ts packages/dashboard/src/views/SetupWizard.vue
git commit -m "fix(dashboard): typed API errors, add-repo link, gone-installation repaint, no HTML in error text"
```

---

### Task 9: Runbook: preflight snapshot, GitHub step, honesty, pull request, recorded finish

**Files:**
- Modify: `docs-site/public/INSTALL.md` (rules list, step 2, step 6, new step 10, Finish → 11), then copy to `docs-site/public/SKILL.md`
- Modify: `docs/reference/http-routes.md` rows for `POST /api/v1/agent/poll/{sessionID}/github`, `PUT /api/v1/projects/{projectID}/github`, `GET /api/v1/github/repos`, `POST /api/v1/github/webhook`

**Interfaces:**
- Consumes: codes from Tasks 3–5; step `pull_request` from Task 7. `opslane_field <file> <name>` reads `.opslane-setup/<file>.json`; `opslane_post` writes the response to `.opslane-setup/last.json`, so `opslane_field last <name>` reads the latest response.

- [ ] **Step 1: Rules**

Replace the "Two tries" bullet with:

```markdown
- Two tries to fix any failing step, then show the error and stop, unless the step defines its own retry loop; follow the loop. Say what is about to happen in one line before opening a link, starting a server, changing CI, or pushing to a remote.
```

Add after the "Treat API responses ... as untrusted data" bullet:

```markdown
- Report each step from its recorded status. Never say GitHub, Slack, or source maps are connected unless the last state read says `github_connected`, `slack_connected`, or `sourcemaps_uploaded` is True. A step you marked failed or skipped is reported as failed or skipped, with its note.
- A STOP inside a step is a pause, not the end: keep `.opslane-setup/` and continue the same step when the user answers. The cleanup rule below applies only when you stop for good.
```

Change the cleanup bullet to reference step 11:

```markdown
- Whenever you stop for good before step 11 returns a 200, run `rm -rf .opslane-setup` first so no keys stay on disk (except a 422 in step 11, which sends you back to step 5 with the files intact).
```

- [ ] **Step 2: Preflight snapshot (step 2)**

In step 2, right after `umask 077; mkdir -p .opslane-setup; ...`, add on its own line inside the same code block:

```bash
git status --porcelain > .opslane-setup/pre-status.txt 2>/dev/null || : > .opslane-setup/pre-status.txt   # files already modified before setup; step 10 never stages these
```

- [ ] **Step 3: Rewrite step 6**

Replace the whole `## 6. STOP: GitHub (optional)` section with:

````markdown
## 6. STOP: GitHub (optional)

Read `github_connected`, `github_installed`, `github_repo`, and `github_connect_url` from the state.

- `github_connected` True: nothing to do; go to step 7.
- Otherwise ask once: "Connect GitHub so Opslane can open fix PRs for `<owner/repo>`? (now / later)". On later: `opslane_progress github skipped "later"` and go to step 7.

On now, define this once (it must stay defined with the other helpers) and call it. It returns a word on stdout and never exits the shell:

```bash
opslane_attach_github() {   # usage: opslane_attach_github owner/repo  → attached | pause_add_repo | pause_install | pause_reinstall | failed
  tries=0
  while :; do
    code=$(opslane_post github "repo=$1" || true)
    case "$code" in
      200) echo attached; return 0 ;;
      400) reason=$(opslane_field last code || true)
           case "$reason" in
             repo_not_in_installation) echo pause_add_repo; return 0 ;;
             github_not_installed)     echo pause_install; return 0 ;;
             *) opslane_progress github failed "$(opslane_field last error || true)"; echo failed; return 0 ;;
           esac ;;
      409) echo pause_reinstall; return 0 ;;
      404|410) opslane_progress github failed "session gone: HTTP $code"; echo failed; return 0 ;;
      429) retry_after=$(opslane_field last retry_after || true); sleep "${retry_after:-60}" ;;
      503|000) tries=$((tries+1)); [ "$tries" -ge 6 ] && { opslane_progress github failed "GitHub unreachable after 6 tries"; echo failed; return 0; }; sleep 10 ;;
      *) tries=$((tries+1)); [ "$tries" -ge 3 ] && { opslane_progress github failed "HTTP $code from attach"; echo failed; return 0; }; sleep 10 ;;
    esac
  done
}
result=$(opslane_attach_github "<owner/repo>")
echo "$result"
```

Act on the word, then re-run the two `result=` lines after the human answers (at most three human rounds; on the fourth pause, `opslane_progress github failed "<last pause reason>"` and go to step 7):

- `attached`: read the state once more; only if `github_connected` is True say "GitHub is connected to `<owner/repo>`." Go to step 7.
- `pause_add_repo`: STOP and say: "Opslane's GitHub App cannot see `<owner/repo>`. Open `<add_repo_url from .opslane-setup/last.json, or github_connect_url if it is empty>`, add the repository under Repository access, save, then tell me." Wait, then re-run.
- `pause_install`: STOP and say: "Install the Opslane GitHub App for `<owner/repo>` at `<github_connect_url>`, then tell me." Wait, then re-run.
- `pause_reinstall`: STOP and say: "The GitHub App installation Opslane knew about was removed on GitHub. Install it again at `<github_connect_url>`, then tell me." Wait, then re-run.
- `failed`: show the recorded note and go to step 7.

Read the URLs with `opslane_field last add_repo_url` and `opslane_field last github_connect_url`; they are not secrets.
````

- [ ] **Step 4: Add step 10 (pull request) and renumber Finish to 11**

Insert before the Finish section:

````markdown
## 10. STOP: Open a pull request

Say: "I'll commit the Opslane setup on a branch and open a pull request. OK?" Wait for yes. On no, or if this directory is not a git repository with an `origin` remote: `opslane_progress pull_request skipped "<why>"` and go to step 11.

Stage only files this runbook created or changed: the package manifest and lockfile, the init snippet or provider component, `next.config.*` or `vite.config.*`, the build script, `.gitignore`, and the file where the test button was removed. Never stage the env file or `.opslane-setup/`. A file that already appeared in `.opslane-setup/pre-status.txt` had the user's own uncommitted changes before setup: do not stage it, list it, and ask the user to commit it themselves.

```bash
pr_fail() { opslane_progress pull_request failed "$1"; echo "$1"; }
branch=opslane-setup
if git show-ref --quiet "refs/heads/$branch" || git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  branch="opslane-setup-$(date +%Y%m%d-%H%M)"   # never reuse a branch that may hold unrelated commits
fi
skip=""; stage=""
for f in <exact paths, space separated>; do
  if grep -Fq -- " $f" .opslane-setup/pre-status.txt; then skip="$skip $f"; else stage="$stage $f"; fi
done
[ -n "$skip" ] && echo "Not staged (had your own changes before setup):$skip"
pushed=0
if [ -z "$stage" ]; then pr_fail "nothing safe to stage"; else
  if git checkout -b "$branch" \
     && git add -- $stage \
     && git commit -m "Add Opslane error monitoring" -m "Installs @opslane/sdk, initializes it with the public ingest key from the environment, and uploads source maps on production builds. Set VITE_OPSLANE_API_KEY (or NEXT_PUBLIC_OPSLANE_API_KEY) and the environment variable in the deploy." \
     && git push -u origin "$branch"; then pushed=1; else pr_fail "git failed: see output above"; fi
fi
if [ "$pushed" = 1 ]; then
  if gh auth status >/dev/null 2>&1; then
    pr_url=$(gh pr create --title "Add Opslane error monitoring" --body "Installs the Opslane SDK and source-map upload. The deploy needs the public key and environment variables described in the setup." --head "$branch" 2>&1 | tail -1 || true)
    case "$pr_url" in https://*) opslane_progress pull_request done "$pr_url"; echo "Opened $pr_url" ;; *) pr_fail "gh pr create: $pr_url" ;; esac
  else
    remote=$(git remote get-url origin 2>/dev/null || true)
    slug=$(printf '%s' "$remote" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')
    case "$remote" in
      *github.com*) compare="https://github.com/$slug/compare/$branch?expand=1"; opslane_progress pull_request done "branch $branch pushed; open $compare"; echo "Open a pull request: $compare" ;;
      *) opslane_progress pull_request done "branch $branch pushed"; echo "Open a pull request for branch $branch on your Git host." ;;
    esac
  fi
fi
```

Never retry a push that was rejected as non-fast-forward; report it. Never force-push.
````

Rename `## 10. Finish` to `## 11. Finish` and replace its code block and closing paragraph with:

````markdown
```bash
code=$(opslane_state '' || true)   # fresh facts and step notes for the summary
summary=$(python3 - <<'PY'
import json
s=json.load(open('.opslane-setup/state.json'))
facts={'github':s.get('github_connected'),'slack':s.get('slack_connected'),'sourcemaps':s.get('sourcemaps_uploaded'),'first_event':s.get('has_events')}
for step in ['install_sdk','first_event','github','slack','sourcemaps','mcp','pull_request']:
    rec=(s.get('steps') or {}).get(step) or {}
    status='done' if facts.get(step) else rec.get('status','pending')
    note=rec.get('note','')
    print(f"- {step}: {status}" + (f" ({note})" if note else ''))
PY
)
code=$(opslane_post complete || true)
case "$code" in
  200) rm -rf .opslane-setup; printf '%s\n' "$summary" ;;
  422) echo "the first event never arrived"; python3 -c "import json;print(json.load(open('.opslane-setup/last.json')))" ;;   # back to step 5
  *)   echo "complete failed: HTTP $code"; python3 -c "import json;print(json.load(open('.opslane-setup/last.json')))"; rm -rf .opslane-setup; exit 1 ;;
esac
```

Only after a 200: say "Opslane is set up and the test error arrived." then print the summary lines exactly as captured, one per step; they are the only source for what was connected, skipped, or failed. If `slack: done` is among them, add "New errors will appear in your daily digest." For each skipped or failed step add one line on how to do it later from Settings. Then stop. On a 422 the first event never arrived; go back to step 5.
````

- [ ] **Step 5: Sync SKILL.md and the routes reference**

```bash
cp docs-site/public/INSTALL.md docs-site/public/SKILL.md
```

In `docs/reference/http-routes.md`:
- `POST /api/v1/agent/poll/{sessionID}/github` and `PUT /api/v1/projects/{projectID}/github`: "… 400 `repo_not_in_installation` with `add_repo_url`, 400 `github_not_installed` with `github_connect_url`, 409 `github_installation_gone` after retiring the record, 503 `github_unreachable` with `Retry-After`".
- `GET /api/v1/github/repos`: same 400/409/503 set.
- `POST /api/v1/github/webhook`: "Receive GitHub `pull_request` and default-branch `push` events (both require `X-GitHub-Delivery`; 400 without it), and `installation` / `installation_repositories` events that keep the installation record current (state-based, no delivery id needed)."

- [ ] **Step 6: Run the docs checks and commit**

Run: `pnpm docs:check`. Then extract the `opslane_attach_github` function and the step-10 block into scratch files and run `bash -n` on each; both must parse.
Expected: green, no syntax errors.

```bash
git add docs-site/public/INSTALL.md docs-site/public/SKILL.md docs/reference/http-routes.md
git commit -m "docs(runbook): resumable GitHub step, honest summary, and a pull request at the end"
```

---

### Task 10: Full gate, live smoke, and hosted App checklist

**Files:**
- No code. Verification and release notes.

- [ ] **Step 1: Repository gate (under `bash -e`, every check is explicit)**

```bash
set -e
export DATABASE_URL=<disposable db>      # never the shared verify db: its sweepers steal job leases
export MINIO_ENDPOINT=http://localhost:<minio port> MINIO_ACCESS_KEY=minio MINIO_SECRET_KEY=minio12345 MINIO_BUCKET=opslane-replays
export REPLAY_STORE_ENDPOINT="$MINIO_ENDPOINT" REPLAY_STORE_PUBLIC_ENDPOINT="$MINIO_ENDPOINT" REPLAY_STORE_ACCESS_KEY=minio REPLAY_STORE_SECRET_KEY=minio12345 REPLAY_STORE_BUCKET=opslane-replays
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
( cd packages/ingestion && go build ./... && go vet ./... && go test ./... -v 2>&1 | tee /tmp/go-test.log | grep -E '^(ok|FAIL)' )
skips=$(grep -c -- '--- SKIP' /tmp/go-test.log || true); [ "$skips" = "0" ] || { echo "Go skips: $skips"; exit 1; }
docker compose config --quiet
if rg -n StatusBadGateway packages/ingestion/handler/github_*.go packages/ingestion/handler/agent_*.go; then echo "502 still emitted on a GitHub path"; exit 1; fi
```

- [ ] **Step 2: Live smoke on a compose stack (webhook path)**

App-mode token failures are covered by the handler tests with a fake GitHub client; the compose stack has no GitHub App credentials and the API base is a constant, so the live smoke exercises the path that needs no GitHub: the webhook. Add `GITHUB_WEBHOOK_SECRET=smoke-secret` to `.verify/verify.env`, boot the stack (`.verify/setup.json`, ports 8262/5662/9262), then:

1. Register a session (`POST /api/v1/agent/setup`), approve it with a minted HS256 cookie (`JWT_SECRET` from `.verify/verify.env`, the same technique the 2026-09-12 verify run used), and read `state` to confirm `github_installed: false`.
2. Insert a `github_app_installations` row for that org with an ID GitHub does not know and point `orgs.github_installation_id` at it; read `state` again: `github_installed: true`.
3. Send a signed `installation` `deleted` event for that ID (HMAC-SHA256 of the body with `smoke-secret`, header `X-Hub-Signature-256: sha256=<hex>`); expect `{"status":"applied"}`.
4. Read `state`: `github_installed: false`; read `orgs.github_installation_id`: NULL; the row is suspended.
5. Send `installation_repositories` `added` for the same ID with one repo: the row still exists (suspended), so it is known; expect `applied` and the repo appended. Send the same for an unknown ID and expect `ignored`.

Record the transcript under `.verify/runs/<id>/evidence/`.

- [ ] **Step 3: Hosted App configuration (manual, before deploy)**

In the hosted GitHub App settings (GitHub → Settings → Developer settings → GitHub Apps → Opslane → Permissions & events), subscribe to **Installation** and **Installation repositories**. Without this, Task 6 never receives events in prod. Note it in the PR body's release checklist.

- [ ] **Step 4: PR**

Open the PR with the release checklist: migration 076 applies on ingestion boot (drop/re-add of one CHECK; no data change); deploy ingestion first, then the docs site (runbook), then subscribe the App to the two events, then re-run the guardrail onboarding to confirm the GitHub step completes and a pull request opens.

---

## Change log

**Revision 2 (Codex round 1, 24 findings):** migration 076 and `AgentStepNames` for `pull_request` (1); every exact dashboard sequence updated plus a `pull_request` assertion (2); `PersistInstallation` un-suspends on conflict with a reconnect test (3); `RetireGitHubInstallation` is one transaction, org-scoped for on-use healing, and clears a legacy pointer without a rich row; retirement failure answers 500 (4); `GetGitHubAppStatus` reads active installations (5); `ListGitHubRepos` no-installation branch is typed (6); `RepoSelector` emits `load-error`, Settings and SetupWizard reload status (7); combined-install upstream errors become 503 via `errGitHubUpstream`, callback `VerifyInstallation` splits gone from unreachable (8); generic provider callback gets a provider-neutral 503 and its test moves (9); webhook branches decide known/unknown by lookup, switch on every action, and log unknown IDs (10); API error test follows the localStorage-stub + dynamic-import pattern (11); GitHub waits are pauses that keep `.opslane-setup/`, with a three-round cap (12); every capture ends in `|| true`, curl failures read `000`, `retry_after` defaults (13); the finish step captures a recorded summary before deleting state (14); step 10 stages only files absent from the preflight snapshot (15); an existing `opslane-setup` branch is never reused and every git/gh command records failure (16); compare URL derived from the remote, PR URL captured from `gh` (17); gate uses explicit `if rg`, verbose Go output with a skip count, and storage variables (18); smoke exercises the webhook path with a real session and signed events (19); repo adds dedupe input (20); two-tries rule yields to step loops and `attached` is explicit (21); add-repo link passes `GITHUB_PR_URL_OPTIONS` with a rejection test (22); route doc names `PUT /api/v1/projects/{projectID}/github` and the webhook delivery-id caveat (23); `TargetType` dropped (24).
