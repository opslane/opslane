// Package narrative owns deterministic, reader-facing copy shared by digest
// and incident surfaces.
package narrative

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"

	"github.com/opslane/opslane/packages/ingestion/masking"
)

var (
	proseEmailPattern = regexp.MustCompile(`(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`)
	urlOriginPattern  = regexp.MustCompile(`https?://[^/\s]+`)
)

// Impact is the mechanically measured recording impact for an incident.
type Impact struct {
	Class     string
	Visits    *int64
	Recovered *int64
}

// Story renders a deterministic incident summary from stored counts.
func Story(nounSingular, nounPlural string, occurrences int64, impact Impact) string {
	occurrenceNoun := plural(occurrences, nounSingular, nounPlural)
	prefix := fmt.Sprintf("%d %s", occurrences, occurrenceNoun)
	if !validImpact(impact) {
		return prefix + "; recording impact unavailable"
	}

	visits := *impact.Visits
	recovered := *impact.Recovered
	line := fmt.Sprintf("%s across %d %s, ", prefix, visits, plural(visits, "visit", "visits"))
	switch {
	case recovered == 0:
		return line + "no visit recovered"
	case recovered == visits:
		return fmt.Sprintf("%sall %d %s recovered", line, visits, plural(visits, "visit", "visits"))
	default:
		return fmt.Sprintf("%s%d of %d visits recovered", line, recovered, visits)
	}
}

func validImpact(impact Impact) bool {
	switch impact.Class {
	case "blocked", "degraded", "invisible":
	default:
		return false
	}
	return impact.Visits != nil && impact.Recovered != nil &&
		*impact.Visits >= 0 && *impact.Recovered >= 0 && *impact.Recovered <= *impact.Visits
}

// ReceiptLine returns the fixed sentence for a known receipt state.
func ReceiptLine(state string) (string, bool) {
	switch state {
	case "pr_open":
		return "Fix PR ready for review.", true
	case "attempt_failed_with_diff":
		return "Fix attempt failed its checks; saved diff and report on the issue page.", true
	case "attempt_failed_no_diff":
		return "Fix attempt failed before producing a change; investigation report on the issue page.", true
	case "report_ready":
		return "Investigation report ready.", true
	default:
		return "", false
	}
}

// TriageLine renders the point-in-time action summary.
func TriageLine(prsAwaitingReview, needsDecision int, quiet bool) string {
	var prs string
	switch prsAwaitingReview {
	case 0:
		prs = "No fix PRs awaiting review"
	case 1:
		prs = "1 fix PR awaiting review"
	default:
		prs = fmt.Sprintf("%d fix PRs awaiting review", prsAwaitingReview)
	}

	var decisions string
	switch needsDecision {
	case 0:
		decisions = "no issues need a decision"
	case 1:
		decisions = "1 issue needs a decision"
	default:
		decisions = fmt.Sprintf("%d issues need a decision", needsDecision)
	}

	line := prs + ", " + decisions
	if quiet {
		line += ", nothing else needs you today"
	}
	return line + "."
}

// HeldBackLine reports receipts excluded by the readiness or artifact belt.
func HeldBackLine(heldBack int) string {
	return fmt.Sprintf("Held back: %d %s without a verified receipt yet.", heldBack, plural(int64(heldBack), "item", "items"))
}

// OverflowLine reports publishable receipts below the card cap.
func OverflowLine(overflow int) string {
	return fmt.Sprintf("%d more %s ranked below these — open the dashboard for the full list.", overflow, plural(int64(overflow), "receipt", "receipts"))
}

// Clean removes secrets and formatting controls from prose without imposing a
// length budget. Formatting markers become apostrophes rather than vanishing:
// deletion fuses the tokens around snake_case identifiers ("user_profile_id"
// must not become "userprofileid" in customer copy) and an all-marker value
// must not sanitize to the empty string.
func Clean(value string) string {
	value = masking.RedactBody(value)
	value = masking.RedactURL(value)
	value = proseEmailPattern.ReplaceAllString(value, "[REDACTED]")
	value = urlOriginPattern.ReplaceAllString(value, "")
	value = strings.Map(func(r rune) rune {
		switch r {
		case '`', '*', '_', '~':
			return '\''
		}
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	return strings.TrimSpace(value)
}

// SanitizeExcerpt removes secrets and formatting controls before prose enters
// an outbox payload. The returned string never exceeds max runes.
func SanitizeExcerpt(value string, max int) string {
	value = Clean(value)
	if max <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	if max == 1 {
		return "…"
	}
	return string(runes[:max-1]) + "…"
}

func plural(n int64, singular, plural string) string {
	if n == 1 {
		return singular
	}
	return plural
}
