package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

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
		ProjectName string `json:"project_name"`
		GithubRepo  string `json:"github_repo"`
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

	// Use a transaction for atomicity
	tx, err := d.Queries.Pool().Begin(r.Context())
	if err != nil {
		slog.Error("onboarding: begin tx", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer tx.Rollback(r.Context())

	// 1. Create project (github_repo is nullable — pass nil if empty)
	var githubRepo *string
	if req.GithubRepo != "" {
		githubRepo = &req.GithubRepo
	}
	project, err := d.Queries.CreateProjectTx(r.Context(), tx, orgID, req.ProjectName, githubRepo)
	if err != nil {
		slog.Error("onboarding: create project", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to create project")
		return
	}

	// 2. Create "production" environment
	env, err := d.Queries.CreateEnvironmentTx(r.Context(), tx, project.ID, "production")
	if err != nil {
		slog.Error("onboarding: create environment", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to create environment")
		return
	}

	// 3. Create API key
	apiKey, err := d.Queries.CreateProjectKeyTx(
		r.Context(), tx, project.ID, db.ScopeIngest, "onboarding", nil, "",
	)
	if err != nil {
		slog.Error("onboarding: create api key", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to create API key")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("onboarding: commit tx", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to complete setup")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{
		"project":     toProjectJSON(*project),
		"environment": environmentJSON{ID: env.ID, ProjectID: env.ProjectID, Name: env.Name, CreatedAt: env.CreatedAt.Format(time.RFC3339)},
		"api_key": map[string]any{
			"id":      apiKey.ID,
			"raw_key": apiKey.Raw,
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
