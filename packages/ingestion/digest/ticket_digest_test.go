package digest

import (
	ingestiondb "github.com/opslane/opslane/packages/ingestion/db"
	"testing"
	"time"
)

func TestTicketCandidateGateAndActions(t *testing.T) {
	now := time.Now()
	source := actionableCandidate{GroupID: "ticket-group", Kind: "friction", Status: "fixing", ActionableSince: &now, TicketFacts: &ingestiondb.TicketDigestFacts{TicketID: "ticket", Generation: 1, LiveGeneration: 1, EvidenceVersion: 2, TicketStatus: "published", GroupStatus: "fixing", FixSubstate: "fixing", InvestigationStatus: "done", Coverage: .5, Steps: "Open the six-month view.", VerifiedUsers: 2, VerifiedSessions: 4}}
	cards, _, _ := selectOnCardCandidates([]actionableCandidate{source}, now)
	if len(cards) != 1 || cards[0].TicketID != "ticket" || cards[0].ValidAction != "Fix in progress" || cards[0].PromptVersion != 7 {
		t.Fatalf("cards=%+v", cards)
	}
	baseline := *source.TicketFacts
	for _, change := range []func(*ingestiondb.TicketDigestFacts){func(f *ingestiondb.TicketDigestFacts) { f.Coverage = .49 }, func(f *ingestiondb.TicketDigestFacts) { f.InvestigationStatus = "pending" }, func(f *ingestiondb.TicketDigestFacts) { f.FixSubstate = "resolved" }, func(f *ingestiondb.TicketDigestFacts) { f.LiveGeneration = 2 }} {
		copy := baseline
		change(&copy)
		source.TicketFacts = &copy
		cards, _, _ := selectOnCardCandidates([]actionableCandidate{source}, now)
		if len(cards) != 0 {
			t.Fatalf("ineligible ticket rendered: %+v", copy)
		}
	}
}

func TestTicketDigestGroundsBehaviorNumbersButNeverCustomerCounts(t *testing.T) {
	c := Candidate{PromptVersion: 7, TicketID: "ticket", Steps: "Open the six-month view", ConfirmedNotes: []string{"Clicked 3 times in the six-month view; three clicks were ignored"}}
	for _, tc := range []struct {
		copy   string
		reject bool
	}{{"The six-month view ignored 3 clicks.", false}, {"The six-month view affected 3 users.", true}, {"Three users could not finish.", true}, {"The view ignored 4 clicks.", true}, {"The view affected ３ users.", true}, {"Affected users: 3.", true}, {"The number of affected users is 3.", true}, {"Sessions affected = three.", true}, {"Users need 3 clicks.", false}} {
		_, reject := firstUngroundedNumber(writtenDigestCard{Copy: tc.copy}, c)
		if reject != tc.reject {
			t.Errorf("%q reject=%v", tc.copy, reject)
		}
	}
}

func TestTicketDigestDistinguishesCustomerNounPhrasesFromInteractionUnits(t *testing.T) {
	c := Candidate{PromptVersion: 7, TicketID: "ticket", VerifiedUsers: 1,
		ConfirmedNotes: []string{"Changing the month requires 3 clicks."}}
	for _, tc := range []struct {
		copy   string
		reject bool
	}{
		{"Affected users (3).", true},
		{"Users impacted: 3.", true},
		{"Impacted customers (3).", true},
		{"Sessions impacted = 3.", true},
		{"3 active users could not save.", true},
		{"3 unique paying customers could not save.", true},
		{"3 different users could not save.", true},
		{"3 frustrated users could not save.", true},
		{"It takes 3 clicks for 3 users to save.", true},
		{"(3) affected users could not save.", true},
		{"It takes 3 clicks for users to save.", false},
		{"Saving takes 3 clicks per user.", false},
		{"After 3 clicks, users can save.", false},
		{"Users need 3 clicks.", false},
		{"It takes 3 presses for customers to save.", false},
		{"It takes 3 taps for people to save.", false},
		{"It takes 3 seconds for users to save.", false},
	} {
		t.Run(tc.copy, func(t *testing.T) {
			_, reject := firstUngroundedNumber(writtenDigestCard{Copy: tc.copy}, c)
			if reject != tc.reject {
				t.Errorf("reject=%v, want %v", reject, tc.reject)
			}
		})
	}
}

// The worker's confirmer rejects the same provenance in notes, so a note that
// passed confirmation cannot sink its card at publication.
func TestProvenanceVocabularyMatchesConfirmerPattern(t *testing.T) {
	for _, tc := range []struct {
		text  string
		match bool
	}{
		{"The form stayed unchanged at line 12.", true},
		{"LINE  7 shows the click.", true},
		{"User clicked Update (L23-24).", true},
		{"The timelines agree.", true},
		{"Frames show the spinner.", true},
		{"Line items do not update.", false},
		{"The deadline 12 passed.", false},
		{"Online checkout stalls.", false},
	} {
		if got := provenanceVocabulary.MatchString(tc.text); got != tc.match {
			t.Errorf("%q match=%v, want %v", tc.text, got, tc.match)
		}
	}
}
