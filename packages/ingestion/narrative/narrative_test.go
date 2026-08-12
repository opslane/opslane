package narrative_test

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/opslane/opslane/packages/ingestion/narrative"
)

func TestStory(t *testing.T) {
	i := func(v int64) *int64 { return &v }
	tests := []struct {
		name string
		occ  int64
		imp  narrative.Impact
		want string
	}{
		{"blocked", 12, narrative.Impact{Class: "blocked", Visits: i(3), Recovered: i(0)}, "12 crashes across 3 visits, no visit recovered"},
		{"degraded", 12, narrative.Impact{Class: "degraded", Visits: i(3), Recovered: i(1)}, "12 crashes across 3 visits, 1 of 3 visits recovered"},
		{"invisible", 12, narrative.Impact{Class: "invisible", Visits: i(3), Recovered: i(3)}, "12 crashes across 3 visits, all 3 visits recovered"},
		{"null impact", 12, narrative.Impact{}, "12 crashes; recording impact unavailable"},
		{"singular", 1, narrative.Impact{Class: "blocked", Visits: i(1), Recovered: i(0)}, "1 crash across 1 visit, no visit recovered"},
		{"bad class", 12, narrative.Impact{Class: "bogus", Visits: i(3), Recovered: i(0)}, "12 crashes; recording impact unavailable"},
		{"too many recovered", 12, narrative.Impact{Class: "blocked", Visits: i(3), Recovered: i(5)}, "12 crashes; recording impact unavailable"},
		{"negative visits", 12, narrative.Impact{Class: "blocked", Visits: i(-1), Recovered: i(0)}, "12 crashes; recording impact unavailable"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := narrative.Story("crash", "crashes", tt.occ, tt.imp); got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestReceiptLine(t *testing.T) {
	wants := map[string]string{
		"pr_open":                  "Fix PR ready for review.",
		"attempt_failed_with_diff": "Fix attempt failed its checks; saved diff and report on the issue page.",
		"attempt_failed_no_diff":   "Fix attempt failed before producing a change; investigation report on the issue page.",
		"report_ready":             "Investigation report ready.",
	}
	for state, want := range wants {
		got, ok := narrative.ReceiptLine(state)
		if !ok || got != want || strings.Contains(got, "://") {
			t.Errorf("%s: got %q, %v", state, got, ok)
		}
	}
	if _, ok := narrative.ReceiptLine("future"); ok {
		t.Fatal("unknown receipt state accepted")
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
