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
	ErrorGroupID          string            `json:"errorGroupId"`
	EpisodeID             string            `json:"episodeId,omitempty"`
	EpisodeSequence       *int              `json:"episodeSequence,omitempty"`
	Kind                  string            `json:"kind"`
	SpellStartedAt        *time.Time        `json:"spellStartedAt,omitempty"`
	Fingerprint           string            `json:"fingerprint,omitempty"`
	CachedCard            *CachedDigestCard `json:"cachedCard,omitempty"`
	HasValidatedDiagnosis bool              `json:"hasValidatedDiagnosis,omitempty"`
	Label                 string            `json:"label"`
	// IssueID remains during the rolling transition for workers that predate
	// incident-keyed cards. New consumers use ErrorGroupID.
	IssueID         string    `json:"issueId"`
	Title           string    `json:"title"`
	Outcome         string    `json:"outcome"`
	Status          string    `json:"status,omitempty"`
	SignalType      string    `json:"signalType,omitempty"`
	Summary         string    `json:"summary"`
	RootCause       string    `json:"rootCause,omitempty"`
	Mitigation      string    `json:"mitigation,omitempty"`
	DiffIdentity    string    `json:"diffIdentity,omitempty"`
	PRURL           string    `json:"prUrl,omitempty"`
	AffectedUsers   int       `json:"affectedUsers"`
	OccurrenceCount int       `json:"occurrenceCount"`
	Accounts        []string  `json:"accounts"`
	LastSeen        time.Time `json:"lastSeen"`
	RoutePurpose    string    `json:"routePurpose,omitempty"`
	DecidedAt       time.Time `json:"decidedAt"`
	ReplaySessionID string    `json:"replaySessionId,omitempty"`
	ReplayAnchorMs  int64     `json:"replayAnchorMs,omitempty"`
	// ValidAction is the reader-facing follow-up the card must offer. In ON it
	// is digestAction's output and nothing else; validation stamps it back onto
	// whatever the model wrote. In OFF it remains the remediation-derived text.
	ValidAction string `json:"validAction"`
	// HasSavedDiff is the exact fact digestAction reads, carried explicitly so
	// the action never has to be reconstructed from a diff hash.
	HasSavedDiff bool `json:"hasSavedDiff,omitempty"`
	// NotCardEligible marks a candidate publishable() refuses an authored card.
	// Inverted so the zero value means eligible: OFF snapshots and snapshots
	// frozen before this field existed keep their meaning. The writer defers
	// these mechanically, so a never-eligible incident costs no model call and
	// still renders its receipt.
	NotCardEligible  bool   `json:"notCardEligible,omitempty"`
	FrictionCategory string `json:"frictionCategory,omitempty"`
	Route            string `json:"route,omitempty"`
	SessionCount     int    `json:"sessionCount,omitempty"`
	IdentifiedCount  int    `json:"identifiedCount,omitempty"`
	ObservationQuote string `json:"observationQuote,omitempty"`
}

