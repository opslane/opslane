package digest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"time"
)

const digestValidatorVersion = 1
const digestPromptVersion = 4

// CachedDigestCard is an atomic, already validated card frozen into a run.
// Partial cache hits are never represented.
type CachedDigestCard struct {
	Title       string    `json:"title"`
	Copy        string    `json:"copy"`
	Action      string    `json:"action"`
	AuthoredAt  time.Time `json:"authoredAt"`
	Fingerprint string    `json:"fingerprint"`
}

// candidateFingerprint intentionally excludes rolling impact facts. Counts
// are rendered mechanically, so count and recency drift must not spend model
// tokens or invalidate digit-free authored prose.
func candidateFingerprint(candidate Candidate, promptVersion, validatorVersion int) string {
	accounts := append([]string(nil), candidate.Accounts...)
	sort.Strings(accounts)
	semantic := struct {
		ErrorGroupID, EpisodeID   string
		EpisodeSequence           *int
		Kind, Status, SignalType  string
		Title, Outcome, Summary   string
		RootCause, Mitigation     string
		ValidAction, DiffIdentity string
		RoutePurpose              string
		FrictionCategory, Route   string
		ObservationQuote          string
		Accounts                  []string
		HasValidatedDiagnosis     bool
		PromptVersion             int
		ValidatorVersion          int
	}{
		ErrorGroupID: candidate.ErrorGroupID, EpisodeID: candidate.EpisodeID,
		EpisodeSequence: candidate.EpisodeSequence, Kind: candidate.Kind,
		Status: candidate.Status, SignalType: candidate.SignalType,
		Title: candidate.Title, Outcome: candidate.Outcome, Summary: candidate.Summary,
		RootCause: candidate.RootCause, Mitigation: candidate.Mitigation,
		ValidAction: candidate.ValidAction, DiffIdentity: candidate.DiffIdentity,
		RoutePurpose: candidate.RoutePurpose, Accounts: accounts,
		FrictionCategory: candidate.FrictionCategory, Route: candidate.Route,
		ObservationQuote:      candidate.ObservationQuote,
		HasValidatedDiagnosis: candidate.HasValidatedDiagnosis,
		PromptVersion:         promptVersion, ValidatorVersion: validatorVersion,
	}
	encoded, _ := json.Marshal(semantic)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}
