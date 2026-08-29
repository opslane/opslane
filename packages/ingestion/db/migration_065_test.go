package db_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// oldDraft065SQL is the shape of migration 065 that dev and verification
// databases already applied before shadow mode was cut. The shipped file is
// edited in place (065 never reached production), so the only compatibility
// obligation is that the edited file replays onto this shape — including its
// 'shadow' run rows, which the tightened CHECK would otherwise reject.
const oldDraft065SQL = `
ALTER TABLE digest_run_candidate_evaluations
  ADD COLUMN IF NOT EXISTS shadow_render_mode TEXT;
ALTER TABLE digest_runs
  ADD COLUMN IF NOT EXISTS unified_cards_mode TEXT NOT NULL DEFAULT 'off';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='digest_runs_unified_mode_check') THEN
    ALTER TABLE digest_runs ADD CONSTRAINT digest_runs_unified_mode_check
      CHECK (unified_cards_mode IN ('off','shadow','on'));
  END IF;
END $$;
`

func TestMigration065ReplaysOverOldShadowDraft(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if filepath.Base(file) == "065_unified_digest_cards.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
	ctx := context.Background()
	if _, err := pool.Exec(ctx, oldDraft065SQL); err != nil {
		t.Fatalf("build old-draft 065 shape: %v", err)
	}
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-065-replay') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id,name) VALUES ($1,'p') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	var shadowRunID string
	if err := pool.QueryRow(ctx, `INSERT INTO digest_runs
		(project_id,window_from,window_to,run_date,status,unified_cards_mode)
		VALUES ($1,now()-interval '1 day',now(),current_date,'delivered','shadow')
		RETURNING id`, projectID).Scan(&shadowRunID); err != nil {
		t.Fatal(err)
	}

	if err := applyMigration(t, psql, dsn, filepath.Join("migrations", "065_unified_digest_cards.sql")); err != nil {
		t.Fatalf("replay edited 065 over the old draft: %v", err)
	}
	var mode string
	if err := pool.QueryRow(ctx, `SELECT unified_cards_mode FROM digest_runs WHERE id=$1`, shadowRunID).Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != "off" {
		t.Fatalf("stray shadow run normalized to %q, want off", mode)
	}
	var check string
	if err := pool.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint
		WHERE conname='digest_runs_unified_mode_check'`).Scan(&check); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(check, "shadow") {
		t.Fatalf("replayed CHECK still admits shadow: %s", check)
	}
}

func TestMigration065AddsUnifiedDigestSchemaWithoutBreakingOldWriters(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if filepath.Base(file) == "065_unified_digest_cards.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
	ctx := context.Background()
	var legacyPrimaryKeyOID uint32
	if err := pool.QueryRow(ctx, `SELECT oid FROM pg_constraint
		WHERE conrelid='digest_run_items'::regclass AND contype='p'`).Scan(&legacyPrimaryKeyOID); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join("migrations", "065_unified_digest_cards.sql")
	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatal(err)
	}
	var orgID, projectID, groupID, episodeID, runID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-065') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id,name) VALUES ($1,'p') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id,fingerprint,title,first_seen,last_seen,status)
		VALUES ($1,'migration-065','x',now(),now(),'new') RETURNING id`, projectID).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence)
		VALUES ($1,$2,1) RETURNING id`, projectID, groupID).Scan(&episodeID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO digest_runs
		(project_id,window_from,window_to,run_date,status)
		VALUES ($1,now()-interval '1 day',now(),current_date,'frozen') RETURNING id`, projectID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	var mode string
	if err := pool.QueryRow(ctx, `SELECT unified_cards_mode FROM digest_runs WHERE id=$1`, runID).Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != "off" {
		t.Fatalf("default mode = %q, want off", mode)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO digest_run_items
		(project_id,run_id,episode_id,candidate_snapshot) VALUES ($1,$2,$3,'{}')`, projectID, runID, episodeID); err != nil {
		t.Fatalf("old run-item writer failed: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO digest_unified_run_items
		(project_id,run_id,error_group_id,candidate_snapshot) VALUES ($1,$2,$3,'{}')`, projectID, runID, groupID); err != nil {
		t.Fatalf("unified friction writer failed: %v", err)
	}

	if _, err := pool.Exec(ctx, `INSERT INTO digest_card_copy
		(error_group_id,spell_started_at,input_fingerprint,title,copy,action,model,prompt_version)
		VALUES ($1,now(),'a','t','c','a','m',4)`, groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO digest_card_copy
		(error_group_id,spell_started_at,input_fingerprint,title,copy,action,model,prompt_version)
		SELECT error_group_id,spell_started_at,'b','t','c','a','m',4 FROM digest_card_copy
		WHERE error_group_id=$1 AND invalidated_at IS NULL`, groupID); err == nil {
		t.Fatal("unique current-copy index accepted two current rows")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO digest_run_candidate_evaluations
		(digest_run_id,error_group_id,outcome,primary_reason_code,phase)
		VALUES ($1,$2,'included','included','bogus')`, runID, groupID); err == nil {
		t.Fatal("phase check accepted bogus value")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO digest_run_candidate_evaluations
		(digest_run_id,error_group_id,outcome,primary_reason_code,render_mode)
		VALUES ($1,$2,'included','included','bogus')`, runID, groupID); err == nil {
		t.Fatal("render mode check accepted bogus value")
	}

	// Shadow mode is deleted, so a fresh install must never grow its columns.
	for _, column := range []struct{ table, name string }{
		{"digest_run_candidate_evaluations", "shadow_render_mode"},
		{"digest_card_copy", "source"},
	} {
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema='public' AND table_name=$1 AND column_name=$2)`,
			column.table, column.name).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if exists {
			t.Errorf("%s.%s exists on a fresh schema; shadow mode is deleted", column.table, column.name)
		}
	}
	var modeCheck string
	if err := pool.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint
		WHERE conname='digest_runs_unified_mode_check'`).Scan(&modeCheck); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(modeCheck, "shadow") {
		t.Errorf("unified mode CHECK still admits shadow: %s", modeCheck)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO digest_runs
		(project_id,window_from,window_to,run_date,status,unified_cards_mode)
		VALUES ($1,now()-interval '1 day',now(),current_date+1,'frozen','shadow')`, projectID); err == nil {
		t.Fatal("unified mode CHECK accepted shadow")
	}

	constraintOIDs := func() map[string]uint32 {
		rows, err := pool.Query(ctx, `SELECT conname,oid FROM pg_constraint
			WHERE conname IN ('drce_render_mode_check',
			'drce_phase_check','digest_runs_unified_mode_check') ORDER BY conname`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		got := map[string]uint32{}
		for rows.Next() {
			var name string
			var oid uint32
			if err := rows.Scan(&name, &oid); err != nil {
				t.Fatal(err)
			}
			got[name] = oid
		}
		return got
	}
	before := constraintOIDs()
	if len(before) != 3 {
		t.Fatalf("constraint count = %d, want 3", len(before))
	}
	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatalf("reapply: %v", err)
	}
	after := constraintOIDs()
	for name, oid := range before {
		if after[name] != oid {
			t.Errorf("constraint %s OID changed: %d -> %d", name, oid, after[name])
		}
	}
	var currentPrimaryKeyOID uint32
	if err := pool.QueryRow(ctx, `SELECT oid FROM pg_constraint
		WHERE conrelid='digest_run_items'::regclass AND contype='p'`).Scan(&currentPrimaryKeyOID); err != nil {
		t.Fatal(err)
	}
	if currentPrimaryKeyOID != legacyPrimaryKeyOID {
		t.Errorf("legacy digest_run_items primary key OID changed: %d -> %d", legacyPrimaryKeyOID, currentPrimaryKeyOID)
	}
}
