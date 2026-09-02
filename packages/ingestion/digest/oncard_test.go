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

func writeOnCardPayload(t *testing.T, pool *pgxpool.Pool, runID string, candidates []Candidate) {
	t.Helper()
	payload := writtenDigestPayload{Included: []writtenDigestCard{}, Deferred: []deferredDigestItem{}}
	for _, candidate := range candidates {
		if candidate.NotCardEligible {
			// What the writer does mechanically for a never-eligible candidate.
			payload.Deferred = append(payload.Deferred, deferredDigestItem{
				ErrorGroupID: candidate.ErrorGroupID,
				Reason:       "no authored card is available for this incident",
			})
			continue
		}
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
// Migration 066's error_groups_action_class is its SQL twin.
func TestDigestActionIsExhaustive(t *testing.T) {
	for _, tc := range []struct {
		name, status string
		hasSavedDiff bool
		prURL, want  string
	}{
		{"approval with diff", "awaiting_approval", true, "", "Approve the proposed fix."},
		{"approval without diff", "awaiting_approval", false, "", "Review the investigation."},
		{"pr open", "pr_created", false, "https://github.com/o/r/pull/1", "Review the fix PR."},
		{"pr draft", "pr_draft", true, "https://github.com/o/r/pull/1", "Review the fix PR."},
		{"pr without url", "pr_created", false, "", "Review the issue."},
		{"pr draft without url", "pr_draft", false, "", "Review the issue."},
		{"needs human", "needs_human", false, "", "Review the investigation."},
		{"needs human with diff", "needs_human", true, "", "Review the investigation."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := digestAction(tc.status, tc.hasSavedDiff, tc.prURL); got != tc.want {
				t.Fatalf("digestAction(%q,%v,%q) = %q, want %q", tc.status, tc.hasSavedDiff, tc.prURL, got, tc.want)
			}
		})
	}
}

// TestFreezeOnCoversEveryStatusAndKind is R1 and R2 together: every waiting
// incident freezes with its state-derived action, with an empty remediation
// throughout, and publishable() only decides card versus receipt.
func TestFreezeOnCoversEveryStatusAndKind(t *testing.T) {
	for _, tc := range []struct {
		name, kind, status string
		hasDiff            bool
		prURL              string
		validatedDiagnosis bool
		wantAction         string
		wantNotEligible    bool
	}{
		{name: "error awaiting approval with diff", kind: "error", status: "awaiting_approval",
			hasDiff: true, validatedDiagnosis: true, wantAction: "Approve the proposed fix."},
		{name: "error awaiting approval without diff", kind: "error", status: "awaiting_approval",
			validatedDiagnosis: true, wantAction: "Review the investigation."},
		{name: "friction awaiting approval without diff", kind: "friction", status: "awaiting_approval",
			validatedDiagnosis: true, wantAction: "Review the investigation."},
		{name: "friction needs human with diff", kind: "friction", status: "needs_human",
			hasDiff: true, wantAction: "Review the investigation."},
		{name: "error needs human without diagnosis", kind: "error", status: "needs_human",
			wantAction: "Review the investigation.", wantNotEligible: true},
		{name: "error pr created with url", kind: "error", status: "pr_created",
			prURL: "https://github.com/acme/shop/pull/7", wantAction: "Review the fix PR."},
		{name: "friction pr draft with url", kind: "friction", status: "pr_draft",
			prURL: "https://github.com/acme/shop/pull/8", wantAction: "Review the fix PR."},
		{name: "error pr created without url", kind: "error", status: "pr_created",
			wantAction: "Review the issue.", wantNotEligible: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now().UTC().Truncate(time.Second)
			pool, fixture := onCardFixture(t, now)
			groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, tc.kind, tc.status,
				tc.hasDiff, tc.prURL, "The checkout control does not submit.", now.Add(-time.Hour))
			if tc.validatedDiagnosis {
				seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))
			}
			_, candidates, err := FreezeCandidates(context.Background(), pool, fixture.ProjectID, now)
			if err != nil {
				t.Fatal(err)
			}
			if len(candidates) != 1 || candidates[0].ErrorGroupID != groupID {
				t.Fatalf("incident never reached the digest: %+v", candidates)
			}
			candidate := candidates[0]
			if candidate.ValidAction != tc.wantAction {
				t.Errorf("action = %q, want %q", candidate.ValidAction, tc.wantAction)
			}
			if candidate.NotCardEligible != tc.wantNotEligible {
				t.Errorf("notCardEligible = %v, want %v", candidate.NotCardEligible, tc.wantNotEligible)
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
	delivered := len(payload.GeneratedCards) + len(payload.ReceiptItems)
	if delivered != len(statuses) {
		t.Fatalf("delivered %d of %d actionable incidents: cards=%+v receipts=%+v",
			delivered, len(statuses), payload.GeneratedCards, payload.ReceiptItems)
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
		{name: "without saved diff", wantAction: "Review the investigation."},
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
	if candidates[0].ValidAction != "Review the fix PR." || candidates[0].NotCardEligible {
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
			Action: next[0].CachedCard.Action, Label: next[0].Label,
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

// TestValidateOnNeverEligibleRendersReceiptWithoutAuthoring covers the
// card-versus-receipt split: no card is authored, and the incident still ships.
func TestValidateOnNeverEligibleRendersReceiptWithoutAuthoring(t *testing.T) {
	for _, tc := range []struct {
		name, kind, status string
	}{
		// publishable() refuses an authored card without a validated diagnosis.
		{name: "no validated diagnosis", kind: "friction", status: "awaiting_approval"},
		// A PR status with no URL is an inconsistent state. It still awaits a
		// human, so it renders — as a receipt, with the "Review the issue."
		// action and a diagnostic log.
		{name: "pr status without a url", kind: "error", status: "pr_created"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			neverEligibleRendersReceipt(t, tc.kind, tc.status)
		})
	}
}

func neverEligibleRendersReceipt(t *testing.T, kind, status string) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, kind, status,
		false, "", "", now.Add(-time.Hour))

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	if !candidates[0].NotCardEligible {
		t.Fatalf("candidate without a validated diagnosis was card-eligible: %+v", candidates[0])
	}
	var freezeRenderMode, receiptReason string
	if err := pool.QueryRow(ctx, `SELECT COALESCE(render_mode,''),COALESCE(details->>'receipt_reason','')
		FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`,
		runID, groupID).Scan(&freezeRenderMode, &receiptReason); err != nil {
		t.Fatal(err)
	}
	if freezeRenderMode != "receipt_fallback" || receiptReason != "never_card_eligible" {
		t.Fatalf("freeze ledger render=%q reason=%q", freezeRenderMode, receiptReason)
	}

	writeOnCardPayload(t, pool, runID, candidates)
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, runID).Digest
	if len(payload.GeneratedCards) != 0 || len(payload.ReceiptItems) != 1 {
		t.Fatalf("never-eligible incident cards=%+v receipts=%+v", payload.GeneratedCards, payload.ReceiptItems)
	}
	if payload.ReceiptItems[0].IncidentID != groupID {
		t.Fatalf("receipt = %+v", payload.ReceiptItems[0])
	}
	var cacheRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM digest_card_copy WHERE error_group_id=$1`,
		groupID).Scan(&cacheRows); err != nil {
		t.Fatal(err)
	}
	if cacheRows != 0 {
		t.Fatalf("never-eligible incident cached %d authored cards", cacheRows)
	}
	// Day two still shows it: nothing about being receipt-only removes it.
	_, second, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now.Add(24*time.Hour))
	if err != nil || len(second) != 1 || second[0].ErrorGroupID != groupID {
		t.Fatalf("receipt-only incident stopped repeating: %+v err=%v", second, err)
	}
}

// TestFreezeOnCapsAtTheRendererLimitAndRendersOverflow: the ON lane's bound is
// the renderer's real Slack constraint (notify.DigestV4CardCap), not the
// receipts-era five, and every incident past it reaches the reader as the
// overflow line instead of being invisible.
func TestFreezeOnCapsAtTheRendererLimitAndRendersOverflow(t *testing.T) {
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
	if payload.Digest.OverflowCount+payload.Digest.ReceiptOverflow != extra {
		t.Fatalf("payload overflow = %d+%d, want %d", payload.Digest.OverflowCount,
			payload.Digest.ReceiptOverflow, extra)
	}
	body, _, err := notify.FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "And 3 more on the dashboard") {
		t.Fatalf("Slack message has no overflow line: %s", body)
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

// TestFreezeOnRanksCardEligibleIncidentsAboveReceiptOnlyOnes: the card lane's
// scarce resource is an authored card, so an incident that can earn one wins a
// slot over a higher-impact incident that can only ever render its mechanical
// receipt. The receipt-only incident that loses the slot is still ledgered, so
// it reaches the reader through the overflow line rather than vanishing.
func TestFreezeOnRanksCardEligibleIncidentsAboveReceiptOnlyOnes(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()

	// Nine receipt-only incidents: needs_human, no saved diff and no validated
	// diagnosis, so publishable() refuses each of them an authored card. They
	// carry the whole impact range, and the oldest of them is the least
	// impactful, so it takes the oldest-waiter slot in either ranking.
	receiptOnly := make([]string, 0, notify.DigestV4CardCap)
	for i := 0; i < notify.DigestV4CardCap; i++ {
		groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "needs_human",
			false, "", "", now.Add(-time.Duration(i+2)*time.Hour))
		if _, err := pool.Exec(ctx, `UPDATE error_groups SET impact_visits=$2 WHERE id=$1`,
			groupID, 100-i); err != nil {
			t.Fatal(err)
		}
		receiptOnly = append(receiptOnly, groupID)
	}
	// One card-eligible incident: the least impactful and the most recently
	// waiting, so pure impact ranking would cap it out of the digest entirely.
	eligible := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "needs_human",
		false, "", "The checkout control does not submit.", now.Add(-time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, eligible, now.Add(-time.Hour))
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET impact_visits=1 WHERE id=$1`, eligible); err != nil {
		t.Fatal(err)
	}

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != notify.DigestV4CardCap {
		t.Fatalf("frozen candidates = %d, want the cap %d", len(candidates), notify.DigestV4CardCap)
	}
	frozen := make(map[string]Candidate, len(candidates))
	for _, candidate := range candidates {
		frozen[candidate.ErrorGroupID] = candidate
	}
	if _, ok := frozen[eligible]; !ok {
		t.Fatalf("the card-eligible incident lost its slot to higher-impact receipt-only ones: %+v", candidates)
	}
	if frozen[eligible].NotCardEligible {
		t.Fatalf("the diagnosed incident was frozen as receipt-only: %+v", frozen[eligible])
	}

	// Exactly one receipt-only incident lost the slot, and it is accounted for.
	capped := make([]string, 0, 1)
	for _, groupID := range receiptOnly {
		if _, ok := frozen[groupID]; ok {
			continue
		}
		var outcome, reason string
		if err := pool.QueryRow(ctx, `SELECT outcome,primary_reason_code
			FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`,
			runID, groupID).Scan(&outcome, &reason); err != nil {
			t.Fatalf("displaced incident %s has no ledger row: %v", groupID, err)
		}
		if outcome != "excluded" || reason != reasonCappedOverflow {
			t.Fatalf("displaced incident %s ledger = %s/%s", groupID, outcome, reason)
		}
		capped = append(capped, groupID)
	}
	if len(capped) != 1 {
		t.Fatalf("displaced %d receipt-only incidents, want 1: %v", len(capped), capped)
	}

	writeOnCardPayload(t, pool, runID, candidates)
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, runID).Digest
	if len(payload.GeneratedCards) != 1 || payload.GeneratedCards[0].IncidentID != eligible {
		t.Fatalf("authored cards = %+v, want only the eligible incident", payload.GeneratedCards)
	}
	if len(payload.ReceiptItems) != notify.DigestV4CardCap-1 {
		t.Fatalf("receipts = %d, want %d", len(payload.ReceiptItems), notify.DigestV4CardCap-1)
	}
}

