package notify

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
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

func TestFormatSlackDigestV2Golden(t *testing.T) {
	visits, recovered := int64(3), int64(0)
	payload := EventPayload{
		Version: 1, EventType: "digest.daily",
		Project: ProjectRef{ID: "p1", Name: "Acme"}, DashboardURL: "https://dash.example",
		Digest: &DigestPayload{
			SchemaVersion: 2, Date: "2026-08-12",
			TriageCounts: &DigestTriageCounts{PRsAwaitingReview: 1, NeedsDecision: 3},
			ReceiptItems: []ReceiptItem{
				{Kind: "error", IncidentID: "pr", Title: "Checkout crashes", OccurrenceCount: 12,
					ImpactClass: "blocked", ImpactVisits: &visits, ImpactRecovered: &recovered,
					ReceiptState: "pr_open", PRURL: "https://github.example/pr/1",
					SessionURL: "https://dash.example/sessions/s1", RootCauseExcerpt: "Cart was nil."},
				{Kind: "error", IncidentID: "draft", Title: "Draft fix", ReceiptState: "pr_draft",
					PRURL: "https://github.example/pr/draft"},
				{Kind: "friction", IncidentID: "approval", Title: "Approval needed", ReceiptState: "awaiting_approval"},
				{Kind: "error", IncidentID: "diff", Title: "Saved diff", ReceiptState: "attempt_failed_with_diff"},
				{Kind: "error", IncidentID: "no-diff", Title: "No diff", ReceiptState: "attempt_failed_no_diff"},
				{Kind: "friction", IncidentID: "report", Title: "Checkout friction", OccurrenceCount: 2,
					ReceiptState: "report_ready"},
				{Kind: "error", IncidentID: "caused", Title: "Cause established", OccurrenceCount: 3,
					ReceiptState: "report_ready", HasValidatedDiagnosis: true},
			},
			Watching: DigestWatching{Sessions: 20, Users: 7},
		},
	}
	body, _, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	for _, want := range []string{
		"1 fix PR awaiting review, 3 issues need a decision.",
		"12 crashes across 3 visits, no visit recovered",
		"2 friction signals; recording impact unavailable",
		"Fix PR ready for review.",
		"A draft fix PR needs your review.",
		"A fix is written and needs your approval.",
		"Fix attempt failed its checks; saved diff and report on the issue page.",
		"Fix attempt failed before producing a change; investigation report on the issue page.",
		"We could not establish a cause. Details in the issue.",
		"Cause found; no fix opened yet. Details in the issue.",
		"Review fix PR", "Review draft PR",
		"<https://github.example/pr/draft|Review draft PR>",
		"Watch recording", "Issue page", "Investigation: Cart was nil.",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("v2 digest missing %q: %s", want, s)
		}
	}
	if strings.Contains(s, "Where customers struggled") || strings.Contains(s, "older issues still awaiting") {
		t.Fatalf("legacy copy leaked into v2: %s", s)
	}
}

func TestFormatSlackDigestV2QuietAndFooters(t *testing.T) {
	payload := EventPayload{
		Version: 1, EventType: "digest.daily", Project: ProjectRef{ID: "p", Name: "p"},
		Digest: &DigestPayload{
			SchemaVersion: 2, Date: "2026-08-12",
			TriageCounts:  &DigestTriageCounts{PRsAwaitingReview: 2, NeedsDecision: 3},
			HeldBackCount: 1, ReceiptOverflow: 4,
			Watching: DigestWatching{Sessions: 9, Users: 4},
		},
	}
	body, _, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	for _, want := range []string{
		"2 fix PRs awaiting review, 3 issues need a decision, nothing else needs you today.",
		"Held back: 1 item without a verified receipt yet.",
		"4 more receipts ranked below these — open the dashboard for the full list.",
		"Watched 9 sessions across 4 users",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("quiet v2 digest missing %q: %s", want, s)
		}
	}
}

