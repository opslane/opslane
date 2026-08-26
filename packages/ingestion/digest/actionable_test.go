package digest

import (
	"reflect"
	"testing"
	"time"
)

func TestEvaluateActionableEligibility(t *testing.T) {
	now := time.Date(2026, 8, 26, 8, 0, 0, 0, time.UTC)
	past := now.Add(-time.Hour)
	future := now.Add(time.Hour)
	base := actionableCandidate{
		GroupID: "friction", Kind: "friction", Status: "awaiting_approval",
		Title: "Dead click", HasValidatedDiagnosis: true, ActionableSince: &past,
	}
	tests := []struct {
		name   string
		change func(*actionableCandidate)
		frozen map[string]bool
		want   string
	}{
		{name: "friction with validated diagnosis is included", want: "included"},
		{name: "future snooze excludes", change: func(c *actionableCandidate) { c.SnoozedUntil = &future }, want: "snoozed"},
		{name: "expired snooze includes", change: func(c *actionableCandidate) { c.SnoozedUntil = &past }, want: "included"},
		{name: "error lane must be eligible", change: func(c *actionableCandidate) { c.Kind = "error" }, want: "error_lane_ineligible"},
		{name: "candidate must be publishable", change: func(c *actionableCandidate) { c.HasValidatedDiagnosis = false }, want: "not_publishable"},
		{name: "frozen lane owns duplicate", frozen: map[string]bool{"friction": true}, want: "frozen_lane_owns"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			candidate := base
			if tc.change != nil {
				tc.change(&candidate)
			}
			eval := evaluateActionable([]actionableCandidate{candidate}, tc.frozen, now)
			if tc.want == "included" {
				if len(eval.Included) != 1 || len(eval.Excluded) != 0 {
					t.Fatalf("evaluation = %+v", eval)
				}
				return
			}
			if len(eval.Included) != 0 || eval.Excluded[candidate.GroupID] != tc.want {
				t.Fatalf("evaluation = %+v, want %s", eval, tc.want)
			}
		})
	}
}

func TestEvaluateActionableSelectsFourByImpactPlusOldest(t *testing.T) {
	now := time.Date(2026, 8, 26, 8, 0, 0, 0, time.UTC)
	visits := []int64{70, 60, 50, 40, 30, 20, 10}
	candidates := make([]actionableCandidate, 0, len(visits))
	for i, impact := range visits {
		stamp := now.Add(-time.Duration(i+1) * 24 * time.Hour)
		value := impact
		candidates = append(candidates, actionableCandidate{
			GroupID: string(rune('a' + i)), Kind: "friction", Status: "needs_human",
			Title: "candidate", OccurrenceCount: int64(100 - i), ImpactVisits: &value,
			HasValidatedDiagnosis: true, ActionableSince: &stamp,
		})
	}

	eval := evaluateActionable(candidates, nil, now)
	got := make([]string, 0, len(eval.Included))
	for _, candidate := range eval.Included {
		got = append(got, candidate.GroupID)
	}
	if want := []string{"a", "b", "c", "d", "g"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("picked = %v, want %v", got, want)
	}
	if eval.Overflow != 2 || eval.Excluded["e"] != "capped_overflow" || eval.Excluded["f"] != "capped_overflow" {
		t.Fatalf("overflow evaluation = %+v", eval)
	}
}

func TestEvaluateActionableIsDeterministicForUnorderedInput(t *testing.T) {
	now := time.Date(2026, 8, 26, 8, 0, 0, 0, time.UTC)
	impact := int64(5)
	candidates := []actionableCandidate{
		{GroupID: "c", Kind: "friction", Status: "needs_human", OccurrenceCount: 2, ImpactVisits: &impact, HasValidatedDiagnosis: true},
		{GroupID: "a", Kind: "friction", Status: "needs_human", OccurrenceCount: 3, ImpactVisits: &impact, HasValidatedDiagnosis: true},
		{GroupID: "b", Kind: "friction", Status: "needs_human", OccurrenceCount: 3, ImpactVisits: &impact, HasValidatedDiagnosis: true},
	}
	first := evaluateActionable(candidates, nil, now)
	second := evaluateActionable(candidates, nil, now)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("same input produced different evaluations:\n%+v\n%+v", first, second)
	}
	got := []string{first.Included[0].GroupID, first.Included[1].GroupID, first.Included[2].GroupID}
	if want := []string{"a", "b", "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("deterministic order = %v, want %v", got, want)
	}
}

func TestSelectActionableFallsBackToFifthByImpactWithoutAgeStamps(t *testing.T) {
	candidates := make([]actionableCandidate, 6)
	for i := range candidates {
		impact := int64(6 - i)
		candidates[i] = actionableCandidate{GroupID: string(rune('a' + i)), ImpactVisits: &impact}
	}
	picked, overflow := selectActionable(candidates)
	if len(picked) != 5 || picked[4].GroupID != "e" || overflow != 1 {
		t.Fatalf("picked=%+v overflow=%d", picked, overflow)
	}
}

func TestReconcileActionableTripwire(t *testing.T) {
	impact := int64(5)
	candidate := actionableCandidate{GroupID: "g1", Kind: "friction", Status: "awaiting_approval", ImpactVisits: &impact}
	// Fully accounted: one included candidate, nothing pending.
	clean := evaluation{
		Included:   []actionableCandidate{candidate},
		Excluded:   map[string]string{},
		Candidates: []actionableCandidate{candidate},
	}
	if alert, err := reconcileActionable(clean); alert != "" || err != nil {
		t.Fatalf("clean evaluation flagged: alert=%q err=%v", alert, err)
	}
	// A reason outside knownReasonCodes trips the wire.
	other := actionableCandidate{GroupID: "g2", Kind: "friction", Status: "awaiting_approval"}
	drifted := evaluation{
		Included:   []actionableCandidate{candidate},
		Excluded:   map[string]string{"g2": "made_up_reason"},
		Candidates: []actionableCandidate{candidate, other},
	}
	alert, err := reconcileActionable(drifted)
	if err == nil || alert != "1 items are pending but could not be rendered" {
		t.Fatalf("drifted evaluation not flagged: alert=%q err=%v", alert, err)
	}
}

func TestToReceiptItemsRejectsUnsupportedCandidates(t *testing.T) {
	if _, err := toReceiptItems([]actionableCandidate{{GroupID: "g", Kind: "insight", Status: "awaiting_approval"}}); err == nil {
		t.Fatal("unsupported kind accepted")
	}
	if _, err := toReceiptItems([]actionableCandidate{{GroupID: "g", Kind: "friction", Status: "resolved"}}); err == nil {
		t.Fatal("unsupported status accepted")
	}
}
