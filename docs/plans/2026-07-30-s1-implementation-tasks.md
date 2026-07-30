# S1 Project Keys Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the single API key into a public ingest key and a secret source-map key, with the permission stored in the database, and move incident reads behind a user session.

**Architecture:** A new `project_api_keys` table replaces `environment_api_keys`. Keys look like `opslane_pk_<key_id>_<secret>`. Authentication loads one row by `key_id` and compares a SHA-256 hash in constant time; authorization reads the row's `scope` column. One middleware constructor does both in a single pass so a route cannot be authenticated without also being scoped. The key no longer carries an environment, so the middleware resolves the project's `production` row instead.

**Tech Stack:** Go 1.25 (chi v5, pgx v5), PostgreSQL, TypeScript (Vitest), Vue 3.

**Design doc:** `docs/design/2026-07-30-s1-project-keys.md`
**Scope decisions and review history:** `docs/plans/2026-07-30-s1-project-keys-implementation.md`

**Before you start.** The database is being recreated, not migrated. Existing `def_` keys stop working on purpose. Run every Go command from `packages/ingestion/`.

**Task order is load-bearing.** Every task ends with a commit and the tree must compile at
each one. Two orderings matter and are easy to get wrong:

- The metric (Task 4) lands before the middleware that calls it (Task 5).
- `environment_api_keys` comes from `001_baseline.sql:34` and is **dropped in a new
  migration 029**, which lands only in Task 7, after the last Go reference is gone. Dropping it earlier makes
  `provisionProjectTx` (`db/queries.go:242`) fail with `relation "environment_api_keys"
  does not exist`, which breaks the setup path of every database test written before then.

**Environment facts the commands depend on.** Getting any of these wrong wastes an hour:

| Thing | Value | Source |
|---|---|---|
| Build target | `go build -o /tmp/ingestion .` | no `cmd/` directory exists; `packages/ingestion/main.go` |
| Postgres password | `opslane_dev`, not `opslane` | `docker-compose.yml:28` |
| Server port | defaults to **8080**; set `PORT=8082` | `packages/ingestion/main.go:27-30` |
| `JWT_SECRET` | required, at least 32 bytes, or the process exits | `packages/ingestion/main.go:65-69` |
| CLI endpoint | defaults to `https://api.opslane.com`; set `OPSLANE_API_URL` | `cli/src/config.ts:10` |

**Response codes you will need.** `POST /api/v1/events` returns **202**, not 200
(`handler/error_event.go:243`). Its body is nested, not flat
(`handler/error_event.go:60-73`):

```json
{"timestamp":"2026-07-30T00:00:00Z","error":{"type":"Error","message":"smoke","stack":"x"}}
```

`POST /api/v1/replays/init` returns **201** (`handler/replay.go:162`). Do not assume 200
for any route; check the handler.

---

## Task 1: Key format (mint and parse)

Pure functions, no database. Do this first because everything else depends on the format being right.

**Files:**
- Create: `packages/ingestion/db/project_keys.go`
- Test: `packages/ingestion/db/project_keys_test.go`

**Step 1: Write the failing test**

Create `packages/ingestion/db/project_keys_test.go`:

```go
package db

import (
	"regexp"
	"strings"
	"testing"
)

var (
	keyIDPattern = regexp.MustCompile(`^[a-z2-7]{26}$`)
	secretPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

func TestNewProjectKeyFormat(t *testing.T) {
	for _, scope := range []string{ScopeIngest, ScopeSourcemaps} {
		minted, err := NewProjectKey(scope)
		if err != nil {
			t.Fatalf("NewProjectKey(%q): %v", scope, err)
		}
		if !keyIDPattern.MatchString(minted.KeyID) {
			t.Errorf("key_id %q does not match %v", minted.KeyID, keyIDPattern)
		}
		parts := strings.SplitN(minted.Raw, "_", 4)
		if len(parts) != 4 {
			t.Fatalf("raw key %q did not split into 4 parts", minted.Raw)
		}
		if !secretPattern.MatchString(parts[3]) {
			t.Errorf("secret %q does not match %v", parts[3], secretPattern)
		}
		if minted.SecretHash == "" || len(minted.SecretHash) != 64 {
			t.Errorf("secret_hash %q is not 64 hex chars", minted.SecretHash)
		}
	}
}

func TestNewProjectKeyPrefixMatchesScope(t *testing.T) {
	ingest, err := NewProjectKey(ScopeIngest)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ingest.Raw, "opslane_pk_") {
		t.Errorf("ingest key %q does not start with opslane_pk_", ingest.Raw)
	}
	if ingest.TokenPrefix != "opslane_pk" {
		t.Errorf("TokenPrefix = %q, want opslane_pk", ingest.TokenPrefix)
	}

	sm, err := NewProjectKey(ScopeSourcemaps)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(sm.Raw, "opslane_sk_") {
		t.Errorf("sourcemaps key %q does not start with opslane_sk_", sm.Raw)
	}
}

func TestNewProjectKeyRejectsUnknownScope(t *testing.T) {
	if _, err := NewProjectKey("admin"); err == nil {
		t.Fatal("NewProjectKey(\"admin\") should have failed")
	}
}

// The secret is base64url, whose alphabet contains "_". A parser that splits
// into a fixed number of parts rejects roughly half of all minted keys. This
// test uses a hand-built key whose secret contains underscores so the bug
// cannot hide behind a lucky fixture.
func TestParseProjectKeySecretContainingUnderscores(t *testing.T) {
	keyID := "mzxw6ytboi3damrrgi3tknzxgq"
	secret := "a_b_c_deFGHIJKLMNOPQRSTUVWXYZ0123456789-_x"
	if len(secret) != 42 {
		t.Fatalf("fixture setup: secret is %d chars, adjust it", len(secret))
	}
	secret += "Z" // 43
	raw := "opslane_pk_" + keyID + "_" + secret

	parsed, err := ParseProjectKey(raw)
	if err != nil {
		t.Fatalf("ParseProjectKey: %v", err)
	}
	if parsed.KeyID != keyID {
		t.Errorf("KeyID = %q, want %q", parsed.KeyID, keyID)
	}
	if parsed.Secret != secret {
		t.Errorf("Secret = %q, want %q", parsed.Secret, secret)
	}
	if parsed.Scope != ScopeIngest {
		t.Errorf("Scope = %q, want %q", parsed.Scope, ScopeIngest)
	}
}

func TestParseProjectKeyRoundTrip(t *testing.T) {
	minted, err := NewProjectKey(ScopeIngest)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseProjectKey(minted.Raw)
	if err != nil {
		t.Fatalf("ParseProjectKey(%q): %v", minted.Raw, err)
	}
	if parsed.KeyID != minted.KeyID {
		t.Errorf("KeyID = %q, want %q", parsed.KeyID, minted.KeyID)
	}
	if HashSecret(parsed.Secret) != minted.SecretHash {
		t.Error("re-hashed secret does not match the minted hash")
	}
}

func TestParseProjectKeyRejects(t *testing.T) {
	cases := map[string]string{
		"empty":            "",
		"legacy def_":      "def_2f1c9a44-1b3e-4f4a-9c7a-4b2d8e6f0a11",
		"wrong vendor":     "acme_pk_mzxw6ytboi3damrrgi3tknzxgq_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"unknown type":     "opslane_zz_mzxw6ytboi3damrrgi3tknzxgq_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"three parts":      "opslane_pk_mzxw6ytboi3damrrgi3tknzxgq",
		"key_id too short": "opslane_pk_mzxw6ytboi3damrrgi3tknzx_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"key_id uppercase": "opslane_pk_MZXW6YTBOI3DAMRRGI3TKNZXGQ_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"key_id has 0/1":   "opslane_pk_01xw6ytboi3damrrgi3tknzxgq_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"secret too short": "opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_AAAA",
		"secret bad char":  "opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!A",
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseProjectKey(raw); err == nil {
				t.Errorf("ParseProjectKey(%q) should have failed", raw)
			}
		})
	}
}

func TestHashSecretIsStable(t *testing.T) {
	// sha256("test") as hex.
	const want = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
	if got := HashSecret("test"); got != want {
		t.Errorf("HashSecret(\"test\") = %q, want %q", got, want)
	}
}
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/ingestion && go test ./db -run 'ProjectKey|HashSecret' -v
```

Expected: compile failure, `undefined: NewProjectKey`, `undefined: ScopeIngest`.

**Step 3: Write the implementation**

Create `packages/ingestion/db/project_keys.go`:

```go
package db

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
)

// Key scopes. The value stored in project_api_keys.scope is the only thing
// that grants permission; the textual prefix is a hint for humans and secret
// scanners, and a CHECK constraint keeps the two in agreement.
const (
	ScopeIngest     = "ingest"
	ScopeSourcemaps = "sourcemaps"
)

const (
	prefixIngest     = "opslane_pk"
	prefixSourcemaps = "opslane_sk"

	keyIDBytes  = 16 // -> 26 base32 chars
	secretBytes = 32 // -> 43 base64url chars
)

var (
	keyIDRe  = regexp.MustCompile(`^[a-z2-7]{26}$`)
	secretRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

	base32NoPad = base32.StdEncoding.WithPadding(base32.NoPadding)
)

// MintedProjectKey is the result of minting. Raw exists only here and in the
// creation response; the database stores SecretHash.
type MintedProjectKey struct {
	// ID is the project_api_keys row UUID. projects.provisioning_key_id is a
	// UUID column, so KeyID (base32 text) cannot substitute for it.
	ID          string
	KeyID       string
	Scope       string
	TokenPrefix string
	SecretHash  string
	Raw         string
}

// ParsedProjectKey is what a presented credential decomposes into. Scope here
// is what the *prefix* claims. The caller must still check it against the
// scope stored on the row.
type ParsedProjectKey struct {
	KeyID  string
	Secret string
	Scope  string
}

func prefixForScope(scope string) (string, error) {
	switch scope {
	case ScopeIngest:
		return prefixIngest, nil
	case ScopeSourcemaps:
		return prefixSourcemaps, nil
	default:
		return "", fmt.Errorf("unknown key scope %q", scope)
	}
}

func scopeForPrefix(prefix string) (string, bool) {
	switch prefix {
	case prefixIngest:
		return ScopeIngest, true
	case prefixSourcemaps:
		return ScopeSourcemaps, true
	default:
		return "", false
	}
}

// HashSecret returns the lowercase hex SHA-256 of the secret half of a key.
// Unsalted on purpose: the secret is 256 random bits, so there is no
// dictionary to precompute against, and a per-row salt would prevent nothing.
func HashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// NewProjectKey mints a credential. The raw value is returned once and never
// recoverable afterwards.
func NewProjectKey(scope string) (*MintedProjectKey, error) {
	prefix, err := prefixForScope(scope)
	if err != nil {
		return nil, err
	}

	idRaw := make([]byte, keyIDBytes)
	if _, err := rand.Read(idRaw); err != nil {
		return nil, fmt.Errorf("generate key id: %w", err)
	}
	secretRaw := make([]byte, secretBytes)
	if _, err := rand.Read(secretRaw); err != nil {
		return nil, fmt.Errorf("generate key secret: %w", err)
	}

	keyID := strings.ToLower(base32NoPad.EncodeToString(idRaw))
	secret := base64.RawURLEncoding.EncodeToString(secretRaw)

	return &MintedProjectKey{
		KeyID:       keyID,
		Scope:       scope,
		TokenPrefix: prefix,
		SecretHash:  HashSecret(secret),
		Raw:         prefix + "_" + keyID + "_" + secret,
	}, nil
}

// ParseProjectKey splits a presented credential.
//
// SplitN with n=4 is load-bearing. base64url's alphabet includes "_", so about
// 49% of 43-character secrets contain at least one. Splitting into a fixed
// number of parts would reject roughly half of every key this package mints,
// non-deterministically. Part four is the entire remainder.
func ParseProjectKey(raw string) (*ParsedProjectKey, error) {
	parts := strings.SplitN(raw, "_", 4)
	if len(parts) != 4 {
		return nil, fmt.Errorf("malformed key")
	}
	scope, ok := scopeForPrefix(parts[0] + "_" + parts[1])
	if !ok {
		return nil, fmt.Errorf("malformed key")
	}
	if !keyIDRe.MatchString(parts[2]) {
		return nil, fmt.Errorf("malformed key")
	}
	if !secretRe.MatchString(parts[3]) {
		return nil, fmt.Errorf("malformed key")
	}
	return &ParsedProjectKey{KeyID: parts[2], Secret: parts[3], Scope: scope}, nil
}
```