func TestFormatSlackDigestV3RendersAuthoredActionAndReturnedLabel(t *testing.T) {
	payload := EventPayload{
		Version: 1, EventType: "digest.daily", RunID: "run-1",
		Project: ProjectRef{ID: "p1", Name: "Shop"}, DashboardURL: "https://app.example",
		Digest: &DigestPayload{Date: "2026-08-20", SchemaVersion: 3,
			GeneratedCards: []GeneratedDigestCard{{
				EpisodeID: "ep-2", IncidentID: "issue-1", Title: "Checkout failed",
				Label: "returned", Copy: "Checkout fails before payment.",
				Action: "Review the verified fix", AffectedUsers: 4,
				Accounts: []string{"Acme"}, PRURL: "https://github.com/acme/shop/pull/42",
			}}},
	}
	body, _, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, want := range []string{"Returned", "Checkout fails before payment.", "Review the verified fix", "Acme", "pull/42"} {
		if !strings.Contains(text, want) {
			t.Errorf("v3 digest omitted %q: %s", want, text)
		}
	}
}

func formatV4Blocks(t *testing.T, payload EventPayload) ([]map[string]any, string) {
	t.Helper()
	body, _, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Blocks []map[string]any `json:"blocks"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded.Blocks, string(body)
}

func blockText(block map[string]any) string {
	if text, ok := block["text"].(map[string]any); ok {
		if value, ok := text["text"].(string); ok {
			return value
		}
	}
	if elements, ok := block["elements"].([]any); ok && len(elements) > 0 {
		if element, ok := elements[0].(map[string]any); ok {
			if value, ok := element["text"].(string); ok {
				return value
			}
		}
	}
	return ""
}

func TestFormatSlackDigestV4NativeLayout(t *testing.T) {
	payload := EventPayload{
		Version: 1, EventType: "digest.daily", Project: ProjectRef{ID: "p1", Name: "Acme Invoicing"},
		DashboardURL: "https://app.example",
		Digest: &DigestPayload{SchemaVersion: 4, Date: "2026-08-24", GeneratedCards: []GeneratedDigestCard{
			{IncidentID: "decision-1", Title: "Send invoice does nothing", Outcome: "needs_human", Copy: "18 people tried to send an invoice and couldn't. The request stopped before saving.", Action: "Watch the replay and choose whether to retry.", AffectedUsers: 18, Accounts: []string{"Northwind Traders", "Globex"}, ReplayURL: "https://app.example/sessions/s1?t=4200"},
			{IncidentID: "fix-1", Title: "Checkout stops before payment", Outcome: "verified_fix", Copy: "4 people couldn't pay. The cart failed to load.", Action: "Review and merge the fix.", AffectedUsers: 4, PRURL: "https://github.com/acme/shop/pull/6", PRNumber: 6},
			{IncidentID: "decision-2", Title: "Export never starts", Outcome: "needs_human", Copy: "1 person couldn't export data.", Action: "Choose the safe fallback.", AffectedUsers: 1},
			{IncidentID: "fix-2", Title: "Search results disappear", Outcome: "verified_fix", Copy: "2 people couldn't search.", Action: "Review and merge the fix.", AffectedUsers: 2, PRURL: "https://github.com/acme/shop/pull/not-a-number"},
			{IncidentID: "fix-3", Title: "Profile fails to save", Outcome: "verified_fix", Copy: "3 people couldn't save a profile.", Action: "Confirm the remediation.", AffectedUsers: 3},
		}},
	}
	blocks, body := formatV4Blocks(t, payload)
	if got := blockText(blocks[0]); got != "Daily digest · Acme Invoicing" {
		t.Fatalf("header = %q", got)
	}
	if got := blockText(blocks[1]); got != "Aug 24 · 5 issues that matter · 2 need a decision · 3 fixes ready to merge" {
		t.Fatalf("summary = %q", got)
	}
	decisionHeader := strings.Index(body, "Needs a decision")
	decisionCard := strings.Index(body, "Send invoice does nothing")
	fixHeader := strings.Index(body, "Fixes ready to merge")
	fixCard := strings.Index(body, "Checkout stops before payment")
	if !(decisionHeader < decisionCard && decisionCard < fixHeader && fixHeader < fixCard) {
		t.Fatalf("outcome groups rendered out of order: %s", body)
	}
	for _, want := range []string{
		"*Send invoice does nothing*\\n18 people tried to send an invoice and couldn't. The request stopped before saving.\\n*Needs you:* Watch the replay and choose whether to retry.",
		"👥 18 users · Northwind Traders, Globex", "Watch replay", "Review PR #6", "Review fix PR", "*Ready:* Review and merge the fix.",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("v4 digest missing %q: %s", want, body)
		}
	}
	if strings.Contains(body, "Watched") || strings.Contains(body, "only opens a PR") {
		t.Fatalf("legacy footer leaked into v4: %s", body)
	}

	labelsByIncident := map[string][]string{}
	currentIncident := ""
	for _, block := range blocks {
		text := blockText(block)
		for _, incident := range []string{"decision-1", "decision-2", "fix-1", "fix-2", "fix-3"} {
			if strings.Contains(text, strings.TrimSuffix(map[string]string{
				"decision-1": "Send invoice does nothing", "decision-2": "Export never starts", "fix-1": "Checkout stops before payment", "fix-2": "Search results disappear", "fix-3": "Profile fails to save",
			}[incident], "")) {
				currentIncident = incident
			}
		}
		if block["type"] != "actions" {
			continue
		}
		for _, raw := range block["elements"].([]any) {
			button := raw.(map[string]any)
			labelsByIncident[currentIncident] = append(labelsByIncident[currentIncident], button["text"].(map[string]any)["text"].(string))
			if strings.HasPrefix(button["action_id"].(string), "digest_replay_") || strings.HasPrefix(button["action_id"].(string), "digest_pr_") {
				if button["style"] != "primary" {
					t.Errorf("primary action lacks style: %+v", button)
				}
			}
		}
	}
	if got := labelsByIncident["decision-2"]; len(got) != 1 || got[0] != "View issue" {
		t.Errorf("decision without replay buttons = %v", got)
	}
	if got := labelsByIncident["fix-3"]; len(got) != 1 || got[0] != "View issue" {
		t.Errorf("remediation-only fix buttons = %v", got)
	}
}

func TestFormatSlackDigestV4SessionIntelligence(t *testing.T) {
	payload := EventPayload{
		Version: 1, EventType: "digest.daily", Project: ProjectRef{ID: "p1", Name: "Shop"},
		DashboardURL: "https://app.example",
		Digest: &DigestPayload{SchemaVersion: 4, Date: "2026-08-31", GeneratedCards: []GeneratedDigestCard{{
			IncidentID: "friction-1", Kind: "friction", Outcome: "needs_human",
			Title: "Save feedback is unclear", Copy: "People could not tell whether saving worked.", Action: "Review the replay.",
			FrictionCategory: "no_feedback_after_action", Route: "/assets", SessionCount: 3, IdentifiedCount: 2,
			ObservationQuote: "The save button produced no visible confirmation.",
		}}},
	}

	_, body := formatV4Blocks(t, payload)
	for _, want := range []string{"Session intelligence", "/assets · 3 sessions (2 identified)", "Save feedback is unclear"} {
		if !strings.Contains(body, want) {
			t.Fatalf("session intelligence digest missing %q: %s", want, body)
		}
	}
	if strings.Contains(body, "friction signals") || strings.Contains(body, "no_feedback_after_action") {
		t.Fatalf("session intelligence exposed implementation vocabulary: %s", body)
	}
}

func TestFormatSlackDigestV4RendersAuthoredFrictionCard(t *testing.T) {
	clock := time.Date(2026, 8, 27, 9, 0, 0, 0, time.UTC)
	actionableSince := clock.Add(-3 * 24 * time.Hour)
	payload := EventPayload{
		Version: 1, EventType: "digest.daily", Project: ProjectRef{ID: "p1", Name: "Shop"},
		DashboardURL: "https://app.example",
		Digest: &DigestPayload{
			SchemaVersion: 4, Date: "2026-08-27",
			Window: DigestWindow{To: clock.Format(time.RFC3339)},
			GeneratedCards: []GeneratedDigestCard{{
				IncidentID: "friction-1", Kind: "friction", Title: "Checkout button does nothing",
				Outcome: "needs_human", Copy: "People try to continue but the checkout remains unchanged.",
				Action: "Watch the replay and review the investigation.", SignalCount: 17,
				ActionableSince: &actionableSince, ReplayURL: "https://app.example/sessions/s1?t=4200",
			}},
		},
	}
	_, body := formatV4Blocks(t, payload)
	for _, want := range []string{
		"People try to continue but the checkout remains unchanged.",
		"17 friction signals",
		"waiting on you since Aug 24 (3 days)",
		"Watch replay",
		"Issue page",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("authored friction card missing %q: %s", want, body)
		}
	}
	if strings.Contains(body, "👥") {
		t.Fatalf("zero-user friction card rendered people context: %s", body)
	}
}

func TestFormatSlackDigestV4ErrorCardSnapshotIsUnchanged(t *testing.T) {
	payload := EventPayload{
		Version: 1, EventType: "digest.daily", Project: ProjectRef{ID: "p1", Name: "Shop"},
		DashboardURL: "https://app.example",
		Digest: &DigestPayload{SchemaVersion: 4, Date: "2026-08-27", GeneratedCards: []GeneratedDigestCard{{
			IncidentID: "error-1", Title: "Checkout fails", Outcome: "needs_human",
			Copy: "Checkout stops before payment.", Action: "Review the investigation.",
			AffectedUsers: 2, Accounts: []string{"Acme"}, ReplayURL: "https://app.example/sessions/s1",
		}}},
	}
	payload.Digest.GeneratedCards[0].Kind = "error"
	body, _, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"blocks":[{"text":{"emoji":true,"text":"Daily digest · Shop","type":"plain_text"},"type":"header"},{"elements":[{"text":"Aug 27 · 1 issue that matters · 1 needs a decision","type":"mrkdwn"}],"type":"context"},{"text":{"text":"⚠️ *Needs a decision*","type":"mrkdwn"},"type":"section"},{"text":{"text":"*Checkout fails*\nCheckout stops before payment.\n*Needs you:* Review the investigation.","type":"mrkdwn"},"type":"section"},{"elements":[{"text":"👥 2 users · Acme","type":"mrkdwn"}],"type":"context"},{"elements":[{"action_id":"digest_replay_0","style":"primary","text":{"emoji":true,"text":"Watch replay","type":"plain_text"},"type":"button","url":"https://app.example/sessions/s1"},{"action_id":"digest_issue_0","text":{"emoji":true,"text":"View issue","type":"plain_text"},"type":"button","url":"https://app.example/incidents/error-1?project_id=p1"}],"type":"actions"}]}
`
	if string(body) != want {
		t.Fatalf("error card snapshot changed:\nwant: %s\n got: %s", want, body)
	}
}

