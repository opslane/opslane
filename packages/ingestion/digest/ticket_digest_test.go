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
