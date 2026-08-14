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

// minCodeFileLen is the shortest string that can plausibly name a bundle
// ("a.js" is four bytes). Anything shorter is not a file reference, and
// matching it against a stack only creates ways to rewrite text that is not a
// frame.
const minCodeFileLen = 4

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

	// Key on the query-stripped code_file, because that is what we match on.
	// The handler's ambiguity guard keys on the FULL code_file, so two images
	// that differ only by a per-request query string but disagree on debug ID
	// both survive it. Once the query is gone they collide, and keeping either
	// one would make the fingerprint depend on the order the SDK happened to
	// emit them in. Drop both instead.
	byFile := make(map[string]string, len(images))
	ambiguous := make(map[string]struct{})
	for _, image := range images {
		codeFile := cutQuery(image.CodeFile)
		if !usableCodeFile(codeFile) || image.DebugID == "" ||
			strings.ContainsAny(image.DebugID, "\n\r>") {
			continue
		}
		if existing, seen := byFile[codeFile]; seen && existing != image.DebugID {
			ambiguous[codeFile] = struct{}{}
			continue
		}
		byFile[codeFile] = image.DebugID
	}
	for codeFile := range ambiguous {
		delete(byFile, codeFile)
	}
	if len(byFile) == 0 {
		return stackTrace, false
	}

	usable := make([]SourceImage, 0, len(byFile))
	for codeFile, debugID := range byFile {
		usable = append(usable, SourceImage{CodeFile: codeFile, DebugID: debugID})
	}
	// Longest first, so a short URL that prefixes a longer one cannot shadow it.
	// Tie-break on the code file so Go's randomized map iteration can never
	// reach the fingerprint.
	sort.Slice(usable, func(i, j int) bool {
		if len(usable[i].CodeFile) != len(usable[j].CodeFile) {
			return len(usable[i].CodeFile) > len(usable[j].CodeFile)
		}
		return usable[i].CodeFile < usable[j].CodeFile
	})

	substituted := stackTrace
	for _, image := range usable {
		substituted = replaceFrameToken(substituted, image.CodeFile, "<debug:"+image.DebugID+">")
	}
	if substituted == stackTrace {
		return stackTrace, false
	}
	// Defense in depth. Substitution swaps a URL for a ~44-byte token, so it
	// should shrink the stack or barely grow it. Anything past this bound means
	// the anchoring above failed, and handing an unbounded string to the hasher
	// on the ingest hot path is worse than keeping the legacy identity.
	if len(substituted) > 2*len(stackTrace)+4096 {
		return stackTrace, false
	}
	return reDebugQuery.ReplaceAllString(substituted, "$1"), true
}

// usableCodeFile reports whether a code_file is plausibly a file reference and
// therefore safe to match against a stack.
//
// The handler only requires 1 to 4096 printable bytes, so without this a
// one-character value like "e" matches the error-type prefix on a stack's
// header line ("e: boom"), which is a token boundary on both sides but is not a
// frame. A real bundle reference always carries a path separator or an
// extension dot, and is never one or two characters long.
func usableCodeFile(codeFile string) bool {
	if len(codeFile) < minCodeFileLen {
		return false
	}
	if strings.ContainsAny(codeFile, "\n\r \t") {
		return false
	}
	return strings.ContainsAny(codeFile, "/.")
}

// replaceFrameToken replaces codeFile with token, but only where codeFile
// stands alone as a frame's file reference.
//
// Raw substring replacement is unsafe here. code_file is client-supplied and
// only has to be 1 to 4096 printable bytes, so a one-character value would
// rewrite every occurrence of that character in the stack, and the inserted
// token is itself made of letters a later image could match again. Measured on
// the unanchored version: six single-character images grew an 839-byte stack to
// 471 KB, and a project's public key is embedded in the browser.
//
// Anchoring also stops an image for one bundle from rewriting the middle of an
// unrelated frame's URL, which would make a bug's identity depend on the shape
// of the SDK's image list.
func replaceFrameToken(stack, codeFile, token string) string {
	var builder strings.Builder
	for index := 0; index < len(stack); {
		offset := strings.Index(stack[index:], codeFile)
		if offset < 0 {
			builder.WriteString(stack[index:])
			return builder.String()
		}
		start := index + offset
		end := start + len(codeFile)
		if frameTokenBoundary(stack, start-1) && frameTokenBoundary(stack, end) {
			builder.WriteString(stack[index:start])
			builder.WriteString(token)
			index = end
			continue
		}
		builder.WriteString(stack[index : start+1])
		index = start + 1
	}
	return builder.String()
}

// frameTokenBoundary reports whether the byte at index delimits a file
// reference in a stack frame, in either engine format: V8 "at fn (URL:1:2)"
// and Gecko/JSC "fn@URL:1:2". An out-of-range index is the start or end of the
// stack, which is also a boundary. '<' and '>' are deliberately absent, so a
// substituted <debug:...> token can never be matched again by a later image.
func frameTokenBoundary(stack string, index int) bool {
	if index < 0 || index >= len(stack) {
		return true
	}
	switch stack[index] {
	case '(', ')', '@', '?', ':', ' ', '\t', '\n', '\r', '\'', '"', ',':
		return true
	}
	return false
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