func TestFormatSlackDigestV4CapsMergedKindsOnceWithinSlackBlockLimit(t *testing.T) {
	clock := time.Date(2026, 8, 27, 9, 0, 0, 0, time.UTC)
	actionableSince := clock.Add(-24 * time.Hour)
	cards := make([]GeneratedDigestCard, 0, 12)
	for index := range 12 {
		kind := "error"
		if index%2 == 0 {
			kind = "friction"
		}
		cards = append(cards, GeneratedDigestCard{
			IncidentID: "issue-" + strconv.Itoa(index), Kind: kind, Title: "Problem " + strconv.Itoa(index),
			Outcome: "needs_human", Copy: "People cannot complete the flow.", Action: "Review the investigation.",
			AffectedUsers: 1, SignalCount: int64(index + 1), ActionableSince: &actionableSince,
			ReplayURL: "https://app.example/sessions/s1",
		})
	}
	payload := EventPayload{
		Version: 1, EventType: "digest.daily", Project: ProjectRef{ID: "p", Name: "p"}, DashboardURL: "https://app.example",
		Digest: &DigestPayload{SchemaVersion: 4, Date: "2026-08-27", Window: DigestWindow{To: clock.Format(time.RFC3339)}, GeneratedCards: cards, OverflowCount: 3},
	}
	blocks, body := formatV4Blocks(t, payload)
	if got := strings.Count(body, "more on the dashboard"); got != 1 {
		t.Fatalf("overflow rendered %d times: %s", got, body)
	}
	if !strings.Contains(body, "And 3 more on the dashboard") {
		t.Fatalf("merged overflow count missing: %s", body)
	}
	if strings.Contains(body, "Problem 9") || strings.Contains(body, "Problem 10") || strings.Contains(body, "Problem 11") {
		t.Fatalf("card past merged cap rendered: %s", body)
	}
	if len(blocks) >= 50 {
		t.Fatalf("maximum-card digest has %d Slack blocks; want fewer than 50", len(blocks))
	}
}