**Step 4: Run the test to verify it passes**

```bash
cd packages/ingestion && go test ./db -run 'ProjectKey|HashSecret' -v
```

Expected: all PASS. If `TestParseProjectKeySecretContainingUnderscores` fails, the parser is wrong; do not adjust the fixture.

**Step 5: Commit**

```bash
git add packages/ingestion/db/project_keys.go packages/ingestion/db/project_keys_test.go
git commit -m "feat(ingestion): add project key mint and parse"
```

---

## Task 2: Migration 028

**Files:**
- Create: `packages/ingestion/db/migrations/028_project_api_keys.sql`

**Step 1: Write the migration**

```sql
-- 028_project_api_keys.sql
-- Project-scoped API keys with the permission stored as data.
-- Append-only after 027. run-migrations.sh re-applies every file on every
-- start, so every statement here must be safe to run twice.

CREATE TABLE IF NOT EXISTS project_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id TEXT NOT NULL UNIQUE
    CHECK (key_id ~ '^[a-z2-7]{26}$'),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('ingest', 'sourcemaps')),
  token_prefix TEXT NOT NULL
    CHECK (
      (scope = 'ingest'     AND token_prefix = 'opslane_pk') OR
      (scope = 'sourcemaps' AND token_prefix = 'opslane_sk')
    ),
  secret_hash TEXT NOT NULL UNIQUE
    CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  label TEXT NOT NULL
    CHECK (label = btrim(label) AND char_length(label) BETWEEN 1 AND 100),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK (revoked_at IS NOT NULL OR revoked_by_user_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_project_api_keys_project_created
  ON project_api_keys(project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_project_api_keys_project_active_scope
  ON project_api_keys(project_id, scope)
  WHERE revoked_at IS NULL;

-- Environment becomes a label the SDK sends, defaulting to production.
-- The column stays (queries still project it); only the default changes.
ALTER TABLE projects ALTER COLUMN allow_payload_environment SET DEFAULT true;
UPDATE projects SET allow_payload_environment = true
  WHERE allow_payload_environment IS DISTINCT FROM true;
```

**`environment_api_keys` is NOT dropped here.** `provisionProjectTx`
(`db/queries.go:242`) still writes to it until Task 7, and every database test in Tasks 4
and 5 calls `ProvisionProject` in its setup. Dropping the table now makes those tests fail
with `relation "environment_api_keys" does not exist` instead of the failure the plan
predicts. The drop is migration `029`, added in Task 7.

**Step 2: Apply it to a disposable database**

```bash
docker run --rm -d --name s1pg -e POSTGRES_PASSWORD=x -e POSTGRES_USER=opslane \
  -e POSTGRES_DB=opslane -p 5439:5432 postgres:16
sleep 5
for f in packages/ingestion/db/migrations/*.sql; do
  psql "postgres://opslane:x@localhost:5439/opslane" -v ON_ERROR_STOP=1 -f "$f" >/dev/null || { echo "FAILED: $f"; break; }
done
echo "first pass done"
```

Expected: no `FAILED` line.

**Step 3: Apply it a second time to prove idempotency**

```bash
for f in packages/ingestion/db/migrations/*.sql; do
  psql "postgres://opslane:x@localhost:5439/opslane" -v ON_ERROR_STOP=1 -f "$f" >/dev/null || { echo "FAILED: $f"; break; }
done
psql "postgres://opslane:x@localhost:5439/opslane" -c "\d project_api_keys" | head -20
```

Expected: no `FAILED`, and the table description prints.

**Step 4: Confirm the new table exists and the old one is still there**

```bash
psql "postgres://opslane:x@localhost:5439/opslane" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('project_api_keys','environment_api_keys')"
```

Expected: `2`. Both tables coexist until Task 7.

**Step 5: Commit**

```bash
git add packages/ingestion/db/migrations/028_project_api_keys.sql
git commit -m "feat(ingestion): add project_api_keys table"
```

---

## Task 3: Lookup and create against the database

**Files:**
- Modify: `packages/ingestion/db/project_keys.go`
- Test: `packages/ingestion/db/project_keys_db_test.go`

**Step 1: Write the failing test**

Create `packages/ingestion/db/project_keys_db_test.go`:

```go
package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestCreateAndLookupProjectKey(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "project-keys-lookup")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	prov, err := q.ProvisionProject(ctx, org.ID, "keys-app", nil, "keys-app-token")
	if err != nil {
		t.Fatal(err)
	}

	minted, err := q.CreateProjectKey(ctx, prov.Project.ID, db.ScopeIngest, "test key", nil)
	if err != nil {
		t.Fatalf("CreateProjectKey: %v", err)
	}
	if minted.Raw == "" {
		t.Fatal("raw key was empty")
	}

	got, err := q.LookupProjectKey(ctx, minted.Raw)
	if err != nil {
		t.Fatalf("LookupProjectKey: %v", err)
	}
	if got.ProjectID != prov.Project.ID {
		t.Errorf("ProjectID = %q, want %q", got.ProjectID, prov.Project.ID)
	}
	if got.Scope != db.ScopeIngest {
		t.Errorf("Scope = %q, want %q", got.Scope, db.ScopeIngest)
	}
	if got.OrgID != org.ID {
		t.Errorf("OrgID = %q, want %q", got.OrgID, org.ID)
	}
}

func TestLookupProjectKeyRejectsWrongSecret(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "project-keys-wrong-secret")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	prov, err := q.ProvisionProject(ctx, org.ID, "keys-app", nil, "wrong-secret-token")
	if err != nil {
		t.Fatal(err)
	}
	minted, err := q.CreateProjectKey(ctx, prov.Project.ID, db.ScopeIngest, "k", nil)
	if err != nil {
		t.Fatal(err)
	}

	parsed, err := db.ParseProjectKey(minted.Raw)
	if err != nil {
		t.Fatal(err)
	}
	// Flip one character of the secret, keeping it a valid shape.
	bad := []byte(parsed.Secret)
	if bad[0] == 'A' {
		bad[0] = 'B'
	} else {
		bad[0] = 'A'
	}
	forged := "opslane_pk_" + parsed.KeyID + "_" + string(bad)

	if _, err := q.LookupProjectKey(ctx, forged); !errors.Is(err, db.ErrProjectKeyInvalid) {
		t.Fatalf("err = %v, want ErrProjectKeyInvalid", err)
	}
}

func TestLookupProjectKeyRejectsForgedPrefix(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "project-keys-forged-prefix")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	prov, err := q.ProvisionProject(ctx, org.ID, "keys-app", nil, "forged-prefix-token")
	if err != nil {
		t.Fatal(err)
	}
	minted, err := q.CreateProjectKey(ctx, prov.Project.ID, db.ScopeIngest, "k", nil)
	if err != nil {
		t.Fatal(err)
	}

	// Present an ingest key as if it were a source-map key. The stored scope
	// disagrees with the prefix, so this is not a valid credential at all.
	forged := "opslane_sk_" + minted.Raw[len("opslane_pk_"):]
	if _, err := q.LookupProjectKey(ctx, forged); !errors.Is(err, db.ErrProjectKeyInvalid) {
		t.Fatalf("err = %v, want ErrProjectKeyInvalid", err)
	}
}

func TestLookupProjectKeyRejectsRevoked(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "project-keys-revoked")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	prov, err := q.ProvisionProject(ctx, org.ID, "keys-app", nil, "revoked-token")
	if err != nil {
		t.Fatal(err)
	}
	minted, err := q.CreateProjectKey(ctx, prov.Project.ID, db.ScopeIngest, "k", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE project_api_keys SET revoked_at = now() WHERE key_id = $1`, minted.KeyID); err != nil {
		t.Fatal(err)
	}

	if _, err := q.LookupProjectKey(ctx, minted.Raw); !errors.Is(err, db.ErrProjectKeyInvalid) {
		t.Fatalf("err = %v, want ErrProjectKeyInvalid", err)
	}
}

// Creating a key must never disturb another one. This is the rotation
// guarantee: create the replacement, deploy it, then revoke the old one.
func TestCreateProjectKeyDoesNotRevokeOthers(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "project-keys-no-revoke")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	prov, err := q.ProvisionProject(ctx, org.ID, "keys-app", nil, "no-revoke-token")
	if err != nil {
		t.Fatal(err)
	}

	first, err := q.CreateProjectKey(ctx, prov.Project.ID, db.ScopeIngest, "first", nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := q.CreateProjectKey(ctx, prov.Project.ID, db.ScopeIngest, "second", nil)
	if err != nil {
		t.Fatal(err)
	}

	for name, raw := range map[string]string{"first": first.Raw, "second": second.Raw} {
		if _, err := q.LookupProjectKey(ctx, raw); err != nil {
			t.Errorf("%s key stopped working after the other was created: %v", name, err)
		}
	}
}

