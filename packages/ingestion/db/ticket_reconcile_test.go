package db_test

import (
	"context"
	"fmt"
	"testing"
)

func TestTicketPurgeReconcilesPublication(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		recordings            int
		resolved              bool
		wantTicket, wantGroup string
	}{
		{"below publication bar", 3, false, "unpublished", "archived"},
		{"still verified", 5, false, "published", "awaiting_approval"},
		{"resolved stays resolved", 3, true, "published", "merged"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := seedTicketFixWithCount(t, tc.recordings)
			ctx := context.Background()
			if _, err := f.q.Pool().Exec(ctx, `UPDATE friction_tickets SET steps='Old recording steps' WHERE id=$1`, f.ticket); err != nil {
				t.Fatal(err)
			}
			if tc.resolved {
				if _, err := f.q.Pool().Exec(ctx, `UPDATE error_groups SET status='merged',fix_substate='resolved' WHERE id=$1`, f.group); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := f.q.Pool().Exec(ctx, `INSERT INTO digest_card_copy(error_group_id,spell_started_at,input_fingerprint,title,copy,action,model,prompt_version)
				VALUES($1,now(),'test','Payment stalls','Old recording quote','create_fix','test',7)`, f.group); err != nil {
				t.Fatal(err)
			}
			session := f.ticket + "-0"
			if tc.wantTicket == "unpublished" {
				// A deferred check sees the state at the purge's commit boundary.
				// Reconciliation performed after commit would fail this constraint.
				if _, err := f.q.Pool().Exec(ctx, `CREATE FUNCTION assert_purge_reconciled() RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN IF EXISTS(SELECT 1 FROM friction_tickets WHERE project_id=OLD.project_id AND status='published') THEN
					RAISE EXCEPTION 'purge committed before reconciliation'; END IF; RETURN NULL; END $$;
					CREATE CONSTRAINT TRIGGER purge_reconciled AFTER DELETE ON sessions DEFERRABLE INITIALLY DEFERRED
					FOR EACH ROW EXECUTE FUNCTION assert_purge_reconciled()`); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := f.q.Pool().Exec(ctx, `UPDATE sessions SET status='deleting' WHERE id=$1`, session); err != nil {
				t.Fatal(err)
			}
			if err := f.q.DeleteMarkedSession(ctx, session, f.project); err != nil {
				t.Fatal(err)
			}
			var ticketStatus, groupStatus string
			var matched, version int
			var invalidated bool
			var steps *string
			if err := f.q.Pool().QueryRow(ctx, `SELECT t.status,g.status,t.matched_count,t.evidence_version,t.steps,c.invalidated_at IS NOT NULL
				FROM friction_tickets t JOIN error_groups g ON g.ticket_id=t.id JOIN digest_card_copy c ON c.error_group_id=g.id WHERE t.id=$1`, f.ticket).
				Scan(&ticketStatus, &groupStatus, &matched, &version, &steps, &invalidated); err != nil {
				t.Fatal(err)
			}
			if ticketStatus != tc.wantTicket || groupStatus != tc.wantGroup || matched != tc.recordings-1 || version != 2 {
				t.Fatalf("ticket=%s group=%s matched=%d version=%d", ticketStatus, groupStatus, matched, version)
			}
			if !tc.resolved && (!invalidated || steps != nil) {
				t.Fatalf("stale presentation survived: invalidated=%v steps=%v", invalidated, steps)
			}
			if err := f.q.DeleteMarkedSession(ctx, session, f.project); err != nil {
				t.Fatal(err)
			}
			if err := f.q.Pool().QueryRow(ctx, `SELECT evidence_version FROM friction_tickets WHERE id=$1`, f.ticket).Scan(&version); err != nil || version != 2 {
				t.Fatalf("repeated purge changed evidence: %d %v", version, err)
			}
		})
	}
}

