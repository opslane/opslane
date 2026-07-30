package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/masking"
)

// incidentJSON is the JSON representation of an incident, matching the
// Incident type in shared/src/types.ts. Fields use snake_case.
type incidentJSON struct {
	ID                   string                    `json:"id"`
	ProjectID            string                    `json:"project_id"`
	Fingerprint          string                    `json:"fingerprint"`
	Title                string                    `json:"title"`
	Status               string                    `json:"status"`
	Kind                 string                    `json:"kind"`
	Platform             *string                   `json:"platform,omitempty"`
	EnvironmentID        *string                   `json:"environment_id,omitempty"`
	AdjudicationStatus   *string                   `json:"adjudication_status,omitempty"`
	FirstSeen            string                    `json:"first_seen"`
	LastSeen             string                    `json:"last_seen"`
	OccurrenceCount      int                       `json:"occurrence_count"`
	AffectedUsersCount   int                       `json:"affected_users_count"`
	Confidence           *string                   `json:"confidence,omitempty"`
	PrURL                *string                   `json:"pr_url,omitempty"`
	ReplayID             *string                   `json:"replay_id,omitempty"`
	SessionPointer       *sessionPointerJSON       `json:"session_pointer,omitempty"`
	Reason               *needsHumanReason         `json:"reason,omitempty"`
	RootCause            *string                   `json:"root_cause,omitempty"`
	SuggestedMitigation  *string                   `json:"suggested_mitigation,omitempty"`
	VerificationEvidence json.RawMessage           `json:"verification_evidence,omitempty"`
	CandidateDiff        *string                   `json:"candidate_diff,omitempty"`
	MergedAt             *string                   `json:"merged_at,omitempty"`
	ResolvedAt           *string                   `json:"resolved_at,omitempty"`
	ArchivedAt           *string                   `json:"archived_at,omitempty"`
	TraceURL             *string                   `json:"trace_url,omitempty"`
	Environments         []incidentEnvironmentJSON `json:"environments,omitempty"`
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
		ID:                  g.ID,
		ProjectID:           g.ProjectID,
		Fingerprint:         g.Fingerprint,
		Title:               g.Title,
		Status:              g.Status,
		Kind:                g.Kind,
		Platform:            g.Platform,
		EnvironmentID:       g.EnvironmentID,
		AdjudicationStatus:  g.AdjudicationStatus,
		FirstSeen:           g.FirstSeen.Format(time.RFC3339),
		LastSeen:            g.LastSeen.Format(time.RFC3339),
		OccurrenceCount:     g.OccurrenceCount,
		AffectedUsersCount:  g.AffectedUsersCount,
		Confidence:          g.Confidence,
		PrURL:               g.PrURL,
		RootCause:           g.RootCause,
		SuggestedMitigation: g.SuggestedMitigation,
		CandidateDiff:       g.CandidateDiff,
		MergedAt:            fmtTimePtr(g.MergedAt),
		ResolvedAt:          fmtTimePtr(g.ResolvedAt),
		ArchivedAt:          fmtTimePtr(g.ArchivedAt),
	}
	if len(g.VerificationEvidence) > 0 {
		inc.VerificationEvidence = json.RawMessage(g.VerificationEvidence)
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

// projectJSON is the JSON representation of a project for the dashboard API.
type projectJSON struct {
	ID                      string  `json:"id"`
	Name                    string  `json:"name"`
	GithubRepo              *string `json:"github_repo"`
	FrictionAutonomy        string  `json:"friction_autonomy"`
	PrPosture               string  `json:"pr_posture"`
	AllowPayloadEnvironment bool    `json:"allow_payload_environment"`
	CreatedAt               string  `json:"created_at"`
}

func toProjectJSON(p db.Project) projectJSON {
	return projectJSON{
		ID:                      p.ID,
		Name:                    p.Name,
		GithubRepo:              p.GithubRepo,
		FrictionAutonomy:        p.FrictionAutonomy,
		PrPosture:               p.PrPosture,
		AllowPayloadEnvironment: p.AllowPayloadEnvironment,
		CreatedAt:               p.CreatedAt.Format(time.RFC3339),
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

	result := make([]projectJSON, 0, len(projects))
	for _, p := range projects {
		result = append(result, toProjectJSON(p))
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
	if accountID != "" || endUserID != "" || status != "" || environmentID != "" || platform != "" {
		filters = &db.ErrorGroupFilters{
			AccountID:     accountID,
			EndUserID:     endUserID,
			Status:        status,
			Platform:      platform,
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
	for _, g := range groups {
		incidents = append(incidents, toIncidentJSON(g))
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(inc)
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
		"project": toProjectJSON(provisioning.Project),
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
		GithubRepo              *string `json:"github_repo"`
		FrictionAutonomy        *string `json:"friction_autonomy"`
		PrPosture               *string `json:"pr_posture"`
		AllowPayloadEnvironment *bool   `json:"allow_payload_environment"`
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

	project, err := d.Queries.UpdateProject(
		r.Context(), orgID, projectID, req.GithubRepo, req.FrictionAutonomy, req.PrPosture, req.AllowPayloadEnvironment,
	)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to update project")
		return
	}
	if project == nil {
		writeJSONError(w, http.StatusNotFound, "project not found")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toProjectJSON(*project))
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

	envs, err := d.Queries.ListEnvironments(r.Context(), projectID)
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

// CreateEnvironmentEndpoint creates a new environment for a project.
// POST /api/v1/projects/{projectID}/environments
func (d *Dependencies) CreateEnvironmentEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name == "" {
		writeJSONError(w, http.StatusBadRequest, "name is required")
		return
	}
	if !environmentNamePattern.MatchString(req.Name) {
		writeJSONError(w, http.StatusBadRequest, "name must be 1-64 characters using letters, numbers, dot, underscore, or hyphen")
		return
	}

	env, err := d.Queries.CreateEnvironment(r.Context(), projectID, req.Name)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique constraint") {
			writeJSONError(w, http.StatusConflict, "environment with this name already exists")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to create environment")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(environmentJSON{
		ID:        env.ID,
		ProjectID: env.ProjectID,
		Name:      env.Name,
		CreatedAt: env.CreatedAt.Format(time.RFC3339),
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
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toIncidentJSON(*group))
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
