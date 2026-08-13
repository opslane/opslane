package grouping

import (
	"strings"
	"testing"
)

func TestNormalizeMessage(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"hex addresses", "error at 0x7fff5fbff8c8", "error at 0xn"},
		{"uuids", "user a1b2c3d4-e5f6-7890-abcd-ef1234567890 not found", "user <uuid> not found"},
		{"path numbers", "/users/123/posts/456", "/users/n/posts/n"},
		{"quoted strings", `Cannot read "foo" of undefined`, `cannot read "..." of undefined`},
		{"combined", `Error 0xAB at /api/users/42: "timeout"`, `error 0xn at /api/users/n: "..."`},
		{"already clean", "typeerror: cannot read properties of undefined", "typeerror: cannot read properties of undefined"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizeMessage(tt.input)
			if got != tt.want {
				t.Errorf("normalizeMessage(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestFingerprint_StableAcrossVariableContent(t *testing.T) {
	fp1 := Fingerprint("javascript", "TypeError", "Cannot read property of user 123", "at foo.js:1\nat bar.js:2")
	fp2 := Fingerprint("javascript", "TypeError", "Cannot read property of user 456", "at foo.js:1\nat bar.js:2")
	if fp1 != fp2 {
		t.Errorf("fingerprints should match: %s != %s", fp1, fp2)
	}
}

func TestFingerprint_DifferentErrorTypesDiffer(t *testing.T) {
	fp1 := Fingerprint("javascript", "TypeError", "msg", "at foo.js:1")
	fp2 := Fingerprint("javascript", "RangeError", "msg", "at foo.js:1")
	if fp1 == fp2 {
		t.Errorf("different error types should produce different fingerprints")
	}
}

func TestFingerprint_CollapsesContentHash(t *testing.T) {
	a := Fingerprint("javascript", "TypeError", "Failed to fetch dynamically imported module: https://app.example.com/assets/index-DbQ2xY9p.js", "")
	b := Fingerprint("javascript", "TypeError", "Failed to fetch dynamically imported module: https://app.example.com/assets/index-Zz88Aa10.js", "")
	if a != b {
		t.Fatalf("expected same fingerprint across deploy hashes, got %s vs %s", a, b)
	}
}

func TestFingerprint_StripsHost(t *testing.T) {
	a := Fingerprint("javascript", "Error", "Unable to preload CSS for https://app.example.com/assets/main-AbC12345.css", "")
	b := Fingerprint("javascript", "Error", "Unable to preload CSS for /assets/main-Zx9Yq077.css", "")
	if a != b {
		t.Fatalf("expected host-independent fingerprint, got %s vs %s", a, b)
	}
}

func TestFingerprint_KeepsLogicalName(t *testing.T) {
	idx := Fingerprint("javascript", "TypeError", "Failed to fetch dynamically imported module: /assets/index-AbC12345.js", "")
	vnd := Fingerprint("javascript", "TypeError", "Failed to fetch dynamically imported module: /assets/vendor-AbC12345.js", "")
	if idx == vnd {
		t.Fatalf("expected index and vendor to stay distinct")
	}
}

func TestFingerprint_DoesNotCollapseOrdinaryNames(t *testing.T) {
	a := Fingerprint("javascript", "TypeError", "Failed to import /assets/checkout-widget.js", "")
	b := Fingerprint("javascript", "TypeError", "Failed to import /assets/checkout-button.js", "")
	if a == b {
		t.Fatalf("expected checkout-widget and checkout-button to stay distinct")
	}
}

func TestFingerprint_DoesNotCollapseLongLetterOnlyNames(t *testing.T) {
	a := Fingerprint("javascript", "TypeError", "Failed to import /assets/checkout-widgetname.js", "")
	b := Fingerprint("javascript", "TypeError", "Failed to import /assets/checkout-buttonname.js", "")
	if a == b {
		t.Fatalf("expected long suffixes without digits to stay distinct")
	}
}

func TestFingerprint_DropsHashedAssetQuery(t *testing.T) {
	a := Fingerprint("javascript", "Error", "Unable to load /assets/main-AbC12345.js?cache=one", "")
	b := Fingerprint("javascript", "Error", "Unable to load /assets/main-AbC12345.js?cache=two", "")
	if a != b {
		t.Fatalf("expected hashed asset queries to be ignored, got %s vs %s", a, b)
	}
}

func TestFingerprint_KeepsNonHashedAssetQuery(t *testing.T) {
	a := Fingerprint("javascript", "Error", "Unable to load /assets/main.js?variant=one", "")
	b := Fingerprint("javascript", "Error", "Unable to load /assets/main.js?variant=two", "")
	if a == b {
		t.Fatalf("expected non-hashed asset queries to stay distinct")
	}
}

func TestFingerprint_DoesNotManglePlainText(t *testing.T) {
	a := Fingerprint("javascript", "Error", "Is the value correct? yes it was 5", "")
	b := Fingerprint("javascript", "Error", "Is the value correct? no it was 9", "")
	if a == b {
		t.Fatalf("plain-text prose after '?' must remain part of the fingerprint")
	}
}

func TestFingerprint_NormalizesHashedFrameCoords(t *testing.T) {
	s1 := "at load (https://app.example.com/assets/index-DbQ2xY9p.js:1:100)\nat run (/assets/app-Abc12345.js:2:5)"
	s2 := "at load (https://app.example.com/assets/index-Zz88Aa10.js:9:842)\nat run (/assets/app-Zzz99999.js:7:311)"
	if Fingerprint("javascript", "TypeError", "boom", s1) != Fingerprint("javascript", "TypeError", "boom", s2) {
		t.Fatalf("expected hashed frame hash+coords to be normalized")
	}
}

func TestFingerprint_KeepsNonHashedFrameCoords(t *testing.T) {
	s1 := "at a (/src/app.js:42:1)"
	s2 := "at a (/src/app.js:99:1)"
	if Fingerprint("javascript", "TypeError", "boom", s1) == Fingerprint("javascript", "TypeError", "boom", s2) {
		t.Fatalf("expected non-hashed frames to keep line/col granularity")
	}
}

func TestFingerprint_PlatformPreventsCollision(t *testing.T) {
	js := Fingerprint("javascript", "ValueError", "No row was found", "")
	py := Fingerprint("python", "ValueError", "No row was found", "")
	if js == py {
		t.Fatal("same-type errors on different platforms must not collide")
	}
}

func TestFingerprint_PythonUsesParsedFrames(t *testing.T) {
	a := Fingerprint("python", "ValueError", "No row was found", pyStandard)
	b := Fingerprint("python", "ValueError", "No row was found", strings.ReplaceAll(pyStandard, "/app/", "/srv/"))
	if a != b {
		t.Fatal("fingerprint not invariant across deployment roots")
	}
}

func TestFingerprint_PythonLibraryOnlyFramesFallBackToRawString(t *testing.T) {
	libOnly := "Traceback (most recent call last):\n" +
		"  File \"/app/venv/lib/python3.12/site-packages/celery/worker.py\", line 10, in run\n" +
		"    task()\n" +
		"  File \"/app/venv/lib/python3.12/site-packages/celery/task.py\", line 20, in task\n" +
		"    raise ValueError()\nValueError: boom"
	if got := pythonFrames(libOnly); len(got) != 0 {
		t.Fatalf("expected no app frames, got %v", got)
	}
	a := Fingerprint("python", "ValueError", "boom", libOnly)
	b := Fingerprint("python", "ValueError", "boom", strings.ReplaceAll(libOnly, "line 10", "line 11"))
	if a == b {
		t.Fatal("library-only tracebacks must fall back to raw-string fingerprinting")
	}
}

func TestFingerprint_PythonMalformedFallsBackToRawString(t *testing.T) {
	a := Fingerprint("python", "ValueError", "x", "Traceback (most recent call last):\ngarbage-A")
	b := Fingerprint("python", "ValueError", "x", "Traceback (most recent call last):\ngarbage-B")
	if a == b {
		t.Fatal("raw-string fallback must distinguish different raw stacks")
	}
}

func TestFingerprint_PythonExceptionGroupFallsBackToRawString(t *testing.T) {
	a := Fingerprint("python", "ExceptionGroup", "many", "  + Exception Group Traceback (most recent call last):\n  | ValueError: A")
	b := Fingerprint("python", "ExceptionGroup", "many", "  + Exception Group Traceback (most recent call last):\n  | ValueError: B")
	if a == b {
		t.Fatal("ExceptionGroup raw-string fallback must distinguish different stacks")
	}
}

func TestFingerprint_EmptyPlatformDefaultsToJavascript(t *testing.T) {
	a := Fingerprint("", "TypeError", "boom", "at fn (/src/app.js:1:1)")
	b := Fingerprint("javascript", "TypeError", "boom", "at fn (/src/app.js:1:1)")
	if a != b {
		t.Fatal("empty platform did not default to javascript")
	}
}

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
