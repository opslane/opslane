# Grouping Slice 1: Suppression + Stale-Deploy Family Rule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2** — incorporates Codex review rounds 1 and 2 (18 further findings: fixed test expectations, canonical-group self-closure exclusion, in-transaction reclassification, event-level platform, honest suppression response, run()-error structure, audit manifest, deterministic outputs, disposable-DB smoke with polling).

**Goal:** Stop the two biggest grouping failures in prod — noise events minting groups, and the stale-deploy asset family minting one group per deploy (86 of 145 groups) — by adding rung-0 suppression and the rung-1 family rule in front of the existing fingerprint algorithm, plus the shadow report and cutover script that validate and land the change.

**Architecture:** Two pure-function detectors in the Go `grouping` package run before `Fingerprint()` in the ingest handler: `Suppress()` drops known-noise events with a per-rule counter (no event row, HTTP 202 with an honest suppression response), and `FamilyFingerprint()` maps all four browser wordings of stale-deploy asset failures to one constant fingerprint per project (scoping via the existing `UNIQUE(project_id, fingerprint)` constraint). A read-only `shadow-regroup` command classifies stored events per event-level platform and prints a deterministic per-project report; a `cutover-close` command closes superseded old-scheme groups — classified by their EVENTS through the same detectors, reclassified inside the closing transaction, never by title, never touching new-scheme (`js|v2|%`) groups.

**Tech Stack:** Go 1.24, pgx (existing), `atomic.Int64` counters + text metrics endpoint (existing `handler/metrics.go` pattern), shared JSON fixture corpus under `test-fixtures/grouping/`.

**Design authority:** `docs/decisions/grouping-ladder.md` → `LOCKED PLAN` section, build-order item 1. Rungs 2/3, the key table, and the Go resolver are explicitly OUT of this plan (separate plan after this lands).

## Global Constraints

- The ladder applies to `platform == "javascript"` only; any other platform takes the existing `Fingerprint()` path byte-for-byte unchanged.
- Family fingerprint is the exact constant `js|v2|r1|3394fed5608cf6c6b509abd8fbadef76` (`"js|v2|r1|" + hex(sha256("stale-deploy")[:16])`) — never raw message text.
- `POST /api/v1/events` request contract unchanged. **Suppression response contract:** HTTP 202 with the same three keys as accepted events, all empty strings (`event_id: ""`, `group_id: ""`, `error_group_id: ""`), plus one ADDITIVE optional field `"suppressed": true`. No phantom ids — a generated-but-unstored UUID would be a receipt for nothing; empty means "accepted, intentionally not stored." Adding an optional response field is allowed by the append-only wire contract. Never edit frozen fixtures under `test-fixtures/wire/`.
- **Suppression placement contract (decided, not accidental):** the early return runs after auth, body validation, platform defaulting, and scrubbing, but BEFORE environment resolution, session/environment conflict checks, and any DB access. Dropped events need no environment; suppression works even when the DB is down. It records ingest duration and the per-rule counter, and deliberately does not increment `eventsIngestedTotal` or enqueue jobs.
- Suppression is conservative by construction: a stack line the parser doesn't understand means DO NOT suppress.
- Cutover closes ONLY groups that are (a) old-scheme (`fingerprint NOT LIKE 'js|v2|%'` — the canonical family group itself must never be closeable), (b) in status `investigated` or `needs_human`, re-checked under lock, and (c) fully removable — every event classifies as family or suppressed BY EVENT PLATFORM (`error_events.platform`, NOT NULL since migration 016; `error_groups.platform` is nullable and untrusted) — re-verified INSIDE the closing transaction.
- Both ops commands require `--project <uuid>` (repeatable for shadow); there is no all-projects mode.
- Ops command structure: `main()` is a thin wrapper around `run() error` — no `os.Exit` inside logic (it bypasses deferred `Rollback`/`Close`).
- No new dependencies. No migrations.
- Verification per `packages/ingestion/AGENTS.md` (`go build ./...`, `go test ./...`) and root `AGENTS.md` (live smoke on a DISPOSABLE compose database, worker running, job polled to a terminal state).

**Accepted limitations (decided, not oversights):** (1) A message that merely QUOTES a family wording matches the family — locked predicate is message-pattern-only; the corpus documents one such case. (2) Suppression rule precedence is fixed (resize_observer → script_error → extension_only); the test pins it. (3) Groups whose pass-2 jobs terminalize as `pr_created`/`resolved`/`merged` keep their real provenance and are deliberately never closed by this script.

---

### Task 1: Shared family corpus fixture

**Files:**
- Create: `test-fixtures/grouping/stale-deploy-corpus.json`

**Interfaces:**
- Produces: JSON array consumed by Task 3's Go test (and later by the worker's TS triage-detector tests — same file, so the two sides cannot drift). Schema per entry: `{"message": string, "family": "stale-deploy" | null, "note": string}`.

- [ ] **Step 1: Write the fixture**

```json
[
  {"message": "Failed to fetch dynamically imported module: https://app.customer.com/assets/chunk-index.Dlu29ZBh.js", "family": "stale-deploy", "note": "Chrome wording, dot-segment hash (real prod shape)"},
  {"message": "Failed to fetch dynamically imported module: https://app.customer.com/assets/chunk-BdA9x2Lq.js", "family": "stale-deploy", "note": "Chrome wording, dash-hash Vite default"},
  {"message": "error loading dynamically imported module: https://app.customer.com/assets/settings-Cq2w8xLp.js", "family": "stale-deploy", "note": "Firefox wording (lowercase start, mid-string match required)"},
  {"message": "TypeError: error loading dynamically imported module", "family": "stale-deploy", "note": "Firefox wording with type prefix baked into message"},
  {"message": "Importing a module script failed.", "family": "stale-deploy", "note": "Safari wording"},
  {"message": "  Failed to fetch dynamically imported module: https://a.com/x.js", "family": "stale-deploy", "note": "leading whitespace must not defeat the match"},
  {"message": "Unable to preload CSS for /assets/index-BUccYFyj.css", "family": "stale-deploy", "note": "Vite CSS preload, all-letter hash (real prod title)"},
  {"message": "unable to preload CSS for /assets/asset-SettingsRow.OdZiYodm.css", "family": "stale-deploy", "note": "case-insensitivity check"},
  {"message": "Cannot read properties of null (reading 'includes')", "family": null, "note": "ordinary TypeError must not match"},
  {"message": "Error loading vendor.min.js", "family": null, "note": "generic load error is NOT the family"},
  {"message": "Failed to fetch", "family": null, "note": "bare fetch failure (network/CORS) is NOT the family"},
  {"message": "Loading chunk 26 failed", "family": null, "note": "webpack wording — out of scope for v1, must not match"},
  {"message": "NetworkError when attempting to fetch resource.", "family": null, "note": "generic network error"},
  {"message": "Помилка завантаження модуля", "family": null, "note": "localized wording — out of scope for v1 (unicode passthrough must not crash)"},
  {"message": "Widget error: user saw \"Failed to fetch dynamically imported module\" banner", "family": "stale-deploy", "note": "KNOWN ACCEPTED FALSE POSITIVE — quoted family wording matches by design (locked predicate is message-pattern-only); documented here so nobody 'fixes' the corpus without revisiting the locked decision"}
]
```

- [ ] **Step 2: Validate it parses**

