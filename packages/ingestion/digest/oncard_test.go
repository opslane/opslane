package digest

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

// seedOnCardGroup seeds one incident in the ON lane. remediation is left empty
// on purpose in most callers: prod data shows every incident that reached
// awaiting_approval has an empty remediation, and the old lane skipped exactly
// those. Nothing here may depend on that field.
func seedOnCardGroup(
	t *testing.T,
	pool *pgxpool.Pool,
	projectID, environmentID, kind, status string,
	hasDiff bool,
	prURL, rootCause string,
	lastSeen time.Time,
) string {
	t.Helper()
	diff := ""
	if hasDiff {
		diff = "diff --git a/src/checkout.ts b/src/checkout.ts"
	}
	var groupID string
	if err := pool.QueryRow(context.Background(), `INSERT INTO error_groups
		(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
		 occurrence_count,affected_users_count,signal_type,root_cause,suggested_mitigation,
		 candidate_diff,pr_url,remediation,reason_message)
		VALUES ($1,$2,$3,'Dead checkout control',$4,$5::error_group_status,$6,$6,17,2,
		        CASE WHEN $4='friction' THEN 'dead_click' ELSE NULL END,
		        NULLIF($7,''),'Repair the submit handler.',NULLIF($8,''),NULLIF($9,''),'','')
		RETURNING id::text`,
		projectID, environmentID, "oncard-"+uuid.NewString(), kind, status, lastSeen,
		rootCause, diff, prURL).Scan(&groupID); err != nil {
		t.Fatalf("seed on-card group: %v", err)
	}
	// The insert trigger stamps actionable_since=now(); backdate it to the
	// seeded time so the fixture has genuinely been waiting since lastSeen —
	// the freeze bounds its replay lookup by this spell start.
	if _, err := pool.Exec(context.Background(), `UPDATE error_groups SET actionable_since=$2 WHERE id=$1`,
		groupID, lastSeen); err != nil {
		t.Fatalf("backdate on-card spell: %v", err)
	}
	return groupID
}

