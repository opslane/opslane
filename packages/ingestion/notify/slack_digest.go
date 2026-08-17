package notify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"

	"github.com/opslane/opslane/packages/ingestion/masking"
	"github.com/opslane/opslane/packages/ingestion/narrative"
)

const (
	digestTitleMax   = 200
	digestDetailMax  = 300
	digestPageMax    = 120
	digestAccountMax = 60
)

func formatSlackDigest(payload EventPayload) ([]byte, string, error) {
	if payload.Digest == nil {
		return nil, "application/json", fmt.Errorf("digest.daily payload missing digest body")
	}
	if payload.Digest.SchemaVersion >= 2 {
		return formatSlackDigestV2(payload)
	}
	return formatSlackDigestV1(payload)
}

func formatSlackDigestV1(payload EventPayload) ([]byte, string, error) {
	digest := payload.Digest
	projectName := cleanProse(payload.Project.Name, headerMax)
	blocks := []map[string]any{
		{
			"type": "header",
			"text": map[string]any{
				"type":  "plain_text",
				"text":  truncate("Daily digest — "+projectName, headerMax),
				"emoji": true,
			},
		},
		{
			"type": "context",
			"elements": []map[string]any{{
				"type": "mrkdwn",
				"text": cleanProse(digest.Date, digestTitleMax),
			}},
		},
	}

	quiet := len(digest.Insights) == 0 &&
		len(digest.TopNewIssues) == 0 &&
		len(digest.Outcomes.PRsOpened) == 0 &&
		len(digest.Outcomes.PRsMerged) == 0 &&
		len(digest.Outcomes.NeedsHuman) == 0
	if quiet {
		blocks = append(blocks, digestSectionBlock("All quiet — no new customer-impacting issues in this digest."))
	} else {
		blocks = append(blocks, digestInsightBlocks(digest)...)
		blocks = append(blocks, digestNewIssueBlocks(digest)...)
		blocks = append(blocks, digestOutcomeBlocks(digest)...)
	}
	blocks = append(blocks, digestBacklogBlocks(payload.DashboardURL, digest.NeedsHumanBacklog)...)
	blocks = append(blocks, digestWatchingBlocks(digest.Watching)...)

	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(map[string]any{"blocks": blocks}); err != nil {
		return nil, "application/json", err
	}
	return body.Bytes(), "application/json", nil
}

type renderableReceipt struct {
	item ReceiptItem
	line string
}

func formatSlackDigestV2(payload EventPayload) ([]byte, string, error) {
	digest := payload.Digest
	projectName := cleanProse(payload.Project.Name, headerMax)
	blocks := []map[string]any{
		{
			"type": "header",
			"text": map[string]any{
				"type":  "plain_text",
				"text":  truncate("Daily digest — "+projectName, headerMax),
				"emoji": true,
			},
		},
		{
			"type": "context",
			"elements": []map[string]any{{
				"type": "mrkdwn",
				"text": cleanProse(digest.Date, digestTitleMax),
			}},
		},
	}

	renderable := make([]renderableReceipt, 0, len(digest.ReceiptItems))
	for _, item := range digest.ReceiptItems {
		if item.Kind != "error" && item.Kind != "friction" {
			slog.Warn("digest receipt kind is not renderable", "incident_id", item.IncidentID, "kind", item.Kind)
			continue
		}
		line, ok := narrative.ReceiptLine(item.ReceiptState, item.RootCauseExcerpt != "")
		if !ok {
			slog.Warn("digest receipt state is not renderable", "incident_id", item.IncidentID, "state", item.ReceiptState)
			continue
		}
		renderable = append(renderable, renderableReceipt{item: item, line: line})
	}

	counts := DigestTriageCounts{}
	if digest.TriageCounts != nil {
		counts = *digest.TriageCounts
	}
	quiet := len(renderable) == 0
	blocks = append(blocks, digestSectionBlock(narrative.TriageLine(counts.PRsAwaitingReview, counts.NeedsDecision, quiet)))
	for _, receipt := range renderable {
		blocks = append(blocks, digestReceiptCardBlocks(payload, receipt.item, receipt.line)...)
	}
	if digest.ReceiptOverflow > 0 {
		blocks = append(blocks, digestContextBlock(narrative.OverflowLine(digest.ReceiptOverflow)))
	}
	if digest.HeldBackCount > 0 {
		blocks = append(blocks, digestContextBlock(narrative.HeldBackLine(digest.HeldBackCount)))
	}
	blocks = append(blocks, digestWatchingBlocks(digest.Watching)...)

	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(map[string]any{"blocks": blocks}); err != nil {
		return nil, "application/json", err
	}
	return body.Bytes(), "application/json", nil
}

