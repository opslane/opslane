package db

import (
	"regexp"
	"strings"
	"testing"
)

var (
	keyIDPattern  = regexp.MustCompile(`^[a-z2-7]{26}$`)
	secretPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

func TestNewProjectKeyFormat(t *testing.T) {
	for _, scope := range []string{ScopeIngest, ScopeSourcemaps} {
		minted, err := NewProjectKey(scope)
		if err != nil {
			t.Fatalf("NewProjectKey(%q): %v", scope, err)
		}
		if !keyIDPattern.MatchString(minted.KeyID) {
			t.Errorf("key_id %q has invalid shape", minted.KeyID)
		}
		parts := strings.SplitN(minted.Raw, "_", 4)
		if len(parts) != 4 || !secretPattern.MatchString(parts[3]) {
			t.Errorf("raw key %q has invalid shape", minted.Raw)
		}
		if len(minted.SecretHash) != 64 {
			t.Errorf("secret hash %q has invalid shape", minted.SecretHash)
		}
	}
}

func TestNewProjectKeyPrefixMatchesScope(t *testing.T) {
	ingest, err := NewProjectKey(ScopeIngest)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ingest.Raw, "opslane_pk_") || ingest.TokenPrefix != "opslane_pk" {
		t.Errorf("unexpected ingest key: %+v", ingest)
	}
	sourcemaps, err := NewProjectKey(ScopeSourcemaps)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(sourcemaps.Raw, "opslane_sk_") {
		t.Errorf("unexpected source-map key: %+v", sourcemaps)
	}
}

func TestNewProjectKeyRejectsUnknownScope(t *testing.T) {
	if _, err := NewProjectKey("admin"); err == nil {
		t.Fatal("expected unknown scope to fail")
	}
}

func TestParseProjectKeySecretContainingUnderscores(t *testing.T) {
	keyID := "mzxw6ytboi3damrrgi3tknzxgq"
	secret := "a_b_c_deFGHIJKLMNOPQRSTUVWXYZ0123456789-_x"
	if len(secret) != 42 {
		t.Fatalf("fixture secret length = %d", len(secret))
	}
	secret += "Z"
	parsed, err := ParseProjectKey("opslane_pk_" + keyID + "_" + secret)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.KeyID != keyID || parsed.Secret != secret || parsed.Scope != ScopeIngest {
		t.Errorf("parsed = %+v", parsed)
	}
}

func TestParseProjectKeyRoundTrip(t *testing.T) {
	minted, err := NewProjectKey(ScopeIngest)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseProjectKey(minted.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.KeyID != minted.KeyID || HashSecret(parsed.Secret) != minted.SecretHash {
		t.Errorf("round trip mismatch: minted=%+v parsed=%+v", minted, parsed)
	}
}

func TestParseProjectKeyRejects(t *testing.T) {
	cases := []string{
		"",
		"def_2f1c9a44-1b3e-4f4a-9c7a-4b2d8e6f0a11",
		"acme_pk_mzxw6ytboi3damrrgi3tknzxgq_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"opslane_zz_mzxw6ytboi3damrrgi3tknzxgq_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"opslane_pk_mzxw6ytboi3damrrgi3tknzxgq",
		"opslane_pk_mzxw6ytboi3damrrgi3tknzx_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"opslane_pk_MZXW6YTBOI3DAMRRGI3TKNZXGQ_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"opslane_pk_01xw6ytboi3damrrgi3tknzxgq_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_AAAA",
		"opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!A",
	}
	for _, raw := range cases {
		if _, err := ParseProjectKey(raw); err == nil {
			t.Errorf("ParseProjectKey(%q) should fail", raw)
		}
	}
}

func TestHashSecretIsStable(t *testing.T) {
	const want = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
	if got := HashSecret("test"); got != want {
		t.Errorf("HashSecret(test) = %q, want %q", got, want)
	}
}
