package db_test

import (
	"context"
	"path/filepath"
	"testing"
)

func TestMigration045QuarantinesOnlyAnchoredDegenerateCausesOnce(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	files := migrationFiles(t)
	for _, file := range files {
		if filepath.Base(file) == "045_quarantine_degenerate_verdicts.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s: %v", file, err)
		}
	}

	ctx := context.Background()
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-045') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1, 'p') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 3)
	causes := []string{
		"placeholder while I continue reading",
		"NPE in checkout when coupon is stale",
		"The placeholder text in the input is misrendered",
	}
	for i, cause := range causes {
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id, fingerprint, title, first_seen, last_seen, status, root_cause)
			VALUES ($1, $2, 'x', now(), now(), 'investigated', $3) RETURNING id`, projectID, "fp-"+cause, cause).Scan(&ids[i]); err != nil {
			t.Fatal(err)
		}
	}

	path := filepath.Join("migrations", "045_quarantine_degenerate_verdicts.sql")
	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatal(err)
	}
	var incidentID, status, reason string
	if err := pool.QueryRow(ctx, `SELECT incident_id, status, reason FROM digest_readiness`).Scan(&incidentID, &status, &reason); err != nil {
		t.Fatal(err)
	}
	if incidentID != ids[0] || status != "ineligible" || reason != "quarantined_degenerate" {
		t.Fatalf("quarantine row = %s %s %s", incidentID, status, reason)
	}

	if _, err := pool.Exec(ctx, `UPDATE digest_readiness SET status='eligible', reason='validated_cause' WHERE incident_id=$1`, ids[0]); err != nil {
		t.Fatal(err)
	}
	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT status, reason FROM digest_readiness WHERE incident_id=$1`, ids[0]).Scan(&status, &reason); err != nil {
		t.Fatal(err)
	}
	if status != "eligible" || reason != "validated_cause" {
		t.Fatalf("reapply changed validated row to %s/%s", status, reason)
	}
}
