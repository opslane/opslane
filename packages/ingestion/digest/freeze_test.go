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
	episodeID := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "needs_human", now.Add(-time.Hour))
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET occurrence_count=34
		WHERE id=(SELECT canonical_issue_id FROM issue_episodes WHERE id=$1)`, episodeID); err != nil {
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
	if candidates[0].ReplaySessionID == "" || candidates[0].ReplayAnchorMs == 0 {
		t.Fatalf("replay facts not frozen: %+v", candidates[0])
	}
}

func TestFreezeDualWritesGroupIdentityAndChoosesCanonicalEpisode(t *testing.T) {
	t.Setenv("DIGEST_UNIFIED_CARDS", "off")
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	first := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-3*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, first, "needs_human", now.Add(-2*time.Hour))
	var groupID, second string
	if err := pool.QueryRow(ctx, `SELECT canonical_issue_id::text FROM issue_episodes WHERE id=$1`, first).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE issue_episodes SET closed_at=$2 WHERE id=$1`, first, now.Add(-90*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence)
		VALUES ($1,$2,2) RETURNING id::text`, f.ProjectID, groupID).Scan(&second); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO issue_inquiry_decisions
		(project_id,episode_id,decision,reason,evaluated_units,evidence_signature,model,prompt_version,decided_at)
		VALUES ($1,$2,'investigate','newer episode',1,$3,'test',1,$4)`,
		f.ProjectID, second, "freeze-"+uuid.NewString(), now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	seedFreezeDiagnosis(t, pool, f.ProjectID, second, "needs_human", now.Add(-30*time.Minute))

	runID, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].EpisodeID != second {
		t.Fatalf("canonical candidates = %+v, want episode %s", candidates, second)
	}
	if candidates[0].ErrorGroupID != groupID || candidates[0].Kind != "error" {
		t.Fatalf("incident identity not frozen: %+v", candidates[0])
	}
	var itemCount int
	var storedGroupID, mode string
	if err := pool.QueryRow(ctx, `SELECT count(*),min(error_group_id::text)
		FROM digest_run_items WHERE run_id=$1`, runID).Scan(&itemCount, &storedGroupID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT unified_cards_mode FROM digest_runs WHERE id=$1`, runID).Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if itemCount != 1 || storedGroupID != groupID || mode != "off" {
		t.Fatalf("run identity count=%d group=%s mode=%s", itemCount, storedGroupID, mode)
	}
}

func TestFreezeOnIncludesFrictionAndReusesValidatedCopy(t *testing.T) {
	t.Setenv("DIGEST_UNIFIED_CARDS", "on")
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
		(error_group_id,spell_started_at,input_fingerprint,title,copy,action,model,prompt_version)
		VALUES ($1,$2,$3,'Saving is blocked','The save control never submits.','Review the proposed repair.','test',4)`,
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
			return
		}
	}
	t.Fatal("friction candidate missing from second run")
}

func TestFreezeOnRepeatsActionableErrorPastLegacyWindows(t *testing.T) {
	t.Setenv("DIGEST_UNIFIED_CARDS", "on")
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
	t.Setenv("DIGEST_UNIFIED_CARDS", "on")
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
	t.Setenv("DIGEST_UNIFIED_CARDS", "on")
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
	t.Setenv("DIGEST_UNIFIED_CARDS", "on")
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
	episodeID := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "needs_human", now.Add(-time.Hour))

	_, candidates, err := FreezeCandidates(context.Background(), pool, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].ReplaySessionID != "" || candidates[0].ReplayAnchorMs != 0 {
		t.Fatalf("unexpected replay facts: %+v", candidates)
	}
}

