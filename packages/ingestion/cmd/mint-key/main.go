// Command mint-key mints a project API key and prints it once. It is the v1
// manual key lifecycle: mint here, revoke with the printed exact-key SQL.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// resolveScope maps the -scope flag to a stored scope value. The flag is
// required and exact: a truncated or typoed recovery command must fail
// loudly, never mint a valid-looking wrong credential.
func resolveScope(raw string) (string, error) {
	switch raw {
	case db.ScopeSourcemaps:
		return db.ScopeSourcemaps, nil
	case db.ScopeIngest:
		return db.ScopeIngest, nil
	case "":
		return "", fmt.Errorf("-scope is required (use %q or %q)", db.ScopeIngest, db.ScopeSourcemaps)
	default:
		return "", fmt.Errorf("unknown scope %q (use %q or %q)", raw, db.ScopeIngest, db.ScopeSourcemaps)
	}
}

// resolveEndpoint decides the upload destination sealed into a source-map key.
// A source-map key is only mintable when exactly one canonical destination is
// known: silently preferring one of two disagreeing sources would mint a key
// that uploads to the wrong deployment forever. An ingest key never carries a
// destination, so the flag is refused there while the deployment-wide env var
// is simply ignored.
func resolveEndpoint(flagVal, envVal, scope string) (string, error) {
	if scope != db.ScopeSourcemaps {
		if flagVal != "" {
			return "", fmt.Errorf("-endpoint is only valid with -scope %s", db.ScopeSourcemaps)
		}
		return "", nil
	}
	flagC, envC := "", ""
	var err error
	if flagVal != "" {
		if flagC, err = db.CanonicalIngestURL(flagVal); err != nil {
			return "", fmt.Errorf("-endpoint: %w", err)
		}
	}
	if envVal != "" {
		if envC, err = db.CanonicalIngestURL(envVal); err != nil {
			return "", fmt.Errorf("OPSLANE_PUBLIC_INGEST_URL: %w", err)
		}
	}
	switch {
	case flagC != "" && envC != "" && flagC != envC:
		return "", fmt.Errorf("-endpoint %q disagrees with OPSLANE_PUBLIC_INGEST_URL %q", flagC, envC)
	case flagC != "":
		return flagC, nil
	case envC != "":
		return envC, nil
	default:
		return "", fmt.Errorf("sourcemaps minting needs OPSLANE_PUBLIC_INGEST_URL or -endpoint")
	}
}

// keyInstructions renders the show-once output. The two scopes ship to
// different places: an sk is a CI secret; a pk is public by construction and
// lands in the browser bundle, so it only takes effect when the app
// redeploys.
func keyInstructions(scope, raw, keyID string) string {
	var out string
	switch scope {
	case db.ScopeIngest:
		out = "Ingest key (shown once — not retrievable later):\n" +
			"  " + raw + "\n\n" +
			"Set VITE_OPSLANE_API_KEY (or your app's equivalent) to this value,\n" +
			"then rebuild and redeploy the app: the key ships inside the browser\n" +
			"bundle, so it takes effect on the next app deploy, not on mint.\n"
	case db.ScopeSourcemaps:
		out = "Source-map upload key (shown once — not retrievable later):\n" +
			"  " + raw + "\n\n" +
			"Set OPSLANE_SOURCEMAP_KEY to this value in CI, and/or in the\n" +
			"repo's gitignored .env.local for local production builds. The key\n" +
			"carries its own upload destination, so this single value is the\n" +
			"whole configuration — there is no separate endpoint variable.\n"
	default:
		// resolveScope guards every caller; reaching this is a programming error.
		panic("keyInstructions: unknown scope " + scope)
	}
	out += "\nKey ID (for exact revocation): " + keyID + "\n" +
		"To revoke exactly this key:\n" +
		fmt.Sprintf("  UPDATE project_api_keys SET revoked_at = now() WHERE key_id = '%s';\n", keyID)
	return out
}

func defaultLabel(scope string) string {
	if scope == db.ScopeIngest {
		return "manual ingest key"
	}
	return "ci source maps"
}

func main() {
	projectID := flag.String("project", "", "project UUID")
	scopeFlag := flag.String("scope", "", "REQUIRED key scope: ingest (browser pk) or sourcemaps (CI sk)")
	label := flag.String("label", "", "key label (defaults per scope)")
	endpointFlag := flag.String("endpoint", "",
		"public ingest origin sealed into a sourcemaps key (defaults to OPSLANE_PUBLIC_INGEST_URL)")
	flag.Parse()
	if *projectID == "" {
		fmt.Fprintln(os.Stderr, "usage: mint-key -project <uuid> -scope ingest|sourcemaps [-label <text>] [-endpoint <url>]")
		os.Exit(2)
	}
	scope, err := resolveScope(*scopeFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	// Resolve the destination before touching the database: a key that cannot
	// be addressed must never reach an INSERT.
	endpoint, err := resolveEndpoint(*endpointFlag, os.Getenv("OPSLANE_PUBLIC_INGEST_URL"), scope)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if *label == "" {
		*label = defaultLabel(scope)
	}
	if os.Getenv("DATABASE_URL") == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL is required")
		os.Exit(2)
	}

	ctx := context.Background()
	pool, err := db.Connect(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect:", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Print the target's identity before minting so a wrong-but-valid UUID is
	// caught by the operator instead of silently routing another tenant's data.
	queries := db.New(pool)
	projectName, githubRepo, err := queries.GetProjectIdentity(ctx, *projectID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "no such project %s: %v\n", *projectID, err)
		os.Exit(1)
	}
	repo := "(no repo)"
	if githubRepo != nil {
		repo = *githubRepo
	}
	fmt.Printf("Minting %s key for project %q (%s, %s)\n", scope, projectName, repo, *projectID)
	if endpoint != "" {
		fmt.Printf("Upload destination sealed into the key: %s\n", endpoint)
	}
	fmt.Println()

	minted, err := queries.CreateProjectKey(ctx, *projectID, scope, *label, nil, endpoint)
	if err != nil {
		fmt.Fprintln(os.Stderr, "mint:", err)
		os.Exit(1)
	}

	fmt.Print(keyInstructions(scope, minted.Raw, minted.KeyID))
}