func digestReceiptCardBlocks(payload EventPayload, item ReceiptItem, receiptLine string) []map[string]any {
	nounSingular, nounPlural := "crash", "crashes"
	if item.Kind == "friction" {
		nounSingular, nounPlural = "friction signal", "friction signals"
	}
	text := "*" + cleanProse(item.Title, digestTitleMax) + "*\n" +
		narrative.Story(nounSingular, nounPlural, item.OccurrenceCount, narrative.Impact{
			Class: item.ImpactClass, Visits: item.ImpactVisits, Recovered: item.ImpactRecovered,
		}) + "\n" + receiptLine
	if item.RootCauseExcerpt != "" {
		text += "\nInvestigation: " + cleanProse(item.RootCauseExcerpt, digestDetailMax)
	}

	links := make([]string, 0, 3)
	if (item.ReceiptState == "pr_open" || item.ReceiptState == "pr_draft") && item.PRURL != "" {
		label := "Review fix PR"
		if item.ReceiptState == "pr_draft" {
			label = "Review draft PR"
		}
		links = append(links, slackDigestLink(item.PRURL, label))
	}
	if item.SessionURL != "" {
		links = append(links, slackDigestLink(item.SessionURL, "Watch recording"))
	}
	issueURL := BuildIncidentURL(payload.DashboardURL, item.IncidentID, payload.Project.ID)
	links = append(links, slackDigestLink(issueURL, "Issue page"))

	return []map[string]any{
		digestSectionBlock(text),
		digestContextBlock(strings.Join(links, " · ")),
	}
}

func digestContextBlock(text string) map[string]any {
	return map[string]any{
		"type": "context",
		"elements": []map[string]any{{
			"type": "mrkdwn",
			"text": truncate(text, sectionMax),
		}},
	}
}

func digestInsightBlocks(digest *DigestPayload) []map[string]any {
	if len(digest.Insights) == 0 {
		return nil
	}
	lines := []string{"*Where customers struggled*"}
	for _, insight := range digest.Insights {
		page := cleanProse(insight.Page, digestPageMax)
		if page == "" {
			page = "Unknown page"
		}
		phrase := digestSignalPhrase(insight.SignalType, insight.AffectedUsers)
		line := "• " + slackDigestLink(insight.URL, page) + " — " + phrase
		if insight.Occurrences > 0 {
			line += " (" + strconv.FormatInt(insight.Occurrences, 10) + " occurrences)"
		}
		lines = append(lines, line)
		if accounts := digestAccounts(insight.Accounts, insight.AccountsMore); accounts != "" {
			lines = append(lines, "  Accounts: "+accounts)
		}
		if insight.ReplayURL != nil && *insight.ReplayURL != "" {
			lines = append(lines, "  "+slackDigestLink(*insight.ReplayURL, "Watch replay"))
		}
	}
	if digest.InsightsHasMore {
		lines = append(lines, "• And more customer friction")
	}
	return []map[string]any{digestSectionBlock(strings.Join(lines, "\n"))}
}

func digestNewIssueBlocks(digest *DigestPayload) []map[string]any {
	if len(digest.TopNewIssues) == 0 {
		return nil
	}
	lines := []string{"*New errors customers hit*"}
	for _, issue := range digest.TopNewIssues {
		title := cleanProse(issue.Title, digestTitleMax)
		line := "• " + slackDigestLink(issue.URL, title)
		if issue.Occurrences > 0 || issue.AffectedUsers > 0 {
			line += " — " + strconv.FormatInt(issue.Occurrences, 10) + " occurrences across " +
				strconv.Itoa(issue.AffectedUsers) + " " + digestCustomerNoun(issue.AffectedUsers)
		}
		lines = append(lines, line)
		if issue.RootCauseExcerpt != nil && *issue.RootCauseExcerpt != "" {
			lines = append(lines, "  Root cause: "+cleanProse(*issue.RootCauseExcerpt, digestDetailMax))
		}
		if accounts := digestAccounts(issue.Accounts, issue.AccountsMore); accounts != "" {
			lines = append(lines, "  Accounts: "+accounts)
		}
		if issue.ReplayURL != nil && *issue.ReplayURL != "" {
			lines = append(lines, "  "+slackDigestLink(*issue.ReplayURL, "Watch replay"))
		}
	}
	if digest.TopNewIssuesHasMore {
		lines = append(lines, "• And more new errors")
	}
	return []map[string]any{digestSectionBlock(strings.Join(lines, "\n"))}
}

