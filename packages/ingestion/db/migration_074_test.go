package db_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const migration074File = "migrations/074_friction_tickets.sql"

func applyKnownProblemMigrations(t *testing.T, dsn string) {
	t.Helper()
	psql := findPsql(t)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
}

func requireMigrationConstraint(t *testing.T, err error, code string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != code {
		t.Fatalf("want PostgreSQL constraint error %s, got %v", code, err)
	}
}

func TestMigration074FreshInstallAndPopulatedReplay(t *testing.T) {
	// This must start empty: 069 creates ticket_id before 074 adds its FK.
	pool, dsn := disposableDB(t, testPool(t))
	applyKnownProblemMigrations(t, dsn)
	ctx := context.Background()
	tables := []string{
		"friction_tickets", "friction_observation_decisions", "friction_ticket_matches",
		"friction_ticket_match_observations", "friction_session_processed", "friction_confirm_batches",
		"friction_check_attempts", "friction_checks", "friction_unavailable_retries",
		"friction_incident_evidence", "friction_fix_attempts",
	}
	for _, table := range tables {
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT to_regclass($1) IS NOT NULL`, "public."+table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Errorf("fresh install is missing %s", table)
		}
	}
	if t.Failed() {
		t.FailNow()
	}
	var hasFK bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conrelid='error_groups'::regclass
		AND confrelid='friction_tickets'::regclass AND contype='f'
		AND conname='error_groups_ticket_id_fkey')`).Scan(&hasFK); err != nil {
		t.Fatal(err)
	}
	if !hasFK {
		t.Fatal("fresh install did not add error_groups_ticket_id_fkey to 069's bare column")
	}
	insertID := func(query string, args ...any) string {
		t.Helper()
		var id string
		if err := pool.QueryRow(ctx, query, args...).Scan(&id); err != nil {
			t.Fatalf("seed fixture: %v\n%s", err, query)
		}
		return id
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("seed fixture: %v\n%s", err, query)
		}
	}
	orgID := insertID(`INSERT INTO orgs(name) VALUES ('074-replay') RETURNING id`)
	projectID := insertID(`INSERT INTO projects(org_id,name) VALUES ($1,'p') RETURNING id`, orgID)
	environmentID := insertID(`INSERT INTO environments(project_id,name) VALUES ($1,'production') RETURNING id`, projectID)
	sessionID := "074-session"
	exec(`INSERT INTO sessions(id,project_id,environment_id,started_at) VALUES ($1,$2,$3,now())`, sessionID, projectID, environmentID)
	exec(`INSERT INTO session_narratives(session_id,project_id,environment_id,status,narrative,prompt_version)
		VALUES ($1,$2,$3,'ok','{"observations":[]}',3)`, sessionID, projectID, environmentID)
	signalID := insertID(`INSERT INTO friction_signals
		(session_id,project_id,environment_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,observation_id,narrative_id,evidence_lines)
		VALUES ($1,$2,$3,3,'narrative','074-observation','/checkout',now(),'observation-1','narrative-1','["Clicked Pay; nothing changed"]') RETURNING id`, sessionID, projectID, environmentID)
	ticketID := insertID(`INSERT INTO friction_tickets
		(project_id,environment_id,name,control,what_happened,kind,status,matched_count,next_arrival_number,arrival_boundary,live_generation)
		VALUES ($1,$2,'Payment stalls','Pay','Nothing changed','defect','published',1,1,1,2) RETURNING id`, projectID, environmentID)
	exec(`INSERT INTO friction_observation_decisions(signal_id,project_id,environment_id,session_id,decision,ticket_id,decided_by)
		VALUES ($1,$2,$3,$4,'created',$5,'strong')`, signalID, projectID, environmentID, sessionID, ticketID)
	exec(`INSERT INTO friction_ticket_matches(ticket_id,session_id,project_id,environment_id,arrival_number,source,occurred_at)
		VALUES ($1,$2,$3,$4,1,'strong',now())`, ticketID, sessionID, projectID, environmentID)
	exec(`INSERT INTO friction_ticket_match_observations(ticket_id,session_id,signal_id) VALUES ($1,$2,$3)`, ticketID, sessionID, signalID)
	exec(`INSERT INTO friction_session_processed(project_id,session_id,narrative_id) VALUES ($1,$2,'narrative-1')`, projectID, sessionID)
	groupSQL := `INSERT INTO error_groups(project_id,fingerprint,title,first_seen,last_seen,kind,status,ticket_id,publication_generation,fix_substate,investigation_status)
		VALUES ($1,$2,'Payment stalls',now(),now(),'friction',$3,$4,$5,'none','pending') RETURNING id`
	archivedID := insertID(groupSQL, projectID, "ticket|"+ticketID+"|1", "archived", ticketID, 1)
	groupID := insertID(groupSQL, projectID, "ticket|"+ticketID+"|2", "awaiting_approval", ticketID, 2)
	jobID := insertID(`INSERT INTO error_group_jobs(error_group_id,project_id,job_type,status,ticket_id,publication_generation,source_id)
		VALUES ($1,$2,'friction_confirm','completed',$3,2,$1) RETURNING id`, groupID, projectID, ticketID)
	batchID := insertID(`INSERT INTO friction_confirm_batches(ticket_id,job_id,manifest,arrival_boundary_at_select,live_generation_at_select,status_at_select,status)
		VALUES ($1,$2,'["074-session"]',1,2,'published','finalized') RETURNING id`, ticketID, jobID)
	stagingBatchID := insertID(`INSERT INTO friction_confirm_batches(ticket_id,job_id,manifest,arrival_boundary_at_select,live_generation_at_select,status_at_select)
		VALUES ($1,$2,'["074-session"]',1,2,'published') RETURNING id`, ticketID, jobID)
	attemptSQL := `INSERT INTO friction_check_attempts(batch_id,ticket_id,session_id,outcome,model,evidence_lines,signal_ids)
		VALUES ($1,$2,$3,'confirmed','test-model','["Pay did not respond"]',jsonb_build_array($4::text)) RETURNING id`
	attemptID := insertID(attemptSQL, batchID, ticketID, sessionID, signalID)
	insertID(attemptSQL, stagingBatchID, ticketID, sessionID, signalID)
	exec(`INSERT INTO friction_checks(ticket_id,session_id,attempt_id,outcome) VALUES ($1,$2,$3,'confirmed')`, ticketID, sessionID, attemptID)
	exec(`INSERT INTO friction_unavailable_retries(ticket_id,session_id,attempts,retry_at) VALUES ($1,$2,1,now()+interval '1 hour')`, ticketID, sessionID)
	for generation, id := range []string{archivedID, groupID} {
		exec(`INSERT INTO friction_incident_evidence(error_group_id,ticket_id,generation,signal_id) VALUES ($1,$2,$3,$4)`, id, ticketID, generation+1, signalID)
	}
	exec(`INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status) VALUES ($1,$2,2,'active')`, ticketID, groupID)

	// A distinct fingerprint and generation cannot bypass the one-live-group rule.
	_, err := pool.Exec(ctx, groupSQL, projectID, "ticket|"+ticketID+"|3", "awaiting_approval", ticketID, 3)
	requireMigrationConstraint(t, err, "23505")
	_, err = pool.Exec(ctx, `INSERT INTO friction_signals
		(session_id,project_id,environment_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,observation_id,narrative_id)
		VALUES ($1,$2,$3,4,'narrative','different-fingerprint','/checkout',now(),'observation-1','narrative-1')`, sessionID, projectID, environmentID)
	requireMigrationConstraint(t, err, "23505")

	// Test both 069 predicates: a queued ticket must not receive a job, and
	// an awaiting-approval ticket must not move back to queued.
	exec(`UPDATE error_groups SET status='queued' WHERE id=$1`, groupID)
	if err := applyMigration(t, findPsql(t), dsn, "migrations/069_verdict_gated_investigation.sql"); err != nil {
		t.Fatal(err)
	}
	if count := investigateJobCount(t, pool, groupID); count != 0 {
		t.Fatalf("069 enqueued %d investigation jobs for a ticket-backed group", count)
	}
	exec(`UPDATE error_groups SET status='awaiting_approval' WHERE id=$1`, groupID)

	// Compare complete rows, including immutable staged attempts and generation
	// history, to detect destructive replay or silent changes to evidence.
	tables = append(tables, "friction_signals", "session_narratives", "error_groups", "error_group_jobs")
	before := knownProblemRows(t, pool, tables)
	applyKnownProblemMigrations(t, dsn)
	after := knownProblemRows(t, pool, tables)
	for _, table := range tables {
		if before[table] != after[table] {
			t.Errorf("replaying migrations changed %s rows:\nbefore: %s\nafter: %s", table, before[table], after[table])
		}
	}
	if status := groupStatus(t, pool, groupID); status != "awaiting_approval" {
		t.Errorf("069 moved ticket-backed group to %s", status)
	}
	if count := investigateJobCount(t, pool, groupID); count != 0 {
		t.Errorf("069 added %d investigation jobs during full replay", count)
	}
}

