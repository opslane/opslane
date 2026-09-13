package digest

import (
	"regexp"
	"strings"
)

// Keep these token and count rules aligned with the TypeScript writer.
const v7NumberPattern = `(?:\p{Nd}+|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\b)`
const v7CustomerNoun = `(?:users?|people|persons?|sessions?|recordings?|accounts?|customers?|visits?)\b`

var v7Number = regexp.MustCompile(`(?i)` + v7NumberPattern)

// Remove explicit interaction quantities only from the customer-count scan.
// The original prose still undergoes evidence-number validation below.
var v7InteractionQuantity = regexp.MustCompile(`(?i)` + v7NumberPattern + `[\s-]+(?:clicks?|press(?:es)?|taps?|keystrokes?|swipes?|scrolls?|steps?|attempts?|retr(?:y|ies)|times?|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b`)
var v7CustomerCount = regexp.MustCompile(`(?i)` + v7NumberPattern + `\)?(?:[\s-]+[\p{L}]+){0,3}[\s-]+` + v7CustomerNoun)

// Labels and copulas can put the quantity after its noun, including "users
// impacted: 3" and "users (3)". Behavioral verbs such as "need" stay separate.
var v7CustomerCountAfter = regexp.MustCompile(`(?i)\b` + v7CustomerNoun + `(?:[\s-]+(?:count|total|affected|impacted))*(?:\s*[:=–—]\s*|\s+(?:(?:is|are|was|were|totals?|totaled|numbered|reached|equals?)\s+)?)(?:(?:only|exactly|about|approximately|at\s+least|at\s+most)\s+)?(?:` + v7NumberPattern + `|\(\s*` + v7NumberPattern + `\s*\))`)

func authoredCustomerCount(value string) string {
	normalized := v7InteractionQuantity.ReplaceAllString(normalizeProseNumbers(value), " ")
	if claim := v7CustomerCount.FindString(normalized); claim != "" {
		return claim
	}
	return v7CustomerCountAfter.FindString(normalized)
}

func firstUngroundedV7Number(card writtenDigestCard, candidate Candidate) (string, bool) {
	sources := append([]string{candidate.Steps}, candidate.ConfirmedNotes...)
	if candidate.TicketID == "" {
		sources = append(sources, candidate.ObservationQuote, candidate.Summary, candidate.RootCause)
	}
	allowed := map[string]bool{}
	for _, source := range sources {
		for _, n := range v7Number.FindAllString(normalizeProseNumbers(source), -1) {
			allowed[strings.ToLower(n)] = true
		}
	}
	for _, field := range []string{card.Title, card.Copy, card.Steps} {
		if claim := authoredCustomerCount(field); claim != "" {
			return claim, true
		}
		for _, n := range v7Number.FindAllString(normalizeProseNumbers(field), -1) {
			if !allowed[strings.ToLower(n)] {
				return n, true
			}
		}
	}
	cause := candidate.Why
	if cause == "" {
		cause = candidate.RootCause
	}
	whyNumbers := map[string]bool{}
	for _, n := range v7Number.FindAllString(normalizeProseNumbers(cause), -1) {
		whyNumbers[strings.ToLower(n)] = true
	}
	if claim := authoredCustomerCount(card.Why); claim != "" {
		return claim, true
	}
	for _, n := range v7Number.FindAllString(normalizeProseNumbers(card.Why), -1) {
		if !whyNumbers[strings.ToLower(n)] {
			return n, true
		}
	}
	return "", false
}
