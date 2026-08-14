# Debug-ID Frame Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop one JavaScript bug from creating a new error group (and a new Slack alert) on every page load, by keying stack frames on the SDK-supplied `debug_id` instead of the volatile bundle URL.

**Architecture:** The SDK already sends `debug_meta.images[] = {code_file, debug_id}` on every event, and ingestion already validates it (`sanitizeDebugMeta`) *before* it fingerprints. `debug_id` is a content hash of the source map — stable across page loads, unlike the URL. We substitute each frame's `code_file` occurrence with its `debug_id` before the existing volatile-normalization runs. Ingestion-only; no source-map fetch, no worker involvement, no migration, no regrouping of existing rows.

**Tech Stack:** Go 1.24 (`packages/ingestion`), standard library only. No new dependencies.

**Spec:** This plan. Diagnosis evidence is inline in Task 1's rationale; the originating issue is #247 ("Regroup errors after source-map symbolication"), which this plan **supersedes for the per-page-load case** — see "Scope boundary".

## Global Constraints

- Go 1.24; `go build ./...` and `go test ./...` from `packages/ingestion` must pass.
- Package layout is fixed: grouping logic in `grouping/`, handler wiring in `handler/`. Do not move code between them.
- No new dependencies (root `AGENTS.md`: reuse existing utilities first).
- No database migration. No write to any existing row.
- The `POST /api/v1/events` wire contract is append-only — this plan adds **no** wire fields and reads only `debug_meta`, already part of the contract.
- Substitution applies to **JavaScript only**. Python stacks use `pythonFrames` and have no bundle URLs; running substitution on them is out of scope and must be blocked, not merely unlikely.
- Every new metric counter must be registered in the ingestion metrics registry alongside the existing `RecordSuppressed`/`RecordDebugMetaDiscard` counters.
- Behavior change is gated by `GROUPING_DEBUG_ID_FRAMES`, **default off**, read **once at process start** (not per event — this is the ingest hot path).

## Scope boundary — read before implementing

This plan fixes exactly one mechanism: a bundle URL that varies per page load while `debug_meta` stays constant. That is the verified prod case. It relies on the frame line containing the **literal** `code_file` string, which is what the SDK emits today.

**Known cases it does not fix, by design.** Each is pinned by a test in Task 1 Step 1 that asserts the *current* fallback behavior, so a future change that silently alters them fails:

| Case | Behavior |
| --- | --- |
| Frame URL is relative, `webpack://`, or `blob:` | No match; legacy fingerprint. |
| `code_file` points at the `.js.map`, frame at the `.js` | No match; legacy fingerprint. |
| Frame URL is percent-encoded differently from `code_file` | No match; legacy fingerprint. |
| Frame URL carries a per-request **query string** with no `:` in it | `code_file` is cut at `?` before matching, so the prefix matches; the residual query is then removed from the substituted token. Covered — see `cutQuery` and `reDebugQuery`. |
| Frame URL query string **contains a colon** (e.g. `?next=https://x`) | Partially handled. `reDebugQuery` stops at the first `:`, so `://x` survives into the fingerprint and that URL still splinters. Rare in practice, not fixed here. Do not claim arbitrary query support. |
| Per-deploy splintering | **Not fixed.** `debug_id` is a hash of the source map and changes every deploy. Different mechanism, tracked as W7.1 / #77. |
| The 15 groups already in prod | **Not merged.** No backfill; they age out. |

**Rollout is not a single clean re-key.** Enabling the flag re-keys events, and the honest failure modes are:

- **Mixed-metadata split (permanent while it lasts).** If some events for one bug carry matching `debug_meta` and others do not — an older SDK on a cached page, a frame the images don't cover — the two populations land in *different* groups and stay split. This resolves only when the non-carrying population stops.
- **Rolling-deploy split (transient).** During an ingestion rollout, flag-on and flag-off instances key the same event differently. Deploy to all ingestion tasks before flipping the flag, not during.
- **One-time re-key burst.** Every currently-open JS group carrying `debug_meta` alerts once more under its new key.

Only the third is one-time. Do not describe this rollout as "a one-time burst" in the change log.

---

### Task 1: `SourceImage` type and debug-ID frame substitution in `grouping`

