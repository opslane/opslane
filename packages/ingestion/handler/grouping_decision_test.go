package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/opslane/opslane/packages/ingestion/grouping"
)

// setDebugIDFrames flips the start-up flag for one test and restores it.
func setDebugIDFrames(t *testing.T, enabled bool) {
	t.Helper()
	previous := debugIDFramesEnabled
	debugIDFramesEnabled = enabled
	t.Cleanup(func() { debugIDFramesEnabled = previous })
}

func TestGroupingDecision_FlagCollapsesPerLoadURLs(t *testing.T) {
	const debugID = "afa8111b-3697-ce9d-b9e5-4e52afdb3b57"
	urlA := "https://59n3u0-x.cdn.prod.atlassian-dev.net/a/global-page/_ctx_AAAA"
	urlB := "https://abcrz-y.cdn.prod.atlassian-dev.net/a/global-page/_ctx_BBBB"
	stackA := "e: boom\n    at Object.h (" + urlA + ":1:2)"
	stackB := "e: boom\n    at Object.h (" + urlB + ":1:2)"
	imagesA := []grouping.SourceImage{{CodeFile: urlA, DebugID: debugID}}
	imagesB := []grouping.SourceImage{{CodeFile: urlB, DebugID: debugID}}

	setDebugIDFrames(t, true)
	_, onA, _ := groupingDecision("javascript", "e", "boom", stackA, imagesA)
	_, onB, _ := groupingDecision("javascript", "e", "boom", stackB, imagesB)
	if onA != onB {
		t.Errorf("flag on: per-load URLs must collapse, %s != %s", onA, onB)
	}

	setDebugIDFrames(t, false)
	_, offA, _ := groupingDecision("javascript", "e", "boom", stackA, imagesA)
	_, offB, _ := groupingDecision("javascript", "e", "boom", stackB, imagesB)
	if offA == offB {
		t.Error("flag off: behavior must be unchanged, so these must still splinter")
	}
}

func TestGroupingDecision_DefaultsToOff(t *testing.T) {
	if os.Getenv("GROUPING_DEBUG_ID_FRAMES") != "" {
		t.Skip("env var set in this environment; default cannot be observed")
	}
	if debugIDFramesEnabled {
		t.Error("GROUPING_DEBUG_ID_FRAMES must default to off")
	}
}

// Substitution is a JavaScript concept. Python frames go through pythonFrames
// and must never be rewritten, even if debug_meta is somehow present.
func TestGroupingDecision_NeverSubstitutesOnPython(t *testing.T) {
	setDebugIDFrames(t, true)
	stack := "Traceback (most recent call last):\n  File \"https://cdn.example.net/app.py\", line 3, in handler\n    raise ValueError('x')"
	images := []grouping.SourceImage{{CodeFile: "https://cdn.example.net/app.py", DebugID: "afa8111b-3697-ce9d-b9e5-4e52afdb3b57"}}

	_, withImages, _ := groupingDecision("python", "ValueError", "x", stack, images)
	_, without, _ := groupingDecision("python", "ValueError", "x", stack, nil)

	if withImages != without {
		t.Errorf("python grouping must ignore debug_meta images: %s != %s", withImages, without)
	}
}

func TestGroupingDecision_SuppressionStillWinsWithImages(t *testing.T) {
	setDebugIDFrames(t, true)
	rule, fp, _ := groupingDecision("javascript", "Error", "ResizeObserver loop limit exceeded", "", nil)
	if rule != "resize_observer" {
		t.Errorf("suppression must still run first, got rule %q", rule)
	}
	if fp != "" {
		t.Errorf("suppressed events must not be fingerprinted, got %q", fp)
	}
}

func TestGroupingDecision(t *testing.T) {
	rule, fingerprint, _ := groupingDecision("javascript", "Error", "ResizeObserver loop limit exceeded", "", nil)
	if rule != "resize_observer" || fingerprint != "" {
		t.Fatalf("noise: got rule=%q fingerprint=%q, want resize_observer with empty fingerprint", rule, fingerprint)
	}

	_, firstFingerprint, firstTitle := groupingDecision("javascript", "TypeError", "Failed to fetch dynamically imported module: https://a.com/assets/chunk-index.Dlu29ZBh.js", "", nil)
	_, secondFingerprint, secondTitle := groupingDecision("javascript", "TypeError", "Failed to fetch dynamically imported module: https://a.com/assets/chunk-index.Ck2mQ9xw.js", "", nil)
	if firstFingerprint != "js|v2|r1|3394fed5608cf6c6b509abd8fbadef76" || firstFingerprint != secondFingerprint {
		t.Fatalf("family fingerprint wrong or unstable: %q vs %q", firstFingerprint, secondFingerprint)
	}
	if firstTitle != secondTitle || !strings.HasPrefix(firstTitle, "Stale deploy") {
		t.Fatalf("family title unstable or wrong: %q vs %q", firstTitle, secondTitle)
	}

	_, legacyFingerprint, legacyTitle := groupingDecision("javascript", "TypeError", "Cannot read properties of null (reading 'includes')", "at f (https://a.com/x.js:1:1)", nil)
	if legacyFingerprint == "" || strings.HasPrefix(legacyFingerprint, "js|v2|") {
		t.Fatalf("non-matching event must take legacy fingerprint path, got %q", legacyFingerprint)
	}
	if legacyTitle != "TypeError: Cannot read properties of null (reading 'includes')" {
		t.Fatalf("legacy title changed: %q", legacyTitle)
	}

	pythonRule, pythonFingerprint, _ := groupingDecision("python", "ValueError", "ResizeObserver loop limit exceeded", "Traceback (most recent call last):\n  File \"app.py\", line 1", nil)
	if pythonRule != "" || pythonFingerprint == "" || strings.HasPrefix(pythonFingerprint, "js|") {
		t.Fatalf("python must be untouched: rule=%q fingerprint=%q", pythonRule, pythonFingerprint)
	}

	longMessage := strings.Repeat("x", 300)
	_, _, longTitle := groupingDecision("javascript", "Error", longMessage, "", nil)
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
		_, _, title := groupingDecision("javascript", "TypeError", message, "", nil)
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
