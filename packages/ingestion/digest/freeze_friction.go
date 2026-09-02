package digest

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

// selectOnCardCandidates is the ON lane, and the only one. Every incident that
// awaits a human action becomes a candidate; nothing but a snooze or the cap
// can remove it. publishable() decides whether it gets an authored card or its
// mechanical receipt (NotCardEligible), never whether it appears at all — that
// split is what closes the "actionable error vanished" defect.
//
// The returned map holds the ledger reason for every candidate that did not
// make the cut, so the freeze ledger accounts for all of them.
func selectOnCardCandidates(all []actionableCandidate, at time.Time) ([]Candidate, []time.Time, map[string]string) {
	excluded := make(map[string]string, len(all))
	eligible := make([]actionableCandidate, 0, len(all))
	for _, source := range all {
		if source.SnoozedUntil != nil && source.SnoozedUntil.After(at) {
			excluded[source.GroupID] = reasonSnoozed
			continue
		}
		if source.ActionableSince == nil {
			// Freezing this would produce a candidate with no spell, which
			// validation reads as an episode candidate and queries by an empty
			// episode id — an infrastructure error that degrades the whole card
			// section for one malformed row. Ledger it and move on; the SLA
			// sweep reports it as an omitted actionable incident.
			slog.Warn("actionable incident has no waiting age; excluded from the card lane",
				"diagnostic", "missing_actionable_since",
				"error_group_id", source.GroupID, "status", source.Status)
			excluded[source.GroupID] = reasonMissingWaitingAge
			continue
		}
		eligible = append(eligible, source)
	}
	// The ON lane's bound is the renderer's real Slack-block constraint, not the
	// OFF receipts lane's product-era five: capping lower would hide waiting
	// incidents the message has room for. Its ranking is eligibility first: the
	// cap rations authored cards, so a diagnosed incident that can earn one is
	// worth more of that budget than a louder incident that can only ever render
	// a mechanical receipt.
	selected, _ := selectOnCardEligibleFirst(eligible, notify.DigestV4CardCap)
	picked := make(map[string]bool, len(selected))
	for _, source := range selected {
		picked[source.GroupID] = true
	}
	for _, source := range eligible {
		if !picked[source.GroupID] {
			excluded[source.GroupID] = reasonCappedOverflow
		}
	}

	candidates := make([]Candidate, 0, len(selected))
	floors := make([]time.Time, 0, len(selected))
	for _, source := range selected {
		summary := source.RootCause
		if summary == "" {
			summary = source.Title
		}
		decidedAt := source.LastSeen
		if source.DiagnosisDecidedAt != nil {
			decidedAt = *source.DiagnosisDecidedAt
		}
		action := digestAction(source.Status, source.HasSavedDiff, source.PRURL)
		if action == actionReviewIssue {
			slog.Warn("digest card renders an inconsistent PR state",
				"diagnostic", "pr_status_without_url",
				"error_group_id", source.GroupID, "status", source.Status)
		}
		candidate := Candidate{
			ErrorGroupID: source.GroupID, IssueID: source.GroupID, Kind: source.Kind,
			Title: source.Title, Outcome: onCardOutcome(source.Status), Status: source.Status,
			SignalType: source.SignalType, Summary: summary, RootCause: source.RootCause,
			Mitigation: source.Mitigation, DiffIdentity: source.DiffIdentity,
			HasSavedDiff: source.HasSavedDiff, PRURL: source.PRURL,
			AffectedUsers: source.AffectedUsers, OccurrenceCount: int(source.OccurrenceCount),
			ImpactVisits: source.ImpactVisits, ImpactRecovered: source.ImpactRecovered,
			Accounts: source.Accounts, LastSeen: source.LastSeen, RoutePurpose: source.RoutePurpose,
			DecidedAt: decidedAt, ValidAction: action, SpellStartedAt: source.ActionableSince,
			HasValidatedDiagnosis: source.HasValidatedDiagnosis, Label: "new",
			NotCardEligible: !actionablePublishable(source),
		}
		if source.ObservationQuote != "" {
			candidate.FrictionCategory = source.SignalType
			candidate.Route = source.Route
			candidate.SessionCount = source.SessionCount
			candidate.IdentifiedCount = source.IdentifiedCount
			candidate.ObservationQuote = source.ObservationQuote
		}
		candidate.Fingerprint = candidateFingerprint(candidate, digestPromptVersion, digestValidatorVersion)
		candidates = append(candidates, candidate)
		// Bound the replay lookup by the current actionable spell, exactly as
		// validation's receipt enrichment does: an unbounded floor sorts the
		// group's whole event history inside the freeze transaction, and a
		// recording from an earlier spell is stale anyway. ActionableSince is
		// non-nil for every selected candidate — the nil case was excluded above.
		floors = append(floors, *source.ActionableSince)
	}
	return candidates, floors, excluded
}