// A database failure must not look like a bad credential. Returning 401 here
// would turn a transient blip into "your key is invalid" for every customer.
func TestLookupProjectKeyDistinguishesDatabaseFailure(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "project-keys-db-down")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	prov, err := q.ProvisionProject(ctx, org.ID, "keys-app", nil, "db-down-token")
	if err != nil {
		t.Fatal(err)
	}
	minted, err := q.CreateProjectKey(ctx, prov.Project.ID, db.ScopeIngest, "k", nil)
	if err != nil {
		t.Fatal(err)
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = q.LookupProjectKey(cancelled, minted.Raw)
	if err == nil {
		t.Fatal("expected an error from a cancelled context")
	}
	if errors.Is(err, db.ErrProjectKeyInvalid) {
		t.Fatal("a database failure was reported as an invalid key")
	}
}
```

**Step 2: Run it to verify it fails**

```bash
cd packages/ingestion && go test ./db -run 'ProjectKey' -v
```

Expected: `undefined: db.ErrProjectKeyInvalid`, `q.CreateProjectKey undefined`.

**Step 3: Add the implementation**

Append to `packages/ingestion/db/project_keys.go`:

```go
// ErrProjectKeyInvalid means the presented credential is not usable: it is
// malformed, its key_id is unknown, its secret is wrong, its stored scope
// disagrees with its prefix, or it has been revoked. Callers turn this into
// 401 and must never turn any other error into 401.
var ErrProjectKeyInvalid = errors.New("invalid project key")

// ProjectKeyLookup is what a successfully authenticated key resolves to.
// AllowedOrigins comes from projects and drives EnforceOrigin; dropping it
// would silently allow every origin.
type ProjectKeyLookup struct {
	KeyID                   string
	ProjectID               string
	OrgID                   string
	Scope                   string
	AllowedOrigins          []string
	AllowPayloadEnvironment bool
}

// CreateProjectKey mints a key and stores its hash. The raw value is in the
// return and nowhere else. Creating a key never modifies another key.
func (q *Queries) CreateProjectKey(
	ctx context.Context,
	projectID, scope, label string,
	createdByUserID *string,
) (*MintedProjectKey, error) {
	minted, err := NewProjectKey(scope)
	if err != nil {
		return nil, err
	}
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO project_api_keys
		   (key_id, project_id, scope, token_prefix, secret_hash, label, created_by_user_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		minted.KeyID, projectID, minted.Scope, minted.TokenPrefix,
		minted.SecretHash, label, createdByUserID,
	).Scan(&minted.ID); err != nil {
		return nil, fmt.Errorf("create project key: %w", err)
	}
	return minted, nil
}

// CreateProjectKeyTx is CreateProjectKey inside a caller-owned transaction.
func (q *Queries) CreateProjectKeyTx(
	ctx context.Context,
	tx pgx.Tx,
	projectID, scope, label string,
	createdByUserID *string,
) (*MintedProjectKey, error) {
	minted, err := NewProjectKey(scope)
	if err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx,
		`INSERT INTO project_api_keys
		   (key_id, project_id, scope, token_prefix, secret_hash, label, created_by_user_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		minted.KeyID, projectID, minted.Scope, minted.TokenPrefix,
		minted.SecretHash, label, createdByUserID,
	).Scan(&minted.ID); err != nil {
		return nil, fmt.Errorf("create project key tx: %w", err)
	}
	return minted, nil
}

// LookupProjectKey authenticates a presented credential.
//
// Every unusable-credential case returns ErrProjectKeyInvalid so the caller
// cannot accidentally tell an attacker which part was wrong. Any other error
// is a real failure and must become a 500.
func (q *Queries) LookupProjectKey(ctx context.Context, raw string) (*ProjectKeyLookup, error) {
	parsed, err := ParseProjectKey(raw)
	if err != nil {
		return nil, ErrProjectKeyInvalid
	}

	var (
		out        ProjectKeyLookup
		storedHash string
		revokedAt  *time.Time
	)
	err = q.pool.QueryRow(ctx,
		`SELECT k.project_id, p.org_id, k.scope, k.secret_hash, k.revoked_at,
		        p.allowed_origins, p.allow_payload_environment
		 FROM project_api_keys k
		 JOIN projects p ON p.id = k.project_id
		 WHERE k.key_id = $1`,
		parsed.KeyID,
	).Scan(&out.ProjectID, &out.OrgID, &out.Scope, &storedHash, &revokedAt,
		&out.AllowedOrigins, &out.AllowPayloadEnvironment)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrProjectKeyInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("lookup project key: %w", err)
	}

	// Compare the secret before any other rejection so a caller cannot learn
	// from timing whether a known key_id is revoked or wrong-scoped.
	secretOK := subtle.ConstantTimeCompare([]byte(HashSecret(parsed.Secret)), []byte(storedHash)) == 1

	if !secretOK || out.Scope != parsed.Scope || revokedAt != nil {
		return nil, ErrProjectKeyInvalid
	}

	out.KeyID = parsed.KeyID
	return &out, nil
}
```

Extend the import block at the top of the file to:

```go
import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)
```

**Step 4: Run the tests**

```bash
cd packages/ingestion
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/opslane"
MIGRATION_DIR=db/migrations ../../scripts/run-migrations.sh
go test ./db -run 'ProjectKey' -v
```

Expected: all PASS. Task 2 verified the migration against a throwaway database on port
5439; these tests use the Compose database on **5434**, so it needs the migration applied
too. Note the password is `opslane_dev` (`docker-compose.yml:28`).

**Step 5: Commit**

```bash
git add packages/ingestion/db/project_keys.go packages/ingestion/db/project_keys_db_test.go
git commit -m "feat(ingestion): add project key create and lookup"
```

---

## Task 4: The auth metric

Small, and it lands before the middleware in Task 5 that calls `RecordKeyAuth`. Building it
the other way round leaves Task 5 uncompilable at its commit.

**Files:**
- Modify: `packages/ingestion/handler/metrics.go`
- Test: `packages/ingestion/handler/metrics_test.go`

**Step 1: Write the failing test**

`handler/metrics_test.go` is `package handler`, not `handler_test`, so call the symbols
directly with no package qualifier. Add `"net/http"` to that file's import block.

```go
func TestKeyAuthMetricRenders(t *testing.T) {
	RecordKeyAuth("ok")
	RecordKeyAuth("invalid_key")

	rec := httptest.NewRecorder()
	Metrics(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))

	body := rec.Body.String()
	for _, want := range []string{
		`opslane_key_auth_total{outcome="ok"}`,
		`opslane_key_auth_total{outcome="invalid_key"}`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics output missing %q", want)
		}
	}
}
```

**Step 2: Run it**

```bash
cd packages/ingestion && go test ./handler -run KeyAuthMetric -v
```

Expected: `undefined: RecordKeyAuth`.

**Step 3: Implement**

Add to `packages/ingestion/handler/metrics.go`, following the counter pattern already in that file:

```go
// keyAuthOutcomes counts project-key authentication results. An unrecognised
// key cannot be attributed to a project, so there is deliberately no project
// label: this tells you something is presenting a dead key, not which app.
var (
	keyAuthMu       sync.Mutex
	keyAuthOutcomes = map[string]*atomic.Uint64{}
)

// RecordKeyAuth increments the counter for one authentication outcome:
// ok, invalid_key, wrong_scope, or error.
func RecordKeyAuth(outcome string) {
	keyAuthMu.Lock()
	counter, ok := keyAuthOutcomes[outcome]
	if !ok {
		counter = &atomic.Uint64{}
		keyAuthOutcomes[outcome] = counter
	}
	keyAuthMu.Unlock()
	counter.Add(1)
}
```

And inside the `Metrics` handler, next to the other counter blocks:

```go
	fmt.Fprintln(w, "# HELP opslane_key_auth_total Project API key authentication outcomes")
	fmt.Fprintln(w, "# TYPE opslane_key_auth_total counter")
	keyAuthMu.Lock()
	for outcome, counter := range keyAuthOutcomes {
		fmt.Fprintf(w, "opslane_key_auth_total{outcome=%q} %d\n", outcome, counter.Load())
	}
	keyAuthMu.Unlock()
	fmt.Fprintln(w)
```

**Step 4: Run the tests**

```bash
cd packages/ingestion && go test ./handler -run KeyAuthMetric -v && go build ./...
```

Expected: PASS, and the build succeeds.

**Step 5: Commit**

```bash
git add packages/ingestion/handler/metrics.go packages/ingestion/handler/metrics_test.go
git commit -m "feat(ingestion): add opslane_key_auth_total"
```

---

## Task 5: The auth middleware

**Files:**
- Create: `packages/ingestion/handler/project_keys.go`
- Test: `packages/ingestion/handler/project_keys_test.go`

**Step 1: Write the failing test**

Create `packages/ingestion/handler/project_keys_test.go`. It exercises the middleware through an `httptest` server so the status codes are the real ones.

The `handler_test` package does **not** have `testPool` or `cleanupTenant`; those live in
`db_test`. Use `authTestRouter` (`handler/auth_middleware_test.go:29`), which returns
`(http.Handler, *db.Queries, *pgxpool.Pool)`, and `cleanupTenantHandler`
(`handler/auth_middleware_test.go:435`).

```go
package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestProjectKeyMiddlewareStatuses(t *testing.T) {
	_, q, pool := authTestRouter(t)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "middleware-statuses")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org.ID) })
	prov, err := q.ProvisionProject(ctx, org.ID, "mw-app", nil, "mw-token")
	if err != nil {
		t.Fatal(err)
	}
	pk, err := q.CreateProjectKey(ctx, prov.Project.ID, db.ScopeIngest, "pk", nil)
	if err != nil {
		t.Fatal(err)
	}
	sk, err := q.CreateProjectKey(ctx, prov.Project.ID, db.ScopeSourcemaps, "sk", nil)
	if err != nil {
		t.Fatal(err)
	}

	deps := &handler.Dependencies{Queries: q}
	srv := httptest.NewServer(
		deps.ProjectKey(db.ScopeIngest)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if handler.ProjectIDFromCtx(r.Context()) == "" {
				t.Error("handler ran without a project in context")
			}
			if handler.EnvironmentIDFromCtx(r.Context()) == "" {
				t.Error("handler ran without an environment in context")
			}
			w.WriteHeader(http.StatusNoContent)
		})),
	)
	t.Cleanup(srv.Close)

	cases := []struct {
		name string
		key  string
		want int
		code string
	}{
		{"valid ingest key", pk.Raw, http.StatusNoContent, ""},
		{"source-map key on an ingest route", sk.Raw, http.StatusForbidden, "insufficient_scope"},
		{"no credential", "", http.StatusUnauthorized, "invalid_api_key"},
		{"malformed", "not-a-key", http.StatusUnauthorized, "invalid_api_key"},
		{"legacy def_ key", "def_2f1c9a44-1b3e-4f4a-9c7a-4b2d8e6f0a11", http.StatusUnauthorized, "invalid_api_key"},
		{"unknown key_id", "opslane_pk_aaaaaaaaaaaaaaaaaaaaaaaaaa_" +
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", http.StatusUnauthorized, "invalid_api_key"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, srv.URL, nil)
			if err != nil {
				t.Fatal(err)
			}
			if tc.key != "" {
				req.Header.Set("X-API-Key", tc.key)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.want {
				t.Errorf("status = %d, want %d", resp.StatusCode, tc.want)
			}
			if tc.code == "" {
				return
			}
			// The machine-readable code is the contract, not the prose.
			// Without this assertion it could disappear and every status
			// check would still pass.
			var body struct {
				Error string `json:"error"`
				Code  string `json:"code"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
				t.Fatalf("decode error body: %v", err)
			}
			if body.Code != tc.code {
				t.Errorf("code = %q, want %q", body.Code, tc.code)
			}
		})
	}
}
```

**Step 2: Run it to verify it fails**

```bash
cd packages/ingestion && go test ./handler -run ProjectKeyMiddleware -v
```

Expected: `deps.ProjectKey undefined`.

**Step 3: Write the middleware**

Create `packages/ingestion/handler/project_keys.go`:

```go
package handler

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// ProjectKey authenticates a project API key and checks its scope in one
// pass.
//
// Deliberately one constructor rather than an authenticate middleware plus a
// separate scope middleware. A standalone scope check fails open, because a
// request that never went through authentication carries no scope, and
// "no scope" would have to mean either allow-everything or deny-everything.
// It also allows three states the compiler cannot catch: auth without a scope
// check, a scope check without auth, and the two in the wrong order, since
// chi's .With(...) is positional and silent.
func (d *Dependencies) ProjectKey(requiredScope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw := r.Header.Get("X-API-Key")
			if raw == "" {
				writeJSONErrorCode(w, http.StatusUnauthorized, "missing X-API-Key header", "invalid_api_key")
				return
			}

			lookup, err := d.Queries.LookupProjectKey(r.Context(), raw)
			if errors.Is(err, db.ErrProjectKeyInvalid) {
				RecordKeyAuth("invalid_key")
				writeJSONErrorCode(w, http.StatusUnauthorized, "invalid or revoked API key", "invalid_api_key")
				return
			}
			if err != nil {
				// A database failure is not a bad credential. Returning 401
				// here would turn a transient blip into a fleet-wide "your
				// key is invalid".
				slog.Error("project key lookup failed", "error", err)
				RecordKeyAuth("error")
				writeJSONErrorCode(w, http.StatusInternalServerError, "internal error", "internal_error")
				return
			}

			if lookup.Scope != requiredScope {
				RecordKeyAuth("wrong_scope")
				writeJSONErrorCode(w, http.StatusForbidden, "key is not permitted on this route", "insufficient_scope")
				return
			}

			// The key no longer carries an environment. Every ingest request
			// starts at the project's production row; a payload label may
			// still select another pre-created row for the same project.
			envID, err := d.environmentNameResolver().resolve(r.Context(), lookup.ProjectID, "production")
			if err != nil {
				slog.Error("resolve production environment failed", "error", err, "project_id", lookup.ProjectID)
				writeJSONErrorCode(w, http.StatusInternalServerError, "internal error", "internal_error")
				return
			}
			if envID == "" {
				slog.Error("project has no production environment", "project_id", lookup.ProjectID)
				writeJSONErrorCode(w, http.StatusInternalServerError, "internal error", "internal_error")
				return
			}

			RecordKeyAuth("ok")

			ctx := r.Context()
			ctx = context.WithValue(ctx, ctxProjectID, lookup.ProjectID)
			ctx = context.WithValue(ctx, ctxOrgID, lookup.OrgID)
			ctx = context.WithValue(ctx, ctxEnvironmentID, envID)
			ctx = context.WithValue(ctx, ctxKeyScope, lookup.Scope)
			ctx = context.WithValue(ctx, ctxAllowedOrigins, lookup.AllowedOrigins)
			ctx = context.WithValue(ctx, ctxAllowPayloadEnvironment, lookup.AllowPayloadEnvironment)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
```

Add `ctxKeyScope` to the `contextKey` block in `packages/ingestion/handler/auth.go:21-30`:

```go
const (
	ctxProjectID contextKey = iota
	ctxEnvironmentID
	ctxOrgID
	ctxRequestID
	ctxUserID
	ctxAllowedOrigins
	ctxAllowPayloadEnvironment
	ctxRole
	ctxKeyScope
)
```

Add the error helper alongside `writeJSONError` in `packages/ingestion/handler/auth.go`:

```go
// writeJSONErrorCode emits the {error, code} shape. `code` is the stable
// machine-readable field; `error` stays human-readable.
func writeJSONErrorCode(w http.ResponseWriter, status int, message, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message, "code": code})
}
```

**Step 4: Run the tests**

```bash
cd packages/ingestion && go test ./handler -run ProjectKeyMiddleware -v
```

Expected: all subtests PASS.

**Step 5: Commit**

```bash
git add packages/ingestion/handler/project_keys.go packages/ingestion/handler/project_keys_test.go packages/ingestion/handler/auth.go
git commit -m "feat(ingestion): add one-pass ProjectKey auth middleware"
```

---

## Task 6: Wire the routes

This is where the security boundary actually moves. Read `packages/ingestion/handler/routes.go` end to end before editing.

**Files:**
- Modify: `packages/ingestion/handler/routes.go`
- Modify: `packages/ingestion/handler/auth.go` (delete `AuthenticateSDK` and `AuthenticateSessionOrSDK`)
- Delete: `packages/ingestion/handler/sourcemap.go`, `packages/ingestion/handler/sourcemap_test.go`

**Step 1: Replace the ingest route block**

At `routes.go:86-92`, replace:

```go
r.With(deps.AuthenticateSDK, deps.EnforceOriginAllowingServerSDK, rateLimitByProject(eventsLimiter)).Post("/events", deps.IngestEvent)
r.With(deps.AuthenticateSDK, deps.EnforceOrigin, rateLimitByProject(replaysLimiter)).Post("/replays/init", deps.ReplayInit)
r.With(deps.AuthenticateSDK, deps.EnforceOrigin, rateLimitByProject(replaysLimiter)).Post("/replays/{replayID}/complete", deps.ReplayComplete)
r.With(deps.AuthenticateSDK, deps.EnforceOrigin, rateLimitByProject(replaysLimiter)).Post("/replays/{replayID}/fail", deps.ReplayFail)
r.With(deps.AuthenticateSDK, deps.EnforceOrigin, rateLimitByProject(chunksLimiter)).Post("/sessions/init", deps.SessionInit)
r.With(deps.AuthenticateSDK, deps.EnforceOrigin, rateLimitByProject(chunksLimiter)).Post("/sessions/{sessionID}/chunks/{seq}", deps.ChunkUpload)
r.With(deps.AuthenticateSDK, rateLimitByProject(sourcemapsLimiter)).Post("/sourcemaps", deps.UploadSourceMap)
```

with:

```go
ingestKey := deps.ProjectKey(db.ScopeIngest)

