package db_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func seedProjectKeyTest(t *testing.T, label string) (*db.Queries, string, string) {
	t.Helper()
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, label)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	provisioning, err := q.ProvisionProject(ctx, org.ID, "keys-app", nil, label)
	if err != nil {
		t.Fatal(err)
	}
	return q, org.ID, provisioning.Project.ID
}

func TestLookupProjectKeyExpiry(t *testing.T) {
	q, _, projectID := seedProjectKeyTest(t, "project-keys-expiry")
	ctx := context.Background()

	tests := []struct {
		name      string
		expiresAt *time.Time
		revoke    bool
		wantErr   bool
	}{
		{name: "no expiry"},
		{name: "future expiry", expiresAt: timePtr(time.Now().Add(time.Hour))},
		{name: "past expiry", expiresAt: timePtr(time.Now().Add(-time.Hour)), wantErr: true},
		{name: "revoked before future expiry", expiresAt: timePtr(time.Now().Add(time.Hour)), revoke: true, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			minted, err := q.CreateProjectKey(ctx, projectID, db.ScopeAPI, tc.name, nil, "")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := q.Pool().Exec(ctx, `
				UPDATE project_api_keys
				SET expires_at = $2,
				    revoked_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
				WHERE key_id = $1`, minted.KeyID, tc.expiresAt, tc.revoke); err != nil {
				t.Fatal(err)
			}
			lookup, err := q.LookupProjectKey(ctx, minted.Raw)
			if tc.wantErr {
				if !errors.Is(err, db.ErrProjectKeyInvalid) {
					t.Fatalf("err = %v, want ErrProjectKeyInvalid", err)
				}
				if tc.name == "past expiry" && !errors.Is(err, db.ErrProjectKeyExpired) {
					t.Fatalf("err = %v, want ErrProjectKeyExpired", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tc.expiresAt == nil {
				if lookup.ExpiresAt != nil {
					t.Fatalf("expires_at = %v, want nil", lookup.ExpiresAt)
				}
			} else if lookup.ExpiresAt == nil || !lookup.ExpiresAt.Equal(tc.expiresAt.Truncate(time.Microsecond)) {
				t.Fatalf("expires_at = %v, want %v", lookup.ExpiresAt, tc.expiresAt)
			}
		})
	}
}

func timePtr(value time.Time) *time.Time { return &value }

func TestCreateAndLookupProjectKey(t *testing.T) {
	q, orgID, projectID := seedProjectKeyTest(t, "project-keys-lookup")
	minted, err := q.CreateProjectKey(
		context.Background(), projectID, db.ScopeIngest, "test key", nil, "",
	)
	if err != nil {
		t.Fatal(err)
	}
	got, err := q.LookupProjectKey(context.Background(), minted.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.ProjectID != projectID || got.OrgID != orgID || got.Scope != db.ScopeIngest {
		t.Fatalf("lookup = %+v", got)
	}
}

func TestLookupProjectKeyRejectsWrongSecretPrefixAndRevocation(t *testing.T) {
	q, _, projectID := seedProjectKeyTest(t, "project-keys-rejections")
	ctx := context.Background()
	minted, err := q.CreateProjectKey(ctx, projectID, db.ScopeIngest, "test", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := db.ParseProjectKey(minted.Raw)
	if err != nil {
		t.Fatal(err)
	}
	bad := []byte(parsed.Secret)
	if bad[0] == 'A' {
		bad[0] = 'B'
	} else {
		bad[0] = 'A'
	}
	forgedSecret := "opslane_pk_" + parsed.KeyID + "_" + string(bad)
	forgedPrefix := "opslane_sk_" + minted.Raw[len("opslane_pk_"):]
	for name, raw := range map[string]string{
		"wrong secret": forgedSecret,
		"wrong prefix": forgedPrefix,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := q.LookupProjectKey(ctx, raw); !errors.Is(err, db.ErrProjectKeyInvalid) {
				t.Fatalf("err = %v, want ErrProjectKeyInvalid", err)
			}
		})
	}
	if _, err := q.Pool().Exec(ctx,
		`UPDATE project_api_keys SET revoked_at = now() WHERE key_id = $1`,
		minted.KeyID); err != nil {
		t.Fatal(err)
	}
	if _, err := q.LookupProjectKey(ctx, minted.Raw); !errors.Is(err, db.ErrProjectKeyInvalid) {
		t.Fatalf("revoked err = %v, want ErrProjectKeyInvalid", err)
	}
}

func TestCreateProjectKeyDoesNotRevokeOthers(t *testing.T) {
	q, _, projectID := seedProjectKeyTest(t, "project-keys-no-revoke")
	ctx := context.Background()
	first, err := q.CreateProjectKey(ctx, projectID, db.ScopeIngest, "first", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := q.CreateProjectKey(ctx, projectID, db.ScopeIngest, "second", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	for name, raw := range map[string]string{"first": first.Raw, "second": second.Raw} {
		if _, err := q.LookupProjectKey(ctx, raw); err != nil {
			t.Errorf("%s key stopped working: %v", name, err)
		}
	}
}

func TestLookupProjectKeyDistinguishesDatabaseFailure(t *testing.T) {
	q, _, projectID := seedProjectKeyTest(t, "project-keys-db-failure")
	minted, err := q.CreateProjectKey(
		context.Background(), projectID, db.ScopeIngest, "test", nil, "",
	)
	if err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = q.LookupProjectKey(cancelled, minted.Raw)
	if err == nil || errors.Is(err, db.ErrProjectKeyInvalid) {
		t.Fatalf("database failure was reported as invalid key: %v", err)
	}
}