func TestFormatSlackDigestV4SummaryEmptyAndOverflow(t *testing.T) {
	one := EventPayload{Version: 1, EventType: "digest.daily", Project: ProjectRef{ID: "p", Name: "p"}, DashboardURL: "https://app.example",
		Digest: &DigestPayload{SchemaVersion: 4, Date: "2026-08-24", GeneratedCards: []GeneratedDigestCard{{IncidentID: "i", Outcome: "needs_human", Title: "Problem", Copy: "It broke.", Action: "Decide.", AffectedUsers: 1}}}}
	blocks, body := formatV4Blocks(t, one)
	if got := blockText(blocks[1]); got != "Aug 24 · 1 issue that matters · 1 needs a decision" {
		t.Fatalf("singular summary = %q", got)
	}
	if strings.Contains(body, "fix ready") {
		t.Fatalf("empty fixes fragment rendered: %s", body)
	}

	empty := one
	empty.Digest = &DigestPayload{SchemaVersion: 4, Date: "2026-08-24"}
	blocks, body = formatV4Blocks(t, empty)
	if len(blocks) != 3 || blockText(blocks[1]) != "Aug 24" || !strings.Contains(body, "Nothing needs your attention today.") {
		t.Fatalf("empty digest = %s", body)
	}

	cards := make([]GeneratedDigestCard, 12)
	for index := range cards {
		cards[index] = GeneratedDigestCard{IncidentID: "issue-" + strconv.Itoa(index), Outcome: "needs_human", Title: "Problem " + strconv.Itoa(index), Copy: "It broke.", Action: "Decide."}
	}
	overflow := one
	overflow.Digest = &DigestPayload{SchemaVersion: 4, Date: "2026-08-24", GeneratedCards: cards}
	blocks, body = formatV4Blocks(t, overflow)
	actions := 0
	for _, block := range blocks {
		if block["type"] == "actions" {
			actions++
		}
	}
	if actions != 9 || !strings.Contains(body, "And 3 more on the dashboard") || len(blocks) > 50 {
		t.Fatalf("overflow rendering: actions=%d blocks=%d body=%s", actions, len(blocks), body)
	}
}

