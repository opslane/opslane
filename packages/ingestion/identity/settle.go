package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Result struct {
	CanonicalIssueID string
	State            string
}

// Settle binds an observation's versioned fingerprints to a canonical issue.
// Normal settlement only attaches; moving observations belongs to the audited
// merge operation.
func Settle(ctx context.Context, pool *pgxpool.Pool, projectID, eventID string) (Result, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("begin settlement: %w", err)
	}
	defer tx.Rollback(ctx)

	var rawFingerprint, identityStatus, resolutionStatus string
	var identityVersion int
	var canonicalIssueID *string
	var envelopeJSON []byte
	if err := tx.QueryRow(ctx,
		`SELECT i.raw_fingerprint, i.status, i.identity_version,
		        i.canonical_issue_id::text, r.status, r.envelope
		   FROM error_event_identities i
		   JOIN error_event_resolutions r
		     ON r.project_id=i.project_id AND r.event_id=i.event_id
		  WHERE i.project_id=$1 AND i.event_id=$2
		  FOR UPDATE OF i`, projectID, eventID).Scan(
		&rawFingerprint, &identityStatus, &identityVersion,
		&canonicalIssueID, &resolutionStatus, &envelopeJSON,
	); err != nil {
		return Result{}, fmt.Errorf("load identity: %w", err)
	}
	if identityStatus == "settled" {
		if canonicalIssueID == nil {
			return Result{}, errors.New("settled identity has no canonical issue")
		}
		if err := tx.Commit(ctx); err != nil {
			return Result{}, fmt.Errorf("commit settled retry: %w", err)
		}
		return Result{CanonicalIssueID: *canonicalIssueID, State: "settled"}, nil
	}
	if identityStatus == "conflict" {
		if err := tx.Commit(ctx); err != nil {
			return Result{}, fmt.Errorf("commit conflict retry: %w", err)
		}
		return Result{State: "conflict"}, nil
	}
	if identityStatus != "pending" && identityStatus != "settling" {
		return Result{}, fmt.Errorf("identity status %q is not settleable", identityStatus)
	}
	if resolutionStatus != "resolved" && resolutionStatus != "no_map" {
		return Result{}, fmt.Errorf("resolution status %q is not terminal", resolutionStatus)
	}

	candidates := []alias{{fingerprint: rawFingerprint, kind: "raw"}}
	resolvedFingerprint := ""
	if resolutionStatus == "resolved" {
		var envelope Envelope
		if len(envelopeJSON) == 0 || string(envelopeJSON) == "null" {
			return Result{}, errors.New("resolved observation has no envelope")
		}
		if err := json.Unmarshal(envelopeJSON, &envelope); err != nil {
			return Result{}, fmt.Errorf("decode resolved envelope: %w", err)
		}
		if envelope.Version != identityVersion || envelope.Version != ResolverVersion {
			return Result{}, fmt.Errorf("resolved envelope version %d does not match identity version %d", envelope.Version, identityVersion)
		}
		if len(envelope.Frames) == 0 {
			return Result{}, errors.New("resolved envelope has no identity frames")
		}
		resolvedFingerprint = Hash(envelope)
		candidates = append(candidates, alias{fingerprint: resolvedFingerprint, kind: "resolved"})
	}
	candidates = normalizeAliases(candidates)
	if err := lockAliases(ctx, tx, projectID, identityVersion, candidates); err != nil {
		return Result{}, err
	}

	bound, err := lookupAliases(ctx, tx, projectID, identityVersion, candidates)
	if err != nil {
		return Result{}, err
	}
	distinct := distinctIssues(bound)
	if len(distinct) > 1 {
		if err := recordConflict(ctx, tx, projectID, eventID, distinct); err != nil {
			return Result{}, err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE error_event_identities
			    SET status='conflict', claimed_at=NULL,
			        resolved_fingerprint=NULLIF($3,'')
			  WHERE project_id=$1 AND event_id=$2`,
			projectID, eventID, resolvedFingerprint); err != nil {
			return Result{}, fmt.Errorf("mark identity conflict: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return Result{}, fmt.Errorf("commit conflict: %w", err)
		}
		return Result{State: "conflict"}, nil
	}

	issueID := ""
	if len(distinct) == 1 {
		issueID = distinct[0]
		if err := lockActiveIssue(ctx, tx, projectID, issueID); err != nil {
			return Result{}, err
		}
	} else {
		issueID, err = createIssue(ctx, tx, projectID, eventID)
		if err != nil {
			return Result{}, err
		}
	}
	for _, candidate := range candidates {
		if err := bindAlias(ctx, tx, projectID, identityVersion, candidate, issueID); err != nil {
			return Result{}, err
		}
	}
	if err := attachObservation(ctx, tx, projectID, eventID, issueID); err != nil {
		return Result{}, err
	}
	episodeID, err := episodeForObservation(ctx, tx, projectID, issueID, eventID)
	if err != nil {
		return Result{}, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE error_event_identities
		    SET status='settled', canonical_issue_id=$3,
		        resolved_fingerprint=NULLIF($4,''), episode_id=$5,
		        claimed_at=NULL, settled_at=now()
		  WHERE project_id=$1 AND event_id=$2`,
		projectID, eventID, issueID, resolvedFingerprint, episodeID); err != nil {
		return Result{}, fmt.Errorf("mark identity settled: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, fmt.Errorf("commit settlement: %w", err)
	}
	return Result{CanonicalIssueID: issueID, State: "settled"}, nil
}

func createIssue(ctx context.Context, tx pgx.Tx, projectID, eventID string) (string, error) {
	// sample_event_id is a stable display anchor for the dashboard's
	// sample-event view and human-triggered fix jobs: set once here, kept if
	// already present on attach, and never rewritten. Identity decisions never
	// read it (see the canary test).
	var issueID string
	if err := tx.QueryRow(ctx,
		`WITH new_issue AS (SELECT gen_random_uuid() AS id)
		 INSERT INTO error_groups
		   (id,project_id,environment_id,fingerprint,title,platform,first_seen,last_seen,
		    occurrence_count,affected_users_count,status,sample_event_id)
		 SELECT n.id,e.project_id,e.environment_id,'canonical:' || n.id::text,
		        concat(e.error_type, ': ', e.error_message),e.platform,e.timestamp,e.timestamp,
		        0,0,'new',e.id
		   FROM error_events e CROSS JOIN new_issue n
		  WHERE e.project_id=$1 AND e.id=$2
		 RETURNING id::text`, projectID, eventID).Scan(&issueID); err != nil {
		return "", fmt.Errorf("create canonical issue: %w", err)
	}
	return issueID, nil
}

func lockActiveIssue(ctx context.Context, tx pgx.Tx, projectID, issueID string) error {
	var status string
	if err := tx.QueryRow(ctx,
		`SELECT status::text FROM error_groups
		  WHERE project_id=$1 AND id=$2 FOR UPDATE`, projectID, issueID).Scan(&status); err != nil {
		return fmt.Errorf("lock canonical issue: %w", err)
	}
	if status == "merged" {
		return errors.New("canonical issue was merged while settlement was in progress")
	}
	return nil
}

func attachObservation(ctx context.Context, tx pgx.Tx, projectID, eventID, issueID string) error {
	var timestamp time.Time
	var endUserID *string
	var currentIssueID *string
	var environmentID string
	if err := tx.QueryRow(ctx,
		`SELECT timestamp,end_user_id::text,error_group_id::text,environment_id::text
		   FROM error_events WHERE project_id=$1 AND id=$2 FOR UPDATE`,
		projectID, eventID).Scan(&timestamp, &endUserID, &currentIssueID, &environmentID); err != nil {
		return fmt.Errorf("load observation: %w", err)
	}
	if currentIssueID != nil {
		if *currentIssueID == issueID {
			return nil
		}
		return errors.New("observation is already attached to a different issue")
	}
	if _, err := tx.Exec(ctx,
		`UPDATE error_events SET error_group_id=$3
		  WHERE project_id=$1 AND id=$2 AND error_group_id IS NULL`,
		projectID, eventID, issueID); err != nil {
		return fmt.Errorf("attach observation: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE error_groups
		    SET occurrence_count=occurrence_count+1,
		        first_seen=LEAST(first_seen,$3), last_seen=GREATEST(last_seen,$3),
		        sample_event_id=COALESCE(sample_event_id,$4),
		        updated_at=now()
		  WHERE project_id=$1 AND id=$2`, projectID, issueID, timestamp, eventID); err != nil {
		return fmt.Errorf("update issue counters: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO error_group_environments
		   (error_group_id,environment_id,first_seen,last_seen,occurrence_count)
		 VALUES ($1,$2,$3,$3,1)
		 ON CONFLICT (error_group_id,environment_id) DO UPDATE
		   SET first_seen=LEAST(error_group_environments.first_seen,EXCLUDED.first_seen),
		       last_seen=GREATEST(error_group_environments.last_seen,EXCLUDED.last_seen),
		       occurrence_count=error_group_environments.occurrence_count+1`,
		issueID, environmentID, timestamp); err != nil {
		return fmt.Errorf("update issue environment rollup: %w", err)
	}
	if endUserID != nil {
		if _, err := tx.Exec(ctx,
			`INSERT INTO error_group_affected_users
			   (error_group_id,end_user_id,first_seen,last_seen,occurrence_count)
			 VALUES ($1,$2,$3,$3,1)
			 ON CONFLICT (error_group_id,end_user_id) DO UPDATE
			   SET first_seen=LEAST(error_group_affected_users.first_seen,EXCLUDED.first_seen),
			       last_seen=GREATEST(error_group_affected_users.last_seen,EXCLUDED.last_seen),
			       occurrence_count=error_group_affected_users.occurrence_count+1`,
			issueID, *endUserID, timestamp); err != nil {
			return fmt.Errorf("update affected user: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE error_groups g SET affected_users_count=(
			   SELECT count(*) FROM error_group_affected_users u WHERE u.error_group_id=g.id)
			 WHERE g.project_id=$1 AND g.id=$2`, projectID, issueID); err != nil {
			return fmt.Errorf("update affected user count: %w", err)
		}
	}
	return nil
}
