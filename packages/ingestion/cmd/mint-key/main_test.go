package main

import (
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestResolveScope(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"", "", true}, // scope is REQUIRED: refusal, not a silent default
		{"sourcemaps", db.ScopeSourcemaps, false},
		{"ingest", db.ScopeIngest, false},
		{"admin", "", true},  // unknown scope is refused
		{"Ingest", "", true}, // no case folding: exact values only
	}
	for _, c := range cases {
		got, err := resolveScope(c.in)
		if c.wantErr != (err != nil) {
			t.Fatalf("resolveScope(%q) err = %v, wantErr %v", c.in, err, c.wantErr)
		}
		if got != c.want {
			t.Fatalf("resolveScope(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestKeyInstructionsPerScope(t *testing.T) {
	sk := keyInstructions(db.ScopeSourcemaps, "opslane_sk_x_y", "kid123")
	for _, must := range []string{
		"OPSLANE_SOURCEMAP_KEY", "opslane_sk_x_y", "shown once",
		"WHERE key_id = 'kid123'",
	} {
		if !strings.Contains(sk, must) {
			t.Fatalf("sourcemaps instructions missing %q:\n%s", must, sk)
		}
	}
	if strings.Contains(sk, "VITE_OPSLANE_API_KEY") {
		t.Fatal("sourcemaps instructions must not mention the browser env var")
	}
	// The key carries its own upload destination, so the instructions must not
	// send the operator looking for a second variable.
	if strings.Contains(sk, "OPSLANE_ENDPOINT") {
		t.Fatal("sourcemaps instructions must not mention OPSLANE_ENDPOINT")
	}
	if !strings.Contains(sk, "destination") {
		t.Fatalf("sourcemaps instructions must say the key carries its destination:\n%s", sk)
	}
	if n := strings.Count(sk, "opslane_sk_x_y"); n != 1 {
		t.Fatalf("raw key must appear exactly once, got %d", n)
	}

	pk := keyInstructions(db.ScopeIngest, "opslane_pk_x_y", "kid456")
	for _, must := range []string{
		"VITE_OPSLANE_API_KEY", "opslane_pk_x_y", "redeploy",
		"WHERE key_id = 'kid456'",
	} {
		if !strings.Contains(pk, must) {
			t.Fatalf("ingest instructions missing %q:\n%s", must, pk)
		}
	}
	if strings.Contains(pk, "OPSLANE_SOURCEMAP_KEY") {
		t.Fatal("ingest instructions must not mention the CI secret env var")
	}
	if n := strings.Count(pk, "opslane_pk_x_y"); n != 1 {
		t.Fatalf("raw key must appear exactly once, got %d", n)
	}
}

// TestResolveEndpoint pins the one-source-of-truth rule: a sourcemaps key is
// only mintable when exactly one canonical destination is known, and an ingest
// key never carries one.
func TestResolveEndpoint(t *testing.T) {
	cases := []struct {
		name    string
		flag    string
		env     string
		scope   string
		want    string
		wantErr bool
	}{
		{"sourcemaps neither", "", "", db.ScopeSourcemaps, "", true},
		{"sourcemaps flag only", "https://ingest.opslane.com", "", db.ScopeSourcemaps, "https://ingest.opslane.com", false},
		{"sourcemaps env only", "", "https://ingest.opslane.com", db.ScopeSourcemaps, "https://ingest.opslane.com", false},
		{
			"sourcemaps agreeing after canonicalization",
			"HTTPS://Ingest.Opslane.com:443/", "https://ingest.opslane.com",
			db.ScopeSourcemaps, "https://ingest.opslane.com", false,
		},
		{"sourcemaps conflict", "https://a.example", "https://b.example", db.ScopeSourcemaps, "", true},
		{"sourcemaps bad flag", "not a url", "", db.ScopeSourcemaps, "", true},
		{"sourcemaps bad env", "", "ftp://ingest.example", db.ScopeSourcemaps, "", true},
		{"ingest neither", "", "", db.ScopeIngest, "", false},
		{"ingest flag rejected", "https://ingest.opslane.com", "", db.ScopeIngest, "", true},
		{"ingest env ignored", "", "https://ingest.opslane.com", db.ScopeIngest, "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := resolveEndpoint(c.flag, c.env, c.scope)
			if c.wantErr != (err != nil) {
				t.Fatalf("resolveEndpoint(%q, %q, %q) err = %v, wantErr %v",
					c.flag, c.env, c.scope, err, c.wantErr)
			}
			if got != c.want {
				t.Fatalf("resolveEndpoint(%q, %q, %q) = %q, want %q",
					c.flag, c.env, c.scope, got, c.want)
			}
		})
	}
}

// TestResolveEndpointErrorsDoNotEchoSecrets keeps operator-facing failures free
// of anything but the URLs the operator typed.
func TestResolveEndpointErrorsDoNotEchoSecrets(t *testing.T) {
	_, err := resolveEndpoint("https://a.example", "https://b.example", db.ScopeSourcemaps)
	if err == nil {
		t.Fatal("conflicting sources must fail")
	}
	for _, must := range []string{"https://a.example", "https://b.example", "OPSLANE_PUBLIC_INGEST_URL"} {
		if !strings.Contains(err.Error(), must) {
			t.Fatalf("conflict error must name %q: %v", must, err)
		}
	}
}