Run from the repo root: `python3 -c "import json; d=json.load(open('test-fixtures/grouping/stale-deploy-corpus.json')); print(len(d), 'entries')"`
Expected: `15 entries`

- [ ] **Step 3: Commit**

```bash
git add test-fixtures/grouping/stale-deploy-corpus.json
git commit -m "test: add shared stale-deploy family corpus fixture"
```

---

### Task 2: Suppression detector

**Files:**
- Create: `packages/ingestion/grouping/suppress.go`
- Test: `packages/ingestion/grouping/suppress_test.go`

**Interfaces:**
- Produces: `func Suppress(platform, errorMessage, stackTrace string) (rule string, suppressed bool)` — rule is `"resize_observer"`, `"script_error"`, `"extension_only"`, or `""`. Package-private `func classifyStackLines(stackTrace string) (parsedSchemes []string, unparsed int)`.

- [ ] **Step 1: Write the failing test**

```go
package grouping

import "testing"

func TestSuppress(t *testing.T) {
	cases := []struct {
		name     string
		platform string
		msg      string
		stack    string
		wantRule string
		want     bool
	}{
		{"resize observer limit", "javascript", "ResizeObserver loop limit exceeded", "", "resize_observer", true},
		{"resize observer undelivered", "javascript", "ResizeObserver loop completed with undelivered notifications.", "at fn (https://a.com/x.js:1:1)", "resize_observer", true},
		{"stackless script error", "javascript", "Script error.", "", "script_error", true},
		{"whitespace-only stack is stackless", "javascript", "Script error.", "  \n ", "script_error", true},
		{"script error with frames NOT suppressed", "javascript", "Script error.", "at fn (https://a.com/x.js:1:1)", "", false},
		{"script error with UNPARSEABLE stack NOT suppressed", "javascript", "Script error.", "some opaque stack text", "", false},
		{"extension only V8", "javascript", "boom", "at inject (chrome-extension://abcdef/content.js:10:5)\nat run (chrome-extension://abcdef/bg.js:2:1)", "extension_only", true},
		{"extension only gecko", "javascript", "boom", "wrap@moz-extension://uuid-here/inject.js:3:9", "extension_only", true},
		{"extension only with V8 message header line", "javascript", "boom", "TypeError: boom\n    at inject (chrome-extension://abcdef/content.js:10:5)", "extension_only", true},
		{"header after leading blank line still recognized", "javascript", "boom", "\nTypeError: boom\n    at inject (chrome-extension://abcdef/content.js:10:5)", "extension_only", true},
		{"mixed app+extension NOT suppressed", "javascript", "boom", "at inject (chrome-extension://abcdef/content.js:10:5)\nat app (https://a.com/app.js:1:1)", "", false},
		{"extension + unparseable line NOT suppressed", "javascript", "boom", "at inject (chrome-extension://abcdef/content.js:10:5)\n[native code]", "", false},
		{"empty stack must NOT match extension rule", "javascript", "boom", "", "", false},
		{"header-only stack must NOT match extension rule", "javascript", "boom", "TypeError: boom", "", false},
		{"python never suppressed", "python", "Script error.", "", "", false},
		{"precedence resize before extension", "javascript", "ResizeObserver loop limit exceeded", "at f (chrome-extension://abc/x.js:1:1)", "resize_observer", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rule, got := Suppress(c.platform, c.msg, c.stack)
			if got != c.want || rule != c.wantRule {
				t.Fatalf("Suppress(%q,%q,%q) = (%q,%v), want (%q,%v)", c.platform, c.msg, c.stack, rule, got, c.wantRule, c.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ingestion && go test ./grouping -run TestSuppress -v`
Expected: FAIL — `undefined: Suppress`

- [ ] **Step 3: Write the implementation**

```go
package grouping

import (
	"regexp"
	"strings"
)

// reFrameURL matches the URL inside a stack frame line in either engine format:
// V8 "at fn (scheme://host/path:1:2)" / "at scheme://host/path:1:2" and
// Gecko/JSC "fn@scheme://host/path:1:2".
var reFrameURL = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*)://[^\s()]+:\d+:\d+`)

// reErrorHeader matches a leading "Identifier: message" line. V8 embeds the
// error name+message as the first line of err.stack; we tolerate any
// identifier prefix (custom error classes included). Only the FIRST non-blank
// line is ever treated as a header.
var reErrorHeader = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_$]*: `)

var extensionSchemes = map[string]struct{}{
	"chrome-extension":     {},
	"moz-extension":        {},
	"safari-extension":     {},
	"safari-web-extension": {},
}

// classifyStackLines walks nonempty stack lines and returns the scheme of each
// line that parses as a frame, plus the count of nonempty lines that are
// neither a parseable frame nor the first-non-blank error-header line. Callers
// deciding to DELETE an event must treat unparsed > 0 as "we don't understand
// this stack".
func classifyStackLines(stackTrace string) (parsedSchemes []string, unparsed int) {
	seenNonBlank := false
	for _, line := range strings.Split(stackTrace, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		first := !seenNonBlank
		seenNonBlank = true
		if m := reFrameURL.FindStringSubmatch(line); m != nil {
			parsedSchemes = append(parsedSchemes, strings.ToLower(m[1]))
			continue
		}
		if first && reErrorHeader.MatchString(line) {
			continue // V8 embeds "TypeError: message" as the first stack line
		}
		unparsed++
	}
	return parsedSchemes, unparsed
}

// Suppress reports whether the event is known noise that should be dropped
// before grouping (rung 0). JavaScript platform only. Rule order is a fixed
// contract: resize_observer, then script_error, then extension_only.
// Conservative by design: anything the parser doesn't fully understand is NOT
// suppressed — wrong-drop loses data forever, wrong-keep costs one group.
func Suppress(platform, errorMessage, stackTrace string) (string, bool) {
	if platform != "javascript" {
		return "", false
	}
	msg := strings.TrimSpace(errorMessage)
	if strings.HasPrefix(msg, "ResizeObserver loop") {
		return "resize_observer", true
	}
	if strings.EqualFold(msg, "Script error.") && strings.TrimSpace(stackTrace) == "" {
		return "script_error", true
	}
	schemes, unparsed := classifyStackLines(stackTrace)
	if len(schemes) > 0 && unparsed == 0 {
		allExtension := true
		for _, s := range schemes {
			if _, ok := extensionSchemes[s]; !ok {
				allExtension = false
				break
			}
		}
		if allExtension {
			return "extension_only", true
		}
	}
	return "", false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/ingestion && go test ./grouping -run TestSuppress -v`
Expected: PASS (all 16 subtests)

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/grouping/suppress.go packages/ingestion/grouping/suppress_test.go
git commit -m "feat(ingestion): rung-0 suppression detector, conservative on unparsed stacks"
```

---

### Task 3: Family rule detector

Identical to Revision 1 (unchanged by round 2): create `packages/ingestion/grouping/family.go` + `family_test.go` exactly as specified below.

**Interfaces:**
- Consumes: `test-fixtures/grouping/stale-deploy-corpus.json` (relative path `../../../test-fixtures/grouping/`).
- Produces: `func FamilyFingerprint(platform, errorMessage string) (fingerprint string, matched bool)`, `const FamilyTitleStaleDeploy = "Stale deploy: hashed asset failed to load after release"`. Fingerprint is the exact constant `js|v2|r1|3394fed5608cf6c6b509abd8fbadef76`.

- [ ] **Step 1: Write the failing test**

```go
package grouping

