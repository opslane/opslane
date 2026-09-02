package digest

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func seedFreezeEpisode(t *testing.T, pool *pgxpool.Pool, projectID, environmentID string, lastSeen time.Time, sequence int) string {
	t.Helper()
	ctx := context.Background()
	var groupID, episodeID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO error_groups
		  (project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
		   occurrence_count,affected_users_count,page_url_normalized,pr_url,remediation)
		VALUES ($1,$2,$3,'Checkout failed','error','investigated',$4,$4,3,0,'/checkout',
		        'https://github.com/acme/shop/pull/42','Decide whether to ship the documented follow-up.')
		RETURNING id::text`, projectID, environmentID, "freeze-"+uuid.NewString(), lastSeen,
	).Scan(&groupID); err != nil {
		t.Fatalf("seed freeze group: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence)
		VALUES ($1,$2,$3) RETURNING id::text`, projectID, groupID, sequence,
	).Scan(&episodeID); err != nil {
		t.Fatalf("seed freeze episode: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO issue_inquiry_decisions
		  (project_id,episode_id,decision,reason,evaluated_units,evidence_signature,
		   model,prompt_version,decided_at)
		VALUES ($1,$2,'investigate','customer checkout is blocked',1,$3,'test',1,$4)`,
		projectID, episodeID, "freeze-"+uuid.NewString(), lastSeen); err != nil {
		t.Fatalf("seed inquiry: %v", err)
	}
	return episodeID
}

func seedFreezeDiagnosis(t *testing.T, pool *pgxpool.Pool, projectID, episodeID, outcome string, decidedAt time.Time) {
	t.Helper()
	var decisionID string
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO diagnosis_decisions
		  (error_group_id,project_id,episode_id,outcome,decision_reason,diagnosis,
		   model,prompt_version,decided_at)
		SELECT canonical_issue_id,$1,id,$3,'verified terminal result',
		       '{"summary":"The checkout request fails before payment."}'::jsonb,
		       'test','1',$4
		  FROM issue_episodes WHERE project_id=$1 AND id=$2
		RETURNING id::text`, projectID, episodeID, outcome, decidedAt).Scan(&decisionID); err != nil {
		t.Fatalf("seed diagnosis: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		if _, err := pool.Exec(ctx, `ALTER TABLE diagnosis_decisions DISABLE TRIGGER diagnosis_decisions_immutable_row`); err != nil {
			t.Errorf("disable diagnosis immutability: %v", err)
			return
		}
		if _, err := pool.Exec(ctx, `DELETE FROM diagnosis_decisions WHERE id=$1`, decisionID); err != nil {
			t.Errorf("delete diagnosis fixture: %v", err)
		}
		if _, err := pool.Exec(ctx, `ALTER TABLE diagnosis_decisions ENABLE TRIGGER diagnosis_decisions_immutable_row`); err != nil {
			t.Errorf("enable diagnosis immutability: %v", err)
		}
	})
}

