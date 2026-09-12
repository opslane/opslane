package digest

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	ingestiondb "github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/notify"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func knownProblemPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	admin := testPool(t)
	ctx := context.Background()
	name := fmt.Sprintf("digest_ticket_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(), "DROP DATABASE "+name+" WITH (FORCE)"); err != nil {
			t.Error(err)
		}
	})
	cfg := admin.Config().Copy()
	cfg.ConnConfig.Database = name
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	files, err := filepath.Glob("../db/migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		out, err := exec.Command("psql", fmt.Sprintf("postgresql://%s:%s@%s:%d/%s?sslmode=disable", cfg.ConnConfig.User, cfg.ConnConfig.Password, cfg.ConnConfig.Host, cfg.ConnConfig.Port, name), "-v", "ON_ERROR_STOP=1", "-q", "-f", file).CombinedOutput()
		if err != nil {
			t.Fatalf("migration %s: %v %s", file, err, out)
		}
	}
	return pool
}

func TestKnownProblemDigestFreezeValidateAndMergedFooter(t *testing.T) {
	pool := knownProblemPool(t)
	ctx := context.Background()
	q := ingestiondb.New(pool)
	org, err := q.CreateOrg(ctx, "known problems")
	if err != nil {
		t.Fatal(err)
	}
	repo := "acme/shop"
	p, err := q.CreateProject(ctx, org.ID, "Shop", &repo)
	if err != nil {
		t.Fatal(err)
	}
	insert := func(sql string, args ...any) string {
		t.Helper()
		var id string
		if err := pool.QueryRow(ctx, sql, args...).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	run := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	env := insert(`SELECT id FROM environments WHERE project_id=$1 AND name='production'`, p.ID)
	ticket := insert(`INSERT INTO friction_tickets(project_id,environment_id,name,control,what_happened,kind,status,live_generation,evidence_version,steps)VALUES($1,$2,'Six-month view stalls','View','Clicks ignored','ux_insight','published',1,4,'Open the six-month view and click Apply.')RETURNING id`, p.ID, env)
	group := insert(`INSERT INTO error_groups(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,ticket_id,publication_generation,fix_substate,investigation_status,root_cause,occurrence_count,affected_users_count,actionable_since)VALUES($1,$2,$3,'Six-month view stalls','friction','fixing',now(),now(),$4,1,'fixing','done','The handler returns early.',999,999,now())RETURNING id`, p.ID, env, "ticket|"+ticket, ticket)
	job := insert(`INSERT INTO error_group_jobs(error_group_id,project_id,job_type,status,ticket_id,publication_generation,source_id)VALUES($1,$2,'friction_confirm','completed',$3,1,$1)RETURNING id`, group, p.ID, ticket)
	finalized := insert(`INSERT INTO friction_confirm_batches(ticket_id,job_id,manifest,arrival_boundary_at_select,live_generation_at_select,status_at_select,status)VALUES($1,$2,'[]',7,1,'published','finalized')RETURNING id`, ticket, job)
	stagedJob := insert(`INSERT INTO error_group_jobs(error_group_id,project_id,job_type,status,ticket_id,publication_generation,source_id)VALUES($1,$2,'friction_confirm','completed',$3,1,$1)RETURNING id`, group, p.ID, ticket)
	staged := insert(`INSERT INTO friction_confirm_batches(ticket_id,job_id,manifest,arrival_boundary_at_select,live_generation_at_select,status_at_select,status)VALUES($1,$2,'[]',7,1,'published','staging')RETURNING id`, ticket, stagedJob)
	ids := []string{}
	for i := 0; i < 7; i++ {
		session := fmt.Sprintf("%s-%d", ticket, i)
		user := insert(`INSERT INTO end_users(project_id,external_user_id,account_name)VALUES($1,$2,$3)RETURNING id`, p.ID, session, []string{"Acme", "Beta", "Acme", " ", "Staged", "Old", "Future"}[i])
		occurred := time.Now().Add(-time.Hour)
		if i == 5 {
			occurred = time.Now().Add(-8 * 24 * time.Hour)
		}
		if i == 6 {
			occurred = time.Now().Add(time.Hour)
		}
		run(`INSERT INTO sessions(id,project_id,environment_id,started_at)VALUES($1,$2,$3,$4)`, session, p.ID, env, occurred)
		id := insert(`INSERT INTO friction_signals(session_id,project_id,environment_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,observation_id,narrative_id)VALUES($1,$2,$3,3,'narrative',$1,'/view',$4,'o','n')RETURNING id`, session, p.ID, env, occurred)
		run(`INSERT INTO friction_ticket_matches(ticket_id,session_id,project_id,environment_id,arrival_number,source,occurred_at,end_user_id)VALUES($1,$2,$3,$4,$5,'strong',$6,$7)`, ticket, session, p.ID, env, i+1, occurred, user)
		run(`INSERT INTO friction_ticket_match_observations(ticket_id,session_id,signal_id)VALUES($1,$2,$3)`, ticket, session, id)
		batch := finalized
		if i == 4 {
			batch = staged
		}
		attempt := insert(`INSERT INTO friction_check_attempts(batch_id,ticket_id,session_id,outcome,signal_ids,note,cost_to_user,model)VALUES($1,$2,$3,'confirmed',jsonb_build_array($4::text),'Clicked 3 times in the six-month view',$5,'test')RETURNING id`, batch, ticket, session, id, []string{"abandoned_task", "none", "annoyance", "lost_time", "abandoned_task", "abandoned_task", "abandoned_task"}[i])
		run(`INSERT INTO friction_checks(ticket_id,session_id,attempt_id,outcome)VALUES($1,$2,$3,'confirmed')`, ticket, session, attempt)
		ids = append(ids, id)
	}
	// A later match observation was never included in the finalized check.
	unchecked := insert(`INSERT INTO friction_signals(session_id,project_id,environment_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,observation_id,narrative_id)VALUES($1,$2,$3,3,'narrative','unchecked','/view',now(),'o2','n')RETURNING id`, ticket+"-0", p.ID, env)
	run(`INSERT INTO friction_ticket_match_observations(ticket_id,session_id,signal_id)VALUES($1,$2,$3)`, ticket, ticket+"-0", unchecked)
	run(`UPDATE error_groups SET explained_signal_ids=jsonb_build_array($2::text,$3::text,$4::text) WHERE id=$1`, group, ids[0], ids[1], unchecked)
	seedDestination(t, pool, p.ID, []string{"digest.daily"})
	run(`UPDATE friction_tickets SET cohort_cutoff=now() WHERE id=$1`, ticket)
	cutoffFacts, err := ingestiondb.LoadTicketDigestFacts(ctx, pool, p.ID, group, time.Now())
	if err != nil || cutoffFacts.VerifiedSessions != 0 {
		t.Fatalf("cutoff facts=%+v err=%v", cutoffFacts, err)
	}
	run(`UPDATE friction_tickets SET cohort_cutoff=NULL WHERE id=$1`, ticket)
	at := time.Now()
	runID, candidates, err := FreezeCandidates(ctx, pool, p.ID, at)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 {
		t.Fatalf("candidates=%+v", candidates)
	}
	c := candidates[0]
	if c.Coverage != .5 || c.VerifiedSessions != 4 || c.VerifiedUsers != 4 || strings.Join(c.Accounts, ",") != "Acme,Beta" || c.RepresentativeSessionID != ticket+"-2" || c.ValidAction != "Fix in progress" || c.EvidenceVersion != 4 {
		t.Fatalf("candidate=%+v", c)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	current, err := candidateStillUnified(ctx, tx, p.ID, c)
	if err != nil || !current {
		t.Fatalf("current=%v error=%v", current, err)
	}
	tx.Rollback(ctx)
	for _, sql := range []string{`UPDATE friction_tickets SET evidence_version=5 WHERE id=$1`, `UPDATE friction_tickets SET live_generation=2 WHERE id=$1`} {
		run(sql, ticket)
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		current, err := candidateStillUnified(ctx, tx, p.ID, c)
		tx.Rollback(ctx)
		if err != nil || current {
			t.Fatalf("moved candidate accepted=%v err=%v", current, err)
		}
		run(`UPDATE friction_tickets SET evidence_version=4,live_generation=1 WHERE id=$1`, ticket)
	}
	written := writtenDigestPayload{Included: []writtenDigestCard{{ErrorGroupID: group, Title: "Six-month view stalls", Copy: "The six-month view ignores 3 clicks.", Steps: c.Steps, Why: "The handler returns early."}}}
	payload, err := json.Marshal(written)
	if err != nil {
		t.Fatal(err)
	}
	run(`UPDATE digest_runs SET status='written',writer_payload=$2 WHERE id=$1`, runID, payload)
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	var result notify.EventPayload
	var raw []byte
	if err := pool.QueryRow(ctx, `SELECT payload FROM outbound_events WHERE project_id=$1 AND event_type='digest.daily' ORDER BY created_at DESC LIMIT 1`, p.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if result.Digest.SchemaVersion != 5 || len(result.Digest.GeneratedCards) != 1 || result.Digest.GeneratedCards[0].Steps != c.Steps {
		t.Fatalf("digest=%+v", result.Digest)
	}
	// Resolved tickets leave cards and remain in the seven-day merged footer.
	attempt := insert(`INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status,pr_url,pr_number,github_repo)VALUES($1,$2,1,'merged','https://github.com/acme/shop/pull/4',4,'acme/shop')RETURNING id`, ticket, group)
	run(`INSERT INTO friction_pr_events(ticket_id,error_group_id,fix_attempt_id,generation,event,delivery_id,pr_url,pr_number,github_repo,occurred_at)VALUES($1,$2,$3,1,'merged',$3::uuid::text,'https://github.com/acme/shop/pull/4',4,'acme/shop',now())`, ticket, group, attempt)
	run(`UPDATE error_groups SET fix_substate='resolved',explained_signal_ids=jsonb_build_array($2::text,$3::text,$4::text,$5::text) WHERE id=$1`, group, ids[0], ids[1], ids[2], ids[3])
	errorGroup := insert(`INSERT INTO error_groups(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,pr_url,pr_number)VALUES($1,$2,'merged-error','An error fixed','error','merged',now(),now(),'https://github.com/acme/shop/pull/999',999)RETURNING id`, p.ID, env)
	run(`INSERT INTO pr_outcomes(project_id,error_group_id,pr_number,outcome,github_delivery_id,github_repo,occurred_at)VALUES($1,$2,42,'merged',$2::uuid::text,'acme/shop',now())`, p.ID, errorGroup)
	_, cards, err := FreezeCandidates(ctx, pool, p.ID, at.Add(24*time.Hour))
	if err != nil || len(cards) != 0 {
		t.Fatalf("resolved cards=%+v error=%v", cards, err)
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	merged, err := mergedThisWeek(ctx, tx, p.ID, time.Now())
	if err != nil || len(merged) != 2 {
		t.Fatalf("merged=%+v error=%v", merged, err)
	}
	if merged[0].PRURL != "https://github.com/acme/shop/pull/42" {
		t.Fatalf("error merge linked mutable PR: %+v", merged)
	}
	old, err := mergedThisWeek(ctx, tx, p.ID, time.Now().Add(8*24*time.Hour))
	tx.Rollback(ctx)
	if err != nil || len(old) != 0 {
		t.Fatalf("old footer=%+v error=%v", old, err)
	}
}
