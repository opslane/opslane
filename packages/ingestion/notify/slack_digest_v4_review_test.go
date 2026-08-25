package notify

import (
	"encoding/json"
	"strings"
	"testing"
)

func renderV4(t *testing.T, digest *DigestPayload) []map[string]any {
	t.Helper()
	digest.SchemaVersion = 4
	body, _, err := formatSlackDigest(EventPayload{
		Version: 1, EventType: "digest.daily",
		Project:      ProjectRef{ID: "p1", Name: "Acme"},
		DashboardURL: "https://dash.example.com",
		Digest:       digest,
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	var decoded struct {
		Blocks []map[string]any `json:"blocks"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return decoded.Blocks
}

func TestFormatSlackDigestV4OmitsZeroUserCount(t *testing.T) {
	blocks := renderV4(t, &DigestPayload{
		Date: "2026-08-25",
		GeneratedCards: []GeneratedDigestCard{{
			EpisodeID: "ep1", IncidentID: "i1", Title: "Broken flow", Label: "new",
			Outcome: "needs_human", Copy: "Something failed.", Action: "Decide.",
			AffectedUsers: 0, Accounts: []string{"Globex"},
		}},
	})
	joined, _ := json.Marshal(blocks)
	if strings.Contains(string(joined), "0 users") {
		t.Fatalf("zero-user count rendered: %s", joined)
	}
	if !strings.Contains(string(joined), "👥 Globex") {
		t.Fatalf("accounts context missing: %s", joined)
	}
}

func TestFormatSlackDigestV4OverflowCountFromValidator(t *testing.T) {
	// The validator defers overflow cards and reports the count; the renderer
	// must surface it even though the payload itself carries only capped cards.
	cards := make([]GeneratedDigestCard, 0, DigestV4CardCap)
	for range DigestV4CardCap {
		cards = append(cards, GeneratedDigestCard{
			EpisodeID: "ep", IncidentID: "i", Title: "T", Label: "new",
			Outcome: "needs_human", Copy: "c", Action: "a", AffectedUsers: 1,
		})
	}
	blocks := renderV4(t, &DigestPayload{Date: "2026-08-25", GeneratedCards: cards, OverflowCount: 3})
	joined, _ := json.Marshal(blocks)
	if !strings.Contains(string(joined), "And 3 more on the dashboard") {
		t.Fatalf("validator overflow count not rendered: %s", joined)
	}
}