// seedValidatedDiagnosis gives a group the validated diagnosis publishable()
// demands of the non-PR receipt states.
func seedValidatedDiagnosis(t *testing.T, pool *pgxpool.Pool, projectID, groupID string, decidedAt time.Time) {
	t.Helper()
	ctx := context.Background()
	var episodeID string
	if err := pool.QueryRow(ctx, `INSERT INTO issue_episodes
		(project_id,canonical_issue_id,sequence) VALUES ($1,$2,1) RETURNING id::text`,
		projectID, groupID).Scan(&episodeID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO diagnosis_decisions
		(error_group_id,project_id,episode_id,outcome,decision_reason,diagnosis,model,prompt_version,decided_at)
		VALUES ($1,$2,$3,'not_actionable','validated finding',
		 '{"evidence":[{"path":"src/checkout.ts","detail":"click has no handler","symptomLink":"dead click"}]}'::jsonb,
		 'test','1',$4)`, groupID, projectID, episodeID, decidedAt); err != nil {
		t.Fatal(err)
	}
	cleanupActionableDiagnoses(t, pool, projectID)
}

// seedTerminalFixJob points an incident's terminal fix job at a real job row.
// jobType is a parameter because the fact under test is the TYPE: reconciling
// a dead-lettered investigation stores that investigation's id in the same
// column, and reading the id alone would claim a fix attempt that never was.
func seedTerminalFixJob(t *testing.T, pool *pgxpool.Pool, projectID, groupID, jobType string) {
	t.Helper()
	ctx := context.Background()
	var jobID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_group_jobs
		(error_group_id,project_id,job_type,status) VALUES ($1,$2,$3,'completed')
		RETURNING id::text`, groupID, projectID, jobType).Scan(&jobID); err != nil {
		t.Fatalf("seed terminal fix job: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET terminal_fix_job_id=$2 WHERE id=$1`,
		groupID, jobID); err != nil {
		t.Fatalf("stamp terminal fix job: %v", err)
	}
}

func writeOnCardPayload(t *testing.T, pool *pgxpool.Pool, runID string, candidates []Candidate) {
	t.Helper()
	payload := writtenDigestPayload{Included: []writtenDigestCard{}, Deferred: []deferredDigestItem{}}
	for _, candidate := range candidates {
		payload.Included = append(payload.Included, writtenDigestCard{
			ErrorGroupID: candidate.ErrorGroupID, Title: "Saving is blocked",
			Copy:   "People cannot save because the control never submits.",
			Why:    "The submit handler is never wired to the control.",
			Action: "Take a look when you can.", Label: candidate.Label,
		})
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE digest_runs
		SET status='written',writer_payload=$2::jsonb WHERE id=$1`, runID, encoded); err != nil {
		t.Fatal(err)
	}
}

func onCardFixture(t *testing.T, now time.Time) (*pgxpool.Pool, digestFixture) {
	t.Helper()
	pool := testPool(t)
	fixture := seedDigestFixture(t, pool, now)
	quietBackgroundActionable(t, pool, fixture.ProjectID)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	return pool, fixture
}

// TestDigestActionIsExhaustive pins the deterministic action function itself.
// Migration 072's error_groups_action_class is its SQL twin.
func TestDigestActionIsExhaustive(t *testing.T) {
	for _, tc := range []struct {
		name, status string
		hasSavedDiff bool
		fixAttempted bool
		prURL, want  string
	}{
		{"approval with diff", "awaiting_approval", true, false, "", "Approve the proposed fix."},
		{"approval without diff after a fix ran", "awaiting_approval", false, true, "", "Decide how to handle this."},
		{"approval without diff or fix", "awaiting_approval", false, false, "", "Decide how to handle this."},
		{"pr open", "pr_created", false, false, "https://github.com/o/r/pull/1", "Review the fix PR."},
		{"pr draft", "pr_draft", true, false, "https://github.com/o/r/pull/1", "Review the fix PR."},
		{"pr without url", "pr_created", false, false, "", "Review the issue."},
		{"pr draft without url", "pr_draft", false, false, "", "Review the issue."},
		{"needs human after a fix ran", "needs_human", false, true, "", "Decide how to handle this."},
		{"needs human with no fix ever run", "needs_human", false, false, "", "Decide how to handle this."},
		{"needs human with diff", "needs_human", true, false, "", "Decide how to handle this."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := digestAction(tc.status, tc.hasSavedDiff, tc.prURL, tc.fixAttempted); got != tc.want {
				t.Fatalf("digestAction(%q,%v,%q,%v) = %q, want %q",
					tc.status, tc.hasSavedDiff, tc.prURL, tc.fixAttempted, got, tc.want)
			}
		})
	}
}

// TestFreezeOnCoversEveryStatusAndKind is R1 and R2 together: every waiting
// incident publishable() accepts freezes with its state-derived action, with an
// empty remediation throughout, and one it refuses is ledgered not_publishable.
func TestFreezeOnCoversEveryStatusAndKind(t *testing.T) {
	for _, tc := range []struct {
		name, kind, status string
		hasDiff            bool
		prURL              string
		validatedDiagnosis bool
		terminalJobType    string
		wantAction         string
		wantExcluded       bool
	}{
		{name: "error awaiting approval with diff", kind: "error", status: "awaiting_approval",
			hasDiff: true, validatedDiagnosis: true, wantAction: "Approve the proposed fix."},
		{name: "error awaiting approval after a fix ran", kind: "error", status: "awaiting_approval",
			validatedDiagnosis: true, terminalJobType: "fix", wantAction: "Decide how to handle this."},
		{name: "error awaiting approval with no fix ever run", kind: "error", status: "awaiting_approval",
			validatedDiagnosis: true, wantAction: "Decide how to handle this."},
		{name: "friction awaiting approval without diff", kind: "friction", status: "awaiting_approval",
			validatedDiagnosis: true, wantAction: "Decide how to handle this."},
		{name: "friction needs human with diff", kind: "friction", status: "needs_human",
			hasDiff: true, wantAction: "Decide how to handle this."},
		{name: "error needs human after a fix produced nothing", kind: "error", status: "needs_human",
			validatedDiagnosis: true, terminalJobType: "error_fix", wantAction: "Decide how to handle this."},
		{name: "error needs human without diagnosis", kind: "error", status: "needs_human", wantExcluded: true},
		// The dead-lettered-investigation reconciliation writes an investigation
		// job id into the same column. It is not a fix attempt.
		{name: "error needs human after a dead-lettered investigation", kind: "error", status: "needs_human",
			validatedDiagnosis: true, terminalJobType: "investigate", wantAction: "Decide how to handle this."},
		{name: "error pr created with url", kind: "error", status: "pr_created",
			prURL: "https://github.com/acme/shop/pull/7", wantAction: "Review the fix PR."},
		{name: "friction pr draft with url", kind: "friction", status: "pr_draft",
			prURL: "https://github.com/acme/shop/pull/8", wantAction: "Review the fix PR."},
		{name: "error pr created without url", kind: "error", status: "pr_created", wantExcluded: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now().UTC().Truncate(time.Second)
			pool, fixture := onCardFixture(t, now)
			groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, tc.kind, tc.status,
				tc.hasDiff, tc.prURL, "The checkout control does not submit.", now.Add(-time.Hour))
			if tc.validatedDiagnosis {
				seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))
			}
			if tc.terminalJobType != "" {
				seedTerminalFixJob(t, pool, fixture.ProjectID, groupID, tc.terminalJobType)
			}
			runID, candidates, err := FreezeCandidates(context.Background(), pool, fixture.ProjectID, now)
			if err != nil {
				t.Fatal(err)
			}
			if tc.wantExcluded {
				if len(candidates) != 0 {
					t.Fatalf("an incident publishable() refuses reached the digest: %+v", candidates)
				}
				if outcome, reason, _ := heldBackLedger(t, pool, runID, groupID); outcome != "excluded" || reason != reasonNotPublishable {
					t.Fatalf("ledger = %s/%s, want excluded/%s", outcome, reason, reasonNotPublishable)
				}
				return
			}
			if len(candidates) != 1 || candidates[0].ErrorGroupID != groupID {
				t.Fatalf("incident never reached the digest: %+v", candidates)
			}
			candidate := candidates[0]
			if candidate.ValidAction != tc.wantAction {
				t.Errorf("action = %q, want %q", candidate.ValidAction, tc.wantAction)
			}
			if candidate.SpellStartedAt == nil {
				t.Error("no waiting age was frozen")
			}
			if candidate.Kind != tc.kind {
				t.Errorf("kind = %q, want %q", candidate.Kind, tc.kind)
			}
		})
	}
}

// TestFreezeOnAccountsForCappedOverflow: past the cap an incident is counted
// and ledgered, never silently dropped.
func TestFreezeOnAccountsForCappedOverflow(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	seeded := make([]string, 0, notify.DigestV4CardCap+3)
	for i := 0; i < notify.DigestV4CardCap+3; i++ {
		seeded = append(seeded, seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID,
			"friction", "needs_human", true, "", "cause", now.Add(-time.Duration(i+1)*time.Hour)))
	}
	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != notify.DigestV4CardCap {
		t.Fatalf("frozen candidates = %d, want the cap %d", len(candidates), notify.DigestV4CardCap)
	}
	for _, groupID := range seeded {
		var outcome, reason, phase string
		if err := pool.QueryRow(ctx, `SELECT outcome,primary_reason_code,phase
			FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`,
			runID, groupID).Scan(&outcome, &reason, &phase); err != nil {
			t.Fatalf("incident %s has no ledger row: %v", groupID, err)
		}
		if outcome == "excluded" && reason != reasonCappedOverflow {
			t.Fatalf("incident %s excluded as %q, want %q", groupID, reason, reasonCappedOverflow)
		}
	}
}

// TestValidateOnWritesNoPublicationsForAnyStatus is R6. A pre-existing
// publication row must gate nothing, and delivery must add none.
func TestValidateOnWritesNoPublicationsForAnyStatus(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	// The PR cards link into the project repository, so every status earns a card.
	if _, err := pool.Exec(ctx, `UPDATE projects SET github_repo='acme/shop' WHERE id=$1`, fixture.ProjectID); err != nil {
		t.Fatal(err)
	}
	statuses := []struct {
		status  string
		hasDiff bool
		prURL   string
	}{
		{status: "awaiting_approval", hasDiff: true},
		{status: "needs_human"},
		{status: "pr_created", prURL: "https://github.com/acme/shop/pull/11"},
		{status: "pr_draft", prURL: "https://github.com/acme/shop/pull/12"},
	}
	for i, tc := range statuses {
		groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", tc.status,
			tc.hasDiff, tc.prURL, "The checkout control does not submit.", now.Add(-time.Duration(i+1)*time.Hour))
		seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))
		// The one-shot gate, pre-poisoned: ON must ignore it entirely.
		if _, err := pool.Exec(ctx, `INSERT INTO issue_publications (project_id,episode_id,channel)
			SELECT $1,id,'digest' FROM issue_episodes WHERE canonical_issue_id=$2`,
			fixture.ProjectID, groupID); err != nil {
			t.Fatal(err)
		}
	}

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != len(statuses) {
		t.Fatalf("frozen candidates = %d, want %d: %+v", len(candidates), len(statuses), candidates)
	}
	var before int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM issue_publications
		WHERE project_id=$1`, fixture.ProjectID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	writeOnCardPayload(t, pool, runID, candidates)
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	var after int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM issue_publications
		WHERE project_id=$1`, fixture.ProjectID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("delivered ON run wrote %d publication rows", after-before)
	}
	payload := renderedEvent(t, pool, runID).Digest
	if len(payload.GeneratedCards) != len(statuses) || len(payload.ReceiptItems) != 0 {
		t.Fatalf("delivered %d cards for %d actionable incidents: cards=%+v receipts=%+v",
			len(payload.GeneratedCards), len(statuses), payload.GeneratedCards, payload.ReceiptItems)
	}
}

// TestValidateOnRendersEmptyRemediationIncident is the F4 regression: the field
// the old lane keyed the action on is empty, and the incident renders anyway.
func TestValidateOnRendersEmptyRemediationIncident(t *testing.T) {
	for _, tc := range []struct {
		name       string
		hasDiff    bool
		wantAction string
	}{
		{name: "with saved diff", hasDiff: true, wantAction: "Approve the proposed fix."},
		// No diff and no fix job: the only thing waiting is the diagnosis.
		{name: "without saved diff", wantAction: "Decide how to handle this."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now().UTC().Truncate(time.Second)
			pool, fixture := onCardFixture(t, now)
			ctx := context.Background()
			groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error",
				"awaiting_approval", tc.hasDiff, "", "The checkout control does not submit.", now.Add(-time.Hour))
			seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))
			var remediation, reasonMessage string
			if err := pool.QueryRow(ctx, `SELECT COALESCE(remediation,''),COALESCE(reason_message,'')
				FROM error_groups WHERE id=$1`, groupID).Scan(&remediation, &reasonMessage); err != nil {
				t.Fatal(err)
			}
			if remediation != "" || reasonMessage != "" {
				t.Fatalf("fixture is not the empty-field shape: %q / %q", remediation, reasonMessage)
			}

			runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
			if err != nil || len(candidates) != 1 {
				t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
			}
			if candidates[0].ValidAction != tc.wantAction {
				t.Fatalf("action = %q, want %q", candidates[0].ValidAction, tc.wantAction)
			}
			writeOnCardPayload(t, pool, runID, candidates)
			if err := ValidateAndPublish(ctx, pool, runID); err != nil {
				t.Fatal(err)
			}
			payload := renderedEvent(t, pool, runID).Digest
			if len(payload.GeneratedCards) != 1 {
				t.Fatalf("empty-remediation incident did not render a card: %+v", payload)
			}
			// The model wrote "Take a look when you can."; the state function owns
			// the line, so that is not what the reader sees.
			if payload.GeneratedCards[0].Action != tc.wantAction {
				t.Fatalf("rendered action = %q, want %q", payload.GeneratedCards[0].Action, tc.wantAction)
			}

			// Day two: still waiting, still rendered.
			_, second, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now.Add(24*time.Hour))
			if err != nil || len(second) != 1 || second[0].ErrorGroupID != groupID {
				t.Fatalf("second freeze candidates=%+v err=%v", second, err)
			}
		})
	}
}

// TestValidateOnPRCardRepeatsFromCache is R1 for the PR statuses: the card is
// authored once and re-served from the cache on the following days.
func TestValidateOnPRCardRepeatsFromCache(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE projects SET github_repo='acme/shop' WHERE id=$1`, fixture.ProjectID); err != nil {
		t.Fatal(err)
	}
	groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "pr_created",
		false, "https://github.com/acme/shop/pull/21", "The checkout control does not submit.", now.Add(-time.Hour))

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 1 || candidates[0].ErrorGroupID != groupID {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	if candidates[0].ValidAction != "Review the fix PR." {
		t.Fatalf("PR candidate = %+v", candidates[0])
	}
	writeOnCardPayload(t, pool, runID, candidates)
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, runID).Digest
	if len(payload.GeneratedCards) != 1 || payload.GeneratedCards[0].Action != "Review the fix PR." {
		t.Fatalf("day one cards = %+v", payload.GeneratedCards)
	}

	for day := 2; day <= 3; day++ {
		at := now.Add(time.Duration(day-1) * 24 * time.Hour)
		nextRun, next, err := FreezeCandidates(ctx, pool, fixture.ProjectID, at)
		if err != nil || len(next) != 1 || next[0].ErrorGroupID != groupID {
			t.Fatalf("day %d freeze candidates=%+v err=%v", day, next, err)
		}
		if next[0].CachedCard == nil {
			t.Fatalf("day %d did not reuse the authored card", day)
		}
		payload := writtenDigestPayload{Included: []writtenDigestCard{{
			ErrorGroupID: groupID, Title: next[0].CachedCard.Title, Copy: next[0].CachedCard.Copy,
			Why: next[0].CachedCard.Why, Action: next[0].CachedCard.Action, Label: next[0].Label,
		}}}
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE digest_runs
			SET status='written',writer_payload=$2::jsonb WHERE id=$1`, nextRun, encoded); err != nil {
			t.Fatal(err)
		}
		if err := ValidateAndPublish(ctx, pool, nextRun); err != nil {
			t.Fatal(err)
		}
		rendered := renderedEvent(t, pool, nextRun).Digest
		if len(rendered.GeneratedCards) != 1 || rendered.GeneratedCards[0].Action != "Review the fix PR." {
			t.Fatalf("day %d cards = %+v", day, rendered.GeneratedCards)
		}
		var renderMode string
		if err := pool.QueryRow(ctx, `SELECT render_mode FROM digest_run_candidate_evaluations
			WHERE digest_run_id=$1 AND error_group_id=$2`, nextRun, groupID).Scan(&renderMode); err != nil {
			t.Fatal(err)
		}
		if renderMode != "cached" {
			t.Fatalf("day %d render mode = %q, want cached", day, renderMode)
		}
	}
}

// TestFreezeOnCapsAtTheRendererLimit: the ON lane's bound is the renderer's
// real Slack constraint (notify.DigestV4CardCap), not the receipts-era five.
// Every incident past it is ledgered capped_overflow and stays on the
// dashboard; the message carries no overflow line.
func TestFreezeOnCapsAtTheRendererLimit(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	const extra = 3
	seeded := make([]string, 0, notify.DigestV4CardCap+extra)
	for i := 0; i < notify.DigestV4CardCap+extra; i++ {
		groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "needs_human",
			true, "", "The checkout control does not submit.", now.Add(-time.Duration(i+1)*time.Hour))
		seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))
		seeded = append(seeded, groupID)
	}

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != notify.DigestV4CardCap {
		t.Fatalf("frozen candidates = %d, want the renderer cap %d", len(candidates), notify.DigestV4CardCap)
	}
	var capped int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM digest_run_candidate_evaluations
		WHERE digest_run_id=$1 AND outcome='excluded' AND primary_reason_code=$2`,
		runID, reasonCappedOverflow).Scan(&capped); err != nil {
		t.Fatal(err)
	}
	if capped != extra {
		t.Fatalf("ledgered capped_overflow = %d, want %d", capped, extra)
	}

	writeOnCardPayload(t, pool, runID, candidates)
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, runID)
	if payload.Digest.OverflowCount+payload.Digest.ReceiptOverflow != 0 {
		t.Fatalf("payload overflow = %d+%d, want none", payload.Digest.OverflowCount,
			payload.Digest.ReceiptOverflow)
	}
	body, _, err := notify.FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "more on the dashboard") {
		t.Fatalf("Slack message has an overflow line: %s", body)
	}
	var rendered struct {
		Blocks []json.RawMessage `json:"blocks"`
	}
	if err := json.Unmarshal(body, &rendered); err != nil {
		t.Fatal(err)
	}
	if len(rendered.Blocks) > 50 {
		t.Fatalf("digest rendered %d Slack blocks, want at most 50", len(rendered.Blocks))
	}
	if len(seeded) != notify.DigestV4CardCap+extra {
		t.Fatalf("seeded %d incidents", len(seeded))
	}
}