func TestFreezeReplayFloorUsesPreviousEpisodeClose(t *testing.T) {
	tests := []struct {
		name        string
		sequence    int
		openedAt    time.Duration
		withCurrent bool
		wantCurrent bool
	}{
		{name: "returned excludes replay before prior close", sequence: 2, withCurrent: false},
		{name: "returned selects replay after prior close", sequence: 2, withCurrent: true, wantCurrent: true},
		{name: "first episode keeps replay before open", sequence: 1, openedAt: -time.Hour},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			pool := testPool(t)
			ctx := context.Background()
			now := time.Now().UTC().Truncate(time.Second)
			f := seedDigestFixture(t, pool, now)
			episodeID := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-3*time.Hour), tc.sequence)
			seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "needs_human", now.Add(-30*time.Minute))
			var groupID string
			if err := pool.QueryRow(ctx, `SELECT canonical_issue_id::text FROM issue_episodes WHERE id=$1`, episodeID).Scan(&groupID); err != nil {
				t.Fatal(err)
			}
			if tc.sequence == 2 {
				if _, err := pool.Exec(ctx, `INSERT INTO issue_episodes
					(project_id,canonical_issue_id,sequence,opened_at,closed_at)
					VALUES ($1,$2,1,$3,$4)`, f.ProjectID, groupID, now.Add(-6*time.Hour), now.Add(-2*time.Hour)); err != nil {
					t.Fatal(err)
				}
			} else if _, err := pool.Exec(ctx, `UPDATE issue_episodes SET opened_at=$2 WHERE id=$1`, episodeID, now.Add(tc.openedAt)); err != nil {
				t.Fatal(err)
			}
			oldID := "digest-old-" + uuid.NewString()
			seedFreezeReplay(t, pool, f.ProjectID, f.EnvID, episodeID, oldID, now.Add(-3*time.Hour))
			currentID := ""
			if tc.withCurrent {
				currentID = "digest-current-" + uuid.NewString()
				seedFreezeReplay(t, pool, f.ProjectID, f.EnvID, episodeID, currentID, now.Add(-time.Hour))
			}

			_, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
			if err != nil {
				t.Fatal(err)
			}
			if len(candidates) != 1 {
				t.Fatalf("candidates: got %d", len(candidates))
			}
			want := oldID
			if tc.sequence == 2 && !tc.wantCurrent {
				want = ""
			} else if tc.wantCurrent {
				want = currentID
			}
			if candidates[0].ReplaySessionID != want {
				t.Fatalf("replay = %q, want %q", candidates[0].ReplaySessionID, want)
			}
		})
	}
}

func TestFreezeAllowsANewlyReadyActionOnAQuietProblem(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	quiet := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-9*24*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, quiet, "verified_fix", now.Add(-time.Hour))

	_, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatalf("FreezeCandidates: %v", err)
	}
	for _, candidate := range candidates {
		if candidate.EpisodeID == quiet {
			return
		}
	}
	t.Error("a newly ready fix must be publishable even when the problem went quiet")
}

func TestFreezeExcludesStaleAndAlreadyPublished(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	fresh := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 1)
	stale := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-9*24*time.Hour), 1)
	already := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, fresh, "needs_human", now.Add(-time.Hour))
	seedFreezeDiagnosis(t, pool, f.ProjectID, stale, "needs_human", now.Add(-9*24*time.Hour))
	seedFreezeDiagnosis(t, pool, f.ProjectID, already, "verified_fix", now.Add(-time.Hour))
	if _, err := pool.Exec(ctx, `
		INSERT INTO issue_publications (project_id,episode_id,channel)
		VALUES ($1,$2,'digest')`, f.ProjectID, already); err != nil {
		t.Fatal(err)
	}

	_, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatalf("FreezeCandidates: %v", err)
	}
	got := make(map[string]bool)
	for _, candidate := range candidates {
		got[candidate.EpisodeID] = true
	}
	if !got[fresh] {
		t.Error("a fresh terminal result must be a candidate")
	}
	if got[stale] {
		t.Error("a problem last seen nine days ago must not be a candidate")
	}
	if got[already] {
		t.Error("an episode with a digest receipt must not repeat")
	}
}