r.With(ingestKey, deps.EnforceOriginAllowingServerSDK, rateLimitByProject(eventsLimiter)).Post("/events", deps.IngestEvent)
r.With(ingestKey, deps.EnforceOrigin, rateLimitByProject(replaysLimiter)).Post("/replays/init", deps.ReplayInit)
r.With(ingestKey, deps.EnforceOrigin, rateLimitByProject(replaysLimiter)).Post("/replays/{replayID}/complete", deps.ReplayComplete)
r.With(ingestKey, deps.EnforceOrigin, rateLimitByProject(replaysLimiter)).Post("/replays/{replayID}/fail", deps.ReplayFail)
r.With(ingestKey, deps.EnforceOrigin, rateLimitByProject(chunksLimiter)).Post("/sessions/init", deps.SessionInit)
r.With(ingestKey, deps.EnforceOrigin, rateLimitByProject(chunksLimiter)).Post("/sessions/{sessionID}/chunks/{seq}", deps.ChunkUpload)

// Proves an ingest key still authenticates, without granting any read.
// Returns 204 with an empty body: no project name, no counts.
r.With(ingestKey, rateLimitByProject(eventsLimiter)).Post("/ingest/ping",
	func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
```

Add `"github.com/opslane/opslane/packages/ingestion/db"` to the imports.

**Step 2: Move the three read routes to session-only**

At `routes.go:128,134,135`, change `deps.AuthenticateSessionOrSDK` to `deps.AuthenticateUserSession` on:

- `/projects/{projectID}/event-count`
- `/projects/{projectID}/incidents`
- `/projects/{projectID}/incidents/{incidentID}`

**Step 3: Remove the key-management routes**

Delete both lines at `routes.go:124-125`. Onboarding is the only mint path in v1, and `ListAPIKeysEndpoint` queries a table that no longer exists.

Then delete `CreateAPIKeyEndpoint` and `ListAPIKeysEndpoint` from `handler/read_api.go:803-873`, plus the `apiKeyInfoJSON` type if nothing else uses it.

**Step 4: Fix the CORS classifier**

Replace `isSDKEndpoint` at `routes.go:254-259`:

```go
// isSDKEndpoint reports whether a path gets the permissive browser CORS
// policy. CORS runs before routing, so chi's route pattern is not available
// here and prefix matching is the only option. The boundary check stops
// /api/v1/eventsX from matching /api/v1/events.
//
// /api/v1/sourcemaps is gone. /api/v1/ingest/ping is deliberately absent:
// permissive CORS would make a credential probe readable from any page.
func isSDKEndpoint(path string) bool {
	for _, p := range []string{"/api/v1/events", "/api/v1/replays", "/api/v1/sessions"} {
		if path == p || strings.HasPrefix(path, p+"/") {
			return true
		}
	}
	return false
}
```

**Step 5: Delete the dead code**

```bash
git rm packages/ingestion/handler/sourcemap.go packages/ingestion/handler/sourcemap_test.go
```

Remove `sourcemapsLimiter` from `handler/ingest_limits.go`, and delete `AuthenticateSDK` (`auth.go:190-212`) and `AuthenticateSessionOrSDK` (`auth.go:217-227`).

**Step 6: Build and run the whole suite**

```bash
cd packages/ingestion && go build ./... && go test ./... 2>&1 | tail -30
```

Expected: it compiles, and the suite is **red**. Existing tests still send `def_` keys and
still expect a project key to reach the read routes, for example
`handler/auth_middleware_test.go:89-124` and `handler/error_event_test.go:328-347,995-1068`.

Do not commit here. Task 6 and Task 7 land as **one commit**: the routes move and the tests
that encode the old boundary are converted together. Splitting them leaves a commit whose
suite fails, which makes a bisect through this range useless.

Carry on straight into Task 7 and commit once, at its Step 12.

**Step 7: Do not commit yet.** Continue into Task 7; these land as one commit.

---

## Task 7: Mint sites, legacy removal, and migration 029

The largest task. It ends with the tree compiling and the suite green, so do not commit
partway through.

**Files:**
- Create: `packages/ingestion/db/migrations/029_drop_environment_api_keys.sql`
- Modify: `packages/ingestion/db/queries.go` (revoke block, mint, legacy deletions)
- Modify: `packages/ingestion/handler/onboarding.go:77`
- Modify: `packages/ingestion/handler/read_api.go:640-644`
- Modify: `packages/ingestion/handler/onboard_provision.go:94`
- Modify: `packages/ingestion/db/onboard_provision.go:146,173`
- Modify: `packages/ingestion/db/agent_provision.go:257,272`
- Modify: `packages/ingestion/db/project_provisioning_test.go`

**Step 1: Rewrite the reprovision test to the new behaviour**

`db/project_provisioning_test.go:36-44` currently asserts the opposite of what we want. It
requires the two mints to differ, then asserts the first key **stops working**. Replace
that block:

```go
	if first.APIKey.ID == second.APIKey.ID || first.APIKey.Raw == second.APIKey.Raw {
		t.Fatalf("retry did not mint a fresh one-time key: first=%+v second=%+v", first.APIKey, second.APIKey)
	}
	// Re-provisioning must NOT revoke the previous key. The old key is sitting
	// in a browser bundle we cannot redeploy from here; revoking it takes the
	// customer's error reporting offline with no warning.
	if lookup, err := q.LookupProjectKey(ctx, first.APIKey.Raw); err != nil || lookup.ProjectID != second.Project.ID {
		t.Fatalf("prior provisioning key stopped working after retry: (%+v, %v)", lookup, err)
	}
	if lookup, err := q.LookupProjectKey(ctx, second.APIKey.Raw); err != nil || lookup.ProjectID != second.Project.ID {
		t.Fatalf("fresh key lookup = (%+v, %v)", lookup, err)
	}
```

and the count assertion below it:

```go
	var projectCount, activeKeyCount int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM projects WHERE org_id = $1 AND idempotency_token = $2`,
		org.ID, "acme/checkout",
	).Scan(&projectCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM project_api_keys
		WHERE project_id = $1 AND revoked_at IS NULL`, second.Project.ID,
	).Scan(&activeKeyCount); err != nil {
		t.Fatal(err)
	}
	if projectCount != 1 || activeKeyCount != 2 {
		t.Fatalf("project_count=%d active_keys=%d want 1,2", projectCount, activeKeyCount)
	}