// TestValidateOnRequiresACauseSentenceFromADiagnosedCard: the card exists to
// answer "why", so a diagnosed incident whose card omits that sentence is held
// back. Only that card is held back; its sibling still ships.
func TestValidateOnRequiresACauseSentenceFromADiagnosedCard(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	diagnosed := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "awaiting_approval",
		true, "", "The submit handler is never wired to the control.", now.Add(-2*time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, diagnosed, now.Add(-time.Hour))
	// Admitted on its validated diagnosis with no stored cause to explain: the
	// cause sentence is excused rather than demanded, and its card still ships.
	causeless := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "awaiting_approval",
		false, "", "", now.Add(-time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, causeless, now.Add(-time.Hour))

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 2 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	// Neither card carries a cause sentence.
	payload := writtenDigestPayload{Deferred: []deferredDigestItem{}}
	for _, candidate := range candidates {
		payload.Included = append(payload.Included, writtenDigestCard{
			ErrorGroupID: candidate.ErrorGroupID, Title: "Saving is blocked",
			Copy:   "People cannot save because the control never submits.",
			Action: "Take a look when you can.", Label: candidate.Label,
		})
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE digest_runs
		SET status='written',writer_payload=$2::jsonb WHERE id=$1`, runID, encoded); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}

	delivered := renderedEvent(t, pool, runID).Digest
	if len(delivered.GeneratedCards) != 1 || delivered.GeneratedCards[0].IncidentID != causeless {
		t.Fatalf("cards = %+v, want only the incident with no cause to explain", delivered.GeneratedCards)
	}
	if len(delivered.ReceiptItems) != 0 {
		t.Fatalf("receipts = %+v, want none", delivered.ReceiptItems)
	}
	outcome, reason, held := heldBackLedger(t, pool, runID, diagnosed)
	if outcome != "excluded" || reason != reasonCardHeldBack || !strings.Contains(held, "carries no cause sentence") {
		t.Fatalf("diagnosed card ledger = %s/%s/%q, want excluded/%s for its missing cause sentence",
			outcome, reason, held, reasonCardHeldBack)
	}
}

// The rule cuts both ways: the cause sentence answers to the stored cause and
// nothing else, so a card that writes one for an incident with no stored cause
// is asserting something nothing can check, and it is held back.
func TestValidateOnRefusesACauseSentenceWithoutAStoredCause(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	causeless := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "awaiting_approval",
		false, "", "", now.Add(-time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, causeless, now.Add(-time.Hour))

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	payload := writtenDigestPayload{Deferred: []deferredDigestItem{}, Included: []writtenDigestCard{{
		ErrorGroupID: candidates[0].ErrorGroupID, Title: "Saving is blocked",
		Copy:   "People cannot save because the control never submits.",
		Why:    "The handler was never wired to the control.",
		Action: "Take a look when you can.", Label: candidates[0].Label,
	}}}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE digest_runs
		SET status='written',writer_payload=$2::jsonb WHERE id=$1`, runID, encoded); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	assertHeldBack(t, pool, fixture.ProjectID, runID, causeless)
	if _, _, held := heldBackLedger(t, pool, runID, causeless); !strings.Contains(held, "has no stored cause to answer to") {
		t.Fatalf("causeless card held reason = %q, want its unchecked cause sentence", held)
	}
}

