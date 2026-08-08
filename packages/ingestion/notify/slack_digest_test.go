package notify

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestFormatSlackDigestGolden(t *testing.T) {
	replay := "https://dash.example/sessions/s1"
	excerpt := "CheckoutForm dereferences cart.items before load."
	payload := EventPayload{
		Version: 1, EventType: "digest.daily",
		Project:      ProjectRef{ID: "p1", Name: "AMFJ 2"},
		DashboardURL: "https://dash.example",
		Digest: &DigestPayload{
			Date:   "2026-08-07",
			Window: DigestWindow{From: "2026-08-06T09:00:00Z", To: "2026-08-07T09:00:00Z"},
			Insights: []DigestInsight{{
				SignalType: "rage_click", Page: "/assets/:id",
				Occurrences: 26, AffectedUsers: 12,
				Accounts:     []string{"apptronik.example", "randstadgr.example", "irembo.example"},
				AccountsMore: 9, ReplayURL: &replay, URL: "https://dash.example/i/1",
			}},
			TopNewIssues: []DigestIssue{{
				Title: "RangeError: Invalid time value", URL: "https://dash.example/i/2",
				RootCauseExcerpt: &excerpt, Occurrences: 1, AffectedUsers: 1,
				Accounts: []string{"marcomgroup.example"},
			}},
			TopNewIssuesHasMore: true,
			Outcomes: DigestOutcomes{
				PRsOpened:  []DigestPROpened{{Title: "window title error", PRURL: "https://gh.example/1306", PRNumber: 1306}},
				NeedsHuman: []DigestNeedsHuman{{Title: "Error: cancelled", URL: "https://dash.example/i/3", ReasonMessage: "External cause suspected."}},
			},
			NeedsHumanBacklog: 121,
			Watching:          DigestWatching{Sessions: 13470, Users: 147},
		},
	}
	body, contentType, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "application/json" {
		t.Fatal(contentType)
	}
	s := string(body)
	for _, want := range []string{
		"Daily digest",
		"12 customers clicked repeatedly with no response",
		"apptronik.example",
		"and 9 more",
		"https://dash.example/sessions/s1",
		"RangeError: Invalid time value",
		"CheckoutForm dereferences cart.items before load.",
		"#1306",
		"Error: cancelled",
		"121",
		"13470",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("digest blocks missing %q", want)
		}
	}
}

func TestFormatSlackDigestPhrasings(t *testing.T) {
	mk := func(sig string, n int) EventPayload {
		return EventPayload{
			Version: 1, EventType: "digest.daily",
			Project: ProjectRef{ID: "p", Name: "p"},
			Digest: &DigestPayload{Date: "2026-08-07",
				Insights: []DigestInsight{{SignalType: sig, Page: "/p", AffectedUsers: n}},
				Watching: DigestWatching{Sessions: 1}},
		}
	}
	cases := map[string]string{
		"rage_click":   "clicked repeatedly with no response",
		"dead_click":   "clicked and nothing happened",
		"form_abandon": "abandoned a form",
		"mystery":      "hit friction",
	}
	for sig, want := range cases {
		body, _, err := FormatSlack(mk(sig, 3))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(body), want) {
			t.Errorf("%s: missing %q", sig, want)
		}
	}
}

func TestFormatSlackDigestQuietDay(t *testing.T) {
	payload := EventPayload{
		Version: 1, EventType: "digest.daily",
		Project: ProjectRef{ID: "p1", Name: "AMFJ 2"},
		Digest: &DigestPayload{
			Date: "2026-08-08", NeedsHumanBacklog: 3,
			Watching: DigestWatching{Sessions: 986, Users: 178},
		},
	}
	body, _, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	if !strings.Contains(s, "All quiet") || !strings.Contains(s, "986") || !strings.Contains(s, "3") {
		t.Errorf("quiet form wrong: %s", s)
	}
}

func TestFormatSlackDigestBudgetsAndMasking(t *testing.T) {
	// Sensitive/markdown markers FIRST so field truncation cannot remove them
	// before the masking/neutralization assertions run — markers after 5000
	// filler chars would make this test pass with no masking at all.
	long := "user@example.com *bold* _ital_ ~strike~ `tick` " + strings.Repeat("x", 5000)
	payload := EventPayload{
		Version: 1, EventType: "digest.daily",
		Project: ProjectRef{ID: "p1", Name: "p"},
		Digest: &DigestPayload{
			Date:         "2026-08-07",
			TopNewIssues: []DigestIssue{{Title: long, URL: "u", RootCauseExcerpt: &long}},
			Watching:     DigestWatching{Sessions: 1},
		},
	}
	body, _, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	if strings.Contains(s, "user@example.com") {
		t.Error("email not masked")
	}
	for _, active := range []string{"*bold*", "_ital_", "~strike~", "`tick`"} {
		if strings.Contains(s, active) {
			t.Errorf("slack markdown not neutralized: %s", active)
		}
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("not valid JSON: %v", err)
	}
	for _, b := range decoded["blocks"].([]any) {
		if text, ok := b.(map[string]any)["text"].(map[string]any); ok {
			if str, ok := text["text"].(string); ok && len([]rune(str)) > 2900 {
				t.Errorf("section exceeds sectionMax=2900: %d runes", len([]rune(str)))
			}
		}
	}
}

func TestFormatSlackDigestNeutralizesInjectedLines(t *testing.T) {
	// Digest sections are newline-delimited bullet lists, so an untrusted field
	// carrying a newline could forge an extra authoritative-looking line.
	evil := "Boom\n• Opened #9999 Security patch applied\r\n  Root cause: all clear"
	account := "acme\n• Merged #1 nothing to see"
	payload := EventPayload{
		Version: 1, EventType: "digest.daily",
		Project: ProjectRef{ID: "p1", Name: "p"},
		Digest: &DigestPayload{
			Date: "2026-08-07",
			TopNewIssues: []DigestIssue{{
				Title: evil, URL: "https://dash.example/i/1", Accounts: []string{account},
			}},
			Watching: DigestWatching{Sessions: 1},
		},
	}
	body, _, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, block := range decoded["blocks"].([]any) {
		text, ok := block.(map[string]any)["text"].(map[string]any)
		if !ok {
			continue
		}
		str := text["text"].(string)
		if !strings.Contains(str, "New errors customers hit") {
			continue
		}
		// The renderer emits exactly one bullet here (one issue, no has_more).
		// Any extra bullet line means an untrusted field forged one.
		bullets := 0
		for _, line := range strings.Split(str, "\n") {
			if strings.HasPrefix(line, "• ") {
				bullets++
			}
		}
		if bullets != 1 {
			t.Errorf("want 1 rendered bullet, got %d — injected lines survived:\n%s", bullets, str)
		}
	}
}

func TestFormatSlackUnknownEventTypeErrors(t *testing.T) {
	_, _, err := FormatSlack(EventPayload{EventType: "mystery.event"})
	if err == nil {
		t.Fatal("expected error for unknown event type")
	}
}