```

Delete the `provisioningKeyID` variable and its assertion.

**Step 2: Rewrite the concurrent test's key query**

`db/project_provisioning_test.go:129-135` joins through `environment_api_keys`. Replace
that query with the project-scoped one:

```go
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM project_api_keys k
		JOIN projects p ON p.id = k.project_id
		WHERE p.org_id = $1 AND p.idempotency_token = 'same-concurrent-attempt'
		  AND k.revoked_at IS NULL`, org.ID,
	).Scan(&activeKeyCount); err != nil {
```

**Step 3: Run both to verify they fail**

```bash
cd packages/ingestion && go test ./db -run ProvisionProject -v
```

Expected: compile failure on `first.APIKey.Raw` and `q.LookupProjectKey`, because
`ProjectProvisioning.APIKey` is still `APIKeyResult`. That is the correct red.

**Step 4: Convert `provisionProjectTx`**

In `db/queries.go`, delete the entire `UPDATE environment_api_keys ... SET revoked_at =
now()` block at `:242-257`. Then change the mint and the pointer write:

```go
	apiKey, err := q.CreateProjectKeyTx(ctx, tx, result.Project.ID, ScopeIngest, "onboarding", nil)
	if err != nil {
		return nil, fmt.Errorf("provision project: %w", err)
	}
	result.APIKey = *apiKey

	tag, err := tx.Exec(ctx, `
		UPDATE projects
		SET provisioning_key_id = $4
		WHERE id = $1 AND org_id = $2 AND idempotency_token = $3`,
		result.Project.ID, orgID, idempotencyToken, result.APIKey.ID,
	)
```

`result.APIKey.ID` is the `project_api_keys` row UUID, which is why Task 3's insert uses
`RETURNING id`. `provisioning_key_id` is a UUID column; `KeyID` is base32 text and will not
cast.

Change the struct field at `db/queries.go:108-112`:

```go
type ProjectProvisioning struct {
	Project     Project
	Environment Environment
	APIKey      MintedProjectKey
}
```

**Step 5: Fix every reader of the old field names**

`RawKey` becomes `Raw`, and `KeyPrefix` no longer exists. Find them all:

```bash
cd packages/ingestion && grep -rn "\.RawKey\|\.KeyPrefix" --include="*.go" . | grep -v _test.go
```

Expected hits and their fixes:

- `handler/read_api.go:640-644` — `CreateProjectEndpoint` response. Drop `key_prefix`:
  ```go
          "api_key": map[string]any{
              "id":      provisioning.APIKey.ID,
              "raw_key": provisioning.APIKey.Raw,
          },
  ```
- `handler/onboard_provision.go:94` — `result.RawKey` (already a plain string field on
  `OnboardProvisionResult`; only its source changes)
- `db/onboard_provision.go:146,173` — `provisioning.APIKey.RawKey` becomes `.Raw`
- `handler/onboarding.go:77-91` — replace `CreateAPIKeyTx(ctx, tx, env.ID)` with
  `CreateProjectKeyTx(ctx, tx, project.ID, ScopeIngest, "onboarding", nil)` and drop
  `key_prefix` from the response body

**Step 6: Convert the agent provisioning mint**

`db/agent_provision.go:257`:

```go
	// Project-scoped now. Which environment a self-test error lands in is
	// decided by the label the SDK sends, not by the key.
	developmentKey, err := q.CreateProjectKeyTx(ctx, tx, project.ID, ScopeIngest, "agent setup", nil)
```

and `:272` `in.SealKey(developmentKey.RawKey)` becomes `developmentKey.Raw`.

The `development` environment is still created just above; leave it. It is no longer bound
to the key, and removing it is a separate change.

**Step 7: Delete the legacy functions and their now-unused imports**

Remove from `db/queries.go`: `CreateAPIKey` (`:314`), `LookupAPIKey` (`:337`), `hashKey`
(`:356`), `CreateAPIKeyTx` (`:3249`), `ListAPIKeys` (`:3106`), and the `APIKeyResult`
(`:102`) and `APIKeyLookup` (`:114`) types.

Deleting `hashKey` orphans `crypto/sha256`, and deleting `CreateAPIKey` orphans
`github.com/google/uuid`. Go treats an unused import as a compile error, so check both:

```bash
cd packages/ingestion && grep -n "sha256\.\|uuid\." db/queries.go | head
```

If neither appears, remove those two imports.

**Step 8: Add migration 029**

Only now, with no Go code referencing the table, create
`packages/ingestion/db/migrations/029_drop_environment_api_keys.sql`:

```sql
-- 029_drop_environment_api_keys.sql
-- The project-scoped key table replaced this one. Existing def_ keys stop
-- authenticating on purpose; this deployment recreates its database rather
-- than migrating it.
--
-- 001_baseline.sql re-creates this table on every replay and this file drops
-- it again, so both run on every boot. That churn is accepted because the
-- database is short-lived. Do not copy this pattern into a migration that
-- will run against a long-lived production database.
DROP TABLE IF EXISTS environment_api_keys CASCADE;
```

**Step 9: Add the CI guard against a second mint path**

Create `packages/ingestion/db/no_legacy_keys_test.go`:

```go
package db_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The dropped table must not survive in any production Go file. A second
// lookup path is how a security boundary quietly grows a hole.
//
// Test files are skipped, including this one: the search literal below would
// otherwise match itself and this test could never pass.
func TestNoLegacyKeyTableReferences(t *testing.T) {
	needle := "environment" + "_api_keys"
	err := filepath.Walk("..", func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(body), needle) {
			t.Errorf("%s still references the dropped key table", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
```

**Step 10: Convert the test suite. This is most of the task.**

Fourteen Go test files reference the dropped table or the deleted functions. The package
will not compile until every one is converted, so this is not cleanup to do later:

```
db/agent_provision_test.go              db/queries_test.go
db/db_test.go                           db/testhelper_test.go
db/environment_resolution_test.go       handler/agent_callback_integration_test.go
db/onboard_provision_test.go            handler/auth_middleware_test.go
db/project_provisioning_test.go         handler/environment_override_integration_test.go
handler/error_event_test.go             handler/onboard_provision_integration_test.go
handler/project_provisioning_test.go    handler/webhook_test.go
```

Confirm the list before you start, since it will shrink as you go:

```bash
cd packages/ingestion
grep -rln "environment_api_keys\|CreateAPIKey\|LookupAPIKey\|APIKeyResult\|APIKeyLookup" --include="*_test.go" .
```

Four mechanical substitutions cover nearly all of it:

| Old | New |
|---|---|
| `q.CreateAPIKey(ctx, envID)` | `q.CreateProjectKey(ctx, projectID, db.ScopeIngest, "test", nil)` |
| `q.CreateAPIKeyTx(ctx, tx, envID)` | `q.CreateProjectKeyTx(ctx, tx, projectID, db.ScopeIngest, "test", nil)` |
| `q.LookupAPIKey(ctx, raw)` | `q.LookupProjectKey(ctx, raw)` |
| `.RawKey` | `.Raw` |

Two need judgement rather than substitution:

- **`db/testhelper_test.go`** is the shared fixture builder. Convert it first; several
  other files stop failing once it compiles.
- Any assertion that a **superseded key stops working** now asserts the opposite. Find
  them: `grep -rn "remains active after\|no longer\|superseded" --include="*_test.go" .`

**Step 11: Fix the concurrent provisioning assertion**

`db/project_provisioning_test.go:138-140` expects exactly one active key. With eight
concurrent callers and no revocation, every successful mint now survives. Change the
expectation to the number of successful provision calls the test made, not 1.

**Step 12: Recreate the database and run everything**

029 only takes effect on a fresh apply, so rebuild the test database first. Note the
password is `opslane_dev`:

```bash
docker compose down -v && docker compose up -d postgres && sleep 5
cd packages/ingestion
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/opslane"
MIGRATION_DIR=db/migrations ../../scripts/run-migrations.sh
go build ./... && go test ./... 2>&1 | tail -40
```

Expected: build clean, suite green. `TestNoLegacyKeyTableReferences` passing is **not**
sufficient evidence, because it skips `_test.go` files by design. The whole suite passing
is the evidence.