func TestFormatSlackDigestV4RendersActionableReceiptAgeAndDeliveryAlert(t *testing.T) {
	clock := time.Date(2026, 8, 25, 9, 0, 0, 0, time.UTC)
	actionableSince := clock.Add(-12 * 24 * time.Hour)
	payload := EventPayload{
		Version: 1, EventType: "digest.daily", Project: ProjectRef{ID: "p", Name: "Shop"},
		DashboardURL: "https://app.example",
		Digest: &DigestPayload{
			SchemaVersion: 4, Date: "2026-08-25",
			Window: DigestWindow{From: clock.Add(-24 * time.Hour).Format(time.RFC3339), To: clock.Format(time.RFC3339)},
			ReceiptItems: []ReceiptItem{{
				Kind: "friction", IncidentID: "friction-1", Title: "Checkout button does nothing",
				OccurrenceCount: 17, ReceiptState: "awaiting_approval",
				HasValidatedDiagnosis: true, ActionableSince: &actionableSince,
			}},
			DeliveryAlert: "1 item is pending but could not be rendered",
		},
	}
	_, body := formatV4Blocks(t, payload)
	for _, want := range []string{
		"1 issue that matters · 1 needs a decision",
		"Checkout button does nothing",
		"waiting on you since Aug 13 (12 days)",
		"1 item is pending but could not be rendered",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("v4 actionable digest missing %q: %s", want, body)
		}
	}
}

func TestDigestReceiptAgeLineBoundaries(t *testing.T) {
	clock := time.Date(2026, 8, 25, 9, 0, 0, 0, time.UTC)
	tests := []struct {
		name  string
		stamp *time.Time
		want  string
	}{
		{name: "one day", stamp: func() *time.Time { v := clock.Add(-24 * time.Hour); return &v }(), want: "waiting on you since Aug 24 (1 day)"},
		{name: "today", stamp: func() *time.Time { v := clock.Add(-2 * time.Hour); return &v }(), want: "waiting on you since Aug 25 (today)"},
		{name: "future", stamp: func() *time.Time { v := clock.Add(time.Minute); return &v }()},
		{name: "nil"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			payload := EventPayload{Version: 1, EventType: "digest.daily", Project: ProjectRef{ID: "p", Name: "p"},
				Digest: &DigestPayload{SchemaVersion: 4, Date: "2026-08-25", Window: DigestWindow{To: clock.Format(time.RFC3339)},
					ReceiptItems: []ReceiptItem{{Kind: "error", IncidentID: "i", Title: "Issue", ReceiptState: "awaiting_approval", HasValidatedDiagnosis: true, ActionableSince: tc.stamp}}}}
			_, body := formatV4Blocks(t, payload)
			if tc.want != "" && !strings.Contains(body, tc.want) {
				t.Fatalf("missing %q: %s", tc.want, body)
			}
			if tc.want == "" && strings.Contains(body, "waiting on you since") {
				t.Fatalf("unexpected age line: %s", body)
			}
		})
	}
}

