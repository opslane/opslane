package handler

import (
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/usageevents"
)

func TestEmitFirstSDKEventOnlyForClaimedReceipt(t *testing.T) {
	var events []struct {
		name  string
		props map[string]string
	}
	restore := usageevents.SetSinkForTest(func(event string, props map[string]string) {
		events = append(events, struct {
			name  string
			props map[string]string
		}{event, props})
	})
	t.Cleanup(restore)
	if err := usageevents.Configure("https://hooks.example/T/B/x"); err != nil {
		t.Fatal(err)
	}

	emitFirstSDKEvent(&db.CaptureReceipt{
		FirstEvent: true, EnvironmentID: "env-1", EnvironmentAgeSeconds: 42,
	}, "project-1", "production")
	emitFirstSDKEvent(&db.CaptureReceipt{FirstEvent: false}, "project-1", "production")
	if len(events) != 1 || events[0].name != "sdk_first_event_received" {
		t.Fatalf("events = %+v", events)
	}
	props := events[0].props
	if props["project_id"] != "project-1" || props["environment_id"] != "env-1" ||
		props["environment_name"] != "production" || props["environment_age_s"] != "42" {
		t.Fatalf("props = %+v", props)
	}
}
