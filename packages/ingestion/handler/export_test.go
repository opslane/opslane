package handler

import (
	"context"
	"net/http"
	"time"
)

func RateLimitByProjectForTest(maxPerMinute int) func(http.Handler) http.Handler {
	return rateLimitByProject(newRateLimiter(maxPerMinute))
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

// The source-map seams are unexported so production cannot set them. Every
// source-map test lives in package handler_test, so without these setters the
// expiry, completion-wait, and copy-failure paths are unreachable by any test.

func SetSourceMapNowForTest(d *Dependencies, now func() time.Time) {
	d.sourcemapNow = now
}

func SetSourceMapCopierForTest(d *Dependencies, copier func(ctx context.Context, srcKey, dstKey string) error) {
	d.sourcemapCopier = copier
}

func SetCompletionWaitForTest(d *Dependencies, wait time.Duration) {
	d.completionWait = wait
}
