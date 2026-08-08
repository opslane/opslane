package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func main() {
	batch := flag.Int("batch", 100, "maximum sessions to enqueue per batch")
	sleep := flag.Duration("sleep", 30*time.Second, "delay between batches")
	dryRun := flag.Bool("dry-run", false, "count candidates without enqueueing")
	ruleVersion := flag.Int("rule-version", 0, "worker analyzer RULE_VERSION (required)")
	flag.Parse()
	if *batch < 1 || *sleep < 0 || *ruleVersion < 1 {
		fmt.Fprintln(os.Stderr, "-batch must be positive, -sleep non-negative, and -rule-version is required")
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
	queries := db.New(pool)
	if *dryRun {
		count, countErr := queries.CountAnalysisBackfillCandidates(ctx, *ruleVersion)
		if countErr != nil {
			fmt.Fprintln(os.Stderr, "count candidates:", countErr)
			os.Exit(1)
		}
		fmt.Printf("session-analysis backfill candidates: %d\n", count)
		return
	}
	for {
		count, enqueueErr := queries.EnqueueAnalysisBackfillBatch(ctx, *ruleVersion, *batch)
		if enqueueErr != nil {
			fmt.Fprintln(os.Stderr, "enqueue batch:", enqueueErr)
			os.Exit(1)
		}
		fmt.Printf("enqueued %d session-analysis jobs\n", count)
		if count == 0 {
			return
		}
		time.Sleep(*sleep)
	}
}
