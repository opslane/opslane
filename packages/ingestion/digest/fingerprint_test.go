package digest

import (
	"testing"
	"time"
)

func intPtr(value int) *int { return &value }

func TestCandidateFingerprintSemanticContract(t *testing.T) {
	spell := time.Date(2026, 8, 27, 9, 0, 0, 0, time.UTC)
	base := Candidate{
		ErrorGroupID: "group", EpisodeID: "episode", EpisodeSequence: intPtr(2),
		Kind: "friction", Status: "awaiting_approval", SignalType: "dead_click",
		Title: "Save does nothing", Outcome: "needs_human", Summary: "The handler exits early",
		RootCause: "The handler exits early", ValidAction: "Review the investigation",
		DiffIdentity: "diff-a", RoutePurpose: "editing assets", Accounts: []string{"Beta", "Acme"},
		SpellStartedAt: &spell, AffectedUsers: 3, OccurrenceCount: 42,
		LastSeen: spell.Add(time.Hour),
	}
	// Pinned to the live constants: the prompt version is the cache authority,
	// so a bump here is what retires every card written under the old contract.
	if digestPromptVersion != 6 || digestValidatorVersion != 1 {
		t.Fatalf("prompt/validator version = %d/%d, want 6/1", digestPromptVersion, digestValidatorVersion)
	}
	want := candidateFingerprint(base, digestPromptVersion, digestValidatorVersion)
	if want == "" || want != candidateFingerprint(base, digestPromptVersion, digestValidatorVersion) {
		t.Fatal("fingerprint is empty or nondeterministic")
	}
	permuted := base
	permuted.Accounts = []string{"Acme", "Beta"}
	permuted.AffectedUsers = 99
	permuted.OccurrenceCount = 1000
	// The measured impact rolls every morning and the message prints it
	// mechanically, so it must never retire a day-old cached card.
	visits, recovered := int64(23), int64(4)
	permuted.ImpactVisits, permuted.ImpactRecovered = &visits, &recovered
	permuted.LastSeen = base.LastSeen.Add(24 * time.Hour)
	if got := candidateFingerprint(permuted, digestPromptVersion, digestValidatorVersion); got != want {
		t.Fatalf("volatile facts or account ordering changed fingerprint: %s != %s", got, want)
	}

	mutations := map[string]func(*Candidate){
		"title":            func(c *Candidate) { c.Title += " now" },
		"summary":          func(c *Candidate) { c.Summary += " changed" },
		"root cause":       func(c *Candidate) { c.RootCause += " changed" },
		"outcome":          func(c *Candidate) { c.Outcome = "verified_fix" },
		"status":           func(c *Candidate) { c.Status = "needs_human" },
		"action":           func(c *Candidate) { c.ValidAction += " now" },
		"diff":             func(c *Candidate) { c.DiffIdentity = "diff-b" },
		"route":            func(c *Candidate) { c.RoutePurpose += " page" },
		"kind":             func(c *Candidate) { c.Kind = "error" },
		"signal":           func(c *Candidate) { c.SignalType = "rage_click" },
		"diagnosis flag":   func(c *Candidate) { c.HasValidatedDiagnosis = true },
		"accounts":         func(c *Candidate) { c.Accounts = append(c.Accounts, "Gamma") },
		"episode id":       func(c *Candidate) { c.EpisodeID = "other" },
		"episode sequence": func(c *Candidate) { c.EpisodeSequence = intPtr(3) },
	}
	for name, mutate := range mutations {
		changed := base
		changed.Accounts = append([]string(nil), base.Accounts...)
		mutate(&changed)
		if got := candidateFingerprint(changed, digestPromptVersion, digestValidatorVersion); got == want {
			t.Errorf("%s did not change fingerprint", name)
		}
	}
	if candidateFingerprint(base, digestPromptVersion+1, digestValidatorVersion) == want ||
		candidateFingerprint(base, digestPromptVersion, digestValidatorVersion+1) == want {
		t.Error("prompt or validator version did not change fingerprint")
	}
}
