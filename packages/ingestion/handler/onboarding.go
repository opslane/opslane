package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/db"
)

// Rate limiters for onboarding and resource creation endpoints.
var onboardingLimiter = newRateLimiter(5) // 5/min — one-time flow

// OnboardingSetup atomically creates a project + production environment + API key
// in a single database transaction. If any step fails, the entire operation is
// rolled back so no orphaned records are left.
//
// POST /api/v1/onboarding/setup
func (d *Dependencies) OnboardingSetup(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !onboardingLimiter.allow(ip) {
		slog.Warn("onboarding rate limit exceeded", "ip", ip)
		writeJSONError(w, http.StatusTooManyRequests, "too many requests, try again later")
		return
	}

	orgID := OrgIDFromCtx(r.Context())

	r.Body = http.MaxBytesReader(w, r.Body, 1<<16) // 64KB
	var req struct {
		ProjectName      string `json:"project_name"`
		IdempotencyToken string `json:"idempotency_token"`
		GithubRepo       string `json:"github_repo"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ProjectName == "" {
		writeJSONError(w, http.StatusBadRequest, "project_name is required")
		return
	}
	if len(req.ProjectName) > 100 {
		writeJSONError(w, http.StatusBadRequest, "project_name must be 100 characters or less")
		return
	}

	if strings.TrimSpace(req.IdempotencyToken) == "" {
		req.IdempotencyToken = uuid.NewString()
	}
	var githubRepo *string
	if req.GithubRepo != "" {
		githubRepo = &req.GithubRepo
	}

	result, err := d.Queries.OnboardingProvision(
		r.Context(), orgID, req.ProjectName, githubRepo, req.IdempotencyToken,
	)
	if errors.Is(err, db.ErrOrgOnboarded) {
		writeJSONError(w, http.StatusConflict, "org already onboarded")
		return
	}
	if err != nil {
		slog.Error("onboarding: provision", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to complete setup")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{
		"project":     toProjectJSON(result.Project, false, []string{}),
		"environment": environmentJSON{ID: result.Environment.ID, ProjectID: result.Environment.ProjectID, Name: result.Environment.Name, CreatedAt: result.Environment.CreatedAt.Format(time.RFC3339)},
		"api_key": map[string]any{
			"id":      result.APIKey.ID,
			"raw_key": result.APIKey.Raw,
		},
	})
}

// environmentJSON is the JSON representation of an environment.
type environmentJSON struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
}
