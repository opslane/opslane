package identity

import (
	"encoding/json"
	"os"
	"testing"
)

func TestCanonicalStringMatchesFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../test-fixtures/grouping/resolved-envelope-v2.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture struct {
		Version           int     `json:"version"`
		Frames            []Frame `json:"frames"`
		ExpectedCanonical string  `json:"expected_canonical"`
		ExpectedHash      string  `json:"expected_hash"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	// Pin the constants to the fixture: regenerating the fixture for a new
	// resolver version without bumping ResolverVersion (or vice versa) must
	// fail here, or the two runtimes drift silently.
	if fixture.Version != ResolverVersion {
		t.Fatalf("fixture version %d != ResolverVersion %d", fixture.Version, ResolverVersion)
	}
	if IdentityVersion != ResolverVersion {
		t.Fatalf("IdentityVersion %d != ResolverVersion %d; the v2 contract keeps them aligned", IdentityVersion, ResolverVersion)
	}
	envelope := Envelope{Version: fixture.Version, Frames: fixture.Frames}
	if got := CanonicalString(envelope); got != fixture.ExpectedCanonical {
		t.Errorf("CanonicalString =\n  %q\nwant\n  %q", got, fixture.ExpectedCanonical)
	}
	if got := Hash(envelope); got != fixture.ExpectedHash {
		t.Errorf("Hash = %q, want %q", got, fixture.ExpectedHash)
	}
}