> **Amended after code review.** The first draft of this task used
> `strings.ReplaceAll` for the substitution. That is unsafe: `code_file` is
> client-supplied (`validCodeFile` accepts any 1 to 4096 printable bytes, and
> the handler retains up to 64 images), and the token it inserts is made of
> letters a later image matches again. Six single-character `code_file` values
> grew an 839-byte stack to 471 KB, on the ingest hot path, reachable with the
> browser-embedded public key. The shipped version matches only where the
> `code_file` stands alone as a frame's file reference (`replaceFrameToken`),
> and bounds the result. It also drops images that collide after query-stripping
> with different debug IDs, because the handler's ambiguity guard keys on the
> full `code_file` and lets that pair through.

**Rationale (read before implementing):** Verified in prod on 2026-08-13. Three separate `error_groups` for the same error carry these frames:

```
at Object.h [as changeWindowTitle] (https://59n3u0-20bxmx2og5-2q8nlicgda--dchjri-….net/…/global-page/_ctx_H4sIAAAAAAACA8VVy27bMBD8Fx4NiwF8Keqb…)
at Object.h [as changeWindowTitle] (https://abcrz-1lafkb263s-gn3d6f7yf--dchjri-….net/…/global-page/_ctx_H4sIAAAAAAACA8VVXW-bMBT9L36MwJX6mDdG…)
```

`normalizeVolatile`'s `reURL` (`https?://[^/\s]+`) already strips scheme+host, so the rotating subdomain is handled. What survives is the **path**, ending in `_ctx_<gzipped-base64>` — different on every page load. All three events carry the identical `debug_meta`:

```json
{"images": [{"type": "sourcemap", "debug_id": "afa8111b-3697-ce9d-b9e5-4e52afdb3b57", "code_file": "https://59n3u0-…/global-page/_ctx_H4sIAAAA…"}]}
```

Substitution must run **before** `normalizeVolatile`, because `normalizeVolatile` deletes the scheme+host that `code_file` includes — afterwards there is nothing left to match.

**Files:**
- Modify: `packages/ingestion/grouping/fingerprint.go`
- Test: `packages/ingestion/grouping/fingerprint_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type SourceImage struct { CodeFile string; DebugID string }`
  - `func applyDebugIDs(stackTrace string, images []SourceImage) (string, bool)` — unexported; the `bool` reports whether a substitution actually fired.
  - `func FingerprintWithImages(platform, errorType, errorMessage, stackTrace string, images []SourceImage) (string, bool)` — returns the fingerprint and whether debug IDs were applied. **It calls `Fingerprint` internally**; `Fingerprint`'s own signature and behavior are unchanged, so every existing caller and test is untouched.

- [ ] **Step 1: Write the failing test**

Add to `packages/ingestion/grouping/fingerprint_test.go`:

