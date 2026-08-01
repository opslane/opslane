package handler

import (
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func NewRouter(deps *Dependencies) *chi.Mux {
	return NewRouterWithPool(deps, nil)
}

// NewRouterWithPool creates the router with structured logging and enhanced health
// checks backed by the given DB pool. If pool is nil, a simple health check is used.
func NewRouterWithPool(deps *Dependencies, pool *pgxpool.Pool) *chi.Mux {
	logger := slog.Default()

	r := chi.NewRouter()
	r.Use(RequestID)
	r.Use(StructuredLogger(logger))
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware())

	// Health check — enhanced with DB + MinIO checks if pool is provided
	if pool != nil {
		hc := NewHealthChecker(pool, deps.MinIO)
		r.Get("/health", hc.Handler())
	} else {
		r.Get("/health", simpleHealth)
	}

	// Metrics endpoint (no auth needed — internal endpoint)
	r.Get("/metrics", Metrics)

	// Auth endpoints (unauthenticated)
	r.Post("/auth/refresh", deps.Refresh)
	r.Get("/auth/config", deps.AuthConfig)
	r.Post("/auth/password", deps.PasswordLogin)
	r.Post("/auth/signup", deps.Signup)
	r.Post("/auth/verify-email", deps.VerifyEmail)
	r.Post("/auth/oauth/verify-email", deps.OAuthVerifyEmail)
	r.Post("/auth/password/forgot", deps.ForgotPassword)
	r.Post("/auth/password/reset", deps.ResetPassword)
	r.With(deps.AuthenticateUserSession).Post("/auth/switch-org", deps.SwitchOrg)

	// Browser OAuth (unauthenticated — user auth via configured provider).
	r.Get("/auth/login", deps.OAuthLoginStart)
	r.Get("/auth/github", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/auth/login", http.StatusFound)
	})
	r.Get("/auth/callback", deps.OAuthLoginCallback)
	r.Get("/auth/github/callback", deps.OAuthLoginCallback)

	// OAuth endpoints (unauthenticated — used by CLI PKCE flow)
	r.HandleFunc("/oauth/authorize", deps.OAuthAuthorize) // GET + POST
	r.Post("/oauth/token", deps.OAuthToken)

	// Agent-first onboarding (unauthenticated start; polling uses a split token)
	r.Post("/api/v1/agent/setup", deps.AgentSetup)
	r.Get("/api/v1/agent/poll/{sessionID}", deps.AgentPoll)
	r.Get("/agent/auth/{sessionID}", deps.AgentAuthRedirect)
	r.Get("/agent/auth/callback", deps.AgentAuthCallback)

	// GitHub webhook (unauthenticated — uses HMAC signature verification)
	r.Post("/api/v1/github/webhook", deps.HandleWebhook)

	// Internal service read (worker -> ingestion). The shared implementation
	// applies the same scrub gate and redact-on-read policy as dashboard reads.
	r.With(RequireInternalToken).Get("/internal/v1/projects/{projectID}/sessions/{sessionID}/chunks/{seq}",
		func(w http.ResponseWriter, r *http.Request) {
			deps.serveChunk(w, r, chi.URLParam(r, "projectID"))
		})

	r.Route("/api/v1", func(r chi.Router) {
		// SDK endpoints (authenticated by ingest-scoped project key).
		// Browser endpoints (replays, sessions, chunks) are origin-gated
		// strictly. /events also accepts server-side SDKs, which send no
		// Origin or Referer (#104).
		ingestKey := deps.ProjectKey(db.ScopeIngest)
		r.With(ingestKey, deps.EnforceOriginAllowingServerSDK, rateLimitByProject(eventsLimiter)).Post("/events", deps.IngestEvent)
		r.With(ingestKey, deps.EnforceOrigin, rateLimitByProject(replaysLimiter)).Post("/replays/init", deps.ReplayInit)
		r.With(ingestKey, deps.EnforceOrigin, rateLimitByProject(replaysLimiter)).Post("/replays/{replayID}/complete", deps.ReplayComplete)
		r.With(ingestKey, deps.EnforceOrigin, rateLimitByProject(replaysLimiter)).Post("/replays/{replayID}/fail", deps.ReplayFail)
		r.With(ingestKey, deps.EnforceOrigin, rateLimitByProject(chunksLimiter)).Post("/sessions/init", deps.SessionInit)
		r.With(ingestKey, deps.EnforceOrigin, rateLimitByProject(chunksLimiter)).Post("/sessions/{sessionID}/chunks/{seq}", deps.ChunkUpload)
		r.With(ingestKey, rateLimitByProject(eventsLimiter)).Post("/ingest/ping",
			func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })

		// Source-map upload endpoints are authenticated by a write-only,
		// sourcemaps-scoped project key.
		sourcemapKey := deps.ProjectKey(db.ScopeSourcemaps)
		r.With(sourcemapKey, rateLimitByProject(sourcemapBatchLimiter)).Post("/sourcemaps/batches", deps.CreateSourceMapBatch)
		r.With(sourcemapKey, rateLimitByProject(sourcemapFileLimiter)).Put("/sourcemaps/batches/{batchID}/files/{debugID}", deps.UploadSourceMapFile)
		r.With(sourcemapKey, rateLimitByProject(sourcemapCompleteLimiter)).Post("/sourcemaps/batches/{batchID}/complete", deps.CompleteSourceMapBatch)

		// Session-authenticated endpoints (dashboard + CLI)
		r.With(deps.AuthenticateUserSession).Get("/auth/me", deps.AuthMe)
		r.With(deps.AuthenticateUserSession).Get("/auth/verify", deps.AuthVerify)
		r.With(deps.AuthenticateUserSession).Post("/auth/logout", deps.Logout)

		// Cloud organization invitations. Admin operations use the active org;
		// acceptance is intentionally available to any authenticated user.
		r.With(deps.AuthenticateUserSession, deps.RequireRole("admin")).Get("/invitations", deps.ListInvitations)
		r.With(deps.AuthenticateUserSession, deps.RequireRole("admin")).Post("/invitations", deps.CreateInvitation)
		r.With(deps.AuthenticateUserSession, deps.RequireRole("admin")).Delete("/invitations/{invitationID}", deps.RevokeInvitation)
		r.With(deps.AuthenticateUserSession).Post("/invitations/accept", deps.AcceptInvitation)

		// Cross-tenant operator observability. RequireAdmin deliberately returns 404.
		r.With(deps.AuthenticateUserSession, deps.RequireAdmin).Get("/admin/overview", deps.AdminOverview)
		r.With(deps.AuthenticateUserSession, deps.RequireAdmin).Get("/admin/jobs", deps.AdminJobs)

		// Onboarding
		r.With(deps.AuthenticateUserSession, deps.RequireRoleIfCloud("admin")).Post("/onboard/provision", deps.OnboardProvision)
		r.With(deps.AuthenticateUserSession, deps.RequireRoleIfCloud("admin")).Post("/onboarding/setup", deps.OnboardingSetup)

		// Project CRUD
		r.With(deps.AuthenticateUserSession).Get("/projects", deps.ListProjects)
		r.With(deps.AuthenticateUserSession, deps.RequireRoleIfCloud("admin")).Post("/projects", deps.CreateProjectEndpoint)
		r.With(deps.AuthenticateUserSession, deps.RequireRoleIfCloud("admin")).Patch("/projects/{projectID}", deps.UpdateProjectEndpoint)

		// Environment CRUD
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/environments", deps.ListEnvironmentsEndpoint)
		r.With(deps.AuthenticateUserSession, deps.RequireRoleIfCloud("admin")).Post("/projects/{projectID}/environments", deps.CreateEnvironmentEndpoint)

		// Stats are user-session reads.
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/event-count", deps.GetEventCountEndpoint)
		// Fix-stats is dashboard-only (session auth): it backs the autonomy
		// settings receipts, which no SDK/CLI caller consumes.
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/fix-stats", deps.GetFixStatsEndpoint)
		r.With(deps.AuthenticateUserSession).Post("/projects/{projectID}/sourcemaps/verify", deps.VerifySourceMap)

		// Incidents are user-session reads.
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/incidents", deps.ListIncidents)
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/incidents/{incidentID}", deps.GetIncident)
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/incidents/{incidentID}/sample-event", deps.GetSampleEvent)
		// === Project D: replay retrieval (project-scoped, dashboard JWT auth) ===
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/replays/{replayID}", deps.GetReplay)
		// Always-on session browsing and bounded chunk playback.
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/sessions", deps.ListSessionsEndpoint)
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/sessions/{sessionID}", deps.GetSessionEndpoint)
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/sessions/{sessionID}/chunks/{seq}", deps.GetSessionChunk)
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/incidents/{incidentID}/affected-users", deps.ListAffectedUsers)
		r.With(deps.AuthenticateUserSession).Post("/projects/{projectID}/incidents/{incidentID}/fix", deps.TriggerFix)
		r.With(deps.AuthenticateUserSession).Post("/projects/{projectID}/incidents/{incidentID}/resolve", deps.ResolveIncident)
		r.With(deps.AuthenticateUserSession).Post("/projects/{projectID}/incidents/{incidentID}/archive", deps.ArchiveIncident)
		r.With(deps.AuthenticateUserSession).Post("/projects/{projectID}/incidents/{incidentID}/unarchive", deps.UnarchiveIncident)

		// B2B Accounts
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/accounts", deps.ListAccounts)
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/accounts/{accountID}", deps.GetAccount)
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/accounts/{accountID}/incidents", deps.ListAccountIncidents)

		// GitHub App integration
		r.With(deps.AuthenticateUserSession, deps.RequireRoleIfCloud("admin")).Get("/github/setup", deps.GitHubSetupCallback)
		r.With(deps.AuthenticateUserSession, deps.RequireRoleIfCloud("admin")).Get("/github/status", deps.GetGitHubAppStatus)
		r.With(deps.AuthenticateUserSession).Get("/github/repos", deps.ListGitHubRepos)

		// Per-project GitHub config
		r.With(deps.AuthenticateUserSession).Put("/projects/{projectID}/github", deps.SetGitHubConfig)
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/github", deps.GetGitHubConfig)
		r.With(deps.AuthenticateUserSession).Delete("/projects/{projectID}/github", deps.DeleteGitHubConfig)

		// Per-project notification destinations
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/notification-destinations", deps.ListNotificationDestinationsEndpoint)
		r.With(deps.AuthenticateUserSession, deps.requireIntegrationAdmin).Post("/projects/{projectID}/notification-destinations", deps.CreateNotificationDestinationEndpoint)
		r.With(deps.AuthenticateUserSession, deps.requireIntegrationAdmin).Patch("/projects/{projectID}/notification-destinations/{destID}", deps.UpdateNotificationDestinationEndpoint)
		r.With(deps.AuthenticateUserSession, deps.requireIntegrationAdmin).Delete("/projects/{projectID}/notification-destinations/{destID}", deps.DeleteNotificationDestinationEndpoint)
		r.With(deps.AuthenticateUserSession, deps.requireIntegrationAdmin).Post("/projects/{projectID}/notification-destinations/{destID}/test", deps.TestNotificationDestinationEndpoint)

		// Setup PR
		r.With(deps.AuthenticateUserSession).Post("/projects/{projectID}/setup-pr", deps.SetupPR)
		r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/setup-pr", deps.GetSetupPR)

		r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
			writeJSONErrorCode(w, http.StatusNotFound, "not found", "not_found")
		})
		r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
			writeJSONErrorCode(w, http.StatusMethodNotAllowed, "method not allowed", "method_not_allowed")
		})
	})

	// Keep every API version out of the dashboard catch-all. The more-specific
	// /api/v1 mount above continues to handle its registered routes and emits
	// its own JSON 404/405 responses.
	r.Handle("/api/*", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSONErrorCode(w, http.StatusNotFound, "not found", "not_found")
	}))

	// Serve dashboard SPA (must be last — catch-all).
	// DASHBOARD_DIR should point to the Vite build output containing index.html.
	dashboardDir := os.Getenv("DASHBOARD_DIR")
	if dashboardDir != "" {
		cleanRoot := filepath.Clean(dashboardDir)
		fileServer := http.FileServer(http.Dir(dashboardDir))
		spa := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			// Clean path to prevent traversal oracle via os.Stat
			cleaned := filepath.Join(cleanRoot, filepath.Clean("/"+req.URL.Path))
			if !strings.HasPrefix(cleaned, cleanRoot+string(os.PathSeparator)) && cleaned != cleanRoot {
				http.NotFound(w, req)
				return
			}
			// Try to serve the file directly
			if _, err := os.Stat(cleaned); err == nil {
				fileServer.ServeHTTP(w, req)
				return
			}
			// Missing static asset — return 404 instead of index.html
			if ext := filepath.Ext(req.URL.Path); ext != "" && ext != ".html" {
				http.NotFound(w, req)
				return
			}
			// Fall back to index.html for SPA client-side routing
			http.ServeFile(w, req, cleanRoot+"/index.html")
		})
		// Read-only verbs only: the catch-all must not answer POST/PUT/DELETE
		// with the SPA shell. chi does not fall back HEAD->GET, so HEAD is
		// registered explicitly; uptime checks and CDNs rely on it.
		r.Method(http.MethodGet, "/*", spa)
		r.Method(http.MethodHead, "/*", spa)
	}

	return r
}

