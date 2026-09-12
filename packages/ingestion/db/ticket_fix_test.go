package db_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

type ticketFixFixture struct {
	q                      *db.Queries
	project, ticket, group string
	signals                []string
}

func seedTicketFix(t *testing.T) ticketFixFixture {
	return seedTicketFixWithCount(t, 4)
}

func seedTicketFixWithCount(t *testing.T, recordings int) ticketFixFixture {
	t.Helper()
	pool, dsn := disposableDB(t, testPool(t))
	applyKnownProblemMigrations(t, dsn)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "ticket-fix")
	if err != nil {
		t.Fatal(err)
	}
	createdProject, err := q.CreateProject(ctx, org.ID, "ticket-fix", ptrStr("org/repo"))
	if err != nil {
		t.Fatal(err)
	}
	project := createdProject.ID
	insert := func(sql string, args ...any) string {
		t.Helper()
		var id string
		if err := q.Pool().QueryRow(ctx, sql, args...).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := q.Pool().Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	environment := insert(`INSERT INTO environments(project_id,name) VALUES($1,'ticket-production') RETURNING id`, project)
	ticket := insert(`INSERT INTO friction_tickets(project_id,environment_id,name,control,what_happened,kind,status,live_generation,evidence_version)
		VALUES($1,$2,'Payment stalls','Pay','Payment stalls','ux_insight','published',1,1) RETURNING id`, project, environment)
	group := insert(`INSERT INTO error_groups(project_id,fingerprint,title,first_seen,last_seen,kind,status,ticket_id,publication_generation,fix_substate,investigation_status,root_cause,evidence_version_used)
		VALUES($1,$2,'Payment stalls',now(),now(),'friction','awaiting_approval',$3,1,'none','done','The payment handler stalls',1) RETURNING id`, project, "ticket|"+ticket+"|1", ticket)
	job := insert(`INSERT INTO error_group_jobs(project_id,error_group_id,job_type,status,ticket_id,publication_generation,source_id)
		VALUES($1,$2,'investigate','completed',$3,1,$2) RETURNING id`, project, group, ticket)
	batch := insert(`INSERT INTO friction_confirm_batches(ticket_id,job_id,manifest,arrival_boundary_at_select,live_generation_at_select,status_at_select,status)
		VALUES($1,$2,'[]',4,1,'tracking','finalized') RETURNING id`, ticket, job)
	f := ticketFixFixture{q: q, project: project, ticket: ticket, group: group}
	for i := 0; i < recordings; i++ {
		session := fmt.Sprintf("%s-%d", ticket, i)
		exec(`INSERT INTO sessions(id,project_id,environment_id,started_at) VALUES($1,$2,$3,now()-interval '1 hour')`, session, project, environment)
		signal := insert(`INSERT INTO friction_signals(session_id,project_id,environment_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,observation_id,narrative_id)
			VALUES($1,$2,$3,3,'narrative',$1,'/pay',now()-interval '1 hour','o','n') RETURNING id`, session, project, environment)
		exec(`INSERT INTO friction_ticket_matches(ticket_id,session_id,project_id,environment_id,arrival_number,source,occurred_at)
			VALUES($1,$2,$3,$4,$5,'strong',now()-interval '1 hour')`, ticket, session, project, environment, i+1)
		exec(`INSERT INTO friction_ticket_match_observations(ticket_id,session_id,signal_id) VALUES($1,$2,$3)`, ticket, session, signal)
		attempt := insert(`INSERT INTO friction_check_attempts(batch_id,ticket_id,session_id,outcome,signal_ids,note,model)
			VALUES($1,$2,$3,'confirmed',jsonb_build_array($4::text),'The payment stalled','test') RETURNING id`, batch, ticket, session, signal)
		exec(`INSERT INTO friction_checks(ticket_id,session_id,attempt_id,outcome) VALUES($1,$2,$3,'confirmed')`, ticket, session, attempt)
		f.signals = append(f.signals, signal)
	}
	exec(`UPDATE error_groups SET explained_signal_ids=jsonb_build_array($2::text,$3::text) WHERE id=$1`, group, f.signals[0], f.signals[1])
	exec(`INSERT INTO diagnosis_decisions(error_group_id,project_id,job_id,outcome,decision_reason,diagnosis,model,prompt_version)
		VALUES($1,$2,$3,'code_fix','Fix the payment handler','{"agentTaskBrief":"Fix the verified payment handler."}','test','ticket-test')`, group, project, job)
	return f
}

