package notify

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/usageevents"
)

func TestDispatcherEmitsDigestDeliveredOnlyAfterSuccessfulCompletion(t *testing.T) {
	pool := testPool(t)
	cipher := testCipher(t)
	server := newScriptedServer(t, http.StatusOK, "")
	defer server.Close()
	seed := seedDelivery(t, pool, cipher, server.URL+"/hook")
	payload := EventPayload{
		Version: 1, EventType: "digest.daily", RunID: "run-1",
		Project: ProjectRef{ID: seed.ProjectID, Name: "Acme"},
		Digest:  &DigestPayload{Date: "2026-08-26", NeedsHumanBacklog: 3},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE outbound_events SET event_type='digest.daily', payload=$2 WHERE id=$1`, seed.EventID, raw,
	); err != nil {
		t.Fatal(err)
	}
	var events []map[string]string
	restore := usageevents.SetSinkForTest(func(event string, props map[string]string) {
		if event != "digest_delivered" {
			t.Fatalf("event = %q", event)
		}
		events = append(events, props)
	})
	t.Cleanup(restore)
	if err := usageevents.Configure("https://hooks.example/T/B/x"); err != nil {
		t.Fatal(err)
	}
	dispatcher := New(pool, cipher, Options{ExtraHosts: []string{serverHost(server)}})
	claims, err := dispatcher.claim(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	claim, ok := claimFor(claims, seed.DeliveryID)
	if !ok {
		t.Fatalf("delivery not claimed: %+v", claims)
	}
	dispatcher.deliverClaim(context.Background(), claim)
	if len(events) != 1 || events[0]["project_id"] != seed.ProjectID ||
		events[0]["run_id"] != "run-1" || events[0]["needs_human_backlog"] != "3" {
		t.Fatalf("events = %+v", events)
	}
}

func TestDispatcherDoesNotEmitDigestDeliveredForRetry(t *testing.T) {
	pool := testPool(t)
	cipher := testCipher(t)
	server := newScriptedServer(t, http.StatusInternalServerError, "")
	defer server.Close()
	seed := seedDelivery(t, pool, cipher, server.URL+"/hook")
	payload := EventPayload{
		Version: 1, EventType: "digest.daily", RunID: "run-retry",
		Project: ProjectRef{ID: seed.ProjectID, Name: "Acme"},
		Digest:  &DigestPayload{Date: "2026-08-26"},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE outbound_events SET event_type='digest.daily', payload=$2 WHERE id=$1`, seed.EventID, raw,
	); err != nil {
		t.Fatal(err)
	}
	events := 0
	restore := usageevents.SetSinkForTest(func(string, map[string]string) { events++ })
	t.Cleanup(restore)
	if err := usageevents.Configure("https://hooks.example/T/B/x"); err != nil {
		t.Fatal(err)
	}
	dispatcher := New(pool, cipher, Options{ExtraHosts: []string{serverHost(server)}})
	claims, err := dispatcher.claim(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	claim, ok := claimFor(claims, seed.DeliveryID)
	if !ok {
		t.Fatalf("delivery not claimed: %+v", claims)
	}
	dispatcher.deliverClaim(context.Background(), claim)
	if events != 0 {
		t.Fatalf("retry emitted %d digest events", events)
	}
}
