package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/opslane/opslane/packages/ingestion/grouping"
	"github.com/opslane/opslane/packages/ingestion/identity"
)

// CaptureReceipt identifies the stored observation and its provisional capture
// bucket. Environment fields preserve the ingest-path metrics contract while
// identity is settled asynchronously.
type CaptureReceipt struct {
	EventID             string
	CaptureHandle       string
	EnvironmentOutcome  EnvironmentOutcome
	EnvironmentDiverged bool
}

// CaptureError stores one observation and schedules its resolution. It creates
// no stable issue, investigation, readiness record, or notification: every
// product decision happens downstream of identity settlement.
func (q *Queries) CaptureError(ctx context.Context, p IngestParams) (*CaptureReceipt, error) {
	if p.Breadcrumbs == "" {
		p.Breadcrumbs = "[]"
	}
	if p.Context == "" {
		p.Context = "{}"
	}
	if p.DebugMeta == "" {
		p.DebugMeta = `{"images":[]}`
	}
	if p.NetworkTimings == "" {
		p.NetworkTimings = "[]"
	}
	if p.Platform == "" {
		p.Platform = "javascript"
	}

	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin capture: %w", err)
	}
	defer tx.Rollback(ctx)

	environmentID, environmentOutcome, environmentDiverged, err := captureEnvironment(ctx, tx, p)
	if err != nil {
		return nil, err
	}

	eventTime := p.EventTime
	if eventTime.IsZero() {
		eventTime = time.Now()
	}

	rawFingerprint := grouping.Fingerprint(p.Platform, p.ErrorType, p.ErrorMessage, p.StackTraceRaw)
	if p.Fingerprint != "" {
		rawFingerprint = p.Fingerprint
	} else if familyFingerprint, ok := grouping.FamilyFingerprint(p.Platform, p.ErrorMessage); ok {
		rawFingerprint = familyFingerprint
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO error_capture_buckets (project_id, raw_fingerprint, identity_version)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (project_id, identity_version, raw_fingerprint)
		 DO UPDATE SET last_seen = now()`,
		p.ProjectID, rawFingerprint, identity.IdentityVersion,
	); err != nil {
		return nil, fmt.Errorf("upsert capture bucket: %w", err)
	}

	endUserID, err := captureEndUser(ctx, tx, p)
	if err != nil {
		return nil, err
	}

	var eventID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO error_events
		   (project_id, environment_id, timestamp, error_type, error_message,
		    stack_trace_raw, breadcrumbs, context, release, session_id, platform,
		    debug_meta, commit_sha, network_timings, end_user_id)
		 VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15)
		 RETURNING id`,
		p.ProjectID, environmentID, eventTime, p.ErrorType, p.ErrorMessage,
		p.StackTraceRaw, p.Breadcrumbs, p.Context, nilIfEmpty(p.Release),
		nilIfEmpty(p.SessionID), p.Platform, p.DebugMeta, nilIfEmpty(p.CommitSHA),
		p.NetworkTimings, endUserID,
	).Scan(&eventID); err != nil {
		return nil, fmt.Errorf("insert captured event: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO error_event_identities
		   (project_id, event_id, status, raw_fingerprint, identity_version)
		 VALUES ($1, $2, 'pending', $3, $4)`,
		p.ProjectID, eventID, rawFingerprint, identity.IdentityVersion,
	); err != nil {
		return nil, fmt.Errorf("insert pending identity: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO error_group_jobs (project_id, event_id, job_type, status)
		 VALUES ($1, $2, 'stack_resolve', 'pending')`,
		p.ProjectID, eventID,
	); err != nil {
		return nil, fmt.Errorf("enqueue stack resolution: %w", err)
	}

	if p.SessionID != "" {
		if _, err := tx.Exec(ctx,
			`UPDATE sessions
			    SET retain_until = GREATEST(
			        COALESCE(retain_until, 'epoch'::timestamptz),
			        now() + make_interval(days => $3))
			  WHERE id = $1 AND project_id = $2`,
			p.SessionID, p.ProjectID, evidencePinDays,
		); err != nil {
			return nil, fmt.Errorf("pin session for evidence: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit capture: %w", err)
	}
	return &CaptureReceipt{
		EventID: eventID, CaptureHandle: rawFingerprint,
		EnvironmentOutcome: environmentOutcome, EnvironmentDiverged: environmentDiverged,
	}, nil
}

func captureEnvironment(ctx context.Context, tx pgx.Tx, p IngestParams) (string, EnvironmentOutcome, bool, error) {
	if p.SessionID != "" {
		var environmentID, environmentName string
		err := tx.QueryRow(ctx, `
			SELECT s.environment_id, e.name
			FROM sessions s
			JOIN environments e ON e.id = s.environment_id AND e.project_id = s.project_id
			WHERE s.id = $1 AND s.project_id = $2 AND s.status <> 'deleting'`,
			p.SessionID, p.ProjectID,
		).Scan(&environmentID, &environmentName)
		if err == nil {
			diverged := p.DefaultEnvironmentID != environmentID
			if p.EnvironmentLabel != "" && environmentNamePattern.MatchString(p.EnvironmentLabel) {
				diverged = p.EnvironmentLabel != environmentName
			}
			return environmentID, EnvironmentOutcomeSession, diverged, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", "", false, fmt.Errorf("read authoritative session environment: %w", err)
		}
	}

	environmentID, outcome, err := resolveEnvironmentTx(
		ctx, tx, p.ProjectID, p.DefaultEnvironmentID, p.EnvironmentLabel,
	)
	if err != nil {
		return "", "", false, fmt.Errorf("resolve capture environment: %w", err)
	}
	return environmentID, outcome, false, nil
}

func captureEndUser(ctx context.Context, tx pgx.Tx, p IngestParams) (*string, error) {
	if p.EndUserID == "" {
		return nil, nil
	}
	var id string
	if err := tx.QueryRow(ctx,
		`INSERT INTO end_users
		   (project_id, external_user_id, external_account_id, email, account_name, first_seen, last_seen)
		 VALUES ($1, $2, $3, $4, $5, now(), now())
		 ON CONFLICT (project_id, external_user_id) DO UPDATE
		   SET last_seen = now(),
		       email = COALESCE(NULLIF($4, ''), end_users.email),
		       external_account_id = COALESCE(NULLIF($3, ''), end_users.external_account_id),
		       account_name = COALESCE(NULLIF($5, ''), end_users.account_name)
		 RETURNING id`,
		p.ProjectID, p.EndUserID, nilIfEmpty(p.EndUserAccountID),
		nilIfEmpty(p.EndUserEmail), nilIfEmpty(p.EndUserAccountName),
	).Scan(&id); err != nil {
		return nil, fmt.Errorf("upsert captured end user: %w", err)
	}
	return &id, nil
}