func digestOutcomeBlocks(digest *DigestPayload) []map[string]any {
	outcomes := digest.Outcomes
	if len(outcomes.PRsOpened) == 0 && len(outcomes.PRsMerged) == 0 && len(outcomes.NeedsHuman) == 0 {
		return nil
	}
	// Each sub-list gets its own section block. Concatenating all three into one
	// block can exceed Slack's per-section limit on a busy day, and the overflow
	// is then cut silently — dropping exactly the items asking the reader to act.
	var blocks []map[string]any
	emit := func(lines []string) {
		if len(lines) > 0 {
			blocks = append(blocks, digestSectionBlock(strings.Join(lines, "\n")))
		}
	}

	opened := []string{}
	for _, item := range outcomes.PRsOpened {
		label := "#" + strconv.Itoa(item.PRNumber) + " " + cleanProse(item.Title, digestTitleMax)
		line := "• Opened " + slackDigestLink(item.PRURL, strings.TrimSpace(label))
		if item.Merged {
			line += " — merged"
		}
		opened = append(opened, line)
		if item.RootCauseExcerpt != nil && *item.RootCauseExcerpt != "" {
			opened = append(opened, "  Root cause: "+cleanProse(*item.RootCauseExcerpt, digestDetailMax))
		}
	}
	if outcomes.PRsOpenedHasMore {
		opened = append(opened, "• And more PRs opened")
	}

	merged := []string{}
	for _, item := range outcomes.PRsMerged {
		label := "#" + strconv.Itoa(item.PRNumber) + " " + cleanProse(item.Title, digestTitleMax)
		merged = append(merged, "• Merged "+slackDigestLink(item.PRURL, strings.TrimSpace(label)))
	}
	if outcomes.PRsMergedHasMore {
		merged = append(merged, "• And more PRs merged")
	}

	needsHuman := []string{}
	for _, item := range outcomes.NeedsHuman {
		needsHuman = append(needsHuman, "• Needs review: "+slackDigestLink(item.URL, cleanProse(item.Title, digestTitleMax)))
		if item.ReasonMessage != "" {
			needsHuman = append(needsHuman, "  Reason: "+cleanProse(item.ReasonMessage, digestDetailMax))
		}
		if accounts := digestAccounts(item.Accounts, item.AccountsMore); accounts != "" {
			needsHuman = append(needsHuman, "  Accounts: "+accounts)
		}
	}
	if outcomes.NeedsHumanHasMore {
		needsHuman = append(needsHuman, "• And more issues needing review")
	}

	// The heading leads the first non-empty list so the section still reads as one.
	for _, lines := range [][]string{opened, merged, needsHuman} {
		if len(lines) == 0 {
			continue
		}
		if len(blocks) == 0 {
			lines = append([]string{"*What we did about it*"}, lines...)
		}
		emit(lines)
	}
	return blocks
}

func digestBacklogBlocks(dashboardURL string, backlog int) []map[string]any {
	if backlog <= 0 {
		return nil
	}
	label := strconv.Itoa(backlog) + " older issues still awaiting your review"
	return []map[string]any{digestSectionBlock(slackDigestLink(dashboardURL, label))}
}

func digestWatchingBlocks(watching DigestWatching) []map[string]any {
	text := "Watched " + strconv.FormatInt(watching.Sessions, 10) + " sessions across " +
		strconv.FormatInt(watching.Users, 10) + " users"
	return []map[string]any{{
		"type": "context",
		"elements": []map[string]any{{
			"type": "mrkdwn",
			"text": truncate(text, sectionMax),
		}},
	}}
}

func digestSectionBlock(text string) map[string]any {
	return map[string]any{
		"type": "section",
		"text": map[string]any{
			"type": "mrkdwn",
			"text": truncate(text, sectionMax),
		},
	}
}

func digestSignalPhrase(signalType string, affectedUsers int) string {
	prefix := strconv.Itoa(affectedUsers) + " " + digestCustomerNoun(affectedUsers) + " "
	switch signalType {
	case "rage_click":
		return prefix + "clicked repeatedly with no response"
	case "dead_click":
		return prefix + "clicked and nothing happened"
	case "form_abandon":
		return prefix + "abandoned a form"
	default:
		return prefix + "hit friction"
	}
}

func digestCustomerNoun(count int) string {
	if count == 1 {
		return "customer"
	}
	return "customers"
}

func digestAccounts(accounts []string, more int) string {
	cleaned := make([]string, 0, len(accounts)+1)
	for _, account := range accounts {
		if value := cleanProse(account, digestAccountMax); value != "" {
			cleaned = append(cleaned, value)
		}
	}
	if more > 0 {
		cleaned = append(cleaned, "and "+strconv.Itoa(more)+" more")
	}
	return strings.Join(cleaned, ", ")
}

func slackDigestLink(rawURL, label string) string {
	url := masking.RedactURL(masking.RedactBody(rawURL))
	url = slackEscape(strings.TrimSpace(url))
	if url == "" {
		return label
	}
	return "<" + url + "|" + label + ">"
}

func cleanProse(value string, budget int) string {
	// Clean (unbounded), then one truncate after escaping — pre-truncating via
	// SanitizeExcerpt would let slackEscape's entity expansion (&, <, >) push
	// the text back over budget and the outer cut would drop the ellipsis.
	return truncate(slackEscape(narrative.Clean(value)), budget)
}
