package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/masking"
	"github.com/opslane/opslane/packages/ingestion/narrative"
)

// incidentJSON is the JSON representation of an incident, matching the
// Incident type in shared/src/types.ts. Fields use snake_case.
type incidentJSON struct {
	ID                     string                    `json:"id"`
	ProjectID              string                    `json:"project_id"`
	Fingerprint            string                    `json:"fingerprint"`
	Title                  string                    `json:"title"`
	Status                 string                    `json:"status"`
	Kind                   string                    `json:"kind"`
	Platform               *string                   `json:"platform,omitempty"`
	EnvironmentID          *string                   `json:"environment_id,omitempty"`
	AdjudicationStatus     *string                   `json:"adjudication_status,omitempty"`
	SignalType             *string                   `json:"signal_type,omitempty"`
	ElementSelector        *string                   `json:"element_selector,omitempty"`
	PageURLNormalized      *string                   `json:"page_url_normalized,omitempty"`
	WatchableSession       *watchableSessionJSON     `json:"watchable_session,omitempty"`
	FirstSeen              string                    `json:"first_seen"`
	LastSeen               string                    `json:"last_seen"`
	OccurrenceCount        int                       `json:"occurrence_count"`
	AffectedUsersCount     int                       `json:"affected_users_count"`
	Confidence             *string                   `json:"confidence,omitempty"`
	PrURL                  *string                   `json:"pr_url,omitempty"`
	ReplayID               *string                   `json:"replay_id,omitempty"`
	SessionPointer         *sessionPointerJSON       `json:"session_pointer,omitempty"`
	Reason                 *needsHumanReason         `json:"reason,omitempty"`
	RootCause              *string                   `json:"root_cause,omitempty"`
	SuggestedMitigation    *string                   `json:"suggested_mitigation,omitempty"`
	InvestigationReadiness *string                   `json:"investigation_readiness,omitempty"`
	AgentTaskBrief         *string                   `json:"agent_task_brief,omitempty"`
	VerificationEvidence   json.RawMessage           `json:"verification_evidence,omitempty"`
	CandidateDiff          *string                   `json:"candidate_diff,omitempty"`
	ImpactClass            *string                   `json:"impact_class,omitempty"`
	ImpactVisits           *int64                    `json:"impact_visits,omitempty"`
	ImpactRecovered        *int64                    `json:"impact_visits_recovered,omitempty"`
	Story                  string                    `json:"story"`
	ReceiptState           *string                   `json:"receipt_state,omitempty"`
	ReceiptLine            *string                   `json:"receipt_line,omitempty"`
	Recordings             []incidentRecordingJSON   `json:"recordings,omitempty"`
	PriorityScore          *float64                  `json:"priority_score,omitempty"`
	PriorityInputs         json.RawMessage           `json:"priority_inputs,omitempty"`
	PriorityScoredAt       *time.Time                `json:"priority_scored_at,omitempty"`
	MergedAt               *string                   `json:"merged_at,omitempty"`
	ResolvedAt             *string                   `json:"resolved_at,omitempty"`
	ArchivedAt             *string                   `json:"archived_at,omitempty"`
	TraceURL               *string                   `json:"trace_url,omitempty"`
	Environments           []incidentEnvironmentJSON `json:"environments,omitempty"`
	EpisodeID              *string                   `json:"episode_id,omitempty"`
	State                  string                    `json:"state,omitempty"`
	StateReason            string                    `json:"state_reason,omitempty"`
	StateDecidedAt         *string                   `json:"state_decided_at,omitempty"`
	EvidenceEventIDs       []string                  `json:"evidence_event_ids,omitempty"`
	PendingIdentity        bool                      `json:"pending_identity,omitempty"`
}

type incidentRecordingJSON struct {
	SessionID  string `json:"session_id"`
	StartedAt  string `json:"started_at"`
	DurationMs int64  `json:"duration_ms"`
	CrashCount int64  `json:"crash_count"`
	AnchorMs   int64  `json:"anchor_ms"`
}

// watchableSessionJSON points at a session whose scrubbed chunks span the
// playback window. AnchorMs is absolute client-clock epoch milliseconds, which
// is the dashboard's ?t= contract. Unlike Recordings, this is populated for
// friction incidents too.
type watchableSessionJSON struct {
	SessionID string `json:"session_id"`
	AnchorMs  int64  `json:"anchor_ms"`
}

type incidentEnvironmentJSON struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	OccurrenceCount int64  `json:"occurrence_count"`
	LastSeen        string `json:"last_seen"`
}

type sessionPointerJSON struct {
	SessionID string `json:"session_id"`
	ErrorAt   string `json:"error_at"`
}

type needsHumanReason struct {
	ReasonCode    string `json:"reason_code"`
	ReasonMessage string `json:"reason_message"`
	Remediation   string `json:"remediation"`
}

type sampleEventJSON struct {
	Timestamp   string          `json:"timestamp"`
	Platform    string          `json:"platform"`
	Error       sampleErrorJSON `json:"error"`
	Breadcrumbs json.RawMessage `json:"breadcrumbs"`
	Context     json.RawMessage `json:"context"`
}

type sampleErrorJSON struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	Stack   string `json:"stack"`
}

// fmtTimePtr formats a nullable time as an RFC3339 string pointer.
func fmtTimePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format(time.RFC3339)
	return &s
}

