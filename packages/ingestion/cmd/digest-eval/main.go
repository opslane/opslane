// Command digest-eval prints recent model-authored daily messages for human
// actionability review. It is deliberately read-only and safe for a production
// replica DSN.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

func main() {
	projectID := flag.String("project", "", "project UUID")
	days := flag.Int("days", 7, "number of delivered daily messages")
	flag.Parse()
	if *projectID == "" || *days < 1 || *days > 31 {
		log.Fatal("--project is required and --days must be between 1 and 31")
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SET default_transaction_read_only=on`); err != nil {
		log.Fatal(err)
	}
	rows, err := conn.Query(ctx, `SELECT run_date::text,rendered_payload
		FROM digest_runs WHERE project_id=$1 AND status='delivered' AND rendered_payload IS NOT NULL
		ORDER BY run_date DESC LIMIT $2`, *projectID, *days)
	if err != nil {
		log.Fatal(err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var date string
		var raw []byte
		if err := rows.Scan(&date, &raw); err != nil {
			log.Fatal(err)
		}
		var event notify.EventPayload
		if err := json.Unmarshal(raw, &event); err != nil {
			log.Fatalf("%s contains an unreadable delivered payload: %v", date, err)
		}
		if event.Digest == nil {
			log.Fatalf("%s contains a delivered payload with no digest body", date)
		}
		fmt.Printf("# %s\n\n", date)
		view := notify.BuildDigestView(event.Digest)
		if view.Legacy {
			fmt.Println("legacy format run")
			fmt.Println()
			count++
			continue
		}
		if view.Empty() {
			fmt.Println("Nothing needs your attention today.")
			fmt.Println()
		}
		for _, card := range view.Cards {
			fmt.Printf("## %s (%s)\n\n%s\n\nAction: %s\n\n", card.Title, card.Label, card.Copy, card.Action)
			if card.PRURL != "" {
				fmt.Printf("PR: %s\n\n", card.PRURL)
			}
		}
		for _, receipt := range view.Receipts {
			fmt.Printf("## %s\n\nIncident: %s\n\nState: %s\n\n", receipt.Title, receipt.IncidentID, receipt.ReceiptState)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		log.Fatal(err)
	}
	if count == 0 {
		log.Fatal("no delivered model-authored digests found")
	}
}
