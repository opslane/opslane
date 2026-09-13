package digest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/auth"
	ingestiondb "github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/notify"
	"net/url"
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
	ticket := insert(`INSERT INTO friction_tickets(project_id,environment_id,name,control,what_happened,kind,status,live_generation,evidence_version,steps)VALUES($1,$2,'Six-month view stalls','View','Clicks ignored','defect','published',1,4,'Open the six-month view and click Apply.')RETURNING id`, p.ID, env)
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
		id := insert(`INSERT INTO friction_signals(session_id,project_id,environment_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,observation_id,narrative_id)VALUES($1,$2,$3,3,'other',$1,'/view',$4,'o','n')RETURNING id`, session, p.ID, env, occurred)
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
	unchecked := insert(`INSERT INTO friction_signals(session_id,project_id,environment_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,observation_id,narrative_id)VALUES($1,$2,$3,3,'other','unchecked','/view',now(),'o2','n')RETURNING id`, ticket+"-0", p.ID, env)
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
	// The same ticket as an insight: a later day's freeze has no candidate for
	// it while it is still published, investigated and unfixed.
	run(`UPDATE friction_tickets SET kind='ux_insight' WHERE id=$1`, ticket)
	_, insightCandidates, err := FreezeCandidates(ctx, pool, p.ID, at.Add(48*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	for _, ic := range insightCandidates {
		if ic.TicketID == ticket {
			t.Fatalf("insight ticket froze as a candidate: %+v", ic)
		}
	}
	run(`UPDATE friction_tickets SET kind='defect' WHERE id=$1`, ticket)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	current, err := candidateStillUnified(ctx, tx, p.ID, c, at)
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
		current, err := candidateStillUnified(ctx, tx, p.ID, c, at)
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
	run(`INSERT INTO pr_outcomes(project_id,error_group_id,pr_number,outcome,github_delivery_id,github_repo,occurred_at)VALUES($1,$2,43,'merged',$2::uuid::text||'-second','acme/shop',now())`, p.ID, errorGroup)
	_, cards, err := FreezeCandidates(ctx, pool, p.ID, at.Add(24*time.Hour))
	if err != nil || len(cards) != 0 {
		t.Fatalf("resolved cards=%+v error=%v", cards, err)
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	merged, err := mergedThisWeek(ctx, tx, p.ID, time.Now())
	if err != nil || len(merged) != 3 {
		t.Fatalf("merged=%+v error=%v", merged, err)
	}
	if merged[0].PRURL != "https://github.com/acme/shop/pull/42" || merged[1].PRURL != "https://github.com/acme/shop/pull/43" {
		t.Fatalf("error merge linked mutable PR: %+v", merged)
	}
	old, err := mergedThisWeek(ctx, tx, p.ID, time.Now().Add(8*24*time.Hour))
	tx.Rollback(ctx)
	if err != nil || len(old) != 0 {
		t.Fatalf("old footer=%+v error=%v", old, err)
	}
}

func TestTicketDigestSignsLatestAttemptAfterAuthoringCycle(t *testing.T) {
	testTicketDigestActionAfterAuthoringCycle(t, "authored")
}
func TestTicketDigestDeferredChangedCauseUsesLiveReceipt(t *testing.T) {
	testTicketDigestActionAfterAuthoringCycle(t, "deferred_changed_cause")
}
func TestTicketDigestStaleActionDoesNotFailOtherCards(t *testing.T) {
	testTicketDigestActionAfterAuthoringCycle(t, "stale_action")
}
func TestTicketDigestFencesEveryActionBeforePublication(t *testing.T) {
	for _, mode := range []string{"fixing_resolved", "pr_resolved", "pr_unpublished", "pr_unchanged", "pr_replaced"} {
		t.Run(mode, func(t *testing.T) { testTicketDigestActionAfterAuthoringCycle(t, mode) })
	}
}

// A JWT_SECRET that cannot sign a fix link costs the card its link, never the
// whole digest run.
func TestTicketDigestUnsignableActionDoesNotAbortRun(t *testing.T) {
	for _, mode := range []string{"short_secret", "empty_secret", "deferred_short_secret"} {
		t.Run(mode, func(t *testing.T) { testTicketDigestActionAfterAuthoringCycle(t, mode) })
	}
}

// Steps are the confirmed notes, substituted when the writer leaves them out;
// cards do not render them, so the authored-steps length cap does not apply.
func TestTicketDigestSubstitutedStepsPublish(t *testing.T) {
	testTicketDigestActionAfterAuthoringCycle(t, "long_steps")
}

// Evidence that aged out of the seven-day window after the freeze must not
// defer a card that was valid on the frozen day.
func TestTicketDigestValidatesAtFrozenEvaluationTime(t *testing.T) {
	testTicketDigestActionAfterAuthoringCycle(t, "fixing_frozen_window")
}

func testTicketDigestActionAfterAuthoringCycle(t *testing.T, mode string) {
	pool := knownProblemPool(t)
	ctx := context.Background()
	q := ingestiondb.New(pool)
	org, err := q.CreateOrg(ctx, "digest-attempt-cycle")
	if err != nil {
		t.Fatal(err)
	}
	repo := "acme/shop"
	project, err := q.CreateProject(ctx, org.ID, "Shop", &repo)
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
	env := insert(`SELECT id FROM environments WHERE project_id=$1 AND name='production'`, project.ID)
	ticket := insert(`INSERT INTO friction_tickets(project_id,environment_id,name,control,what_happened,kind,status,live_generation,evidence_version,steps)VALUES($1,$2,'Save stalls','Save','Save stalls','defect','published',1,1,'Click Save.')RETURNING id`, project.ID, env)
	group := insert(`INSERT INTO error_groups(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,ticket_id,publication_generation,fix_substate,investigation_status,root_cause,actionable_since)VALUES($1,$2,$3,'Save stalls','friction','needs_human',now(),now(),$4,1,'none','done','The handler returns early.',now())RETURNING id`, project.ID, env, "ticket|"+ticket, ticket)
	sourceJob := insert(`INSERT INTO error_group_jobs(project_id,error_group_id,job_type,status,ticket_id,publication_generation,source_id)VALUES($1,$2,'investigate','completed',$3,1,$2)RETURNING id`, project.ID, group, ticket)
	run(`INSERT INTO diagnosis_decisions(error_group_id,project_id,job_id,outcome,decision_reason,diagnosis,model,prompt_version)VALUES($1,$2,$3,'code_fix','Fix the handler','{"agentTaskBrief":"Fix the verified Save handler."}','test','7')`, group, project.ID, sourceJob)
	batch := insert(`INSERT INTO friction_confirm_batches(ticket_id,job_id,manifest,arrival_boundary_at_select,live_generation_at_select,status_at_select,status)VALUES($1,$2,'[]',3,1,'published','finalized')RETURNING id`, ticket, sourceJob)
	for i := 0; i < 3; i++ {
		session := fmt.Sprintf("%s-%d", ticket, i)
		run(`INSERT INTO sessions(id,project_id,environment_id,started_at)VALUES($1,$2,$3,now()-interval '1 hour')`, session, project.ID, env)
		signal := insert(`INSERT INTO friction_signals(session_id,project_id,environment_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,observation_id,narrative_id)VALUES($1,$2,$3,3,'other',$1,'/save',now()-interval '1 hour','o','n')RETURNING id`, session, project.ID, env)
		run(`INSERT INTO friction_ticket_matches(ticket_id,session_id,project_id,environment_id,arrival_number,source,occurred_at)VALUES($1,$2,$3,$4,$5,'strong',now()-interval '1 hour')`, ticket, session, project.ID, env, i+1)
		run(`INSERT INTO friction_ticket_match_observations(ticket_id,session_id,signal_id)VALUES($1,$2,$3)`, ticket, session, signal)
		check := insert(`INSERT INTO friction_check_attempts(batch_id,ticket_id,session_id,outcome,signal_ids,note,model)VALUES($1,$2,$3,'confirmed',jsonb_build_array($4::text),'Save ignores clicks.','test')RETURNING id`, batch, ticket, session, signal)
		run(`INSERT INTO friction_checks(ticket_id,session_id,attempt_id,outcome)VALUES($1,$2,$3,'confirmed')`, ticket, session, check)
	}
	run(`UPDATE error_groups SET explained_signal_ids=(SELECT jsonb_agg(signal_id::text) FROM friction_ticket_match_observations WHERE ticket_id=$2) WHERE id=$1`, group, ticket)
	if mode == "long_steps" {
		run(`UPDATE friction_tickets SET steps=repeat('Click Save and wait. ',40) WHERE id=$1`, ticket)
	}
	if mode == "fixing_frozen_window" {
		// Inside the window when the run froze an hour ago; outside it now.
		run(`UPDATE friction_ticket_matches SET occurred_at=now()-interval '7 days 30 minutes' WHERE ticket_id=$1`, ticket)
	}
	unsignable := mode == "short_secret" || mode == "empty_secret" || mode == "deferred_short_secret"
	deferred := mode == "deferred_changed_cause" || mode == "deferred_short_secret"
	wantAction := "Create fix PR"
	if strings.HasPrefix(mode, "fixing_") {
		run(`UPDATE error_groups SET status='fixing',fix_substate='fixing' WHERE id=$1`, group)
		wantAction = "Fix in progress"
	} else if strings.HasPrefix(mode, "pr_") {
		run(`UPDATE error_groups SET status='pr_created',fix_substate='pr_open',pr_url='https://github.com/acme/shop/pull/7',pr_number=7 WHERE id=$1`, group)
		wantAction = "Review PR"
	}
	seedDestination(t, pool, project.ID, []string{"digest.daily"})
	unrelated := insert(`INSERT INTO error_groups(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen)VALUES($1,$2,'unrelated','Other checkout issue','error','needs_human',now(),now())RETURNING id`, project.ID, env)
	freezeAt := time.Now()
	if mode == "fixing_frozen_window" {
		freezeAt = freezeAt.Add(-time.Hour)
	}
	runID, candidates, err := FreezeCandidates(ctx, pool, project.ID, freezeAt)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 2 {
		t.Fatalf("frozen candidates=%+v", candidates)
	}
	frozen := candidateByGroup(t, candidates, group)
	if frozen.LatestAttemptID != "" || frozen.ValidAction != wantAction {
		t.Fatalf("ticket=%+v", frozen)
	}
	latest := ""
	if wantAction == "Create fix PR" {
		// A real fix is admitted and fails while the writer holds frozen facts.
		job, err := q.TriggerFixJob(ctx, project.ID, group, "")
		if err != nil {
			t.Fatal(err)
		}
		latest = insert(`SELECT fix_attempt_id FROM error_group_jobs WHERE id=$1`, job)
		run(`UPDATE friction_fix_attempts SET status='failed' WHERE id=$1`, latest)
		run(`UPDATE error_group_jobs SET status='completed' WHERE id=$1`, job)
		run(`UPDATE error_groups SET status='needs_human',fix_substate='none',terminal_fix_job_id=$2 WHERE id=$1`, group, job)
	}
	written := writtenDigestPayload{Included: []writtenDigestCard{{ErrorGroupID: group, Title: "Save stalls", Copy: "Save ignores clicks.", Steps: frozen.Steps, Why: frozen.RootCause}}}
	if mode == "long_steps" {
		written.Included[0].Steps = ""
	}
	changedCause := "The handler drops the save request."
	if deferred {
		run(`UPDATE error_groups SET root_cause=$2 WHERE id=$1`, group, changedCause)
		written = writtenDigestPayload{Deferred: []deferredDigestItem{{ErrorGroupID: group, Reason: "card check: invalid prose"}}}
	}
	stale := mode == "stale_action" || mode == "fixing_resolved" || mode == "pr_resolved" || mode == "pr_unpublished"
	if stale || mode == "pr_replaced" {
		original := loadActionableCandidatesForValidation
		loadActionableCandidatesForValidation = func(ctx context.Context, tx pgx.Tx, projectID string, status actionableStatusSet, evaluatedAt time.Time) ([]actionableCandidate, error) {
			if projectID == project.ID {
				var err error
				switch mode {
				case "fixing_resolved", "pr_resolved":
					_, err = tx.Exec(ctx, `UPDATE error_groups SET status='resolved',fix_substate='resolved' WHERE id=$1`, group)
				case "pr_unpublished":
					_, err = tx.Exec(ctx, `UPDATE friction_tickets SET status='unpublished' WHERE id=$1`, ticket)
				case "pr_replaced":
					_, err = tx.Exec(ctx, `UPDATE error_groups SET pr_url='https://github.com/acme/shop/pull/8',pr_number=8 WHERE id=$1`, group)
				default:
					_, err = tx.Exec(ctx, `UPDATE error_groups SET root_cause=$2 WHERE id=$1`, group, changedCause)
				}
				if err != nil {
					return nil, err
				}
			}
			return original(ctx, tx, projectID, status, evaluatedAt)
		}
		t.Cleanup(func() { loadActionableCandidatesForValidation = original })
	}
	payload, err := json.Marshal(written)
	if err != nil {
		t.Fatal(err)
	}
	run(`UPDATE digest_runs SET status='written',writer_payload=$2 WHERE id=$1`, runID, payload)
	secret := []byte("digest-cycle-intent-secret-at-least-32-bytes")
	if mode == "pr_unchanged" || mode == "pr_replaced" {
		// Reviewing a PR requires no fix intent and must retain its existing URL.
		secret = nil
	}
	switch mode {
	case "short_secret", "deferred_short_secret":
		secret = []byte("too-short")
	case "empty_secret":
		secret = nil
		t.Setenv("JWT_SECRET", "")
	}
	t.Setenv("DASHBOARD_URL", "https://app.example")
	if err := ValidateAndPublish(ctx, pool, runID, secret); err != nil {
		t.Fatal(err)
	}
	published := renderedEvent(t, pool, runID)
	hasUnrelated := false
	for _, receipt := range published.Digest.ReceiptItems {
		if receipt.IncidentID == unrelated {
			hasUnrelated = true
		}
	}
	if !hasUnrelated {
		t.Fatalf("unrelated receipt was lost: %+v", published.Digest)
	}
	if stale {
		if len(published.Digest.GeneratedCards) != 0 || len(published.Digest.ReceiptItems) != 1 {
			t.Fatalf("stale action was published: %+v", published.Digest)
		}
		var outcome string
		if err := pool.QueryRow(ctx, `SELECT outcome FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`, runID, group).Scan(&outcome); err != nil || outcome != "excluded" {
			t.Fatalf("stale action ledger=%q err=%v", outcome, err)
		}
		return
	}
	if unsignable {
		found := 0
		for _, card := range published.Digest.GeneratedCards {
			if card.IncidentID == group {
				found++
				if card.Action != "Create fix PR" || card.ActionURL != "" {
					t.Fatalf("unsignable card=%+v", card)
				}
			}
		}
		for _, receipt := range published.Digest.ReceiptItems {
			if receipt.IncidentID == group {
				found++
				if receipt.Action != "Create fix PR" || receipt.ActionURL != "" {
					t.Fatalf("unsignable receipt=%+v", receipt)
				}
			}
		}
		if found != 1 {
			t.Fatalf("unsignable ticket was dropped: %+v", published.Digest)
		}
		return
	}
	if mode == "fixing_frozen_window" {
		if len(published.Digest.GeneratedCards) != 1 || published.Digest.GeneratedCards[0].IncidentID != group || published.Digest.GeneratedCards[0].Action != "Fix in progress" {
			t.Fatalf("aged-out evidence changed the frozen day's card: %+v", published.Digest)
		}
		return
	}
	if mode == "pr_unchanged" || mode == "pr_replaced" {
		wantPRURL := "https://github.com/acme/shop/pull/7"
		if mode == "pr_replaced" {
			wantPRURL = "https://github.com/acme/shop/pull/8"
		}
		if len(published.Digest.GeneratedCards) != 1 || published.Digest.GeneratedCards[0].Action != "Review PR" || published.Digest.GeneratedCards[0].PRURL != wantPRURL || published.Digest.GeneratedCards[0].PRNumber != prNumber(wantPRURL) {
			t.Fatalf("current PR card was changed: %+v", published.Digest)
		}
		return
	}
	var actionURL string
	if deferred {
		if len(published.Digest.GeneratedCards) != 0 || len(published.Digest.ReceiptItems) != 2 {
			t.Fatalf("live receipt was lost: %+v", published.Digest)
		}
		for _, receipt := range published.Digest.ReceiptItems {
			if receipt.IncidentID == group {
				if receipt.RootCauseExcerpt != changedCause || receipt.Action != "Create fix PR" {
					t.Fatalf("stale receipt=%+v", receipt)
				}
				actionURL = receipt.ActionURL
			}
		}
	} else {
		if len(published.Digest.GeneratedCards) != 1 {
			t.Fatalf("authored card was lost: %+v", published.Digest)
		}
		actionURL = published.Digest.GeneratedCards[0].ActionURL
	}
	link, err := url.Parse(actionURL)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := auth.VerifyTicketFixIntent(secret, link.Query().Get("fixIntent"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if claims.LatestAttemptID != latest {
		t.Fatalf("link latest attempt=%q want %q; frozen=%q", claims.LatestAttemptID, latest, frozen.LatestAttemptID)
	}
	body, _, err := notify.FormatSlack(published)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), link.Query().Get("fixIntent")) {
		t.Fatalf("Slack altered signed intent: %s", body)
	}
	expectation := ingestiondb.TicketFixExpectation{TicketID: claims.TicketID, Generation: claims.Generation, LatestAttemptID: claims.LatestAttemptID, ExpiresAt: claims.ExpiresAt}
	if _, err := q.TriggerFixJob(ctx, project.ID, group, "", expectation); err != nil {
		t.Fatalf("fresh digest intent was inadmissible: %v", err)
	}
	if _, err := q.TriggerFixJob(ctx, project.ID, group, "", expectation); !errors.Is(err, ingestiondb.ErrNotInvestigated) {
		t.Fatalf("reused digest intent=%v", err)
	}
}