func seedFreezeReplay(t *testing.T, pool *pgxpool.Pool, projectID, environmentID, episodeID, sessionID string, anchor time.Time) {
	t.Helper()
	ctx := context.Background()
	var groupID string
	if err := pool.QueryRow(ctx, `SELECT canonical_issue_id::text FROM issue_episodes
		WHERE project_id=$1 AND id=$2`, projectID, episodeID).Scan(&groupID); err != nil {
		t.Fatalf("load replay group: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sessions
		(id,project_id,environment_id,started_at,last_chunk_at)
		VALUES ($1,$2,$3,$4,$4)`, sessionID, projectID, environmentID, anchor.Add(-time.Minute)); err != nil {
		t.Fatalf("seed replay session: %v", err)
	}
	first, last := anchor.Add(-20*time.Second).UnixMilli(), anchor.Add(20*time.Second).UnixMilli()
	if _, err := pool.Exec(ctx, `INSERT INTO session_chunks
		(session_id,seq,project_id,object_key,has_full_snapshot,scrubbed_at,first_event_ms,last_event_ms)
		VALUES ($1,0,$2,$3,true,now(),$4,$5)`, sessionID, projectID, "digest/"+sessionID, first, last); err != nil {
		t.Fatalf("seed replay chunk: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO error_events
		(project_id,environment_id,error_group_id,session_id,"timestamp",error_type,error_message,stack_trace_raw,created_at)
		VALUES ($1,$2,$3,$4,$5,'TypeError','boom','at test',$5)`,
		projectID, environmentID, groupID, sessionID, anchor); err != nil {
		t.Fatalf("seed replay event: %v", err)
	}
}

func TestFreezeCapturesOccurrenceAndReplayFacts(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, f.ProjectID)
	groupID, episodeID := seedActionableGroup(t, pool, f.ProjectID, f.EnvID, "error", "needs_human", now.Add(-2*time.Hour))
	quietBackgroundActionable(t, pool, f.ProjectID, groupID)
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET occurrence_count=34 WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	seedFreezeReplay(t, pool, f.ProjectID, f.EnvID, episodeID, "digest-replay-"+uuid.NewString(), now.Add(-2*time.Hour))

	_, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 {
		t.Fatalf("candidates: got %d", len(candidates))
	}
	if candidates[0].OccurrenceCount != 34 {
		t.Fatalf("occurrence: got %d", candidates[0].OccurrenceCount)
	}
	if candidates[0].Summary != "The checkout control does not submit." {
		t.Fatalf("summary = %q, want the stored root cause", candidates[0].Summary)
	}
	if candidates[0].ReplaySessionID == "" || candidates[0].ReplayAnchorMs == 0 {
		t.Fatalf("replay facts not frozen: %+v", candidates[0])
	}
}

func TestFreezeOnIncludesFrictionAndReusesValidatedCopy(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, f.ProjectID)
	groupID, _ := seedActionableGroup(t, pool, f.ProjectID, f.EnvID, "friction", "awaiting_approval", now.Add(-time.Hour))
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET signal_type='dead_click',candidate_diff='diff --git a/a b/a'
		WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}

	runID, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	var candidate Candidate
	for _, item := range candidates {
		if item.ErrorGroupID == groupID {
			candidate = item
			break
		}
	}
	if candidate.ErrorGroupID == "" || candidate.Kind != "friction" || candidate.EpisodeID != "" || candidate.Fingerprint == "" {
		t.Fatalf("friction candidate = %+v", candidate)
	}
	if candidate.ValidAction != "Approve the proposed fix." {
		t.Fatalf("valid action = %q", candidate.ValidAction)
	}
	var mode, phase string
	if err := pool.QueryRow(ctx, `SELECT r.unified_cards_mode,e.phase
		FROM digest_runs r JOIN digest_unified_run_items i ON i.run_id=r.id
		JOIN digest_run_candidate_evaluations e ON e.digest_run_id=r.id AND e.error_group_id=i.error_group_id
		WHERE r.id=$1 AND i.error_group_id=$2`, runID, groupID).Scan(&mode, &phase); err != nil {
		t.Fatal(err)
	}
	if mode != "on" || phase != "freeze" {
		t.Fatalf("stored mode=%s phase=%s", mode, phase)
	}
	if candidate.SpellStartedAt == nil {
		t.Fatal("friction spell was not frozen")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO digest_card_copy
		(error_group_id,spell_started_at,input_fingerprint,title,copy,why,action,model,prompt_version)
		VALUES ($1,$2,$3,'Saving is blocked','The save control never submits.',
		        'The submit handler is never wired to the control.','Review the proposed repair.','test',5)`,
		groupID, *candidate.SpellStartedAt, candidate.Fingerprint); err != nil {
		t.Fatal(err)
	}
	_, second, err := FreezeCandidates(ctx, pool, f.ProjectID, now.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range second {
		if item.ErrorGroupID == groupID {
			if item.CachedCard == nil || item.CachedCard.Copy != "The save control never submits." {
				t.Fatalf("cache not frozen atomically: %+v", item.CachedCard)
			}
			// The cause sentence rides with the rest of the card. A cached card
			// that lost it would fail its own validation the next day and demote
			// the incident to a receipt forever.
			if item.CachedCard.Why != "The submit handler is never wired to the control." {
				t.Fatalf("cached cause sentence did not survive the round trip: %+v", item.CachedCard)
			}
			return
		}
	}
	t.Fatal("friction candidate missing from second run")
}

func TestFreezeOnRepeatsActionableErrorPastLegacyWindows(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	episodeID := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-9*24*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "needs_human", now.Add(-9*24*time.Hour))
	var groupID string
	if err := pool.QueryRow(ctx, `UPDATE error_groups SET status='needs_human'
		WHERE id=(SELECT canonical_issue_id FROM issue_episodes WHERE id=$1) RETURNING id::text`, episodeID).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	quietBackgroundActionable(t, pool, f.ProjectID, groupID)
	firstRun, first, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil || len(first) != 1 || first[0].ErrorGroupID != groupID {
		t.Fatalf("first freeze candidates=%+v err=%v", first, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE digest_run_items SET outcome='included' WHERE run_id=$1`, firstRun); err != nil {
		t.Fatal(err)
	}
	// A publication row is the one-shot lane's gate. ON must not read it.
	if _, err := pool.Exec(ctx, `INSERT INTO issue_publications (project_id,episode_id,channel)
		VALUES ($1,$2,'digest')`, f.ProjectID, episodeID); err != nil {
		t.Fatal(err)
	}
	_, second, err := FreezeCandidates(ctx, pool, f.ProjectID, now.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 1 || second[0].ErrorGroupID != groupID {
		t.Fatalf("repeat freeze candidates=%+v, want group %s", second, groupID)
	}
	if second[0].ValidAction != "Review the investigation." {
		t.Fatalf("repeat action = %q", second[0].ValidAction)
	}
}

