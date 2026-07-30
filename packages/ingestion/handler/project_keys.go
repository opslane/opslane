package handler

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// ProjectKey authenticates a project API key and enforces its stored scope in
// one pass, preventing routes from accidentally attaching only half of the
// security boundary.
func (d *Dependencies) ProjectKey(requiredScope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw := r.Header.Get("X-API-Key")
			if raw == "" {
				RecordKeyAuth("invalid_key")
				writeJSONErrorCode(w, http.StatusUnauthorized, "missing X-API-Key header", "invalid_api_key")
				return
			}

			lookup, err := d.Queries.LookupProjectKey(r.Context(), raw)
			if errors.Is(err, db.ErrProjectKeyInvalid) {
				RecordKeyAuth("invalid_key")
				writeJSONErrorCode(w, http.StatusUnauthorized, "invalid or revoked API key", "invalid_api_key")
				return
			}
			if err != nil {
				slog.Error("project key lookup failed", "error", err)
				RecordKeyAuth("error")
				writeJSONErrorCode(w, http.StatusInternalServerError, "internal error", "internal_error")
				return
			}
			if lookup.Scope != requiredScope {
				RecordKeyAuth("wrong_scope")
				writeJSONErrorCode(w, http.StatusForbidden, "key is not permitted on this route", "insufficient_scope")
				return
			}

			envID, err := d.environmentNameResolver().resolve(
				r.Context(), lookup.ProjectID, "production",
			)
			if err != nil {
				slog.Error("resolve production environment failed",
					"error", err, "project_id", lookup.ProjectID)
				writeJSONErrorCode(w, http.StatusInternalServerError, "internal error", "internal_error")
				return
			}
			if envID == "" {
				slog.Error("project has no production environment", "project_id", lookup.ProjectID)
				writeJSONErrorCode(w, http.StatusInternalServerError, "internal error", "internal_error")
				return
			}

			RecordKeyAuth("ok")
			ctx := r.Context()
			ctx = context.WithValue(ctx, ctxProjectID, lookup.ProjectID)
			ctx = context.WithValue(ctx, ctxOrgID, lookup.OrgID)
			ctx = context.WithValue(ctx, ctxEnvironmentID, envID)
			ctx = context.WithValue(ctx, ctxKeyScope, lookup.Scope)
			ctx = context.WithValue(ctx, ctxAllowedOrigins, lookup.AllowedOrigins)
			ctx = context.WithValue(ctx, ctxAllowPayloadEnvironment, lookup.AllowPayloadEnvironment)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
