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
	// reasonMissingWaitingAge marks an incident in an actionable status whose
	// actionable_since is NULL. The lifecycle trigger cannot produce that shape,
	// so it means a direct database write: the incident is ledgered (and picked
	// up by the SLA sweep) instead of being frozen without a spell, which sent
	// validation down the episode path with an empty episode id.
	reasonMissingWaitingAge = "missing_waiting_age"
)

// The ON lane's instruction lines. Exactly one is correct for any incident
// state, so the model never owns them: validation stamps the value digestAction
// returns onto the card before it is cached or rendered.
const (
	actionApproveFix          = "Approve the proposed fix."
	actionReviewInvestigation = "Review the investigation."
	actionReviewPR            = "Review the fix PR."
	actionReviewIssue         = "Review the issue."
	// actionReviewDiagnosis is the ask for an incident that reached a verdict
	// and never had a fix attempted. "Review the investigation" implies a fix
	// run the reader could look at; there is none.
	actionReviewDiagnosis = "Review the diagnosis."
)

// digestAction is the single source of an ON card's instruction line. It reads
// only incident state: stored prose (remediation, reason_message) and model
// output never gate it, which is what keeps an incident with an empty
// remediation field from vanishing from the digest. Migration 072's
// error_groups_action_class is its SQL twin; change both together.
func digestAction(status string, hasSavedDiff bool, prURL string, fixAttempted bool) string {
	switch status {
	case "awaiting_approval":
		if hasSavedDiff {
			return actionApproveFix
		}
		return verdictAction(fixAttempted)
	case "pr_created", "pr_draft":
		if prURL != "" {
			return actionReviewPR
		}
		// Inconsistent state: the status says a PR is open and no URL exists.
		// The incident still renders — it still awaits a human — but the
		// caller logs a diagnostic so the inconsistency is visible.
		return actionReviewIssue
	default: // needs_human
		if hasSavedDiff {
			return actionReviewInvestigation
		}
		return verdictAction(fixAttempted)
	}
}

// verdictAction picks between the two asks an incident with no fix artifact can
// honestly make. A saved diff or a completed fix job means there is fix work to
// review; without either, the only thing waiting is the diagnosis.
func verdictAction(fixAttempted bool) string {
	if fixAttempted {
		return actionReviewInvestigation
	}
	return actionReviewDiagnosis
}

// onCardOutcome maps an ON status onto the renderer's two card families, which
// decide the card's button (replay vs review-PR) and its ordering.
func onCardOutcome(status string) string {
	if status == "pr_created" || status == "pr_draft" {
		return "verified_fix"
	}
	return "needs_human"
}

// knownReasonCodes is the closed vocabulary a ledger row may carry. Both
// reconcileActionable and the SLA unknown_reason_code diagnostic derive their
// allowlists from this slice, so adding a reason constant without appending it
// here makes every row carrying it a loud reconciliation finding. That is the
// point: the drift breaks visibly instead of silently.
var knownReasonCodes = []string{
	reasonIncluded, reasonSnoozed, reasonErrorLaneIneligible,
	reasonNotPublishable, reasonFrozenLaneOwns, reasonCappedOverflow,
	reasonMissingWaitingAge,
}

// actionableStatusSet is a SQL fragment spliced into the candidate query. Its
// own type keeps that splice to the two constants below: runtime data cannot
// reach it without an explicit, reviewable conversion.
type actionableStatusSet string

// m1ActionableStatusSQL is the OFF lane's status set: the pair migration 064's
// trigger and the shipped receipts lane were built on. It is deliberately NOT
// widened — OFF mode is the rollback path and must stay byte-identical.
const m1ActionableStatusSQL actionableStatusSet = `('awaiting_approval','needs_human')`

// onCardStatusSQL is the ON lane's status set. PR review is a human action, so
// it repeats until the PR is merged or closed (see docs/design/2026-08-28).
const onCardStatusSQL actionableStatusSet = `('awaiting_approval','needs_human','pr_created','pr_draft')`

