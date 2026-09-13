package db_test

import (
	"context"
	"github.com/opslane/opslane/packages/ingestion/db"
	"testing"
	"time"
)

func TestOrgHasActiveGitHubInstallation(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, _ := approveTenant(t, q)
	installationID := time.Now().UnixNano()
	if _, err := q.Pool().Exec(ctx, `UPDATE orgs SET github_installation_id=$2 WHERE id=$1`, orgID, installationID); err != nil {
		t.Fatal(err)
	}
	assert := func(want bool) {
		t.Helper()
		got, err := q.OrgHasActiveGitHubInstallation(ctx, orgID)
		if err != nil || got != want {
			t.Fatalf("installed=%v want %v: %v", got, want, err)
		}
	}
	assert(false)
	if _, err := q.Pool().Exec(ctx, `INSERT INTO github_app_installations (installation_id,github_org_name,github_org_id,org_id,suspended) VALUES ($1,'facts',1,$2,true)`, installationID, orgID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		q.Pool().Exec(ctx, `DELETE FROM github_app_installations WHERE installation_id=$1`, installationID)
	})
	assert(false)
	if _, err := q.Pool().Exec(ctx, `UPDATE github_app_installations SET suspended=false WHERE installation_id=$1`, installationID); err != nil {
		t.Fatal(err)
	}
	assert(true)
}

func TestHasEnabledSlackDestination(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, _ := approveTenant(t, q)
	p := createProject(t, q, orgID, "facts")
	assert := func(want bool) {
		t.Helper()
		got, err := q.HasEnabledSlackDestination(ctx, p.ID)
		if err != nil || got != want {
			t.Fatalf("slack=%v want %v: %v", got, want, err)
		}
	}
	assert(false)
	var id string
	if err := q.Pool().QueryRow(ctx, `INSERT INTO notification_destinations (id,config_fingerprint,project_id,type,name,config_encrypted,enabled,event_types) VALUES (gen_random_uuid(),'facts',$1,'slack','facts','encrypted',false,ARRAY['issue.created']) RETURNING id`, p.ID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { q.Pool().Exec(ctx, `DELETE FROM notification_destinations WHERE id=$1`, id) })
	assert(false)
	if _, err := q.Pool().Exec(ctx, `UPDATE notification_destinations SET enabled=true WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	assert(true)
}
