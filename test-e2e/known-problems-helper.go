// The live smoke calls exported ingestion code without adding a product API.
// Run from packages/ingestion so its module resolves the production packages.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/digest"
	store "github.com/opslane/opslane/packages/ingestion/minio"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	mode := flag.String("mode", "", "freeze, publish, or purge")
	project := flag.String("project", "", "test project UUID")
	runID := flag.String("run", "", "digest run UUID")
	session := flag.String("session", "", "test recording ID")
	at := flag.String("at", "", "freeze clock in RFC3339")
	flag.Parse()
	if *project == "" {
		return errors.New("project is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	var result interface{}
	switch *mode {
	case "freeze":
		clock, err := time.Parse(time.RFC3339, *at)
		if err != nil {
			return err
		}
		id, candidates, err := digest.FreezeCandidates(ctx, pool, *project, clock)
		if err != nil {
			return err
		}
		if candidates == nil {
			candidates = []digest.Candidate{}
		}
		result = map[string]interface{}{"runId": id, "candidates": candidates}
	case "publish":
		var scoped bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM digest_runs WHERE id=$1 AND project_id=$2)`, *runID, *project).Scan(&scoped); err != nil {
			return err
		}
		if !scoped {
			return errors.New("digest run is outside the test project")
		}
		if err := digest.ValidateAndPublish(ctx, pool, *runID); err != nil {
			return err
		}
		var raw []byte
		if err := pool.QueryRow(ctx, `SELECT rendered_payload FROM digest_runs WHERE id=$1 AND project_id=$2`, *runID, *project).Scan(&raw); err != nil {
			return err
		}
		var event notify.EventPayload
		if err := json.Unmarshal(raw, &event); err != nil {
			return err
		}
		slack, _, err := notify.FormatSlack(event)
		if err != nil {
			return err
		}
		result = map[string]interface{}{"event": event, "slack": json.RawMessage(slack)}
	case "purge":
		// The caller ages only its own fixture. Production retention admission,
		// object deletion, and transactional ticket reconciliation run here.
		q := db.New(pool)
		if err := q.MarkSessionDeleting(ctx, *session, *project); err != nil {
			return err
		}
		var deleting bool
		if err := pool.QueryRow(ctx, `SELECT status='deleting' FROM sessions WHERE id=$1 AND project_id=$2`, *session, *project).Scan(&deleting); err != nil {
			return err
		}
		if !deleting {
			return errors.New("test recording has not passed retention admission")
		}
		rows, err := pool.Query(ctx, `SELECT object_key FROM session_chunks WHERE session_id=$1 AND project_id=$2
			UNION SELECT frame->>'objectKey' FROM session_narratives,
			LATERAL jsonb_array_elements(verification->'frames') frame
			WHERE session_id=$1 AND project_id=$2`, *session, *project)
		if err != nil {
			return err
		}
		keys, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		objects, err := store.New(os.Getenv("MINIO_ENDPOINT"), "", os.Getenv("MINIO_ACCESS_KEY"), os.Getenv("MINIO_SECRET_KEY"), os.Getenv("MINIO_BUCKET"), "")
		if err != nil {
			return err
		}
		for _, key := range keys {
			if _, err := objects.StatObject(ctx, key); err != nil {
				return fmt.Errorf("expected replay object before purge: %w", err)
			}
		}
		if err := objects.RemovePrefix(ctx, fmt.Sprintf("sessions/%s/%s/", *project, *session)); err != nil {
			return err
		}
		if err := q.DeleteMarkedSession(ctx, *session, *project); err != nil {
			return err
		}
		for _, key := range keys {
			if _, err := objects.StatObject(ctx, key); !errors.Is(err, store.ErrObjectNotFound) {
				return fmt.Errorf("object survived purge: %s (%v)", key, err)
			}
		}
		result = map[string]interface{}{"removedObjects": len(keys)}
	default:
		return fmt.Errorf("unknown mode %q", *mode)
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
