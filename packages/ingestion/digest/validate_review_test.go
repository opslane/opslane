package digest

import (
	"strings"
	"testing"
)

func groundingCard(title, copy, action string) writtenDigestCard {
	return writtenDigestCard{EpisodeID: "ep", Title: title, Copy: copy, Action: action, Label: "new"}
}

func groundingCandidate() Candidate {
	return Candidate{
		EpisodeID: "ep", Title: "Export crashed on a server 500", Summary: "Exports fail.",
		ValidAction: "Decide whether exports should retry.", RoutePurpose: "exporting reports",
		AffectedUsers: 18, OccurrenceCount: 34,
		Accounts: []string{"42Floors", "Initech"},
		PRURL:    "https://github.com/acme/shop/pull/77",
		Label:    "new", Outcome: "needs_human",
	}
}

func TestFirstUngroundedNumberReviewHardening(t *testing.T) {
	candidate := groundingCandidate()
	cases := []struct {
		name     string
		card     writtenDigestCard
		rejected string
	}{
		{"unicode digits cannot smuggle counts", groundingCard("t", "４０００ people were affected.", "a"), "４０００"},
		{"comma-grouped fact number is allowed", groundingCard("t", "34 people tried, and it failed 34 times.", "a"), ""},
		{"account-name digits are grounded", groundingCard("t", "42Floors could not export.", "a"), ""},
		{"pr number is grounded", groundingCard("t", "c", "Review PR 77 and merge it."), ""},
		{"status code from frozen title is grounded", groundingCard("t", "They got a server 500.", "a"), ""},
		{"an unsourced number still fails", groundingCard("t", "Around 123 people hit this.", "a"), "123"},
	}
	for _, tc := range cases {
		number, bad := firstUngroundedNumber(tc.card, candidate)
		if tc.rejected == "" && bad {
			t.Fatalf("%s: unexpectedly rejected %q", tc.name, number)
		}
		if tc.rejected != "" && (!bad || number != tc.rejected) {
			t.Fatalf("%s: want rejection of %q, got (%q, %v)", tc.name, tc.rejected, number, bad)
		}
	}
}

// The session counts are COALESCE-0 on error-kind candidates; whitelisting
// them there would silently ground the digit '0' on every card.
func TestSessionCountsGroundOnlyNarrativeCards(t *testing.T) {
	errorKind := groundingCandidate()
	if _, bad := firstUngroundedNumber(groundingCard("t", "0 customers have hit this since the fix.", "a"), errorKind); !bad {
		t.Fatal("error-kind candidate grounded the digit 0 via zero session counts")
	}
	sessionKind := groundingCandidate()
	sessionKind.ObservationQuote = "clicked the disabled export button repeatedly"
	sessionKind.SessionCount = 3
	sessionKind.IdentifiedCount = 0
	if number, bad := firstUngroundedNumber(groundingCard("t", "3 sessions hit this, 0 identified.", "a"), sessionKind); bad {
		t.Fatalf("narrative card counts should be grounded, rejected %q", number)
	}
}

func TestNormalizeProseNumbersCollapsesGroups(t *testing.T) {
	if got := normalizeProseNumbers("1,234,567 users"); got != "1234567 users" {
		t.Fatalf("got %q", got)
	}
}

func TestStripInvisibleRemovesFormatRunes(t *testing.T) {
	hidden := "needs_​human ‮detrever"
	cleaned := stripInvisible(hidden)
	if strings.ContainsRune(cleaned, '​') || strings.ContainsRune(cleaned, '‮') {
		t.Fatalf("format runes survived: %q", cleaned)
	}
	if !internalVocabulary.MatchString(cleaned) {
		t.Fatalf("vocabulary bypass: %q not caught after stripping", cleaned)
	}
}

func TestPRNumberFailurePaths(t *testing.T) {
	cases := map[string]int{
		"https://github.com/acme/shop/pull/42":           42,
		"https://github.com/acme/shop/pull/not-a-number": 0,
		"https://github.com/acme/shop/issues/42":         0,
		"://malformed":                                   0,
		"": 0,
	}
	for input, want := range cases {
		if got := prNumber(input); got != want {
			t.Fatalf("prNumber(%q) = %d, want %d", input, got, want)
		}
	}
}
