# Remote MCP Server (bearer-token v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a remote MCP server, co-hosted on the Go ingestion service, that Claude Code and Codex connect to over HTTP with a static bearer API key, exposing `opslane_digest`, `opslane_issue`, and `opslane_link_pr`.

**Architecture:** A new `api` scope on the existing `project_api_keys` table (prefix `opslane_ak_`) is the credential; it is project-scoped, so the key selects the project. The MCP transport is `modelcontextprotocol/go-sdk` v1.7.0's streamable-HTTP handler mounted on the chi router at `/mcp`, stateless with JSON responses, authenticated by the SDK bearer verifier over `LookupProjectKey`. The three tools call the same in-process queries the PR #400 dashboard endpoints use.

**Tech Stack:** Go 1.25 (ingestion: chi, pgx), `modelcontextprotocol/go-sdk` v1.7.0 (new dependency), Postgres. Formatter ported from TypeScript (`cli/src/mcp/format.ts`) to Go.

**Spec:** `docs/design/2026-08-22-remote-mcp-bearer-token.md`

## Global Constraints

- Migrations are append-only; treat `001_baseline.sql` as the baseline and add new numbered files. Do not edit `028_project_api_keys.sql`. Make migrations reapply-safe.
- Every database helper enforces tenant scope in its own query (project id, and org id where the caller is a session).
- New server-side code defaults to `AGPL-3.0-only`. This is all ingestion (Go), already AGPL.
- Keep HTTP handlers in `handler/` and database operations in `db/`.
- The `POST /api/v1/events` wire contract is untouched here.
- Verify Go changes with `go build ./...` and `go test ./...` from `packages/ingestion`; apply migrations to a disposable clean DB and a representative existing DB, then reapply.
- No secret is logged. Redaction must cover the new `opslane_ak_` prefix.

---

### Task 1: Migration — add the `api` scope and `opslane_ak_` prefix, plus nullable expiry

**Files:**
- Create: `packages/ingestion/db/migrations/061_api_key_scope.sql` (the tree ends at `060_cutover_backfill.sql`)
- Test: `packages/ingestion/db/migration_api_key_scope_test.go`

**Note on constraint names:** the two CHECK constraints in `028` are inline and unnamed, so their deployed names are Postgres-generated, not declared. Before writing the `DROP CONSTRAINT` lines, discover the real names against a migrated DB with `\d project_api_keys` or `SELECT conname FROM pg_constraint WHERE conrelid = 'project_api_keys'::regclass AND contype = 'c'` (the repo already uses this catalog query in `migrations_test.go`). Use the discovered names, and name the replacement constraints explicitly so future migrations are stable.

**Interfaces:**
- Produces: a `project_api_keys` table that accepts `scope = 'api'` with `token_prefix = 'opslane_ak'`, and an `expires_at TIMESTAMPTZ` column (nullable).

- [ ] **Step 1: Write the failing test**

```go
// migration_api_key_scope_test.go
package db

import (
	"context"
	"testing"
)

func TestMigrationAddsAPIScope(t *testing.T) {
	pool, cleanup := freshMigratedDB(t) // applies all migrations to a disposable DB
	defer cleanup()
	ctx := context.Background()

	orgID, projectID := seedOrgAndProject(t, pool)

	// api scope + opslane_ak prefix is now allowed
	_, err := pool.Exec(ctx,
		`INSERT INTO project_api_keys (key_id, project_id, scope, token_prefix, secret_hash, label)
		 VALUES ($1,$2,'api','opslane_ak',$3,'test')`,
		newKeyID(t), projectID, newSecretHash(t))
	if err != nil {
		t.Fatalf("api-scoped key insert failed: %v", err)
	}

	// existing scopes still work
	for _, tc := range []struct{ scope, prefix string }{{"ingest", "opslane_pk"}, {"sourcemaps", "opslane_sk"}} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO project_api_keys (key_id, project_id, scope, token_prefix, secret_hash, label)
			 VALUES ($1,$2,$3,$4,$5,'t')`,
			newKeyID(t), projectID, tc.scope, tc.prefix, newSecretHash(t)); err != nil {
			t.Fatalf("%s still valid: %v", tc.scope, err)
		}
	}

	// a mismatched scope/prefix is still rejected
	if _, err := pool.Exec(ctx,
		`INSERT INTO project_api_keys (key_id, project_id, scope, token_prefix, secret_hash, label)
		 VALUES ($1,$2,'api','opslane_pk',$3,'t')`,
		newKeyID(t), projectID, newSecretHash(t)); err == nil {
		t.Fatal("expected scope/prefix mismatch to be rejected")
	}

	// expires_at column exists and accepts a value
	if _, err := pool.Exec(ctx, `UPDATE project_api_keys SET expires_at = now() + interval '1 day'`); err != nil {
		t.Fatalf("expires_at column missing: %v", err)
	}
	_ = orgID
}
```

Reuse the existing migration-test helpers if present (see `migration_051_test.go` for the `migrationFiles`/`applyMigration` pattern); if `freshMigratedDB`/`seedOrgAndProject`/`newKeyID`/`newSecretHash` do not exist, add small local helpers in this test file. `key_id` must match `^[a-z2-7]{26}$` and `secret_hash` must match `^[0-9a-f]{64}$`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ingestion && go test ./db -run TestMigrationAddsAPIScope -v`
Expected: FAIL, the `api` insert violates the current scope CHECK.