// TestValidateOnCachesAndRendersTheCauseSentence: the Why survives the cache
// round trip and reaches the reader on its own line.
func TestValidateOnCachesAndRendersTheCauseSentence(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "awaiting_approval",
		true, "", "The submit handler is never wired to the control.", now.Add(-time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	writeOnCardPayload(t, pool, runID, candidates)
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	delivered := renderedEvent(t, pool, runID)
	if len(delivered.Digest.GeneratedCards) != 1 ||
		delivered.Digest.GeneratedCards[0].Why != "The submit handler is never wired to the control." {
		t.Fatalf("delivered cards = %+v", delivered.Digest.GeneratedCards)
	}
	body, _, err := notify.FormatSlack(delivered)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "Why: The submit handler is never wired to the control.") {
		t.Fatalf("Slack message has no cause line: %s", body)
	}

	// Day two serves the same sentence from the cache.
	secondRun, second, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now.Add(24*time.Hour))
	if err != nil || len(second) != 1 || second[0].CachedCard == nil {
		t.Fatalf("second freeze candidates=%+v err=%v", second, err)
	}
	if second[0].CachedCard.Why != "The submit handler is never wired to the control." {
		t.Fatalf("cached card lost its cause sentence: %+v", second[0].CachedCard)
	}
	echoCachedPayload(t, pool, secondRun, second[0])
	if err := ValidateAndPublish(ctx, pool, secondRun); err != nil {
		t.Fatal(err)
	}
	repeat := renderedEvent(t, pool, secondRun).Digest
	if len(repeat.GeneratedCards) != 1 ||
		repeat.GeneratedCards[0].Why != "The submit handler is never wired to the control." {
		t.Fatalf("cached day cards = %+v", repeat.GeneratedCards)
	}
}