func toIncidentJSON(g db.ErrorGroup) incidentJSON {
	inc := incidentJSON{
		ID:                     g.ID,
		ProjectID:              g.ProjectID,
		Fingerprint:            g.Fingerprint,
		Title:                  g.Title,
		Status:                 g.Status,
		Kind:                   g.Kind,
		Platform:               g.Platform,
		EnvironmentID:          g.EnvironmentID,
		AdjudicationStatus:     g.AdjudicationStatus,
		SignalType:             g.SignalType,
		ElementSelector:        g.ElementSelector,
		PageURLNormalized:      g.PageURLNormalized,
		FirstSeen:              g.FirstSeen.Format(time.RFC3339),
		LastSeen:               g.LastSeen.Format(time.RFC3339),
		OccurrenceCount:        g.OccurrenceCount,
		AffectedUsersCount:     g.AffectedUsersCount,
		Confidence:             g.Confidence,
		PrURL:                  g.PrURL,
		RootCause:              g.RootCause,
		SuggestedMitigation:    g.SuggestedMitigation,
		InvestigationReadiness: g.InvestigationReadiness,
		CandidateDiff:          g.CandidateDiff,
		PriorityScore:          g.PriorityScore,
		PriorityScoredAt:       g.PriorityScoredAt,
		MergedAt:               fmtTimePtr(g.MergedAt),
		ResolvedAt:             fmtTimePtr(g.ResolvedAt),
		ArchivedAt:             fmtTimePtr(g.ArchivedAt),
	}
	if g.InvestigationReadiness != nil &&
		(*g.InvestigationReadiness == "ineligible" || *g.InvestigationReadiness == "pending") {
		inc.RootCause = nil
		inc.SuggestedMitigation = nil
	}
	impact := narrative.Impact{Visits: g.ImpactVisits, Recovered: g.ImpactVisitsRecovered}
	if g.ImpactClass != nil {
		impact.Class = *g.ImpactClass
	}
	noun, nouns := "crash", "crashes"
	if g.Kind == "friction" {
		noun, nouns = "friction signal", "friction signals"
	}
	inc.Story = narrative.Story(noun, nouns, int64(g.OccurrenceCount), impact)
	if impact.Valid() {
		inc.ImpactClass = g.ImpactClass
		inc.ImpactVisits = g.ImpactVisits
		inc.ImpactRecovered = g.ImpactVisitsRecovered
	}
	if len(g.VerificationEvidence) > 0 {
		inc.VerificationEvidence = json.RawMessage(g.VerificationEvidence)
	}
	if len(g.PriorityInputs) > 0 {
		inc.PriorityInputs = json.RawMessage(g.PriorityInputs)
	}
	if g.ReasonCode != nil && g.ReasonMessage != nil && g.Remediation != nil {
		inc.Reason = &needsHumanReason{
			ReasonCode:    *g.ReasonCode,
			ReasonMessage: *g.ReasonMessage,
			Remediation:   *g.Remediation,
		}
	}
	return inc
}

// inboxState translates storage stages into customer vocabulary.
func inboxState(identity, filterDecision, inquiryDecision, diagnosisOutcome, groupStatus string) (state, reason string) {
	switch {
	case identity == "pending":
		return "processing", "working out which problem this belongs to"
	case groupStatus == "resolved":
		return "resolved", "closed"
	case inquiryDecision == "do_not_pursue":
		return "reviewed_not_pursuing", "reviewed and not selected for investigation"
	case inquiryDecision == "wait_for_more_evidence":
		return "waiting_for_evidence", "waiting for more evidence"
	case inquiryDecision == "investigate" && diagnosisOutcome == "verified_fix":
		return "fix_ready", "a change is verified and waiting for your review"
	case inquiryDecision == "investigate" && diagnosisOutcome == "needs_human":
		return "needs_you", "your input is needed to continue"
	case inquiryDecision == "investigate" && diagnosisOutcome == "unable_to_establish_cause":
		return "reviewed_not_pursuing", "we could not establish a cause"
	case inquiryDecision == "investigate":
		return "investigating", "tracing the cause"
	case filterDecision == "open_inquiry":
		return "reviewing_evidence", "deciding whether this is worth investigating"
	case filterDecision == "inactive":
		return "inactive", "stopped occurring before it advanced"
	default:
		return "watching", "waiting for enough recent affected people or sessions"
	}
}

func attachPipelineState(incident *incidentJSON, record db.IssuePipelineRecord) {
	incident.EpisodeID = nil
	if record.EpisodeID != "" {
		incident.EpisodeID = &record.EpisodeID
	}
	// An issue with no episode has no pipeline state to report: every issue
	// grouped before the rewrite, and every friction bucket. Reporting one
	// anyway lands on the default arm, which claims a PR-bearing legacy issue
	// is waiting for reach and hides it from the inbox's primary list.
	// Archived issues keep their own label for the same reason: their last
	// pipeline decision is real but no longer what the reader should act on.
	if record.EpisodeID == "" || incident.Status == "archived" {
		return
	}
	state, reason := inboxState("settled", record.FilterDecision, record.InquiryDecision, record.DiagnosisOutcome, incident.Status)
	switch state {
	case "reviewed_not_pursuing", "waiting_for_evidence":
		if record.InquiryReason != "" {
			reason = record.InquiryReason
		}
	case "needs_you":
		if record.DiagnosisReason != "" {
			reason = record.DiagnosisReason
		}
	case "watching", "inactive":
		if record.FilterReason != "" {
			reason = record.FilterReason
		}
	}
	incident.State = state
	incident.StateReason = reason
	incident.EvidenceEventIDs = record.EvidenceEventIDs
	incident.StateDecidedAt = fmtTimePtr(record.DecidedAt)
}