// TestFreezeOnProducesNoCandidateForInvestigatedFYI is R7: "we investigated,
// nothing to do" leaves the digest for good in ON, so it costs no model call.
func TestFreezeOnProducesNoCandidateForInvestigatedFYI(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	episodeID := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "verified_fix", now.Add(-time.Hour))
	var groupID string
	if err := pool.QueryRow(ctx, `SELECT canonical_issue_id::text FROM issue_episodes WHERE id=$1`,
		episodeID).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	quietBackgroundActionable(t, pool, f.ProjectID)
	runID, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatalf("investigated FYI produced candidates: %+v", candidates)
	}
	var ledgerRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM digest_run_candidate_evaluations
		WHERE digest_run_id=$1 AND error_group_id=$2`, runID, groupID).Scan(&ledgerRows); err != nil {
		t.Fatal(err)
	}
	if ledgerRows != 0 {
		t.Fatalf("investigated FYI reached the ledger: rows=%d", ledgerRows)
	}
}

// TestFreezeOnDropsIncidentThatStopsWaiting is the other half of R1: status
// alone decides presence, so leaving the ON status set removes the card.
func TestFreezeOnDropsIncidentThatStopsWaiting(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	episodeID := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "needs_human", now.Add(-time.Hour))
	var groupID string
	if err := pool.QueryRow(ctx, `UPDATE error_groups SET status='needs_human'
		WHERE id=(SELECT canonical_issue_id FROM issue_episodes WHERE id=$1) RETURNING id::text`,
		episodeID).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	quietBackgroundActionable(t, pool, f.ProjectID, groupID)
	if _, first, err := FreezeCandidates(ctx, pool, f.ProjectID, now); err != nil ||
		len(first) != 1 || first[0].SpellStartedAt == nil {
		t.Fatalf("actionable freeze candidates=%+v err=%v", first, err)
	}
	transitionAt := now.Add(23 * time.Hour)
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET status='investigated',last_seen=$2
		WHERE id=$1`, groupID, transitionAt); err != nil {
		t.Fatal(err)
	}
	_, second, err := FreezeCandidates(ctx, pool, f.ProjectID, now.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 0 {
		t.Fatalf("incident that stopped waiting still froze: %+v", second)
	}
}

