package notify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/opslane/opslane/packages/ingestion/masking"
)

const (
	headerMax  = 150
	sectionMax = 2900
)

func slackEscape(value string) string {
	value = strings.ReplaceAll(value, "&", "&amp;")
	value = strings.ReplaceAll(value, "<", "&lt;")
	return strings.ReplaceAll(value, ">", "&gt;")
}

func truncate(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max-1]) + "…"
}

// FormatSlack renders a supported notification payload as Slack Block Kit JSON.
func FormatSlack(payload EventPayload) ([]byte, string, error) {
	switch payload.EventType {
	case "issue.created":
		return formatSlackIssue(payload)
	case "issue.triaged":
		return formatSlackTriaged(payload)
	case "digest.daily":
		return formatSlackDigest(payload)
	default:
		return nil, "application/json", fmt.Errorf("no slack formatter for event_type %q", payload.EventType)
	}
}

func formatSlackTriaged(payload EventPayload) ([]byte, string, error) {
	if payload.Issue == nil || payload.Outcome == nil {
		return nil, "application/json", fmt.Errorf("issue.triaged payload missing issue or outcome body")
	}
	title := masking.RedactURL(masking.RedactBody(payload.Issue.Title))
	title = strings.ReplaceAll(title, "`", "'")
	title = truncate(slackEscape(title), sectionMax)
	label := masking.RedactURL(masking.RedactBody(payload.Outcome.Label))
	label = truncate(slackEscape(strings.ReplaceAll(label, "`", "'")), sectionMax)

	blocks := []map[string]any{
		{
			"type": "header",
			"text": map[string]any{
				"type":  "plain_text",
				"text":  truncate("Triaged in "+payload.Project.Name, headerMax),
				"emoji": true,
			},
		},
		{
			"type": "section",
			"text": map[string]any{
				"type": "mrkdwn",
				"text": "*" + label + "*\n`" + title + "`",
			},
			"fields": []map[string]any{
				{"type": "mrkdwn", "text": "*Environment:*\n" + slackEscape(payload.Environment)},
				{"type": "mrkdwn", "text": fmt.Sprintf("*Impact (7d):*\n%d users · %d anonymous sessions", payload.Outcome.Impact.Users7D, payload.Outcome.Impact.AnonSessions7D)},
			},
		},
	}
	if payload.DashboardURL != "" {
		blocks = append(blocks, map[string]any{
			"type": "actions",
			"elements": []map[string]any{{
				"type": "button",
				"text": map[string]any{"type": "plain_text", "text": "View in Opslane"},
				"url":  payload.DashboardURL,
			}},
		})
	}

	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(map[string]any{"blocks": blocks}); err != nil {
		return nil, "application/json", err
	}
	return body.Bytes(), "application/json", nil
}

func formatSlackIssue(payload EventPayload) ([]byte, string, error) {
	if payload.Issue == nil {
		return nil, "application/json", fmt.Errorf("issue.created payload missing issue body")
	}
	title := masking.RedactURL(masking.RedactBody(payload.Issue.Title))
	title = strings.ReplaceAll(title, "`", "'")
	title = truncate(slackEscape(title), sectionMax)

	blocks := []map[string]any{
		{
			"type": "header",
			"text": map[string]any{
				"type":  "plain_text",
				"text":  truncate("New issue in "+payload.Project.Name, headerMax),
				"emoji": true,
			},
		},
		{
			"type": "section",
			"text": map[string]any{"type": "mrkdwn", "text": "`" + title + "`"},
			"fields": []map[string]any{
				{"type": "mrkdwn", "text": "*Environment:*\n" + slackEscape(payload.Environment)},
				{"type": "mrkdwn", "text": "*First seen:*\n" + slackEscape(payload.Issue.FirstSeen)},
			},
		},
	}
	if payload.DashboardURL != "" {
		blocks = append(blocks, map[string]any{
			"type": "actions",
			"elements": []map[string]any{{
				"type": "button",
				"text": map[string]any{"type": "plain_text", "text": "View in Opslane"},
				"url":  payload.DashboardURL,
			}},
		})
	}

	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	// Slack requires literal &lt;/&gt;/&amp; sequences in mrkdwn. The default
	// encoder's HTML escaping would obscure those as JSON unicode escapes.
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(map[string]any{"blocks": blocks}); err != nil {
		return nil, "application/json", err
	}
	return body.Bytes(), "application/json", nil
}
