package notify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

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
	var body []byte
	var contentType string
	var err error
	if payload.Digest.SchemaVersion >= 4 {
		body, contentType, err = formatSlackDigestV4(payload)
	} else if payload.Digest.SchemaVersion >= 3 {
		body, contentType, err = formatSlackDigestV3(payload)
	} else if payload.Digest.SchemaVersion >= 2 {
		body, contentType, err = formatSlackDigestV2(payload)
	} else {
		body, contentType, err = formatSlackDigestV1(payload)
	}
	if err != nil || payload.PreviewNote == "" {
		return body, contentType, err
	}
	var envelope struct {
		Blocks []map[string]any `json:"blocks"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, contentType, fmt.Errorf("add digest preview note: %w", err)
	}
	note := cleanProse(payload.PreviewNote, digestDetailMax)
	if note == "" {
		return body, contentType, nil
	}
	envelope.Blocks = append([]map[string]any{digestContextBlock(note)}, envelope.Blocks...)
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(envelope); err != nil {
		return nil, contentType, fmt.Errorf("encode digest preview note: %w", err)
	}
	return output.Bytes(), contentType, nil
}

// DigestV4CardCap is the most cards one v4 digest renders. Exported because
// the validator enforces it too: cards past the cap must be deferred there,
// not silently receipted as published (see digest/validate.go).
const DigestV4CardCap = 9

func formatSlackDigestV4(payload EventPayload) ([]byte, string, error) {
	digest := payload.Digest
	receipts := renderableDigestReceipts(digest)
	decisions := make([]GeneratedDigestCard, 0)
	fixes := make([]GeneratedDigestCard, 0)
	for _, card := range digest.GeneratedCards {
		switch card.Outcome {
		case "needs_human":
			decisions = append(decisions, card)
		case "verified_fix":
			fixes = append(fixes, card)
		default:
			// Unreachable today (freeze admits exactly two outcomes), but a
			// future outcome must not vanish without a trace.
			slog.Warn("digest card outcome is not renderable", "incident_id", card.IncidentID, "outcome", card.Outcome)
		}
	}
	totalCount := len(decisions) + len(receipts) + len(fixes)
	var renderedDecisions, renderedFixes []GeneratedDigestCard
	var renderedReceipts []renderableReceipt
	// Overflow accounting differs with the mode, so each branch computes the
	// single "And N more" count it owns.
	overflow := 0
	if digest.UnifiedCards {
		// ON: cards and receipt fallbacks are one list of pending incidents and
		// share one budget. The two persisted overflow counts describe
		// different upstream lanes, while local overflow covers an oversized
		// payload from an older or buggy producer. Render one combined notice
		// so an incident is never represented by two overflow lines.
		remaining := DigestV4CardCap
		decisionCount := min(len(decisions), remaining)
		renderedDecisions = decisions[:decisionCount]
		remaining -= decisionCount
		receiptCount := min(len(receipts), remaining)
		renderedReceipts = receipts[:receiptCount]
		remaining -= receiptCount
		fixCount := min(len(fixes), remaining)
		renderedFixes = fixes[:fixCount]
		overflow = max(digest.OverflowCount+digest.ReceiptOverflow,
			totalCount-(decisionCount+receiptCount+fixCount))
	} else {
		// OFF is the rollback path and must stay byte-identical to what ships
		// on main: the cap covers generated cards only, every receipt renders,
		// and the receipt lane keeps its own overflow line below the cards.
		allCards := append(append([]GeneratedDigestCard(nil), decisions...), fixes...)
		rendered := allCards
		if len(rendered) > DigestV4CardCap {
			rendered = rendered[:DigestV4CardCap]
		}
		renderedDecisions = make([]GeneratedDigestCard, 0, len(rendered))
		renderedFixes = make([]GeneratedDigestCard, 0, len(rendered))
		for _, card := range rendered {
			if card.Outcome == "needs_human" {
				renderedDecisions = append(renderedDecisions, card)
			} else {
				renderedFixes = append(renderedFixes, card)
			}
		}
		renderedReceipts = receipts
		// The validator defers overflow cards and reports the count; the local
		// difference is the belt for payloads that somehow still exceed the cap.
		overflow = max(digest.OverflowCount, len(allCards)-len(rendered))
	}

	blocks := []map[string]any{
		{
			"type": "header",
			"text": map[string]any{"type": "plain_text", "text": truncate("Daily digest · "+cleanProse(payload.Project.Name, headerMax), headerMax), "emoji": true},
		},
		{
			"type":     "context",
			"elements": []map[string]any{{"type": "mrkdwn", "text": digestV4Summary(digest.Date, len(decisions)+len(receipts), len(fixes))}},
		},
	}
	if totalCount == 0 {
		blocks = append(blocks, digestSectionBlock("Nothing needs your attention today."))
	}
	position := 0
	regularDecisions := make([]GeneratedDigestCard, 0, len(renderedDecisions))
	intelligence := make([]GeneratedDigestCard, 0, len(renderedDecisions))
	for _, card := range renderedDecisions {
		if card.ObservationQuote != "" {
			intelligence = append(intelligence, card)
		} else {
			regularDecisions = append(regularDecisions, card)
		}
	}
	if len(regularDecisions) > 0 || len(renderedReceipts) > 0 {
		blocks = append(blocks, digestSectionBlock("⚠️ *Needs a decision*"))
		needDivider := false
		for _, card := range regularDecisions {
			if needDivider {
				blocks = append(blocks, map[string]any{"type": "divider"})
			}
			blocks = append(blocks, digestV4CardBlocks(payload, card, position, "Needs you")...)
			position++
			needDivider = true
		}
		// An incident nothing was ever going to write a card for gets one line,
		// not a card: its full rendering is three mechanical sentences the
		// reader cannot act on differently from the one line. Every other
		// receipt keeps its card, because those mark an authoring failure and
		// compacting them would hide it.
		full := make([]renderableReceipt, 0, len(renderedReceipts))
		compact := make([]renderableReceipt, 0, len(renderedReceipts))
		for _, receipt := range renderedReceipts {
			if receipt.item.FallbackReason == ReceiptFallbackNeverEligible {
				compact = append(compact, receipt)
				continue
			}
			full = append(full, receipt)
		}
		for _, receipt := range full {
			if needDivider {
				blocks = append(blocks, map[string]any{"type": "divider"})
			}
			blocks = append(blocks, digestReceiptCardBlocks(payload, receipt.item, receipt.line)...)
			needDivider = true
		}
		if len(compact) > 0 {
			blocks = append(blocks, map[string]any{"type": "divider"},
				digestContextBlock("*Also waiting*"))
			for _, receipt := range compact {
				blocks = append(blocks, digestContextBlock(digestCompactReceiptLine(payload, receipt.item)))
			}
		}
	}
	if len(intelligence) > 0 {
		blocks = append(blocks, digestSectionBlock("🧭 *Session intelligence*"))
		for index, card := range intelligence {
			blocks = append(blocks, digestV4CardBlocks(payload, card, position, "Needs you")...)
			position++
			if index < len(intelligence)-1 {
				blocks = append(blocks, map[string]any{"type": "divider"})
			}
		}
	}
	if !digest.UnifiedCards && digest.ReceiptOverflow > 0 {
		blocks = append(blocks, digestContextBlock(narrative.OverflowLine(digest.ReceiptOverflow)))
	}
	if digest.DeliveryAlert != "" {
		blocks = append(blocks, digestContextBlock("⚠️ "+cleanProse(digest.DeliveryAlert, digestDetailMax)))
	}
	if len(renderedFixes) > 0 {
		blocks = append(blocks, digestSectionBlock("✅ *Fixes ready to merge*"))
		for index, card := range renderedFixes {
			blocks = append(blocks, digestV4CardBlocks(payload, card, position, "Ready")...)
			position++
			if index < len(renderedFixes)-1 {
				blocks = append(blocks, map[string]any{"type": "divider"})
			}
		}
	}
	if overflow > 0 {
		label := fmt.Sprintf("And %d more on the dashboard", overflow)
		blocks = append(blocks, digestContextBlock(slackDigestLink(payload.DashboardURL, label)))
	}

	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(map[string]any{"blocks": blocks}); err != nil {
		return nil, "application/json", err
	}
	return body.Bytes(), "application/json", nil
}

func digestV4Summary(rawDate string, decisions, fixes int) string {
	date := rawDate
	if parsed, err := time.Parse("2006-01-02", rawDate); err == nil {
		date = parsed.Format("Jan 2")
	}
	total := decisions + fixes
	if total == 0 {
		return date
	}
	issueNoun, matterVerb := "issues", "matter"
	if total == 1 {
		issueNoun, matterVerb = "issue", "matters"
	}
	parts := []string{date, fmt.Sprintf("%d %s that %s", total, issueNoun, matterVerb)}
	if decisions > 0 {
		verb := "need"
		if decisions == 1 {
			verb = "needs"
		}
		parts = append(parts, fmt.Sprintf("%d %s a decision", decisions, verb))
	}
	if fixes > 0 {
		noun := "fixes"
		if fixes == 1 {
			noun = "fix"
		}
		parts = append(parts, fmt.Sprintf("%d %s ready to merge", fixes, noun))
	}
	return strings.Join(parts, " · ")
}

func digestV4CardBlocks(payload EventPayload, card GeneratedDigestCard, position int, leadIn string) []map[string]any {
	text := "*" + cleanProse(card.Title, 80) + "*\n" + cleanProse(card.Copy, digestDetailMax)
	// Its own line, between what happened and what to do: the reader decides on
	// the cause, and burying it inside the copy is what made these cards read as
	// a symptom with no explanation.
	if why := cleanProse(card.Why, digestDetailMax); why != "" {
		text += "\nWhy: " + why
	}
	text += "\n*" + leadIn + ":* " + cleanProse(card.Action, digestDetailMax)
	// No people fragment at zero: the prompt tells the writer to describe a
	// zero-user problem without a count, and "👥 0 users" would contradict the
	// card's own copy (v3 hid the count the same way).
	contextParts := make([]string, 0, 4)
	if card.ObservationQuote != "" {
		// Route only. The session tally used to follow it, and a reader who had
		// just been told in prose who was affected got the same fact back as
		// arithmetic. The writer owns the impact sentence now; a receipt card
		// still shows its counts, because nobody wrote prose for it.
		if card.Route != "" {
			contextParts = append(contextParts, cleanProse(card.Route, digestPageMax))
		}
	} else if card.AffectedUsers > 0 {
		noun := "users"
		if card.AffectedUsers == 1 {
			noun = "user"
		}
		contextParts = append(contextParts, fmt.Sprintf("👥 %d %s", card.AffectedUsers, noun))
	}
	if len(card.Accounts) > 0 {
		accounts := cleanProse(strings.Join(card.Accounts, ", "), digestDetailMax)
		if len(contextParts) == 0 {
			accounts = "👥 " + accounts
		}
		contextParts = append(contextParts, accounts)
	}
	if age := digestWaitingAgeLine(payload, card.IncidentID, card.ActionableSince,
		"digest card aging line dropped: window is not RFC3339Nano"); age != "" {
		contextParts = append(contextParts, age)
	}
	context := strings.Join(contextParts, " · ")
	buttons := make([]map[string]any, 0, 2)
	if card.Outcome == "needs_human" && card.ReplayURL != "" {
		buttons = append(buttons, digestButton("digest_replay_"+strconv.Itoa(position), "Watch replay", card.ReplayURL, "primary"))
	}
	if card.Outcome == "verified_fix" && card.PRURL != "" {
		label := "Review fix PR"
		if card.PRNumber > 0 {
			label = "Review PR #" + strconv.Itoa(card.PRNumber)
		}
		buttons = append(buttons, digestButton("digest_pr_"+strconv.Itoa(position), label, card.PRURL, "primary"))
	}
	if issueURL := BuildIncidentURL(payload.DashboardURL, card.IncidentID, payload.Project.ID); issueURL != "" {
		label := "View issue"
		if card.Kind == "friction" {
			label = "Issue page"
		}
		buttons = append(buttons, digestButton("digest_issue_"+strconv.Itoa(position), label, issueURL, ""))
	}
	blocks := []map[string]any{digestSectionBlock(text)}
	if context != "" {
		blocks = append(blocks, digestContextBlock(context))
	}
	if len(buttons) > 0 {
		blocks = append(blocks, map[string]any{"type": "actions", "elements": buttons})
	}
	return blocks
}

func digestButton(actionID, text, buttonURL, style string) map[string]any {
	button := map[string]any{
		"type":      "button",
		"action_id": actionID,
		"text":      map[string]any{"type": "plain_text", "text": truncate(text, 75), "emoji": true},
		"url":       strings.TrimSpace(masking.RedactURL(masking.RedactBody(buttonURL))),
	}
	if style != "" {
		button["style"] = style
	}
	return button
}

func formatSlackDigestV3(payload EventPayload) ([]byte, string, error) {
	digest := payload.Digest
	blocks := []map[string]any{
		{
			"type": "header",
			"text": map[string]any{"type": "plain_text", "text": truncate("Daily digest — "+cleanProse(payload.Project.Name, headerMax), headerMax), "emoji": true},
		},
		{
			"type":     "context",
			"elements": []map[string]any{{"type": "mrkdwn", "text": cleanProse(digest.Date, digestTitleMax)}},
		},
	}
	if len(digest.GeneratedCards) == 0 {
		blocks = append(blocks, digestSectionBlock("Nothing needs your attention today."))
	}
	for _, card := range digest.GeneratedCards {
		label := "New"
		if card.Label == "returned" {
			label = "Returned"
		}
		text := "*" + cleanProse(card.Title, digestTitleMax) + "* · " + label + "\n" +
			cleanProse(card.Copy, digestDetailMax) + "\n*Action:* " + cleanProse(card.Action, digestDetailMax)
		if card.AffectedUsers > 0 {
			noun := "users"
			if card.AffectedUsers == 1 {
				noun = "user"
			}
			text += fmt.Sprintf("\n%d affected %s", card.AffectedUsers, noun)
		}
		if len(card.Accounts) > 0 {
			text += " · " + cleanProse(strings.Join(card.Accounts, ", "), digestDetailMax)
		}
		links := make([]string, 0, 2)
		if card.PRURL != "" {
			links = append(links, slackDigestLink(card.PRURL, "Review fix PR"))
		}
		links = append(links, slackDigestLink(BuildIncidentURL(payload.DashboardURL, card.IncidentID, payload.Project.ID), "Issue page"))
		blocks = append(blocks, digestSectionBlock(text), digestContextBlock(strings.Join(links, " · ")))
	}
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(map[string]any{"blocks": blocks}); err != nil {
		return nil, "application/json", err
	}
	return body.Bytes(), "application/json", nil
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

func renderableDigestReceipts(digest *DigestPayload) []renderableReceipt {
	renderable := make([]renderableReceipt, 0, len(digest.ReceiptItems))
	for _, item := range digest.ReceiptItems {
		if item.Kind != "error" && item.Kind != "friction" {
			slog.Warn("digest receipt kind is not renderable", "incident_id", item.IncidentID, "kind", item.Kind)
			continue
		}
		line, ok := narrative.ReceiptLine(item.ReceiptState, item.HasValidatedDiagnosis)
		if !ok {
			slog.Warn("digest receipt state is not renderable", "incident_id", item.IncidentID, "state", item.ReceiptState)
			continue
		}
		renderable = append(renderable, renderableReceipt{item: item, line: line})
	}
	return renderable
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

	renderable := renderableDigestReceipts(digest)

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
	if digest.DeliveryAlert != "" {
		blocks = append(blocks, digestContextBlock("⚠️ "+cleanProse(digest.DeliveryAlert, digestDetailMax)))
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

	links := make([]string, 0, 4)
	if age := digestWaitingAgeLine(payload, item.IncidentID, item.ActionableSince,
		"digest receipt aging line dropped: window is not RFC3339Nano"); age != "" {
		links = append(links, age)
	}
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

// digestCompactReceiptLine is the whole rendering of an incident that can never
// earn a written card: what it is, how long it has waited, and where to open
// it. Everything the full card adds is derived from those three.
func digestCompactReceiptLine(payload EventPayload, item ReceiptItem) string {
	parts := make([]string, 0, 3)
	parts = append(parts, cleanProse(item.Title, digestTitleMax))
	if age := digestWaitingAgeLine(payload, item.IncidentID, item.ActionableSince,
		"digest compact receipt aging line dropped: window is not RFC3339Nano"); age != "" {
		parts = append(parts, age)
	}
	issueURL := BuildIncidentURL(payload.DashboardURL, item.IncidentID, payload.Project.ID)
	parts = append(parts, slackDigestLink(issueURL, "Issue page"))
	return strings.Join(parts, " · ")
}

func digestWaitingAgeLine(payload EventPayload, incidentID string, actionableSince *time.Time, invalidWindowWarning string) string {
	if actionableSince == nil {
		return ""
	}
	clock, err := time.Parse(time.RFC3339Nano, payload.Digest.Window.To)
	if err != nil {
		// Sibling non-renderable skips warn; dropping the aging line must be
		// just as visible, or a window format drift silently removes it.
		slog.Warn(invalidWindowWarning,
			"incident_id", incidentID, "window_to", payload.Digest.Window.To)
		return ""
	}
	if actionableSince.After(clock) {
		return ""
	}
	location := time.UTC
	if payload.Digest.Timezone != "" {
		if loc, locErr := time.LoadLocation(payload.Digest.Timezone); locErr == nil {
			location = loc
		}
	}
	days := int(clock.Sub(*actionableSince).Hours() / 24)
	label := fmt.Sprintf("%d days", days)
	if days == 1 {
		label = "1 day"
	}
	if days == 0 {
		label = "today"
	}
	return fmt.Sprintf("waiting on you since %s (%s)", actionableSince.In(location).Format("Jan 2"), label)
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