func TestFreezeOnAdmitsFYIToActionableTransitionDespitePublication(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	episodeID := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "verified_fix", now.Add(-time.Hour))
	if _, err := pool.Exec(ctx, `INSERT INTO issue_publications (project_id,episode_id,channel)
		VALUES ($1,$2,'digest')`, f.ProjectID, episodeID); err != nil {
		t.Fatal(err)
	}
	transitionAt := now.Add(23 * time.Hour)
	var groupID string
	if err := pool.QueryRow(ctx, `UPDATE error_groups SET status='needs_human',last_seen=$2
		WHERE id=(SELECT canonical_issue_id FROM issue_episodes WHERE id=$1) RETURNING id::text`,
		episodeID, transitionAt).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "needs_human", transitionAt)
	quietBackgroundActionable(t, pool, f.ProjectID, groupID)
	_, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].ErrorGroupID != groupID || candidates[0].SpellStartedAt == nil {
		t.Fatalf("FYI-to-actionable candidates=%+v", candidates)
	}
}

func TestFreezeSucceedsWithoutWatchableReplay(t *testing.T) {
	pool := testPool(t)
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, f.ProjectID)
	groupID, _ := seedActionableGroup(t, pool, f.ProjectID, f.EnvID, "error", "needs_human", now.Add(-2*time.Hour))
	quietBackgroundActionable(t, pool, f.ProjectID, groupID)

	_, candidates, err := FreezeCandidates(context.Background(), pool, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].ReplaySessionID != "" || candidates[0].ReplayAnchorMs != 0 {
		t.Fatalf("unexpected replay facts: %+v", candidates)
	}
}

func TestFreezeIsIdempotentPerWindowAndPreservesSnapshot(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, f.ProjectID)
	groupID, _ := seedActionableGroup(t, pool, f.ProjectID, f.EnvID, "error", "awaiting_approval", now.Add(-2*time.Hour))
	quietBackgroundActionable(t, pool, f.ProjectID, groupID)

	firstID, first, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET title='mutated after freeze' WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	secondID, second, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if firstID != secondID {
		t.Fatalf("two freezes in one window must reuse the run: %s != %s", firstID, secondID)
	}
	if len(first) != 1 || len(second) != 1 || second[0].Title != first[0].Title {
		t.Fatalf("frozen snapshot changed: first=%+v second=%+v", first, second)
	}
}

// TestFreezeOnKeepsOneCandidatePerGroup: the card lane is keyed per incident,
// so extra episodes on one group add no candidates.
func TestFreezeOnKeepsOneCandidatePerGroup(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, f.ProjectID)
	groupID, firstEpisode := seedActionableGroup(t, pool, f.ProjectID, f.EnvID, "error", "needs_human", now.Add(-2*time.Hour))
	if _, err := pool.Exec(ctx, `UPDATE issue_episodes SET closed_at=$2 WHERE id=$1`,
		firstEpisode, now.Add(-90*time.Minute)); err != nil {
		t.Fatal(err)
	}
	var second string
	if err := pool.QueryRow(ctx, `INSERT INTO issue_episodes
		(project_id,canonical_issue_id,sequence) VALUES ($1,$2,2) RETURNING id::text`,
		f.ProjectID, groupID).Scan(&second); err != nil {
		t.Fatal(err)
	}

	_, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	forGroup := 0
	for _, candidate := range candidates {
		if candidate.ErrorGroupID == groupID {
			forGroup++
			if candidate.EpisodeID != "" {
				t.Fatalf("ON candidate is episode-keyed: %+v", candidate)
			}
		}
	}
	if forGroup != 1 {
		t.Fatalf("ON froze %d candidates for one group, want 1", forGroup)
	}
}