func TestFreezeIsIdempotentPerWindowAndPreservesSnapshot(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	episodeID := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 2)
	seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "verified_fix", now.Add(-time.Hour))

	firstID, first, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET title='mutated after freeze'
		WHERE id=(SELECT canonical_issue_id FROM issue_episodes WHERE id=$1)`, episodeID); err != nil {
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
	if second[0].Label != "returned" {
		t.Errorf("sequence two label = %q, want returned", second[0].Label)
	}
}

// TestFreezeOffSelectsEveryEligibleEpisode pins OFF parity with main: the
// episode lane returns one candidate per eligible EPISODE and never dedups by
// error group. The schema makes a second open episode impossible today
// (idx_one_open_episode), so the index is dropped inside a transaction that is
// always rolled back — the rule under test belongs to the Go query path, which
// is the rollback surface and must stay identical to origin/main.
func TestFreezeOffSelectsEveryEligibleEpisode(t *testing.T) {
	t.Setenv("DIGEST_UNIFIED_CARDS", "off")
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DROP INDEX idx_one_open_episode`); err != nil {
		t.Fatal(err)
	}
	var groupID string
	if err := tx.QueryRow(ctx, `INSERT INTO error_groups
		  (project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
		   occurrence_count,affected_users_count,page_url_normalized,remediation)
		VALUES ($1,$2,$3,'Checkout failed','error','investigated',$4,$4,3,0,'/checkout',
		        'Decide whether to ship the documented follow-up.')
		RETURNING id::text`, f.ProjectID, f.EnvID, "freeze-two-open-"+uuid.NewString(),
		now.Add(-2*time.Hour)).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	episodes := make([]string, 0, 2)
	for sequence := 1; sequence <= 2; sequence++ {
		var episodeID string
		if err := tx.QueryRow(ctx, `INSERT INTO issue_episodes
			(project_id,canonical_issue_id,sequence) VALUES ($1,$2,$3) RETURNING id::text`,
			f.ProjectID, groupID, sequence).Scan(&episodeID); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO issue_inquiry_decisions
			(project_id,episode_id,decision,reason,evaluated_units,evidence_signature,
			 model,prompt_version,decided_at)
			VALUES ($1,$2,'investigate','customer checkout is blocked',1,$3,'test',1,$4)`,
			f.ProjectID, episodeID, "freeze-two-open-"+uuid.NewString(), now.Add(-2*time.Hour)); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO diagnosis_decisions
			(error_group_id,project_id,episode_id,outcome,decision_reason,diagnosis,
			 model,prompt_version,decided_at)
			VALUES ($1,$2,$3,'needs_human','verified terminal result',
			        '{"summary":"The checkout request fails before payment."}'::jsonb,
			        'test','1',$4)`,
			groupID, f.ProjectID, episodeID, now.Add(-time.Hour)); err != nil {
			t.Fatal(err)
		}
		episodes = append(episodes, episodeID)
	}

	candidates, replayFloors, err := selectCandidates(ctx, tx, f.ProjectID, now, now.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	frozen := make(map[string]bool, len(candidates))
	for _, candidate := range candidates {
		frozen[candidate.EpisodeID] = true
	}
	if len(candidates) != 2 || !frozen[episodes[0]] || !frozen[episodes[1]] {
		t.Fatalf("OFF returned %d candidates %v, want both eligible episodes %v",
			len(candidates), frozen, episodes)
	}
	if len(replayFloors) != len(candidates) {
		t.Fatalf("replay floors = %d, want %d", len(replayFloors), len(candidates))
	}
}

// TestFreezeOnKeepsOneCandidatePerGroup is the ON half of OFF's per-episode
// rule: the card lane is keyed by incident, so extra episodes on one group add
// no candidates.
func TestFreezeOnKeepsOneCandidatePerGroup(t *testing.T) {
	t.Setenv("DIGEST_UNIFIED_CARDS", "on")
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
