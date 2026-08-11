package notify

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func legacyPopulatedPayload() EventPayload {
	replayURL := "https://app.example/sessions/session-1"
	rootCause := "The authentication wrapper renders an unresolved component."
	return EventPayload{
		Version:      1,
		EventType:    "digest.daily",
		Project:      ProjectRef{ID: "project-1", Name: "Acme"},
		Environment:  "production",
		DashboardURL: "https://app.example",
		Digest: &DigestPayload{
			Date:   "2026-08-11",
			Window: DigestWindow{From: "2026-08-10T09:00:00Z", To: "2026-08-11T09:00:00Z"},
			Insights: []DigestInsight{{
				SignalType:    "rage_click",
				Page:          "/sign-in",
				Occurrences:   8,
				AffectedUsers: 3,
				Accounts:      []string{"acme.example", "beta.example"},
				AccountsMore:  1,
				ReplayURL:     &replayURL,
				URL:           "https://app.example/incidents/insight-1",
			}},
			InsightsHasMore: true,
			TopNewIssues: []DigestIssue{{
				Title:            "Sign-in page crashes",
				URL:              "https://app.example/incidents/incident-1",
				RootCauseExcerpt: &rootCause,
				Occurrences:      3,
				AffectedUsers:    2,
				Accounts:         []string{"acme.example"},
				AccountsMore:     1,
				ReplayURL:        &replayURL,
			}},
			TopNewIssuesHasMore: true,
			Outcomes: DigestOutcomes{
				PRsOpened: []DigestPROpened{{
					Title:            "Fix authentication wrapper fallback",
					PRURL:            "https://github.com/opslane/opslane/pull/1",
					PRNumber:         1,
					Merged:           false,
					RootCauseExcerpt: &rootCause,
				}},
				PRsMerged: []DigestPRMerged{{
					Title: "Guard the checkout total", PRURL: "https://github.com/opslane/opslane/pull/2", PRNumber: 2,
				}},
				NeedsHuman: []DigestNeedsHuman{{
					Title:         "Upstream identity provider timed out",
					URL:           "https://app.example/incidents/incident-2",
					ReasonMessage: "The failing service is outside the repository.",
					Accounts:      []string{"acme.example"},
					AccountsMore:  1,
				}},
				PRsOpenedHasMore:  true,
				PRsMergedHasMore:  true,
				NeedsHumanHasMore: true,
			},
			NeedsHumanBacklog: 4,
			Watching:          DigestWatching{Sessions: 120, Users: 38},
		},
	}
}

func TestDigestPayloadByteIdenticalWhenReceiptFieldsUnset(t *testing.T) {
	p := legacyPopulatedPayload()
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	goldenPath := "testdata/digest_payload_v1.json"
	if os.Getenv("UPDATE_DIGEST_PAYLOAD_GOLDEN") == "1" {
		if err := os.WriteFile(goldenPath, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	golden, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b, golden) {
		t.Fatalf("payload bytes changed:\n%s\nvs golden\n%s", b, golden)
	}
}

func TestReceiptItemRoundTrips(t *testing.T) {
	visits := int64(2)
	recovered := int64(1)
	item := ReceiptItem{
		Kind: "error", IncidentID: "i", Title: "t", OccurrenceCount: 3,
		ImpactClass: "blocked", ImpactVisits: &visits, ImpactRecovered: &recovered,
		ReceiptState: "pr_open", PRURL: "https://github.com/x/1",
	}
	b, err := json.Marshal(DigestPayload{Date: "d", SchemaVersion: 2, ReceiptItems: []ReceiptItem{item}})
	if err != nil {
		t.Fatal(err)
	}
	var back DigestPayload
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back.SchemaVersion != 2 || len(back.ReceiptItems) != 1 || back.ReceiptItems[0].ImpactVisits == nil {
		t.Fatalf("round trip lost data: %+v", back)
	}
}

func TestReceiptFieldsOmitEmptyValuesButKeepPointerZeros(t *testing.T) {
	for _, items := range [][]ReceiptItem{nil, {}} {
		b, err := json.Marshal(DigestPayload{Date: "d", SchemaVersion: 0, ReceiptItems: items})
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "schema_version") || strings.Contains(string(b), "receipt_items") {
			t.Fatalf("empty receipt fields were serialized: %s", b)
		}
	}

	zero := int64(0)
	b, err := json.Marshal(ReceiptItem{
		Kind: "error", IncidentID: "i", Title: "t", ReceiptState: "report_ready",
		ImpactVisits: &zero, ImpactRecovered: &zero, HasSavedDiff: false,
		ClusterIncidentIDs: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, field := range []string{`"impact_visits":0`, `"impact_visits_recovered":0`} {
		if !strings.Contains(s, field) {
			t.Errorf("non-nil pointer zero omitted from %s", s)
		}
	}
	for _, field := range []string{"has_saved_diff", "cluster_incident_ids"} {
		if strings.Contains(s, field) {
			t.Errorf("empty %s serialized in %s", field, s)
		}
	}
}
