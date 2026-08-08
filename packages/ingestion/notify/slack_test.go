package notify

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func samplePayload(title, dashboardURL string) EventPayload {
	return EventPayload{
		Version:      1,
		EventType:    "issue.created",
		Issue:        &IssueRef{ID: "g1", Title: title, FirstSeen: "2026-07-19T00:00:00Z"},
		Project:      ProjectRef{ID: "p1", Name: "storefront"},
		Environment:  "production",
		DashboardURL: dashboardURL,
	}
}

func TestSlackFormatEscapesMasksAndIncludesButton(t *testing.T) {
	title := "<!channel> *bold* `tick` a&b <script> sk_live_supersecret"
	body, contentType, err := FormatSlack(samplePayload(title, "https://app.example.com/incidents/g1?project_id=p1"))
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "application/json" {
		t.Fatalf("content type %q", contentType)
	}
	text := string(body)
	for _, forbidden := range []string{"<!channel>", "sk_live_supersecret", "`tick`"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("untrusted input %q was not sanitized: %s", forbidden, text)
		}
	}
	if !strings.Contains(text, "&amp;") || !strings.Contains(text, "&lt;") || !strings.Contains(text, "View in Opslane") {
		t.Fatalf("missing escaping or action: %s", text)
	}
	if _, ok := Formatters["slack"]; !ok {
		t.Fatal("slack formatter not registered")
	}
}

func TestSlackFormatOmitsButtonWithoutURL(t *testing.T) {
	body, _, err := FormatSlack(samplePayload("t", ""))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "View in Opslane") {
		t.Fatal("button must be omitted without dashboard URL")
	}
}

func TestSlackFormatLimitsAreRuneSafe(t *testing.T) {
	payload := samplePayload(strings.Repeat("界", 5000), "")
	payload.Project.Name = strings.Repeat("界", 500)
	body, _, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Blocks []struct {
			Text struct {
				Text string `json:"text"`
			} `json:"text"`
		} `json:"blocks"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatal(err)
	}
	if got := utf8.RuneCountInString(document.Blocks[0].Text.Text); got > headerMax {
		t.Fatalf("header has %d runes", got)
	}
	if got := utf8.RuneCountInString(document.Blocks[1].Text.Text); got > 3000 {
		t.Fatalf("section has %d runes", got)
	}
}

func TestSlackFormatRejectsUnknownAndMissingIssueBody(t *testing.T) {
	for _, payload := range []EventPayload{
		{EventType: "bogus"},
		{EventType: "issue.created"},
	} {
		if _, _, err := FormatSlack(payload); err == nil {
			t.Fatalf("FormatSlack(%q) unexpectedly succeeded", payload.EventType)
		}
	}
}
