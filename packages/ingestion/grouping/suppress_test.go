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
	known := make(map[string]bool, len(SuppressRules))
	for _, rule := range SuppressRules {
		known[rule] = true
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rule, got := Suppress(c.platform, c.msg, c.stack)
			if got != c.want || rule != c.wantRule {
				t.Fatalf("Suppress(%q,%q,%q) = (%q,%v), want (%q,%v)", c.platform, c.msg, c.stack, rule, got, c.wantRule, c.want)
			}
			// Every rule Suppress can return must be declared, so the metrics
			// side has something to assert a counter against.
			if got && !known[rule] {
				t.Fatalf("Suppress returned rule %q, which is missing from SuppressRules", rule)
			}
		})
	}
}
