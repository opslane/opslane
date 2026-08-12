package db_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestMigration047BackfillsEveryOpenIncidentOnce(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if filepath.Base(file) == "047_readiness_backfill.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}

	ctx := context.Background()
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-047') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1, 'p') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}

	type expected struct{ status, reason string }
	want := make(map[string]expected)
	seedGroup := func(name, status string, diff *string, evidence *string) string {
		t.Helper()
		var id string
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id, fingerprint, title, first_seen, last_seen, status, candidate_diff, verification_evidence)
			VALUES ($1, $2, $2, now(), now(), $3, $4, $5::jsonb) RETURNING id`,
			projectID, name, status, diff, evidence).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	str := func(value string) *string { return &value }
	seedDecision := func(groupID, outcome, diagnosis string, decidedAt time.Time) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO diagnosis_decisions
			(error_group_id, project_id, outcome, decision_reason, diagnosis, model, prompt_version, decided_at)
			VALUES ($1, $2, $3, 'backfill test', $4::jsonb, 'test-model', 'test-v1', $5)`,
			groupID, projectID, outcome, diagnosis, decidedAt); err != nil {
			t.Fatal(err)
		}
	}
	add := func(name, status string, diff, evidence *string, expected expected) string {
		id := seedGroup(name, status, diff, evidence)
		want[id] = expected
		return id
	}

	add("draft", "pr_draft", nil, nil, expected{"eligible", "backfill_receipt_state"})
	add("created", "pr_created", nil, nil, expected{"eligible", "backfill_receipt_state"})
	add("diff", "needs_human", str("diff --git a/a b/a"), nil, expected{"eligible", "backfill_receipt_state"})
	add("no-receipt", "needs_human", nil, nil, expected{"pending", "backfill_unverified"})
	add("empty-evidence", "needs_human", nil, str(`{}`), expected{"pending", "backfill_unverified"})
	add("null-evidence", "needs_human", nil, str(`null`), expected{"pending", "backfill_unverified"})
	add("usable-check", "needs_human", nil, str(`{"checks":[{"name":"suite"}]}`), expected{"eligible", "backfill_receipt_state"})
	add("null-check", "needs_human", nil, str(`{"checks":[null]}`), expected{"pending", "backfill_unverified"})
	add("empty-check", "needs_human", nil, str(`{"checks":[{}]}`), expected{"pending", "backfill_unverified"})

	missingBrief := add("missing-brief", "investigated", nil, nil, expected{"pending", "backfill_unverified"})
	seedDecision(missingBrief, "code_fix", `{"evidence":[{"path":"a.ts","detail":"d","symptomLink":"s"}]}`, time.Now().Add(-time.Minute))
	fillerBrief := add("filler-brief", "investigated", nil, nil, expected{"pending", "backfill_unverified"})
	seedDecision(fillerBrief, "code_fix", `{"agentTaskBrief":"tbd later","evidence":[{"path":"a.ts","detail":"d","symptomLink":"s"}]}`, time.Now())
	validCause := add("valid-cause", "investigated", nil, nil, expected{"eligible", "backfill_validated_cause"})
	seedDecision(validCause, "code_fix", `{"agentTaskBrief":"Fix the null guard","evidence":[{"path":"a.ts","detail":"d","symptomLink":"s"}]}`, time.Now())
	validNotActionable := add("valid-not-actionable", "investigated", nil, nil, expected{"eligible", "backfill_validated_cause"})
	seedDecision(validNotActionable, "not_actionable", `{"evidence":[{"path":"a.ts","detail":"d","symptomLink":"s"}]}`, time.Now())
	corruptEvidence := add("corrupt-decision", "investigated", nil, nil, expected{"pending", "backfill_unverified"})
	seedDecision(corruptEvidence, "code_fix", `{"agentTaskBrief":"Fix it","evidence":"corrupt"}`, time.Now())
	emptyCitation := add("empty-citation", "investigated", nil, nil, expected{"pending", "backfill_unverified"})
	seedDecision(emptyCitation, "code_fix", `{"agentTaskBrief":"Fix it","evidence":[{"path":"a.ts","detail":"","symptomLink":"s"}]}`, time.Now())
	latestInvalid := add("latest-invalid", "investigated", nil, nil, expected{"pending", "backfill_unverified"})
	seedDecision(latestInvalid, "not_actionable", `{"evidence":[{"path":"a.ts","detail":"d","symptomLink":"s"}]}`, time.Now().Add(-time.Hour))
	seedDecision(latestInvalid, "needs_more_context", `{}`, time.Now())

	resolvedID := seedGroup("resolved", "resolved", nil, nil)
	preexistingID := seedGroup("preexisting", "new", nil, nil)
	if _, err := pool.Exec(ctx, `INSERT INTO digest_readiness
		(incident_id, project_id, status, reason) VALUES ($1, $2, 'ineligible', 'quarantined_degenerate')`,
		preexistingID, projectID); err != nil {
		t.Fatal(err)
	}
	want[preexistingID] = expected{"ineligible", "quarantined_degenerate"}

	path := filepath.Join("migrations", "047_readiness_backfill.sql")
	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatal(err)
	}
	for id, expected := range want {
		var status, reason string
		if err := pool.QueryRow(ctx, `SELECT status, reason FROM digest_readiness WHERE incident_id=$1`, id).Scan(&status, &reason); err != nil {
			t.Fatalf("readiness for %s: %v", id, err)
		}
		if status != expected.status || reason != expected.reason {
			t.Errorf("readiness %s = %s/%s, want %s/%s", id, status, reason, expected.status, expected.reason)
		}
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM digest_readiness WHERE incident_id=$1`, resolvedID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("resolved readiness count=%d err=%v, want 0", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM error_groups g
		WHERE g.status NOT IN ('resolved','merged','archived')
		  AND NOT EXISTS (SELECT 1 FROM digest_readiness dr WHERE dr.incident_id=g.id)`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("open incidents without readiness=%d err=%v", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM applied_data_migrations WHERE name='047_readiness_backfill'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("migration markers=%d err=%v", count, err)
	}

	if _, err := pool.Exec(ctx, `UPDATE digest_readiness SET status='eligible', reason='validated_cause' WHERE incident_id=$1`, missingBrief); err != nil {
		t.Fatal(err)
	}
	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatal(err)
	}
	var status, reason string
	if err := pool.QueryRow(ctx, `SELECT status, reason FROM digest_readiness WHERE incident_id=$1`, missingBrief).Scan(&status, &reason); err != nil {
		t.Fatal(err)
	}
	if status != "eligible" || reason != "validated_cause" {
		t.Fatalf("reapply overwrote pipeline row with %s/%s", status, reason)
	}
}
