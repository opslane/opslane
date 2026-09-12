package notify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// formatSlackDigestV5 is the known-problems list. Every item uses one template
// and one primary action; recordings and the issue remain ordinary links.
func formatSlackDigestV5(payload EventPayload) ([]byte, string, error) {
	d := payload.Digest
	cards := append([]GeneratedDigestCard(nil), d.GeneratedCards...)
	for _, r := range d.ReceiptItems {
		copy := r.RootCauseExcerpt
		why := ""
		if r.TicketID != "" {
			copy = r.Copy
			why = r.RootCauseExcerpt
		}
		if copy == "" {
			copy = r.Title
		}
		action := r.Action
		if action == "" {
			action = "Review issue"
			if r.PRURL != "" {
				action = "Review PR"
			}
		}
		cards = append(cards, GeneratedDigestCard{IncidentID: r.IncidentID, Kind: r.Kind, Title: r.Title, Copy: copy, Why: why,
			TicketID: r.TicketID, Generation: r.Generation, Steps: r.Steps, VerifiedUsers: r.VerifiedUsers, VerifiedSessions: r.VerifiedSessions, Coverage: r.Coverage,
			AffectedUsers: r.AffectedUsers, OccurrenceCount: int(r.OccurrenceCount), Accounts: r.Accounts, Action: action, ActionURL: r.ActionURL, PRURL: r.PRURL, ReplayURL: r.SessionURL})
	}
	blocks := []map[string]any{{"type": "header", "text": map[string]any{"type": "plain_text", "text": truncate("Daily digest · "+cleanProse(payload.Project.Name, headerMax), headerMax)}}}
	blocks = append(blocks, digestContextBlock(cleanProse(d.Date, digestTitleMax)))
	if len(cards) == 0 {
		blocks = append(blocks, digestSectionBlock("No known problems need attention today."))
	}
	for i, c := range cards[:min(len(cards), DigestV4CardCap)] {
		if i > 0 {
			blocks = append(blocks, map[string]any{"type": "divider"})
		}
		text := "*" + cleanProse(c.Title, 80) + "*\n" + cleanProse(c.Copy, 300)
		if c.Steps != "" {
			text += "\n" + cleanProse(c.Steps, 600)
		}
		if c.Why != "" && (c.TicketID == "" || c.Coverage >= .5) {
			text += "\nWhy: " + cleanProse(c.Why, 300)
		}
		counts := fmt.Sprintf("%d users · %d error occurrences", c.AffectedUsers, c.OccurrenceCount)
		if c.TicketID != "" {
			counts = fmt.Sprintf("%d users · %d sessions this week", c.VerifiedUsers, c.VerifiedSessions)
		} else if c.Kind != "error" {
			counts = fmt.Sprintf("%d users · %d signals", c.AffectedUsers, c.OccurrenceCount)
		}
		if len(c.Accounts) > 0 {
			counts += " · " + cleanProse(strings.Join(c.Accounts, ", "), 300)
		}
		text += "\n" + counts
		blocks = append(blocks, digestSectionBlock(text))
		issue := BuildIncidentURL(payload.DashboardURL, c.IncidentID, payload.Project.ID)
		links := []string{}
		if c.ReplayURL != "" {
			links = append(links, slackDigestLink(c.ReplayURL, "Replay"))
		}
		if issue != "" {
			links = append(links, slackDigestLink(issue, "Issue"))
		}
		if len(links) > 0 {
			blocks = append(blocks, digestContextBlock(strings.Join(links, " · ")))
		}
		action, target := c.Action, c.ActionURL
		if target == "" {
			target = issue
		}
		if c.TicketID != "" {
			if action == "Review PR" && c.PRURL != "" {
				target = c.PRURL
			}
		} else {
			if c.PRURL != "" {
				action, target = "Review PR", c.PRURL
			} else if action == "" {
				action = "Review issue"
			}
		}
		if target != "" {
			blocks = append(blocks, map[string]any{"type": "actions", "elements": []map[string]any{digestButton("digest_action_"+strconv.Itoa(i), action, target, "primary")}})
		}
	}
	overflow := max(d.OverflowCount+d.ReceiptOverflow, len(cards)-DigestV4CardCap)
	if overflow > 0 {
		blocks = append(blocks, digestContextBlock(fmt.Sprintf("And %d more on the dashboard", overflow)))
	}
	if len(d.MergedThisWeek) > 0 {
		budget := 50 - len(blocks)
		if d.DeliveryAlert != "" {
			budget--
		}
		if payload.PreviewNote != "" {
			budget--
		}
		blocks = append(blocks, mergedFooterBlocks(d.MergedThisWeek, budget)...)
	}
	if d.DeliveryAlert != "" {
		blocks = append(blocks, digestContextBlock(cleanProse(d.DeliveryAlert, 300)))
	}
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(map[string]any{"blocks": blocks}); err != nil {
		return nil, "application/json", err
	}
	return out.Bytes(), "application/json", nil
}

// Leave room below Slack's section limit for an explicit overflow line. Links
// are indivisible: truncating a section can silently lose PRs or cut markup.
func mergedFooterBlocks(merged []DigestPRMerged, budget int) []map[string]any {
	if len(merged) == 0 || budget <= 0 {
		return nil
	}
	blocks := []map[string]any{}
	current := "*Merged this week*"
	for i, item := range merged {
		line := "• " + slackDigestLink(item.PRURL, cleanProse(item.Title, 120))
		if len([]rune(current))+1+len([]rune(line)) > 2800 {
			if len(blocks)+1 >= budget || len([]rune(line)) > 2800 {
				current += fmt.Sprintf("\nAnd %d more merged PRs on the dashboard", len(merged)-i)
				return append(blocks, digestSectionBlock(current))
			}
			blocks = append(blocks, digestSectionBlock(current))
			current = line
		} else {
			current += "\n" + line
		}
	}
	return append(blocks, digestSectionBlock(current))
}