**Step 11: Commit**

```bash
git add -A packages/ingestion
git commit -m "feat(ingestion): mint project keys, stop revoking on reprovision, drop the old table"
```

---

## Task 8: Secret redaction

Small, and it is the difference between a leaked key being redacted and being in plaintext in the fix agent's prompt.

**Files:**
- Modify: `packages/ingestion/masking/masking.go:44`
- Test: `packages/ingestion/masking/masking_test.go`

**Step 1: Write the failing test**

The package exposes `RedactBody`, `RedactURL`, `RedactHeaders`, `RedactContext`,
`RedactRecording`, and `RedactBreadcrumbs` (`masking/masking.go:68-183`). There is no
`Redact`. `masking_test.go` is `package masking_test`, so qualify the call.

```go
func TestRedactsProjectKeys(t *testing.T) {
	cases := map[string]string{
		"public key": "opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_aB-_cD3fGhIjKlMnOpQrStUvWxYz0123456789",
		"secret key": "opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_aB-_cD3fGhIjKlMnOpQrStUvWxYz0123456789",
		// Regression: the old class stopped at the first "-", so most of
		// every legacy key was already reaching logs in plaintext.
		"legacy key": "def_2f1c9a44-1b3e-4f4a-9c7a-4b2d8e6f0a11",
	}
	for name, key := range cases {
		t.Run(name, func(t *testing.T) {
			got := masking.RedactBody("token=" + key + " end")
			if strings.Contains(got, key) {
				t.Errorf("key survived redaction: %q", got)
			}
			// The tail must not leak either.
			tail := key[len(key)-8:]
			if strings.Contains(got, tail) {
				t.Errorf("key tail %q survived redaction: %q", tail, got)
			}
		})
	}
}
```

**Step 2: Run it**

```bash
cd packages/ingestion && go test ./masking -run RedactsProjectKeys -v
```

Expected: FAIL on all three.

**Step 3: Fix the regex**

`masking/masking.go:44`. Two changes; missing either one ships no redaction for the new keys.

```go
// apiKeyPrefixRe matches well-known API key prefixes followed by their value.
// The trailing class must include "_" and "-": base64url secrets contain
// underscores, and legacy def_ keys are UUIDs containing hyphens.
var apiKeyPrefixRe = regexp.MustCompile(
	`(?i)(sk_live_|sk_test_|AKIA|ghp_|gho_|def_|opslane_pk_|opslane_sk_)[A-Za-z0-9_-]+`)
```

Update the doc comment at `masking.go:84` to list the new prefixes.

**Step 4: Run the tests**

```bash
cd packages/ingestion && go test ./masking -v
```

Expected: PASS, including the pre-existing tests.

**Step 5: Commit**

```bash
git add packages/ingestion/masking
git commit -m "fix(ingestion): redact project keys and full legacy keys"
```

---

## Task 9: The SDK guard

**Files:**
- Modify: `packages/sdk/src/config.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/src/__tests__/config.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { init } from '../index.js';

describe('init key validation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a public ingest key', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    init({ apiKey: 'opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_ab' });
    expect(err).not.toHaveBeenCalled();
  });

  it('refuses a secret source-map key and says so without debug enabled', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    init({ apiKey: 'opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_ab' });
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('opslane_pk_'),
    );
  });

  it('refuses a legacy def_ key', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    init({ apiKey: 'def_2f1c9a44-1b3e-4f4a-9c7a-4b2d8e6f0a11' });
    expect(err).toHaveBeenCalled();
  });
});
```

`init` sets a module-level `initialized` flag (`index.ts:16`) that a static import keeps
alive across tests, so the second `init` call returns immediately and asserts nothing.
`vi.resetModules()` alone does not fix that, because the binding is already resolved. Import
dynamically **inside** each test:

```ts
beforeEach(() => { vi.resetModules(); });

it('refuses a secret source-map key', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { init } = await import('../index.js');   // fresh module per test
  init({ apiKey: 'opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_ab' });
  expect(err).toHaveBeenCalledWith(expect.stringContaining('opslane_pk_'));
});
```

Apply the same shape to the other two cases in this file.

**Step 2: Run it**

```bash
cd packages/sdk && pnpm vitest run src/__tests__/config.test.ts
```

Expected: the secret-key and legacy-key cases FAIL, because nothing checks the prefix.

**Step 3: Add the check**

In `packages/sdk/src/config.ts`, at the top of `loadConfig`:

```ts
const PUBLIC_KEY_PREFIX = 'opslane_pk_';

export class InvalidApiKeyError extends Error {
  constructor(prefixSeen: string) {
    super(
      `[opslane] refusing to initialize: apiKey must start with "${PUBLIC_KEY_PREFIX}". ` +
      `Got "${prefixSeen}". Only the public ingest key belongs in browser code. ` +
      `A key starting with "opslane_sk_" is a secret and must never ship in a bundle.`,
    );
    this.name = 'InvalidApiKeyError';
  }
}
```

and inside `loadConfig`, **after** the existing empty check at `config.ts:66-68`, not
before it. Moving ahead of it would break the existing `"apiKey is required"` assertion:

```ts
  if (!options.apiKey) {
    throw new Error('apiKey is required');   // existing, leave first
  }
  if (!options.apiKey.startsWith(PUBLIC_KEY_PREFIX)) {
    throw new InvalidApiKeyError(options.apiKey.slice(0, 11));
  }
```

In `packages/sdk/src/index.ts:23-30`, the catch currently swallows everything unless `debug`
is set. A wrong key type is a developer mistake worth surfacing in production. Add the
import at the top of the file, or this will not compile:

```ts
import { loadConfig, InvalidApiKeyError } from './config.js';
```

```ts
  try {
    loadConfig(options);
  } catch (e) {
    if (e instanceof InvalidApiKeyError) {
      // Always visible. Failing silently here means an app ships with a
      // credential that will never work, or worse, a secret in the bundle.
      console.error(e.message);
      return;
    }
    if (options.debug) {
      console.error('[opslane] init failed:', e);
    }
    return;
  }
```

**Step 4: Run the tests**

```bash
cd packages/sdk && pnpm vitest run
```

Expected: PASS.

Many existing tests call `loadConfig` **directly** with placeholder keys like `'k'` and
`'key-abc'`, not just through `init`. Every one of them now throws. Find them and switch
them to a shared fixture:

```bash
cd packages/sdk && grep -rln "apiKey:" src/__tests__
```

Expect around ten files, including `core.test.ts`, `contract.test.ts`,
`browser-contract.test.ts`, `network.test.ts`, `replay.test.ts`, `chunk-upload.test.ts`,
`telemetry.test.ts`, and `index.test.ts`. This is the bulk of Task 9.

Add the fixture once, in a file the tests already share:

```ts
export const TEST_PK =
  'opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_ab';
```

Keep any test that deliberately passes an empty key: that path still throws
`'apiKey is required'` and its assertion is unchanged.

**Step 5: Guard the CLI writer too**

In `cli/src/init.ts:109`, before writing:

```ts
async function persistApiKeyEnvironment(cwd: string, framework: Framework, apiKey: string): Promise<void> {
  if (!apiKey.startsWith('opslane_pk_')) {
    throw new Error(
      'refusing to write a non-public key to .env.local: only opslane_pk_ keys belong in browser code',
    );
  }
  await writeEnvLocal(cwd, { [apiKeyEnvironmentVariable(framework)]: apiKey });
}
```

**Step 6: Commit**

```bash
git add packages/sdk cli/src/init.ts
git commit -m "feat(sdk,cli): refuse any key that is not opslane_pk_"
```

---

## Task 10: CLI reads move to the session

**Files:**
- Modify: `cli/src/errors.ts:17-30,58,81`
- Modify: `cli/src/verify.ts:68`
- Modify: `cli/src/setup.ts:98`
- Modify: `cli/src/doctor.ts:130-160`
- Create: `cli/src/authed-fetch.ts`
- Test: `cli/src/__tests__/authed-fetch.test.ts`

**Step 1: Write the failing test for the shared helper**

One helper rather than five edited call sites, so token refresh exists in exactly one place.

```ts
import { describe, it, expect, vi } from 'vitest';
import { authedFetch } from '../authed-fetch.js';

describe('authedFetch', () => {
  it('sends the session as a Bearer token', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    await authedFetch('https://api.test/x', {
      apiUrl: 'https://api.test',
      fetchFn,
      loadToken: async () => ({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 60_000 }),
    });
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBeUndefined();
  });

  it('reports a missing session instead of sending nothing', async () => {
    const fetchFn = vi.fn();
    await expect(authedFetch('https://api.test/x', {
      apiUrl: 'https://api.test',
      fetchFn,
      loadToken: async () => null,
    })).rejects.toThrow(/opslane login/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run it**

```bash
cd cli && pnpm vitest run src/__tests__/authed-fetch.test.ts
```

Expected: `Cannot find module '../authed-fetch.js'`.

**Step 3: Write the helper**

Create `cli/src/authed-fetch.ts`:

```ts
import { ensureLoggedIn } from './onboard/provision.js';
import { defaultTokenPath } from './auth.js';

export interface AuthedFetchOptions {
  apiUrl: string;
  fetchFn?: typeof fetch;
  tokenPath?: string;
  loadToken?: () => Promise<{ accessToken: string } | null>;
}

/**
 * Session-authenticated fetch for CLI read commands.
 *
 * Uses ensureLoggedIn rather than a bare token read so an expired access
 * token refreshes instead of turning into a confusing 401.
 */
