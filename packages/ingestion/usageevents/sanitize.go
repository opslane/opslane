package usageevents

import "strings"

const maxValueRunes = 300

// SanitizeValue makes one customer-controlled value safe for Slack mrkdwn:
// newlines cannot create fake fields, <...> cannot become links or mentions,
// and truncation never splits a rune.
func SanitizeValue(s string) string {
	s = strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ").Replace(s)
	s = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
	runes := []rune(s)
	if len(runes) > maxValueRunes {
		s = string(runes[:maxValueRunes]) + "…"
	}
	return s
}
