package grouping

import (
	"crypto/sha256"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Pre-compiled regexps for message normalization.
var (
	reHex        = regexp.MustCompile(`0x[0-9a-fA-F]+`)
	reUUID       = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	rePathNum    = regexp.MustCompile(`/\d+`)
	reNum        = regexp.MustCompile(`\b\d+\b`)
	reQuoted     = regexp.MustCompile(`"[^"]*"`)
	reSpaces     = regexp.MustCompile(`\s+`)
	reURL        = regexp.MustCompile(`https?://[^/\s]+`)
	reAssetToken = regexp.MustCompile(`([A-Za-z0-9_.]+)-([A-Za-z0-9_]+)\.(js|mjs|cjs|css|map)(\?[^\s:'")]*)?(:\d+:\d+)?`)
	// reDebugQuery strips a query string left dangling on a substituted token.
	// The token delimits the match, so this cannot eat the trailing :line:col.
	reDebugQuery = regexp.MustCompile(`(<debug:[^>]*>)\?[^\s:)]*`)
)

// Fingerprint generates a stable fingerprint for error grouping.
// Algorithm: first 128 bits of
// SHA256(platform | error_type | normalized_message | frames).
// Python tracebacks use stable, prefix-stripped file:function identities;
// malformed and ExceptionGroup tracebacks fall back to the raw stack string.
func Fingerprint(platform, errorType, errorMessage, stackTrace string) string {
	if platform == "" {
		platform = "javascript"
	}
	template := normalizeMessage(errorMessage)

	var frames []string
	if platform == "python" {
		if isPythonTraceback(stackTrace) && !isExceptionGroupTraceback(stackTrace) {
			frames = pythonFrames(stackTrace)
		}
		if len(frames) == 0 && stackTrace != "" {
			frames = []string{stackTrace}
		}
	} else {
		frames = topFrames(stackTrace, 5)
	}

	input := fmt.Sprintf("%s|%s|%s|%s", platform, errorType, template, strings.Join(frames, "|"))
	hash := sha256.Sum256([]byte(input))
	return fmt.Sprintf("%x", hash[:16])
}

// normalizeMessage strips deploy-varying URLs and asset hashes along with the
// existing variable values to produce stable grouping templates.
func normalizeMessage(msg string) string {
	result := normalizeVolatile(msg)
	result = reHex.ReplaceAllString(result, "0xN")
	result = reUUID.ReplaceAllString(result, "<UUID>")
	result = rePathNum.ReplaceAllString(result, "/N")
	result = reNum.ReplaceAllString(result, "N")
	result = reQuoted.ReplaceAllString(result, `"..."`)
	result = reSpaces.ReplaceAllString(result, " ")
	return strings.ToLower(strings.TrimSpace(result))
}

// normalizeVolatile removes deploy-varying URL and hashed-asset content while
// leaving ordinary filenames and prose untouched.
func normalizeVolatile(s string) string {
	s = reURL.ReplaceAllString(s, "")
	return reAssetToken.ReplaceAllStringFunc(s, func(match string) string {
		parts := reAssetToken.FindStringSubmatch(match)
		if !looksLikeHash(parts[2]) {
			return match
		}
		return parts[1] + "-<HASH>." + parts[3]
	})
}

// looksLikeHash rejects short or letter-only suffixes used in ordinary names.
func looksLikeHash(s string) bool {
	if len(s) < 8 {
		return false
	}
	for _, r := range s {
		if r >= '0' && r <= '9' {
			return true
		}
	}
	return false
}

func topFrames(stack string, n int) []string {
	lines := strings.Split(stack, "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	for i, line := range lines {
		lines[i] = normalizeVolatile(line)
	}
	return lines
}

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
		substituted = strings.ReplaceAll(substituted, image.CodeFile, "<debug:"+image.DebugID+">")
	}
	if substituted == stackTrace {
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