// actionableReceiptCap bounds the OFF lane's receipts section: the top
// (cap-1) candidates by impact plus the single oldest waiting item. It is a
// product-era constant, so it stays where it is — OFF is the rollback path and
// must remain byte-identical. The ON card lane passes notify.DigestV4CardCap
// instead, which is the renderer's real Slack-block constraint.
const actionableReceiptCap = 5

type actionableCandidate struct {
	GroupID               string
	Kind                  string
	Status                string
	Title                 string
	OccurrenceCount       int64
	ImpactClass           string
	ImpactVisits          *int64
	ImpactRecovered       *int64
	SessionURL            string
	PRURL                 string
	RootCause             string
	Mitigation            string
	HasSavedDiff          bool
	HasValidatedDiagnosis bool
	// FixAttempted is true only when this incident's terminal fix job is really
	// a fix job. The dead-lettered-investigation reconciliation writes an
	// INVESTIGATION job id into terminal_fix_job_id, so the id alone proves
	// nothing, and an incident that never ran a fix must not be told a fix
	// attempt failed.
	FixAttempted       bool
	ActionableSince    *time.Time
	SnoozedUntil       *time.Time
	ErrorLaneEligible  bool
	SignalType         string
	AffectedUsers      int
	LastSeen           time.Time
	RoutePurpose       string
	DiffIdentity       string
	DiagnosisDecidedAt *time.Time
	Accounts           []string
	Route              string
	SessionCount       int
	IdentifiedCount    int
	ObservationQuote   string
}

type evaluation struct {
	Included   []actionableCandidate
	Excluded   map[string]string
	Overflow   int
	Candidates []actionableCandidate
}

