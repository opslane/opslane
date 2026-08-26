package handler

import (
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
)

var adminJobStatuses = map[string]struct{}{
	"pending": {}, "claimed": {}, "completed": {}, "failed": {}, "dead_letter": {},
}

var adminJobTypes = map[string]struct{}{
	"investigate": {}, "fix": {}, "error_fix": {}, "session_analysis": {}, "ci_watch": {}, "route_map": {}, "product_context": {}, "issue_inquiry": {}, "score_sync": {}, "stack_resolve": {},
}

var secretRedactors = []struct {
	re          *regexp.Regexp
	replacement string
}{
	{regexp.MustCompile(`github_pat_[A-Za-z0-9_]+`), "[REDACTED]"},
	{regexp.MustCompile(`gh[opsur]_[A-Za-z0-9]+`), "[REDACTED]"},
	{regexp.MustCompile(`npm_[A-Za-z0-9]+`), "[REDACTED]"},
	{regexp.MustCompile(`xox[a-z]-[A-Za-z0-9-]+`), "[REDACTED]"},
	{regexp.MustCompile(`AKIA[0-9A-Z]{16}`), "[REDACTED]"},
	// Opslane project keys. The greedy tail must span the endpoint payload an
	// sk carries after its secret, so the whole credential goes, not its head.
	{regexp.MustCompile(`opslane_(?:pk|sk|ak)_[A-Za-z0-9_-]+`), "[REDACTED]"},
	// \b keeps hyphenated words like "disk-space" intact while still catching keys.
	{regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{6,}`), "[REDACTED]"},
	{regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`), "[REDACTED]"},
	{regexp.MustCompile(`(?i)Bearer\s+[^\s]+`), "Bearer [REDACTED]"},
	{regexp.MustCompile(`(?i)\b(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)\S+`), "${1}${2}[REDACTED]"},
	{regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://)[^/@\s]+@`), "${1}[REDACTED]@"},
}

func redactAdminError(value string) string {
	for _, redactor := range secretRedactors {
		value = redactor.re.ReplaceAllString(value, redactor.replacement)
	}
	runes := []rune(value)
	if len(runes) > 300 {
		return string(runes[:300]) + "…"
	}
	return value
}

func (d *Dependencies) AdminOverview(w http.ResponseWriter, r *http.Request) {
	overview, err := d.Queries.AdminOverviewData(r.Context())
	if err != nil {
		slog.Error("admin: overview query failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to load admin overview")
		return
	}
	writeJSON(w, http.StatusOK, overview)
}

func (d *Dependencies) AdminJobs(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeJSONError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = min(parsed, 200)
	}

	status := r.URL.Query().Get("status")
	if status != "" {
		if _, ok := adminJobStatuses[status]; !ok {
			writeJSONError(w, http.StatusBadRequest, "invalid status")
			return
		}
	}
	jobType := r.URL.Query().Get("job_type")
	if jobType != "" {
		if _, ok := adminJobTypes[jobType]; !ok {
			writeJSONError(w, http.StatusBadRequest, "invalid job_type")
			return
		}
	}

	jobs, err := d.Queries.AdminRecentJobs(r.Context(), limit, status, jobType)
	if err != nil {
		slog.Error("admin: recent jobs query failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to load admin jobs")
		return
	}
	for i := range jobs {
		if jobs[i].LastError != nil {
			redacted := redactAdminError(*jobs[i].LastError)
			jobs[i].LastError = &redacted
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
}
