package notify_test

import (
	"fmt"
	"strings"
	"testing"

	mcpformat "github.com/opslane/opslane/packages/ingestion/mcp"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

func TestDigestChannelParity(t *testing.T) {
	knownIDs := []string{"i-card", "i-receipt"}
	fixtures := []struct {
		name   string
		digest notify.DigestPayload
	}{
		{name: "cards-only", digest: notify.DigestPayload{SchemaVersion: 4, Date: "2026-08-27", GeneratedCards: []notify.GeneratedDigestCard{{IncidentID: "i-card", Title: "New issue", Label: "new", Outcome: "needs_human", Copy: "It broke.", Action: "Decide."}}}},
		{name: "receipts-only", digest: notify.DigestPayload{SchemaVersion: 4, Date: "2026-08-27", ReceiptItems: []notify.ReceiptItem{{IncidentID: "i-receipt", Kind: "error", Title: "Waiting issue", ReceiptState: "awaiting_approval", HasValidatedDiagnosis: true}}}},
		{name: "mixed", digest: notify.DigestPayload{SchemaVersion: 4, Date: "2026-08-27", GeneratedCards: []notify.GeneratedDigestCard{{IncidentID: "i-card", Title: "New issue", Label: "new", Outcome: "needs_human", Copy: "It broke.", Action: "Decide."}}, ReceiptItems: []notify.ReceiptItem{{IncidentID: "i-receipt", Kind: "error", Title: "Waiting issue", ReceiptState: "awaiting_approval", HasValidatedDiagnosis: true}}}},
		{name: "degraded", digest: notify.DigestPayload{SchemaVersion: 4, Date: "2026-08-27", DeliveryAlert: "actionable lane degraded"}},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			payload := notify.EventPayload{Version: 1, EventType: "digest.daily", Project: notify.ProjectRef{ID: "p", Name: "Project"}, DashboardURL: "https://app.example.com", Digest: &fixture.digest}
			view := notify.BuildDigestView(payload.Digest)
			expected := make(map[string]bool)
			for _, card := range view.Cards {
				expected[card.IncidentID] = true
			}
			for _, receipt := range view.Receipts {
				expected[receipt.IncidentID] = true
			}
			slackBody, _, err := notify.FormatSlack(payload)
			if err != nil {
				t.Fatal(err)
			}
			date := fixture.digest.Date
			mcpText := mcpformat.FormatDigest(mcpformat.DigestInput{RunDate: &date, View: view, ProjectLabel: "p"})
			for _, id := range knownIDs {
				for channel, body := range map[string]string{"Slack": string(slackBody), "MCP": mcpText} {
					if strings.Contains(body, id) != expected[id] {
						t.Fatalf("%s membership for %s disagrees with view: %s", channel, id, body)
					}
				}
			}
		})
	}
}

func TestDigestChannelParityDeclaresSlackCardCap(t *testing.T) {
	cards := make([]notify.GeneratedDigestCard, notify.DigestV4CardCap+1)
	for i := range cards {
		cards[i] = notify.GeneratedDigestCard{IncidentID: fmt.Sprintf("cap-%d", i), Title: "Issue", Outcome: "needs_human", Copy: "It broke.", Action: "Decide."}
	}
	digest := &notify.DigestPayload{SchemaVersion: 4, Date: "2026-08-27", GeneratedCards: cards}
	payload := notify.EventPayload{Version: 1, EventType: "digest.daily", Project: notify.ProjectRef{Name: "Project"}, DashboardURL: "https://app.example.com", Digest: digest}
	slackBody, _, err := notify.FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	body := string(slackBody)
	for i := 0; i < notify.DigestV4CardCap; i++ {
		if !strings.Contains(body, cards[i].IncidentID) {
			t.Fatalf("Slack omitted capped card %s", cards[i].IncidentID)
		}
	}
	if strings.Contains(body, cards[len(cards)-1].IncidentID) || !strings.Contains(body, "And 1 more") {
		t.Fatalf("Slack cap/overflow contract changed: %s", body)
	}
	if len(notify.BuildDigestView(digest).Cards) != len(cards) {
		t.Fatal("view applied a channel-specific cap")
	}
}