export async function authedFetch(
  url: string,
  options: AuthedFetchOptions,
): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  // ensureLoggedIn requires loginFn (provision.ts:31). Read commands must not
  // launch an interactive browser login on their own, so pass a loginFn that
  // refuses; the caller sees "run opslane login" instead of a surprise browser.
  const load = options.loadToken
    ?? (() => ensureLoggedIn({
      apiUrl: options.apiUrl,
      tokenPath: options.tokenPath ?? defaultTokenPath(),
      fetchFn,
      loginFn: async () => {
        throw new Error('Not signed in. Run "opslane login" first.');
      },
    }));

  const token = await load();
  if (!token) {
    throw new Error('Not signed in. Run "opslane login" first.');
  }
  return fetchFn(url, { headers: { Authorization: `Bearer ${token.accessToken}` } });
}
```

**Step 4: Convert the call sites**

`cli/src/errors.ts` — replace `fetchAndOutput`'s signature and both calls so it takes the api url rather than a key, and preserve the server's `code` field in the error output:

```ts
async function fetchAndOutput(fetchFn: typeof fetch, apiUrl: string, url: string): Promise<void> {
  try {
    const resp = await authedFetch(url, { apiUrl, fetchFn });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
      return exitWithStatus('api_error', {
        status: resp.status,
        code: body['code'] ?? null,
        message: body['error'] ?? `API error: ${resp.status}`,
      }, 1);
    }
    jsonOutput(await resp.json() as Record<string, unknown>);
  } catch (err) {
    exitWithError((err as Error).message);
  }
}
```

`cli/src/verify.ts:68` — swap `{ headers: { 'X-API-Key': creds.api_key } }` for
`authedFetch(url, { apiUrl: creds.api_url, fetchFn })`. This one is a genuine read.

`cli/src/setup.ts:91-105` — **do not** convert `validateExistingCredential` to a session.
It exists to answer "is the stored ingest key still good," and a session answers a
different question. A revoked key would be reported valid and left in the app. Point it at
the ping instead:

```ts
async function validateExistingCredential(
  creds: AgentCredentials,
  fetchFn: typeof fetch,
): Promise<'valid' | 'invalid' | 'unreachable'> {
  try {
    const response = await fetchFn(`${creds.api_url}/api/v1/ingest/ping`, {
      method: 'POST',
      headers: { 'X-API-Key': creds.api_key },
    });
    if (response.ok) return 'valid';
    return response.status === 401 || response.status === 403 ? 'invalid' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}
```

**Step 5: Split the doctor check honestly**

`cli/src/doctor.ts:130-160` currently prints "API key is valid" after proving only that a
request succeeded. Replace the single check with two. Both closures need `tokens`, `agentCredentials`, `apiUrl`, and `fetchImpl` in scope. Those
are resolved inside **`buildChecks`** (`cli/src/doctor.ts:39-52`), not `doctor()`. Put the
new checks in `buildChecks` alongside the existing ones, or they reference undefined
variables and will not compile.

```ts
    {
      name: 'Session',
      run: async () => {
        const resp = await fetchImpl(`${apiUrl}/api/v1/auth/verify`, {
          headers: { Authorization: `Bearer ${tokens?.accessToken ?? ''}` },
          signal: AbortSignal.timeout(5000),
        });
        return resp.ok
          ? { name: 'Session', passed: true, message: 'Signed in' }
          : { name: 'Session', passed: false, message: `Not signed in (status ${resp.status})`,
              remediation: 'Run `opslane login`' };
      },
    },
    {
      name: 'Ingest key',
      run: async () => {
        if (!agentCredentials) {
          return { name: 'Ingest key', passed: false, message: 'No stored key',
                   remediation: 'Run `opslane onboard` in this repo' };
        }
        // A session proves who you are. Only the ping proves the key baked
        // into the app still authenticates.
        const resp = await fetchImpl(`${agentCredentials.api_url}/api/v1/ingest/ping`, {
          method: 'POST',
          headers: { 'X-API-Key': agentCredentials.api_key },
          signal: AbortSignal.timeout(5000),
        });
        return resp.ok
          ? { name: 'Ingest key', passed: true, message: 'Ingest key is valid' }
          : { name: 'Ingest key', passed: false, message: `Ingest key rejected (status ${resp.status})`,
              remediation: 'Run `opslane onboard` to mint a replacement, then redeploy' };
      },
    },
```

**Step 6: Run the CLI suite**

```bash
cd cli && pnpm build && pnpm test 2>&1 | tail -20
```

Six CLI test files encode the old behaviour and fail until converted:

```
__tests__/doctor.test.ts    __tests__/errors.test.ts    __tests__/init.test.ts
__tests__/snippet.test.ts   __tests__/status.test.ts    __tests__/verify.test.ts
```

Two need more than a header swap:

- `__tests__/init.test.ts:235-251` expects a `def_` key to be written to `.env.local`. The
  Task 9 CLI guard now rejects that. Change the fixture to a valid `opslane_pk_` value and
  add a case asserting a `def_` key is refused. **Task 9 only runs the SDK suite, so this
  regression is invisible until here.** Run `cd cli && pnpm test` at the end of Task 9 too.
- `errors.test.ts`, `verify.test.ts`, and `doctor.test.ts` assert `X-API-Key` headers and
  `/event-count` calls. They need a deterministic session seam: give the read commands an
  optional `tokenPath` or `loadToken` option, the way `authedFetch` already accepts, and
  have the tests pass a stub rather than touching the real token file.

Expected after conversion: PASS.

**Step 7: Commit**

```bash
git add cli/src
git commit -m "feat(cli): read with the session, probe the ingest key separately"
```

---

## Task 11: Fail the Vite plugin loudly

**Files:**
- Modify: `packages/sdk/vite-plugin/index.ts:59-95`
- Modify: `docs/guides/source-maps.md`, `packages/sdk/README.md`

**Step 1: Replace the upload with a build error**

The plugin posts to `/api/v1/sourcemaps`, which now returns 404. Left alone it removes the maps from the output, warns, and exits 0, so a customer gets a green build with no maps anywhere.

```ts
      // Source-map upload moved to a batch API that does not exist yet
      // (tracked in #218). Failing the build is better than silently
      // deleting maps and uploading nothing, which is what a 404 here
      // would produce.
      throw new Error(
        '[opslane] source-map upload is unavailable in this release. ' +
        'Remove opslane() from your Vite plugins until @opslane/sdk ships batch upload (see opslane/opslane-oss#218).',
      );
```

Delete the `generateBundle` hook that removes map assets. Nothing should be deleting maps
while there is nowhere to send them.

Put the throw at the **top** of the plugin's `configResolved` hook, not inside
`closeBundle`. `closeBundle` returns early when `collectedMaps.length === 0`, and with
`generateBundle` gone nothing collects maps, so a throw placed there would never fire.
Throwing in `configResolved` fails the build immediately with a clear message.

**Step 2: Rewrite the plugin tests**

`packages/sdk/src/__tests__/vite-plugin.test.ts` asserts the behaviour being deleted: that
`generateBundle` exists, that it removes map assets, and that `closeBundle` posts multipart
form data. Every one of those tests now fails. Replace the file with the new contract:

The export is `opslaneSourceMapPlugin(options)` (`packages/sdk/vite-plugin/index.ts:18`),
not `opslane`, and it takes a required options argument.

```ts
import { describe, it, expect } from 'vitest';
import { opslaneSourceMapPlugin } from '../../vite-plugin/index.js';

const opts = { apiKey: 'unused', endpoint: 'https://api.test' };

describe('vite plugin', () => {
  it('fails the build instead of silently dropping source maps', () => {
    const plugin = opslaneSourceMapPlugin(opts) as { configResolved: (c: unknown) => void };
    expect(() => plugin.configResolved({} as never)).toThrow(/source-map upload is unavailable/);
  });

  it('no longer removes map assets from the bundle', () => {
    const plugin = opslaneSourceMapPlugin(opts) as Record<string, unknown>;
    expect(plugin.generateBundle).toBeUndefined();
  });
});
```

**Step 3: Update the docs**

One line at the top of `docs/guides/source-maps.md` and in the plugin section of `packages/sdk/README.md` saying upload is unavailable in this release and pointing at #218.

**Step 4: Run the SDK build**

```bash
cd packages/sdk && pnpm build && pnpm test
```

Expected: PASS, including the rewritten plugin tests.

**Step 5: Commit**

```bash
git add packages/sdk docs/guides/source-maps.md
git commit -m "fix(sdk): fail the build instead of silently dropping source maps"
```

---

## Task 12: Dashboard, minimum only

Two things break on merge because the list response changed shape. Nothing else.

**Files:**
- Modify: `packages/dashboard/src/api.ts:177-184,461-466`
- Modify: `packages/dashboard/src/views/Settings.vue:393,428,505,806-880`

**Step 1: Update the types and drop the deleted calls**

`packages/dashboard/src/api.ts:186-203` also declares `key_prefix` on `APIKeyCreated` and
on the provisioning response types. Task 7 removed that field from the server response, so
remove it here or `vue-tsc` will pass on a field that is always `undefined`.

```ts
export interface APIKey {
  key_id: string;
  scope: 'ingest' | 'sourcemaps';
  label: string;
  status: 'active' | 'revoked';
  created_at: string;
  revoked_at: string | null;
}
```

Delete `createAPIKey` and `listAPIKeys`; both routes are gone.

**Step 2: Strip the API Keys panel to a placeholder**

Replace the panel body at `Settings.vue:806-880` with one paragraph:

> API keys are created by `opslane onboard` in your repository. Managing them here is coming with source-map settings.

Remove `apiKeys`, `loadAPIKeys`, `handleCreateKey`, `openNewKeyModal`, `newKeyEnvId`,
`newKeyResult`, `showNewKeyModal`, `creatingKey`, `keyError`, and the tab-switch load guard
at `:393`.

**Also delete the "New key" modal at `Settings.vue:883` and onward.** It references every
one of those symbols in its template, and `vue-tsc` fails on a template reference to a
deleted binding. Removing the script refs without removing the modal leaves the build red.

Keep the **provisioning** modal at `:859-881`. It is a separate element that shows the key
returned by onboarding and does not touch the deleted list route. Read both carefully
before cutting; they sit next to each other.

**Step 3: Type-check and build**

```bash
cd packages/dashboard && pnpm build
```

Expected: no TypeScript errors. If one appears, a consumer of the old `APIKey` shape was missed.

**Step 4: Commit**

```bash
git add packages/dashboard
git commit -m "refactor(dashboard): remove the key panel that queried a dropped table"
```

---

## Task 13: The route matrix

This is what stops the boundary regressing on some future PR. Write it last, when every route is in its final position.

**Files:**
- Create: `packages/ingestion/handler/route_matrix_test.go`

**Step 1: Write the test**

```go
package handler_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

type credential string

const (
	credNone     credential = "none"
	credPK       credential = "pk"
	credSK       credential = "sk"
	credRevoked  credential = "revoked"
	credMalformed credential = "malformed"
	credOtherPK  credential = "wrong-project-pk"
	credSession  credential = "session"
)

// want maps each credential to the expected status. Anything not listed is
// expected to be DENIED. A route must opt in to accepting a credential.
type routeExpectation struct {
	method string
	path   string
	want   map[credential]int
}

// Every credential-bearing route in the API, and what each credential gets.
// A new route with no entry here fails TestRouteMatrixCoversEveryRoute.
var matrix = []routeExpectation{
	// /events returns 202 Accepted, not 200 (handler/error_event.go:243).
	{"POST", "/api/v1/events", map[credential]int{
		credPK: 202, credSK: 403, credRevoked: 401, credMalformed: 401,
		credOtherPK: 202, credNone: 401, credSession: 401,
	}},
	// 201, not 200 (handler/replay.go:162).
	{"POST", "/api/v1/replays/init", map[credential]int{
		credPK: 201, credSK: 403, credRevoked: 401, credMalformed: 401, credNone: 401,
	}},
	{"POST", "/api/v1/replays/{replayID}/complete", map[credential]int{
		credPK: 200, credSK: 403, credRevoked: 401, credMalformed: 401, credNone: 401,
	}},
	{"POST", "/api/v1/replays/{replayID}/fail", map[credential]int{
		credPK: 200, credSK: 403, credRevoked: 401, credMalformed: 401, credNone: 401,
	}},
	{"POST", "/api/v1/sessions/init", map[credential]int{
		credPK: 200, credSK: 403, credRevoked: 401, credMalformed: 401, credNone: 401,
	}},
	{"POST", "/api/v1/sessions/{sessionID}/chunks/{seq}", map[credential]int{
		credPK: 200, credSK: 403, credRevoked: 401, credMalformed: 401, credNone: 401,
	}},
	{"POST", "/api/v1/ingest/ping", map[credential]int{
		credPK: 204, credSK: 403, credRevoked: 401, credMalformed: 401,
		credOtherPK: 204, credNone: 401, credSession: 401,
	}},
	{"GET", "/api/v1/projects/{projectID}/incidents", map[credential]int{
		credSession: 200, credPK: 401, credSK: 401, credNone: 401, credMalformed: 401,
	}},
	{"GET", "/api/v1/projects/{projectID}/incidents/{incidentID}", map[credential]int{
		credSession: 404, credPK: 401, credSK: 401, credNone: 401, credMalformed: 401,
	}},
	{"GET", "/api/v1/projects/{projectID}/event-count", map[credential]int{
		credSession: 200, credPK: 401, credSK: 401, credNone: 401, credMalformed: 401,
	}},
}

// Confirm each expected success status against the handler before trusting
// this table; several of these return 200 while /events returns 202. Run the
// route once by hand if unsure. A wrong success code here produces a red test
// that looks like a security failure and is not one.

// A public key on a read route gets 401, not 403, because those routes have
// no key authenticator at all: an X-API-Key header there is an absent
// credential, not a wrong-scoped one. 403 is reserved for a key that
// authenticated and then failed the scope check.
func TestRouteMatrix(t *testing.T) {
	env := newMatrixEnv(t) // helper: org, two projects, keys, session cookie, live server
	for _, route := range matrix {
		for _, cred := range []credential{credNone, credPK, credSK, credRevoked, credMalformed, credOtherPK, credSession} {
			t.Run(string(cred)+" "+route.method+" "+route.path, func(t *testing.T) {
				want, listed := route.want[cred]
				if !listed {
					want = http.StatusUnauthorized // DENY by default
				}
				// credOtherPK is a VALID key for a different project. On a
				// key-scoped route it authenticates and then either succeeds
				// against its own resources or fails on ownership. Do not
				// leave it unlisted and expect 401: list the real expectation
				// per route, or the default hides a genuine result.
				got, code := env.call(t, route.method, route.path, cred)
				if got != want {
					t.Errorf("%s %s with %s: status %d, want %d", route.method, route.path, cred, got, want)
				}
				// The code field is the contract clients branch on. Asserting
				// status alone lets it silently disappear.
				switch got {
				case http.StatusUnauthorized:
					if code != "invalid_api_key" {
						t.Errorf("%s %s with %s: code %q, want invalid_api_key", route.method, route.path, cred, code)
					}
				case http.StatusForbidden:
					if code != "insufficient_scope" {
						t.Errorf("%s %s with %s: code %q, want insufficient_scope", route.method, route.path, cred, code)
					}
				}
			})
		}
	}
}

// Walking the router catches a route that was added without a matrix entry.
// chi/v5 v5.3.1 passes inline .With(...) middleware to WalkFunc
// (tree.go:839, 872-875), so the chain is visible here. This reads library
// internals: re-check it on any chi upgrade.
func TestRouteMatrixCoversEveryRoute(t *testing.T) {
	listed := map[string]bool{}
	for _, r := range matrix {
		listed[r.method+" "+r.path] = true
	}

	_, _, pool := authTestRouter(t)
	deps := newTestDeps(t, pool)              // build Dependencies the same way authTestRouter does
	router := newTestRouter(t, deps, pool)    // existing 3-arg helper, do not redefine
	err := chi.Walk(router, func(method, route string, h http.Handler, mws ...func(http.Handler) http.Handler) error {
		if !isCredentialBearing(mws) {
			return nil // public, session-only, internal-token, or SPA
		}
		if !listed[method+" "+route] {
			t.Errorf("route %s %s takes a project key but has no matrix entry", method, route)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
```

**Do not define `newTestRouter`.** It already exists in `handler_test` with a different
signature, `newTestRouter(t *testing.T, deps *handler.Dependencies, pool *pgxpool.Pool)`
(`handler/session_integration_test.go:66`), and Go has no function overloading. Reuse it.

Write two helpers in this file:

```go
// matrixEnv holds one org with two projects so wrong-project keys are real.
type matrixEnv struct {
	srv        *httptest.Server
	projectID  string
	otherKey   string // a valid pk belonging to a DIFFERENT project
	keys       map[credential]string
	sessionJar http.CookieJar
}

func newMatrixEnv(t *testing.T) *matrixEnv {
	t.Helper()
	_, q, pool := authTestRouter(t)
	// create org, two projects, mint pk + sk + a revoked pk for project one
	// and a pk for project two, then build the router with newTestRouter and
	// wrap it in httptest.NewServer.
	// ...
}

// isCredentialBearing reports whether a route's middleware chain contains the
// project-key authenticator. chi/v5 v5.3.1 passes inline .With(...) middleware
// to WalkFunc (tree.go:839, 872-875). Functions are not comparable, but every
// closure returned by ProjectKey shares one code pointer.
func isCredentialBearing(mws []func(http.Handler) http.Handler) bool {
	want := reflect.ValueOf((&handler.Dependencies{}).ProjectKey(db.ScopeIngest)).Pointer()
	for _, mw := range mws {
		if reflect.ValueOf(mw).Pointer() == want {
			return true
		}
	}
	return false
}
```

This reads chi internals. If a chi upgrade breaks `isCredentialBearing`, the behavioural
matrix above still holds; fix the walk rather than deleting it.

**Step 2: Run it**

```bash
cd packages/ingestion && go test ./handler -run RouteMatrix -v
```

Expected: PASS. Any failure here is a real hole; do not relax an expectation to make it green.

**Step 3: Commit**

```bash
git add packages/ingestion/handler/route_matrix_test.go
git commit -m "test(ingestion): add the deny-by-default route matrix"
```

---

## Task 14: The live check

Not a test file. Three things to do by hand, in about ten minutes, before opening the PR.

**Step 1: Bring up a clean stack and start the server**

```bash
cd "$(git rev-parse --show-toplevel)"
export DATABASE_URL="postgres://opslane:opslane@localhost:5434/opslane"

docker compose down -v && docker compose up -d postgres minio && sleep 5
(cd packages/ingestion && go build -o /tmp/ingestion ./cmd/server)
(cd packages/ingestion && MIGRATION_DIR=db/migrations ../../scripts/run-migrations.sh)

# An earlier draft of this plan built the binary and never started it.
/tmp/ingestion &
INGESTION_PID=$!
sleep 2
curl -sf localhost:8082/health && echo " health ok"
```

`export` matters. A `VAR=x cmd` prefix scopes the variable to that one command, so the
later `psql "$DATABASE_URL"` calls would run against an empty string.

**Step 2: Check one, the flow survives**

```bash
cd "$(git rev-parse --show-toplevel)/test-fixtures/react-app"
rm -f .env.local .opslane.json     # only these two; do not blanket-delete untracked files
node ../../cli/dist/index.js onboard
grep OPSLANE .env.local
```

Expected: a line matching `^VITE_OPSLANE_API_KEY=opslane_pk_[a-z2-7]{26}_[A-Za-z0-9_-]{43}$`.

Start the app, trigger the fixture error, then:

```bash
psql "$DATABASE_URL" -c \
  "SELECT project_id, environment_id, error_type FROM error_events ORDER BY created_at DESC LIMIT 1"
```

Expected: one row, under the project onboarding just created, in its `production` environment.

**Step 3: Check two, the boundary is real**

The event body is nested, not flat (`handler/error_event.go:60-73`). A flat body returns
400, which tells you nothing about authentication.

```bash
cd "$(git rev-parse --show-toplevel)"
KEY=$(grep VITE_OPSLANE_API_KEY test-fixtures/react-app/.env.local | cut -d= -f2)
PROJ=$(psql "$DATABASE_URL" -tAc "SELECT project_id FROM project_api_keys LIMIT 1")

BODY='{"timestamp":"2026-07-30T00:00:00Z","error":{"type":"Error","message":"smoke","stack":"at x (a.js:1:1)"}}'

curl -s -o /dev/null -w 'events:      %{http_code}\n' -X POST localhost:8082/api/v1/events \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d "$BODY"
curl -s -o /dev/null -w 'incidents:   %{http_code}\n' \
  "localhost:8082/api/v1/projects/$PROJ/incidents" -H "X-API-Key: $KEY"
curl -s -o /dev/null -w 'sourcemaps:  %{http_code}\n' -X POST localhost:8082/api/v1/sourcemaps -H "X-API-Key: $KEY"
curl -s -o /dev/null -w 'ping:        %{http_code}\n' -X POST localhost:8082/api/v1/ingest/ping -H "X-API-Key: $KEY"
```

Expected exactly:

```
events:      202
incidents:   401
sourcemaps:  404
ping:        204
```

`202` is the success code for `/events` (`handler/error_event.go:243`). A `400` means the
body shape is wrong, not that authentication failed.

Confirm the error body carries its machine-readable code:

```bash
curl -s "localhost:8082/api/v1/projects/$PROJ/incidents" -H "X-API-Key: $KEY" | head -c 200
```

Expected: JSON containing `"code":"invalid_api_key"`.

**Step 4: Check three, nobody went dark**

```bash
cd "$(git rev-parse --show-toplevel)/test-fixtures/react-app"
node ../../cli/dist/index.js onboard
cd "$(git rev-parse --show-toplevel)"
curl -s -o /dev/null -w 'old key still works: %{http_code}\n' -X POST localhost:8082/api/v1/events \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d "$BODY"
```

Expected: `202`. A `401` means the reprovision revoke from Task 7 is still in place.

**Step 5: Record what you saw**

Append the four status codes and both `psql` outputs to the "Done when" section of
`docs/design/2026-07-30-s1-project-keys.md`, under a dated heading. That document claims
these three checks pass; this is where the claim gets its evidence.

**Step 6: Stop the server and run the full gate**

```bash
kill $INGESTION_PID
pnpm install --frozen-lockfile && pnpm -r build && pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

**Step 7: Commit and open the PR**

```bash
git add -A && git commit -m "docs: record S1 live check results"
gh pr create --fill
```