// projectJSON is the JSON representation of a project for the dashboard API.
type projectJSON struct {
	ID                   string   `json:"id"`
	Name                 string   `json:"name"`
	GithubRepo           *string  `json:"github_repo"`
	FrictionAutonomy     string   `json:"friction_autonomy"`
	PrPosture            string   `json:"pr_posture"`
	DefaultEnvironmentID *string  `json:"default_environment_id"`
	ActionScopeEnabled   bool     `json:"action_scope_enabled"`
	ActionEnvironmentIDs []string `json:"action_environment_ids"`
	DigestTimezone       string   `json:"digest_timezone"`
	CreatedAt            string   `json:"created_at"`
}

func toProjectJSON(p db.Project, actionScopeEnabled bool, actionEnvironmentIDs []string) projectJSON {
	if actionEnvironmentIDs == nil {
		actionEnvironmentIDs = []string{}
	}
	return projectJSON{
		ID:                   p.ID,
		Name:                 p.Name,
		GithubRepo:           p.GithubRepo,
		FrictionAutonomy:     p.FrictionAutonomy,
		PrPosture:            p.PrPosture,
		DefaultEnvironmentID: p.DefaultEnvironmentID,
		ActionScopeEnabled:   actionScopeEnabled,
		ActionEnvironmentIDs: actionEnvironmentIDs,
		DigestTimezone:       p.DigestTimezone,
		CreatedAt:            p.CreatedAt.Format(time.RFC3339),
	}
}

