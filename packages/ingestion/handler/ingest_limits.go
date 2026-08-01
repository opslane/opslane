package handler

import (
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

// Per-project ingest rate limiters (requests/minute, in-memory, reset each minute).
// Public SDK keys ship in customer bundles and are not secret, so these cap burst
// abuse per project. Generous defaults: real apps stay well under them.
var (
	eventsLimiter  = newRateLimiter(600) // ~10 errors/sec sustained
	replaysLimiter = newRateLimiter(120)

	// Per-replica, in-memory, reset each minute. Contract 7.2 wants these
	// cluster-wide; #226 does that.
	sourcemapBatchLimiter    = newRateLimiter(20)
	sourcemapFileLimiter     = newRateLimiter(600)
	sourcemapCompleteLimiter = newRateLimiter(60)
	sourcemapVerifyLimiter   = newRateLimiter(30)

	// Always-on recording: every session uploads a chunk every ~30s, and each
	// chunk now costs 1 ingestion request (#194 collapsed the upload-url +
	// storage POST + commit handshake into a single call). 6000/min therefore
	// supports ~3000 concurrent sessions per replica; the byte budget below is
	// the real ceiling.
	chunksLimiter = newRateLimiter(6000)

	// 512 MB/min/project of compressed chunks. A 30s chunk gzips to roughly
	// 200-800KB, so this is ~1000 concurrent sessions before shedding — far
	// above real load, but a hard stop on a storage flood (#48).
	chunkBytesBudget = newByteBudget(512 << 20)
)

// rateLimitByProject returns middleware that rate-limits by project_id set by
// ProjectKey. It must be chained after ProjectKey.
func rateLimitByProject(limiter *rateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			projectID := ProjectIDFromCtx(r.Context())
			if projectID == "" {
				writeJSONError(w, http.StatusUnauthorized, "missing project context")
				return
			}
			if !limiter.allow(projectID) {
				slog.Warn("ingest rate limit exceeded", "project_id", projectID, "path", r.URL.Path)
				writeJSONErrorCode(w, http.StatusTooManyRequests, "rate limit exceeded", "rate_limited")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// EnforceOrigin rejects SDK ingest from origins not on the project's allowlist.
//
// Scope: this is a BROWSER-ORIGIN control, and only that. `Origin` is
// meaningful because browsers set it and page JavaScript cannot forge it; any
// non-browser caller can send whatever it likes. It stops another site from
// reusing a public SDK key, not a script. Opt-in: an empty allowlist allows
// all origins.
//
// Used by the browser-only routes (replays, sessions, chunks). A caller with
// no browser context has no legitimate business on those, so header-less
// requests stay rejected here. See EnforceOriginAllowingServerSDK for /events.
func (d *Dependencies) EnforceOrigin(next http.Handler) http.Handler {
	return d.enforceOrigin(next, false)
}

// EnforceOriginAllowingServerSDK is EnforceOrigin for POST /api/v1/events, the
// only route a server-side SDK touches (packages/sdk-python/opslane/transport.py
// builds that URL and no other).
//
// A request carrying neither Origin nor Referer has no browser context, so the
// browser-origin allowlist does not apply to it (#104). Denying it bought
// nothing — the same caller can forge an Origin — while breaking every
// legitimate backend SDK and forcing customers into a second project.
//
// Browsers always send Origin on POST (Fetch spec: included for any method
// other than GET/HEAD, same-origin included), so real browser traffic is never
// exempted here. Residual risk: a proxy in front of ingestion that strips
// Origin would make browser traffic look header-less and skip the check. The
// Debug line below records each exemption, but main.go builds the logger at
// the default Info level with no LOG_LEVEL knob, so observing it takes a code
// change today — it is a hook for investigation, not live detection.
func (d *Dependencies) EnforceOriginAllowingServerSDK(next http.Handler) http.Handler {
	return d.enforceOrigin(next, true)
}

func (d *Dependencies) enforceOrigin(next http.Handler, allowServerSDK bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowed := AllowedOriginsFromCtx(r.Context())
		if len(allowed) == 0 {
			next.ServeHTTP(w, r)
			return
		}

		// Presence, not emptiness: Header.Get returns "" for an absent header
		// AND for a present-but-empty one, so `Origin:` would otherwise slip
		// through as "no browser context".
		hasBrowserContext := len(r.Header.Values("Origin")) > 0 ||
			len(r.Header.Values("Referer")) > 0
		if allowServerSDK && !hasBrowserContext {
			slog.Debug("ingest allowed: no browser context (server-side SDK)",
				"project_id", ProjectIDFromCtx(r.Context()), "path", r.URL.Path)
			next.ServeHTTP(w, r)
			return
		}

		origin := r.Header.Get("Origin")
		if origin == "" {
			origin = originFromReferer(r.Header.Get("Referer"))
		}
		if !originAllowed(origin, allowed) {
			slog.Warn("ingest rejected: origin not allowlisted",
				"project_id", ProjectIDFromCtx(r.Context()), "origin", origin)
			writeJSONError(w, http.StatusForbidden, "origin not allowed")
			return
		}

		next.ServeHTTP(w, r)
	})
}

func originAllowed(origin string, allowed []string) bool {
	if origin == "" {
		return false
	}
	origin = strings.ToLower(origin)
	for _, a := range allowed {
		if origin == strings.ToLower(a) {
			return true
		}
	}
	return false
}

func originFromReferer(referer string) string {
	if referer == "" {
		return ""
	}
	u, err := url.Parse(referer)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme + "://" + u.Host)
}
