# mint-key `-scope` Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `cmd/mint-key` mint `ingest` (pk) keys for existing projects as well as its current `sourcemaps` (sk) keys, so operators can re-key live apps after migration 029 destroys legacy `environment_api_keys` rows.

**Architecture:** Add a REQUIRED `-scope` flag (no default: a recovery operator following a truncated command must get a refusal, not a valid-looking wrong credential) that passes through to the existing, fully tested `db.CreateProjectKey`. Scope validation and the per-scope operator instructions become small pure functions in the same `main` package so they are unit-testable without a database; the DB write path needs no new tests (covered by `db` package tests).

**Tech Stack:** Go 1.25, stdlib `flag`, existing `packages/ingestion/db` key model.

## Global Constraints

- No new dependencies. No changes to `db.CreateProjectKey` or any schema.
- `-scope` is REQUIRED (`ingest` or `sourcemaps`, exact strings). The tool is days old; the only "runbook" is our own guide, updated in Task 2. A missing or unknown scope exits 2 with usage.
- The raw key is printed exactly once; never logged or persisted by the tool.
- Verification per package: `cd packages/ingestion && go build ./... && go test ./...` (run in a `golang:1.25` container with the repo mounted at the repo ROOT — the shared `test-fixtures/` are read via `../../../` paths — and `--network host` if the disposable-DB tests should run).
- The printed revocation SQL stays exact-key (`WHERE key_id = ...`), never project-wide (frozen §3.2).

---

### Task 1: Scope flag, validation, and per-scope instructions

**Files:**
- Modify: `packages/ingestion/cmd/mint-key/main.go`
- Test: `packages/ingestion/cmd/mint-key/main_test.go` (new)

**Interfaces:**
- Consumes: `db.ScopeIngest` / `db.ScopeSourcemaps` (string constants, `db/project_keys.go:21-22`), `db.CreateProjectKey(ctx, projectID, scope, label, nil)` (unchanged).
- Produces: `resolveScope(raw string) (string, error)` and `keyInstructions(scope, raw, keyID string) string` — pure, unit-tested; `main()` becomes a thin shell around them.

- [x] **Step 1: Write the failing tests**

Create `packages/ingestion/cmd/mint-key/main_test.go`:

```go
package main

import (
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestResolveScope(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"", "", true},                            // scope is REQUIRED: refusal, not a silent default
		{"sourcemaps", db.ScopeSourcemaps, false},
		{"ingest", db.ScopeIngest, false},
		{"admin", "", true},                       // unknown scope is refused
		{"Ingest", "", true},                      // no case folding: exact values only
	}
	for _, c := range cases {
		got, err := resolveScope(c.in)
		if c.wantErr != (err != nil) {
			t.Fatalf("resolveScope(%q) err = %v, wantErr %v", c.in, err, c.wantErr)
		}
		if got != c.want {
			t.Fatalf("resolveScope(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestKeyInstructionsPerScope(t *testing.T) {
	sk := keyInstructions(db.ScopeSourcemaps, "opslane_sk_x_y", "kid123")
	for _, must := range []string{
		"OPSLANE_SOURCEMAP_KEY", "opslane_sk_x_y", "shown once",
		"WHERE key_id = 'kid123'",
	} {
		if !strings.Contains(sk, must) {
			t.Fatalf("sourcemaps instructions missing %q:\n%s", must, sk)
		}
	}
	if strings.Contains(sk, "VITE_OPSLANE_API_KEY") {
		t.Fatal("sourcemaps instructions must not mention the browser env var")
	}
	if n := strings.Count(sk, "opslane_sk_x_y"); n != 1 {
		t.Fatalf("raw key must appear exactly once, got %d", n)
	}

	pk := keyInstructions(db.ScopeIngest, "opslane_pk_x_y", "kid456")
	for _, must := range []string{
		"VITE_OPSLANE_API_KEY", "opslane_pk_x_y", "redeploy",
		"WHERE key_id = 'kid456'",
	} {
		if !strings.Contains(pk, must) {
			t.Fatalf("ingest instructions missing %q:\n%s", must, pk)
		}
	}
	if strings.Contains(pk, "OPSLANE_SOURCEMAP_KEY") {
		t.Fatal("ingest instructions must not mention the CI secret env var")
	}
	if n := strings.Count(pk, "opslane_pk_x_y"); n != 1 {
		t.Fatalf("raw key must appear exactly once, got %d", n)
	}
}
```

- [x] **Step 2: Run tests to verify they fail**