import (
	"encoding/json"
	"os"
	"testing"
)

type corpusEntry struct {
	Message string  `json:"message"`
	Family  *string `json:"family"`
	Note    string  `json:"note"`
}

func TestFamilyFingerprintCorpus(t *testing.T) {
	raw, err := os.ReadFile("../../../test-fixtures/grouping/stale-deploy-corpus.json")
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	var entries []corpusEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("parse corpus: %v", err)
	}
	if len(entries) < 10 {
		t.Fatalf("corpus suspiciously small: %d entries", len(entries))
	}
	// Exact constant — sha256("stale-deploy")[:16] hex with the domain prefix.
	// If this assertion surprises you, you changed the hash input; that is a
	// grouping cutover, not a refactor.
	const wantKey = "js|v2|r1|3394fed5608cf6c6b509abd8fbadef76"
	for _, e := range entries {
		fp, ok := FamilyFingerprint("javascript", e.Message)
		wantMatch := e.Family != nil && *e.Family == "stale-deploy"
		if ok != wantMatch {
			t.Errorf("FamilyFingerprint(%q) matched=%v, want %v (%s)", e.Message, ok, wantMatch, e.Note)
		}
		if ok && fp != wantKey {
			t.Errorf("fingerprint = %q, want exact constant %q", fp, wantKey)
		}
	}
}

func TestFamilyFingerprintPlatformScope(t *testing.T) {
	for _, platform := range []string{"python", "", "node", "javascript-worker"} {
		if _, ok := FamilyFingerprint(platform, "Failed to fetch dynamically imported module: x.js"); ok {
			t.Fatalf("family rule must not fire for platform %q", platform)
		}
	}
}
```

- [ ] **Step 2: Run to verify FAIL** (`undefined: FamilyFingerprint`), then **Step 3: implement**:

```go
package grouping

import (
	"crypto/sha256"
	"fmt"
	"strings"
)

// FamilyTitleStaleDeploy is the stable group title for the stale-deploy family;
// the per-event "Type: Message" title would churn with each deploy's hash.
const FamilyTitleStaleDeploy = "Stale deploy: hashed asset failed to load after release"

// staleDeployKey is "js|v2|r1|" + first 128 bits of sha256("stale-deploy"),
// hex: js|v2|r1|3394fed5608cf6c6b509abd8fbadef76. Domain-separated per the
// locked key format — never raw message text.
var staleDeployKey = func() string {
	h := sha256.Sum256([]byte("stale-deploy"))
	return fmt.Sprintf("js|v2|r1|%x", h[:16])
}()

// familyNeedles are the four documented engine wordings, matched
// case-insensitively as substrings. Substring (not prefix) because SDKs and
// rethrow wrappers sometimes bake "TypeError: " into the message itself.
var familyNeedles = []string{
	"failed to fetch dynamically imported module",
	"error loading dynamically imported module",
	"importing a module script failed",
	"unable to preload css",
}

// FamilyFingerprint maps every wording of the stale-deploy asset family to one
// constant fingerprint (rung 1). Per-project scoping comes from the DB
// UNIQUE(project_id, fingerprint) constraint. JavaScript platform only.
func FamilyFingerprint(platform, errorMessage string) (string, bool) {
	if platform != "javascript" {
		return "", false
	}
	msg := strings.ToLower(errorMessage)
	for _, needle := range familyNeedles {
		if strings.Contains(msg, needle) {
			return staleDeployKey, true
		}
	}
	return "", false
}
```

- [ ] **Step 4: Run** `cd packages/ingestion && go test ./grouping` — PASS with no regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/grouping/family.go packages/ingestion/grouping/family_test.go
git commit -m "feat(ingestion): rung-1 stale-deploy family rule with shared corpus test"
```

---

### Task 4: Handler wiring, suppression counters, integration test

**Files:**
- Modify: `packages/ingestion/handler/error_event.go` (fingerprint block ~line 114; accepted-response writer ~line 257 stays untouched)
- Modify: `packages/ingestion/handler/metrics.go` (counter vars ~line 29, record funcs ~line 106, metrics text output ~line 221)
- Test: `packages/ingestion/handler/grouping_decision_test.go` (new, pure) + integration tests following existing patterns in `packages/ingestion/handler/error_event_test.go`

**Interfaces:**
- Consumes: `grouping.Suppress`, `grouping.FamilyFingerprint`, `grouping.Fingerprint`, `grouping.FamilyTitleStaleDeploy`.
- Produces: `func groupingDecision(platform, errorType, errorMessage, stackTrace string) (suppressRule string, fingerprint string, title string)`, `func RecordSuppressed(rule string)`.

- [ ] **Step 1: Write the failing pure test** — exactly as Revision 1 (family constant `js|v2|r1|3394fed5608cf6c6b509abd8fbadef76`, legacy title/fingerprint preservation, python untouched, 200-char truncation):

```go
package handler

import (
	"strings"
	"testing"
)

func TestGroupingDecision(t *testing.T) {
	rule, fp, _ := groupingDecision("javascript", "Error", "ResizeObserver loop limit exceeded", "")
	if rule != "resize_observer" || fp != "" {
		t.Fatalf("noise: got rule=%q fp=%q, want resize_observer with empty fp", rule, fp)
	}

	_, fp1, title1 := groupingDecision("javascript", "TypeError", "Failed to fetch dynamically imported module: https://a.com/assets/chunk-index.Dlu29ZBh.js", "")
	_, fp2, title2 := groupingDecision("javascript", "TypeError", "Failed to fetch dynamically imported module: https://a.com/assets/chunk-index.Ck2mQ9xw.js", "")
	if fp1 != "js|v2|r1|3394fed5608cf6c6b509abd8fbadef76" || fp1 != fp2 {
		t.Fatalf("family fingerprint wrong or unstable: %q vs %q", fp1, fp2)
	}
	if title1 != title2 || !strings.HasPrefix(title1, "Stale deploy") {
		t.Fatalf("family title unstable or wrong: %q vs %q", title1, title2)
	}

	_, fp3, title3 := groupingDecision("javascript", "TypeError", "Cannot read properties of null (reading 'includes')", "at f (https://a.com/x.js:1:1)")
	if fp3 == "" || strings.HasPrefix(fp3, "js|v2|") {
		t.Fatalf("non-matching event must take the legacy fingerprint path, got %q", fp3)
	}
	if title3 != "TypeError: Cannot read properties of null (reading 'includes')" {
		t.Fatalf("legacy title changed: %q", title3)
	}

	rule4, fp4, _ := groupingDecision("python", "ValueError", "ResizeObserver loop limit exceeded", "Traceback (most recent call last):\n  File \"app.py\", line 1")
	if rule4 != "" || fp4 == "" || strings.HasPrefix(fp4, "js|") {
		t.Fatalf("python must be untouched: rule=%q fp=%q", rule4, fp4)
	}

	long := strings.Repeat("x", 300)
	_, _, title5 := groupingDecision("javascript", "Error", long, "")
	if len(title5) != 200 {
		t.Fatalf("title truncation lost: len=%d", len(title5))
	}
}
```

- [ ] **Step 2: Run to verify FAIL** (`undefined: groupingDecision`)

- [ ] **Step 3: Implement**

`groupingDecision` in `error_event.go` above `handleErrorEvent`:

