package digest

import (
	"testing"

	"github.com/opslane/opslane/packages/ingestion/narrative"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

// publishable is the Go belt beneath the SQL projection, and its whole purpose
// is to disagree with the SQL if the two ever drift. Driving it through Build
// cannot test that: the SQL filters the same rows out first, so every arm here
// would stay green with the belt deleted. These call it directly.
func TestPublishableRequiresAnArtifactPerState(t *testing.T) {
	const prURL = "https://github.example/pr/1"
	tests := []struct {
		name      string
		item      notify.ReceiptItem
		validated bool
		want      bool
	}{
		{"open PR with a URL publishes", notify.ReceiptItem{ReceiptState: "pr_open", PRURL: prURL}, false, true},
		{"open PR without a URL is held back", notify.ReceiptItem{ReceiptState: "pr_open"}, true, false},
		{"draft PR with a URL publishes", notify.ReceiptItem{ReceiptState: "pr_draft", PRURL: prURL}, false, true},
		{"draft PR without a URL is held back", notify.ReceiptItem{ReceiptState: "pr_draft"}, true, false},
		{"failed attempt publishes on a saved diff", notify.ReceiptItem{ReceiptState: "attempt_failed_with_diff", HasSavedDiff: true}, false, true},
		{"failed attempt without a diff is held back", notify.ReceiptItem{ReceiptState: "attempt_failed_with_diff"}, true, false},
		{"failed attempt with no diff needs a diagnosis", notify.ReceiptItem{ReceiptState: "attempt_failed_no_diff"}, true, true},
		{"failed attempt with no diff and no diagnosis is held back", notify.ReceiptItem{ReceiptState: "attempt_failed_no_diff"}, false, false},
		{"report needs a diagnosis", notify.ReceiptItem{ReceiptState: "report_ready"}, true, true},
		{"report without a diagnosis is held back", notify.ReceiptItem{ReceiptState: "report_ready"}, false, false},
		{"approval needs a diagnosis", notify.ReceiptItem{ReceiptState: "awaiting_approval"}, true, true},
		{"approval without a diagnosis is held back", notify.ReceiptItem{ReceiptState: "awaiting_approval"}, false, false},
		{"an unknown state never publishes", notify.ReceiptItem{ReceiptState: "future_state", PRURL: prURL, HasSavedDiff: true}, true, false},
		{"placeholder prose is held back whatever the state", notify.ReceiptItem{ReceiptState: "pr_open", PRURL: prURL, RootCauseExcerpt: "TBD"}, true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := publishable(tt.item, tt.validated); got != tt.want {
				t.Errorf("publishable(%q, validated=%v) = %v, want %v",
					tt.item.ReceiptState, tt.validated, got, tt.want)
			}
		})
	}
}

// Every state receiptState can return must render a sentence, or the card is
// silently dropped at slack_digest.go with only a warning.
func TestEveryReceiptStateIsRenderable(t *testing.T) {
	for _, status := range []string{"pr_created", "pr_draft", "awaiting_approval", "needs_human", "investigated", "insight"} {
		for _, savedDiff := range []bool{false, true} {
			for _, fixAttempted := range []bool{false, true} {
				state := receiptState(status, savedDiff, fixAttempted)
				if state == "" {
					t.Errorf("status %q (savedDiff=%v fixAttempted=%v) produced an empty receipt state",
						status, savedDiff, fixAttempted)
				}
				if _, ok := narrative.ReceiptLine(state, true); !ok {
					t.Errorf("status %q (savedDiff=%v fixAttempted=%v) produced unrenderable state %q",
						status, savedDiff, fixAttempted, state)
				}
			}
		}
	}
}