func knownProblemRows(t *testing.T, pool *pgxpool.Pool, tables []string) map[string]string {
	t.Helper()
	result := make(map[string]string, len(tables))
	for _, table := range tables {
		var rows string
		query := fmt.Sprintf(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text FROM %s r`, table)
		if err := pool.QueryRow(context.Background(), query).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		result[table] = rows
	}
	return result
}

func TestMigration074UpgradesAutonomyAndReplaysCheck(t *testing.T) {
	pool, dsn := disposableDB(t, testPool(t))
	psql := findPsql(t)
	for _, file := range migrationFiles(t) {
		if filepath.ToSlash(file) >= migration074File {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
	ctx := context.Background()
	var projectID string
	if err := pool.QueryRow(ctx, `WITH org AS (INSERT INTO orgs(name) VALUES ('074-autonomy') RETURNING id)
		INSERT INTO projects(org_id,name,friction_autonomy) SELECT id,'p','auto_fix_ux' FROM org RETURNING id`).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	if err := applyMigration(t, psql, dsn, migration074File); err != nil {
		t.Fatalf("upgrade existing auto_fix_ux project: %v", err)
	}
	for boot := 0; boot < 2; boot++ {
		var autonomy string
		if err := pool.QueryRow(ctx, `SELECT friction_autonomy FROM projects WHERE id=$1`, projectID).Scan(&autonomy); err != nil {
			t.Fatal(err)
		}
		if autonomy != "auto_fix" {
			t.Fatalf("boot %d: legacy autonomy = %s, want auto_fix", boot, autonomy)
		}
		for _, value := range []string{"ask_first", "auto_fix"} {
			if _, err := pool.Exec(ctx, `UPDATE projects SET friction_autonomy=$2 WHERE id=$1`, projectID, value); err != nil {
				t.Fatalf("boot %d: valid autonomy %s rejected: %v", boot, value, err)
			}
		}
		_, err := pool.Exec(ctx, `UPDATE projects SET friction_autonomy='auto_fix_ux' WHERE id=$1`, projectID)
		requireMigrationConstraint(t, err, "23514")
		if boot == 0 {
			applyKnownProblemMigrations(t, dsn)
		}
	}
}
