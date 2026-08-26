package filter

import (
	"context"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/usageevents"
)

func TestDispatcherEmitsIssueCreatedOnceAfterAdmission(t *testing.T) {
	pool := testPool(t)
	fixture := seedEpisode(t, pool)
	for range 3 {
		seedIdentifiedEvent(t, pool, fixture, time.Now())
	}
	var events []map[string]string
	restore := usageevents.SetSinkForTest(func(event string, props map[string]string) {
		if event != "issue_created" {
			t.Fatalf("event = %q", event)
		}
		events = append(events, props)
	})
	t.Cleanup(restore)
	if err := usageevents.Configure("https://hooks.example/T/B/x"); err != nil {
		t.Fatal(err)
	}
	dispatcher := &Dispatcher{
		pool: pool, projectID: fixture.projectID, dashboardURL: "https://app.example.com",
	}
	if _, enqueued, err := dispatcher.Tick(context.Background()); err != nil || enqueued != 1 {
		t.Fatalf("first Tick enqueued=%d err=%v", enqueued, err)
	}
	if _, _, err := dispatcher.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %+v", events)
	}
	if events[0]["project_id"] != fixture.projectID || events[0]["issue_id"] == "" ||
		events[0]["episode_id"] != fixture.episodeID || events[0]["url"] == "" {
		t.Fatalf("props = %+v", events[0])
	}
}