func TestFormatSlackDigestV4CleansProseAndKeepsButtonURLPlain(t *testing.T) {
	payload := EventPayload{Version: 1, EventType: "digest.daily", Project: ProjectRef{ID: "p", Name: "p"}, DashboardURL: "https://app.example",
		Digest: &DigestPayload{SchemaVersion: 4, Date: "bad-date", GeneratedCards: []GeneratedDigestCard{{
			IncidentID: "i", Outcome: "needs_human", Title: "<fake> & *bold*", Copy: "user@example.com\nforged", Action: "Choose <now>.", ReplayURL: "https://app.example/sessions/s1?token=secret",
		}}}}
	_, body := formatV4Blocks(t, payload)
	if strings.Contains(body, "<fake>") || strings.Contains(body, "user@example.com") || !strings.Contains(body, "&lt;fake&gt;") {
		t.Fatalf("prose was not cleaned: %s", body)
	}
	if strings.Contains(body, "&amp;token") || !strings.Contains(body, `"url":"https://app.example/sessions/s1`) {
		t.Fatalf("button URL was mrkdwn-escaped or omitted: %s", body)
	}
	if !strings.Contains(body, "bad-date") {
		t.Fatalf("raw invalid date fallback missing: %s", body)
	}
}

func TestFormatSlackDigestV2SkipsUnsupportedItems(t *testing.T) {
	for _, item := range []ReceiptItem{
		{Kind: "cluster", IncidentID: "cluster", Title: "cluster", ReceiptState: "report_ready"},
		{Kind: "widget", IncidentID: "widget", Title: "widget", ReceiptState: "report_ready"},
		{Kind: "error", IncidentID: "future", Title: "future", ReceiptState: "future_state"},
	} {
		payload := EventPayload{Version: 1, EventType: "digest.daily", Project: ProjectRef{ID: "p", Name: "p"},
			Digest: &DigestPayload{SchemaVersion: 2, ReceiptItems: []ReceiptItem{item}}}
		body, _, err := FormatSlack(payload)
		if err != nil {
			t.Fatal(err)
		}
		s := string(body)
		if !strings.Contains(s, "nothing else needs you today") || strings.Contains(s, item.Title) {
			t.Fatalf("unsupported item was not treated as quiet: %s", s)
		}
	}
}

func TestFormatSlackDigestV2CleansCapturedProse(t *testing.T) {
	dirty := "user@example.com *claimed* https://customer.example/pay\n• forged " + strings.Repeat("界", 500)
	payload := EventPayload{
		Version: 1, EventType: "digest.daily", Project: ProjectRef{ID: "p", Name: "p"},
		DashboardURL: "https://dash.example",
		Digest: &DigestPayload{SchemaVersion: 2, ReceiptItems: []ReceiptItem{{
			Kind: "error", IncidentID: "i", Title: dirty, ReceiptState: "report_ready",
			RootCauseExcerpt: dirty,
		}}},
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
		blockMap := block.(map[string]any)
		text, ok := blockMap["text"].(map[string]any)
		if !ok {
			continue
		}
		value := text["text"].(string)
		if !strings.Contains(value, "Investigation:") {
			continue
		}
		if strings.Contains(value, "user@example.com") || strings.Contains(value, "https://customer.example") || strings.Contains(value, "*claimed*") {
			t.Fatalf("dirty captured prose survived: %s", value)
		}
		if len([]rune(value)) > sectionMax {
			t.Fatalf("card section exceeds Slack budget: %d", len([]rune(value)))
		}
		if strings.Count(value, "\n• ") != 0 {
			t.Fatalf("captured prose forged a line: %s", value)
		}
		return
	}
	t.Fatal("receipt card section not found")
}

func TestFormatSlackDigestV1CapturedPayloadStillRenders(t *testing.T) {
	raw, err := os.ReadFile("testdata/digest_payload_v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var payload EventPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	body, _, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	for _, want := range []string{"Where customers struggled", "New errors customers hit", "older issues still awaiting your review"} {
		if !strings.Contains(s, want) {
			t.Errorf("captured v1 payload missing legacy copy %q: %s", want, s)
		}
	}
}