```go
func TestFingerprintWithImages_CollapsesPerLoadBundleURLs(t *testing.T) {
	const debugID = "afa8111b-3697-ce9d-b9e5-4e52afdb3b57"
	urlA := "https://59n3u0-20bxmx2og5-2q8nlicgda--dchjri.cdn.prod.atlassian-dev.net/a/b/c/global-page/_ctx_H4sIAAAAAAACA8VVy27bMBD8Fx4NiwF8Keqb"
	urlB := "https://abcrz-1lafkb263s-gn3d6f7yf--dchjri.cdn.prod.atlassian-dev.net/a/b/c/global-page/_ctx_H4sIAAAAAAACA8VVXW-bMBT9L36MwJX6mDdG"

	stackA := "Error: the window title wasn't changed due to error.\n    at Object.h [as changeWindowTitle] (" + urlA + ":1:2345)"
	stackB := "Error: the window title wasn't changed due to error.\n    at Object.h [as changeWindowTitle] (" + urlB + ":1:2345)"

	fpA, okA := FingerprintWithImages("javascript", "e", "the window title wasn't changed due to error.", stackA,
		[]SourceImage{{CodeFile: urlA, DebugID: debugID}})
	fpB, okB := FingerprintWithImages("javascript", "e", "the window title wasn't changed due to error.", stackB,
		[]SourceImage{{CodeFile: urlB, DebugID: debugID}})

	if !okA || !okB {
		t.Fatalf("substitution must report that it fired: okA=%v okB=%v", okA, okB)
	}
	if fpA != fpB {
		t.Errorf("same bug across two page loads must share a fingerprint: %s != %s", fpA, fpB)
	}
}

// Distinct bugs must stay distinct even when EVERYTHING else is identical --
// same bundle, same debug ID, same message shape. Only the frame position and
// function differ. A weaker test (different messages AND different frames)
// would pass even if substitution flattened frames entirely.
func TestFingerprintWithImages_SameBundleDistinctFramesDiffer(t *testing.T) {
	const debugID = "afa8111b-3697-ce9d-b9e5-4e52afdb3b57"
	url := "https://cdn.example.net/a/b/_ctx_XYZ"
	images := []SourceImage{{CodeFile: url, DebugID: debugID}}

	fp1, _ := FingerprintWithImages("javascript", "e", "boom", "e: boom\n    at Object.h ("+url+":1:10)", images)
	fp2, _ := FingerprintWithImages("javascript", "e", "boom", "e: boom\n    at Object.q ("+url+":9:99)", images)

	if fp1 == fp2 {
		t.Error("two different frames in one bundle must not collapse onto one fingerprint")
	}
}

func TestFingerprintWithImages_NoImagesMatchesLegacyFingerprint(t *testing.T) {
	stack := "TypeError: boom\n    at foo (https://cdn.example.net/app.js:1:2)"
	legacy := Fingerprint("javascript", "TypeError", "boom", stack)

	for name, images := range map[string][]SourceImage{"nil": nil, "empty": {}} {
		got, ok := FingerprintWithImages("javascript", "TypeError", "boom", stack, images)
		if got != legacy {
			t.Errorf("%s images must reproduce the legacy fingerprint: %s != %s", name, got, legacy)
		}
		if ok {
			t.Errorf("%s images must report that no substitution fired", name)
		}
	}
}

// A per-request query string must not survive substitution and re-fragment the
// group. code_file is cut at '?' before matching; the residual query on the
// substituted token is then removed.
func TestApplyDebugIDs_StripsPerRequestQueryStrings(t *testing.T) {
	images := []SourceImage{{CodeFile: "https://cdn.example.net/app.js?build=1", DebugID: "abcd"}}
	got1, ok1 := applyDebugIDs("Error: x\n    at f (https://cdn.example.net/app.js?session=111:1:2)", images)
	got2, ok2 := applyDebugIDs("Error: x\n    at f (https://cdn.example.net/app.js?session=222:1:2)", images)

	if !ok1 || !ok2 {
		t.Fatalf("substitution must fire on both: %v %v", ok1, ok2)
	}
	if got1 != got2 {
		t.Errorf("per-request query strings must not survive: %q != %q", got1, got2)
	}
	if !strings.Contains(got1, ":1:2") {
		t.Errorf("line:col must survive query stripping, got %q", got1)
	}
}

func TestApplyDebugIDs_LongestCodeFileWins(t *testing.T) {
	images := []SourceImage{
		{CodeFile: "https://cdn.example.net/a", DebugID: "1111"},
		{CodeFile: "https://cdn.example.net/a/b/vendor.js", DebugID: "2222"},
	}
	got, ok := applyDebugIDs("Error: x\n    at f (https://cdn.example.net/a/b/vendor.js:1:2)", images)

	if !ok {
		t.Fatal("substitution must fire")
	}
	if !strings.Contains(got, "<debug:2222>") {
		t.Errorf("longest matching code_file must win, got %q", got)
	}
	if strings.Contains(got, "<debug:1111>") {
		t.Errorf("shorter prefix must not also substitute, got %q", got)
	}
}

func TestApplyDebugIDs_SkipsUnusableImages(t *testing.T) {
	stack := "Error: x\n    at f (https://cdn.example.net/app.js:1:2)"
	images := []SourceImage{
		{CodeFile: "", DebugID: "1111"},
		{CodeFile: "https://cdn.example.net/app.js", DebugID: ""},
		// A newline in code_file would let one image rewrite across frame
		// boundaries and change which lines topFrames selects.
		{CodeFile: "https://cdn.example.net/\napp.js", DebugID: "3333"},
	}
	got, ok := applyDebugIDs(stack, images)
	if ok || got != stack {
		t.Errorf("unusable images must be ignored, got %q (ok=%v)", got, ok)
	}
}

// Documents the out-of-scope cases from the plan's scope boundary. The
// mechanism under test is literal containment, NOT scheme awareness: each case
// is a code_file that does not appear verbatim in the frame. If a code_file
// ever DID equal a relative or webpack:// frame string, substitution would fire
// and that is fine -- the identity would still be stable.
func TestApplyDebugIDs_CodeFileAbsentFromFrame(t *testing.T) {
	cases := map[string]struct{ stack, codeFile string }{
		"frame relative, code_file absolute": {"Error: x\n    at f (/static/app.js:1:2)", "https://cdn.example.net/static/app.js"},
		"frame webpack, code_file http":      {"Error: x\n    at f (webpack:///src/app.ts:1:2)", "https://cdn.example.net/app.js"},
		"frame blob, code_file http":         {"Error: x\n    at f (blob:https://cdn.example.net/abc-123:1:2)", "https://cdn.example.net/app.js"},
		"code_file is the map, frame the js": {"Error: x\n    at f (https://cdn.example.net/app.js:1:2)", "https://cdn.example.net/app.js.map"},
		"percent-encoding differs":           {"Error: x\n    at f (https://cdn.example.net/a%20b.js:1:2)", "https://cdn.example.net/a b.js"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got, ok := applyDebugIDs(tc.stack, []SourceImage{{CodeFile: tc.codeFile, DebugID: "9999"}})
			if ok || got != tc.stack {
				t.Errorf("out-of-scope case must fall back unchanged, got %q (ok=%v)", got, ok)
			}
		})
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ingestion && go test ./grouping/ -run 'FingerprintWithImages|ApplyDebugIDs' -v`
Expected: FAIL — `undefined: FingerprintWithImages`, `undefined: SourceImage`, `undefined: applyDebugIDs`.