// FreezeCandidates selects publishable work and stores the exact facts before
// a model runs. Repeated and concurrent calls for one project-local day reuse
// the existing run and its snapshots.
func FreezeCandidates(ctx context.Context, pool *pgxpool.Pool, projectID string, at time.Time) (string, []Candidate, error) {
	configuredMode := ReadUnifiedCardsMode()
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
		INSERT INTO digest_runs (project_id,window_from,window_to,run_date,status,unified_cards_mode)
		VALUES ($1,$2,$3,$4,'frozen',$5)
		ON CONFLICT (project_id,run_date) DO NOTHING
		RETURNING id::text`, projectID, windowFrom, at, runDate, configuredMode).Scan(&runID)
	switch {
	case err == nil:
		inserted = true
	case err == pgx.ErrNoRows:
		if err := tx.QueryRow(ctx, `
			SELECT id::text,unified_cards_mode FROM digest_runs WHERE project_id=$1 AND run_date=$2`,
			projectID, runDate).Scan(&runID, &configuredMode); err != nil {
			return "", nil, fmt.Errorf("reuse digest run: %w", err)
		}
	default:
		return "", nil, fmt.Errorf("insert digest run: %w", err)
	}

	if inserted {
		// One lane, chosen by mode. ON reads status alone; the episode/one-shot
		// lane — with its issue_publications gate and its remediation-derived
		// action — runs only in OFF, which is the rollback path.
		var candidates []Candidate
		var replayFloors []time.Time
		var actionableCandidates []actionableCandidate
		var unifiedExcluded map[string]string
		if configuredMode == UnifiedCardsOff {
			candidates, replayFloors, err = selectCandidates(ctx, tx, projectID, at, windowFrom)
			if err != nil {
				return "", nil, err
			}
		} else {
			actionableCandidates, err = loadActionableCandidates(ctx, tx, projectID, onCardStatusSQL)
			if err != nil {
				return "", nil, err
			}
			candidates, replayFloors, unifiedExcluded = selectOnCardCandidates(actionableCandidates, at)
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
			if configuredMode != UnifiedCardsOff {
				if err := attachCachedCard(ctx, tx, projectID, &candidate); err != nil {
					return "", nil, err
				}
			}
			candidates[i] = candidate
			snapshot, err := json.Marshal(candidate)
			if err != nil {
				return "", nil, fmt.Errorf("marshal candidate %s: %w", candidate.EpisodeID, err)
			}
			var insertSQL string
			var insertArgs []any
			if candidate.EpisodeID == "" {
				insertSQL = `INSERT INTO digest_unified_run_items
					(project_id,run_id,error_group_id,candidate_snapshot) VALUES ($1,$2,$3,$4::jsonb)`
				insertArgs = []any{projectID, runID, candidate.ErrorGroupID, snapshot}
			} else {
				insertSQL = `INSERT INTO digest_run_items
					(project_id,run_id,episode_id,error_group_id,candidate_snapshot) VALUES ($1,$2,$3,$4,$5::jsonb)`
				insertArgs = []any{projectID, runID, candidate.EpisodeID, candidate.ErrorGroupID, snapshot}
			}
			if _, err := tx.Exec(ctx, insertSQL, insertArgs...); err != nil {
				return "", nil, fmt.Errorf("freeze candidate %s: %w", candidate.EpisodeID, err)
			}
		}
		if configuredMode != UnifiedCardsOff {
			if err := writeUnifiedFreezeLedger(ctx, tx, runID, configuredMode,
				actionableCandidates, candidates, unifiedExcluded, at); err != nil {
				return "", nil, err
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

// selectCandidates is the OFF lane only: the episode/one-shot path, gated by
// issue_publications so a card shows once. ON never calls it.
func selectCandidates(ctx context.Context, q digestQuerier, projectID string, at, windowFrom time.Time) ([]Candidate, []time.Time, error) {
	rows, err := q.Query(ctx, `
		SELECT ep.id::text, ep.sequence, g.id::text, g.title,
		       d.outcome, d.decision_reason,
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
		       d.decided_at, action.text,g.status::text,COALESCE(g.signal_type,''),
		       COALESCE(g.root_cause,''),COALESCE(g.suggested_mitigation,''),
		       md5(COALESCE(g.candidate_diff,'')),g.actionable_since,
		       COALESCE((SELECT max(prev.closed_at)
		                   FROM issue_episodes prev
		                  WHERE prev.project_id=ep.project_id
		                    AND prev.canonical_issue_id=ep.canonical_issue_id
		                    AND prev.id<>ep.id), 'epoch'::timestamptz) AS replay_floor,
		       validity.has_validated_diagnosis
		  FROM issue_episodes ep
		  -- kind='error' matches the filter sweep, which no longer evaluates
	  -- friction episodes; without this guard a friction episode with
	  -- historical decisions would stay frozen-eligible on facts that can
	  -- never refresh. Friction reaches the digest through the actionable
	  -- receipts lane instead.
	  JOIN error_groups g ON g.id=ep.canonical_issue_id AND g.project_id=ep.project_id AND g.kind='error'
		  LEFT JOIN LATERAL (`+diagnosisValidationLateralSQL+`) validity ON true
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
		var episodeSequence int
		var replayFloor time.Time
		if err := rows.Scan(
			&candidate.EpisodeID, &episodeSequence, &candidate.IssueID,
			&candidate.Title, &candidate.Outcome, &candidate.Summary, &candidate.PRURL, &candidate.OccurrenceCount,
			&candidate.AffectedUsers, &candidate.Accounts, &candidate.LastSeen,
			&candidate.RoutePurpose, &candidate.DecidedAt, &candidate.ValidAction,
			&candidate.Status, &candidate.SignalType, &candidate.RootCause, &candidate.Mitigation,
			&candidate.DiffIdentity, &candidate.SpellStartedAt, &replayFloor,
			&candidate.HasValidatedDiagnosis,
		); err != nil {
			return nil, nil, fmt.Errorf("scan digest candidate: %w", err)
		}
		candidate.ErrorGroupID = candidate.IssueID
		candidate.Kind = "error"
		candidate.EpisodeSequence = &episodeSequence
		// No per-group dedup here: OFF is the rollback path and returns one
		// candidate per eligible EPISODE, exactly as origin/main does. The ON
		// lane is keyed per incident by loadActionableCandidates and never
		// reaches this query.
		candidate.Label = "new"
		if episodeSequence > 1 {
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
		SELECT candidate_snapshot FROM (
		  SELECT candidate_snapshot,COALESCE(error_group_id,episode_id) AS identity
		    FROM digest_run_items WHERE project_id=$1 AND run_id=$2
		  UNION ALL
		  SELECT candidate_snapshot,error_group_id AS identity
		    FROM digest_unified_run_items WHERE project_id=$1 AND run_id=$2
		) frozen ORDER BY identity`, projectID, runID)
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