```go
// groupingDecision runs the rung-0/rung-1 ladder in front of the legacy
// fingerprint. Returns a non-empty suppressRule when the event is known noise
// (no fingerprint, no event row); otherwise the fingerprint and title to use.
// Pure function so the ladder is testable without the HTTP/DB harness.
func groupingDecision(platform, errorType, errorMessage, stackTrace string) (string, string, string) {
	if rule, drop := grouping.Suppress(platform, errorMessage, stackTrace); drop {
		return rule, "", ""
	}
	title := errorType + ": " + errorMessage
	if len(title) > 200 {
		title = title[:200]
	}
	if fp, ok := grouping.FamilyFingerprint(platform, errorMessage); ok {
		return "", fp, grouping.FamilyTitleStaleDeploy
	}
	return "", grouping.Fingerprint(platform, errorType, errorMessage, stackTrace), title
}
```

Replace the fingerprint+title block in `handleErrorEvent` with:

```go
	suppressRule, fingerprint, title := groupingDecision(payload.Platform, payload.Error.Type, payload.Error.Message, payload.Error.Stack)
	if suppressRule != "" {
		RecordSuppressed(suppressRule)
		RecordIngestDuration(time.Since(start).Seconds())
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]any{
			"event_id":       "", // honest: nothing stored, nothing to reference
			"group_id":       "",
			"error_group_id": "",
			"suppressed":     true, // additive optional field, allowed by the append-only contract
		})
		return
	}
```

**Notes to implementer:** (a) the placement is the Suppression placement contract in Global Constraints — after auth/validation/platform-default/scrub, before environment resolution and any DB access; do not move it; (b) the accepted-event response at ~line 259 stays byte-identical to today.

`metrics.go` — counters (~line 29):

```go
	suppressedResizeObserverTotal atomic.Int64
	suppressedScriptErrorTotal    atomic.Int64
	suppressedExtensionOnlyTotal  atomic.Int64
```

Record function (~line 106):

```go
// RecordSuppressed increments the rung-0 suppression counter for a fixed rule
// set. Label cardinality is fixed; unknown rules are ignored on purpose.
func RecordSuppressed(rule string) {
	switch rule {
	case "resize_observer":
		suppressedResizeObserverTotal.Add(1)
	case "script_error":
		suppressedScriptErrorTotal.Add(1)
	case "extension_only":
		suppressedExtensionOnlyTotal.Add(1)
	}
}
```

Metrics text output next to `opslane_stackless_events_total` (~line 221) — without this the counters are invisible:

```go
	fmt.Fprintf(w, "opslane_suppressed_events_total{rule=\"resize_observer\"} %d\n", suppressedResizeObserverTotal.Load())
	fmt.Fprintf(w, "opslane_suppressed_events_total{rule=\"script_error\"} %d\n", suppressedScriptErrorTotal.Load())
	fmt.Fprintf(w, "opslane_suppressed_events_total{rule=\"extension_only\"} %d\n\n", suppressedExtensionOnlyTotal.Load())
```

- [ ] **Step 4: Run the pure test** — PASS.

- [ ] **Step 5: Write the integration test** — copy the existing setup pattern from `error_event_test.go` (do not invent a new harness; use whatever DB mechanism its DB-backed tests use). Assert:

1. **Suppressed event**: POST message `ResizeObserver loop limit exceeded` → 202; body `event_id == ""`, `group_id == ""`, `error_group_id == ""`, `suppressed == true`; `error_events` and `error_group_jobs` counts for the project unchanged; a NORMAL event posted before and after still returns non-empty ids and no `suppressed` field.
2. **Family collapse**: POST two events, messages `Failed to fetch dynamically imported module: https://a.com/assets/chunk-index.AAA111.js` / `...BBB222.js` → exactly one `error_groups` row with `fingerprint = 'js|v2|r1|3394fed5608cf6c6b509abd8fbadef76'`, `occurrence_count = 2`, `title = 'Stale deploy: hashed asset failed to load after release'`, exactly one job enqueued.

- [ ] **Step 6: Run** `cd packages/ingestion && go test ./handler ./grouping` — PASS. If an existing handler test posts `Script error.`/ResizeObserver fixtures to exercise the old terminalization path, change the fixture message to a non-suppressed one rather than weakening its assertion.

- [ ] **Step 7: Audit fingerprint-format assumptions**

Run: `grep -rn "fingerprint" packages/dashboard/src packages/worker/src shared/ --include="*.ts" --include="*.vue" -il`
Skim hits for hex/length assumptions (regex `[0-9a-f]{32}`, slicing, parsing). Expected: opaque strings everywhere; fix any violation in this task.

- [ ] **Step 8: Build and commit**

```bash
cd packages/ingestion && go build ./... && go test ./...
git add packages/ingestion/handler/error_event.go packages/ingestion/handler/metrics.go packages/ingestion/handler/grouping_decision_test.go packages/ingestion/handler/error_event_test.go
git commit -m "feat(ingestion): wire rung-0/rung-1 ladder into ingest with counters and integration tests"
```

---

### Task 5: Shadow report command

**Files:**
- Create: `packages/ingestion/shadow-regroup/main.go`
- Create: `packages/ingestion/shadow-regroup/predict.go`
- Test: `packages/ingestion/shadow-regroup/predict_test.go`