func TestTicketFixUsesCurrentCoverageAndRejectsConcurrentRequests(t *testing.T) {
	f := seedTicketFix(t)
	state, err := f.q.GetTicketIncidentState(context.Background(), f.project, f.group)
	if err != nil || state == nil || state.CauseCoverage != 0.5 {
		t.Fatalf("state=%+v error=%v", state, err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.q.TriggerFixJob(context.Background(), f.project, f.group, "Fix it")
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	accepted := 0
	for err := range results {
		if err == nil {
			accepted++
		} else if !errors.Is(err, db.ErrNotInvestigated) {
			t.Fatal(err)
		}
	}
	if accepted != 1 {
		t.Fatalf("accepted %d requests, want one", accepted)
	}
	var count int
	if err := f.q.Pool().QueryRow(context.Background(), `SELECT count(*) FROM error_group_jobs j JOIN friction_fix_attempts a ON a.id=j.fix_attempt_id
		WHERE j.error_group_id=$1 AND j.ticket_id=$2 AND j.publication_generation=1 AND a.status='active' AND a.requested_by='human'
		AND j.payload->'diagnosis'->>'agentTaskBrief'='Fix the verified payment handler.'`, f.group, f.ticket).Scan(&count); err != nil || count != 1 {
		t.Fatalf("stamped attempts=%d error=%v", count, err)
	}
	// A failed attempt can become visible before its claimed job finishes.
	if _, err := f.q.Pool().Exec(context.Background(), `UPDATE friction_fix_attempts SET status='failed' WHERE ticket_id=$1`, f.ticket); err != nil {
		t.Fatal(err)
	}
	if _, err := f.q.TriggerFixJob(context.Background(), f.project, f.group, ""); !errors.Is(err, db.ErrNotInvestigated) {
		t.Fatalf("unfinished fix job admitted another attempt: %v", err)
	}
}

func TestTicketNotReadyFixQueuesNothing(t *testing.T) {
	f := seedTicketFix(t)
	ctx := context.Background()
	if _, err := f.q.Pool().Exec(ctx, `UPDATE error_groups SET investigation_status='failed' WHERE id=$1`, f.group); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := f.q.TriggerFixJob(ctx, f.project, f.group, ""); !errors.Is(err, db.ErrNotInvestigated) {
			t.Fatalf("request error=%v", err)
		}
	}
	// A refused fix is a refusal only: reinvestigation follows new verified
	// evidence, never a click.
	var count int
	if err := f.q.Pool().QueryRow(ctx, `SELECT count(*) FROM error_group_jobs WHERE error_group_id=$1 AND job_type='investigate' AND status='pending' AND ticket_id=$2 AND publication_generation=1`, f.group, f.ticket).Scan(&count); err != nil || count != 0 {
		t.Fatalf("investigations=%d error=%v", count, err)
	}
	var substate string
	if err := f.q.Pool().QueryRow(ctx, `SELECT fix_substate FROM error_groups WHERE id=$1`, f.group).Scan(&substate); err != nil || substate != "none" {
		t.Fatalf("substate=%s error=%v", substate, err)
	}
}

func TestTicketFixExcludesOldEvidenceAndStaleGeneration(t *testing.T) {
	f := seedTicketFix(t)
	ctx := context.Background()
	if _, err := f.q.Pool().Exec(ctx, `UPDATE friction_ticket_matches SET occurred_at=now()-interval '8 days' WHERE ticket_id=$1`, f.ticket); err != nil {
		t.Fatal(err)
	}
	if _, err := f.q.TriggerFixJob(ctx, f.project, f.group, ""); !errors.Is(err, db.ErrNotInvestigated) {
		t.Fatalf("old evidence accepted: %v", err)
	}
}

func TestTicketPRWebhookRecordsOldAttemptAndQueuesOnlyOnce(t *testing.T) {
	f := seedTicketFix(t)
	ctx := context.Background()
	var attempt string
	if err := f.q.Pool().QueryRow(ctx, `INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status,pr_url,pr_number,github_repo)
		VALUES($1,$2,1,'superseded','https://github.com/org/repo/pull/71',71,'org/repo') RETURNING id`, f.ticket, f.group).Scan(&attempt); err != nil {
		t.Fatal(err)
	}
	if _, err := f.q.Pool().Exec(ctx, `UPDATE error_groups SET status='archived' WHERE id=$1`, f.group); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		result, err := f.q.ProcessPRWebhook(ctx, "org/repo", 71, true, "ticket-merge-"+attempt, time.Now())
		if err != nil || result.GroupID != f.group || result.Duplicate != (i == 1) {
			t.Fatalf("result=%+v error=%v", result, err)
		}
	}
	var count int
	if err := f.q.Pool().QueryRow(ctx, `SELECT count(*) FROM friction_pr_events e JOIN error_group_jobs j ON j.payload->>'eventId'=e.id::text
		WHERE e.fix_attempt_id=$1 AND e.event='merged' AND NOT e.applied AND j.job_type='friction_pr_event' AND j.fix_attempt_id=e.fix_attempt_id AND j.publication_generation=e.generation`, attempt).Scan(&count); err != nil || count != 1 {
		t.Fatalf("events=%d error=%v", count, err)
	}
}

