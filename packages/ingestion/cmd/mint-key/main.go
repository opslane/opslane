// Command mint-key mints a sourcemaps-scoped project key and prints it once.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func main() {
	projectID := flag.String("project", "", "project UUID")
	label := flag.String("label", "ci source maps", "key label")
	flag.Parse()
	if *projectID == "" {
		fmt.Fprintln(os.Stderr, "usage: mint-key -project <uuid> [-label <text>]")
		os.Exit(2)
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

	minted, err := db.New(pool).CreateProjectKey(
		ctx, *projectID, db.ScopeSourcemaps, *label, nil,
	)
	if err != nil {
		fmt.Fprintln(os.Stderr, "mint:", err)
		os.Exit(1)
	}

	fmt.Println("Source-map upload key (shown once — not retrievable later):")
	fmt.Println("  " + minted.Raw)
	fmt.Println()
	fmt.Println("Set OPSLANE_SOURCEMAP_KEY to this value in CI, and/or in the")
	fmt.Println("repo's gitignored .env.local for local production builds.")
	fmt.Println()
	fmt.Println("Key ID (for exact revocation): " + minted.KeyID)
	fmt.Println("To revoke exactly this key:")
	fmt.Printf("  UPDATE project_api_keys SET revoked_at = now() WHERE key_id = '%s';\n", minted.KeyID)
}