func attachCachedCard(ctx context.Context, tx pgx.Tx, projectID string, candidate *Candidate) error {
	if candidate.SpellStartedAt == nil || candidate.Fingerprint == "" {
		return nil
	}
	var cached CachedDigestCard
	err := tx.QueryRow(ctx, `SELECT c.title,c.copy,c.action,c.authored_at,c.input_fingerprint
		FROM digest_card_copy c JOIN error_groups g ON g.id=c.error_group_id
		WHERE g.project_id=$1 AND c.error_group_id=$2 AND c.spell_started_at=$3
		  AND c.invalidated_at IS NULL AND c.input_fingerprint=$4`, projectID,
		candidate.ErrorGroupID, *candidate.SpellStartedAt, candidate.Fingerprint).Scan(
		&cached.Title, &cached.Copy, &cached.Action, &cached.AuthoredAt, &cached.Fingerprint,
	)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load digest card cache for %s: %w", candidate.ErrorGroupID, err)
	}
	candidate.CachedCard = &cached
	return nil
}

// writeUnifiedFreezeLedger records one row per considered incident. In ON every
// candidate is accounted for: included, or excluded with the reason
// selectOnCardCandidates assigned. A candidate that can never earn an authored
// card is stamped receipt_fallback here, at freeze, so no model call is spent
// on it — and its ledger reason distinguishes that from a card that failed
// validation later.
func writeUnifiedFreezeLedger(
	ctx context.Context,
	tx pgx.Tx,
	runID string,
	mode UnifiedCardsMode,
	all []actionableCandidate,
	selected []Candidate,
	excluded map[string]string,
	evaluatedAt time.Time,
) error {
	selectedByID := make(map[string]Candidate, len(selected))
	for _, candidate := range selected {
		selectedByID[candidate.ErrorGroupID] = candidate
	}
	sorted := append([]actionableCandidate(nil), all...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].GroupID < sorted[j].GroupID })
	if len(sorted) == 0 {
		return nil
	}
	// One batched statement, mirroring writeActionableLedger: the freeze ledger
	// covers every considered incident, not just the capped selection, so a
	// per-row Exec loop would cost one serial round trip per standing actionable
	// incident inside the transaction that must commit for the freeze to exist.
	count := len(sorted)
	groupIDs := make([]string, 0, count)
	outcomes := make([]string, 0, count)
	reasons := make([]string, 0, count)
	detailsList := make([]string, 0, count)
	fingerprints := make([]string, 0, count)
	spells := make([]*time.Time, 0, count)
	cacheHits := make([]*bool, 0, count)
	renderModes := make([]*string, 0, count)
	for _, source := range sorted {
		candidate, included := selectedByID[source.GroupID]
		outcome, reason := "excluded", excluded[source.GroupID]
		if included {
			outcome, reason = "included", reasonIncluded
		}
		if reason == "" {
			// Unreachable while selectOnCardCandidates assigns every non-selected
			// candidate a reason; the SLA unknown_reason_code arm makes drift loud.
			reason = reasonNotPublishable
		}
		detailValues := map[string]any{
			"evaluated_at": evaluatedAt.Format(time.RFC3339Nano),
			"kind":         source.Kind, "status": source.Status, "unified_cards_mode": mode,
		}
		var renderMode *string
		if included && candidate.NotCardEligible {
			fallback := "receipt_fallback"
			renderMode = &fallback
			detailValues["receipt_reason"] = "never_card_eligible"
		}
		details, err := json.Marshal(detailValues)
		if err != nil {
			return fmt.Errorf("encode unified freeze ledger details: %w", err)
		}
		var fingerprint string
		var spell *time.Time
		var cacheHit *bool
		if included {
			fingerprint, spell = candidate.Fingerprint, candidate.SpellStartedAt
			hit := candidate.CachedCard != nil
			cacheHit = &hit
		}
		groupIDs = append(groupIDs, source.GroupID)
		outcomes = append(outcomes, outcome)
		reasons = append(reasons, reason)
		detailsList = append(detailsList, string(details))
		fingerprints = append(fingerprints, fingerprint)
		spells = append(spells, spell)
		cacheHits = append(cacheHits, cacheHit)
		renderModes = append(renderModes, renderMode)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO digest_run_candidate_evaluations
		(digest_run_id,error_group_id,outcome,primary_reason_code,details,
		 input_fingerprint,spell_started_at,cache_hit,phase,render_mode)
		SELECT $1,ids.value::uuid,($3::text[])[ids.ordinality],
		       ($4::text[])[ids.ordinality],(($5::text[])[ids.ordinality])::jsonb,
		       NULLIF(($6::text[])[ids.ordinality],''),($7::timestamptz[])[ids.ordinality],
		       ($8::boolean[])[ids.ordinality],'freeze',($9::text[])[ids.ordinality]
		  FROM unnest($2::text[]) WITH ORDINALITY AS ids(value,ordinality)
		ON CONFLICT (digest_run_id,error_group_id) DO UPDATE SET
		 outcome=EXCLUDED.outcome,primary_reason_code=EXCLUDED.primary_reason_code,
		 details=EXCLUDED.details,input_fingerprint=EXCLUDED.input_fingerprint,
		 spell_started_at=EXCLUDED.spell_started_at,cache_hit=EXCLUDED.cache_hit,
		 phase='freeze',render_mode=EXCLUDED.render_mode`,
		runID, groupIDs, outcomes, reasons, detailsList, fingerprints, spells, cacheHits, renderModes); err != nil {
		return fmt.Errorf("write unified freeze ledger: %w", err)
	}
	return nil
}
