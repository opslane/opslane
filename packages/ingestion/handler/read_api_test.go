package handler

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestInboxStateVocabulary(t *testing.T) {
	tests := []struct {
		name, identity, filter, inquiry, diagnosis, status, want string
	}{
		{"pending", "pending", "", "", "", "new", "processing"},
		{"watch", "settled", "watch", "", "", "new", "watching"},
		{"declined", "settled", "open_inquiry", "do_not_pursue", "", "new", "reviewed_not_pursuing"},
		{"waiting", "settled", "open_inquiry", "wait_for_more_evidence", "", "new", "waiting_for_evidence"},
		{"fix", "settled", "open_inquiry", "investigate", "verified_fix", "pr_created", "fix_ready"},
		{"resolved", "settled", "open_inquiry", "investigate", "verified_fix", "resolved", "resolved"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			state, reason := inboxState(test.identity, test.filter, test.inquiry, test.diagnosis, test.status)
			if state != test.want || reason == "" {
				t.Fatalf("state=%q reason=%q, want %q with a reason", state, reason, test.want)
			}
		})
	}
}

func TestIncidentJSON_ReplayID(t *testing.T) {
	id := "11111111-2222-3333-4444-555555555555"
	inc := incidentJSON{ID: "g1", ReplayID: &id}
	b, err := json.Marshal(inc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"replay_id":"`+id+`"`) {
		t.Errorf("expected replay_id in JSON, got %s", string(b))
	}

	inc2 := incidentJSON{ID: "g2"}
	b2, _ := json.Marshal(inc2)
	if strings.Contains(string(b2), "replay_id") {
		t.Errorf("expected replay_id omitted when nil, got %s", string(b2))
	}
}

func TestIncidentJSONIncludesPriorityFields(t *testing.T) {
	score := 4.5
	scoredAt := time.Date(2026, 8, 7, 12, 0, 0, 0, time.UTC)
	inc := toIncidentJSON(db.ErrorGroup{
		PriorityScore:    &score,
		PriorityInputs:   []byte(`{"impact":3,"route_weight":1.5}`),
		PriorityScoredAt: &scoredAt,
	})
	body, err := json.Marshal(inc)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got["priority_score"] != 4.5 || got["priority_scored_at"] != "2026-08-07T12:00:00Z" {
		t.Fatalf("priority fields = %s", body)
	}
	inputs, ok := got["priority_inputs"].(map[string]any)
	if !ok || inputs["impact"] != float64(3) {
		t.Fatalf("priority inputs = %#v", got["priority_inputs"])
	}
}

func TestIncidentJSONIncludesKind(t *testing.T) {
	inc := toIncidentJSON(db.ErrorGroup{Kind: "friction"})
	b, err := json.Marshal(inc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"kind":"friction"`) {
		t.Errorf("expected friction kind in JSON, got %s", string(b))
	}
}

func TestToIncidentJSON_Platform(t *testing.T) {
	platform := "python"
	inc := toIncidentJSON(db.ErrorGroup{Platform: &platform})
	if inc.Platform == nil || *inc.Platform != "python" {
		t.Fatalf("platform = %v, want python", inc.Platform)
	}
	if got := toIncidentJSON(db.ErrorGroup{}); got.Platform != nil {
		t.Fatalf("friction incident platform should marshal as absent, got %v", got.Platform)
	}
}