// loadActionableCandidates reads the incidents awaiting a human. statusSQL is
// the caller's status set: m1ActionableStatusSQL in OFF, onCardStatusSQL in ON.
func loadActionableCandidates(ctx context.Context, tx pgx.Tx, projectID string, statusSQL actionableStatusSet) ([]actionableCandidate, error) {
	query := `
		SELECT g.id::text,g.kind,g.status::text,g.title,g.occurrence_count::bigint,
		       COALESCE(g.impact_class,''),g.impact_visits,g.impact_visits_recovered,
		       COALESCE(g.pr_url,''),COALESCE(g.root_cause,''),
		       COALESCE(g.suggested_mitigation,''),
		       NULLIF(btrim(g.candidate_diff),'') IS NOT NULL,
		       COALESCE(d.has_validated_diagnosis,false),
		       ` + fixAttemptedSQL("g") + `,
		       g.actionable_since,g.snoozed_until,
		       COALESCE(g.kind='error' AND (` + pipelineEligibleSQL("g") + `),false),
		       COALESCE(g.signal_type,''),g.affected_users_count,g.last_seen,
		       COALESCE((SELECT rm.purpose FROM route_map rm
		         WHERE rm.project_id=g.project_id
		           AND g.page_url_normalized LIKE '%' || rm.pattern || '%'
		         ORDER BY length(rm.pattern) DESC LIMIT 1),''),
		       md5(COALESCE(g.candidate_diff,'')),d.diagnosis_decided_at,
		       COALESCE((SELECT array_agg(name) FROM (
		         SELECT DISTINCT eu.account_name AS name
		         FROM error_group_affected_users eau JOIN end_users eu ON eu.id=eau.end_user_id
		         WHERE eau.error_group_id=g.id AND eu.project_id=g.project_id
		           AND NULLIF(btrim(eu.account_name),'') IS NOT NULL
		         ORDER BY eu.account_name LIMIT 8) names),'{}'),
		       COALESCE(g.page_url_normalized,''),
		       COALESCE((SELECT COUNT(DISTINCT fs.session_id)::int
		         FROM friction_signals fs
		         WHERE fs.incident_id=g.id AND fs.project_id=g.project_id
		           AND fs.observation_text IS NOT NULL AND fs.signal_type<>'other'
		           AND fs.adjudication_status='accepted'
		           AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
		           AND fs.occurred_at > now() - interval '7 days'),0),
		       COALESCE((SELECT COUNT(DISTINCT fs.end_user_id)::int
		         FROM friction_signals fs
		         WHERE fs.incident_id=g.id AND fs.project_id=g.project_id
		           AND fs.observation_text IS NOT NULL AND fs.signal_type<>'other'
		           AND fs.adjudication_status='accepted'
		           AND fs.end_user_id IS NOT NULL
		           AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
		           AND fs.occurred_at > now() - interval '7 days'),0),
		       COALESCE((SELECT fs.observation_text
		         FROM friction_signals fs
		         WHERE fs.incident_id=g.id AND fs.project_id=g.project_id
		           AND fs.observation_text IS NOT NULL AND fs.signal_type<>'other'
		           AND fs.adjudication_status='accepted'
		           AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
		           AND fs.occurred_at > now() - interval '7 days'
		         ORDER BY fs.occurred_at DESC,fs.id DESC LIMIT 1),'')
		  FROM error_groups g
		  LEFT JOIN LATERAL (` + diagnosisValidationLateralSQL + `) d ON true
		 WHERE g.project_id=$1
		   AND g.status IN ` + string(statusSQL) + `
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
			&candidate.OccurrenceCount, &candidate.ImpactClass, &candidate.ImpactVisits,
			&candidate.ImpactRecovered, &candidate.PRURL,
			&candidate.RootCause, &candidate.Mitigation, &candidate.HasSavedDiff,
			&candidate.HasValidatedDiagnosis, &candidate.FixAttempted, &candidate.ActionableSince,
			&candidate.SnoozedUntil, &candidate.ErrorLaneEligible,
			&candidate.SignalType, &candidate.AffectedUsers, &candidate.LastSeen,
			&candidate.RoutePurpose, &candidate.DiffIdentity, &candidate.DiagnosisDecidedAt,
			&candidate.Accounts,
			&candidate.Route, &candidate.SessionCount, &candidate.IdentifiedCount,
			&candidate.ObservationQuote,
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

	result.Included, result.Overflow = selectActionable(eligible, actionableReceiptCap)
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

// fixAttemptedSQL is the one spelling of "a fix really ran for this incident",
// and it is a call, not a copy. The rule lives in the database function
// error_groups_fix_attempted (migrations 072 and 073), which the lifecycle
// trigger also uses to decide when the waiting age restarts. Two hand-written
// copies of it drifted apart once already, and the drift is invisible until a
// reader's ask changes on a day nothing reset the age.
//
// The function checks the job type, not just the id: reconciling a
// dead-lettered investigation stores that INVESTIGATION job's id in
// terminal_fix_job_id. A NULL id, or one whose job is gone, is false.
func fixAttemptedSQL(groupAlias string) string {
	return fmt.Sprintf(`error_groups_fix_attempted(%[1]s.terminal_fix_job_id, %[1]s.project_id)`, groupAlias)
}

func actionablePublishable(candidate actionableCandidate) bool {
	return onCardEligible(candidate.Status, candidate.PRURL, candidate.RootCause,
		candidate.HasSavedDiff, candidate.HasValidatedDiagnosis, candidate.FixAttempted)
}

// onCardEligible answers "does this incident deserve an authored card?", and
// nothing else. A false answer routes it to its mechanical receipt; it can
// never remove the incident from the digest.
func onCardEligible(status, prURL, rootCause string, hasSavedDiff, hasValidatedDiagnosis, fixAttempted bool) bool {
	item := notify.ReceiptItem{
		ReceiptState:     receiptState(status, hasSavedDiff, fixAttempted),
		PRURL:            prURL,
		RootCauseExcerpt: narrative.SanitizeExcerpt(rootCause, excerptMax),
		HasSavedDiff:     hasSavedDiff,
	}
	return publishable(item, hasValidatedDiagnosis)
}

// selectActionable keeps the top (limit-1) candidates by impact plus the single
// oldest waiting item. The limit belongs to the caller, not to this function:
// the OFF receipts lane keeps actionableReceiptCap while the ON card lane uses
// the renderer's notify.DigestV4CardCap, and the two must not drift into one
// another.
func selectActionable(eligible []actionableCandidate, limit int) (picked []actionableCandidate, overflow int) {
	byImpact := append([]actionableCandidate(nil), eligible...)
	sort.SliceStable(byImpact, func(i, j int) bool {
		return moreImpactfulActionable(byImpact[i], byImpact[j])
	})
	return takeWithOldestWaiter(eligible, byImpact, limit)
}

// moreImpactfulActionable is the digest's impact ordering: recorded visits
// first, then raw occurrences, then the group id so equal rows never reorder
// between runs. Both selectors rank with it, and neither owns it.
func moreImpactfulActionable(left, right actionableCandidate) bool {
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
}

// takeWithOldestWaiter keeps the top (limit-1) of an already ranked list plus
// the single oldest waiting item, so the longest-ignored incident always has a
// slot no matter how it ranks.
func takeWithOldestWaiter(eligible, ranked []actionableCandidate, limit int) ([]actionableCandidate, int) {
	if len(ranked) <= limit {
		return ranked, 0
	}
	picked := append([]actionableCandidate(nil), ranked[:limit-1]...)
	inPicked := make(map[string]bool, limit-1)
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
		picked = append(picked, ranked[limit-1])
	}
	return picked, len(eligible) - len(picked)
}

// selectOnCardEligibleFirst is the ON card lane's selector. The scarce resource
// the cap rations is an authored card, so an incident that can earn one ranks
// above one that can only ever render its mechanical receipt, whatever their
// impact. Within each of those two groups the impact ordering is unchanged, and
// the oldest waiting item still holds its own slot.
//
// The OFF receipts lane keeps selectActionable, where every candidate is
// already publishable and this split would be a no-op.
func selectOnCardEligibleFirst(eligible []actionableCandidate, limit int) ([]actionableCandidate, int) {
	ranked := append([]actionableCandidate(nil), eligible...)
	sort.SliceStable(ranked, func(i, j int) bool {
		left, right := ranked[i], ranked[j]
		leftCard, rightCard := actionablePublishable(left), actionablePublishable(right)
		if leftCard != rightCard {
			return leftCard
		}
		return moreImpactfulActionable(left, right)
	})
	return takeWithOldestWaiter(eligible, ranked, limit)
}

func toReceiptItems(candidates []actionableCandidate) ([]notify.ReceiptItem, error) {
	items := make([]notify.ReceiptItem, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.Kind != "error" && candidate.Kind != "friction" {
			return nil, fmt.Errorf("unsupported actionable kind %q", candidate.Kind)
		}
		switch candidate.Status {
		case "awaiting_approval", "needs_human", "pr_created", "pr_draft":
		default:
			return nil, fmt.Errorf("unsupported actionable status %q", candidate.Status)
		}
		item := notify.ReceiptItem{
			Kind: candidate.Kind, IncidentID: candidate.GroupID,
			Title:           narrative.SanitizeExcerpt(candidate.Title, excerptMax),
			OccurrenceCount: candidate.OccurrenceCount, ImpactClass: candidate.ImpactClass,
			ImpactVisits: candidate.ImpactVisits, ImpactRecovered: candidate.ImpactRecovered,
			ReceiptState: receiptState(candidate.Status, candidate.HasSavedDiff, candidate.FixAttempted),
			PRURL:        candidate.PRURL, SessionURL: candidate.SessionURL, HasSavedDiff: candidate.HasSavedDiff,
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
