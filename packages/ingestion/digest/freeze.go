package digest

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
	IssueID         string `json:"issueId"`
	Title           string `json:"title"`
	Outcome         string `json:"outcome"`
	Status          string `json:"status,omitempty"`
	SignalType      string `json:"signalType,omitempty"`
	Summary         string `json:"summary"`
	RootCause       string `json:"rootCause,omitempty"`
	Mitigation      string `json:"mitigation,omitempty"`
	DiffIdentity    string `json:"diffIdentity,omitempty"`
	PRURL           string `json:"prUrl,omitempty"`
	AffectedUsers   int    `json:"affectedUsers"`
	OccurrenceCount int    `json:"occurrenceCount"`
	// ImpactVisits and ImpactRecovered are the measured recording impact: how
	// many visits hit the problem and how many got past it. The writer never
	// sees them as usable numbers — validation stamps them onto the rendered
	// card and the message prints them mechanically. Deliberately absent from
	// the fingerprint: they roll every day and must not retire a cached card.
	ImpactVisits    *int64    `json:"impactVisits,omitempty"`
	ImpactRecovered *int64    `json:"impactRecovered,omitempty"`
	Accounts        []string  `json:"accounts"`
	LastSeen        time.Time `json:"lastSeen"`
	RoutePurpose    string    `json:"routePurpose,omitempty"`
	DecidedAt       time.Time `json:"decidedAt"`
	ReplaySessionID string    `json:"replaySessionId,omitempty"`
	ReplayAnchorMs  int64     `json:"replayAnchorMs,omitempty"`
	// ValidAction is the reader-facing follow-up the card must offer. It is
	// digestAction's output and nothing else; validation stamps it back onto
	// whatever the model wrote. Snapshots frozen under the retired OFF switch
	// instead carry the remediation-derived text they were frozen with.
	ValidAction string `json:"validAction"`
	// HasSavedDiff is the exact fact digestAction reads, carried explicitly so
	// the action never has to be reconstructed from a diff hash.
	HasSavedDiff bool `json:"hasSavedDiff,omitempty"`
	// FixAttempted says a real fix job ran for this incident. It separates a
	// fix run that produced nothing from a verdict nobody ever tried to fix,
	// which look identical in status and diff. Absent on snapshots frozen
	// before it existed, so those keep reading as "no attempt".
	FixAttempted bool `json:"fixAttempted,omitempty"`
	// NotCardEligible marks a candidate publishable() refuses an authored card.
	// Inverted so the zero value means eligible: OFF snapshots and snapshots
	// frozen before this field existed keep their meaning. The writer defers
	// these mechanically, so a never-eligible incident costs no model call and
	// still renders its receipt.
	//
	// This is a freeze-time signal for skipping the model call, and nothing
	// else. How the receipt renders is decided at validation from the live row,
	// because an incident can acquire a validated diagnosis overnight and its
	// receipt must then show the cause instead of compacting to one line.
	NotCardEligible  bool   `json:"notCardEligible,omitempty"`
	FrictionCategory string `json:"frictionCategory,omitempty"`
	Route            string `json:"route,omitempty"`
	SessionCount     int    `json:"sessionCount,omitempty"`
	IdentifiedCount  int    `json:"identifiedCount,omitempty"`
	ObservationQuote string `json:"observationQuote,omitempty"`
}

// UnifiedCardsMode is stamped on every digest run. New runs are always
// unified; the constants survive so runs frozen before the operator switch
// was removed rehydrate exactly as they ran.
type UnifiedCardsMode string

const (
	UnifiedCardsOff UnifiedCardsMode = "off"
	UnifiedCardsOn  UnifiedCardsMode = "on"
)

// FreezeCandidates selects publishable work and stores the exact facts before
// a model runs. Repeated and concurrent calls for one project-local day reuse
// the existing run and its snapshots.
func FreezeCandidates(ctx context.Context, pool *pgxpool.Pool, projectID string, at time.Time) (string, []Candidate, error) {
	// Every new run is unified. Reusing an existing run below still adopts
	// that run's stored mode, so a day frozen under the old switch keeps its
	// meaning.
	configuredMode := UnifiedCardsOn
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
		var candidates []Candidate
		var replayFloors []time.Time
		var actionableCandidates []actionableCandidate
		var unifiedExcluded map[string]string
		actionableCandidates, err = loadActionableCandidates(ctx, tx, projectID, onCardStatusSQL)
		if err != nil {
			return "", nil, err
		}
		candidates, replayFloors, unifiedExcluded = selectOnCardCandidates(actionableCandidates, at)
		for i, candidate := range candidates {
			replayFloor := replayFloors[i]
			// The lookup runs under a savepoint: a server-side SQL error would
			// otherwise abort the whole freeze transaction, and the very next
			// snapshot INSERT would fail with "current transaction is aborted" —
			// making the warn-and-continue fallback below a lie for exactly the
			// database errors it exists to survive.
			if _, err := tx.Exec(ctx, `SAVEPOINT digest_replay_lookup`); err != nil {
				return "", nil, fmt.Errorf("open replay lookup savepoint: %w", err)
			}
			if id, anchor, ok, lookupErr := watchableSessionAnySpell(ctx, tx, candidate.IssueID, projectID, replayFloor); lookupErr != nil {
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
			if err := attachCachedCard(ctx, tx, projectID, &candidate); err != nil {
				return "", nil, err
			}
			candidates[i] = candidate
			snapshot, err := json.Marshal(candidate)
			if err != nil {
				return "", nil, fmt.Errorf("marshal candidate %s: %w", candidate.ErrorGroupID, err)
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
				return "", nil, fmt.Errorf("freeze candidate %s: %w", candidate.ErrorGroupID, err)
			}
		}
		if err := writeUnifiedFreezeLedger(ctx, tx, runID, configuredMode,
			actionableCandidates, candidates, unifiedExcluded, at); err != nil {
			return "", nil, err
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