func TestTicketArchivePermanentlyCancelsWork(t *testing.T) {
	f := seedTicketFix(t)
	ctx := context.Background()
	var oldGroup string
	if err := f.q.Pool().QueryRow(ctx, `INSERT INTO error_groups(project_id,fingerprint,title,first_seen,last_seen,kind,status,ticket_id,publication_generation)
		VALUES($1,$2,'Old publication',now(),now(),'friction','archived',$3,0) RETURNING id`, f.project, "old|"+f.ticket, f.ticket).Scan(&oldGroup); err != nil {
		t.Fatal(err)
	}
	if err := f.q.ArchiveErrorGroup(ctx, f.project, oldGroup); err == nil {
		t.Fatal("old generation archived current problem")
	}
	if _, err := f.q.TriggerFixJob(ctx, f.project, f.group, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := f.q.Pool().Exec(ctx, `INSERT INTO error_group_jobs(project_id,ticket_id,job_type,source_id) VALUES($1,$2,'friction_confirm',$2)`, f.project, f.ticket); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := f.q.ArchiveErrorGroup(ctx, f.project, f.group); err != nil {
			t.Fatal(err)
		}
	}
	var ticketStatus, groupStatus, attemptStatus string
	var unfinished int
	if err := f.q.Pool().QueryRow(ctx, `SELECT t.status,g.status,a.status,(SELECT count(*) FROM error_group_jobs WHERE ticket_id=t.id AND status IN ('pending','claimed'))
		FROM friction_tickets t JOIN error_groups g ON g.ticket_id=t.id JOIN friction_fix_attempts a ON a.error_group_id=g.id WHERE t.id=$1`, f.ticket).
		Scan(&ticketStatus, &groupStatus, &attemptStatus, &unfinished); err != nil {
		t.Fatal(err)
	}
	if ticketStatus != "archived" || groupStatus != "archived" || attemptStatus != "superseded" || unfinished != 0 {
		t.Fatalf("ticket=%s group=%s attempt=%s unfinished=%d", ticketStatus, groupStatus, attemptStatus, unfinished)
	}
	if err := f.q.UnarchiveErrorGroup(ctx, f.project, f.group); err == nil {
		t.Fatal("ticket unarchived")
	}
}

func TestTicketIdentityChangeReconcilesInTransaction(t *testing.T) {
	f := seedTicketFix(t)
	ctx := context.Background()
	users := make([]string, 2)
	for i := range users {
		if err := f.q.Pool().QueryRow(ctx, `INSERT INTO end_users(project_id,external_user_id,first_seen,last_seen) VALUES($1,$2,now(),now()) RETURNING id`, f.project, fmt.Sprintf("person-%d", i)).Scan(&users[i]); err != nil {
			t.Fatal(err)
		}
	}
	// Establish two identified people before applying the identity-change seam.
	for i := 0; i < 4; i++ {
		session := fmt.Sprintf("%s-%d", f.ticket, i)
		if _, err := f.q.Pool().Exec(ctx, `UPDATE sessions SET end_user_id=$2 WHERE id=$1`, session, users[i%2]); err != nil {
			t.Fatal(err)
		}
		if _, err := f.q.Pool().Exec(ctx, `UPDATE friction_ticket_matches SET end_user_id=$2 WHERE session_id=$1`, session, users[i%2]); err != nil {
			t.Fatal(err)
		}
	}
	for _, i := range []int{1, 3} {
		if err := f.q.SetSessionIdentity(ctx, fmt.Sprintf("%s-%d", f.ticket, i), f.project, &users[0]); err != nil {
			t.Fatal(err)
		}
	}
	var status string
	var people int
	if err := f.q.Pool().QueryRow(ctx, `SELECT t.status,count(DISTINCT m.end_user_id) FROM friction_tickets t JOIN friction_ticket_matches m ON m.ticket_id=t.id WHERE t.id=$1 GROUP BY t.id`, f.ticket).Scan(&status, &people); err != nil {
		t.Fatal(err)
	}
	if status != "unpublished" || people != 1 {
		t.Fatalf("status=%s people=%d", status, people)
	}
	var version int
	if err := f.q.SetSessionIdentity(ctx, f.ticket+"-0", f.project, &users[0]); err != nil {
		t.Fatal(err)
	}
	if err := f.q.Pool().QueryRow(ctx, `SELECT evidence_version FROM friction_tickets WHERE id=$1`, f.ticket).Scan(&version); err != nil || version != 3 {
		t.Fatalf("no-op identity changed version: %d %v", version, err)
	}
	var otherProject, otherUser string
	if err := f.q.Pool().QueryRow(ctx, `INSERT INTO projects(org_id,name) SELECT org_id,'other identity scope' FROM projects WHERE id=$1 RETURNING id`, f.project).Scan(&otherProject); err != nil {
		t.Fatal(err)
	}
	if err := f.q.Pool().QueryRow(ctx, `INSERT INTO end_users(project_id,external_user_id,first_seen,last_seen) VALUES($1,'foreign person',now(),now()) RETURNING id`, otherProject).Scan(&otherUser); err != nil {
		t.Fatal(err)
	}
	if err := f.q.SetSessionIdentity(ctx, f.ticket+"-0", f.project, &otherUser); err == nil {
		t.Fatal("accepted another project's identity")
	}
	if err := f.q.SetSessionIdentity(ctx, f.ticket+"-0", otherProject, &otherUser); err == nil {
		t.Fatal("accepted another project's session")
	}
}
