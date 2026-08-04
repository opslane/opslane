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
// error name+message as the first line of err.stack; we tolerate any identifier
// prefix (custom error classes included). Only the first non-blank line is ever
// treated as a header.
var reErrorHeader = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_$]*: `)

var extensionSchemes = map[string]struct{}{
	"chrome-extension":     {},
	"moz-extension":        {},
	"safari-extension":     {},
	"safari-web-extension": {},
}

// classifyStackLines walks nonempty stack lines and returns the scheme of each
// line that parses as a frame, plus the count of nonempty lines that are neither
// a parseable frame nor the first-non-blank error-header line. Callers deciding
// to delete an event must treat unparsed > 0 as an unknown stack.
func classifyStackLines(stackTrace string) (parsedSchemes []string, unparsed int) {
	seenNonBlank := false
	for _, line := range strings.Split(stackTrace, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		first := !seenNonBlank
		seenNonBlank = true
		if match := reFrameURL.FindStringSubmatch(line); match != nil {
			parsedSchemes = append(parsedSchemes, strings.ToLower(match[1]))
			continue
		}
		if first && reErrorHeader.MatchString(line) {
			continue
		}
		unparsed++
	}
	return parsedSchemes, unparsed
}

// SuppressRules is the complete, ordered set of rule names Suppress can return.
// Suppression deletes events, so every rule here MUST have a matching counter in
// the ingestion metrics registry — a rule with no counter drops customer data
// with zero observability. Adding a rule to Suppress without adding it here (and
// wiring a counter) fails handler.TestRecordSuppressed_EveryRuleHasACounter.
var SuppressRules = []string{"resize_observer", "script_error", "extension_only"}

// Suppress reports whether an event is known noise that should be dropped
// before grouping (rung 0). It applies only to JavaScript. Rule order is a fixed
// contract: resize_observer, script_error, extension_only. Unknown stack lines
// make the extension-only rule fail closed so potentially useful data is kept.
func Suppress(platform, errorMessage, stackTrace string) (string, bool) {
	if platform != "javascript" {
		return "", false
	}

	message := strings.TrimSpace(errorMessage)
	if strings.HasPrefix(message, "ResizeObserver loop") {
		return "resize_observer", true
	}
	if strings.EqualFold(message, "Script error.") && strings.TrimSpace(stackTrace) == "" {
		return "script_error", true
	}

	schemes, unparsed := classifyStackLines(stackTrace)
	if len(schemes) == 0 || unparsed != 0 {
		return "", false
	}
	for _, scheme := range schemes {
		if _, ok := extensionSchemes[scheme]; !ok {
			return "", false
		}
	}
	return "extension_only", true
}