func TestIncidentJSON_IncludesVerificationEvidenceAndCandidateDiff(t *testing.T) {
	diff := "diff --git a/src/a.ts b/src/a.ts"
	inc := toIncidentJSON(db.ErrorGroup{
		VerificationEvidence: []byte(`{"version":1,"tier":"E0","checks":[]}`),
		CandidateDiff:        &diff,
	})
	body, err := json.Marshal(inc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	evidence, ok := got["verification_evidence"].(map[string]any)
	if !ok || evidence["tier"] != "E0" {
		t.Fatalf("verification_evidence = %#v, want tier E0", got["verification_evidence"])
	}
	if got["candidate_diff"] != diff {
		t.Fatalf("candidate_diff = %#v, want %q", got["candidate_diff"], diff)
	}
}

func TestIncidentJSON_ImpactAndStory(t *testing.T) {
	stringPtr := func(value string) *string { return &value }
	intPtr := func(value int64) *int64 { return &value }
	tests := []struct {
		name       string
		group      db.ErrorGroup
		wantStory  string
		wantImpact bool
	}{
		{
			name:      "valid error impact",
			group:     db.ErrorGroup{Kind: "error", OccurrenceCount: 12, ImpactClass: stringPtr("degraded"), ImpactVisits: intPtr(3), ImpactVisitsRecovered: intPtr(1)},
			wantStory: "12 crashes across 3 visits, 1 of 3 visits recovered", wantImpact: true,
		},
		{name: "unknown impact", group: db.ErrorGroup{Kind: "error", OccurrenceCount: 12}, wantStory: "12 crashes; recording impact unavailable"},
		{
			name:      "corrupt impact",
			group:     db.ErrorGroup{Kind: "error", OccurrenceCount: 12, ImpactClass: stringPtr("degraded"), ImpactVisits: intPtr(3), ImpactVisitsRecovered: intPtr(5)},
			wantStory: "12 crashes; recording impact unavailable",
		},
		{name: "friction nouns", group: db.ErrorGroup{Kind: "friction", OccurrenceCount: 2}, wantStory: "2 friction signals; recording impact unavailable"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, err := json.Marshal(toIncidentJSON(tt.group))
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(body, &got); err != nil {
				t.Fatal(err)
			}
			if got["story"] != tt.wantStory {
				t.Fatalf("story = %#v, want %q", got["story"], tt.wantStory)
			}
			_, hasClass := got["impact_class"]
			_, hasVisits := got["impact_visits"]
			_, hasRecovered := got["impact_visits_recovered"]
			if hasClass != tt.wantImpact || hasVisits != tt.wantImpact || hasRecovered != tt.wantImpact {
				t.Fatalf("impact presence = %v/%v/%v, want %v: %s", hasClass, hasVisits, hasRecovered, tt.wantImpact, body)
			}
		})
	}
}

func TestReceiptStateFor(t *testing.T) {
	ptr := func(value string) *string { return &value }
	eligible, pending, ineligible := ptr("eligible"), ptr("pending"), ptr("ineligible")
	tests := []struct {
		name  string
		group db.ErrorGroup
		inc   incidentJSON
		want  string
	}{
		{"draft PR", db.ErrorGroup{Status: "pr_draft", PrURL: ptr("https://github.com/o/r/pull/1"), InvestigationReadiness: eligible}, incidentJSON{}, "pr_open"},
		{"ineligible PR", db.ErrorGroup{Status: "pr_draft", PrURL: ptr("https://github.com/o/r/pull/1"), InvestigationReadiness: ineligible}, incidentJSON{}, ""},
		{"missing PR URL", db.ErrorGroup{Status: "pr_created", InvestigationReadiness: eligible}, incidentJSON{}, ""},
		{"blank PR URL", db.ErrorGroup{Status: "pr_created", PrURL: ptr("   "), InvestigationReadiness: eligible}, incidentJSON{}, ""},
		{"unsafe PR URL", db.ErrorGroup{Status: "pr_created", PrURL: ptr("javascript:x"), InvestigationReadiness: eligible}, incidentJSON{}, ""},
		{"failed with diff", db.ErrorGroup{Status: "needs_human", HasSavedDiff: true, InvestigationReadiness: eligible}, incidentJSON{}, "attempt_failed_with_diff"},
		{"failed with report", db.ErrorGroup{Status: "needs_human", FixAttempted: true, InvestigationReadiness: eligible}, incidentJSON{RootCause: ptr("cause")}, "attempt_failed_no_diff"},
		// A dead-lettered investigation leaves its own job id in
		// terminal_fix_job_id. No fix ran, so the page must not say one failed.
		{"report with no fix attempt", db.ErrorGroup{Status: "needs_human", InvestigationReadiness: eligible}, incidentJSON{RootCause: ptr("cause")}, "report_ready"},
		{"blank report", db.ErrorGroup{Status: "needs_human", InvestigationReadiness: eligible}, incidentJSON{RootCause: ptr(" \n ")}, ""},
		{"failed no report", db.ErrorGroup{Status: "needs_human", InvestigationReadiness: eligible}, incidentJSON{}, ""},
		{"pending with diff", db.ErrorGroup{Status: "needs_human", HasSavedDiff: true, InvestigationReadiness: pending}, incidentJSON{}, ""},
		{"investigated brief", db.ErrorGroup{Status: "investigated", InvestigationReadiness: eligible}, incidentJSON{AgentTaskBrief: ptr("brief")}, "report_ready"},
		{"investigated no report", db.ErrorGroup{Status: "investigated", InvestigationReadiness: eligible}, incidentJSON{}, ""},
		{"approval cause", db.ErrorGroup{Status: "awaiting_approval", InvestigationReadiness: eligible}, incidentJSON{RootCause: ptr("cause")}, "report_ready"},
		{"fixing", db.ErrorGroup{Status: "fixing", InvestigationReadiness: eligible}, incidentJSON{RootCause: ptr("cause")}, ""},
		{"resolved", db.ErrorGroup{Status: "resolved", InvestigationReadiness: eligible}, incidentJSON{RootCause: ptr("cause")}, ""},
		{"unknown", db.ErrorGroup{Status: "future", InvestigationReadiness: eligible}, incidentJSON{RootCause: ptr("cause")}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := receiptStateFor(tt.group, tt.inc)
			if got != tt.want || ok != (tt.want != "") {
				t.Fatalf("receipt = %q/%v, want %q", got, ok, tt.want)
			}
		})
	}
}