- [ ] **Step 3: Write the migration**

```sql
-- 061_api_key_scope.sql — add the `api` programmatic key scope (opslane_ak_) and optional expiry.
-- The two CHECK constraints in 028 are inline/unnamed and each reject `api`, so both must be
-- dropped (by their real, discovered names) and re-added as NAMED constraints.
ALTER TABLE project_api_keys
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Replace <scope_check_name> and <prefix_check_name> with the names discovered via \d / pg_constraint.
-- Drop BOTH the old (discovered) name and the new name before re-adding, so the whole file is
-- replay-safe: migrations are reapplied on boot, and ADD CONSTRAINT has no IF NOT EXISTS, so a
-- second run would fail on the already-present new constraint without this second DROP.
ALTER TABLE project_api_keys DROP CONSTRAINT IF EXISTS <scope_check_name>;
ALTER TABLE project_api_keys DROP CONSTRAINT IF EXISTS project_api_keys_scope_check;
ALTER TABLE project_api_keys
  ADD CONSTRAINT project_api_keys_scope_check
  CHECK (scope IN ('ingest', 'sourcemaps', 'api'));

ALTER TABLE project_api_keys DROP CONSTRAINT IF EXISTS <prefix_check_name>;
ALTER TABLE project_api_keys DROP CONSTRAINT IF EXISTS project_api_keys_token_prefix_check;
ALTER TABLE project_api_keys
  ADD CONSTRAINT project_api_keys_token_prefix_check
  CHECK (
    (scope = 'ingest'     AND token_prefix = 'opslane_pk') OR
    (scope = 'sourcemaps' AND token_prefix = 'opslane_sk') OR
    (scope = 'api'        AND token_prefix = 'opslane_ak')
  );
```

The `<…_name>` placeholders are the one discovery step: an environment that predates 028 could carry differently-named constraints, so read them from the target DB rather than assuming the autogenerated form. The extra `DROP … IF EXISTS <new_name>` before each `ADD` is what makes reapply safe.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/ingestion && go test ./db -run TestMigrationAddsAPIScope -v`
Expected: PASS.

- [ ] **Step 5: Verify reapply + existing-DB apply**

Apply the migration to a DB that already has 028 applied, then apply the whole set again to confirm idempotency (guarded `DROP … IF EXISTS` / `ADD COLUMN IF NOT EXISTS` make it safe).

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/db/migrations/061_api_key_scope.sql packages/ingestion/db/migration_api_key_scope_test.go
git commit -m "feat(ingestion): add api key scope and optional expiry to project_api_keys"
```

---

### Task 2: Codec — create and parse `opslane_ak_` keys

**Files:**
- Modify: `packages/ingestion/db/project_keys.go`
- Test: `packages/ingestion/db/project_keys_test.go` (add cases; create if absent)

**Interfaces:**
- Consumes: `NewProjectKey(scope, endpoint string)`, `HashSecret`, `prefixForScope`, `scopeForPrefix` (existing in `project_keys.go`).
- Produces: creating and parsing for `scope = "api"` / prefix `opslane_ak`, with the key format `opslane_ak_<keyid>_<secret>` and NO endpoint payload.

- [ ] **Step 1: Write the failing test**

```go
func TestNewProjectKeyAPIScope(t *testing.T) {
	k, err := NewProjectKey("api", "")
	if err != nil {
		t.Fatalf("create api key: %v", err)
	}
	if k.TokenPrefix != "opslane_ak" {
		t.Fatalf("prefix = %q, want opslane_ak", k.TokenPrefix)
	}
	// api keys are bare: an endpoint must be rejected, like ingest
	if _, err := NewProjectKey("api", "https://example.com"); err == nil {
		t.Fatal("expected endpoint to be rejected for api scope")
	}
	// the created token round-trips through the parser and yields scope "api"
	scope, ok := scopeForPrefix("opslane_ak")
	if !ok || scope != "api" {
		t.Fatalf("scopeForPrefix(opslane_ak) = %q,%v", scope, ok)
	}
}
```

