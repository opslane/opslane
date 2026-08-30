package mcp

import (
	"strings"
	"testing"
)

func TestFormatRelatedSeparatesArithmeticFromTheGuess(t *testing.T) {
	got := FormatRelated(RelatedInput{Message: "Error deleting Assets", IssueID: "7f78d3c3", AnchorFound: true, Totals: RelatedTotalsView{Occurrences: 94, People: 24, IssueCount: 18, FirstSeen: "2026-07-27", LastSeen: "2026-08-28", Issues: []RelatedIssueView{{ID: "6939a611", Occurrences: 24, People: 7, FirstSeen: "2026-07-29", LastSeen: "2026-08-03", Status: "resolved", Recurred: true}, {ID: "7f78d3c3", Occurrences: 11, People: 3, FirstSeen: "2026-08-27", LastSeen: "2026-08-28", Status: "needs_human"}}, Truncated: 16}})
	for _, want := range []string{"18 issues", "94 occurrences", "24 distinct people", "16 more not listed", "is a guess", "resolved, and a matching issue produced events afterwards", "<- this issue"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in:\n%s", want, got)
		}
	}
}
func TestFormatRelatedRefusesWithoutAnAnchor(t *testing.T) {
	got := FormatRelated(RelatedInput{IssueID: "x"})
	if !strings.Contains(got, "no anchor event") {
		t.Fatalf("got %s", got)
	}
}
func TestFormatRelatedStaysInsideThePayloadBudget(t *testing.T) {
	issues := make([]RelatedIssueView, 200)
	for i := range issues {
		issues[i] = RelatedIssueView{ID: strings.Repeat("a", 60), Occurrences: 1, People: 1, FirstSeen: "2026-07-27", LastSeen: "2026-07-27", Status: "needs_human"}
	}
	got := FormatRelated(RelatedInput{Message: strings.Repeat("m", 5000), AnchorFound: true, Totals: RelatedTotalsView{Issues: issues, IssueCount: 200}})
	if len([]byte(got)) > PayloadLimit || strings.Count(got, "<untrusted>") != strings.Count(got, "</untrusted>") {
		t.Fatalf("invalid payload size/fences")
	}
}
