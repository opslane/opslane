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
	if applied, err := q.RetireGitHubInstallation(ctx, installationID, orgID); err != nil || applied {
		t.Fatalf("second retire: applied=%v err=%v", applied, err)
	}
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

func TestReactivateGitHubInstallation_RestoresPointerAfterRetire(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, installationID := seedInstallation(t, q, []string{"acme/web"})
	if _, err := q.RetireGitHubInstallation(ctx, installationID, ""); err != nil {
		t.Fatal(err)
	}
	if ok, err := q.ReactivateGitHubInstallation(ctx, installationID); err != nil || !ok {
		t.Fatalf("reactivate: %v %v", ok, err)
	}
	if active, _ := q.OrgHasActiveGitHubInstallation(ctx, orgID); !active {
		t.Fatal("reactivated installation must read active, pointer restored")
	}
	other := installationID + 1
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '[]')`, other, orgID); err != nil {
		t.Fatal(err)
	}
	if err := q.SetOrgGitHubInstallation(ctx, orgID, other); err != nil {
		t.Fatal(err)
	}
	if _, err := q.SetGitHubInstallationSuspended(ctx, installationID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := q.ReactivateGitHubInstallation(ctx, installationID); err != nil {
		t.Fatal(err)
	}
	if pointer, _ := q.GetOrgGitHubInstallation(ctx, orgID); pointer != other {
		t.Fatalf("pointer at another installation must survive reactivation: %d", pointer)
	}
	if ok, err := q.ReactivateGitHubInstallation(ctx, installationID+99); err != nil || ok {
		t.Fatalf("unknown reactivate: %v %v", ok, err)
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

func TestRepoCoveredByActiveInstallation_IsCaseInsensitive(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, installationID := seedInstallation(t, q, []string{"Acme/Web"})
	for _, name := range []string{"acme/web", "ACME/WEB", "Acme/Web"} {
		if ok, err := q.RepoCoveredByActiveInstallation(ctx, orgID, name); err != nil || !ok {
			t.Fatalf("%s must be covered: ok=%v err=%v", name, ok, err)
		}
	}
	if ok, _ := q.RepoCoveredByActiveInstallation(ctx, orgID, "acme/other"); ok {
		t.Fatal("unlisted repo must not be covered")
	}
	if _, err := q.SetGitHubInstallationSuspended(ctx, installationID, true); err != nil {
		t.Fatal(err)
	}
	if ok, _ := q.RepoCoveredByActiveInstallation(ctx, orgID, "acme/web"); ok {
		t.Fatal("a suspended installation covers nothing")
	}
}
