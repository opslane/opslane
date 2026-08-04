package grouping

import (
	"encoding/json"
	"os"
	"testing"
)

type corpusEntry struct {
	Message string  `json:"message"`
	Family  *string `json:"family"`
	Note    string  `json:"note"`
}

func TestFamilyFingerprintCorpus(t *testing.T) {
	raw, err := os.ReadFile("../../../test-fixtures/grouping/stale-deploy-corpus.json")
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	var entries []corpusEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("parse corpus: %v", err)
	}
	if len(entries) < 10 {
		t.Fatalf("corpus suspiciously small: %d entries", len(entries))
	}

	const wantKey = "js|v2|r1|3394fed5608cf6c6b509abd8fbadef76"
	for _, entry := range entries {
		fingerprint, ok := FamilyFingerprint("javascript", entry.Message)
		wantMatch := entry.Family != nil && *entry.Family == "stale-deploy"
		if ok != wantMatch {
			t.Errorf("FamilyFingerprint(%q) matched=%v, want %v (%s)", entry.Message, ok, wantMatch, entry.Note)
		}
		if ok && fingerprint != wantKey {
			t.Errorf("fingerprint = %q, want exact constant %q", fingerprint, wantKey)
		}
	}
}

func TestFamilyFingerprintPlatformScope(t *testing.T) {
	for _, platform := range []string{"python", "", "node", "javascript-worker"} {
		if _, ok := FamilyFingerprint(platform, "Failed to fetch dynamically imported module: x.js"); ok {
			t.Fatalf("family rule must not fire for platform %q", platform)
		}
	}
}