- [ ] **Step 3: Write the implementation**

In `packages/ingestion/grouping/fingerprint.go`, add `sort` to the imports, add to the `var` block:

```go
	// reDebugQuery strips a query string left dangling on a substituted token.
	// The token delimits the match, so this cannot eat the trailing :line:col.
	reDebugQuery = regexp.MustCompile(`(<debug:[^>]*>)\?[^\s:)]*`)
```

and append:

```go
// SourceImage is one validated debug_meta image: the bundle URL the SDK saw
// and the content-derived debug ID for its source map.
type SourceImage struct {
	CodeFile string
	DebugID  string
}

// cutQuery drops a URL query string. A per-request query on code_file would
// otherwise make the literal match fail for every other request.
func cutQuery(s string) string {
	if i := strings.IndexByte(s, '?'); i >= 0 {
		return s[:i]
	}
	return s
}

// applyDebugIDs rewrites every occurrence of a known bundle URL in the stack to
// its debug ID, and reports whether any substitution actually fired.
//
// It must run BEFORE normalizeVolatile: normalizeVolatile strips scheme+host,
// which is part of code_file, so afterwards there is nothing left to match.
//
// Longest code_file first, so a short URL that prefixes a longer one cannot
// shadow it. Images carrying a newline are rejected: a multi-line replacement
// would rewrite across frame boundaries and change which lines topFrames picks.
func applyDebugIDs(stackTrace string, images []SourceImage) (string, bool) {
	if stackTrace == "" || len(images) == 0 {
		return stackTrace, false
	}
	usable := make([]SourceImage, 0, len(images))
	for _, image := range images {
		codeFile := cutQuery(image.CodeFile)
		if codeFile == "" || image.DebugID == "" ||
			strings.ContainsAny(codeFile, "\n\r") || strings.ContainsAny(image.DebugID, "\n\r>") {
			continue
		}
		usable = append(usable, SourceImage{CodeFile: codeFile, DebugID: image.DebugID})
	}
	if len(usable) == 0 {
		return stackTrace, false
	}
	sort.SliceStable(usable, func(i, j int) bool {
		return len(usable[i].CodeFile) > len(usable[j].CodeFile)
	})

	substituted := stackTrace
	for _, image := range usable {
		substituted = replaceFrameToken(substituted, image.CodeFile, "<debug:"+image.DebugID+">")
	}
	if substituted == stackTrace {
		return stackTrace, false
	}
	if len(substituted) > 2*len(stackTrace)+4096 {
		return stackTrace, false
	}
	return reDebugQuery.ReplaceAllString(substituted, "$1"), true
}

// FingerprintWithImages is Fingerprint with the SDK's debug_meta images applied
// to the stack first, giving frames an identity that survives bundle URLs that
// vary per page load. It returns the fingerprint and whether debug IDs were
// actually applied — callers use the flag for metrics, not for control flow.
//
// When nothing matches it returns exactly what Fingerprint would have returned.
func FingerprintWithImages(platform, errorType, errorMessage, stackTrace string, images []SourceImage) (string, bool) {
	substituted, applied := applyDebugIDs(stackTrace, images)
	return Fingerprint(platform, errorType, errorMessage, substituted), applied
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/ingestion && go test ./grouping/ -v`
Expected: PASS, including every pre-existing test in the package. `Fingerprint`'s signature is unchanged, so none should need editing — if one does, stop and re-read Step 3.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/grouping/fingerprint.go packages/ingestion/grouping/fingerprint_test.go
git commit -m "feat(grouping): key stack frames on debug IDs instead of per-load bundle URLs"
```

---

### Task 2: Return validated images from `sanitizeDebugMeta`

**Rationale:** `sanitizeDebugMeta` parses and validates every image into a local slice, then returns only the re-serialized JSON, a count, and a flag. Task 3 needs those images.

**Before writing code, read `sanitizeDebugMeta` in full** (`packages/ingestion/handler/error_event.go`, from its `func` line to its closing brace). It has several early returns and a validation loop with `continue` branches. `Images` must be populated from the **same final accepted slice that produces `result.JSON`**, after all filtering and de-duplication — never from the raw entries. If grouping saw an image that storage discarded, the fingerprint would depend on data no one can audit from the stored row.

**Files:**
- Modify: `packages/ingestion/handler/error_event.go` (the `debugMetaValidation` struct at :293 and `sanitizeDebugMeta` at :311)
- Test: `packages/ingestion/handler/error_event_test.go`

**Interfaces:**
- Consumes: `grouping.SourceImage` from Task 1.
- Produces: `debugMetaValidation` gains `Images []grouping.SourceImage`. `JSON`, `ImageCount`, and `RegistryPresentZeroMatched` keep their exact current meaning and value.

- [ ] **Step 1: Write the failing test**

```go
func TestSanitizeDebugMeta_ExposesValidatedImages(t *testing.T) {
	raw := json.RawMessage(`{"images":[
		{"type":"sourcemap","code_file":"https://cdn.example.net/app.js","debug_id":"afa8111b-3697-ce9d-b9e5-4e52afdb3b57"}
	]}`)

	got := sanitizeDebugMeta(raw)

	if len(got.Images) != 1 {
		t.Fatalf("want 1 validated image, got %d", len(got.Images))
	}
	if got.Images[0].CodeFile != "https://cdn.example.net/app.js" {
		t.Errorf("code_file not carried through: %q", got.Images[0].CodeFile)
	}
	if got.Images[0].DebugID != "afa8111b-3697-ce9d-b9e5-4e52afdb3b57" {
		t.Errorf("debug_id not carried through: %q", got.Images[0].DebugID)
	}
	if got.ImageCount != 1 {
		t.Errorf("ImageCount must keep its existing meaning, got %d", got.ImageCount)
	}
}