**Interfaces:**
- Consumes: `grouping.Suppress`, `grouping.FamilyFingerprint`. DB via `DATABASE_URL`, read-only session.
- Produces: `go run ./shadow-regroup --project <uuid> [--project <uuid>…]` prints a deterministic per-project report covering EVERY requested project (zero-event projects print `zero events`). Core: `type EventRow struct{ ProjectID, GroupID, Platform, ErrorMessage, StackRaw string }` (Platform is the EVENT's platform), `func Predict(rows []EventRow) Report`, `type ProjectReport struct{ SuppressedByRule map[string]int; FamilyEvents int; FamilyCollapsed []string; NoiseOnly []string; MixedGroups []string; UnchangedGroups int }`, `type Report struct{ PerProject map[string]ProjectReport }`.

- [ ] **Step 1: Write the failing test**

```go
package main

import "testing"

func TestPredict(t *testing.T) {
	rows := []EventRow{
		// Two old family groups (different deploy hashes) — both collapse into the family.
		{ProjectID: "p1", GroupID: "g1", Platform: "javascript", ErrorMessage: "Failed to fetch dynamically imported module: https://a.com/assets/chunk-index.Dlu29ZBh.js"},
		{ProjectID: "p1", GroupID: "g2", Platform: "javascript", ErrorMessage: "Unable to preload CSS for /assets/index-BUccYFyj.css"},
		// A group whose only event is suppressed noise — disappears (NOT part of the family).
		{ProjectID: "p1", GroupID: "g3", Platform: "javascript", ErrorMessage: "Script error."},
		// Untouched ordinary group.
		{ProjectID: "p1", GroupID: "g4", Platform: "javascript", ErrorMessage: "Cannot read properties of null (reading 'includes')", StackRaw: "at f (https://a.com/x.js:1:1)"},
		// Family + ordinary events — MIXED, survives, never auto-closed.
		{ProjectID: "p1", GroupID: "g5", Platform: "javascript", ErrorMessage: "Failed to fetch dynamically imported module: https://a.com/assets/x-Abc12345.js"},
		{ProjectID: "p1", GroupID: "g5", Platform: "javascript", ErrorMessage: "Cannot read properties of undefined (reading 'length')", StackRaw: "at g (https://a.com/y.js:2:2)"},
		// Suppressed noise + ordinary events — also MIXED.
		{ProjectID: "p1", GroupID: "g6", Platform: "javascript", ErrorMessage: "Script error."},
		{ProjectID: "p1", GroupID: "g6", Platform: "javascript", ErrorMessage: "Some real error", StackRaw: "at h (https://a.com/z.js:3:3)"},
		// Same group id under a DIFFERENT project must not cross-contaminate.
		{ProjectID: "p2", GroupID: "g1", Platform: "javascript", ErrorMessage: "Cannot read properties of null (reading 'x')", StackRaw: "at f (https://b.com/x.js:1:1)"},
		// Python events classify by EVENT platform: never family, never suppressed.
		{ProjectID: "p1", GroupID: "g7", Platform: "python", ErrorMessage: "Failed to fetch dynamically imported module: x.js"},
	}
	r := Predict(rows)
	p := r.PerProject["p1"]
	if p.SuppressedByRule["script_error"] != 2 {
		t.Errorf("script_error suppressed = %d, want 2", p.SuppressedByRule["script_error"])
	}
	if want := []string{"g1", "g2"}; !equalStrings(p.FamilyCollapsed, want) {
		t.Errorf("family collapsed = %v, want %v", p.FamilyCollapsed, want)
	}
	if want := []string{"g3"}; !equalStrings(p.NoiseOnly, want) {
		t.Errorf("noise-only = %v, want %v", p.NoiseOnly, want)
	}
	if want := []string{"g5", "g6"}; !equalStrings(p.MixedGroups, want) {
		t.Errorf("mixed groups = %v, want %v", p.MixedGroups, want)
	}
	if p.UnchangedGroups != 4 { // g4 ordinary, g5+g6 survive as mixed, g7 python
		t.Errorf("unchanged groups = %d, want 4", p.UnchangedGroups)
	}
	if r.PerProject["p2"].UnchangedGroups != 1 {
		t.Errorf("p2 must tally independently, got %+v", r.PerProject["p2"])
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
```

- [ ] **Step 2: Run to verify FAIL** (`undefined: Predict`)

- [ ] **Step 3: Implement predict.go**

```go
package main

import (
	"sort"

	"github.com/opslane/opslane/packages/ingestion/grouping"
)

// EventRow carries the EVENT's platform (error_events.platform, NOT NULL since
// migration 016) — error_groups.platform is nullable legacy data and untrusted.
type EventRow struct {
	ProjectID, GroupID, Platform, ErrorMessage, StackRaw string
}

type ProjectReport struct {
	SuppressedByRule map[string]int
	FamilyEvents     int
	FamilyCollapsed  []string // every event is family (or family+noise): joins the ONE family group
	NoiseOnly        []string // every event is suppressed noise: the group disappears entirely
	MixedGroups      []string // removable + ordinary events: survives, cutover must NOT touch
	UnchangedGroups  int
}

type Report struct {
	PerProject map[string]ProjectReport
}

// Predict classifies every stored event under the slice-1 ladder. A group is
// removable only when ALL its events classify as family or suppressed; family
// participation decides whether it collapses INTO the family group or simply
// disappears. Mixed groups survive and are cutover-ineligible.
func Predict(rows []EventRow) Report {
	type key struct{ project, group string }
	type tally struct{ family, suppressed, ordinary int }
	tallies := map[key]*tally{}
	suppressedByRule := map[string]map[string]int{}
	familyEvents := map[string]int{}

	for _, row := range rows {
		k := key{row.ProjectID, row.GroupID}
		t := tallies[k]
		if t == nil {
			t = &tally{}
			tallies[k] = t
		}
		if rule, drop := grouping.Suppress(row.Platform, row.ErrorMessage, row.StackRaw); drop {
			t.suppressed++
			if suppressedByRule[row.ProjectID] == nil {
				suppressedByRule[row.ProjectID] = map[string]int{}
			}
			suppressedByRule[row.ProjectID][rule]++
			continue
		}
		if _, ok := grouping.FamilyFingerprint(row.Platform, row.ErrorMessage); ok {
			t.family++
			familyEvents[row.ProjectID]++
			continue
		}
		t.ordinary++
	}

	report := Report{PerProject: map[string]ProjectReport{}}
	get := func(project string) ProjectReport {
		p, ok := report.PerProject[project]
		if !ok {
			p = ProjectReport{SuppressedByRule: map[string]int{}}
		}
		return p
	}
	for project, rules := range suppressedByRule {
		p := get(project)
		for rule, n := range rules {
			p.SuppressedByRule[rule] += n
		}
		report.PerProject[project] = p
	}
	for project, n := range familyEvents {
		p := get(project)
		p.FamilyEvents = n
		report.PerProject[project] = p
	}
	for k, t := range tallies {
		p := get(k.project)
		removable := t.family + t.suppressed
		switch {
		case removable > 0 && t.ordinary > 0:
			p.MixedGroups = append(p.MixedGroups, k.group)
			p.UnchangedGroups++ // survives: ordinary events keep it alive
		case t.family > 0:
			p.FamilyCollapsed = append(p.FamilyCollapsed, k.group)
		case t.suppressed > 0:
			p.NoiseOnly = append(p.NoiseOnly, k.group)
		default:
			p.UnchangedGroups++
		}
		report.PerProject[k.project] = p
	}
	for project, p := range report.PerProject {
		sort.Strings(p.FamilyCollapsed)
		sort.Strings(p.NoiseOnly)
		sort.Strings(p.MixedGroups)
		report.PerProject[project] = p
	}
	return report
}
```

- [ ] **Step 4: Run to verify PASS**

- [ ] **Step 5: Implement main.go**

```go
// Command shadow-regroup classifies stored events under the slice-1 grouping
// ladder WITHOUT writing anything, and prints the deterministic per-project
// cutover preview. Run from the SAME git revision that is deployed; the
// numbers go in the rollout PR.
//
// Usage: DATABASE_URL=... go run ./shadow-regroup --project <uuid> [--project <uuid>...]
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"sort"

	"github.com/jackc/pgx/v5"
)

type projectList []string

func (p *projectList) String() string     { return fmt.Sprint(*p) }
func (p *projectList) Set(v string) error { *p = append(*p, v); return nil }

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "shadow-regroup: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var projects projectList
	flag.Var(&projects, "project", "project UUID to include (repeatable, required)")
	flag.Parse()
	if len(projects) == 0 {
		return fmt.Errorf("--project <uuid> is required (repeatable); there is deliberately no all-projects mode")
	}
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(ctx)
	// Separate Execs: a multi-statement string can fail under the extended protocol.
	if _, err := conn.Exec(ctx, "SET default_transaction_read_only = on"); err != nil {
		return fmt.Errorf("session setup: %w", err)
	}
	if _, err := conn.Exec(ctx, "SET statement_timeout = '120s'"); err != nil {
		return fmt.Errorf("session setup: %w", err)
	}

	dbRows, err := conn.Query(ctx,
		`SELECT e.project_id::text, e.error_group_id::text, e.platform,
		        e.error_message, e.stack_trace_raw
		 FROM error_events e
		 WHERE e.error_group_id IS NOT NULL AND e.project_id = ANY($1::uuid[])
		 ORDER BY e.project_id, e.error_group_id, e.id`,
		[]string(projects))
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}
	var rows []EventRow
	for dbRows.Next() {
		var r EventRow
		if err := dbRows.Scan(&r.ProjectID, &r.GroupID, &r.Platform, &r.ErrorMessage, &r.StackRaw); err != nil {
			return fmt.Errorf("scan: %w", err)
		}
		rows = append(rows, r)
	}
	if dbRows.Err() != nil {
		return fmt.Errorf("rows: %w", dbRows.Err())
	}

	report := Predict(rows)
	requested := append([]string(nil), projects...)
	sort.Strings(requested)
	for _, project := range requested {
		p, ok := report.PerProject[project]
		fmt.Printf("project %s\n", project)
		if !ok {
			fmt.Println("  zero events — nothing to preview (check the project id)")
			continue
		}
		rules := make([]string, 0, len(p.SuppressedByRule))
		for rule := range p.SuppressedByRule {
			rules = append(rules, rule)
		}
		sort.Strings(rules)
		for _, rule := range rules {
			fmt.Printf("  suppress %-16s %d events\n", rule, p.SuppressedByRule[rule])
		}
		fmt.Printf("  family: %d events; %d old groups collapse into the ONE family group\n", p.FamilyEvents, len(p.FamilyCollapsed))
		for _, g := range p.FamilyCollapsed {
			fmt.Printf("    joins family: %s\n", g)
		}
		fmt.Printf("  noise-only groups that disappear entirely: %d\n", len(p.NoiseOnly))
		for _, g := range p.NoiseOnly {
			fmt.Printf("    disappears: %s\n", g)
		}
		if len(p.MixedGroups) > 0 {
			fmt.Printf("  MIXED groups (cutover will NOT touch; review by hand):\n")
			for _, g := range p.MixedGroups {
				fmt.Printf("    %s\n", g)
			}
		}
		fmt.Printf("  unchanged groups: %d\n", p.UnchangedGroups)
	}
	return nil
}
```

- [ ] **Step 6: Build and commit**

Run: `cd packages/ingestion && go build ./shadow-regroup && go test ./shadow-regroup`

```bash
git add packages/ingestion/shadow-regroup/
git commit -m "feat(ingestion): shadow-regroup deterministic read-only cutover preview"
```

---

### Task 6: Cutover close command

**Files:**
- Create: `packages/ingestion/cutover-close/main.go`
- Test: `packages/ingestion/cutover-close/classify_test.go`

**Interfaces:**
- Consumes: `grouping.Suppress`/`grouping.FamilyFingerprint` per EVENT (with `error_events.platform`). DB via `DATABASE_URL`. Flags: `--project <uuid>` (required), `--apply` (default false), `--audit <path>` (required with `--apply`), `--ids <file>` (pass-2 restriction), `--skipped <path>` (write removable-but-wrong-status ids, sorted, machine-readable).
- Produces: closes eligible groups (`status='resolved'`, `resolved_reason='superseded_by_regrouping'`, `resolved_at=now()`, `updated_at=now()`) in ONE transaction that re-locks, re-checks status, AND reclassifies events under the lock; audit JSONL = metadata header line, one full pre-image row per closed group, and a final committed manifest line; deterministic sorted output.

- [ ] **Step 1: Write the failing test**

```go
package main

import "testing"

func TestGroupRemovable(t *testing.T) {
	family := "Failed to fetch dynamically imported module: https://a.com/c-Ab12.js"
	noise := "Script error."
	ordinary := "Cannot read properties of null (reading 'includes')"

	cases := []struct {
		name   string
		events []eventForClose
		want   bool
	}{
		{"all family", []eventForClose{{Platform: "javascript", Message: family}}, true},
		{"family + stackless noise", []eventForClose{{Platform: "javascript", Message: family}, {Platform: "javascript", Message: noise}}, true},
		{"mixed with ordinary NOT removable", []eventForClose{{Platform: "javascript", Message: family}, {Platform: "javascript", Message: ordinary, Stack: "at f (https://a.com/x.js:1:1)"}}, false},
		{"all ordinary NOT removable", []eventForClose{{Platform: "javascript", Message: ordinary, Stack: "at f (https://a.com/x.js:1:1)"}}, false},
		{"python event NEVER removable even with family-looking message", []eventForClose{{Platform: "python", Message: family}}, false},
		{"one python event poisons an otherwise-removable group", []eventForClose{{Platform: "javascript", Message: family}, {Platform: "python", Message: family}}, false},
		{"no events NOT removable", nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := groupRemovable(c.events); got != c.want {
				t.Fatalf("groupRemovable(%v) = %v, want %v", c.events, got, c.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run to verify FAIL** (`undefined: groupRemovable`)

- [ ] **Step 3: Implement main.go**

```go
// Command cutover-close closes old-scheme groups superseded by the slice-1
// grouping ladder. A group is eligible ONLY when all of:
//   - fingerprint NOT LIKE 'js|v2|%'  (the canonical family group itself must
//     never be closeable — it is the destination, not a leftover)
//   - status is investigated or needs_human, re-checked under lock
//   - EVERY event classifies as family or rung-0 noise, by the EVENT's
//     platform, RE-VERIFIED inside the closing transaction (an event arriving
//     between preview and lock makes the group mixed and skips it)
//
// Dry-run by default. --apply requires --audit. The audit JSONL is:
//   line 1: {"meta": {...run metadata...}}
//   lines:  one full pre-image row per group actually closed
//   last:   {"committed": N} — ABSENT means the transaction did NOT commit;
//           pre-image lines without a manifest are candidates, not changes.
//
// Run from the SAME git revision that is deployed. The audit contains customer
// error data: handle like a DB dump, delete after the verification window.
//
// Usage:
//   DATABASE_URL=... go run ./cutover-close --project <uuid> [--skipped skipped.txt]
//   DATABASE_URL=... go run ./cutover-close --project <uuid> --apply --audit a.jsonl
//   DATABASE_URL=... go run ./cutover-close --project <uuid> --apply --audit b.jsonl --ids skipped.txt
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/opslane/opslane/packages/ingestion/grouping"
)

