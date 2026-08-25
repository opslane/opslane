package digest

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	ingestiondb "github.com/opslane/opslane/packages/ingestion/db"
)

// Candidate is the immutable fact envelope supplied to the daily writer.
// Facts omitted here are unavailable to the model by design.
type Candidate struct {
	EpisodeID       string    `json:"episodeId"`
	EpisodeSequence int       `json:"episodeSequence"`
	Label           string    `json:"label"`
	IssueID         string    `json:"issueId"`
	Title           string    `json:"title"`
	Outcome         string    `json:"outcome"`
	Summary         string    `json:"summary"`
	PRURL           string    `json:"prUrl,omitempty"`
	AffectedUsers   int       `json:"affectedUsers"`
	OccurrenceCount int       `json:"occurrenceCount"`
	Accounts        []string  `json:"accounts"`
	LastSeen        time.Time `json:"lastSeen"`
	RoutePurpose    string    `json:"routePurpose,omitempty"`
	DecidedAt       time.Time `json:"decidedAt"`
	ReplaySessionID string    `json:"replaySessionId,omitempty"`
	ReplayAnchorMs  int64     `json:"replayAnchorMs,omitempty"`
	// ValidAction is the reader-facing follow-up the card must offer: the
	// investigator's remediation for needs_human, the PR review for a
	// verified fix. A candidate with no derivable action is not useful and
	// never freezes.
	ValidAction string `json:"validAction"`
}

// FreezeCandidates selects publishable work and stores the exact facts before
// a model runs. Repeated and concurrent calls for one project-local day reuse
// the existing run and its snapshots.
func FreezeCandidates(ctx context.Context, pool *pgxpool.Pool, projectID string, at time.Time) (string, []Candidate, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", nil, fmt.Errorf("begin digest freeze: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var timezone string
	if err := tx.QueryRow(ctx, `SELECT digest_timezone FROM projects WHERE id=$1`, projectID).Scan(&timezone); err != nil {
		return "", nil, fmt.Errorf("load digest timezone: %w", err)
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return "", nil, fmt.Errorf("invalid digest timezone %q: %w", timezone, err)
	}
	runDate := at.In(location).Format("2006-01-02")

	var windowFrom time.Time
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(max(window_to) FILTER (WHERE status='delivered'), $2::timestamptz - interval '24 hours')
		  FROM digest_runs WHERE project_id=$1 AND window_to < $2`, projectID, at,
	).Scan(&windowFrom); err != nil {
		return "", nil, fmt.Errorf("load digest watermark: %w", err)
	}

	var runID string
	inserted := false
	err = tx.QueryRow(ctx, `
		INSERT INTO digest_runs (project_id,window_from,window_to,run_date,status)
		VALUES ($1,$2,$3,$4,'frozen')
		ON CONFLICT (project_id,run_date) DO NOTHING
		RETURNING id::text`, projectID, windowFrom, at, runDate).Scan(&runID)
	switch {
	case err == nil:
		inserted = true
	case err == pgx.ErrNoRows:
		if err := tx.QueryRow(ctx, `
			SELECT id::text FROM digest_runs WHERE project_id=$1 AND run_date=$2`,
			projectID, runDate).Scan(&runID); err != nil {
			return "", nil, fmt.Errorf("reuse digest run: %w", err)
		}
	default:
		return "", nil, fmt.Errorf("insert digest run: %w", err)
	}

	if inserted {
		candidates, replayFloors, err := selectCandidates(ctx, tx, projectID, at, windowFrom)
		if err != nil {
			return "", nil, err
		}
		for i, candidate := range candidates {
			replayFloor := replayFloors[i]
			if replayFloor.Equal(time.Unix(0, 0).UTC()) {
				replayFloor = time.Time{}
			}
			// The lookup runs under a savepoint: a server-side SQL error would
			// otherwise abort the whole freeze transaction, and the very next
			// snapshot INSERT would fail with "current transaction is aborted" —
			// making the warn-and-continue fallback below a lie for exactly the
			// database errors it exists to survive.
			if _, err := tx.Exec(ctx, `SAVEPOINT digest_replay_lookup`); err != nil {
				return "", nil, fmt.Errorf("open replay lookup savepoint: %w", err)
			}
			if id, anchor, ok, lookupErr := ingestiondb.WatchableSessionForGroupOn(ctx, tx, candidate.IssueID, projectID, replayFloor); lookupErr != nil {
				slog.Warn("digest replay lookup failed; freezing without replay", "group_id", candidate.IssueID, "error", lookupErr)
				if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT digest_replay_lookup`); err != nil {
					return "", nil, fmt.Errorf("roll back replay lookup savepoint: %w", err)
				}
			} else if ok {
				candidate.ReplaySessionID = id
				candidate.ReplayAnchorMs = anchor
			}
			if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT digest_replay_lookup`); err != nil {
				return "", nil, fmt.Errorf("release replay lookup savepoint: %w", err)
			}
			snapshot, err := json.Marshal(candidate)
			if err != nil {
				return "", nil, fmt.Errorf("marshal candidate %s: %w", candidate.EpisodeID, err)
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO digest_run_items (project_id,run_id,episode_id,candidate_snapshot)
				VALUES ($1,$2,$3,$4::jsonb)`, projectID, runID, candidate.EpisodeID, snapshot); err != nil {
				return "", nil, fmt.Errorf("freeze candidate %s: %w", candidate.EpisodeID, err)
			}
		}
	}

	candidates, err := loadFrozenCandidates(ctx, tx, projectID, runID)
	if err != nil {
		return "", nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", nil, fmt.Errorf("commit digest freeze: %w", err)
	}
	return runID, candidates, nil
}

type digestQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func selectCandidates(ctx context.Context, q digestQuerier, projectID string, at, windowFrom time.Time) ([]Candidate, []time.Time, error) {
	rows, err := q.Query(ctx, `
		SELECT ep.id::text, ep.sequence, g.id::text, g.title,
		       d.outcome, COALESCE(NULLIF(btrim(d.diagnosis->>'summary'),''), d.decision_reason),
		       COALESCE(g.pr_url,''), g.occurrence_count,
		       (SELECT count(DISTINCT eau.end_user_id)::int
		          FROM error_group_affected_users eau
		          JOIN end_users eu ON eu.id=eau.end_user_id AND eu.project_id=ep.project_id
		         WHERE eau.error_group_id=g.id),
		       COALESCE((SELECT array_agg(name) FROM (
		          SELECT DISTINCT eu.account_name AS name
		            FROM error_group_affected_users eau
		            JOIN end_users eu ON eu.id=eau.end_user_id AND eu.project_id=ep.project_id
		           WHERE eau.error_group_id=g.id AND NULLIF(btrim(eu.account_name),'') IS NOT NULL
		           ORDER BY eu.account_name
		           -- Bounded: the names feed a model prompt and one Slack context
		           -- line; a group touching thousands of named accounts must not
		           -- balloon the frozen snapshot or the prompt.
		           LIMIT 8) capped), '{}'),
		       g.last_seen,
		       COALESCE((SELECT rm.purpose FROM route_map rm
		                  WHERE rm.project_id=ep.project_id
		                    AND g.page_url_normalized LIKE '%' || rm.pattern || '%'
		                  ORDER BY length(rm.pattern) DESC LIMIT 1),''),
		       d.decided_at, action.text,
		       COALESCE((SELECT max(prev.closed_at)
		                   FROM issue_episodes prev
		                  WHERE prev.project_id=ep.project_id
		                    AND prev.canonical_issue_id=ep.canonical_issue_id
		                    AND prev.id<>ep.id), 'epoch'::timestamptz) AS replay_floor
		  FROM issue_episodes ep
		  JOIN error_groups g ON g.id=ep.canonical_issue_id AND g.project_id=ep.project_id
		  JOIN LATERAL (
		    SELECT dd.outcome,dd.decision_reason,dd.diagnosis,dd.decided_at
		      FROM diagnosis_decisions dd
		     WHERE dd.project_id=ep.project_id AND dd.episode_id=ep.id
		     ORDER BY dd.decided_at DESC,dd.id DESC LIMIT 1
		  ) d ON true
		  JOIN LATERAL (
		    SELECT idq.decision FROM issue_inquiry_decisions idq
		     WHERE idq.project_id=ep.project_id AND idq.episode_id=ep.id
		     ORDER BY idq.decided_at DESC,idq.id DESC LIMIT 1
		  ) inquiry ON true
		  JOIN LATERAL (
		    SELECT CASE
		      WHEN d.outcome='verified_fix' AND COALESCE(g.pr_url,'')<>'' THEN 'Review the fix PR.'
		      ELSE COALESCE(NULLIF(btrim(g.remediation),''), NULLIF(btrim(g.reason_message),''), '')
		    END AS text
		  ) action ON true
		 WHERE ep.project_id=$1
		   AND ep.closed_at IS NULL
		   AND inquiry.decision='investigate'
		   AND d.outcome IN ('verified_fix','needs_human')
		   AND action.text <> ''
		   AND (g.last_seen >= $2::timestamptz - interval '7 days' OR d.decided_at >= $3::timestamptz)
		   AND (d.decided_at >= $3::timestamptz OR EXISTS (
		         SELECT 1 FROM digest_run_items old
		          WHERE old.project_id=ep.project_id AND old.episode_id=ep.id
		            AND old.outcome='deferred'))
		   AND NOT EXISTS (
		         SELECT 1 FROM issue_publications publication
		          WHERE publication.project_id=ep.project_id
		            AND publication.episode_id=ep.id AND publication.channel='digest')
		 ORDER BY g.last_seen DESC,ep.id`, projectID, at, windowFrom)
	if err != nil {
		return nil, nil, fmt.Errorf("select digest candidates: %w", err)
	}
	defer rows.Close()
	candidates := make([]Candidate, 0)
	replayFloors := make([]time.Time, 0)
	for rows.Next() {
		var candidate Candidate
		var replayFloor time.Time
		if err := rows.Scan(
			&candidate.EpisodeID, &candidate.EpisodeSequence, &candidate.IssueID,
			&candidate.Title, &candidate.Outcome, &candidate.Summary, &candidate.PRURL, &candidate.OccurrenceCount,
			&candidate.AffectedUsers, &candidate.Accounts, &candidate.LastSeen,
			&candidate.RoutePurpose, &candidate.DecidedAt, &candidate.ValidAction, &replayFloor,
		); err != nil {
			return nil, nil, fmt.Errorf("scan digest candidate: %w", err)
		}
		candidate.Label = "new"
		if candidate.EpisodeSequence > 1 {
			candidate.Label = "returned"
		}
		candidates = append(candidates, candidate)
		replayFloors = append(replayFloors, replayFloor)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("read digest candidates: %w", err)
	}
	return candidates, replayFloors, nil
}

func loadFrozenCandidates(ctx context.Context, q digestQuerier, projectID, runID string) ([]Candidate, error) {
	rows, err := q.Query(ctx, `
		SELECT candidate_snapshot FROM digest_run_items
		 WHERE project_id=$1 AND run_id=$2 ORDER BY episode_id`, projectID, runID)
	if err != nil {
		return nil, fmt.Errorf("load frozen candidates: %w", err)
	}
	defer rows.Close()
	candidates := make([]Candidate, 0)
	for rows.Next() {
		var snapshot []byte
		if err := rows.Scan(&snapshot); err != nil {
			return nil, fmt.Errorf("scan frozen candidate: %w", err)
		}
		var candidate Candidate
		if len(snapshot) == 0 {
			return nil, fmt.Errorf("digest run %s contains an item without a frozen snapshot", runID)
		}
		if err := json.Unmarshal(snapshot, &candidate); err != nil {
			return nil, fmt.Errorf("decode frozen candidate: %w", err)
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read frozen candidates: %w", err)
	}
	return candidates, nil
}