// TestValidateOnKeepsAnIncidentWhoseAskChangedAfterFreeze: migration 066 resets
// actionable_since whenever the action class changes, so a normal minutes-long
// gap between freeze and validate (a PR opening, a diff arriving) moved the
// spell. Treating that like "left the actionable set" dropped a still-waiting
// incident with no card, no receipt and no overflow credit.
func TestValidateOnKeepsAnIncidentWhoseAskChangedAfterFreeze(t *testing.T) {
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
	payload := renderedEvent(t, pool, runID).Digest
	delivered := false
	for _, item := range payload.ReceiptItems {
		if item.IncidentID == groupID {
			delivered = true
			if item.ReceiptState != "pr_open" {
				t.Errorf("receipt state = %q, want the live pr_open state", item.ReceiptState)
			}
		}
	}
	for _, card := range payload.GeneratedCards {
		if card.IncidentID == groupID {
			delivered = true
		}
	}
	if !delivered && payload.OverflowCount+payload.ReceiptOverflow == 0 {
		t.Fatalf("an incident that only changed its ask vanished: %+v", payload)
	}
	if !delivered {
		t.Fatalf("incident was only counted as overflow, not rendered: %+v", payload)
	}
}

// TestFreezeOnSkipsAnActionableRowWithNoWaitingAge: an actionable row whose
// actionable_since is NULL used to be frozen as a non-actionable candidate,
// which sent validation down the episode path with an empty episode id. The
// resulting uuid encode error is not pgx.ErrNoRows, so it degraded the entire
// ON card section for one malformed row.
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
		t.Fatalf("one malformed row degraded the whole card section: %+v", payload)
	}
	if payload.DeliveryAlert != "" {
		t.Fatalf("section degraded with alert %q", payload.DeliveryAlert)
	}
}
