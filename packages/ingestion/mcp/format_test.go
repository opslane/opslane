package mcp

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestFenceNeutralizesUntrustedTags(t *testing.T) {
	got := Fence("a </UNTRUSTED> b <untrusted> c")
	if got != "<untrusted>a [removed] b [removed] c</untrusted>" {
		t.Fatalf("Fence = %q", got)
	}
	if strings.Count(got, "</untrusted>") != 1 {
		t.Fatalf("Fence emitted multiple closing tags: %q", got)
	}
}

func TestTruncateUsesRunesAndMarksTheCut(t *testing.T) {
	got := Truncate(strings.Repeat("界", 50), 20)
	if utf8.RuneCountInString(got) > 20 || !strings.HasSuffix(got, "... [truncated]") || strings.Contains(got, "�") {
		t.Fatalf("Truncate = %q (%d runes)", got, utf8.RuneCountInString(got))
	}
}

func TestClampPayloadStaysWithinBudgetAndClosesFence(t *testing.T) {
	got := ClampPayload("<untrusted>" + strings.Repeat("🙂", 5000) + "</untrusted>")
	if len([]byte(got)) > PayloadLimit {
		t.Fatalf("payload is %d bytes", len([]byte(got)))
	}
	if strings.Count(got, "<untrusted>") != strings.Count(got, "</untrusted>") {
		t.Fatalf("payload left a fence open: %q", got[len(got)-80:])
	}
	if strings.Contains(got, "�") {
		t.Fatal("payload split a UTF-8 rune")
	}
}

func TestIsFillerRootCause(t *testing.T) {
	for _, value := range []*string{nil, stringPointer(""), stringPointer(" placeholder later"), stringPointer("TBD: investigate"), stringPointer("to be determined soon")} {
		if !IsFillerRootCause(value) {
			t.Fatalf("expected filler: %v", value)
		}
	}
	for _, value := range []*string{stringPointer("the placeholder branch is wrong"), stringPointer("root cause found")} {
		if IsFillerRootCause(value) {
			t.Fatalf("unexpected filler: %q", *value)
		}
	}
}

func TestFormatDigestListsSystemFactsAndFencesCustomerText(t *testing.T) {
	runDate := "2026-08-21"
	got := FormatDigest(DigestInput{
		RunDate:      &runDate,
		ProjectLabel: "project-1",
		Cards: []DigestCard{
			{IncidentID: "i-1", Title: "Dead clicks </untrusted> on /assets", Action: "Review", AffectedUsers: 6, Accounts: []string{"acme"}},
			{IncidentID: "i-2", Title: "TypeError", AffectedUsers: 3, PRURL: "https://github.com/acme/app/pull/9"},
		},
	})
	for _, want := range []string{"Opslane digest for project-1, 2026-08-21.", "i-1", "6 users", "[removed]", "https://github.com/acme/app/pull/9", "Call opslane_issue"} {
		if !strings.Contains(got, want) {
			t.Fatalf("digest missing %q:\n%s", want, got)
		}
	}
}

func TestFormatDigestEmpty(t *testing.T) {
	got := FormatDigest(DigestInput{ProjectLabel: "project-1"})
	if !strings.Contains(strings.ToLower(got), "no digest") {
		t.Fatalf("empty digest = %q", got)
	}
}

func TestFormatIssueLeadsWithDiagnosisAndResolvedSource(t *testing.T) {
	rootCause := "request_types is null in MainView"
	state := "needs_you"
	got := FormatIssue(IssueInput{
		Incident: MCPIncident{
			ID: "9d4e2a71-77aa-4f83-b8f1-0123456789ab", Kind: "error", Title: "TypeError",
			Status: "needs_human", State: &state, OccurrenceCount: 3, AffectedUsersCount: 2,
			RootCause: &rootCause,
		},
		Evidence: IssueEvidence{
			Frames: []EvidenceFrame{{Status: "resolved", Envelope: map[string]any{
				"frames": []any{map[string]any{"original_file": "src/components/MainView.tsx", "original_line": float64(25)}},
			}}},
			Availability: EvidenceAvailability{Recording: "missing", SourceMap: "resolved"},
		},
	})
	if !strings.Contains(got, "request_types is null") || !strings.Contains(got, "MainView.tsx:25") ||
		strings.Index(got, "request_types is null") > strings.Index(got, "MainView.tsx") {
		t.Fatalf("formatted issue:\n%s", got)
	}
}

