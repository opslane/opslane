package handler

import (
	"context"
	"net/http"
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