// ListProjects returns all projects for the authenticated user's org.
func (d *Dependencies) ListProjects(w http.ResponseWriter, r *http.Request) {
	orgID := OrgIDFromCtx(r.Context())
	if orgID == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	projects, err := d.Queries.ListProjectsByOrg(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list projects")
		return
	}

	scopes, err := d.Queries.GetActionScopesByOrg(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to load project action scopes")
		return
	}

	result := make([]projectJSON, 0, len(projects))
	for _, p := range projects {
		scope := scopes[p.ID]
		result = append(result, toProjectJSON(p, scope.Enabled, scope.EnvironmentIDs))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// verifyProjectAccess checks that the authenticated identity has access to the given project.
// SDK auth: projectID must match the authenticated project (project-scoped).
// Session auth: project's org must match the authenticated org (org-scoped).
func (d *Dependencies) verifyProjectAccess(w http.ResponseWriter, r *http.Request, projectID string) bool {
	ok, status, message := d.checkProjectAccess(r.Context(), projectID)
	if !ok {
		writeJSONError(w, status, message)
	}
	return ok
}

// checkProjectAccess is the shared project-authorization core. The SDK branch
// remains exact-project scoped; the session branch remains active-org scoped.
func (d *Dependencies) checkProjectAccess(ctx context.Context, projectID string) (bool, int, string) {
	// SDK auth path: ProjectIDFromCtx is set
	if authProjectID := ProjectIDFromCtx(ctx); authProjectID != "" {
		if authProjectID != projectID {
			return false, http.StatusForbidden, "project mismatch"
		}
		return true, 0, ""
	}

	// Session auth path: org-scoped check (tenant boundary enforced at query layer)
	orgID := OrgIDFromCtx(ctx)
	if orgID == "" {
		return false, http.StatusUnauthorized, "authentication required"
	}
	project, err := d.Queries.GetProjectByOrgID(ctx, orgID, projectID)
	if err != nil {
		return false, http.StatusInternalServerError, "failed to verify project access"
	}
	if project == nil {
		return false, http.StatusForbidden, "project not found or does not belong to your organization"
	}
	return true, 0, ""
}

// ListIncidents returns incidents (error groups) for a project with optional filters.
func (d *Dependencies) ListIncidents(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")

	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	// Parse optional query param filters
	var filters *db.ErrorGroupFilters
	accountID := r.URL.Query().Get("account_id")
	endUserID := r.URL.Query().Get("end_user_id")
	status := r.URL.Query().Get("status")
	platform := r.URL.Query().Get("platform")
	if platform != "" && !rePlatformToken.MatchString(platform) {
		writeJSONError(w, http.StatusBadRequest, "invalid platform")
		return
	}
	kind := r.URL.Query().Get("kind")
	if kind != "" && kind != "friction" && kind != "error" {
		writeJSONError(w, http.StatusBadRequest, "kind must be 'friction' or 'error'")
		return
	}
	environmentID := r.URL.Query().Get("environment_id")
	if environmentID != "" {
		if _, err := uuid.Parse(environmentID); err != nil {
			writeJSONError(w, http.StatusBadRequest, "environment_id must be a valid UUID")
			return
		}
		environmentProjectID, err := d.Queries.VerifyEnvironmentAccess(
			r.Context(), OrgIDFromCtx(r.Context()), environmentID,
		)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to verify environment access")
			return
		}
		if environmentProjectID != projectID {
			writeJSONError(w, http.StatusNotFound, "environment not found")
			return
		}
	}
	if accountID != "" || endUserID != "" || status != "" || environmentID != "" || platform != "" || kind != "" {
		filters = &db.ErrorGroupFilters{
			AccountID:     accountID,
			EndUserID:     endUserID,
			Status:        status,
			Platform:      platform,
			Kind:          kind,
			EnvironmentID: nil,
		}
		if environmentID != "" {
			filters.EnvironmentID = &environmentID
		}
	}

	groups, err := d.Queries.ListErrorGroups(r.Context(), projectID, filters)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list incidents")
		return
	}

	incidents := make([]incidentJSON, 0, len(groups))
	groupIDs := make([]string, 0, len(groups))
	for _, group := range groups {
		groupIDs = append(groupIDs, group.ID)
	}
	pipeline, err := d.Queries.IssuePipelineRecords(r.Context(), projectID, groupIDs)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to load issue pipeline state")
		return
	}
	for _, g := range groups {
		incident := toIncidentJSON(g)
		attachPipelineState(&incident, pipeline[g.ID])
		incidents = append(incidents, incident)
	}
	// Pending observations have no canonical issue yet and therefore cannot be
	// produced by ListErrorGroups. Include them in the unfiltered inbox.
	if filters == nil {
		pending, err := d.Queries.PendingIdentities(r.Context(), projectID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to load processing observations")
			return
		}
		for _, identity := range pending {
			platform := identity.Platform
			environmentID := identity.EnvironmentID
			incidents = append(incidents, incidentJSON{
				ID: identity.EventID, ProjectID: projectID, Fingerprint: identity.Fingerprint,
				Title: identity.Title, Status: "new", Kind: "error", Platform: &platform,
				EnvironmentID: &environmentID, FirstSeen: identity.ObservedAt.Format(time.RFC3339),
				LastSeen: identity.ObservedAt.Format(time.RFC3339), OccurrenceCount: 1,
				AffectedUsersCount: 0, Story: "1 crash observed.", State: "processing",
				StateReason: "working out which problem this belongs to", PendingIdentity: true,
				EvidenceEventIDs: []string{identity.EventID},
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(incidents)
}

// GetIncident returns a single incident (error group) by ID.
func (d *Dependencies) GetIncident(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")

	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	incidentID := chi.URLParam(r, "incidentID")
	group, err := d.Queries.GetErrorGroup(r.Context(), projectID, incidentID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to get incident")
		return
	}
	if group == nil {
		writeJSONError(w, http.StatusNotFound, "incident not found")
		return
	}

	inc := toIncidentJSON(*group)
	if pipeline, err := d.Queries.IssuePipelineRecords(r.Context(), projectID, []string{incidentID}); err == nil {
		attachPipelineState(&inc, pipeline[incidentID])
	}
	if group.InvestigationReadiness != nil && *group.InvestigationReadiness == "eligible" {
		if brief, err := d.Queries.GetLatestAgentTaskBrief(r.Context(), projectID, incidentID); err == nil && brief != nil {
			inc.AgentTaskBrief = brief
		}
	}
	d.attachReceiptAndRecordings(r.Context(), projectID, incidentID, *group, &inc)
	environments, err := d.Queries.ListGroupEnvironments(r.Context(), projectID, incidentID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to get incident environments")
		return
	}
	inc.Environments = make([]incidentEnvironmentJSON, 0, len(environments))
	for _, environment := range environments {
		inc.Environments = append(inc.Environments, incidentEnvironmentJSON{
			ID:              environment.ID,
			Name:            environment.Name,
			OccurrenceCount: environment.OccurrenceCount,
			LastSeen:        environment.LastSeen.Format(time.RFC3339),
		})
	}

	// Attach latest job trace URL (best-effort, non-fatal)
	traceURL, err := d.Queries.GetLatestJobTraceURL(r.Context(), projectID, incidentID)
	if err == nil && traceURL != nil {
		inc.TraceURL = traceURL
	}

	// Attach the linked replay id (best-effort, non-fatal). Dashboard loads the
	// replay itself via the replay-retrieval endpoint (Project D). ReplayIDForGroup
	// ranks matches by precision (group > event > session) over recency.
	if replayID, err := d.Queries.ReplayIDForGroup(r.Context(), incidentID, projectID); err == nil && replayID != "" {
		inc.ReplayID = &replayID
	}
	// Pointer identity is valid before any chunk becomes readable. Readers poll
	// manifest readiness; the incident contract must not hide processing sessions.
	if sessionID, errorAt, ok, err := d.Queries.SessionPointerForGroup(r.Context(), incidentID, projectID); err == nil && ok {
		inc.SessionPointer = &sessionPointerJSON{SessionID: sessionID, ErrorAt: errorAt.Format(time.RFC3339)}
	}
	// Best-effort, exactly like the pointer above: missing playback evidence
	// costs the field, never the response. RecordingsForGroup returns nil for
	// friction by design, so this is the only friction recording pointer.
	if sessionID, anchorMs, ok, err := d.Queries.WatchableSessionForGroup(r.Context(), incidentID, projectID); err == nil && ok {
		inc.WatchableSession = &watchableSessionJSON{SessionID: sessionID, AnchorMs: anchorMs}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(inc)
}

// attachReceiptAndRecordings adds the detail-only receipt framing and the
// coverage-proven recordings list to an incident response. Every endpoint
// that returns a single incident (GET and the lifecycle actions, whose
// response the dashboard assigns straight back into its page state) must
// attach these, or the sections vanish from the page after the action.
// Both surfaces are best-effort: a failure costs the section, never the
// response.
func (d *Dependencies) attachReceiptAndRecordings(ctx context.Context, projectID, incidentID string, g db.ErrorGroup, inc *incidentJSON) {
	if state, ok := receiptStateFor(g, *inc); ok {
		lineKey := state
		if state == "pr_open" && g.Status == "pr_draft" {
			lineKey = "pr_open_draft"
		}
		if line, lineOK := narrative.PageReceiptLine(lineKey); lineOK {
			inc.ReceiptState = &state
			inc.ReceiptLine = &line
		}
	}
	if recordings, err := d.Queries.RecordingsForGroup(ctx, incidentID, projectID); err != nil {
		slog.Warn("failed to attach incident recordings", "project_id", projectID, "incident_id", incidentID, "error", err)
	} else if len(recordings) > 0 {
		inc.Recordings = make([]incidentRecordingJSON, 0, len(recordings))
		for _, recording := range recordings {
			inc.Recordings = append(inc.Recordings, incidentRecordingJSON{
				SessionID:  recording.SessionID,
				StartedAt:  recording.StartedAt.Format(time.RFC3339),
				DurationMs: recording.DurationMs,
				CrashCount: recording.CrashCount,
				AnchorMs:   recording.AnchorMs,
			})
		}
	}
}

func receiptStateFor(g db.ErrorGroup, inc incidentJSON) (string, bool) {
	if g.InvestigationReadiness == nil || *g.InvestigationReadiness != "eligible" {
		return "", false
	}
	present := func(value *string) bool {
		return value != nil && strings.TrimSpace(*value) != ""
	}
	hasReport := present(inc.RootCause) || present(inc.AgentTaskBrief)
	switch g.Status {
	case "pr_created", "pr_draft":
		if present(g.PrURL) && isHTTPURL(strings.TrimSpace(*g.PrURL)) {
			return "pr_open", true
		}
	case "needs_human":
		if g.HasSavedDiff {
			return "attempt_failed_with_diff", true
		}
		if hasReport {
			return "attempt_failed_no_diff", true
		}
	case "investigated", "insight", "awaiting_approval":
		if hasReport {
			return "report_ready", true
		}
	}
	return "", false
}

func isHTTPURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Host != "" && (parsed.Scheme == "http" || parsed.Scheme == "https")
}

func filterSensitiveHeaders(headers map[string]json.RawMessage) map[string]json.RawMessage {
	filtered := make(map[string]json.RawMessage, len(headers))
	for name, value := range headers {
		if !masking.IsSensitiveHeader(name) {
			filtered[name] = value
		}
	}
	return filtered
}

func sanitizeSampleContext(raw []byte) json.RawMessage {
	redacted := masking.RedactContext(raw)
	var contextObject map[string]json.RawMessage
	if err := json.Unmarshal(redacted, &contextObject); err != nil || contextObject == nil {
		return json.RawMessage(`{}`)
	}

	requestRaw, hasRequest := contextObject["request"]
	if hasRequest {
		var requestObject map[string]json.RawMessage
		if err := json.Unmarshal(requestRaw, &requestObject); err != nil || requestObject == nil {
			delete(contextObject, "request")
		} else {
			if headersRaw, hasHeaders := requestObject["headers"]; hasHeaders {
				var headersObject map[string]json.RawMessage
				if err := json.Unmarshal(headersRaw, &headersObject); err != nil || headersObject == nil {
					delete(requestObject, "headers")
				} else if filtered, err := json.Marshal(filterSensitiveHeaders(headersObject)); err == nil {
					requestObject["headers"] = filtered
				} else {
					delete(requestObject, "headers")
				}
			}
			if encoded, err := json.Marshal(requestObject); err == nil {
				contextObject["request"] = encoded
			} else {
				delete(contextObject, "request")
			}
		}
	}

	encoded, err := json.Marshal(contextObject)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}

func normalizeSampleBreadcrumbs(raw []byte) json.RawMessage {
	redacted := masking.RedactBreadcrumbs(raw)
	var breadcrumbs []json.RawMessage
	if err := json.Unmarshal(redacted, &breadcrumbs); err != nil || breadcrumbs == nil {
		return json.RawMessage(`[]`)
	}
	return redacted
}

// GetSampleEvent returns the representative error event for an incident.
func (d *Dependencies) GetSampleEvent(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	incidentID := chi.URLParam(r, "incidentID")
	event, err := d.Queries.GetSampleEvent(r.Context(), projectID, incidentID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSONError(w, http.StatusNotFound, "no sample event")
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to get sample event")
		return
	}

	response := sampleEventJSON{
		Timestamp: event.Timestamp.Format(time.RFC3339),
		Platform:  event.Platform,
		// Error text is persisted verbatim (grouping fingerprints the raw
		// values), so redact on the way out: exception messages and stack
		// frames are common carriers of leaked tokens, DSNs, and JWTs.
		Error: sampleErrorJSON{
			Type:    masking.RedactBody(event.ErrorType),
			Message: masking.RedactURL(masking.RedactBody(event.ErrorMessage)),
			Stack:   masking.RedactURL(masking.RedactBody(event.StackTraceRaw)),
		},
		Breadcrumbs: normalizeSampleBreadcrumbs(event.Breadcrumbs),
		Context:     sanitizeSampleContext(event.Context),
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// === B2B endpoints ===

type affectedUserJSON struct {
	EndUserID         string  `json:"end_user_id"`
	ExternalUserID    string  `json:"external_user_id"`
	Email             *string `json:"email,omitempty"`
	ExternalAccountID *string `json:"external_account_id,omitempty"`
	FirstSeen         string  `json:"first_seen"`
	LastSeen          string  `json:"last_seen"`
	OccurrenceCount   int     `json:"occurrence_count"`
}

type accountJSON struct {
	ExternalAccountID string  `json:"external_account_id"`
	AccountName       *string `json:"account_name,omitempty"`
	UserCount         int     `json:"user_count"`
	IncidentCount     int     `json:"incident_count"`
	LastSeen          string  `json:"last_seen"`
}

// ListAffectedUsers returns end users affected by a specific incident.
func (d *Dependencies) ListAffectedUsers(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	incidentID := chi.URLParam(r, "incidentID")
	// No candidate — ordinary or unchecked — exposes affected users (issue
	// #56): the endpoint 404s rather than returning an empty list, matching
	// the detail API's treatment of hidden rows.
	group, err := d.Queries.GetErrorGroup(r.Context(), projectID, incidentID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to load incident")
		return
	}
	if group == nil || group.Status == "candidate" {
		writeJSONError(w, http.StatusNotFound, "incident not found")
		return
	}
	users, err := d.Queries.ListAffectedUsers(r.Context(), projectID, incidentID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list affected users")
		return
	}

	result := make([]affectedUserJSON, 0, len(users))
	for _, u := range users {
		result = append(result, affectedUserJSON{
			EndUserID:         u.EndUserID,
			ExternalUserID:    u.ExternalUserID,
			Email:             u.Email,
			ExternalAccountID: u.ExternalAccountID,
			FirstSeen:         u.FirstSeen.Format(time.RFC3339),
			LastSeen:          u.LastSeen.Format(time.RFC3339),
			OccurrenceCount:   u.OccurrenceCount,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// ListAccounts returns aggregated B2B accounts for a project.
func (d *Dependencies) ListAccounts(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	var queryPtr *string
	if q := r.URL.Query().Get("q"); q != "" {
		queryPtr = &q
	}

	accounts, err := d.Queries.ListAccounts(r.Context(), projectID, queryPtr)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list accounts")
		return
	}

	result := make([]accountJSON, 0, len(accounts))
	for _, a := range accounts {
		result = append(result, accountJSON{
			ExternalAccountID: a.ExternalAccountID,
			AccountName:       a.AccountName,
			UserCount:         a.UserCount,
			IncidentCount:     a.IncidentCount,
			LastSeen:          a.LastSeen.Format(time.RFC3339),
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// GetAccount returns a single account's details.
func (d *Dependencies) GetAccount(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	accountID := chi.URLParam(r, "accountID")
	a, err := d.Queries.GetAccountByID(r.Context(), projectID, accountID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to get account")
		return
	}
	if a == nil {
		writeJSONError(w, http.StatusNotFound, "account not found")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(accountJSON{
		ExternalAccountID: a.ExternalAccountID,
		AccountName:       a.AccountName,
		UserCount:         a.UserCount,
		IncidentCount:     a.IncidentCount,
		LastSeen:          a.LastSeen.Format(time.RFC3339),
	})
}

// ListAccountIncidents returns incidents filtered by account.
func (d *Dependencies) ListAccountIncidents(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	accountID := chi.URLParam(r, "accountID")
	filters := &db.ErrorGroupFilters{AccountID: accountID}

	groups, err := d.Queries.ListErrorGroups(r.Context(), projectID, filters)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list account incidents")
		return
	}

	incidents := make([]incidentJSON, 0, len(groups))
	for _, g := range groups {
		incidents = append(incidents, toIncidentJSON(g))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(incidents)
}

// === Onboarding CRUD endpoints ===

// CreateProjectEndpoint creates a new project for the authenticated user's org.
// POST /api/v1/projects
func (d *Dependencies) CreateProjectEndpoint(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !onboardingLimiter.allow(ip) {
		writeJSONError(w, http.StatusTooManyRequests, "too many requests, try again later")
		return
	}

	orgID := OrgIDFromCtx(r.Context())

	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req struct {
		Name             string `json:"name"`
		GithubRepo       string `json:"github_repo"`
		IdempotencyToken string `json:"idempotency_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name == "" {
		writeJSONError(w, http.StatusBadRequest, "name is required")
		return
	}
	if len(req.Name) > 100 {
		writeJSONError(w, http.StatusBadRequest, "name must be 100 characters or less")
		return
	}
	if strings.TrimSpace(req.IdempotencyToken) == "" {
		writeJSONError(w, http.StatusBadRequest, "idempotency_token is required")
		return
	}
	if len(req.IdempotencyToken) > 128 {
		writeJSONError(w, http.StatusBadRequest, "idempotency_token must be 128 characters or less")
		return
	}

	var githubRepo *string
	if req.GithubRepo != "" {
		githubRepo = &req.GithubRepo
	}

	provisioning, err := d.Queries.ProvisionProject(
		r.Context(), orgID, req.Name, githubRepo, req.IdempotencyToken,
	)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create project")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{
		"project": toProjectJSON(provisioning.Project, false, []string{}),
		"environment": environmentJSON{
			ID:        provisioning.Environment.ID,
			ProjectID: provisioning.Environment.ProjectID,
			Name:      provisioning.Environment.Name,
			CreatedAt: provisioning.Environment.CreatedAt.Format(time.RFC3339),
		},
		"api_key": map[string]any{
			"id":      provisioning.APIKey.ID,
			"raw_key": provisioning.APIKey.Raw,
		},
	})
}

// UpdateProjectEndpoint updates a project's settings.
// PATCH /api/v1/projects/{projectID}
func (d *Dependencies) UpdateProjectEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	orgID := OrgIDFromCtx(r.Context())

	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req struct {
		GithubRepo           *string         `json:"github_repo"`
		FrictionAutonomy     *string         `json:"friction_autonomy"`
		PrPosture            *string         `json:"pr_posture"`
		DefaultEnvironmentID json.RawMessage `json:"default_environment_id"`
		ActionEnvironmentIDs json.RawMessage `json:"action_environment_ids"`
		DigestTimezone       *string         `json:"digest_timezone"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.FrictionAutonomy != nil {
		switch *req.FrictionAutonomy {
		case "ask_first", "auto_fix", "auto_fix_ux":
		default:
			writeJSONError(w, http.StatusBadRequest,
				"friction_autonomy must be one of ask_first, auto_fix, auto_fix_ux")
			return
		}
	}
	if req.PrPosture != nil {
		switch *req.PrPosture {
		case "verified_only", "draft_when_unverified":
		default:
			writeJSONError(w, http.StatusBadRequest,
				"pr_posture must be one of verified_only, draft_when_unverified")
			return
		}
	}
	if req.DigestTimezone != nil {
		// "" resolves to UTC and "Local" to the server process's zone; neither is
		// an IANA name, and "Local" would make replicas in different zones derive
		// different digest dates for the same project.
		if *req.DigestTimezone == "" || *req.DigestTimezone == "Local" {
			writeJSONError(w, http.StatusBadRequest, "digest_timezone must be a valid IANA zone name")
			return
		}
		if _, err := time.LoadLocation(*req.DigestTimezone); err != nil {
			writeJSONError(w, http.StatusBadRequest, "digest_timezone must be a valid IANA zone name")
			return
		}
	}
	var defaultEnvironmentID *string
	if req.DefaultEnvironmentID != nil {
		if string(req.DefaultEnvironmentID) == "null" {
			writeJSONError(w, http.StatusBadRequest, "default_environment_id must be a UUID string")
			return
		}
		var value string
		if err := json.Unmarshal(req.DefaultEnvironmentID, &value); err != nil {
			writeJSONError(w, http.StatusBadRequest, "default_environment_id must be a UUID string")
			return
		}
		if _, err := uuid.Parse(value); err != nil {
			writeJSONError(w, http.StatusBadRequest, "default_environment_id must be a UUID string")
			return
		}
		defaultEnvironmentID = &value
	}
	var actionEnvironmentIDs *[]string
	actionScopeTouched := req.ActionEnvironmentIDs != nil
	if actionScopeTouched && string(req.ActionEnvironmentIDs) != "null" {
		var values []string
		if err := json.Unmarshal(req.ActionEnvironmentIDs, &values); err != nil || values == nil {
			writeJSONError(w, http.StatusBadRequest, "action_environment_ids must be null or an array of UUID strings")
			return
		}
		for _, value := range values {
			if _, err := uuid.Parse(value); err != nil {
				writeJSONError(w, http.StatusBadRequest, "action_environment_ids must contain only UUID strings")
				return
			}
		}
		actionEnvironmentIDs = &values
	}

	tx, err := d.Queries.Pool().Begin(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to update project")
		return
	}
	defer tx.Rollback(r.Context())

	project, err := db.UpdateProjectTx(
		r.Context(), tx, orgID, projectID, req.GithubRepo, req.FrictionAutonomy, req.PrPosture, defaultEnvironmentID, req.DigestTimezone,
	)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to update project")
		return
	}
	if project == nil {
		writeJSONError(w, http.StatusNotFound, "project not found")
		return
	}
	if actionScopeTouched {
		if err := db.SetProjectActionScope(r.Context(), tx, orgID, projectID, actionEnvironmentIDs); err != nil {
			if errors.Is(err, db.ErrEnvironmentNotInProject) {
				writeJSONError(w, http.StatusBadRequest, err.Error())
				return
			}
			writeJSONError(w, http.StatusInternalServerError, "failed to update project action scope")
			return
		}
	}
	// Read the echo inside the transaction: after commit a concurrent PATCH
	// could overwrite the state this request wrote, and a failed read would
	// report 500 for a write that already committed.
	actionScopeEnabled, storedActionEnvironmentIDs, err := db.GetProjectActionScopeTx(r.Context(), tx, orgID, projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to load project action scope")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to update project")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toProjectJSON(*project, actionScopeEnabled, storedActionEnvironmentIDs))
}

// GetFixStatsEndpoint returns per-kind fix generation and PR outcome counts.
// GET /api/v1/projects/{projectID}/fix-stats
func (d *Dependencies) GetFixStatsEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	stats, err := d.Queries.GetFixStats(r.Context(), projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to load fix stats")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// ListEnvironmentsEndpoint returns environments for a project.
// GET /api/v1/projects/{projectID}/environments
func (d *Dependencies) ListEnvironmentsEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	usedBy := r.URL.Query().Get("used_by")
	if usedBy != "" && usedBy != "incidents" && usedBy != "sessions" {
		writeJSONError(w, http.StatusBadRequest, "used_by must be incidents or sessions")
		return
	}

	envs, err := d.Queries.ListEnvironments(r.Context(), projectID, usedBy)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list environments")
		return
	}
	rollupReady, err := d.Queries.RollupReady(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to read environment rollup readiness")
		return
	}

	result := make([]environmentJSON, 0, len(envs))
	for _, e := range envs {
		result = append(result, environmentJSON{
			ID:        e.ID,
			ProjectID: e.ProjectID,
			Name:      e.Name,
			CreatedAt: e.CreatedAt.Format(time.RFC3339),
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"environments": result,
		"rollup_ready": rollupReady,
	})
}

// GetEventCountEndpoint returns whether a project has received any events.
// GET /api/v1/projects/{projectID}/event-count
func (d *Dependencies) GetEventCountEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	hasEvents, err := d.Queries.HasEvents(r.Context(), projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to check events")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"has_events": hasEvents})
}

// TriggerFix creates a fix job for an incident in its kind-specific trigger state.
// POST /api/v1/projects/{projectID}/incidents/{incidentID}/fix
func (d *Dependencies) TriggerFix(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	incidentID := chi.URLParam(r, "incidentID")

	// Parse optional guidance
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req struct {
		Guidance string `json:"guidance"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate guidance length
	if len(req.Guidance) > 2000 {
		writeJSONError(w, http.StatusBadRequest, "guidance must be 2000 characters or less")
		return
	}

	// Strip null bytes and control characters from guidance
	guidance := sanitizeGuidance(req.Guidance)

	// Atomically transition status and create fix job
	jobID, err := d.Queries.TriggerFixJob(r.Context(), projectID, incidentID, guidance)
	if err != nil {
		if errors.Is(err, db.ErrNotInvestigated) {
			writeJSONError(w, http.StatusConflict, "incident is not in a fix-triggerable state")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to trigger fix")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"job_id": jobID})
}

// RequestIssueReview asks the inquiry stage to take another look at the
// current episode. It does not bypass inquiry or create an investigation.
func (d *Dependencies) RequestIssueReview(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	incidentID := chi.URLParam(r, "incidentID")
	jobID, err := d.Queries.RequestIssueReview(r.Context(), projectID, incidentID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONError(w, http.StatusConflict, "issue has no open review round")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to request another review")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]string{"job_id": jobID})
}

// sanitizeGuidance strips null bytes and ASCII control chars (except newline, tab).
func sanitizeGuidance(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == 0 || (r < 0x20 && r != '\n' && r != '\t') {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// respondWithIncident fetches the updated incident and writes it as JSON.
func (d *Dependencies) respondWithIncident(w http.ResponseWriter, r *http.Request, projectID, incidentID string) {
	group, err := d.Queries.GetErrorGroup(r.Context(), projectID, incidentID)
	if err != nil || group == nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to fetch updated incident")
		return
	}
	inc := toIncidentJSON(*group)
	// The dashboard assigns this response straight into its page state, so it
	// must carry the same detail-only surfaces GET does or the receipt and
	// recordings sections vanish after resolve/archive/unarchive.
	d.attachReceiptAndRecordings(r.Context(), projectID, incidentID, *group, &inc)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(inc)
}

// ResolveIncident manually marks an incident as resolved.
// POST /api/v1/projects/{projectID}/incidents/{incidentID}/resolve
func (d *Dependencies) ResolveIncident(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	incidentID := chi.URLParam(r, "incidentID")
	if err := d.Queries.ResolveErrorGroup(r.Context(), projectID, incidentID); err != nil {
		if strings.Contains(err.Error(), "no matching row") {
			writeJSONError(w, http.StatusConflict, "incident is archived or not found")
		} else {
			writeJSONError(w, http.StatusInternalServerError, "failed to resolve incident")
		}
		return
	}
	d.respondWithIncident(w, r, projectID, incidentID)
}

// ArchiveIncident dismisses an incident so it no longer appears in the default view.
// POST /api/v1/projects/{projectID}/incidents/{incidentID}/archive
func (d *Dependencies) ArchiveIncident(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	incidentID := chi.URLParam(r, "incidentID")
	if err := d.Queries.ArchiveErrorGroup(r.Context(), projectID, incidentID); err != nil {
		if strings.Contains(err.Error(), "no matching row") {
			writeJSONError(w, http.StatusConflict, "incident not found")
		} else {
			writeJSONError(w, http.StatusInternalServerError, "failed to archive incident")
		}
		return
	}
	d.respondWithIncident(w, r, projectID, incidentID)
}

// UnarchiveIncident restores an archived incident to a conservative kind-safe state.
// POST /api/v1/projects/{projectID}/incidents/{incidentID}/unarchive
func (d *Dependencies) UnarchiveIncident(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	incidentID := chi.URLParam(r, "incidentID")
	if err := d.Queries.UnarchiveErrorGroup(r.Context(), projectID, incidentID); err != nil {
		if strings.Contains(err.Error(), "no matching row") {
			writeJSONError(w, http.StatusConflict, "incident is not archived or not found")
		} else {
			writeJSONError(w, http.StatusInternalServerError, "failed to unarchive incident")
		}
		return
	}
	d.respondWithIncident(w, r, projectID, incidentID)
}