func TestTicketPRWebhookUsesWorkerLockOrder(t *testing.T) {
	f := seedTicketFix(t)
	ctx := context.Background()
	var attempt string
	if err := f.q.Pool().QueryRow(ctx, `INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status,pr_number,github_repo)
		VALUES($1,$2,1,'active',72,'org/repo') RETURNING id`, f.ticket, f.group).Scan(&attempt); err != nil {
		t.Fatal(err)
	}
	worker, err := f.q.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Rollback(ctx)
	if _, err := worker.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, f.project); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.Exec(ctx, `SELECT id FROM friction_tickets WHERE id=$1 FOR UPDATE`, f.ticket); err != nil {
		t.Fatal(err)
	}
	webhookCtx, cancelWebhook := context.WithTimeout(ctx, 10*time.Second)
	defer cancelWebhook()
	received := make(chan error, 1)
	go func() {
		_, err := f.q.ProcessPRWebhook(webhookCtx, "org/repo", 72, false, "lock-order-"+attempt, time.Now())
		received <- err
	}()
	// Wait until intake is blocked on the worker, then acquire the worker's
	// next lock. Intake must not hold that attempt while waiting for its ticket.
	deadline := time.Now().Add(5 * time.Second)
	blocked := false
	for time.Now().Before(deadline) {
		if err := f.q.Pool().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
			WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid())`).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("webhook did not reach the worker lock")
	}
	lockCtx, cancelLock := context.WithTimeout(ctx, 2*time.Second)
	defer cancelLock()
	_, lockErr := worker.Exec(lockCtx, `SELECT id FROM friction_fix_attempts WHERE id=$1 FOR UPDATE`, attempt)
	_ = worker.Rollback(ctx)
	receiptErr := <-received
	if lockErr != nil || receiptErr != nil {
		t.Fatalf("worker lock=%v webhook=%v", lockErr, receiptErr)
	}
}

func TestTicketFixIntentFencesLineageAndReplay(t *testing.T) {
	f := seedTicketFix(t)
	ctx := context.Background()
	expected := db.TicketFixExpectation{TicketID: f.ticket, Generation: 1, ExpiresAt: time.Now().Add(time.Hour).Unix()}
	for _, bad := range []db.TicketFixExpectation{
		{TicketID: f.ticket, Generation: 2, ExpiresAt: expected.ExpiresAt},
		{TicketID: f.ticket, Generation: 1, LatestAttemptID: "older", ExpiresAt: expected.ExpiresAt},
		{TicketID: f.ticket, Generation: 1, ExpiresAt: time.Now().Add(-time.Second).Unix()},
		{TicketID: "other", Generation: 1, ExpiresAt: expected.ExpiresAt},
	} {
		if _, err := f.q.TriggerFixJob(ctx, f.project, f.group, "", bad); !errors.Is(err, db.ErrNotInvestigated) {
			t.Fatalf("accepted stale intent %+v: %v", bad, err)
		}
	}
	job, err := f.q.TriggerFixJob(ctx, f.project, f.group, "", expected)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.q.Pool().Exec(ctx, `UPDATE friction_fix_attempts SET status='failed' WHERE ticket_id=$1`, f.ticket); err != nil {
		t.Fatal(err)
	}
	if _, err = f.q.Pool().Exec(ctx, `UPDATE error_group_jobs SET status='failed' WHERE id=$1`, job); err != nil {
		t.Fatal(err)
	}
	if _, err = f.q.Pool().Exec(ctx, `UPDATE error_groups SET status='awaiting_approval',fix_substate='none' WHERE id=$1`, f.group); err != nil {
		t.Fatal(err)
	}
	if _, err = f.q.TriggerFixJob(ctx, f.project, f.group, "", expected); !errors.Is(err, db.ErrNotInvestigated) {
		t.Fatalf("replayed consumed intent: %v", err)
	}
	// A fresh page can authorize the new attempt, while the delivered link cannot.
	if err = f.q.Pool().QueryRow(ctx, `SELECT id FROM friction_fix_attempts WHERE ticket_id=$1`, f.ticket).Scan(&expected.LatestAttemptID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.q.TriggerFixJob(ctx, f.project, f.group, "", expected); err != nil {
		t.Fatalf("fresh intent rejected: %v", err)
	}
}
