package digest

import (
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

func TestTicketFixActionURL(t *testing.T) {
	secret := []byte("digest-action-signing-test-secret-32-bytes")
	now := time.Now()
	target, err := ticketFixActionURL("https://app.example/opslane?discard=yes#fragment", "project", "group", "ticket", 2, "attempt", secret, now)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Path != "/opslane/issues/group" || parsed.Query().Get("project_id") != "project" || parsed.Query().Get("discard") != "" || parsed.Fragment != "" {
		t.Fatalf("wrong URL %s", target)
	}
	claims, err := auth.VerifyTicketFixIntent(secret, parsed.Query().Get("fixIntent"), now)
	if err != nil || claims.LatestAttemptID != "attempt" || claims.Generation != 2 {
		t.Fatalf("claims=%+v error=%v", claims, err)
	}
	// The actual Slack button URL must survive redaction unchanged.
	body, _, err := notify.FormatSlack(notify.EventPayload{EventType: "digest.daily", Project: notify.ProjectRef{ID: "project", Name: "Shop"}, DashboardURL: "https://app.example", Digest: &notify.DigestPayload{SchemaVersion: 5, GeneratedCards: []notify.GeneratedDigestCard{{IncidentID: "group", TicketID: "ticket", Title: "Save stalls", Copy: "Save has no effect.", Action: "Create fix PR", ActionURL: target}}}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), parsed.Query().Get("fixIntent")) {
		t.Fatalf("Slack redacted signed intent: %s", body)
	}
	for _, base := range []string{"", "http://localhost:8232", "https://user:secret@app.example", "/relative"} {
		got, err := ticketFixActionURL(base, "project", "group", "ticket", 1, "", secret, now)
		if err != nil || got != "" {
			t.Fatalf("invalid public base %q accepted: %q %v", base, got, err)
		}
	}
}