// TestValidateOnHoldsBackACardWhoseAskChangedAfterFreeze: migration 066 resets
// actionable_since whenever the action class changes, so a normal minutes-long
// gap between freeze and validate (a PR opening, a diff arriving) moves the
// spell. The frozen card describes an ask that no longer holds, so it does not
// ship; the incident is still waiting, so its ledger says card_held_back rather
// than that it left, and tomorrow's freeze picks up the new ask.
func TestValidateOnHoldsBackACardWhoseAskChangedAfterFreeze(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", "The checkout control does not submit.", now.Add(-time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	writeOnCardPayload(t, pool, runID, candidates)

	// The ask changes between freeze and validate: a PR opens.
	if _, err := pool.Exec(ctx, `UPDATE error_groups
		SET status='pr_created',pr_url='https://github.com/acme/shop/pull/9' WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	var spellMoved bool
	if err := pool.QueryRow(ctx, `SELECT actionable_since <> $2 FROM error_groups WHERE id=$1`,
		groupID, *candidates[0].SpellStartedAt).Scan(&spellMoved); err != nil {
		t.Fatal(err)
	}
	if !spellMoved {
		t.Fatal("the trigger did not reset the waiting age; the test proves nothing")
	}

	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	assertHeldBack(t, pool, fixture.ProjectID, runID, groupID)
}

// TestFreezeOnSkipsAnActionableRowWithNoWaitingAge: an actionable row whose
// actionable_since is NULL used to be frozen as a non-actionable candidate,
// which sent validation down the episode path with an empty episode id. The
// resulting uuid encode error is not pgx.ErrNoRows, so one malformed row cost
// every card in the ON section.
func TestFreezeOnSkipsAnActionableRowWithNoWaitingAge(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	malformed := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "needs_human",
		true, "", "The checkout control does not submit.", now.Add(-2*time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, malformed, now.Add(-time.Hour))
	healthy := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "awaiting_approval",
		true, "", "The save control does not submit.", now.Add(-time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, healthy, now.Add(-time.Hour))
	// Only a direct write can produce this shape; the lifecycle trigger cannot.
	if _, err := pool.Exec(ctx, `ALTER TABLE error_groups DISABLE TRIGGER USER`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET actionable_since=NULL WHERE id=$1`, malformed); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE error_groups ENABLE TRIGGER USER`); err != nil {
		t.Fatal(err)
	}

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].ErrorGroupID != healthy {
		t.Fatalf("frozen candidates = %+v, want only the healthy incident", candidates)
	}
	var outcome, reason string
	if err := pool.QueryRow(ctx, `SELECT outcome,primary_reason_code
		FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`,
		runID, malformed).Scan(&outcome, &reason); err != nil {
		t.Fatalf("the skipped row was not ledgered: %v", err)
	}
	if outcome != "excluded" || reason != reasonMissingWaitingAge {
		t.Fatalf("ledger row = %s/%s, want excluded/%s", outcome, reason, reasonMissingWaitingAge)
	}

	writeOnCardPayload(t, pool, runID, candidates)
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, runID).Digest
	if len(payload.GeneratedCards) != 1 || payload.GeneratedCards[0].IncidentID != healthy {
		t.Fatalf("one malformed row cost the healthy card: %+v", payload)
	}
	if events := digestOutboxEvents(t, pool, fixture.ProjectID, runID); events != 1 {
		t.Fatalf("outbox events = %d, want 1 carrying the healthy card", events)
	}
}

func TestFreezeOnExcludesIncidentsThatCannotEarnACard(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	undiagnosed := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "awaiting_approval",
		false, "", "The submit handler is never wired to the control.", now.Add(-time.Hour))
	prWithoutURL := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "pr_created",
		false, "", "The save request never leaves the page.", now.Add(-2*time.Hour))
	filler := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", "TBD", now.Add(-3*time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, filler, now.Add(-time.Hour))
	savedDiff := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "needs_human",
		true, "", "The export request never leaves the page.", now.Add(-4*time.Hour))
	prWithURL := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "pr_created",
		false, "https://github.com/acme/shop/pull/7", "The import request never leaves the page.", now.Add(-5*time.Hour))
	diagnosed := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", "The save request never leaves the page.", now.Add(-6*time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, diagnosed, now.Add(-time.Hour))

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	frozen := map[string]bool{}
	for _, candidate := range candidates {
		frozen[candidate.ErrorGroupID] = true
	}
	// A saved diff or an open PR is something to act on even without a
	// validated diagnosis; publishable() admits both.
	if len(candidates) != 3 || !frozen[diagnosed] || !frozen[savedDiff] || !frozen[prWithURL] {
		t.Fatalf("frozen candidates = %+v, want the diagnosed, saved-diff, and PR-with-URL incidents", candidates)
	}
	for _, groupID := range []string{undiagnosed, prWithoutURL, filler} {
		if outcome, reason, _ := heldBackLedger(t, pool, runID, groupID); outcome != "excluded" || reason != reasonNotPublishable {
			t.Fatalf("ledger for %s = %s/%s, want excluded/%s", groupID, outcome, reason, reasonNotPublishable)
		}
	}
}

func TestFreezeOnGivesErrorCandidatesTheirRootCauseAsWhy(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	const rootCause = "The refresh call has no catch, so a rejected view refresh escapes."
	groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", rootCause, now.Add(-time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))

	_, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	if candidates[0].Why != rootCause {
		t.Fatalf("frozen why = %q, want the validated root cause %q", candidates[0].Why, rootCause)
	}
}

func TestDigestErrorCardWithValidatedRootCauseShipsAWhyLine(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	const rootCause = "The submit handler is never wired to the control."
	groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", rootCause, now.Add(-time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	if candidates[0].Why != rootCause {
		t.Fatalf("frozen why = %q, want %q", candidates[0].Why, rootCause)
	}
	// Stub writer: the card a writer following the prompt returns for this candidate.
	writeOnCardPayload(t, pool, runID, candidates)
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, runID)
	if payload.Digest.SchemaVersion != 5 || len(payload.Digest.GeneratedCards) != 1 || payload.Digest.GeneratedCards[0].Why == "" {
		t.Fatalf("published digest = %+v, want one v5 card with a why", payload.Digest)
	}
	body, _, err := notify.FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "Why: The submit handler is never wired to the control.") {
		t.Fatalf("Slack digest has no Why line: %s", body)
	}
}
