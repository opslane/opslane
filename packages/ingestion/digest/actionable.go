package digest

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/opslane/opslane/packages/ingestion/narrative"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

const (
	reasonSnoozed             = "snoozed"
	reasonErrorLaneIneligible = "error_lane_ineligible"
	reasonNotPublishable      = "not_publishable"
	reasonFrozenLaneOwns      = "frozen_lane_owns"
	reasonCappedOverflow      = "capped_overflow"
	reasonIncluded            = "included"
)

// knownReasonCodes is the closed vocabulary a ledger row may carry. Both
// reconcileActionable and the SLA unknown_reason_code diagnostic derive their
// allowlists from this slice, so adding a reason constant without appending it
// here makes every row carrying it a loud reconciliation finding. That is the
// point: the drift breaks visibly instead of silently.
var knownReasonCodes = []string{
	reasonIncluded, reasonSnoozed, reasonErrorLaneIneligible,
	reasonNotPublishable, reasonFrozenLaneOwns, reasonCappedOverflow,
}

// actionableStatusSQL is the SQL membership list for statuses that require a
// human. digest/sla.go and handler.SnoozeIncident embed the same pair, and the
// migration 064 trigger hardcodes it; a status joining this set must update
// all four sites together.
const actionableStatusSQL = `('awaiting_approval','needs_human')`

// actionableReceiptCap bounds the digest's actionable section: the top
// (cap-1) candidates by impact plus the single oldest waiting item.
const actionableReceiptCap = 5

type actionableCandidate struct {
	GroupID               string
	Kind                  string
	Status                string
	Title                 string
	OccurrenceCount       int64
	ImpactVisits          *int64
	PRURL                 string
	RootCause             string
	Mitigation            string
	HasSavedDiff          bool
	HasValidatedDiagnosis bool
	ActionableSince       *time.Time
	SnoozedUntil          *time.Time
	ErrorLaneEligible     bool
}

type evaluation struct {
	Included   []actionableCandidate
	Excluded   map[string]string
	Overflow   int
	Candidates []actionableCandidate
}