Run (from repo root — no DB or network needed; this package's tests are pure. The db package's own DB-backed suite is exercised separately in the final verification with `--network host` and a live `DATABASE_URL`):
```bash
docker run --rm -v "$PWD":/repo -v /tmp/gocache:/gocache -w /repo/packages/ingestion \
  -e GOCACHE=/gocache/build -e GOMODCACHE=/gocache/mod golang:1.25 \
  go test ./cmd/mint-key/
```
Expected: FAIL — `resolveScope` and `keyInstructions` undefined.

- [x] **Step 3: Implement**

Replace `packages/ingestion/cmd/mint-key/main.go` with:

```go
// Command mint-key mints a project API key and prints it once. It is the v1
// manual key lifecycle: mint here, revoke with the printed exact-key SQL.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// resolveScope maps the -scope flag to a stored scope value. The flag is
// required and exact: a truncated or typoed recovery command must fail
// loudly, never mint a valid-looking wrong credential.
func resolveScope(raw string) (string, error) {
	switch raw {
	case db.ScopeSourcemaps:
		return db.ScopeSourcemaps, nil
	case db.ScopeIngest:
		return db.ScopeIngest, nil
	case "":
		return "", fmt.Errorf("-scope is required (use %q or %q)", db.ScopeIngest, db.ScopeSourcemaps)
	default:
		return "", fmt.Errorf("unknown scope %q (use %q or %q)", raw, db.ScopeIngest, db.ScopeSourcemaps)
	}
}

// keyInstructions renders the show-once output. The two scopes ship to
// different places: an sk is a CI secret; a pk is public by construction and
// lands in the browser bundle, so it only takes effect when the app
// redeploys.
func keyInstructions(scope, raw, keyID string) string {
	var out string
	switch scope {
	case db.ScopeIngest:
		out = "Ingest key (shown once — not retrievable later):\n" +
			"  " + raw + "\n\n" +
			"Set VITE_OPSLANE_API_KEY (or your app's equivalent) to this value,\n" +
			"then rebuild and redeploy the app: the key ships inside the browser\n" +
			"bundle, so it takes effect on the next app deploy, not on mint.\n"
	default:
		out = "Source-map upload key (shown once — not retrievable later):\n" +
			"  " + raw + "\n\n" +
			"Set OPSLANE_SOURCEMAP_KEY to this value in CI, and/or in the\n" +
			"repo's gitignored .env.local for local production builds.\n"
	}
	out += "\nKey ID (for exact revocation): " + keyID + "\n" +
		"To revoke exactly this key:\n" +
		fmt.Sprintf("  UPDATE project_api_keys SET revoked_at = now() WHERE key_id = '%s';\n", keyID)
	return out
}

func defaultLabel(scope string) string {
	if scope == db.ScopeIngest {
		return "manual ingest key"
	}
	return "ci source maps"
}

func main() {
	projectID := flag.String("project", "", "project UUID")
	scopeFlag := flag.String("scope", "", "REQUIRED key scope: ingest (browser pk) or sourcemaps (CI sk)")
	label := flag.String("label", "", "key label (defaults per scope)")
	flag.Parse()
	if *projectID == "" {
		fmt.Fprintln(os.Stderr, "usage: mint-key -project <uuid> -scope ingest|sourcemaps [-label <text>]")
		os.Exit(2)
	}
	scope, err := resolveScope(*scopeFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if *label == "" {
		*label = defaultLabel(scope)
	}
	if os.Getenv("DATABASE_URL") == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL is required")
		os.Exit(2)
	}

	ctx := context.Background()
	pool, err := db.Connect(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect:", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Print the target's identity before minting so a wrong-but-valid UUID is
	// caught by the operator instead of silently routing another tenant's data.
	var projectName string
	var githubRepo *string
	err = pool.QueryRow(ctx,
		`SELECT name, github_repo FROM projects WHERE id = $1`, *projectID,
	).Scan(&projectName, &githubRepo)
	if err != nil {
		fmt.Fprintf(os.Stderr, "no such project %s: %v\n", *projectID, err)
		os.Exit(1)
	}
	repo := "(no repo)"
	if githubRepo != nil {
		repo = *githubRepo
	}
	fmt.Printf("Minting %s key for project %q (%s, %s)\n\n", scope, projectName, repo, *projectID)

	minted, err := db.New(pool).CreateProjectKey(ctx, *projectID, scope, *label, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "mint:", err)
		os.Exit(1)
	}

	fmt.Print(keyInstructions(scope, minted.Raw, minted.KeyID))
}
```