// Images must agree with the JSON that gets stored. If validation discarded an
// entry, grouping must not have seen it either.
func TestSanitizeDebugMeta_ImagesAgreeWithStoredJSON(t *testing.T) {
	raw := json.RawMessage(`{"images":[
		{"type":"sourcemap","code_file":"https://cdn.example.net/good.js","debug_id":"afa8111b-3697-ce9d-b9e5-4e52afdb3b57"},
		{"type":"not-a-sourcemap","code_file":"https://cdn.example.net/bad.js","debug_id":"bbbbbbbb-3697-ce9d-b9e5-4e52afdb3b57"},
		"not-an-object"
	]}`)

	got := sanitizeDebugMeta(raw)

	if len(got.Images) != got.ImageCount {
		t.Errorf("Images (%d) must match ImageCount (%d)", len(got.Images), got.ImageCount)
	}
	for _, image := range got.Images {
		if !strings.Contains(got.JSON, image.DebugID) {
			t.Errorf("image %q was exposed to grouping but is absent from the stored JSON", image.DebugID)
		}
	}
}

func TestSanitizeDebugMeta_NoImagesYieldsNoSourceImages(t *testing.T) {
	for name, raw := range map[string]json.RawMessage{
		"absent":    nil,
		"empty":     json.RawMessage(`{"images":[]}`),
		"malformed": json.RawMessage(`not json`),
	} {
		if got := sanitizeDebugMeta(raw); len(got.Images) != 0 {
			t.Errorf("%s debug_meta must yield no images, got %d", name, len(got.Images))
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/ingestion && go test ./handler/ -run TestSanitizeDebugMeta -v`
Expected: FAIL — `got.Images undefined (type debugMetaValidation has no field or method Images)`.

- [ ] **Step 3: Write the implementation**

Add the field:

```go
type debugMetaValidation struct {
	JSON                       string
	ImageCount                 int
	RegistryPresentZeroMatched bool
	// Images are the validated (code_file, debug_id) pairs that also appear in
	// JSON, used by grouping to give frames an identity that outlives a
	// per-page-load bundle URL.
	Images []grouping.SourceImage
}
```

In `sanitizeDebugMeta`, on the **same success path that sets `result.JSON` and `result.ImageCount`** from the final accepted slice, populate `Images` from that same slice:

```go
	result.Images = make([]grouping.SourceImage, 0, len(valid))
	for _, image := range valid {
		result.Images = append(result.Images, grouping.SourceImage{
			CodeFile: image.CodeFile,
			DebugID:  image.DebugID,
		})
	}
```

Substitute `valid` for whatever the function's final accepted slice is actually named. Do not add this to any early `return result` above the validation loop — those correctly yield a nil `Images`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/ingestion && go test ./handler/ -v`
Expected: PASS, including the pre-existing debug-meta discard/counter tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/error_event.go packages/ingestion/handler/error_event_test.go
git commit -m "refactor(ingestion): surface validated debug_meta images from sanitizeDebugMeta"
```

---

### Task 3: Wire images into `groupingDecision` behind a start-up flag

**Rationale:** `sanitizeDebugMeta` is already called at `error_event.go:136`, above `groupingDecision` at :200, so no reordering is needed. The flag is read once at process start: this is the ingest hot path, and a per-event `os.Getenv` also lets one process change behavior mid-flight, which would splinter groups for no reason.

**Files:**
- Modify: `packages/ingestion/handler/error_event.go` (`groupingDecision` at :39-49; call site at :200-202)
- Modify: `packages/ingestion/handler/metrics.go` (new counter)
- Test: `packages/ingestion/handler/error_event_test.go`

**Interfaces:**
- Consumes: `grouping.FingerprintWithImages` (Task 1), `debugMetaValidation.Images` (Task 2).
- Produces:
  - `var debugIDFramesEnabled = os.Getenv("GROUPING_DEBUG_ID_FRAMES") == "true"` — package-level in `handler`, evaluated once at init. Tests override it directly and restore with `t.Cleanup`.
  - `func groupingDecision(platform, errorType, errorMessage, stackTrace string, images []grouping.SourceImage) (suppressRule, fingerprint, title string)`
  - `func RecordDebugIDGrouping()` in `handler/metrics.go`, incrementing `opslane_ingest_debug_id_grouping_total`.

- [ ] **Step 1: Write the failing test**

```go
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ingestion && go test ./handler/ -run TestGroupingDecision -v`
Expected: FAIL — `undefined: debugIDFramesEnabled`, `too many arguments in call to groupingDecision`.

- [ ] **Step 3: Write the implementation**

```go
// debugIDFramesEnabled keys stack frames on debug_meta debug IDs instead of
// bundle URLs, so a bundle URL that varies per page load no longer fragments
// one bug across many groups.
//
// Read once at start-up: this is the ingest hot path, and a value that could
// change mid-process would splinter groups for no reason. Default off — the
// switch re-keys every JS group carrying debug_meta, and each re-keyed group
// alerts once as new.
var debugIDFramesEnabled = os.Getenv("GROUPING_DEBUG_ID_FRAMES") == "true"

func groupingDecision(platform, errorType, errorMessage, stackTrace string, images []grouping.SourceImage) (suppressRule, fingerprint, title string) {
	if rule, drop := grouping.Suppress(platform, errorMessage, stackTrace); drop {
		return rule, "", ""
	}

	title = truncateTitle(errorType+": "+errorMessage, 200)
	if familyFingerprint, ok := grouping.FamilyFingerprint(platform, errorMessage); ok {
		return "", familyFingerprint, grouping.FamilyTitleStaleDeploy
	}

	if debugIDFramesEnabled && platform == "javascript" && len(images) > 0 {
		fp, applied := grouping.FingerprintWithImages(platform, errorType, errorMessage, stackTrace, images)
		if applied {
			RecordDebugIDGrouping()
		}
		return "", fp, title
	}
	return "", grouping.Fingerprint(platform, errorType, errorMessage, stackTrace), title
}
```

Add `"os"` to the imports if absent. Update the call site at :200:

```go
	suppressRule, fingerprint, title := groupingDecision(
		payload.Platform, payload.Error.Type, payload.Error.Message, payload.Error.Stack,
		debugMeta.Images,
	)
```

In `packages/ingestion/handler/metrics.go`, following the neighboring counters' declaration and registration pattern:

```go
// RecordDebugIDGrouping counts events whose frames were ACTUALLY rewritten onto
// debug IDs. It is incremented only when a substitution fired, not merely when
// images were present — during rollout the gap between "flag is on" and this
// counter is exactly the population still grouping by URL.
func RecordDebugIDGrouping() {
	debugIDGroupingTotal.Inc()
}
```

Declare and register `debugIDGroupingTotal` as `opslane_ingest_debug_id_grouping_total`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/ingestion && go build ./... && go test ./...`
Expected: PASS across the module.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/error_event.go packages/ingestion/handler/metrics.go packages/ingestion/handler/error_event_test.go
git commit -m "feat(ingestion): group on debug IDs behind GROUPING_DEBUG_ID_FRAMES"
```

---

### Task 4: End-to-end proof through the real ingest path, plus docs

**Rationale:** Tasks 1-3 prove the functions. This proves the user-visible claim: two events differing only in their per-load bundle URL land in **one** `error_groups` row and produce **exactly one** `issue.created` outbox row.

**Before writing the test, read the existing handler tests** to find the real fixtures. Verified signatures (do not guess, and do not invent an `env` wrapper object — none exists):

- `seedNotificationProject(t *testing.T, q *db.Queries, name string) (orgID, projectID, environmentID string)` — creates org, project, environment. **It creates no destination.**
- `destinationFixture(projectID, name string) db.NotificationDestination` — a `slack` destination subscribed to `issue.created`, `Enabled: true`. Insert it yourself.
- Also available: `newTestRouter`, `seedTenant`, `seedGroup`, `applyMigration`, `applyMigrationList`.

If a helper you need does not exist, add it in this task and say so in the commit message.

**Files:**
- Test: the existing ingest handler test file (follow its established pattern)
- Modify: `docs/contracts/events.md`
- Modify: `packages/ingestion/AGENTS.md`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: no new exported symbols.

- [ ] **Step 1: Write the failing test**

```go
func TestIngestEvent_DebugIDCollapsesTwoPageLoadsIntoOneGroup(t *testing.T) {
	setDebugIDFrames(t, true)
	// A destination MUST exist and be subscribed, or publishIssueCreated writes
	// no outbound_events row at all and the alert assertion below would pass
	// vacuously. seedNotificationProject does NOT create one -- insert
	// destinationFixture yourself.
	_, projectID, environmentID := seedNotificationProject(t, queries, "debugid")
	insertDestination(t, queries, destinationFixture(projectID, "slack"))

	const debugID = "afa8111b-3697-ce9d-b9e5-4e52afdb3b57"
	post := func(bundleURL string) string {
		body := fmt.Sprintf(`{
			"timestamp": "2026-08-13T21:07:19Z",
			"platform": "javascript",
			"error": {"type": "e", "message": "the window title wasn't changed due to error.",
			          "stack": "e: the window title wasn't changed due to error.\n    at Object.h (%s:1:2345)"},
			"debug_meta": {"images": [{"type": "sourcemap", "code_file": "%s", "debug_id": "%s"}]}
		}`, bundleURL, bundleURL, debugID)
		return ingestReturningGroupID(t, projectID, environmentID, body)
	}

	groupA := post("https://59n3u0-x.cdn.prod.atlassian-dev.net/a/global-page/_ctx_AAAA")
	groupB := post("https://abcrz-y.cdn.prod.atlassian-dev.net/a/global-page/_ctx_BBBB")

	if groupA != groupB {
		t.Fatalf("two page loads of one bug must share a group: %s != %s", groupA, groupB)
	}

	var alerts int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM outbound_events WHERE event_type = 'issue.created' AND payload->'issue'->>'id' = $1`,
		groupA).Scan(&alerts); err != nil {
		t.Fatalf("count alerts: %v", err)
	}
	// Exactly one. Zero would mean the destination was never wired up and the
	// test proves nothing; two would mean the splinter is still happening.
	if alerts != 1 {
		t.Errorf("one bug must alert exactly once, got %d issue.created rows", alerts)
	}
}
```

`ingestReturningGroupID` and `insertDestination` are new helpers this task adds; keep them in the test file and mention them in the commit message.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/ingestion && go test ./handler/ -run TestIngestEvent_DebugID -v`
Expected: two distinct group IDs. If Tasks 1-3 are already committed the test may pass immediately — in that case flip `setDebugIDFrames(t, false)` and confirm it genuinely fails before trusting it.

- [ ] **Step 3: Make it pass and document the change**

No production code change should be required.

In `docs/contracts/events.md`, under `debug_meta`:

```markdown
`debug_meta.images[].debug_id` participates in error grouping. When
`GROUPING_DEBUG_ID_FRAMES` is enabled, a JavaScript frame's bundle URL is
replaced by its debug ID before fingerprinting, so a bundle URL that varies per
page load (for example a Forge iframe's `_ctx_` segment) no longer splits one
bug across many issues. It matches on the literal `code_file` string with the
query stripped; relative, `webpack://`, `blob:`, and `.js.map`-vs-`.js` frames
do not match and group exactly as before. Events without `debug_meta`, and all
non-JavaScript platforms, are grouped exactly as before.
```

In `packages/ingestion/AGENTS.md`, under a "Grouping" heading:

```markdown
- `GROUPING_DEBUG_ID_FRAMES` (default `false`, read once at start-up) keys
  JavaScript stack frames on `debug_meta` debug IDs instead of bundle URLs.
  Roll it out to every ingestion task BEFORE flipping it: flag-on and flag-off
  instances key the same event differently. Enabling it re-keys every JS group
  carrying `debug_meta` and each re-keyed group alerts once as new. A bug whose
  events do not all carry matching `debug_meta` will split permanently between
  the two keys. It does not address per-deploy splintering — debug IDs change
  per deploy (see #77).
```

- [ ] **Step 4: Run the full gate and count skips**

`go test` prints `ok` for a package whose tests all skipped, so the pass line proves nothing. Count skips explicitly:

```bash
cd packages/ingestion && go build ./... || exit 1
go test -count=1 -json ./... > /tmp/ingestion-test.json; test_status=$?
skips=$(grep -c '"Action":"skip"' /tmp/ingestion-test.json)
fails=$(grep -c '"Action":"fail"' /tmp/ingestion-test.json)
echo "exit=$test_status skips=$skips fails=$fails"
```

Expected: `exit=0 skips=0 fails=0`. Capture to a file rather than piping into `grep -c`: `grep` exits non-zero on zero matches, so a naive pipeline reports failure on the *good* result and hides `go test`'s real exit status. Any non-zero skip count means a suite did not run — export the `DATABASE_URL`/MinIO block from the root `AGENTS.md` and re-run before believing the result.

Then confirm the flag-off default is inert:

```bash
cd packages/ingestion && GROUPING_DEBUG_ID_FRAMES=false go test -count=1 ./... && env -u GROUPING_DEBUG_ID_FRAMES go test -count=1 ./...
```

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/ docs/contracts/events.md packages/ingestion/AGENTS.md
git commit -m "test(ingestion): prove debug-ID grouping collapses per-load URLs end to end"
```

---

## Rollout

1. Merge with `GROUPING_DEBUG_ID_FRAMES` unset (inert).
2. Land the post-triage alert delivery plan, so the re-key burst lands on a gated alert path.
3. Deploy to **every** ingestion task before flipping the flag — a mixed fleet keys the same event two ways.
4. Set `GROUPING_DEBUG_ID_FRAMES=true`.
5. Watch `opslane_ingest_debug_id_grouping_total`. If it stays near zero while events carry `debug_meta`, matching is failing — check the scope-boundary table before assuming the flag is on.
6. Confirm in prod:

```sql
SELECT date_trunc('day', first_seen) AS day, count(*) AS groups, sum(occurrence_count) AS events
FROM error_groups WHERE title ILIKE '%window title%'
GROUP BY 1 ORDER BY 1 DESC;
```

Success is `groups` dropping to ~1/day while `events` holds steady. Baseline measured 2026-08-13: 6 groups / 6 events on 08-13, 7 groups on 08-12.

## Self-Review

**Spec coverage.** Diagnosis → Tasks 1 + 3. Fallback for no-source-map apps → Task 1's `NoImagesMatchesLegacyFingerprint` + Task 3's guard. Non-JS platforms → Task 3's `NeverSubstitutesOnPython`. Query strings → `cutQuery` + `reDebugQuery` + test. Out-of-scope match failures → `DocumentedNonMatches`. Observability that distinguishes "on" from "working" → the `applied` bool + Task 3's counter comment. Rollout hazards → the scope-boundary table and the `AGENTS.md` note. End-to-end claim → Task 4.

**Placeholder scan.** No TBDs. Three bounded adaptation points, each naming what to match: `metrics.go` counter declaration, `sanitizeDebugMeta`'s final accepted slice (with the read-it-first instruction and the reason), and Task 4's fixtures (with the real helper names listed and "do not invent" stated).

**Type consistency.** `grouping.SourceImage{CodeFile, DebugID}` is defined in Task 1 and used verbatim in Tasks 2, 3, 4. `applyDebugIDs` and `FingerprintWithImages` both return `(string, bool)` in the interfaces block, the implementation, and every test. `groupingDecision`'s new parameter is `images []grouping.SourceImage` in the definition and the call site. `debugIDFramesEnabled` is the same identifier in the declaration, the guard, and `setDebugIDFrames`.
