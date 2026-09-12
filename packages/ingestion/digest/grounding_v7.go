package digest

import (
	"regexp"
	"strings"
)

var v7Number = regexp.MustCompile(`(?i)\p{Nd}+|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\b`)
var v7CustomerCount = regexp.MustCompile(`(?i)(?:\p{Nd}+|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\b)(?:[\s-]+[\p{L}]+){0,3}[\s-]+(?:users?|people|persons?|sessions?|recordings?|accounts?|customers?|visits?)\b`)

// A label or copula can put the quantity after its customer noun. Restrict
// the connector vocabulary so interaction claims such as "Users need 3
// clicks" remain grounded behavior rather than customer counts.
var v7CustomerCountAfter = regexp.MustCompile(`(?i)\b(?:users?|people|persons?|sessions?|recordings?|accounts?|customers?|visits?)\b(?:[\s-]+(?:count|total|affected)){0,2}(?:\s*[:=–—]\s*|\s+(?:(?:is|are|was|were|totals?|totaled|numbered|reached|equals?)\s+)?)(?:(?:only|exactly|about|approximately|at\s+least|at\s+most)\s+)?(?:\p{Nd}+|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\b)`)

func authoredCustomerCount(value string) string {
	normalized := normalizeProseNumbers(value)
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
