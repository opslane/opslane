package narrative_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/opslane/opslane/packages/ingestion/narrative"
)

func TestStory(t *testing.T) {
	type vector struct {
		Name         string `json:"name"`
		NounSingular string `json:"nounSingular"`
		NounPlural   string `json:"nounPlural"`
		Occurrences  int64  `json:"occurrences"`
		Impact       struct {
			Class     *string `json:"class"`
			Visits    *int64  `json:"visits"`
			Recovered *int64  `json:"recovered"`
		} `json:"impact"`
		Want string `json:"want"`
	}
	_, filename, _, _ := runtime.Caller(0)
	body, err := os.ReadFile(filepath.Join(filepath.Dir(filename), "../../../test-fixtures/story-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var tests []vector
	if err := json.Unmarshal(body, &tests); err != nil {
		t.Fatal(err)
	}
	for _, tt := range tests {
		t.Run(tt.Name, func(t *testing.T) {
			class := ""
			if tt.Impact.Class != nil {
				class = *tt.Impact.Class
			}
			impact := narrative.Impact{Class: class, Visits: tt.Impact.Visits, Recovered: tt.Impact.Recovered}
			if got := narrative.Story(tt.NounSingular, tt.NounPlural, tt.Occurrences, impact); got != tt.Want {
				t.Fatalf("got %q, want %q", got, tt.Want)
			}
			if strings.Contains(tt.Want, "unavailable") == impact.Valid() {
				t.Fatalf("Valid()=%v disagrees with story %q", impact.Valid(), tt.Want)
			}
		})
	}
}

func TestPageReceiptLine(t *testing.T) {
	wants := map[string]string{
		"pr_open":                  "Fix PR ready for review.",
		"pr_open_draft":            "Draft fix PR opened; verification is pending review.",
		"attempt_failed_with_diff": "Fix attempt failed its checks; the working diff was saved.",
		"attempt_failed_no_diff":   "We tried a fix and couldn't produce a working change.",
		"report_ready":             "We found the cause.",
		"report_ready_no_cause":    "We could not establish a cause; what we found is on this page.",
	}
	for state, want := range wants {
		got, ok := narrative.PageReceiptLine(state)
		if !ok || got != want || strings.Contains(got, "://") || strings.Contains(strings.ToLower(got), "below") || strings.Contains(strings.ToLower(got), "attached") {
			t.Errorf("%s: got %q, %v", state, got, ok)
		}
	}
	if _, ok := narrative.PageReceiptLine("future"); ok {
		t.Fatal("unknown page receipt state accepted")
	}
}

func TestReceiptLine(t *testing.T) {
	wants := map[string]string{
		"pr_open":                  "Fix PR ready for review.",
		"pr_draft":                 "A draft fix PR needs your review.",
		"awaiting_approval":        "A fix is written and needs your approval.",
		"attempt_failed_with_diff": "Fix attempt failed its checks; saved diff and report on the issue page.",
		"attempt_failed_no_diff":   "We tried a fix and couldn't produce a working change; details on the issue page.",
		"report_ready":             "We could not establish a cause. Details in the issue.",
	}
	for state, want := range wants {
		got, ok := narrative.ReceiptLine(state, false)
		if !ok || got != want || strings.Contains(got, "://") {
			t.Errorf("%s: got %q, %v", state, got, ok)
		}
	}
	if _, ok := narrative.ReceiptLine("future", false); ok {
		t.Fatal("unknown receipt state accepted")
	}
}

// A report_ready card that states a cause must not also deny one. The digest
// publishes report_ready only when the diagnosis was validated, so this is the
// branch every published card of that state actually takes.
func TestReceiptLineDoesNotDenyAnEstablishedCause(t *testing.T) {
	got, ok := narrative.ReceiptLine("report_ready", true)
	if !ok {
		t.Fatal("report_ready with a cause must render")
	}
	const want = "Cause found; no fix opened yet. Details in the issue."
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if strings.Contains(strings.ToLower(got), "could not establish") {
		t.Errorf("card states a cause and denies one in the same breath: %q", got)
	}
}

func TestTriageAndFooters(t *testing.T) {
	if got := narrative.TriageLine(2, 3, false); got != "2 fix PRs awaiting review, 3 issues need a decision." {
		t.Fatal(got)
	}
	if got := narrative.TriageLine(0, 0, true); got != "No fix PRs awaiting review, no issues need a decision, nothing else needs you today." {
		t.Fatal(got)
	}
	if got := narrative.TriageLine(1, 1, false); got != "1 fix PR awaiting review, 1 issue needs a decision." {
		t.Fatal(got)
	}
	if got := narrative.HeldBackLine(1); got != "Held back: 1 item without a verified receipt yet." {
		t.Fatal(got)
	}
	if got := narrative.OverflowLine(4); got != "4 more receipts ranked below these — open the dashboard for the full list." {
		t.Fatal(got)
	}
}

func TestSanitizeExcerpt(t *testing.T) {
	tests := []struct{ in, want string }{
		{"see https://app.customer.com/checkout?step=2 for", "see /checkout?step=2 for"},
		{"mail bob@x.co", "mail [REDACTED]"},
		{"a\nb\tc", "a b c"},
		{"`code` *bold* _i_ ~s~", "'code' 'bold' 'i' 's'"},
		// Markers become apostrophes, never deletions: deletion would fuse the
		// tokens around snake_case identifiers in customer copy.
		{"user_profile_id is nil", "user'profile'id is nil"},
		{"***", "'''"},
		{"", ""},
	}
	for _, tt := range tests {
		if got := narrative.SanitizeExcerpt(tt.in, 300); got != tt.want {
			t.Errorf("%q: got %q, want %q", tt.in, got, tt.want)
		}
	}
	if got := narrative.SanitizeExcerpt("key sk_live_abc123 leaked", 300); !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("secret survived: %q", got)
	}
	got := narrative.SanitizeExcerpt(strings.Repeat("é", 400), 300)
	if utf8.RuneCountInString(got) != 300 || !strings.HasSuffix(got, "…") {
		t.Fatalf("bad rune truncation: %d %q", utf8.RuneCountInString(got), got)
	}
}
