// Command digest-replay drives the daily digest pipeline for a historical
// boundary. It exists for the slice-10 production evaluation: freeze a run at
// a past daily boundary, hand it to the worker, and publish it once written.
//
//	digest-replay -project <uuid> -freeze -at 2026-08-09T09:00:00Z
//	digest-replay -project <uuid> -publish -run <run-uuid>
//
// Verification rig; not part of the deployed system.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/digest"
)

func main() {
	projectID := flag.String("project", "", "project UUID")
	freeze := flag.Bool("freeze", false, "freeze candidates at -at and enqueue the writing job")
	at := flag.String("at", "", "boundary timestamp, RFC 3339")
	publish := flag.Bool("publish", false, "validate and publish -run")
	runID := flag.String("run", "", "digest run UUID for -publish")
	flag.Parse()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" || *projectID == "" {
		log.Fatal("DATABASE_URL and -project are required")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	switch {
	case *freeze:
		boundary, err := time.Parse(time.RFC3339, *at)
		if err != nil {
			log.Fatalf("bad -at: %v", err)
		}
		id, candidates, err := digest.FreezeCandidates(ctx, pool, *projectID, boundary.UTC())
		if err != nil {
			log.Fatalf("freeze: %v", err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO error_group_jobs
			(project_id,run_id,job_type,status,triggered_by)
			SELECT $1,$2,'digest_write','pending','auto'
			WHERE NOT EXISTS (SELECT 1 FROM error_group_jobs
			 WHERE project_id=$1 AND run_id=$2 AND job_type='digest_write'
			   AND status IN ('pending','claimed'))`, *projectID, id); err != nil {
			log.Fatalf("enqueue write: %v", err)
		}
		fmt.Printf("run=%s candidates=%d\n", id, len(candidates))
	case *publish:
		if *runID == "" {
			log.Fatal("-publish requires -run")
		}
		if err := digest.ValidateAndPublish(ctx, pool, *runID); err != nil {
			log.Fatalf("publish: %v", err)
		}
		fmt.Println("published")
	default:
		log.Fatal("pass -freeze or -publish")
	}
}