// TestFreezeAdmitsDiagnosedFrictionIncident is the consequence AC13 needs: a
// friction diagnosis that needs product judgment lands on awaiting_approval
// with a root cause and no candidate diff (decision 2026-09-01, replacing the
// terminal-FYI `insight`). The freeze must admit it and ask the reader to
// review the investigation, not to approve a fix that does not exist.
func TestFreezeAdmitsDiagnosedFrictionIncident(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, f.ProjectID)
	groupID, _ := seedActionableGroup(t, pool, f.ProjectID, f.EnvID, "friction", "awaiting_approval", now.Add(-time.Hour))
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET signal_type='dead_click',
		root_cause='Users expect the support email to be clickable; product decision.',
		candidate_diff=NULL WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	// The lifecycle trigger stamps the waiting age on the status write; without
	// it the incident is not in the actionable lane at all.
	var actionableSince *time.Time
	if err := pool.QueryRow(ctx, `SELECT actionable_since FROM error_groups WHERE id=$1`,
		groupID).Scan(&actionableSince); err != nil {
		t.Fatal(err)
	}
	if actionableSince == nil {
		t.Fatal("diagnosed friction incident was never stamped actionable")
	}
	quietBackgroundActionable(t, pool, f.ProjectID, groupID)

	_, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	var candidate Candidate
	for _, item := range candidates {
		if item.ErrorGroupID == groupID {
			candidate = item
			break
		}
	}
	if candidate.ErrorGroupID == "" {
		t.Fatalf("diagnosed friction incident was not frozen: %+v", candidates)
	}
	if candidate.Kind != "friction" || candidate.Status != "awaiting_approval" {
		t.Fatalf("frozen candidate = %+v", candidate)
	}
	if candidate.HasSavedDiff {
		t.Fatalf("candidate claims a saved diff it does not have: %+v", candidate)
	}
	if candidate.ValidAction != "Review the investigation." {
		t.Fatalf("valid action = %q, want %q", candidate.ValidAction, "Review the investigation.")
	}
	if candidate.RootCause == "" {
		t.Fatalf("the diagnosis did not reach the card: %+v", candidate)
	}
}

// TestFreezeHardFailsWhenLedgerUnavailable pins the blast radius this branch
// accepted on purpose: the unified freeze ledger is the run's accounting
// record, so a ledger failure aborts the whole freeze atomically — no run row,
// no partial snapshots — and the next tick retries from scratch. The failure is
// induced by renaming the ledger table for the duration of the call.
func TestFreezeHardFailsWhenLedgerUnavailable(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, f.ProjectID)
	groupID, _ := seedActionableGroup(t, pool, f.ProjectID, f.EnvID, "error", "needs_human", now.Add(-2*time.Hour))
	quietBackgroundActionable(t, pool, f.ProjectID, groupID)

	if _, err := pool.Exec(ctx, `ALTER TABLE digest_run_candidate_evaluations RENAME TO drce_freeze_hard_fail`); err != nil {
		t.Fatal(err)
	}
	restored := false
	restore := func() {
		if restored {
			return
		}
		restored = true
		if _, err := pool.Exec(ctx, `ALTER TABLE drce_freeze_hard_fail RENAME TO digest_run_candidate_evaluations`); err != nil {
			t.Fatalf("restore ledger table: %v", err)
		}
	}
	defer restore()

	if _, _, err := FreezeCandidates(ctx, pool, f.ProjectID, now); err == nil {
		t.Fatal("a freeze without its ledger must fail, not degrade")
	}
	var runs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM digest_runs WHERE project_id=$1`, f.ProjectID).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != 0 {
		t.Fatalf("failed freeze left %d run rows; the abort must be atomic", runs)
	}
	restore()

	runID, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("retry after restore: candidates=%d err=%v", len(candidates), err)
	}
	var ledgerRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM digest_run_candidate_evaluations
		WHERE digest_run_id=$1`, runID).Scan(&ledgerRows); err != nil {
		t.Fatal(err)
	}
	if ledgerRows == 0 {
		t.Fatal("the retried freeze wrote no ledger rows")
	}
}
