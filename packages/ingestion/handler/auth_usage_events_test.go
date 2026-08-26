package handler

import (
	"testing"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/usageevents"
)

func TestProvisioningUsageEventsDistinguishSignupLoginAndVerification(t *testing.T) {
	var events []string
	restore := usageevents.SetSinkForTest(func(event string, _ map[string]string) {
		events = append(events, event)
	})
	t.Cleanup(restore)
	if err := usageevents.Configure("https://hooks.example/T/B/x"); err != nil {
		t.Fatal(err)
	}
	identity := auth.Identity{Provider: "workos", Email: "user@example.com"}

	emitProvisioningUsage(identity, "user-1", "org-1", true, false)
	if len(events) != 1 || events[0] != "user_signed_up" {
		t.Fatalf("signup events = %v", events)
	}
	emitProvisioningUsage(identity, "user-1", "org-1", false, true)
	if len(events) != 2 || events[1] != "user_logged_in" {
		t.Fatalf("login events = %v", events)
	}
	emitProvisioningUsage(identity, "user-1", "org-1", false, false)
	if len(events) != 2 {
		t.Fatalf("non-interactive verification emitted: %v", events)
	}
}
