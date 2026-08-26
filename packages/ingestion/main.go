package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/digest"
	"github.com/opslane/opslane/packages/ingestion/filter"
	"github.com/opslane/opslane/packages/ingestion/handler"
	"github.com/opslane/opslane/packages/ingestion/identity"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
	"github.com/opslane/opslane/packages/ingestion/notify"
	"github.com/opslane/opslane/packages/ingestion/priority"
	"github.com/opslane/opslane/packages/ingestion/resolve"
	"github.com/opslane/opslane/packages/ingestion/retention"
	"github.com/opslane/opslane/packages/ingestion/scrubber"
	"github.com/opslane/opslane/packages/ingestion/usageevents"
)

func main() {
	// Set up structured JSON logging as the default logger.
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	ctx := context.Background()
	pool, err := db.Connect(ctx)
	if err != nil {
		slog.Error("Failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Initialize MinIO client for replay/sourcemap storage.
	// Don't fatal on error — ingestion can work without MinIO for events-only mode.
	var minioClient *minioPkg.Client
	minioEndpoint := os.Getenv("REPLAY_STORE_ENDPOINT")
	if minioEndpoint != "" {
		var err2 error
		minioClient, err2 = minioPkg.New(
			minioEndpoint,
			os.Getenv("REPLAY_STORE_PUBLIC_ENDPOINT"),
			os.Getenv("REPLAY_STORE_ACCESS_KEY"),
			os.Getenv("REPLAY_STORE_SECRET_KEY"),
			os.Getenv("REPLAY_STORE_BUCKET"),
			os.Getenv("REPLAY_STORE_REGION"),
		)
		if err2 != nil {
			slog.Error("Failed to create MinIO client", "error", err2)
		} else {
			slog.Info("MinIO client initialized",
				"endpoint", minioEndpoint,
				"bucket", os.Getenv("REPLAY_STORE_BUCKET"))
		}
	} else {
		slog.Warn("REPLAY_STORE_ENDPOINT not set — replay/sourcemap uploads disabled")
	}

	// JWT secret for session auth — fail-fast if missing or weak.
	jwtSecret := os.Getenv("JWT_SECRET")
	if len(jwtSecret) < 32 {
		slog.Error("JWT_SECRET must be set and at least 32 bytes", "length", len(jwtSecret))
		os.Exit(1)
	}
	configCipher, err := notify.NewConfigCipher([]byte(jwtSecret))
	if err != nil {
		slog.Error("Failed to initialize notification config encryption", "error", err)
		os.Exit(1)
	}
	pendingCipher, err := auth.NewPendingCipher([]byte(jwtSecret))
	if err != nil {
		slog.Error("Failed to initialize OAuth verification encryption", "error", err)
		os.Exit(1)
	}

	var notifyExtraHosts []string
	for _, host := range strings.Split(os.Getenv("NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS"), ",") {
		if host = strings.TrimSpace(host); host != "" {
			notifyExtraHosts = append(notifyExtraHosts, host)
		}
	}
	if len(notifyExtraHosts) > 0 {
		slog.Warn("NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS set — webhook host allowlist extended (dev/test only)", "hosts", notifyExtraHosts)
	}

	// GitHub App OAuth — optional for dev environments without GitHub App.
	githubAppID := os.Getenv("GITHUB_APP_ID")
	githubAppClientID := os.Getenv("GITHUB_APP_CLIENT_ID")
	githubAppClientSecret := os.Getenv("GITHUB_APP_CLIENT_SECRET")
	githubAppPrivateKeyRaw := os.Getenv("GITHUB_APP_PRIVATE_KEY")
	githubAppSlug := os.Getenv("GITHUB_APP_SLUG")
	dashboardOrigin := os.Getenv("DASHBOARD_ORIGIN")
	if dashboardOrigin == "" {
		dashboardOrigin = "http://localhost:3000"
	}

	var githubAppPrivateKey []byte
	if githubAppPrivateKeyRaw != "" {
		githubAppPrivateKey = []byte(githubAppPrivateKeyRaw)
	}

	if githubAppClientID == "" || githubAppClientSecret == "" {
		slog.Warn("GITHUB_APP_CLIENT_ID/SECRET not set — GitHub OAuth login disabled")
	}

	authProvider, err := auth.SelectAuthProvider(auth.ProviderConfig{
		Provider:           os.Getenv("AUTH_PROVIDER"),
		GitHubClientID:     githubAppClientID,
		GitHubClientSecret: githubAppClientSecret,
		WorkOSAPIKey:       os.Getenv("WORKOS_API_KEY"),
		WorkOSClientID:     os.Getenv("WORKOS_CLIENT_ID"),
	})
	if err != nil {
		slog.Error("invalid auth provider configuration", "error", err)
		os.Exit(1)
	}
	socialProviders, err := auth.ParseSocialProviders(os.Getenv("AUTH_WORKOS_SOCIAL"))
	if err != nil {
		slog.Error("invalid AUTH_WORKOS_SOCIAL", "error", err)
		os.Exit(1)
	}
	if len(socialProviders.Ordered()) > 0 && authProvider.Name() != "workos" {
		slog.Warn("AUTH_WORKOS_SOCIAL is set but AUTH_PROVIDER is not workos; ignoring social buttons",
			"provider", authProvider.Name())
		socialProviders, _ = auth.ParseSocialProviders("")
	}
	authCallbackOrigin := os.Getenv("AUTH_CALLBACK_ORIGIN")
	if authCallbackOrigin == "" {
		if authProvider.Name() == "workos" {
			slog.Error("AUTH_CALLBACK_ORIGIN is required when AUTH_PROVIDER=workos")
			os.Exit(1)
		}
		authCallbackOrigin = "http://localhost:" + port
	}
	slog.Info("auth provider selected", "provider", authProvider.Name())

	queries := db.New(pool)
	queries.DashboardURL = os.Getenv("DASHBOARD_URL")
	if raw := os.Getenv("USAGE_EVENTS_SLACK_WEBHOOK"); raw != "" {
		if err := usageevents.Configure(raw); err != nil {
			slog.Error("usage events disabled: invalid USAGE_EVENTS_SLACK_WEBHOOK")
		}
	}
	slog.Info("usage events", "enabled", usageevents.Enabled())
	go func() {
		ran, err := queries.RunRollupBackfill(context.Background())
		if err != nil {
			slog.Error("environment rollup backfill failed", "error", err)
		} else if ran {
			slog.Info("environment rollup backfill complete")
		}
	}()
	notifySender := notify.NewSender(0, notifyExtraHosts)
	digestSweeper := digest.New(pool, queries.DashboardURL)
	digestScheduler := digest.NewScheduler(pool)
	deps, err := handler.NewDependencies(&handler.Dependencies{
		Queries:               queries,
		MinIO:                 minioClient,
		JWTSecret:             []byte(jwtSecret),
		PendingCipher:         pendingCipher,
		AuthProvider:          authProvider,
		SocialProviders:       socialProviders,
		AuthCallbackOrigin:    authCallbackOrigin,
		GitHubAppID:           githubAppID,
		GitHubAppClientID:     githubAppClientID,
		GitHubAppClientSecret: githubAppClientSecret,
		GitHubAppPrivateKey:   githubAppPrivateKey,
		GitHubAppSlug:         githubAppSlug,
		DashboardOrigin:       dashboardOrigin,
		AdminEmails:           handler.ParseAdminEmails(os.Getenv("ADMIN_EMAILS")),
		ConfigCipher:          configCipher,
		NotifyExtraHosts:      notifyExtraHosts,
		NotifySender:          notifySender,
		DigestBuilder:         digestSweeper,
	})
	if err != nil {
		slog.Error("Failed to initialize handler dependencies", "error", err)
		os.Exit(1)
	}
	r := handler.NewRouterWithPool(deps, pool)
	dispatcher := notify.New(pool, configCipher, notify.Options{ExtraHosts: notifyExtraHosts})
	go dispatcher.Run(ctx)
	// The sweep runs unconditionally; subscription is the gate. Both the
	// candidate query and the publish insert require an enabled destination
	// carrying 'digest.daily', and a tick that matches none is one cheap query.
	//
	// That default is deliberately broad, so read this before assuming it is a
	// no-op: migration 038 backfilled 'digest.daily' onto every destination and
	// made it the column default, which handler.createNotificationDestination
	// mirrors for new ones. Any project with an enabled Slack destination that
	// has not unticked the digest therefore starts receiving one. Unticking it
	// is the off switch -- there is no global flag, per that migration's
	// product decision that the digest is automatic with a per-destination
	// unsubscribe.
	go digestScheduler.Start(ctx, 5*time.Minute)
	// Boot-time proof the loop exists. The sweep is otherwise silent on a day
	// it publishes nothing, so without this line a sweep that never started is
	// indistinguishable in the logs from a sweep that had nothing to send.
	slog.Info("digest scheduler started")

	// Periodic cleanup of expired/revoked refresh tokens and auth codes
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			deleted, codes, err := queries.CleanupExpiredTokens(context.Background())
			if err != nil {
				slog.Error("token cleanup failed", "error", err)
			} else if deleted > 0 || codes > 0 {
				slog.Info("token cleanup", "refresh_deleted", deleted, "codes_deleted", codes)
			}

			expired, sessErr := queries.ExpireAgentSessions(context.Background())
			if sessErr != nil {
				slog.Error("agent session cleanup failed", "error", sessErr)
			} else if expired > 0 {
				slog.Info("agent session cleanup", "expired", expired)
			}
		}
	}()

	// Settle stack resolutions whose source map never arrived (pending past the
	// daily boundary -> explicit no_map fallback) and report resolutions stuck
	// in 'failed'. The boundary is the architecture's daily boundary, not a
	// tunable retry knob; only the tick rate is env-adjustable.
	resolveWatchdog := resolve.NewWatchdog(pool, 24*time.Hour)
	resolveSweepInterval := 5 * time.Minute
	if v := os.Getenv("RESOLVE_SWEEP_INTERVAL_SECONDS"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
			resolveSweepInterval = time.Duration(parsed) * time.Second
		}
	}
	go resolveWatchdog.Start(context.Background(), resolveSweepInterval)
	slog.Info("resolve watchdog started", "interval", resolveSweepInterval.String())

	identityInterval := 5 * time.Second
	if v := os.Getenv("IDENTITY_SETTLE_INTERVAL_SECONDS"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
			identityInterval = time.Duration(parsed) * time.Second
		}
	}
	go identity.NewLoop(pool).Start(ctx, identityInterval)
	slog.Info("identity settlement loop started", "interval", identityInterval.String())

	filterInterval := 30 * time.Second
	if v := os.Getenv("FILTER_SWEEP_INTERVAL_SECONDS"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
			filterInterval = time.Duration(parsed) * time.Second
		}
	}
	go filter.NewDispatcher(pool, queries.DashboardURL).Start(ctx, filterInterval)
	slog.Info("issue filter sweep started", "interval", filterInterval.String())

	prioritySweeper := &priority.Sweeper{Pool: pool}
	priorityInterval := 30 * time.Minute
	if v := os.Getenv("PRIORITY_SCORE_INTERVAL_SECONDS"); v != "" {
		if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
			priorityInterval = time.Duration(secs) * time.Second
		}
	}
	go prioritySweeper.Start(context.Background(), priorityInterval)
	slog.Info("priority sweeper started", "interval", priorityInterval.String())

	// Raw chunks are fail-closed until this pass overwrites them with redacted
	// bytes and stamps scrubbed_at. Every replica runs a scrubber; claims use
	// FOR UPDATE SKIP LOCKED to avoid duplicate work.
	if minioClient != nil {
		s := &scrubber.Scrubber{Q: queries, MinIO: minioClient}
		// Only the tick rate is tunable. The 30s eligibility grace in
		// ClaimUnscrubbedChunks is retained but no longer load-bearing: chunk
		// uploads are no longer presigned (#194), so there is no replayable
		// upload that could swap raw bytes under an already-scrubbed row. It
		// now only bounds how long a raw chunk sits unredacted; shortening it
		// is a separate privacy-timing decision.
		scrubInterval := 15 * time.Second
		if v := os.Getenv("SCRUB_INTERVAL_SECONDS"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
				scrubInterval = time.Duration(parsed) * time.Second
			}
		}
		go s.Start(context.Background(), scrubInterval)
		slog.Info("chunk scrubber started", "interval", scrubInterval.String())

		sweeper := &retention.Sweeper{Q: queries, MinIO: minioClient}
		if v := os.Getenv("SESSION_IDLE_CLOSE_MINUTES"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
				sweeper.IdleCloseMinutes = parsed
			}
		}
		sweepInterval := time.Hour
		if v := os.Getenv("RETENTION_SWEEP_INTERVAL_SECONDS"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
				sweepInterval = time.Duration(parsed) * time.Second
			}
		}
		go sweeper.Start(context.Background(), sweepInterval)
		slog.Info("retention sweeper started", "interval", sweepInterval.String())
	}

	slog.Info("Opslane ingestion starting", "port", port)
	if err := http.ListenAndServe(fmt.Sprintf(":%s", port), r); err != nil {
		slog.Error("Server failed", "error", err)
		os.Exit(1)
	}
}
