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