func loadActionableCandidates(ctx context.Context, tx pgx.Tx, projectID string) ([]actionableCandidate, error) {
	query := `
		SELECT g.id::text,g.kind,g.status::text,g.title,g.occurrence_count::bigint,
		       g.impact_visits,COALESCE(g.pr_url,''),COALESCE(g.root_cause,''),
		       COALESCE(g.suggested_mitigation,''),
		       NULLIF(btrim(g.candidate_diff),'') IS NOT NULL,
		       COALESCE(d.has_validated_diagnosis,false),
		       g.actionable_since,g.snoozed_until,
		       COALESCE(g.kind='error' AND (` + pipelineEligibleSQL("g") + `),false)
		  FROM error_groups g
		  LEFT JOIN LATERAL (` + diagnosisValidationLateralSQL + `) d ON true
		 WHERE g.project_id=$1
		   AND g.status IN ` + actionableStatusSQL + `
		 ORDER BY g.actionable_since NULLS LAST,g.id`
	rows, err := tx.Query(ctx, query, projectID)
	if err != nil {
		return nil, fmt.Errorf("load actionable digest candidates: %w", err)
	}
	defer rows.Close()

	candidates := make([]actionableCandidate, 0)
	for rows.Next() {
		var candidate actionableCandidate
		if err := rows.Scan(
			&candidate.GroupID, &candidate.Kind, &candidate.Status, &candidate.Title,
			&candidate.OccurrenceCount, &candidate.ImpactVisits, &candidate.PRURL,
			&candidate.RootCause, &candidate.Mitigation, &candidate.HasSavedDiff,
			&candidate.HasValidatedDiagnosis, &candidate.ActionableSince,
			&candidate.SnoozedUntil, &candidate.ErrorLaneEligible,
		); err != nil {
			return nil, fmt.Errorf("scan actionable digest candidate: %w", err)
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read actionable digest candidates: %w", err)
	}
	return candidates, nil
}

func evaluateActionable(candidates []actionableCandidate, frozenIncidentIDs map[string]bool, now time.Time) evaluation {
	result := evaluation{
		Excluded:   make(map[string]string, len(candidates)),
		Candidates: append([]actionableCandidate(nil), candidates...),
	}
	eligible := make([]actionableCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		switch {
		case candidate.SnoozedUntil != nil && candidate.SnoozedUntil.After(now):
			result.Excluded[candidate.GroupID] = reasonSnoozed
		case candidate.Kind == "error" && !candidate.ErrorLaneEligible:
			result.Excluded[candidate.GroupID] = reasonErrorLaneIneligible
		case !actionablePublishable(candidate):
			result.Excluded[candidate.GroupID] = reasonNotPublishable
		case frozenIncidentIDs[candidate.GroupID]:
			result.Excluded[candidate.GroupID] = reasonFrozenLaneOwns
		default:
			eligible = append(eligible, candidate)
		}
	}

	result.Included, result.Overflow = selectActionable(eligible)
	included := make(map[string]bool, len(result.Included))
	for _, candidate := range result.Included {
		included[candidate.GroupID] = true
	}
	for _, candidate := range eligible {
		if !included[candidate.GroupID] {
			result.Excluded[candidate.GroupID] = reasonCappedOverflow
		}
	}
	return result
}

func actionablePublishable(candidate actionableCandidate) bool {
	item := notify.ReceiptItem{
		ReceiptState:     receiptState(candidate.Status, candidate.HasSavedDiff),
		PRURL:            candidate.PRURL,
		RootCauseExcerpt: narrative.SanitizeExcerpt(candidate.RootCause, excerptMax),
		HasSavedDiff:     candidate.HasSavedDiff,
	}
	return publishable(item, candidate.HasValidatedDiagnosis)
}

func selectActionable(eligible []actionableCandidate) (picked []actionableCandidate, overflow int) {
	byImpact := append([]actionableCandidate(nil), eligible...)
	sort.SliceStable(byImpact, func(i, j int) bool {
		left, right := byImpact[i], byImpact[j]
		if left.ImpactVisits != nil || right.ImpactVisits != nil {
			if left.ImpactVisits == nil {
				return false
			}
			if right.ImpactVisits == nil {
				return true
			}
			if *left.ImpactVisits != *right.ImpactVisits {
				return *left.ImpactVisits > *right.ImpactVisits
			}
		}
		if left.OccurrenceCount != right.OccurrenceCount {
			return left.OccurrenceCount > right.OccurrenceCount
		}
		return left.GroupID < right.GroupID
	})
	if len(byImpact) <= actionableReceiptCap {
		return byImpact, 0
	}

	picked = append(picked, byImpact[:actionableReceiptCap-1]...)
	inPicked := make(map[string]bool, actionableReceiptCap-1)
	for _, candidate := range picked {
		inPicked[candidate.GroupID] = true
	}
	var oldest *actionableCandidate
	for i := range eligible {
		candidate := &eligible[i]
		if inPicked[candidate.GroupID] || candidate.ActionableSince == nil {
			continue
		}
		if oldest == nil || candidate.ActionableSince.Before(*oldest.ActionableSince) ||
			(candidate.ActionableSince.Equal(*oldest.ActionableSince) && candidate.GroupID < oldest.GroupID) {
			copy := *candidate
			oldest = &copy
		}
	}
	if oldest != nil {
		picked = append(picked, *oldest)
	} else {
		picked = append(picked, byImpact[actionableReceiptCap-1])
	}
	return picked, len(eligible) - len(picked)
}

func toReceiptItems(candidates []actionableCandidate) ([]notify.ReceiptItem, error) {
	items := make([]notify.ReceiptItem, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.Kind != "error" && candidate.Kind != "friction" {
			return nil, fmt.Errorf("unsupported actionable kind %q", candidate.Kind)
		}
		if candidate.Status != "awaiting_approval" && candidate.Status != "needs_human" {
			return nil, fmt.Errorf("unsupported actionable status %q", candidate.Status)
		}
		item := notify.ReceiptItem{
			Kind: candidate.Kind, IncidentID: candidate.GroupID,
			Title:           narrative.SanitizeExcerpt(candidate.Title, excerptMax),
			OccurrenceCount: candidate.OccurrenceCount, ImpactVisits: candidate.ImpactVisits,
			ReceiptState: receiptState(candidate.Status, candidate.HasSavedDiff),
			PRURL:        candidate.PRURL, HasSavedDiff: candidate.HasSavedDiff,
			HasValidatedDiagnosis: candidate.HasValidatedDiagnosis,
			ActionableSince:       candidate.ActionableSince,
		}
		if candidate.HasValidatedDiagnosis {
			item.RootCauseExcerpt = narrative.SanitizeExcerpt(candidate.RootCause, excerptMax)
			item.MitigationExcerpt = narrative.SanitizeExcerpt(candidate.Mitigation, excerptMax)
		}
		items = append(items, item)
	}
	return items, nil
}

func writeActionableLedger(ctx context.Context, tx pgx.Tx, runID string, eval evaluation, evaluatedAt time.Time) error {
	type ledgerRow struct {
		groupID string
		outcome string
		reason  string
		details string
	}
	rows := make([]ledgerRow, 0, len(eval.Candidates))
	included := make(map[string]bool, len(eval.Included))
	for _, candidate := range eval.Included {
		included[candidate.GroupID] = true
	}
	for _, candidate := range eval.Candidates {
		outcome, reason := "excluded", eval.Excluded[candidate.GroupID]
		if included[candidate.GroupID] {
			outcome, reason = "included", reasonIncluded
		}
		details, err := json.Marshal(map[string]any{
			"evaluated_at": evaluatedAt.Format(time.RFC3339Nano),
			"kind":         candidate.Kind,
			"status":       candidate.Status,
		})
		if err != nil {
			return fmt.Errorf("encode actionable ledger details: %w", err)
		}
		rows = append(rows, ledgerRow{candidate.GroupID, outcome, reason, string(details)})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].groupID < rows[j].groupID })
	groupIDs, outcomes, reasons, details := make([]string, len(rows)), make([]string, len(rows)), make([]string, len(rows)), make([]string, len(rows))
	for i, row := range rows {
		groupIDs[i], outcomes[i], reasons[i], details[i] = row.groupID, row.outcome, row.reason, row.details
	}
	if len(rows) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO digest_run_candidate_evaluations
		(digest_run_id,error_group_id,outcome,primary_reason_code,details)
		SELECT $1,ids.value::uuid,($3::text[])[ids.ordinality],
		       ($4::text[])[ids.ordinality],(($5::text[])[ids.ordinality])::jsonb
		  FROM unnest($2::text[]) WITH ORDINALITY AS ids(value,ordinality)
		ON CONFLICT (digest_run_id,error_group_id) DO UPDATE SET
		  outcome=EXCLUDED.outcome,
		  primary_reason_code=EXCLUDED.primary_reason_code,
		  details=EXCLUDED.details`, runID, groupIDs, outcomes, reasons, details)
	if err != nil {
		return fmt.Errorf("write actionable candidate ledger: %w", err)
	}
	return nil
}

// reconcileActionable is a tripwire, not an independent invariant check:
// evaluateActionable assigns every candidate a reason from the same
// vocabulary, so under today's code the mismatch branch is unreachable. It
// fires only when a future edit emits a reason missing from
// knownReasonCodes, which is exactly the drift it exists to make loud. Do
// not read a quiet reconcile as proof the selection was correct.
func reconcileActionable(eval evaluation) (string, error) {
	accounted := len(eval.Included)
	allowed := make(map[string]bool, len(knownReasonCodes))
	for _, reason := range knownReasonCodes {
		if reason != reasonIncluded {
			allowed[reason] = true
		}
	}
	for _, reason := range eval.Excluded {
		if allowed[reason] {
			accounted++
		}
	}
	if accounted == len(eval.Candidates) {
		return "", nil
	}
	pending := len(eval.Candidates) - accounted
	if pending < 0 {
		pending = -pending
	}
	alert := fmt.Sprintf("%d items are pending but could not be rendered", pending)
	return alert, fmt.Errorf("actionable candidates=%d accounted=%d", len(eval.Candidates), accounted)
}