- [x] **Step 4: Run tests and build**

Same container command as Step 2, plus `go build ./...` first.
Expected: PASS, build clean.

- [x] **Step 5: Commit**

```bash
git add packages/ingestion/cmd/mint-key/
git commit -m "feat(mint-key): -scope flag mints ingest keys for existing projects"
```

---

### Task 2: Docs and live smoke

**Files:**
- Modify: `docs/guides/source-maps.md` (the minting section that documents `go run ./cmd/mint-key` — find it with `grep -n "mint-key" docs/guides/source-maps.md`)

**Interfaces:**
- Consumes: Task 1's flag semantics.
- Produces: operator docs covering both scopes; a proven end-to-end pk mint.

- [x] **Step 1: Update the guide**

Two edits in `docs/guides/source-maps.md`:

1. The existing sk mint example gains the now-required flag:
   `go run ./cmd/mint-key -project <uuid> -scope sourcemaps`.
2. After it, a new subsection:

```md
## Re-keying an app (ingest keys)

To mint a browser ingest key for an existing project (for example when
re-keying an app whose legacy key was removed by an upgrade):

    # find the project UUID first
    psql "$DATABASE_URL" -c "SELECT id, name, github_repo FROM projects;"

    go run ./cmd/mint-key -project <uuid> -scope ingest

The tool prints the project's name and repo before the key — read it and
confirm it is the project you meant. The printed `opslane_pk_` value goes
into the app's build environment (`VITE_OPSLANE_API_KEY` for Vite apps, or
your framework's equivalent public variable); it takes effect when the app
is rebuilt and redeployed, because the key ships inside the browser bundle.

Cutover order when an upgrade removes old keys: deploy the server first,
then mint per project, then update each app's environment and redeploy it.
Ingestion for an app stays down from the server deploy until that app's
redeploy — budget the window accordingly.
```

Run `node scripts/check-docs-drift.mjs` — expected: clean (mint-key flags are not in the drift-checked surfaces, but the guide is covered prose; the check must stay green).

- [x] **Step 2: Live smoke against a disposable database**

With the compose stack from the E2E setup running (or any disposable Postgres with migrations applied and one project row):

```bash
DATABASE_URL=postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable \
  docker run --rm --network host -v "$PWD":/repo -w /repo/packages/ingestion \
  -e DATABASE_URL -e GOCACHE=/gocache/build -e GOMODCACHE=/gocache/mod \
  -v /tmp/gocache:/gocache golang:1.25 \
  go run ./cmd/mint-key -project <seed project uuid> -scope ingest
```

Expected: prints an `opslane_pk_...` key. Prove it works end to end:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "X-API-Key: <printed pk>" -H 'Content-Type: application/json' \
  --data '{"timestamp":"2026-08-04T00:00:00Z","error":{"type":"E","message":"smoke","stack":"E: smoke"},"breadcrumbs":[],"context":{},"sdk_version":"smoke"}' \
  http://localhost:8082/api/v1/events
```
Expected: `202`. Then make the check discriminating, not just status-code green:

```bash
# key row has the right scope and label
docker exec simplify-postgres-1 psql -U opslane -d opslane -c \
  "SELECT scope, label FROM project_api_keys WHERE key_id = '<printed key id>';"
# the event landed under the intended project
docker exec simplify-postgres-1 psql -U opslane -d opslane -c \
  "SELECT project_id FROM error_events ORDER BY created_at DESC LIMIT 1;"
# negative: an ingest key cannot upload maps
curl -s -o /dev/null -w '%{http_code}\n' -X PUT -H "X-API-Key: <printed pk>" \
  --data '{}' http://localhost:8082/api/v1/sourcemaps/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
```
Expected: `ingest | manual ingest key`, the seeded project's UUID, and `403`.

- [x] **Step 3: Commit**

```bash
git add docs/guides/source-maps.md
git commit -m "docs: document mint-key -scope ingest for re-keying existing apps"
```

---

## Self-Review Notes

- Spec coverage: `-scope` flag with validation → Task 1; pk-specific operator guidance (bundle/redeploy semantics) → Task 1 instructions + Task 2 docs; proof a minted pk actually ingests → Task 2 smoke.
- The required-scope refusal is pinned by the `{"", "", true}` test case.
- No placeholder text; all code complete; names (`resolveScope`, `keyInstructions`, `defaultLabel`) consistent across tasks.
