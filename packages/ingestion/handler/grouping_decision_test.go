package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestGroupingDecision(t *testing.T) {
	rule, fingerprint, _ := groupingDecision("javascript", "Error", "ResizeObserver loop limit exceeded", "")
	if rule != "resize_observer" || fingerprint != "" {
		t.Fatalf("noise: got rule=%q fingerprint=%q, want resize_observer with empty fingerprint", rule, fingerprint)
	}

	_, firstFingerprint, firstTitle := groupingDecision("javascript", "TypeError", "Failed to fetch dynamically imported module: https://a.com/assets/chunk-index.Dlu29ZBh.js", "")
	_, secondFingerprint, secondTitle := groupingDecision("javascript", "TypeError", "Failed to fetch dynamically imported module: https://a.com/assets/chunk-index.Ck2mQ9xw.js", "")
	if firstFingerprint != "js|v2|r1|3394fed5608cf6c6b509abd8fbadef76" || firstFingerprint != secondFingerprint {
		t.Fatalf("family fingerprint wrong or unstable: %q vs %q", firstFingerprint, secondFingerprint)
	}
	if firstTitle != secondTitle || !strings.HasPrefix(firstTitle, "Stale deploy") {
		t.Fatalf("family title unstable or wrong: %q vs %q", firstTitle, secondTitle)
	}

	_, legacyFingerprint, legacyTitle := groupingDecision("javascript", "TypeError", "Cannot read properties of null (reading 'includes')", "at f (https://a.com/x.js:1:1)")
	if legacyFingerprint == "" || strings.HasPrefix(legacyFingerprint, "js|v2|") {
		t.Fatalf("non-matching event must take legacy fingerprint path, got %q", legacyFingerprint)
	}
	if legacyTitle != "TypeError: Cannot read properties of null (reading 'includes')" {
		t.Fatalf("legacy title changed: %q", legacyTitle)
	}

	pythonRule, pythonFingerprint, _ := groupingDecision("python", "ValueError", "ResizeObserver loop limit exceeded", "Traceback (most recent call last):\n  File \"app.py\", line 1")
	if pythonRule != "" || pythonFingerprint == "" || strings.HasPrefix(pythonFingerprint, "js|") {
		t.Fatalf("python must be untouched: rule=%q fingerprint=%q", pythonRule, pythonFingerprint)
	}

	longMessage := strings.Repeat("x", 300)
	_, _, longTitle := groupingDecision("javascript", "Error", longMessage, "")
	if len(longTitle) != 200 {
		t.Fatalf("title truncation lost: len=%d", len(longTitle))
	}
}

// A byte-sliced truncation cuts multi-byte runes in half, and Postgres rejects
// invalid UTF-8 on TEXT input — so a localized app with a long message would 500
// on insert and retry forever.
func TestGroupingDecisionTitleTruncationIsRuneSafe(t *testing.T) {
	for _, message := range []string{
		strings.Repeat("Помилка завантаження модуля ", 20), // 2-byte runes
		strings.Repeat("読み込みに失敗しました ", 30),                 // 3-byte runes
		strings.Repeat("🔥", 200),                           // 4-byte runes
	} {
		_, _, title := groupingDecision("javascript", "TypeError", message, "")
		if len(title) > 200 {
			t.Fatalf("title exceeds the 200-byte cap: len=%d", len(title))
		}
		if !utf8.ValidString(title) {
			t.Fatalf("truncation split a rune: %q", title)
		}
	}
}

func TestSuppressionReturnsBeforeDatabaseAccess(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(
		`{"platform":"javascript","environment":"does-not-exist","session_id":"unknown-session","error":{"type":"Error","message":"ResizeObserver loop limit exceeded","stack":""}}`,
	))
	ctx := context.WithValue(request.Context(), ctxProjectID, "project-id")
	ctx = context.WithValue(ctx, ctxEnvironmentID, "environment-id")
	request = request.WithContext(ctx)

	recorder := httptest.NewRecorder()
	(&Dependencies{}).IngestErrorEvent(recorder, request)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("suppression with nil database = %d (%s), want 202", recorder.Code, recorder.Body.String())
	}
	var response map[string]any
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response["suppressed"] != true || response["event_id"] != "" || response["group_id"] != "" || response["error_group_id"] != "" {
		t.Fatalf("unexpected suppression response: %#v", response)
	}
}