var closeableStatuses = map[string]bool{"investigated": true, "needs_human": true}

type eventForClose struct {
	Platform string
	Message  string
	Stack    string
}

// groupRemovable reports whether every event of the group classifies as
// family or suppressible noise under the ingest detectors, using each EVENT's
// platform. Empty groups are not removable.
func groupRemovable(events []eventForClose) bool {
	if len(events) == 0 {
		return false
	}
	for _, e := range events {
		if _, drop := grouping.Suppress(e.Platform, e.Message, e.Stack); drop {
			continue
		}
		if _, ok := grouping.FamilyFingerprint(e.Platform, e.Message); ok {
			continue
		}
		return false
	}
	return true
}

func readIDs(path string) (map[string]bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	ids := map[string]bool{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if id := strings.TrimSpace(sc.Text()); id != "" {
			ids[id] = true
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("%s contains no ids — refusing an accidental no-op", path)
	}
	return ids, nil
}

func loadGroupEvents(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, groupID, project string) ([]eventForClose, error) {
	rows, err := q.Query(ctx,
		`SELECT platform, error_message, stack_trace_raw FROM error_events
		 WHERE error_group_id = $1 AND project_id = $2`, groupID, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []eventForClose
	for rows.Next() {
		var e eventForClose
		if err := rows.Scan(&e.Platform, &e.Message, &e.Stack); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "cutover-close: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	project := flag.String("project", "", "project UUID (required)")
	apply := flag.Bool("apply", false, "actually close groups (default: dry run)")
	auditPath := flag.String("audit", "", "JSONL audit file (required with --apply)")
	idsPath := flag.String("ids", "", "restrict to these group IDs (pass-2 mode)")
	skippedPath := flag.String("skipped", "", "write removable-but-wrong-status ids here, sorted")
	flag.Parse()

	if *project == "" {
		return fmt.Errorf("--project is required")
	}
	if *apply && *auditPath == "" {
		return fmt.Errorf("--apply requires --audit")
	}
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	var restrictIDs map[string]bool
	if *idsPath != "" {
		var err error
		if restrictIDs, err = readIDs(*idsPath); err != nil {
			return err
		}
	}

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "SET statement_timeout = '120s'"); err != nil {
		return fmt.Errorf("session setup: %w", err)
	}

	// Phase 1: preview. Old-scheme groups only, deterministic order.
	type groupMeta struct{ id, status, title string; hasPR bool }
	groupRows, err := conn.Query(ctx,
		`SELECT g.id::text, g.status::text, g.title, g.pr_url IS NOT NULL
		 FROM error_groups g
		 WHERE g.project_id = $1 AND g.fingerprint NOT LIKE 'js|v2|%'
		 ORDER BY g.id`, *project)
	if err != nil {
		return fmt.Errorf("groups query: %w", err)
	}
	var groups []groupMeta
	for groupRows.Next() {
		var g groupMeta
		if err := groupRows.Scan(&g.id, &g.status, &g.title, &g.hasPR); err != nil {
			return fmt.Errorf("scan: %w", err)
		}
		if restrictIDs != nil && !restrictIDs[g.id] {
			continue
		}
		groups = append(groups, g)
	}
	if groupRows.Err() != nil {
		return fmt.Errorf("rows: %w", groupRows.Err())
	}

	var toClose, wrongStatus []groupMeta
	for _, g := range groups {
		events, err := loadGroupEvents(ctx, conn, g.id, *project)
		if err != nil {
			return fmt.Errorf("events %s: %w", g.id, err)
		}
		if !groupRemovable(events) {
			continue
		}
		if closeableStatuses[g.status] {
			toClose = append(toClose, g)
		} else {
			wrongStatus = append(wrongStatus, g)
		}
	}
	sort.Slice(wrongStatus, func(i, j int) bool {
		if wrongStatus[i].status != wrongStatus[j].status {
			return wrongStatus[i].status < wrongStatus[j].status
		}
		return wrongStatus[i].id < wrongStatus[j].id
	})

	fmt.Printf("would close %d groups:\n", len(toClose))
	for _, g := range toClose {
		marker := ""
		if g.hasPR {
			marker = "  [HAS PR — eyeball this one]"
		}
		fmt.Printf("  %s  %-12s  %s%s\n", g.id, g.status, g.title, marker)
	}
	fmt.Printf("removable but wrong status (left open; ids -> --skipped file):\n")
	for _, g := range wrongStatus {
		fmt.Printf("  %s  %-12s  %s\n", g.id, g.status, g.title)
	}
	if *skippedPath != "" {
		var b strings.Builder
		for _, g := range wrongStatus {
			b.WriteString(g.id + "\n")
		}
		if err := os.WriteFile(*skippedPath, []byte(b.String()), 0o600); err != nil {
			return fmt.Errorf("write skipped file: %w", err)
		}
		fmt.Printf("wrote %d skipped ids to %s\n", len(wrongStatus), *skippedPath)
	}

	if !*apply {
		fmt.Println("dry run — nothing written. Re-run with --apply --audit <path> to close.")
		return nil
	}
	if len(toClose) == 0 {
		fmt.Println("nothing to close.")
		return nil
	}

	audit, err := os.OpenFile(*auditPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("audit file: %w (refusing to overwrite an existing audit)", err)
	}
	defer audit.Close()
	fmt.Fprintf(audit, `{"meta":{"project":%q,"started_at":%q,"candidates":%d}}`+"\n",
		*project, time.Now().UTC().Format(time.RFC3339), len(toClose))

	// Phase 2: ONE transaction — lock, re-check status, RECLASSIFY events under
	// the lock (an event arriving since phase 1 can make a group mixed), snapshot
	// pre-image, update. Errors return through run(), so the deferred Rollback
	// genuinely executes.
	tx, err := conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)

	closed, raced := 0, 0
	for _, g := range toClose {
		var status, preImage string
		if err := tx.QueryRow(ctx,
			`SELECT status::text, row_to_json(g)::text FROM error_groups g
			 WHERE id = $1 AND project_id = $2 FOR UPDATE`,
			g.id, *project).Scan(&status, &preImage); err != nil {
			return fmt.Errorf("lock %s: %w", g.id, err)
		}
		if !closeableStatuses[status] {
			fmt.Printf("  raced: %s moved to %s since preview — skipped\n", g.id, status)
			raced++
			continue
		}
		events, err := loadGroupEvents(ctx, tx, g.id, *project)
		if err != nil {
			return fmt.Errorf("reclassify %s: %w", g.id, err)
		}
		if !groupRemovable(events) {
			fmt.Printf("  raced: %s gained ordinary events since preview — skipped\n", g.id)
			raced++
			continue
		}
		if _, err := fmt.Fprintln(audit, preImage); err != nil {
			return fmt.Errorf("audit write: %w — nothing committed", err)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE error_groups
			 SET status = 'resolved', resolved_reason = 'superseded_by_regrouping',
			     resolved_at = now(), updated_at = now()
			 WHERE id = $1 AND project_id = $2`, g.id, *project); err != nil {
			return fmt.Errorf("update %s: %w — nothing committed", g.id, err)
		}
		closed++
	}
	if err := audit.Sync(); err != nil {
		return fmt.Errorf("audit sync: %w — nothing committed", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w — audit pre-images are CANDIDATES ONLY (no manifest line)", err)
	}
	// Manifest AFTER successful commit: its absence means "not applied".
	fmt.Fprintf(audit, `{"committed":%d}`+"\n", closed)
	if err := audit.Sync(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: manifest sync failed: %v (transaction IS committed)\n", err)
	}
	fmt.Printf("closed %d groups, %d raced-and-skipped (audit: %s)\n", closed, raced, *auditPath)
	return nil
}
```

- [ ] **Step 4: Run tests, build**

Run: `cd packages/ingestion && go test ./cutover-close -v && go build ./cutover-close`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/cutover-close/
git commit -m "feat(ingestion): transactional cutover-close with in-tx reclassification and audit manifest"
```

---

### Task 7: Full verification + live smoke

**Files:** none — verification per root `AGENTS.md` and `packages/ingestion/AGENTS.md`.

- [ ] **Step 1: Full ingestion gate**

Run: `cd packages/ingestion && go build ./... && go test ./...`

- [ ] **Step 2: DISPOSABLE database + rebuild ingestion AND worker**

The smoke asserts absolute counts, so it needs a clean slate (root AGENTS.md: use a disposable database for clean-state verification; the compose dev DB is disposable):

```bash
docker compose down -v
docker compose config --quiet
docker compose up -d --build postgres minio ingestion worker
docker compose ps   # wait for healthy
```

- [ ] **Step 3: Seed**

```bash
docker compose exec -T postgres psql -U opslane -d opslane < scripts/seed-e2e.sql
```
Note the seeded project UUID and public ingest key (`pk_…`) from `scripts/seed-e2e.sql`; export as `PROJECT` and `KEY`.

- [ ] **Step 4: Smoke the family rule — two deploys, one group**

Use a frozen wire fixture from `test-fixtures/wire/` as the payload template (never edit those files); change only type/message/stack:

```bash
for HASH in Dlu29ZBh Ck2mQ9xw; do
  code=$(curl -sS -o /tmp/resp.json -w '%{http_code}' -X POST http://localhost:8082/api/v1/events \
    -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
    -d '{"platform":"javascript","error":{"type":"TypeError","message":"Failed to fetch dynamically imported module: https://app.example.com/assets/chunk-index.'"$HASH"'.js","stack":""},"timestamp":"2026-08-04T12:00:00Z"}')
  echo "HTTP $code"; cat /tmp/resp.json; echo
done
docker compose exec -T postgres psql -U opslane -d opslane -c \
  "SELECT fingerprint, title, occurrence_count FROM error_groups
   WHERE project_id='$PROJECT' AND fingerprint = 'js|v2|r1|3394fed5608cf6c6b509abd8fbadef76';"
```
Expected: both HTTP 202 with non-empty `event_id`/`group_id` and NO `suppressed` field; exactly ONE group row, `occurrence_count = 2`, title `Stale deploy: hashed asset failed to load after release`.

- [ ] **Step 5: Smoke suppression — 202, honest body, no rows, counter up**

```bash
code=$(curl -sS -o /tmp/supp.json -w '%{http_code}' -X POST http://localhost:8082/api/v1/events \
  -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"platform":"javascript","error":{"type":"Error","message":"ResizeObserver loop limit exceeded","stack":""},"timestamp":"2026-08-04T12:00:00Z"}')
echo "HTTP $code"; cat /tmp/supp.json; echo
docker compose exec -T postgres psql -U opslane -d opslane -tAc \
  "SELECT count(*) FROM error_events WHERE project_id='$PROJECT'"
curl -sS http://localhost:8082/metrics | grep opslane_suppressed_events_total
```
Expected: HTTP 202; body `{"event_id":"","group_id":"","error_group_id":"","suppressed":true}`; event count exactly 2 (the family events only — clean DB makes this absolute); `opslane_suppressed_events_total{rule="resize_observer"} 1`. (If the metrics route differs from `/metrics`, use wherever `opslane_stackless_events_total` is served.)

- [ ] **Step 6: Poll the family job to a terminal state; zero jobs for suppressed**

```bash
for i in $(seq 1 24); do
  STATUS=$(docker compose exec -T postgres psql -U opslane -d opslane -tAc \
    "SELECT j.status FROM error_group_jobs j
     JOIN error_groups g ON g.id = j.error_group_id
     WHERE g.project_id='$PROJECT' AND g.fingerprint LIKE 'js|v2|r1|%'
     ORDER BY j.created_at DESC LIMIT 1")
  echo "job status: $STATUS"
  case "$STATUS" in queued|claimed|pending|analyzing|running|"") sleep 5 ;; *) break ;; esac
done
docker compose exec -T postgres psql -U opslane -d opslane -tAc \
  "SELECT count(*) FROM error_group_jobs j JOIN error_groups g ON g.id = j.error_group_id
   WHERE g.project_id='$PROJECT'"
```
Expected: the loop exits within ~2 minutes on a TERMINAL status (with the worker's shipped triage rubric, the stale-deploy family terminalizes as fixable-with-mitigation, not `unfixable_infra` — the exact status string comes from the worker's terminal set; a status still in the polling set after 24 tries is a FAILURE). Total job count for the project is exactly 1 — the family group's; the suppressed event produced none (absolute count valid on the clean DB).

- [ ] **Step 7: Smoke the shadow + cutover tools against the compose DB**

```bash
cd packages/ingestion
DATABASE_URL=postgres://opslane:opslane@localhost:5432/opslane go run ./shadow-regroup --project "$PROJECT"
DATABASE_URL=postgres://opslane:opslane@localhost:5432/opslane go run ./cutover-close --project "$PROJECT" --skipped /tmp/skipped.txt
```
Expected: shadow-regroup prints the project with 2 family events and deterministic ordering; cutover-close dry-run prints `would close 0 groups` — the ONE existing family group is new-scheme (`js|v2|…`) and therefore EXCLUDED by the fingerprint filter (this directly exercises the canonical-group protection), and exits 0 without writing.

- [ ] **Step 8: Final gate**

```bash
cd packages/ingestion && go build ./... && go test ./...
git status --short   # clean, or only intended changes
```

---

## Cutover runbook (operator steps — run after this plan ships to prod)

0. Run every command from a checkout of the EXACT deployed git revision (`git checkout <deployed-sha>`).
1. `DATABASE_URL=<prod> go run ./shadow-regroup --project <partner-uuid>` — paste the report into the rollout PR. Predictions to beat (2026-08-03 prod evidence): ~86 family groups join the family; Script error./ResizeObserver-only groups disappear; MIXED list gets a human decision per group (cutover won't touch them regardless).
2. Release-tagging precondition (locked plan): run the scoped query in `docs/decisions/grouping-ladder.md`. If `missing/total` is not near 0, fix the partner's SDK `release` config BEFORE cutover.
3. Deploy the ladder.
4. `go run ./cutover-close --project <partner-uuid> --skipped skipped.txt` (dry run) → review, especially `[HAS PR]` rows → `--apply --audit cutover-$(date +%F).jsonl`.
5. Once skipped ids' jobs settle: dry-run with `--ids skipped.txt`; close the now-eligible with `--apply --audit cutover-pass2-$(date +%F).jsonl --ids skipped.txt`. Ids that terminalized as `pr_created`/`resolved`/`merged` keep their real provenance — designed outcome, not a leak.
6. Rollback restores from audit pre-images (full rows; a missing `{"committed":N}` manifest line means the pre-images were candidates and nothing was applied). The audit contains customer error data — store like a DB dump, delete after the verification window.
7. Watch for one week: exactly ONE family group per project receiving events; `opslane_suppressed_events_total` climbing; no new per-deploy family groups.

---

## Self-Review (completed, revision 2)

- **Round-2 P0s:** finding 1 — `TestPredict` expectations corrected (g5 mixed, not collapsed; unchanged=4 with the added python row); finding 2 — `fingerprint NOT LIKE 'js|v2|%'` in the candidate query, exercised by smoke step 7; finding 3 — in-transaction reclassification after `FOR UPDATE`.
- **Round-2 P1/P2s:** event-level platform everywhere (4; `error_events.platform` verified NOT NULL via migration 016); `$1::uuid[]` cast (5); `--all-projects` removed (6); family/noise-only split in report (7); suppression placement made an explicit contract (8); honest empty-id + `suppressed:true` response (9); `run() error` structure in both commands (10); audit metadata + committed manifest (11); deterministic ordering + `--skipped` file (12); disposable-DB smoke (13); polling loop with failure condition (14); absolute job-count assertion on clean DB (15); separate `SET` execs (16); zero-event projects enumerated (17); first-non-blank header handling with corrected comment and test (18).
- **Placeholder scan:** clean. **Type consistency:** `eventForClose{Platform,Message,Stack}` consistent between test and implementation; `FamilyCollapsed`/`NoiseOnly`/`MixedGroups` consistent between `Predict`, its test, and main.go printing; family constant identical in Tasks 3/4/7.