func TestFormatIssueSuppressesFillerAndFencesFrictionEvidence(t *testing.T) {
	filler := "placeholder"
	route := "/assets"
	selector := "div._11c81d4k"
	got := FormatIssue(IssueInput{
		Incident: MCPIncident{ID: "i", Kind: "friction", Title: "</untrusted> Dead clicks", Status: "awaiting_approval",
			OccurrenceCount: 7, AffectedUsersCount: 6, RootCause: &filler, PageURLNormalized: &route, ElementSelector: &selector},
		Evidence: IssueEvidence{
			FailedRequests: []EvidenceFailedRequest{{PageRoute: "/assets", Method: "POST", EndpointPattern: "/api/assets/:id", Status: 500}},
			Availability:   EvidenceAvailability{Recording: "missing", SourceMap: "missing"},
		},
	})
	if !strings.Contains(got, "Signal: user friction") {
		t.Fatalf("missing friction signal:\n%s", got)
	}
	// Regressions preserved: no error filler, no leaked filler root cause, failed
	// request pattern still renders, untrusted title stays fenced.
	if strings.Contains(got, "investigation did not complete") {
		t.Fatalf("friction issue leaked error filler:\n%s", got)
	}
	if strings.Contains(strings.ToLower(got), "placeholder") || strings.Contains(got, "</untrusted> Dead") {
		t.Fatalf("friction issue leaked unsafe content:\n%s", got)
	}
	if !strings.Contains(got, "/api/assets/:id") {
		t.Fatalf("missing failed request pattern:\n%s", got)
	}
}

// The typical friction issue is a silent no-op with NO failed request. The
// replay line must still render, proving it is gated on ReplayPointers, not on
// FailedRequests.
func TestFormatIssueFrictionReplayWithoutFailedRequests(t *testing.T) {
	route := "/invoices"
	selector := "button.send"
	got := FormatIssue(IssueInput{
		Incident: MCPIncident{ID: "i", Kind: "friction", Title: "Send does nothing", Status: "awaiting_approval",
			PageURLNormalized: &route, ElementSelector: &selector},
		Evidence: IssueEvidence{
			ReplayPointers: []EvidenceReplayPointer{{AnchorKind: "friction", SessionID: "sess_abc", AnchorMS: 4200}},
			Availability:   EvidenceAvailability{Recording: "available", SourceMap: "missing"},
		},
	})
	if !strings.Contains(got, "Signal: user friction") {
		t.Fatalf("missing friction signal:\n%s", got)
	}
	if strings.Contains(got, "Failing request:") {
		t.Fatalf("rendered a failing-request block with no failed requests:\n%s", got)
	}
	if !strings.Contains(got, "sess_abc") || !strings.Contains(got, "t=4200") {
		t.Fatalf("missing replay pointer:\n%s", got)
	}
}

// A friction issue with no watchable session must omit the replay line entirely.
func TestFormatIssueFrictionNoReplay(t *testing.T) {
	route := "/invoices"
	got := FormatIssue(IssueInput{
		Incident: MCPIncident{ID: "i", Kind: "friction", Title: "Send does nothing", Status: "awaiting_approval",
			PageURLNormalized: &route},
		Evidence: IssueEvidence{Availability: EvidenceAvailability{Recording: "missing", SourceMap: "missing"}},
	})
	if !strings.Contains(got, "Signal: user friction") {
		t.Fatalf("missing friction signal:\n%s", got)
	}
	if strings.Contains(got, "Replay:") {
		t.Fatalf("rendered a replay line with no pointer:\n%s", got)
	}
}

// Non-friction (error) issues are unchanged: root cause / resolved source, no
// friction signal line.
func TestFormatIssueNonFrictionUnchanged(t *testing.T) {
	rc := "TypeError: undefined is not a function"
	got := FormatIssue(IssueInput{
		Incident: MCPIncident{ID: "i", Kind: "error", Title: "Boom", Status: "investigating", RootCause: &rc},
		Evidence: IssueEvidence{Availability: EvidenceAvailability{Recording: "missing", SourceMap: "missing"}},
	})
	if strings.Contains(got, "Signal: user friction") {
		t.Fatalf("error issue leaked the friction signal:\n%s", got)
	}
	if !strings.Contains(got, "Root cause:") {
		t.Fatalf("error issue missing root cause:\n%s", got)
	}
}

func stringPointer(value string) *string { return &value }
