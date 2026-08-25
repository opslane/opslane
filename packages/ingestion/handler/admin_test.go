package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseAdminEmails(t *testing.T) {
	emails := ParseAdminEmails(" Admin@Example.com, operator@example.com, ,ADMIN@example.com ")
	if len(emails) != 2 {
		t.Fatalf("got %d emails, want 2", len(emails))
	}
	for _, email := range []string{"admin@example.com", "operator@example.com"} {
		if _, ok := emails[email]; !ok {
			t.Errorf("missing normalized email %q", email)
		}
	}
}

func TestAdminJobsRejectsInvalidFiltersBeforeQuerying(t *testing.T) {
	deps := &Dependencies{}
	for _, path := range []string{
		"/api/v1/admin/jobs?limit=zero",
		"/api/v1/admin/jobs?limit=0",
		"/api/v1/admin/jobs?status=unknown",
		"/api/v1/admin/jobs?job_type=unknown",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		w := httptest.NewRecorder()
		deps.AdminJobs(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("GET %s = %d, want 400", path, w.Code)
		}
	}
}

func TestAdminJobsAllowsCIWatchFilter(t *testing.T) {
	if _, ok := adminJobTypes["ci_watch"]; !ok {
		t.Fatal("ci_watch is missing from the admin job-type allowlist")
	}
	if _, ok := adminJobTypes["route_map"]; !ok {
		t.Fatal("route_map is missing from the admin job-type allowlist")
	}
	if _, ok := adminJobTypes["product_context"]; !ok {
		t.Fatal("product_context is missing from the admin job-type allowlist")
	}
	if _, ok := adminJobTypes["issue_inquiry"]; !ok {
		t.Fatal("issue_inquiry is missing from the admin job-type allowlist")
	}
	if _, ok := adminJobTypes["score_sync"]; !ok {
		t.Fatal("score_sync is missing from the admin job-type allowlist")
	}
}

func TestRedactAdminError(t *testing.T) {
	raw := "ghp_abcdefghijklmnopqrstuvwxyz github_pat_abc_DEF123 sk-secret Bearer top-secret https://user:pass@example.com/path"
	got := redactAdminError(raw)
	for _, secret := range []string{"ghp_", "github_pat_", "sk-secret", "top-secret", "user:pass"} {
		if strings.Contains(got, secret) {
			t.Errorf("redacted error still contains %q: %s", secret, got)
		}
	}
	if !strings.Contains(got, "https://[REDACTED]@example.com/path") {
		t.Errorf("URL userinfo was not redacted correctly: %s", got)
	}
}

func TestRedactAdminErrorCoversCommonCredentialShapes(t *testing.T) {
	raw := "gho_16C7e42F292c6912E7710c838347Ae178B4a " +
		"npm_AbCdEf1234567890 xoxb-1234-5678-abcdef " +
		"AKIAIOSFODNN7EXAMPLE eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dGVzdHNpZw " +
		"password=hunter2 api_key: abc123"
	got := redactAdminError(raw)
	for _, secret := range []string{"gho_16C", "npm_AbC", "xoxb-1234", "AKIAIOSFODNN7EXAMPLE", "eyJhbGciOiJIUzI1NiJ9", "hunter2", "abc123"} {
		if strings.Contains(got, secret) {
			t.Errorf("redacted error still contains %q: %s", secret, got)
		}
	}
}

// skCanary is vectors.valid[0].raw from
// test-fixtures/sourcemap-key/vectors.json: a full endpoint-bearing sk. Its
// key id is the frozen fixture id allowlisted in .gitleaks.toml, so this
// canary authenticates nothing.
const skCanary = "opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA" +
	"_eyJ2IjoxLCJpYXQiOiIyMDI2LTA4LTA0VDAwOjAwOjAwWiIsInVybCI6Imh0dHBzOi8vaW5nZXN0Lm9wc2xhbmUuY29tIn0"

func TestRedactAdminErrorSwallowsEndpointBearingProjectKey(t *testing.T) {
	got := redactAdminError("upload rejected for key " + skCanary + " end")
	for _, remnant := range []string{
		"opslane_sk_",
		"E2ESOURCEMAPSECRET",
		"eyJ2IjoxLCJpYXQiOiIyMDI2LTA4LTA0VDAwOjAwOjAwWiIsInVybCI6Imh0dHBzOi8vaW5nZXN0Lm9wc2xhbmUuY29tIn0",
	} {
		if strings.Contains(got, remnant) {
			t.Errorf("redacted error still contains %q: %s", remnant, got)
		}
	}
	if want := "upload rejected for key [REDACTED] end"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestRedactAdminErrorSwallowsAPIKey(t *testing.T) {
	const key = "opslane_ak_mzxw6ytboi3damrrgi3tknzxgq_E2EAPISECRETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	got := redactAdminError("request rejected for key " + key + " end")
	if strings.Contains(got, "opslane_ak_") || strings.Contains(got, "E2EAPISECRET") {
		t.Fatalf("redacted error leaked api key: %s", got)
	}
}

func TestRedactAdminErrorPreservesBenignText(t *testing.T) {
	in := "disk-space exhausted while writing task-output to /var/tmp"
	if got := redactAdminError(in); got != in {
		t.Errorf("benign text was mangled: %q", got)
	}
}

func TestRedactAdminErrorTruncatesRunesAfterRedaction(t *testing.T) {
	got := redactAdminError(strings.Repeat("界", 301))
	if len([]rune(got)) != 301 || !strings.HasSuffix(got, "…") {
		t.Fatalf("got %d runes and suffix %q", len([]rune(got)), got[len(got)-3:])
	}
}