Read the current `NewProjectKey`, `MintedProjectKey`, `prefixForScope`, `scopeForPrefix`, and the parse path first, so the test matches the real return shape (field names like `TokenPrefix`, `KeyID`, `Raw`, `SecretHash`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/ingestion && go test ./db -run TestNewProjectKeyAPIScope -v`
Expected: FAIL (`unknown key scope "api"`).

- [ ] **Step 3: Implement**

In `project_keys.go`: add `ScopeAPI = "api"` and `prefixAPI = "opslane_ak"` constants; add the `case ScopeAPI: return prefixAPI, nil` to `prefixForScope`; add `case prefixAPI: return ScopeAPI, true` to `scopeForPrefix`. The endpoint-required/forbidden logic in `NewProjectKey` already forbids an endpoint for non-`sourcemaps` scopes, so `api` gets bare-key behavior for free once the prefix is known. Confirm the parse path (the function that splits `prefix_keyid_secret` and rejects a payload on non-sourcemaps keys) treats `api` as bare.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/ingestion && go test ./db -run TestNewProjectKeyAPIScope -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/project_keys.go packages/ingestion/db/project_keys_test.go
git commit -m "feat(ingestion): create and parse opslane_ak api keys"
```

---

### Task 3: Lookup — return and enforce `expires_at`

**Files:**
- Modify: `packages/ingestion/db/project_keys.go` (`LookupProjectKey` and its result struct)
- Test: `packages/ingestion/db/project_keys_test.go`

**Interfaces:**
- Produces: `ProjectKeyLookup` (or existing name) gains `ExpiresAt *time.Time`; `LookupProjectKey` selects `expires_at`, and returns the same invalid-credential error when `expires_at` is non-null and in the past. A null `expires_at` means no expiry.

- [ ] **Step 1: Write the failing test**

```go
func TestLookupProjectKeyExpiry(t *testing.T) {
	pool, cleanup := freshMigratedDB(t)
	defer cleanup()
	_, projectID := seedOrgAndProject(t, pool)
	q := &Queries{pool: pool}

	// create an api key, store its hash with expires_at in the past
	k, _ := NewProjectKey("api", "")
	insertKey(t, pool, projectID, k, /*expiresAt*/ past())

	if _, err := q.LookupProjectKey(context.Background(), k.Raw); err == nil {
		t.Fatal("expired key should be rejected")
	}

	// a null-expiry api key is accepted
	k2, _ := NewProjectKey("api", "")
	insertKey(t, pool, projectID, k2, nil)
	if _, err := q.LookupProjectKey(context.Background(), k2.Raw); err != nil {
		t.Fatalf("null-expiry key should be accepted: %v", err)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/ingestion && go test ./db -run TestLookupProjectKeyExpiry -v`
Expected: FAIL (expired key currently accepted; column not selected).

- [ ] **Step 3: Implement**

Add `expires_at` to the `SELECT` in `LookupProjectKey`, scan into `*time.Time`, and after the existing revocation check add: if `ExpiresAt != nil && ExpiresAt.Before(now)` return the same invalid-credential error the revocation path returns. Add `ExpiresAt` to the returned struct so the verifier can read it.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/ingestion && go test ./db -run TestLookupProjectKeyExpiry -v`
Expected: PASS.

- [ ] **Step 5: Regression — full expiry matrix across every caller**

Because `LookupProjectKey` is shared by the ingest/sourcemaps HTTP middleware (`handler/project_keys.go`, used by the events/replay/session/ping/sourcemap routes) and the new MCP verifier, cover: null expiry (accepted), future expiry (accepted), past expiry (rejected), revoked + future expiry (rejected), and the exact boundary against a captured `now`. Assert an `ingest` key with null expiry still authenticates through its middleware, and that the sourcemap path is unaffected. Run `go test ./db ./handler`.

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/db/project_keys.go packages/ingestion/db/project_keys_test.go
git commit -m "feat(ingestion): enforce optional expires_at in project key lookup"
```

---

### Task 4: Redaction and SDK message for the new prefix

**Files:**
- Modify: `packages/ingestion/masking/masking.go` (the `apiKeyPrefixRe` regex used by `RedactBody`)
- Modify: `packages/ingestion/handler/admin.go` (a **second** redactor regex `opslane_(?:pk|sk)_…` lives here)
- Modify: `packages/sdk/src/config.ts` (the key-validation message)
- Test: `packages/ingestion/masking/masking_test.go`; `packages/ingestion/handler/admin_test.go` (extend the `opslane_sk_` canary); `packages/sdk/src/__tests__/init-key-validation.test.ts`

**Interfaces:**
- Produces: `opslane_ak_…` secrets are masked in captured body text, and the SDK's key-validation error names `sk`/`ak` as the secret prefixes not allowed in the browser.

- [ ] **Step 1: Write the failing test**

```go
func TestMaskingRedactsAPIKeyPrefix(t *testing.T) {
	in := `{"note":"token opslane_ak_abcdefghijklmnopqrstuvwxyz_SECRETSECRETSECRETSECRETSECRETSECRETSECRET1"}`
	out := MaskBody([]byte(in)) // use the real entry point
	if strings.Contains(string(out), "SECRET") {
		t.Fatalf("api key secret not masked: %s", out)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/ingestion && go test ./masking -run TestMaskingRedactsAPIKeyPrefix -v`
Expected: FAIL (only `opslane_pk_`/`opslane_sk_` recognized today).

- [ ] **Step 3: Implement**

Add `opslane_ak_` to `apiKeyPrefixRe` in `masking.go` (used by `RedactBody`), and to the second redactor regex in `handler/admin.go` (`opslane_(?:pk|sk)_…` becomes `opslane_(?:pk|sk|ak)_…`). Extend `admin_test.go`'s canary to include an `opslane_ak_` value. In `packages/sdk/src/config.ts`, update the validation message so it names both `opslane_sk_` and `opslane_ak_` as secret prefixes that must not ship in a bundle, and add the `opslane_ak_` case to `init-key-validation.test.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/ingestion && go test ./masking -v` and the SDK unit test.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/masking/masking.go packages/ingestion/masking/masking_test.go packages/sdk/src/config.ts
git commit -m "chore: recognize opslane_ak secrets in redaction and SDK validation"
```

---

### Task 5: Create / list / revoke endpoints (admin, org + project + scope='api')

**Files:**
- Modify: `packages/ingestion/handler/project_keys.go` (or a new `handler/api_keys.go`)
- Modify: `packages/ingestion/handler/routes.go`
- Modify: `packages/ingestion/db/project_keys.go` (create/list/revoke queries scoped by org, project, and `scope='api'`)
- Test: `packages/ingestion/handler/api_keys_test.go`

**Interfaces:**
- Produces: `POST /api/v1/projects/{projectID}/api-keys` (create; optional `expires_at` in the body; returns the plaintext once), `GET …/api-keys` (list, redacted), `DELETE …/api-keys/{keyID}` (revoke; `{keyID}` is the public `key_id`, which the list response exposes). All under `AuthenticateUserSession` + `RequireRoleIfCloud("admin")`, and each handler also calls `verifyProjectAccess` (admin middleware alone is not the full tenancy check; existing project-scoped handlers pair the two). New DB helpers `CreateAPIKey`/`ListAPIKeys`/`RevokeAPIKey` are added; the existing `CreateProjectKey` does a bare `VALUES` insert and is not org-scoped, so model the new ones on the `INSERT … SELECT FROM projects WHERE id=$ AND org_id=$` pattern in `db/notifications.go`.
- Response contract: create returns `201` with `{key_id, token, label, scope:"api", expires_at}` where `token` is the only time the plaintext appears; revoke returns `204` on success, `404` when the key is absent for that org+project+`api` scope (check `RowsAffected`), and is idempotent on an already-revoked key (return `204`).

- [ ] **Step 1: Write the failing test** — create returns a plaintext `opslane_ak_…` once; list shows it redacted; revoke marks it revoked and sets `revoked_by_user_id`; a create for a project in another org fails; list/revoke never return or affect an `ingest`/`sourcemaps` key of the same project.

```go
func TestAPIKeyCreateListRevokeScoped(t *testing.T) {
	// seed org A with projectA; also insert an ingest key on projectA directly.
	// create via handler as an admin of org A -> returns opslane_ak_ plaintext once.
	// list -> exactly one entry (the api key), redacted, no secret, ingest key absent.
	// create against a project in org B (admin only of A) -> 403/404, no row created.
	// revoke the api key -> revoked_at set, revoked_by_user_id set; ingest key untouched.
}
```

- [ ] **Step 2: Run to verify it fails** — `go test ./handler -run TestAPIKeyCreateListRevokeScoped -v` (routes/handlers absent).

- [ ] **Step 3: Implement** — DB: `CreateAPIKey` creates via `NewProjectKey("api","")` then `INSERT INTO project_api_keys (key_id, project_id, scope, token_prefix, secret_hash, label, created_by_user_id, expires_at) SELECT $keyid, p.id, 'api','opslane_ak', $hash, $label, $userID, $expires FROM projects p WHERE p.id=$projectID AND p.org_id=$orgID` (org-scoped like `db/notifications.go`); `ListAPIKeys(orgID, projectID)` and `RevokeAPIKey(orgID, projectID, keyID, byUserID)` both filter `project_id=$projectID AND scope='api'` and join `projects` on `org_id=$orgID`; revoke sets `revoked_at=now(), revoked_by_user_id=$userID` and returns `RowsAffected`. Handlers call `verifyProjectAccess`, return the created plaintext once, and map list rows to `{key_id, label, created_by, created_at, last_used_at, expires_at, redacted: "opslane_ak_<key_id>_…"}`. Register the three routes (`POST`/`GET` on `/projects/{projectID}/api-keys`, `DELETE` on `/projects/{projectID}/api-keys/{keyID}`) with `AuthenticateUserSession, RequireRoleIfCloud("admin")` (mirror the project-settings routes in `routes.go`).

- [ ] **Step 4: Run to verify it passes** — `go test ./handler -run TestAPIKeyCreateListRevokeScoped -v`.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/api_keys.go packages/ingestion/handler/routes.go packages/ingestion/db/project_keys.go packages/ingestion/handler/api_keys_test.go
git commit -m "feat(ingestion): admin api-key create/list/revoke scoped to org, project, and api scope"
```

---

### Task 6: MCP transport and bearer auth at `/mcp`

**Files:**
- Create: `packages/ingestion/handler/mcp.go` (transport wiring + verifier)
- Modify: `packages/ingestion/handler/routes.go` (mount before SPA catch-all)
- Modify: `packages/ingestion/go.mod` / `go.sum` (add `github.com/modelcontextprotocol/go-sdk v1.7.0`)
- Test: `packages/ingestion/handler/mcp_auth_test.go`

**Interfaces:**
- Consumes: `LookupProjectKey` (Task 3).
- Produces: a mounted `/mcp` handler; a `TokenVerifier` that requires `scope == "api"`, sets `AllowMissingExpiration: true`, and puts `project_id`, `org_id`, `key_id` into the tool context. Registers a single trivial tool for this task (real tools land in later tasks) or gate on `tools/list`.

- [ ] **Step 1: Write the failing test**

```go
func TestMCPBearerAuth(t *testing.T) {
	// build the router with a real DB; seed an api key, an ingest key, a revoked api key, an expired api key.
	// POST /mcp with no Authorization -> 401
	// with a valid api key -> initialize/tools/list succeeds (200)
	// with the ingest key -> 403 (valid token, missing required `api` scope: the SDK returns
	//   403 insufficient_scope, NOT 401 — 401 is for missing/invalid/revoked/expired)
	// with the revoked key -> 401
	// with the expired key -> 401
	// on a forced DB lookup error -> 500 (an infra failure is not an auth failure)
}
```

Use the go-sdk client or a raw JSON-RPC `initialize` + `tools/list` over HTTP. Assert status, not tool behavior. Also assert the token never appears in captured logs.

- [ ] **Step 2: Run to verify it fails** — `go test ./handler -run TestMCPBearerAuth -v`.

- [ ] **Step 3: Implement**

Add the dependency (`go get github.com/modelcontextprotocol/go-sdk@v1.7.0`; update `go.mod` and `go.sum`). Alias the imports to avoid a name clash with the internal formatter package: `mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"` and `mcpformat "github.com/opslane/opslane/packages/ingestion/mcp"`.

The constructor takes a request-to-server callback, not a `*Server`:

```go
server := mcpsdk.NewServer(&mcpsdk.Implementation{Name: "opslane", Version: "…"}, nil)
// register a trivial tool for this task
handler := mcpsdk.NewStreamableHTTPHandler(
    func(*http.Request) *mcpsdk.Server { return server },
    &mcpsdk.StreamableHTTPOptions{Stateless: true, JSONResponse: true, MaxRequestBodyBytes: 1 << 20},
)
```

The verifier must translate the DB sentinel into the SDK's invalid-token error, or a bad key becomes a 500 instead of a 401:

```go
verifier := func(ctx context.Context, token string, _ *http.Request) (*auth.TokenInfo, error) {
    lk, err := deps.Queries.LookupProjectKey(ctx, token)
    if errors.Is(err, db.ErrProjectKeyInvalid) {
        return nil, fmt.Errorf("invalid api key: %w", auth.ErrInvalidToken) // -> 401
    }
    if err != nil {
        return nil, err // infra failure -> 500
    }
    exp := time.Time{} // TokenInfo.Expiration is a non-pointer time.Time
    if lk.ExpiresAt != nil {
        exp = *lk.ExpiresAt
    }
    return &auth.TokenInfo{
        Scopes:     []string{lk.Scope},
        Expiration: exp,
        Extra:      map[string]any{"project_id": lk.ProjectID, "org_id": lk.OrgID, "key_id": lk.KeyID},
    }, nil
}
```

Wrap with `RequireBearerToken(verifier, &RequireBearerTokenOptions{Scopes: []string{"api"}, AllowMissingExpiration: true})` (without `AllowMissingExpiration`, a null-expiry key 401s). Mount `/mcp` before the SPA catch-all in `routes.go`.

Rate limiting: the existing `rateLimitByProject` reads `ProjectIDFromCtx`, which the SDK bearer path does not populate. Add a small middleware, ordered after `RequireBearerToken`, that reads `project_id` from the verified `TokenInfo.Extra` and writes it into the request context via the same key the handler layer uses, then the existing limiter works; or write an MCP-specific limiter keyed off `TokenInfo`. Cover it with a valid-token rate-limit test.

Emit structured auth-outcome logs (ok / missing / invalid / wrong_scope / expired / lookup_error) and an MCP auth metric (mirror `metrics.go`); never log the token.

- [ ] **Step 4: Run to verify it passes** — `go test ./handler -run TestMCPBearerAuth -v`.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/mcp.go packages/ingestion/handler/routes.go packages/ingestion/handler/mcp_auth_test.go packages/ingestion/go.mod packages/ingestion/go.sum
git commit -m "feat(ingestion): mount remote MCP transport with api-key bearer auth"
```

---

### Task 7: Port the formatter to Go with parity tests

**Files:**
- Create: `packages/ingestion/mcp/format.go` (new package for MCP presentation)
- Test: `packages/ingestion/mcp/format_test.go`

**Interfaces:**
- Produces: `Fence`, `Truncate`, `IsFillerRootCause`, `ClampPayload` in a new `packages/ingestion/mcp` package. `FormatDigest`/`FormatIssue` and their DTOs (`DigestCard`, `McpIncident`, `IssueEvidence`, ported from `cli/src/mcp/types.ts`) land with their tools in Tasks 8 and 9. The DTOs are exported and live in this package so the handler converts DB rows into them; the handler imports the formatter, never the reverse, so there is no import cycle. (Note `clampPayload` is private in the TS file; the Go `ClampPayload` can be package-private too, tested within the package.)

- [ ] **Step 1: Write the failing tests** — port ONLY the helper-level cases here (the `formatDigest` cases move to Task 8 and the `formatIssue` cases to Task 9, since those functions do not exist yet): fence neutralizes `</untrusted>` and `<untrusted>` (case-insensitive) to `[removed]`; `Truncate` slices by rune and appends `... [truncated]`; `ClampPayload` keeps the UTF-8 byte length ≤ 8192 and closes an open `<untrusted>` fence within budget; `IsFillerRootCause` matches the anchored placeholder/tbd regex. Source the cases from the helper assertions in `cli/src/__tests__/mcp-format.test.ts`.

- [ ] **Step 2: Run to verify they fail** — `cd packages/ingestion && go test ./mcp -v` (package/functions absent).

- [ ] **Step 3: Implement** — port `format.ts:9-52` and `clampPayload` (`format.ts:145-162`) to Go. Use `[]rune` for code-point slicing and `utf8.RuneCountInString`; use `regexp` for the fence-strip and filler patterns; byte-budget with `len([]byte(s))`.

- [ ] **Step 4: Run to verify they pass** — `go test ./mcp -v`.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/mcp/format.go packages/ingestion/mcp/format_test.go
git commit -m "feat(ingestion): port MCP formatter primitives to Go with parity tests"
```

---

### Task 8: `opslane_digest` tool, end to end

**Files:**
- Modify: `packages/ingestion/mcp/format.go` (add `FormatDigest`)
- Modify: `packages/ingestion/handler/mcp.go` (register `opslane_digest`)
- Test: `packages/ingestion/mcp/format_test.go`; `packages/ingestion/handler/mcp_digest_test.go`

**Interfaces:**
- Consumes: `Queries.LatestDeliveredDigest(ctx, projectID)` (`db/queries.go`), the project id from the token context, and a chosen project-label source (project id for v1; if the DB name/repo is used it must be fenced).
- Produces: `opslane_digest` returns the formatted digest text.

- [ ] **Step 1: Write the failing tests** — `FormatDigest` parity test converted from `mcp-digest.test.ts` (asserting the chosen label format, fenced fields, and the "call opslane_issue" line); a decode test since `LatestDeliveredDigest` returns `cards []byte` (JSON) that must unmarshal into `[]DigestCard`, including the SQL/JSON `null` case (no delivered run → empty digest, not a crash); an e2e handler test that seeds a delivered `digest_runs` row (`scripts/seed-e2e.sql` has none; copy the `INSERT INTO digest_runs (project_id, window_from, window_to, run_date, status, rendered_payload) VALUES (…, 'delivered', $::jsonb)` shape from `handler/read_api_digest_latest_test.go`), creates an api key, and calls `opslane_digest` over the transport.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** — port `formatDigest` (`format.ts:22-45`); decide the label (project id for v1); register the tool to call `LatestDeliveredDigest(projectID)` and return `FormatDigest(...)`.

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/mcp/format.go packages/ingestion/handler/mcp.go packages/ingestion/mcp/format_test.go packages/ingestion/handler/mcp_digest_test.go
git commit -m "feat(ingestion): opslane_digest MCP tool over the remote transport"
```

---

### Task 9: Shared incident presenter and `opslane_issue`

**Files:**
- Create: `packages/ingestion/handler/incident_present.go` (extract the shared presenter)
- Modify: `packages/ingestion/handler/read_api.go` (the #400 handler calls the shared presenter)
- Modify: `packages/ingestion/mcp/format.go` (add `FormatIssue`)
- Modify: `packages/ingestion/handler/mcp.go` (register `opslane_issue`)
- Test: `packages/ingestion/mcp/format_test.go`; `packages/ingestion/handler/mcp_issue_test.go`

**Interfaces:**
- Consumes: `Queries.GetErrorGroup` (the DB read; note `GetIncident` is the HTTP *handler*, not a DB method), `Queries.IssueEvidence`, `attachPipelineState`, and the `toIncidentJSON` pending/ineligible suppression currently in `read_api.go`.
- Produces: a presenter (in `handler/`, since it uses unexported handler types) returning a subset that maps into the exported `mcpformat.McpIncident`/`IssueEvidence` DTOs. It must reproduce exactly what `formatIssue` reads (id, kind, title, status, counts, root_cause with pending/ineligible suppression, pr_url, route, selector, derived state, evidence frames/failed-requests with nil→empty and availability) and nothing more. It must NOT include the extra enrichments `GetIncident` adds for the dashboard (agent brief, receipts/recordings, required environments, trace/replay/session pointers), because `formatIssue` never reads them.

- [ ] **Step 1: Write the failing tests** — `FormatIssue` parity test from `mcp-format.test.ts` (pending diagnosis hides root cause; resolved issue shows frames; customer text fenced); a handler test that the shared presenter yields the same suppression the dashboard endpoint does.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** — extract the presenter from `read_api.go` (`toIncidentJSON` suppression ~181, `attachPipelineState` ~308, and the incident assembly in the `GetIncident` handler ~545) into `incident_present.go` in the same `handler` package (moving unexported functions there is safe). Have the `GetIncident` HTTP handler and the MCP tool both call it, but keep their differing pipeline-failure policy: the single-incident path stays best-effort (omit derived state on failure), and the extraction must not change the existing HTTP response. Port `formatIssue` (`format.ts:76-136`) into `mcpformat.FormatIssue`, converting the presenter output into the `McpIncident`/`IssueEvidence` DTOs.

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/incident_present.go packages/ingestion/handler/read_api.go packages/ingestion/mcp/format.go packages/ingestion/handler/mcp.go packages/ingestion/mcp/format_test.go packages/ingestion/handler/mcp_issue_test.go
git commit -m "feat(ingestion): shared incident presenter and opslane_issue MCP tool"
```

---

### Task 10: `opslane_link_pr`

**Files:**
- Modify: `packages/ingestion/handler/mcp.go` (register `opslane_link_pr`)
- Modify: `packages/ingestion/handler/read_api.go` / a shared link op (reuse `parseGitHubPR` and `Queries.LinkPR`)
- Test: `packages/ingestion/handler/mcp_link_pr_test.go`

**Interfaces:**
- Consumes: `parseGitHubPR`, `Queries.LinkPR` and its typed errors (`ErrPRAlreadyLinked`, `ErrPRRepoMismatch`, `ErrIncidentNotFound`).
- Produces: `opslane_link_pr(id, url)` that validates the URL, links the PR, and returns the typed refusals as tool output; it skips the post-write incident refetch.

- [ ] **Step 1: Write the failing test** — linking a valid PR to a seeded incident drives it to `pr_created`; an already-linked incident returns the "already linked" refusal; a foreign-repo URL returns the repo-mismatch refusal; a bad URL is rejected by `parseGitHubPR`.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — factor a shared `linkPR(projectID, incidentID, url)` used by both the #400 handler and the tool; map the three sentinel errors to distinct tool messages. Decide the `isError` contract for the tool (surface a failed link as an MCP error, not plain success text).

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/mcp.go packages/ingestion/handler/read_api.go packages/ingestion/handler/mcp_link_pr_test.go
git commit -m "feat(ingestion): opslane_link_pr MCP tool with typed refusals"
```

---

### Task 11: Dashboard token UI

**Files:**
- Modify: `packages/dashboard/src/api.ts` and `packages/dashboard/src/types/api.ts` (the `APIKey` type only allows `scope: 'ingest' | 'sourcemaps'` and has no `expires_at`, `key_id`-as-delete-id, or redacted display value; extend it and add the create/list/revoke client calls)
- Modify: `packages/dashboard/src/views/Settings.vue` (there is already a placeholder panel around line 845 saying key management is coming later)
- Test: `packages/dashboard/src/views/__tests__/Settings.test.ts` (extend the API mocks)

**Interfaces:**
- Consumes: the Task 5 endpoints.
- Produces: create (shows the plaintext once with copy + paste instructions), list (redacted), revoke.

- [ ] **Step 1: Write the failing tests** — component tests for: load on project/tab change; create calls `POST …/api-keys` and renders the returned plaintext exactly once with a copy/acknowledge affordance; list renders redacted rows with label and expiry; revoke calls `DELETE …/api-keys/{key_id}` behind a confirm and handles the error path; admin-versus-non-admin visibility; empty/loading/error states.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — extend `APIKey` to include `'api'` scope and `expires_at`; add the client calls in `api.ts`; replace the placeholder in `Settings.vue` with the panel, labeled clearly as a secret credential (paste instructions for Claude Code / Codex in env-var form); update `Settings.test.ts` mocks.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src
git commit -m "feat(dashboard): API key management panel for MCP"
```

---

### Task 12: Remove the local MCP CLI (separate PR, after the remote path is live)

**Files:**
- Delete: `cli/src/mcp/*` and its tests (`cli/src/__tests__/mcp-*.test.ts`), `cli/src/init-claude.ts` and `cli/src/__tests__/init-claude.test.ts`.
- Modify: `cli/src/index.ts` (remove the `mcp` and `init-claude` command registrations and their dynamic imports, ~lines 175–202).
- Modify: `cli/package.json` (drop the `@modelcontextprotocol/sdk` dependency; review the `build` script which runs `scripts/embed-skill.mjs`).
- Remove if now unused: `cli/scripts/embed-skill.mjs` and `cli/skills/opslane/SKILL.md`.
- Update: the workspace lockfile (`pnpm-lock.yaml`) and any docs/command-help referencing `opslane mcp` / `opslane init-claude`.

**Precondition:** the remote MCP path (Tasks 1–8, at least digest) is deployed and the connect docs describe the remote-server + API-key flow. `init-claude` is today's mechanism for configuring the integration, so its replacement (the dashboard flow plus copy-paste client config) must exist before this deletion.

- [ ] **Step 1** Confirm the remote path is deployed and the replacement connect docs are published.
- [ ] **Step 2** Remove the commands, tests, dependency, and now-unused embed/skill assets; run `pnpm install`, `pnpm --filter @opslane/cli build`, and `pnpm --filter @opslane/cli test`.
- [ ] **Step 3** Update `docs/` connect instructions to the remote-MCP + API-key flow.
- [ ] **Step 4: Commit** on its own PR.

---

## Self-Review

- **Spec coverage:** every design-doc section maps to a task — credential (Tasks 1-5), transport/auth (Task 6), formatter (Task 7), the three tools (Tasks 8-10), dashboard (Task 11), CLI removal (Task 12). The two blockers Codex raised are covered: the migration drops/recreates both CHECK constraints (Task 1) and `AllowMissingExpiration: true` is set in the verifier (Task 6). The scope='api' management filter is in Task 5; redaction + SDK message in Task 4; the digest seed gap and label choice in Task 8.
- **Placeholder scan:** exact file paths and test code are given. The one intentional discovery step is the two `<…_check_name>` values in the Task 1 migration: 028's CHECK constraints are inline/unnamed, so their deployed names must be read from the target DB before the `DROP` lines. Everything else is concrete.
- **Codex round 1 fixes folded in:** migration is `061` and drops/re-adds both (unnamed) constraints; the go-sdk `NewStreamableHTTPHandler` takes a request-to-server callback; the verifier wraps `auth.ErrInvalidToken` so bad keys are 401 not 500, and converts nullable expiry to a zero `time.Time` with `AllowMissingExpiration`; the MCP path sets project context before the existing rate limiter; `DELETE` is a member route keyed by public `key_id`; list/revoke filter `scope='api'` and handlers add `verifyProjectAccess`; the second redactor in `handler/admin.go` and the SDK message/test are included; parity tests are split (helpers in Task 7, digest in Task 8, issue in Task 9); the formatter package holds exported DTOs so there is no import cycle, with `mcpsdk`/`mcpformat` aliases; the expiry test matrix spans null/future/past/revoked/boundary across ingest, sourcemaps, and MCP; Tasks 11 and 12 name concrete files and the CLI-removal scope.
- **Type consistency:** `ScopeAPI`/`prefixAPI`, `opslane_ak`, and `expires_at` are used consistently across Tasks 1-6; the formatter names (`Fence`/`Truncate`/`ClampPayload`/`FormatDigest`/`FormatIssue`) are consistent across Tasks 7-9.