// simpleHealth is a minimal health check for when the DB pool is not available.
func simpleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

// corsMiddleware applies a split CORS policy:
//   - SDK endpoints reflect Origin; the server-side origin middleware is the
//     real gate (EnforceOrigin, or EnforceOriginAllowingServerSDK on /events).
//   - Dashboard endpoints are restricted to DASHBOARD_ORIGIN env var.
func corsMiddleware() func(http.Handler) http.Handler {
	dashboardOrigin := os.Getenv("DASHBOARD_ORIGIN")
	if dashboardOrigin == "" {
		dashboardOrigin = "http://localhost:3000"
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			w.Header().Add("Vary", "Origin")

			if isSourcemapUploadEndpoint(r.URL.Path) {
				// Source-map keys are server-to-server credentials; never
				// authorize a browser origin to call the upload routes.
			} else if isSDKEndpoint(r.URL.Path) {
				if origin != "" {
					w.Header().Set("Access-Control-Allow-Origin", origin)
				} else {
					w.Header().Set("Access-Control-Allow-Origin", "*")
				}
			} else if origin == dashboardOrigin {
				w.Header().Set("Access-Control-Allow-Origin", dashboardOrigin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			}

			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// isSourcemapUploadEndpoint marks the server-to-server upload routes. They get
// no browser CORS of any kind, not even the dashboard origin: no browser is
// supposed to hold an opslane_sk_.
func isSourcemapUploadEndpoint(path string) bool {
	const prefix = "/api/v1/sourcemaps/batches"
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

// isSDKEndpoint reports paths receiving permissive browser CORS. Boundary
// checks keep similarly prefixed non-SDK routes out; ingest/ping is omitted so
// arbitrary pages cannot read a credential probe.
func isSDKEndpoint(path string) bool {
	for _, prefix := range []string{"/api/v1/events", "/api/v1/replays", "/api/v1/sessions"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	return false
}
