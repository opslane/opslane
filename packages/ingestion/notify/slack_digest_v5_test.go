package notify

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestKnownProblemsDigestSingleListAndOneButton(t *testing.T) {
	p := EventPayload{Project: ProjectRef{ID: "project", Name: "Shop"}, DashboardURL: "https://app.example", Digest: &DigestPayload{SchemaVersion: 5, Date: "2026-09-12", GeneratedCards: []GeneratedDigestCard{{IncidentID: "incident", TicketID: "ticket", Kind: "friction", Title: "Payment stalls", Copy: "The payment control ignores clicks.", Steps: "Open payment and click Pay.", Why: "The handler returns early.", Coverage: .5, VerifiedUsers: 2, VerifiedSessions: 4, Accounts: []string{"Acme"}, Action: "Create fix PR", ActionURL: "https://app.example/issues/incident?fixIntent=opaque.payload", ReplayURL: "https://app.example/sessions/session"}}, MergedThisWeek: []DigestPRMerged{{Title: "Save fixed", PRURL: "https://github.com/acme/shop/pull/4"}}}}
	body, _, err := formatSlackDigest(p)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"2 users · 4 sessions this week", "Create fix PR", "Merged this week", "Open payment and click Pay.", "Why:"} {
		if !strings.Contains(string(body), expected) {
			t.Errorf("missing %q: %s", expected, body)
		}
	}
	for _, bad := range []string{"Needs you", "Needs a decision", "Session intelligence", "visits", "recovered"} {
		if strings.Contains(string(body), bad) {
			t.Errorf("legacy %q: %s", bad, body)
		}
	}
	var message struct {
		Blocks []struct {
			Elements []struct {
				Type string `json:"type"`
			} `json:"elements"`
		} `json:"blocks"`
	}
	if err := json.Unmarshal(body, &message); err != nil {
		t.Fatal(err)
	}
	buttons := 0
	for _, b := range message.Blocks {
		for _, e := range b.Elements {
			if e.Type == "button" {
				buttons++
			}
		}
	}
	if buttons != 1 {
		t.Fatalf("buttons=%d", buttons)
	}
}
