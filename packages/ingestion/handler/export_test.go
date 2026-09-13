package handler

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func RateLimitByProjectForTest(maxPerMinute int) func(http.Handler) http.Handler {
	return rateLimitByProject(newRateLimiter(maxPerMinute))
}

func SourcemapRateLimitForTest(maxPerMinute int) func(http.Handler) http.Handler {
	return sourcemapRateLimit(newRateLimiter(maxPerMinute))
}

func WithProjectIDForTest(ctx context.Context, projectID string) context.Context {
	return context.WithValue(ctx, ctxProjectID, projectID)
}

func WithAllowedOriginsForTest(ctx context.Context, origins []string) context.Context {
	return context.WithValue(ctx, ctxAllowedOrigins, origins)
}

func SetAuthCookiesForTest(w http.ResponseWriter, r *http.Request, access, refresh string) {
	setAuthCookies(w, r, access, refresh)
}

func SetDebugIDFramesForTest(t *testing.T, enabled bool) {
	t.Helper()
	previous := debugIDFramesEnabled
	debugIDFramesEnabled = enabled
	t.Cleanup(func() { debugIDFramesEnabled = previous })
}

func SetTicketFactsLoaderForTest(t *testing.T, load func(context.Context, db.TicketEvidenceQuerier, string, string, time.Time) (*db.TicketDigestFacts, error)) {
	t.Helper()
	previous := loadTicketFacts
	loadTicketFacts = load
	t.Cleanup(func() { loadTicketFacts = previous })
}
