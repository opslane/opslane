package notify

import (
	"encoding/json"
	"fmt"
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

func TestKnownProblemsMergedFooterPreservesWholeLinksWithinSlackBudget(t *testing.T) {
	for _, count := range []int{50, 1500} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			p := EventPayload{Project: ProjectRef{ID: "project", Name: "Shop"}, Digest: &DigestPayload{SchemaVersion: 5}}
			for i := 0; i < count; i++ {
				p.Digest.MergedThisWeek = append(p.Digest.MergedThisWeek, DigestPRMerged{Title: fmt.Sprintf("Checkout problem %d repaired without disrupting the current workflow", i), PRURL: fmt.Sprintf("https://github.com/acme/shop/pull/%d", i+1)})
			}
			body, _, err := formatSlackDigest(p)
			if err != nil {
				t.Fatal(err)
			}
			var message struct {
				Blocks []struct {
					Text struct {
						Text string `json:"text"`
					} `json:"text"`
				} `json:"blocks"`
			}
			if err := json.Unmarshal(body, &message); err != nil {
				t.Fatal(err)
			}
			if len(message.Blocks) > 50 {
				t.Fatalf("Slack blocks=%d", len(message.Blocks))
			}
			links := 0
			for _, block := range message.Blocks {
				if len([]rune(block.Text.Text)) > 2900 {
					t.Fatal("oversized section")
				}
				if strings.Count(block.Text.Text, "<https://") != strings.Count(block.Text.Text, ">") {
					t.Fatalf("truncated markup: %s", block.Text.Text)
				}
				links += strings.Count(block.Text.Text, "<https://github.com/acme/shop/pull/")
			}
			if count == 50 && links != count {
				t.Fatalf("merged links=%d want %d", links, count)
			}
			if count == 1500 && (links == count || !strings.Contains(string(body), fmt.Sprintf("And %d more merged PRs", count-links))) {
				t.Fatalf("overflow not explicit: links=%d body=%s", links, body)
			}
		})
	}
}
