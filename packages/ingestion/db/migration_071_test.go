package db_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func applyMigrationsThrough070(t *testing.T) (*pgxpool.Pool, string, string) {
	t.Helper()
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if filepath.Base(file) == "071_dead_letter_class.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
	ctx := context.Background()
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-071') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id,name) VALUES ($1,'p') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	return pool, dsn, projectID
}

func TestMigration071RepairsStrandedInvestigation(t *testing.T) {
	pool, dsn, projectID := applyMigrationsThrough070(t)
	ctx := context.Background()
	psql := findPsql(t)

	var groupID, jobID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id,fingerprint,title,first_seen,last_seen,status,reason_code,
		 reason_message,remediation,needs_human_at)
		VALUES ($1,'071-stranded','x',now(),now(),'needs_human','worker_runtime_error',
		 'worker failed','retry it',now() - interval '1 day') RETURNING id`, projectID).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO error_group_jobs
		(error_group_id,project_id,job_type,status,attempts,max_attempts,last_error)
		VALUES ($1,$2,'investigate','dead_letter',3,3,'template missing') RETURNING id`,
		groupID, projectID).Scan(&jobID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET terminal_fix_job_id=$2 WHERE id=$1`, groupID, jobID); err != nil {
		t.Fatal(err)
	}

	// Controls the backfill must not touch: a needs_human with an evidence
	// verdict, one whose terminal job is a fix, and one whose dead job is
	// already classed. Each keeps its status and reason on every replay.
	type control struct {
		fingerprint, reasonCode, jobType string
		classed                          bool
	}
	controls := []control{
		{"071-verdict", "unfixable_no_app_frames", "investigate", false},
		{"071-fix", "worker_runtime_error", "fix", false},
	}
	controlIDs := map[string]string{}
	seedControl := func(c control) {
		var gid, jid string
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id,fingerprint,title,first_seen,last_seen,status,reason_code,
			 reason_message,remediation,needs_human_at)
			VALUES ($1,$2,'x',now(),now(),'needs_human',$3,'why','do',now() - interval '1 day') RETURNING id`,
			projectID, c.fingerprint, c.reasonCode).Scan(&gid); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `INSERT INTO error_group_jobs
			(error_group_id,project_id,job_type,status,attempts,max_attempts,last_error)
			VALUES ($1,$2,$3,'dead_letter',3,3,'x') RETURNING id`, gid, projectID, c.jobType).Scan(&jid); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE error_groups SET terminal_fix_job_id=$2 WHERE id=$1`, gid, jid); err != nil {
			t.Fatal(err)
		}
		if c.classed {
			if _, err := pool.Exec(ctx, `UPDATE error_group_jobs SET dead_letter_class='agent' WHERE id=$1`, jid); err != nil {
				t.Fatal(err)
			}
		}
		controlIDs[c.fingerprint] = gid
	}
	for _, c := range controls {
		seedControl(c)
	}

	path := filepath.Join("migrations", "071_dead_letter_class.sql")
	var retainedNeedsHumanAt time.Time
	for boot := 0; boot < 2; boot++ {
		if err := applyMigration(t, psql, dsn, path); err != nil {
			t.Fatalf("boot %d apply 071: %v", boot, err)
		}
		var status string
		var reasonCode, reasonMessage, remediation, terminalJobID *string
		var needsHumanAt time.Time
		if err := pool.QueryRow(ctx, `SELECT status,reason_code,reason_message,remediation,
			terminal_fix_job_id,needs_human_at FROM error_groups WHERE id=$1`, groupID).Scan(
			&status, &reasonCode, &reasonMessage, &remediation, &terminalJobID, &needsHumanAt,
		); err != nil {
			t.Fatal(err)
		}
		if status != "analyzing" || reasonCode != nil || reasonMessage != nil || remediation != nil || terminalJobID != nil {
			t.Fatalf("boot %d group not repaired: status=%q reason=%v/%v/%v terminal=%v", boot, status, reasonCode, reasonMessage, remediation, terminalJobID)
		}
		if boot == 0 {
			retainedNeedsHumanAt = needsHumanAt
		} else if !needsHumanAt.Equal(retainedNeedsHumanAt) {
			t.Fatalf("needs_human_at changed on replay: first=%s second=%s", retainedNeedsHumanAt, needsHumanAt)
		}

		var class string
		var requeues int
		var deadLetteredAt time.Time
		if err := pool.QueryRow(ctx, `SELECT dead_letter_class,requeues,dead_lettered_at
			FROM error_group_jobs WHERE id=$1`, jobID).Scan(&class, &requeues, &deadLetteredAt); err != nil {
			t.Fatal(err)
		}
		if class != "config" || requeues != 0 || deadLetteredAt.IsZero() {
			t.Fatalf("boot %d job not classed: class=%q requeues=%d dead_lettered_at=%s", boot, class, requeues, deadLetteredAt)
		}
		if boot == 0 {
			// A stranded row whose dead job already carries a class (only
			// possible once the column exists) belongs to the worker's requeue
			// policy, not to the backfill; the second replay must leave it.
			seedControl(control{"071-classed", "worker_runtime_error", "investigate", true})
		}
		for fingerprint, gid := range controlIDs {
			var cs string
			var cr *string
			if err := pool.QueryRow(ctx, `SELECT status, reason_code FROM error_groups WHERE id=$1`, gid).Scan(&cs, &cr); err != nil {
				t.Fatal(err)
			}
			if cs != "needs_human" || cr == nil {
				t.Fatalf("boot %d control %s was repaired: status=%q reason=%v", boot, fingerprint, cs, cr)
			}
		}
	}
}