func TestFormatSlackUnknownEventTypeErrors(t *testing.T) {
	_, _, err := FormatSlack(EventPayload{EventType: "mystery.event"})
	if err == nil {
		t.Fatal("expected error for unknown event type")
	}
}

// v4CapFixture builds a payload with the given number of decision cards and
// receipts; both fixtures below differ only in the mode flag.
func v4CapFixture(cards, receipts, receiptOverflow int, unified bool) EventPayload {
	generated := make([]GeneratedDigestCard, 0, cards)
	for index := range cards {
		generated = append(generated, GeneratedDigestCard{
			IncidentID: "card-" + strconv.Itoa(index), Kind: "error",
			Title: "Card " + strconv.Itoa(index), Outcome: "needs_human",
			Copy: "People cannot complete the flow.", Action: "Review the investigation.",
		})
	}
	items := make([]ReceiptItem, 0, receipts)
	for index := range receipts {
		items = append(items, ReceiptItem{
			Kind: "error", IncidentID: "receipt-" + strconv.Itoa(index),
			Title: "Receipt " + strconv.Itoa(index), OccurrenceCount: 4,
			ReceiptState: "report_ready", HasValidatedDiagnosis: true,
		})
	}
	return EventPayload{
		Version: 1, EventType: "digest.daily", Project: ProjectRef{ID: "p", Name: "p"},
		DashboardURL: "https://app.example",
		Digest: &DigestPayload{
			SchemaVersion: 4, Date: "2026-08-27", GeneratedCards: generated,
			ReceiptItems: items, ReceiptOverflow: receiptOverflow, UnifiedCards: unified,
		},
	}
}

// TestFormatSlackDigestV4OffCapsGeneratedCardsOnly pins OFF against
// origin/main: the render budget covers generated cards, receipts render below
// them without competing for it, and the receipt lane keeps its own overflow
// line. OFF is the rollback path, so this output may not drift.
func TestFormatSlackDigestV4OffCapsGeneratedCardsOnly(t *testing.T) {
	blocks, body := formatV4Blocks(t, v4CapFixture(12, 5, 4, false))
	for index := range DigestV4CardCap {
		if !strings.Contains(body, "Card "+strconv.Itoa(index)+"*") {
			t.Fatalf("card %d below the cap was dropped: %s", index, body)
		}
	}
	for _, index := range []int{9, 10, 11} {
		if strings.Contains(body, "Card "+strconv.Itoa(index)+"*") {
			t.Fatalf("card %d past the cap rendered: %s", index, body)
		}
	}
	for index := range 5 {
		if !strings.Contains(body, "Receipt "+strconv.Itoa(index)+"*") {
			t.Fatalf("receipt %d lost the render budget to cards: %s", index, body)
		}
	}
	if !strings.Contains(body, "And 3 more on the dashboard") {
		t.Fatalf("card overflow line missing: %s", body)
	}
	if !strings.Contains(body, "4 more receipts ranked below these") {
		t.Fatalf("receipt overflow line missing: %s", body)
	}
	if len(blocks) >= 50 {
		t.Fatalf("OFF digest has %d Slack blocks; want fewer than 50", len(blocks))
	}
}

// TestFormatSlackDigestV4OnCapsCardsAndReceiptsTogether is the ON contract: one
// list of incidents, one budget, one overflow line.
func TestFormatSlackDigestV4OnCapsCardsAndReceiptsTogether(t *testing.T) {
	blocks, body := formatV4Blocks(t, v4CapFixture(6, 5, 0, true))
	rendered := strings.Count(body, "Card ") + strings.Count(body, "Receipt ")
	if rendered != DigestV4CardCap {
		t.Fatalf("ON rendered %d items, want the merged cap %d: %s", rendered, DigestV4CardCap, body)
	}
	if got := strings.Count(body, "more on the dashboard"); got != 1 {
		t.Fatalf("overflow rendered %d times: %s", got, body)
	}
	if !strings.Contains(body, "And 2 more on the dashboard") {
		t.Fatalf("merged overflow line missing: %s", body)
	}
	if strings.Contains(body, "ranked below these") {
		t.Fatalf("ON rendered a second receipt overflow line: %s", body)
	}
	if len(blocks) >= 50 {
		t.Fatalf("ON digest has %d Slack blocks; want fewer than 50", len(blocks))
	}
}