func TestIncidentJSON_SessionPointer(t *testing.T) {
	inc := incidentJSON{
		ID: "g1",
		SessionPointer: &sessionPointerJSON{
			SessionID: "sess_12345678",
			ErrorAt:   "2026-07-15T10:00:00Z",
		},
	}
	body, err := json.Marshal(inc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(body), `"session_pointer":{"session_id":"sess_12345678","error_at":"2026-07-15T10:00:00Z"}`) {
		t.Fatalf("session pointer missing from %s", body)
	}

	without, err := json.Marshal(incidentJSON{ID: "g2"})
	if err != nil {
		t.Fatalf("marshal without pointer: %v", err)
	}
	if strings.Contains(string(without), "session_pointer") {
		t.Fatalf("nil session pointer was not omitted: %s", without)
	}
}

func TestIncidentJSON_AdjudicationFields(t *testing.T) {
	envID := "env-123"
	status := "unchecked"
	inc := toIncidentJSON(db.ErrorGroup{
		Kind:               "friction",
		EnvironmentID:      &envID,
		AdjudicationStatus: &status,
	})
	data, err := json.Marshal(inc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"environment_id":"env-123"`) {
		t.Errorf("expected environment_id in %s", data)
	}
	if !strings.Contains(string(data), `"adjudication_status":"unchecked"`) {
		t.Errorf("expected adjudication_status in %s", data)
	}
}

func TestIncidentJSON_AdjudicationFieldsOmittedForErrors(t *testing.T) {
	inc := toIncidentJSON(db.ErrorGroup{Kind: "error"})
	data, err := json.Marshal(inc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(data), "environment_id") ||
		strings.Contains(string(data), "adjudication_status") {
		t.Errorf("error incidents must omit adjudication fields, got %s", data)
	}
}

func TestFilterSensitiveHeaders(t *testing.T) {
	in := map[string]json.RawMessage{"content-type": json.RawMessage(`"application/json"`)}
	for _, k := range []string{
		"Authorization", "PROXY-AUTHORIZATION", "authentication",
		"Cookie", "set-cookie", "x-api-key", "X-CSRF-Token",
		"x-auth-token", "X-Access-Token", "x-amz-security-token",
		"Private-Token", "x-gitlab-token", "X-Vault-Token",
		"x-goog-api-key", "X-Refresh-Token", "x-session-token", "X-Session-Id",
	} {
		in[k] = json.RawMessage(`"secret"`)
	}
	out := filterSensitiveHeaders(in)
	if len(out) != 1 {
		t.Fatalf("expected only content-type to survive, got %v", out)
	}
	if _, ok := out["content-type"]; !ok {
		t.Fatal("benign header must survive")
	}
}

func TestSanitizeSampleContext_NonObjectRequest(t *testing.T) {
	out := sanitizeSampleContext([]byte(`{"request":"GET /users/42","other":"ok"}`))
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatalf("sanitized context is not an object: %v (%s)", err, out)
	}
	if _, exists := decoded["request"]; exists {
		t.Fatalf("non-object request must be dropped, got %s", out)
	}
	if string(decoded["other"]) != `"ok"` {
		t.Fatalf("benign sibling field clobbered: %s", out)
	}
}
