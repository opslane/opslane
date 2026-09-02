package digest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	ingestiondb "github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/narrative"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

type writtenDigestPayload struct {
	Included []writtenDigestCard  `json:"included"`
	Deferred []deferredDigestItem `json:"deferred"`
}

type writtenDigestCard struct {
	ErrorGroupID       string   `json:"errorGroupId,omitempty"`
	EpisodeID          string   `json:"episodeId"`
	Title              string   `json:"title,omitempty"`
	Copy               string   `json:"copy"`
	Why                string   `json:"why,omitempty"`
	Action             string   `json:"action"`
	Label              string   `json:"label"`
	ClaimedUsers       *int     `json:"claimedUsers,omitempty"`
	ClaimedOccurrences *int     `json:"claimedOccurrences,omitempty"`
	Accounts           []string `json:"accounts,omitempty"`
	PRURL              string   `json:"prUrl,omitempty"`
	FrictionCategory   string   `json:"frictionCategory,omitempty"`
	Route              string   `json:"route,omitempty"`
	SessionCount       *int     `json:"sessionCount,omitempty"`
	IdentifiedCount    *int     `json:"identifiedCount,omitempty"`
	ObservationQuote   string   `json:"observationQuote,omitempty"`
}

type deferredDigestItem struct {
	ErrorGroupID string `json:"errorGroupId,omitempty"`
	EpisodeID    string `json:"episodeId,omitempty"`
	Reason       string `json:"reason"`
}

type validationRun struct {
	ProjectID   string
	ProjectName string
	GithubRepo  string
	Status      string
	Timezone    string
	RunDate     string
	WindowFrom  time.Time
	WindowTo    time.Time
	CreatedAt   time.Time
	Payload     []byte
	Mode        UnifiedCardsMode
}

func candidateIdentity(candidate Candidate) string {
	if candidate.ErrorGroupID != "" {
		return candidate.ErrorGroupID
	}
	return candidate.EpisodeID
}

func cardIdentity(errorGroupID, episodeID string) string {
	if errorGroupID != "" {
		return errorGroupID
	}
	return episodeID
}

// capDigestDelivery mirrors the renderer's decision -> receipt -> fix order.
// Publication accounting uses its returned slices, so no card hidden by the
// renderer can acquire a durable publication receipt.
//
// The mode decides who pays for the budget, exactly as the renderer does: ON
// spends one cap across decisions, receipts and fixes, because there a receipt
// is a card that could not be authored and both are the same pending incident.
// OFF is the rollback path — the cap covers generated cards only and every
// receipt is delivered, which is what ships on main.
func capDigestDelivery(
	mode UnifiedCardsMode,
	generated []notify.GeneratedDigestCard,
	receipts []notify.ReceiptItem,
	generatedOverflow int,
	receiptOverflow int,
) ([]notify.GeneratedDigestCard, []notify.ReceiptItem, int, int, []string) {
	decisions := make([]notify.GeneratedDigestCard, 0, len(generated))
	fixes := make([]notify.GeneratedDigestCard, 0, len(generated))
	for _, card := range generated {
		if card.Outcome == "needs_human" {
			decisions = append(decisions, card)
		} else {
			fixes = append(fixes, card)
		}
	}

	remaining := notify.DigestV4CardCap
	keptDecisions := min(len(decisions), remaining)
	remaining -= keptDecisions
	keptReceipts := len(receipts)
	if mode == UnifiedCardsOn {
		keptReceipts = min(len(receipts), remaining)
		remaining -= keptReceipts
	}
	keptFixes := min(len(fixes), remaining)

	dropped := make([]string, 0,
		len(decisions)-keptDecisions+len(receipts)-keptReceipts+len(fixes)-keptFixes)
	for _, card := range decisions[keptDecisions:] {
		dropped = append(dropped, card.IncidentID)
	}
	for _, item := range receipts[keptReceipts:] {
		dropped = append(dropped, item.IncidentID)
	}
	for _, card := range fixes[keptFixes:] {
		dropped = append(dropped, card.IncidentID)
	}

	keptGenerated := make([]notify.GeneratedDigestCard, 0, keptDecisions+keptFixes)
	keptGenerated = append(keptGenerated, decisions[:keptDecisions]...)
	keptGenerated = append(keptGenerated, fixes[:keptFixes]...)
	return keptGenerated, receipts[:keptReceipts],
		generatedOverflow + len(decisions) - keptDecisions + len(fixes) - keptFixes,
		receiptOverflow + len(receipts) - keptReceipts,
		dropped
}

// loadActionableCandidatesForValidation is the validator's live reload of the
// actionable set. It is a variable so a test can inject the infrastructure
// failure this degrade path exists for; production always uses the real query.
var loadActionableCandidatesForValidation = loadActionableCandidates

// ValidateAndPublish rechecks model output against the immutable snapshots and
// publishes the run, its receipts, outbox event and deliveries atomically.
func ValidateAndPublish(ctx context.Context, pool *pgxpool.Pool, runID string) error {
	err := validateAndPublish(ctx, pool, runID)
	if err != nil {
		// Validation and transactional failures leave no publication side effects.
		// Marking failed separately lets the scheduler re-enqueue the same frozen run.
		_, _ = pool.Exec(ctx, `UPDATE digest_runs SET status='failed'
			WHERE id=$1 AND status NOT IN ('delivered')`, runID)
	}
	return err
}

// internalVocabulary matches pipeline state words as whole tokens. The customer
// message may never carry them; validation fails closed when a writer leaks one.
var internalVocabulary = regexp.MustCompile(`(?i)(^|[^a-z0-9_])(needs_human|verified_fix|report_ready|do_not_pursue|unable_to_establish_cause)($|[^a-z0-9_])`)

// \p{Nd}, not \d: Go's \d is ASCII-only, so full-width or Arabic-Indic digits
// ("４０００ users") would sail past the grounding scan entirely. Any decimal
// digit in any script is scanned; non-ASCII digit runs can never match the
// ASCII fact set, so they are rejected rather than invisible.
var proseNumber = regexp.MustCompile(`\p{Nd}+`)

// digitGroupSeparator collapses "1,234" to "1234" before scanning, so a
// normally formatted count matches its frozen fact instead of tokenizing as
// two ungrounded numbers and failing the whole digest.
var digitGroupSeparator = regexp.MustCompile(`(\p{Nd}),(\p{Nd})`)

func normalizeProseNumbers(text string) string {
	for {
		collapsed := digitGroupSeparator.ReplaceAllString(text, "$1$2")
		if collapsed == text {
			return collapsed
		}
		text = collapsed
	}
}

// stripInvisible removes format-category runes (zero-width spaces and joiners,
// bidi controls) from writer output before validation and rendering. They pass
// TrimSpace and rune counts while defeating the vocabulary regex
// ("needs_​human") and enabling RTL visual spoofing in Slack.
func stripInvisible(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, text)
}

func containsDigit(value string) bool {
	for _, r := range value {
		if unicode.IsDigit(r) {
			return true
		}
	}
	return false
}

// validateUnifiedWrittenCard checks one authored or cached card and, when it
// refuses a CACHED one, retires exactly that cache row. Without this a copy the
// validator rejects stays current and demotes its card to a receipt every day
// forever; with it, tomorrow's run re-authors.
func validateUnifiedWrittenCard(
	ctx context.Context,
	tx pgx.Tx,
	run validationRun,
	card writtenDigestCard,
	candidate Candidate,
) (writtenDigestCard, string, error) {
	validated, renderMode, err := checkUnifiedWrittenCard(ctx, tx, run, card, candidate)
	if err == nil || candidate.CachedCard == nil || candidate.SpellStartedAt == nil {
		return validated, renderMode, err
	}
	var infrastructureError unifiedInfrastructureError
	if errors.As(err, &infrastructureError) {
		// The savepoint is about to roll back; another statement on this
		// transaction would only turn a degraded section into a failed run.
		return validated, renderMode, err
	}
	// Keyed by the full primary key, never by group alone: a concurrent writer
	// may already have retired this row and made a newer one current, and a
	// late validator must not clobber that replacement.
	if _, retireErr := tx.Exec(ctx, `UPDATE digest_card_copy SET invalidated_at=now()
		WHERE error_group_id=$1 AND spell_started_at=$2 AND authored_at=$3
		  AND invalidated_at IS NULL
		  AND EXISTS (SELECT 1 FROM error_groups g
		    WHERE g.id=digest_card_copy.error_group_id AND g.project_id=$4)`,
		candidate.ErrorGroupID, *candidate.SpellStartedAt,
		candidate.CachedCard.AuthoredAt, run.ProjectID); retireErr != nil {
		return validated, renderMode, unifiedInfrastructureError{
			fmt.Errorf("retire rejected digest card cache for %s: %w", candidate.ErrorGroupID, retireErr)}
	}
	slog.Warn("rejected digest card cache retired", "diagnostic", "cache_rejected",
		"error_group_id", candidate.ErrorGroupID, "error", err)
	return validated, renderMode, err
}

func checkUnifiedWrittenCard(
	ctx context.Context,
	tx pgx.Tx,
	run validationRun,
	card writtenDigestCard,
	candidate Candidate,
) (writtenDigestCard, string, error) {
	identity := candidateIdentity(candidate)
	card.Title = stripInvisible(card.Title)
	card.Copy = stripInvisible(card.Copy)
	card.Why = stripInvisible(card.Why)
	card.Action = stripInvisible(card.Action)
	// The instruction line has exactly one correct value, so the model does not
	// own it: overwrite rather than compare. Demoting a good card over wording
	// would waste the authoring call and hide the incident behind a receipt.
	// This runs before every check below, so the stamped value is what gets
	// length-checked, cached, and rendered.
	if candidate.SpellStartedAt != nil && candidate.ValidAction != "" {
		if strings.TrimSpace(card.Action) != candidate.ValidAction {
			slog.Info("digest card action replaced by the state function",
				"diagnostic", "action_overwritten", "error_group_id", candidate.ErrorGroupID,
				"model_action", strings.TrimSpace(card.Action), "state_action", candidate.ValidAction)
		}
		card.Action = candidate.ValidAction
	}
	if strings.TrimSpace(card.Title) == "" || strings.TrimSpace(card.Copy) == "" || strings.TrimSpace(card.Action) == "" {
		return card, "", fmt.Errorf("malformed card for %s", identity)
	}
	// A diagnosed incident owes the reader the one sentence that explains it. An
	// incident admitted on a validated diagnosis whose stored cause is empty has
	// nothing to say, so it is excused rather than demoted for a missing field.
	if candidate.HasValidatedDiagnosis && strings.TrimSpace(candidate.RootCause) != "" &&
		strings.TrimSpace(card.Why) == "" {
		return card, "", fmt.Errorf("diagnosed card for %s carries no cause sentence", identity)
	}
	if internalVocabulary.MatchString(card.Title) || internalVocabulary.MatchString(card.Copy) ||
		internalVocabulary.MatchString(card.Why) || internalVocabulary.MatchString(card.Action) {
		return card, "", fmt.Errorf("internal vocabulary in card for %s", identity)
	}
	if len([]rune(strings.TrimSpace(card.Title))) > 80 || len([]rune(card.Copy)) > 300 ||
		len([]rune(card.Why)) > 300 || len([]rune(card.Action)) > 300 {
		return card, "", fmt.Errorf("card length exceeded for %s", identity)
	}
	if containsDigit(card.Copy) || containsDigit(card.Action) {
		return card, "", fmt.Errorf("authored copy/action contains a numeric glyph for %s", identity)
	}
	if card.Label != candidate.Label {
		return card, "", fmt.Errorf("unsupported label for %s", identity)
	}
	if card.ClaimedUsers != nil && *card.ClaimedUsers != candidate.AffectedUsers {
		return card, "", fmt.Errorf("unsupported count for %s", identity)
	}
	if card.ClaimedOccurrences != nil && *card.ClaimedOccurrences != candidate.OccurrenceCount {
		return card, "", fmt.Errorf("unsupported occurrence count for %s", identity)
	}
	if card.Accounts != nil && !equalStringSet(card.Accounts, candidate.Accounts) {
		return card, "", fmt.Errorf("unsupported accounts for %s", identity)
	}
	if card.PRURL != "" && card.PRURL != candidate.PRURL {
		return card, "", fmt.Errorf("unsupported link for %s", identity)
	}
	if card.SessionCount != nil && *card.SessionCount != candidate.SessionCount {
		return card, "", fmt.Errorf("unsupported session count for %s", identity)
	}
	if card.IdentifiedCount != nil && *card.IdentifiedCount != candidate.IdentifiedCount {
		return card, "", fmt.Errorf("unsupported identified count for %s", identity)
	}
	if card.FrictionCategory != "" && card.FrictionCategory != candidate.FrictionCategory {
		return card, "", fmt.Errorf("unsupported friction category for %s", identity)
	}
	if card.Route != "" && card.Route != candidate.Route {
		return card, "", fmt.Errorf("unsupported route for %s", identity)
	}
	if card.ObservationQuote != "" && card.ObservationQuote != candidate.ObservationQuote {
		return card, "", fmt.Errorf("unsupported observation quote for %s", identity)
	}
	if candidate.PRURL != "" && !projectPullRequest(candidate.PRURL, run.GithubRepo) {
		return card, "", fmt.Errorf("frozen link for %s is outside the project repository", identity)
	}
	current, err := candidateStillUnified(ctx, tx, run.ProjectID, candidate)
	if err != nil {
		return card, "", err
	}
	if !current {
		return card, "", unifiedCandidateChangedError{identity: identity}
	}

	// Grounding runs for cached cards too, and it is the only check that covers
	// the title. The fingerprint deliberately excludes counts, so nothing
	// retires a cached row when a count moves: a title authored as "for 2
	// people" would otherwise repeat verbatim beside a context line showing the
	// live number, forever. A digit copied from a frozen fact still passes, so
	// this does not ban titles that legitimately carry numbers.
	if number, ok := firstUngroundedNumber(card, candidate); ok {
		return card, "", fmt.Errorf("ungrounded number %s in card for %s", number, identity)
	}
	renderMode := "authored"
	if candidate.CachedCard != nil {
		cached := candidate.CachedCard
		if card.Title != cached.Title || card.Copy != cached.Copy || card.Why != cached.Why ||
			card.Action != cached.Action || cached.Fingerprint != candidate.Fingerprint {
			return card, "", fmt.Errorf("cached card for %s changed in transit", identity)
		}
		return card, "cached", nil
	}
	card, cachedMode, err := cacheValidatedCard(ctx, tx, run, candidate, card)
	if err != nil {
		return card, "", err
	}
	if cachedMode != "" {
		renderMode = cachedMode
	}
	return card, renderMode, nil
}

func candidateStillUnified(ctx context.Context, tx pgx.Tx, projectID string, frozen Candidate) (bool, error) {
	actionable := frozen.SpellStartedAt != nil
	if !actionable {
		if err := candidateStillPublishable(ctx, tx, projectID, frozen); err != nil {
			var queryError candidateQueryError
			if errors.As(err, &queryError) && !errors.Is(err, pgx.ErrNoRows) {
				return false, unifiedInfrastructureError{err}
			}
			return false, nil
		}
	}
	var status, title, signalType, rootCause, mitigation, diffIdentity, routePurpose, prURL, remediation, reasonMessage string
	var hasValidatedDiagnosis, hasSavedDiff bool
	var snoozedUntil, actionableSince *time.Time
	if err := tx.QueryRow(ctx, `SELECT g.status::text,g.title,COALESCE(g.signal_type,''),
		COALESCE(g.root_cause,''),COALESCE(g.suggested_mitigation,''),
		md5(COALESCE(g.candidate_diff,'')),NULLIF(btrim(g.candidate_diff),'') IS NOT NULL,
		g.snoozed_until,g.actionable_since,
		COALESCE((SELECT rm.purpose FROM route_map rm
		 WHERE rm.project_id=g.project_id AND g.page_url_normalized LIKE '%' || rm.pattern || '%'
		 ORDER BY length(rm.pattern) DESC LIMIT 1),''),COALESCE(g.pr_url,''),
		COALESCE(g.remediation,''),COALESCE(g.reason_message,''),
		validity.has_validated_diagnosis
		FROM error_groups g
		LEFT JOIN LATERAL (`+diagnosisValidationLateralSQL+`) validity ON true
		WHERE g.project_id=$1 AND g.id=$2`, projectID, frozen.ErrorGroupID).Scan(
		&status, &title, &signalType, &rootCause, &mitigation, &diffIdentity, &hasSavedDiff,
		&snoozedUntil, &actionableSince, &routePurpose, &prURL, &remediation, &reasonMessage,
		&hasValidatedDiagnosis,
	); err != nil {
		if err == pgx.ErrNoRows {
			return false, nil
		}
		return false, unifiedInfrastructureError{fmt.Errorf("reload unified candidate %s: %w", frozen.ErrorGroupID, err)}
	}
	if actionable {
		switch status {
		case "awaiting_approval", "needs_human", "pr_created", "pr_draft":
		default:
			return false, nil
		}
		if snoozedUntil != nil && snoozedUntil.After(time.Now()) {
			return false, nil
		}
		if actionableSince == nil || !actionableSince.Equal(*frozen.SpellStartedAt) {
			return false, nil
		}
	}
	current := frozen
	current.Status, current.Title, current.SignalType = status, title, signalType
	current.RootCause, current.Mitigation, current.DiffIdentity = rootCause, mitigation, diffIdentity
	current.RoutePurpose, current.SpellStartedAt, current.PRURL = routePurpose, actionableSince, prURL
	current.HasValidatedDiagnosis = hasValidatedDiagnosis
	if actionable {
		// One reload path for both kinds in ON: the action is the state
		// function's, never stored prose, and never an episode's diagnosis.
		current.Summary = rootCause
		if current.Summary == "" {
			current.Summary = title
		}
		current.HasSavedDiff = hasSavedDiff
		current.ValidAction = digestAction(status, hasSavedDiff, prURL)
		current.Outcome = onCardOutcome(status)
		current.NotCardEligible = !onCardEligible(status, prURL, rootCause, hasSavedDiff, hasValidatedDiagnosis)
	} else {
		var outcome, summary string
		var decidedAt time.Time
		if err := tx.QueryRow(ctx, `SELECT d.outcome,
			COALESCE(NULLIF(btrim(d.diagnosis->>'summary'),''),d.decision_reason),d.decided_at
			FROM diagnosis_decisions d WHERE d.project_id=$1 AND d.episode_id=$2
			ORDER BY d.decided_at DESC,d.id DESC LIMIT 1`, projectID, frozen.EpisodeID).Scan(
			&outcome, &summary, &decidedAt,
		); err != nil {
			if err == pgx.ErrNoRows {
				return false, nil
			}
			return false, unifiedInfrastructureError{fmt.Errorf("reload unified diagnosis %s: %w", frozen.EpisodeID, err)}
		}
		current.Outcome, current.Summary, current.DecidedAt = outcome, summary, decidedAt
		if outcome == "verified_fix" && prURL != "" {
			current.ValidAction = "Review the fix PR."
		} else {
			current.ValidAction = strings.TrimSpace(remediation)
			if current.ValidAction == "" {
				current.ValidAction = strings.TrimSpace(reasonMessage)
			}
		}
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT eu.account_name
		FROM error_group_affected_users eau JOIN end_users eu ON eu.id=eau.end_user_id
		WHERE eau.error_group_id=$1 AND eu.project_id=$2 AND NULLIF(btrim(eu.account_name),'') IS NOT NULL
		ORDER BY eu.account_name LIMIT 8`, frozen.ErrorGroupID, projectID)
	if err != nil {
		return false, unifiedInfrastructureError{fmt.Errorf("reload unified accounts %s: %w", frozen.ErrorGroupID, err)}
	}
	current.Accounts = []string{}
	for rows.Next() {
		var account string
		if err := rows.Scan(&account); err != nil {
			rows.Close()
			return false, unifiedInfrastructureError{fmt.Errorf("reload unified account %s: %w", frozen.ErrorGroupID, err)}
		}
		current.Accounts = append(current.Accounts, account)
	}
	rows.Close()
	if rows.Err() != nil {
		return false, unifiedInfrastructureError{fmt.Errorf("reload unified accounts %s: %w", frozen.ErrorGroupID, rows.Err())}
	}
	return candidateFingerprint(current, digestPromptVersion, digestValidatorVersion) == frozen.Fingerprint, nil
}

type unifiedInfrastructureError struct{ err error }

func (e unifiedInfrastructureError) Error() string { return e.err.Error() }
func (e unifiedInfrastructureError) Unwrap() error { return e.err }

type unifiedCandidateChangedError struct{ identity string }

func (e unifiedCandidateChangedError) Error() string {
	return fmt.Sprintf("candidate %s changed after freeze", e.identity)
}

func cacheValidatedCard(ctx context.Context, tx pgx.Tx, run validationRun, candidate Candidate, card writtenDigestCard) (writtenDigestCard, string, error) {
	if candidate.SpellStartedAt == nil || candidate.Fingerprint == "" {
		return card, "", nil
	}
	if _, err := tx.Exec(ctx, `UPDATE digest_card_copy SET invalidated_at=now()
		WHERE error_group_id=$1 AND spell_started_at=$2 AND invalidated_at IS NULL
		  AND input_fingerprint<>$3 AND authored_at < $4
		  AND EXISTS (SELECT 1 FROM error_groups g
		    WHERE g.id=digest_card_copy.error_group_id AND g.project_id=$5)`, candidate.ErrorGroupID,
		*candidate.SpellStartedAt, candidate.Fingerprint, run.CreatedAt, run.ProjectID); err != nil {
		return card, "", unifiedInfrastructureError{fmt.Errorf("retire stale digest card cache for %s: %w", candidate.ErrorGroupID, err)}
	}
	command, err := tx.Exec(ctx, `INSERT INTO digest_card_copy
		(error_group_id,spell_started_at,input_fingerprint,title,copy,why,action,model,prompt_version)
		SELECT $1,$2,$3,$4,$5,NULLIF($6,''),$7,'digest-writer',$8
		FROM error_groups g WHERE g.id=$1 AND g.project_id=$9
		ON CONFLICT (error_group_id,spell_started_at) WHERE invalidated_at IS NULL DO NOTHING`,
		candidate.ErrorGroupID, *candidate.SpellStartedAt, candidate.Fingerprint,
		strings.TrimSpace(card.Title), strings.TrimSpace(card.Copy), strings.TrimSpace(card.Why),
		strings.TrimSpace(card.Action), digestPromptVersion, run.ProjectID)
	if err != nil {
		return card, "", unifiedInfrastructureError{fmt.Errorf("cache validated digest card for %s: %w", candidate.ErrorGroupID, err)}
	}
	if command.RowsAffected() == 0 {
		var winner, title, copy, why, action string
		if err := tx.QueryRow(ctx, `SELECT c.input_fingerprint,c.title,c.copy,COALESCE(c.why,''),c.action
			FROM digest_card_copy c JOIN error_groups g ON g.id=c.error_group_id
			WHERE g.project_id=$1 AND c.error_group_id=$2 AND c.spell_started_at=$3
			  AND c.invalidated_at IS NULL`, run.ProjectID, candidate.ErrorGroupID,
			*candidate.SpellStartedAt).Scan(&winner, &title, &copy, &why, &action); err != nil {
			return card, "", unifiedInfrastructureError{fmt.Errorf("load digest cache winner for %s: %w", candidate.ErrorGroupID, err)}
		}
		if winner == candidate.Fingerprint {
			card.Title, card.Copy, card.Why, card.Action = title, copy, why, action
			return card, "cached", nil
		} else {
			slog.Warn("digest cache conflict", "diagnostic", "cache_conflict",
				"error_group_id", candidate.ErrorGroupID, "run_mode", run.Mode,
				"candidate_fingerprint", candidate.Fingerprint, "winner_fingerprint", winner)
		}
	}
	return card, "authored", nil
}

func validateAndPublish(ctx context.Context, pool *pgxpool.Pool, runID string) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin digest publication: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var run validationRun
	if err := tx.QueryRow(ctx, `
		SELECT r.project_id::text,p.name,COALESCE(p.github_repo,''),r.status,
		       p.digest_timezone,r.run_date::text,r.window_from,r.window_to,
		       r.created_at,COALESCE(r.writer_payload,r.payload),r.unified_cards_mode
		  FROM digest_runs r JOIN projects p ON p.id=r.project_id
		 WHERE r.id=$1 FOR UPDATE OF r`, runID).Scan(
		&run.ProjectID, &run.ProjectName, &run.GithubRepo, &run.Status, &run.Timezone,
		&run.RunDate, &run.WindowFrom, &run.WindowTo, &run.CreatedAt, &run.Payload, &run.Mode,
	); err != nil {
		return fmt.Errorf("load digest run: %w", err)
	}
	if run.Status == "delivered" {
		return tx.Commit(ctx)
	}
	if run.Status != "written" && run.Status != "validated" {
		return fmt.Errorf("digest run %s is %s, want written or validated", runID, run.Status)
	}

	var payload writtenDigestPayload
	decoder := json.NewDecoder(bytes.NewReader(run.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return fmt.Errorf("malformed digest payload: %w", err)
	}
	candidates, err := loadValidationCandidates(ctx, tx, run.ProjectID, runID)
	if err != nil {
		return err
	}
	byIdentity := make(map[string]Candidate, len(candidates)*2)
	for _, candidate := range candidates {
		if candidate.ErrorGroupID != "" {
			byIdentity[candidate.ErrorGroupID] = candidate
		}
		if candidate.EpisodeID != "" {
			byIdentity[candidate.EpisodeID] = candidate
		}
	}
	unifiedSavepointOpen := false
	unifiedDegraded := false
	unifiedDeliveryAlert := ""
	if run.Mode != UnifiedCardsOff {
		if _, err := tx.Exec(ctx, `SAVEPOINT unified_card_section`); err != nil {
			return fmt.Errorf("open unified card savepoint: %w", err)
		}
		unifiedSavepointOpen = true
	}
	rollbackUnified := func(cause error) error {
		if !unifiedSavepointOpen || unifiedDegraded {
			return nil
		}
		if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT unified_card_section`); err != nil {
			return fmt.Errorf("roll back unified card section after %v: %w", cause, err)
		}
		unifiedDegraded = true
		unifiedDeliveryAlert = "Authored digest cards could not be finalized; showing receipts instead."
		slog.Error("unified digest card section degraded", "run_id", runID,
			"project_id", run.ProjectID, "error", cause)
		return nil
	}
	accounted := make(map[string]string, len(candidates))
	renderModes := make(map[string]string, len(candidates))
	// Why an incident fell back to its receipt. The freeze already stamped
	// "never_card_eligible" for candidates publishable() refused; these are the
	// ones that were card-eligible and lost the card at validation.
	receiptReasons := make(map[string]string, len(candidates))
	overflowReasons := make(map[string]string)
	excludedReasons := make(map[string]string)
	generated := make([]notify.GeneratedDigestCard, 0, len(payload.Included))
	for _, card := range payload.Included {
		dispositionID := cardIdentity(card.ErrorGroupID, card.EpisodeID)
		candidate, ok := byIdentity[dispositionID]
		if !ok {
			return fmt.Errorf("unknown digest candidate %s", dispositionID)
		}
		identity := candidateIdentity(candidate)
		if previous := accounted[identity]; previous != "" {
			return fmt.Errorf("duplicate action for candidate %s", identity)
		}
		accounted[identity] = "included"
		if run.Mode != UnifiedCardsOff {
			if unifiedDegraded {
				renderModes[identity] = "receipt_fallback"
				receiptReasons[identity] = "card_section_degraded"
				continue
			}
			validated, mode, validationErr := validateUnifiedWrittenCard(ctx, tx, run, card, candidate)
			if validationErr != nil {
				var infrastructureError unifiedInfrastructureError
				if errors.As(validationErr, &infrastructureError) {
					if err := rollbackUnified(validationErr); err != nil {
						return err
					}
				}
				slog.Warn("unified digest card fell back to receipt", "run_id", runID,
					"error_group_id", candidate.ErrorGroupID, "mode", run.Mode, "error", validationErr)
				var changedError unifiedCandidateChangedError
				if candidate.SpellStartedAt == nil && errors.As(validationErr, &changedError) {
					accounted[identity] = "deferred"
					excludedReasons[identity] = reasonNotPublishable
					delete(renderModes, identity)
					continue
				}
				renderModes[identity] = "receipt_fallback"
				receiptReasons[identity] = "card_validation_failed"
				continue
			}
			card = validated
			renderModes[identity] = mode
			replayURL := notify.BuildSessionURL(os.Getenv("DASHBOARD_URL"), candidate.ReplaySessionID, candidate.ReplayAnchorMs)
			generated = append(generated, notify.GeneratedDigestCard{
				EpisodeID: candidate.EpisodeID, IncidentID: candidate.ErrorGroupID, Kind: candidate.Kind,
				Title: strings.TrimSpace(card.Title), Label: candidate.Label, Outcome: candidate.Outcome,
				Copy: strings.TrimSpace(card.Copy), Why: strings.TrimSpace(card.Why),
				Action:        strings.TrimSpace(card.Action),
				AffectedUsers: candidate.AffectedUsers, OccurrenceCount: candidate.OccurrenceCount,
				SignalCount: int64(candidate.OccurrenceCount), Accounts: candidate.Accounts,
				PRURL: candidate.PRURL, ReplayURL: replayURL, PRNumber: prNumber(candidate.PRURL),
				ActionableSince:  candidate.SpellStartedAt,
				FrictionCategory: candidate.FrictionCategory, Route: candidate.Route,
				SessionCount: candidate.SessionCount, IdentifiedCount: candidate.IdentifiedCount,
				ObservationQuote: candidate.ObservationQuote,
			})
			continue
		}
		// Stripped BEFORE every check and carried through to the rendered card:
		// zero-width and bidi characters pass TrimSpace and rune counts while
		// defeating the vocabulary regex and blanking titles.
		card.Title = stripInvisible(card.Title)
		card.Copy = stripInvisible(card.Copy)
		card.Action = stripInvisible(card.Action)
		if strings.TrimSpace(card.Copy) == "" || strings.TrimSpace(card.Action) == "" {
			return fmt.Errorf("malformed card for episode %s", card.EpisodeID)
		}
		if internalVocabulary.MatchString(card.Title) || internalVocabulary.MatchString(card.Copy) || internalVocabulary.MatchString(card.Action) {
			return fmt.Errorf("internal vocabulary in card for episode %s", card.EpisodeID)
		}
		if len([]rune(strings.TrimSpace(card.Title))) > 80 {
			return fmt.Errorf("title for episode %s exceeds 80 characters", card.EpisodeID)
		}
		// Enforced here, not at render: the renderer truncates at 300 runes
		// AFTER validation, and a cut inside grounded prose can change meaning
		// (dropping "…and couldn't", splitting a digit run). Legacy title-less
		// payloads predate the writer contract and keep render truncation.
		if card.Title != "" {
			if len([]rune(card.Copy)) > 300 {
				return fmt.Errorf("copy for episode %s exceeds 300 characters", card.EpisodeID)
			}
			if len([]rune(card.Action)) > 300 {
				return fmt.Errorf("action for episode %s exceeds 300 characters", card.EpisodeID)
			}
		}
		if card.Label != candidate.Label {
			return fmt.Errorf("unsupported label for episode %s", card.EpisodeID)
		}
		if card.ClaimedUsers != nil && *card.ClaimedUsers != candidate.AffectedUsers {
			return fmt.Errorf("unsupported count for episode %s", card.EpisodeID)
		}
		if card.ClaimedOccurrences != nil && *card.ClaimedOccurrences != candidate.OccurrenceCount {
			return fmt.Errorf("unsupported occurrence count for episode %s", card.EpisodeID)
		}
		if number, ok := firstUngroundedNumber(card, candidate); ok {
			return fmt.Errorf("ungrounded number %s in card for episode %s", number, card.EpisodeID)
		}
		if card.Accounts != nil && !equalStringSet(card.Accounts, candidate.Accounts) {
			return fmt.Errorf("unsupported accounts for episode %s", card.EpisodeID)
		}
		if card.PRURL != "" && card.PRURL != candidate.PRURL {
			return fmt.Errorf("unsupported link for episode %s", card.EpisodeID)
		}
		if card.SessionCount != nil && *card.SessionCount != candidate.SessionCount {
			return fmt.Errorf("unsupported session count for episode %s", card.EpisodeID)
		}
		if card.IdentifiedCount != nil && *card.IdentifiedCount != candidate.IdentifiedCount {
			return fmt.Errorf("unsupported identified count for episode %s", card.EpisodeID)
		}
		if card.PRURL != "" && !projectPullRequest(card.PRURL, run.GithubRepo) {
			return fmt.Errorf("link for episode %s is outside the project repository", card.EpisodeID)
		}
		// The rendered button always carries candidate.PRURL, so the frozen URL
		// is validated directly — checking only the model's echo would skip the
		// repository gate whenever the echo field is omitted.
		if candidate.PRURL != "" && !projectPullRequest(candidate.PRURL, run.GithubRepo) {
			return fmt.Errorf("frozen link for episode %s is outside the project repository", card.EpisodeID)
		}
		if err := candidateStillPublishable(ctx, tx, run.ProjectID, candidate); err != nil {
			return err
		}
		title := strings.TrimSpace(card.Title)
		if title == "" {
			title = truncateRunes(stripInvisible(candidate.Title), 80)
		}
		replayURL := notify.BuildSessionURL(os.Getenv("DASHBOARD_URL"), candidate.ReplaySessionID, candidate.ReplayAnchorMs)
		if replayURL == "" && candidate.ReplaySessionID != "" {
			// The URL is baked into the outbox event, so a misconfigured (empty
			// or loopback) DASHBOARD_URL silently drops every Watch replay
			// button and retries never recover it. Loud, or invisible forever.
			slog.Warn("digest replay URL rejected; card renders without its replay button",
				"episode_id", candidate.EpisodeID, "dashboard_url_set", os.Getenv("DASHBOARD_URL") != "")
		}
		generated = append(generated, notify.GeneratedDigestCard{
			EpisodeID: candidate.EpisodeID, IncidentID: candidate.IssueID,
			Title: title, Label: candidate.Label, Outcome: candidate.Outcome, Copy: strings.TrimSpace(card.Copy),
			Action: strings.TrimSpace(card.Action), AffectedUsers: candidate.AffectedUsers,
			OccurrenceCount: candidate.OccurrenceCount, Accounts: candidate.Accounts, PRURL: candidate.PRURL,
			ReplayURL:        replayURL,
			PRNumber:         prNumber(candidate.PRURL),
			FrictionCategory: candidate.FrictionCategory, Route: candidate.Route,
			SessionCount: candidate.SessionCount, IdentifiedCount: candidate.IdentifiedCount,
			ObservationQuote: candidate.ObservationQuote,
		})
	}
	for _, item := range payload.Deferred {
		dispositionID := cardIdentity(item.ErrorGroupID, item.EpisodeID)
		candidate, ok := byIdentity[dispositionID]
		if !ok {
			return fmt.Errorf("unknown digest candidate %s", dispositionID)
		}
		identity := candidateIdentity(candidate)
		if accounted[identity] != "" {
			return fmt.Errorf("duplicate disposition for candidate %s", identity)
		}
		if strings.TrimSpace(item.Reason) == "" {
			return fmt.Errorf("deferred episode %s has no reason", item.EpisodeID)
		}
		if internalVocabulary.MatchString(item.Reason) {
			return fmt.Errorf("internal vocabulary in deferred reason for episode %s", item.EpisodeID)
		}
		accounted[identity] = "deferred"
		if run.Mode != UnifiedCardsOff {
			renderModes[identity] = "receipt_fallback"
		}
	}
	for _, candidate := range candidates {
		identity := candidateIdentity(candidate)
		if accounted[identity] == "" {
			if run.Mode != UnifiedCardsOff {
				accounted[identity] = "deferred"
				renderModes[identity] = "receipt_fallback"
				continue
			}
			return fmt.Errorf("candidate %s was not accounted for", identity)
		}
	}
	if unifiedDegraded {
		kept := generated[:0]
		for _, card := range generated {
			if candidate, ok := byIdentity[card.IncidentID]; ok && candidate.SpellStartedAt == nil {
				kept = append(kept, card)
			}
		}
		generated = kept
		for _, candidate := range candidates {
			if candidate.SpellStartedAt != nil {
				renderModes[candidateIdentity(candidate)] = "receipt_fallback"
			}
		}
	}

	// The renderer shows at most DigestV4CardCap cards, so cards past the cap
	// must NOT be marked included here: an issue_publications receipt for a
	// never-rendered card would exclude that issue from every future digest —
	// it silently disappears without ever reaching the reader. Overflow cards
	// are deferred instead (decisions keep priority), which the freeze
	// re-admits into the next digest.
	sort.SliceStable(generated, func(i, j int) bool {
		return generated[i].Outcome == "needs_human" && generated[j].Outcome != "needs_human"
	})
	overflowCount := 0
	// The cross-lane dedup set is built from the PRE-truncation card list: a
	// card deferred past the render cap is re-admitted to tomorrow's frozen
	// digest, and letting today's receipt lane also deliver it would show the
	// same incident twice across two days while today's overflow count
	// contradicts the receipts below it.
	frozenIncidentIDs := make(map[string]bool, len(generated))
	for _, card := range generated {
		frozenIncidentIDs[card.IncidentID] = true
	}
	// Actionable receipts and their candidate ledger are one publication unit:
	// ledger "included" plus this run's delivered status is the durable receipt
	// publication record. Episode-keyed issue_publications remains owned by the
	// frozen lane above. A savepoint keeps failures in this additive lane from
	// suppressing otherwise valid frozen cards.
	receiptItems := []notify.ReceiptItem(nil)
	actionableBaseReceipts := []notify.ReceiptItem(nil)
	receiptOverflow := 0
	deliveryAlert := ""
	if _, err := tx.Exec(ctx, `SAVEPOINT actionable_delivery`); err != nil {
		return fmt.Errorf("open actionable delivery savepoint: %w", err)
	}
	var actionableErr error
	var actionableEvaluatedAt time.Time
	actionableByGroup := make(map[string]actionableCandidate)
	if err := tx.QueryRow(ctx, `SELECT transaction_timestamp()`).Scan(&actionableEvaluatedAt); err != nil {
		actionableErr = fmt.Errorf("load actionable evaluation clock: %w", err)
	}
	var actionableEval evaluation
	if actionableErr == nil {
		statusSQL := m1ActionableStatusSQL
		if run.Mode == UnifiedCardsOn {
			statusSQL = onCardStatusSQL
		}
		actionableCandidates, err := loadActionableCandidatesForValidation(ctx, tx, run.ProjectID, statusSQL)
		if err != nil {
			actionableErr = err
		} else {
			actionableByGroup = make(map[string]actionableCandidate, len(actionableCandidates))
			for _, candidate := range actionableCandidates {
				actionableByGroup[candidate.GroupID] = candidate
			}
		}
		if actionableErr == nil && run.Mode == UnifiedCardsOn {
			actionableEval = evaluation{Excluded: map[string]string{}}
			for _, frozen := range candidates {
				identity := candidateIdentity(frozen)
				if renderModes[identity] != "receipt_fallback" {
					continue
				}
				// Only "stopped waiting" removes an incident here. A moved
				// spell means the ASK changed since the freeze (migration 066
				// resets the waiting age on every action-class change, so a
				// minutes-long gap is enough) — the incident is still waiting,
				// and its receipt is mechanical, built from the live row below.
				live, ok := actionableByGroup[frozen.ErrorGroupID]
				snoozed := ok && live.SnoozedUntil != nil && live.SnoozedUntil.After(actionableEvaluatedAt)
				if !ok || snoozed || live.ActionableSince == nil {
					accounted[identity] = "deferred"
					delete(renderModes, identity)
					reason := reasonNotPublishable
					if snoozed {
						reason = reasonSnoozed
					} else if ok {
						reason = reasonMissingWaitingAge
					}
					excludedReasons[identity] = reason
					continue
				}
				if frozen.SpellStartedAt == nil || !live.ActionableSince.Equal(*frozen.SpellStartedAt) {
					slog.Info("digest incident changed its ask between freeze and validation",
						"diagnostic", "ask_changed_after_freeze",
						"error_group_id", frozen.ErrorGroupID, "status", live.Status)
				}
				actionableEval.Included = append(actionableEval.Included, live)
				actionableEval.Candidates = append(actionableEval.Candidates, live)
			}
		} else if actionableErr == nil {
			actionableEval = evaluateActionable(actionableCandidates, frozenIncidentIDs, actionableEvaluatedAt)
		}
	}
	if actionableErr == nil {
		// The replay link is decoration on a receipt. Nothing here may fail
		// the digest: a lookup error, or a failure of the savepoint
		// bookkeeping that isolates it, abandons link enrichment for the rest
		// of the run and leaves every receipt intact and publishable.
		dashboardURL := os.Getenv("DASHBOARD_URL")
		for i := range actionableEval.Included {
			candidate := &actionableEval.Included[i]
			if _, err := tx.Exec(ctx, `SAVEPOINT actionable_replay_lookup`); err != nil {
				slog.Warn("actionable digest replay enrichment abandoned; receipts publish without links",
					"project_id", run.ProjectID, "error", err)
				break
			}
			// Bound the lookup by the moment the item became actionable. An
			// unbounded floor makes the watchable query sort the group's
			// whole event history inside the transaction that must commit
			// for the digest to be delivered, and a recording from before
			// the item was actionable is stale anyway.
			replayFloor := time.Time{}
			if candidate.ActionableSince != nil {
				replayFloor = *candidate.ActionableSince
			}
			sessionID, anchorMs, ok, lookupErr := ingestiondb.WatchableSessionForGroupOn(ctx, tx, candidate.GroupID, run.ProjectID, replayFloor)
			if lookupErr != nil {
				slog.Warn("actionable digest replay lookup failed; omitting the link", "group_id", candidate.GroupID, "project_id", run.ProjectID, "error", lookupErr)
				if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT actionable_replay_lookup`); err != nil {
					// The transaction is no longer usable for enrichment;
					// stop touching it and let the receipts lane proceed.
					slog.Warn("actionable digest replay enrichment abandoned after rollback failure",
						"project_id", run.ProjectID, "error", err)
					break
				}
			} else if ok {
				candidate.SessionURL = notify.BuildSessionURL(dashboardURL, sessionID, anchorMs)
			}
			if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT actionable_replay_lookup`); err != nil {
				slog.Warn("actionable digest replay enrichment abandoned after release failure",
					"project_id", run.ProjectID, "error", err)
				break
			}
		}
	}
	if actionableErr == nil {
		var err error
		receiptItems, err = toReceiptItems(actionableEval.Included)
		if err != nil {
			actionableErr = fmt.Errorf("map actionable receipts: %w", err)
		}
		receiptOverflow = actionableEval.Overflow
		actionableBaseReceipts = append(actionableBaseReceipts, receiptItems...)
		for _, item := range receiptItems {
			if _, ok := byIdentity[item.IncidentID]; ok {
				accounted[item.IncidentID] = "included"
			}
		}
	}
	if actionableErr == nil && run.Mode == UnifiedCardsOff {
		if err := writeActionableLedger(ctx, tx, runID, actionableEval, actionableEvaluatedAt); err != nil {
			actionableErr = err
		}
	}
	if actionableErr == nil {
		var err error
		deliveryAlert, err = reconcileActionable(actionableEval)
		if err != nil {
			actionableErr = fmt.Errorf("digest reconciliation failed: %w", err)
		}
	}
	if actionableErr != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("evaluate actionable digest candidates: %w", ctx.Err())
		}
		slog.Error("actionable digest delivery degraded", "run_id", runID, "project_id", run.ProjectID, "error", actionableErr)
		if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT actionable_delivery`); err != nil {
			return fmt.Errorf("roll back actionable delivery savepoint: %w", err)
		}
		receiptItems = nil
		receiptOverflow = 0
		if deliveryAlert == "" {
			deliveryAlert = "Actionable findings could not be evaluated for this digest."
		}
	}
	if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT actionable_delivery`); err != nil {
		return fmt.Errorf("release actionable delivery savepoint: %w", err)
	}
	if actionableErr != nil && run.Mode != UnifiedCardsOff {
		if err := rollbackUnified(actionableErr); err != nil {
			return err
		}
	}
	rebuildUnifiedFallbacks := func() {
		generated = generated[:0]
		receiptItems = append(receiptItems[:0], actionableBaseReceipts...)
		receipted := make(map[string]bool, len(receiptItems))
		for _, item := range receiptItems {
			receipted[item.IncidentID] = true
		}
		for _, candidate := range candidates {
			identity := candidateIdentity(candidate)
			// With no live state the liveness gate cannot be evaluated, and
			// judging it against an empty map would drop every frozen incident:
			// a delivery alert over an empty digest. The frozen snapshot carries
			// title, counts, status and action, so it renders the receipt and
			// the alert says the live check did not run.
			if candidate.SpellStartedAt != nil && actionableErr == nil {
				// Same rule as the gate above: a changed ask is still a
				// waiting incident, so only leaving the set or a live snooze
				// removes it.
				live, ok := actionableByGroup[candidate.ErrorGroupID]
				snoozed := ok && live.SnoozedUntil != nil && live.SnoozedUntil.After(actionableEvaluatedAt)
				if !ok || snoozed || live.ActionableSince == nil {
					accounted[identity] = "deferred"
					delete(renderModes, identity)
					reason := reasonNotPublishable
					if snoozed {
						reason = reasonSnoozed
					} else if ok {
						reason = reasonMissingWaitingAge
					}
					excludedReasons[identity] = reason
					continue
				}
			}
			renderModes[identity] = "receipt_fallback"
			if !receipted[candidate.ErrorGroupID] {
				receiptItems = append(receiptItems, receiptForUnifiedFallback(candidate))
				receipted[candidate.ErrorGroupID] = true
			}
			accounted[identity] = "included"
		}
	}
	if unifiedDegraded {
		rebuildUnifiedFallbacks()
		receiptOverflow = actionableEval.Overflow
		deliveryAlert = unifiedDeliveryAlert
	}
	// The ON lane caps its candidate set at freeze and ledgers the remainder as
	// capped_overflow. Nothing carried that count into the payload, so the
	// renderer computed an overflow of zero and the capped incidents were
	// invisible: no card, no receipt, and no "And N more" line. Read the count
	// the freeze already recorded (validation-time exclusions are written after
	// this point, so this reads exactly the frozen cap).
	frozenOverflow := 0
	if run.Mode == UnifiedCardsOn {
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM digest_run_candidate_evaluations
			WHERE digest_run_id=$1 AND outcome='excluded' AND primary_reason_code=$2`,
			runID, reasonCappedOverflow).Scan(&frozenOverflow); err != nil {
			return fmt.Errorf("count frozen digest overflow: %w", err)
		}
		overflowCount += frozenOverflow
	}
	baseOverflowCount, baseReceiptOverflow := overflowCount, receiptOverflow
	capDropped := make(map[string]bool)
	applyDeliveryCap := func() {
		var dropped []string
		generated, receiptItems, overflowCount, receiptOverflow, dropped = capDigestDelivery(
			run.Mode, generated, receiptItems, baseOverflowCount, baseReceiptOverflow,
		)
		for _, identity := range dropped {
			capDropped[identity] = true
			if _, ok := byIdentity[identity]; ok {
				accounted[identity] = "deferred"
				delete(renderModes, identity)
				overflowReasons[identity] = "digest overflow: held for the next digest"
			}
			// OFF drops only generated cards, and its receipt ledger row was
			// already written as included in this transaction: re-ledgering it
			// as excluded here would overwrite a row that main never touches.
			if run.Mode == UnifiedCardsOn {
				excludedReasons[identity] = reasonCappedOverflow
			}
		}
	}
	applyDeliveryCap()
	var unifiedLedgerErr error
	if run.Mode != UnifiedCardsOff && !unifiedDegraded {
		for _, candidate := range candidates {
			identity := candidateIdentity(candidate)
			renderMode := renderModes[identity]
			if renderMode == "" {
				continue
			}
			query := `UPDATE digest_run_candidate_evaluations SET phase='validation',render_mode=$3,
				details=details || jsonb_strip_nulls(jsonb_build_object(
				  'validated_at',$4::text,'unified_cards_mode',$5::text,
				  'receipt_reason',NULLIF($6::text,'')))
				WHERE digest_run_id=$1 AND error_group_id=$2 AND outcome='included'`
			if _, err := tx.Exec(ctx, query, runID, candidate.ErrorGroupID, renderMode,
				actionableEvaluatedAt.Format(time.RFC3339Nano), run.Mode, receiptReasons[identity]); err != nil {
				unifiedLedgerErr = fmt.Errorf("finalize unified ledger for %s: %w", identity, err)
				break
			}
		}
	}
	if unifiedLedgerErr != nil {
		if err := rollbackUnified(unifiedLedgerErr); err != nil {
			return err
		}
		for identity := range capDropped {
			delete(excludedReasons, identity)
			delete(overflowReasons, identity)
			if _, ok := byIdentity[identity]; ok {
				accounted[identity] = "included"
			}
		}
		capDropped = make(map[string]bool)
		rebuildUnifiedFallbacks()
		// The frozen cap still holds after a unified rollback: those incidents
		// are absent from this message either way, so their count stays.
		baseOverflowCount, baseReceiptOverflow = frozenOverflow, actionableEval.Overflow
		applyDeliveryCap()
		deliveryAlert = unifiedDeliveryAlert
	}
	if unifiedSavepointOpen {
		if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT unified_card_section`); err != nil {
			return fmt.Errorf("release unified card savepoint: %w", err)
		}
		unifiedSavepointOpen = false
	}
	for identity, reason := range excludedReasons {
		if _, err := tx.Exec(ctx, `UPDATE digest_run_candidate_evaluations
			SET outcome='excluded',primary_reason_code=$3,phase='validation',
			    render_mode=NULL,
			    details=details || jsonb_build_object('validation_exclusion',$3::text)
			WHERE digest_run_id=$1 AND error_group_id=$2`, runID, identity, reason); err != nil {
			return fmt.Errorf("store digest validation exclusion for %s: %w", identity, err)
		}
	}
	deliveredGenerated := make(map[string]bool, len(generated))
	for _, card := range generated {
		deliveredGenerated[card.IncidentID] = true
	}
	deliveredReceipts := make(map[string]bool, len(receiptItems))
	for _, item := range receiptItems {
		deliveredReceipts[item.IncidentID] = true
	}

	eventPayload := notify.EventPayload{
		Version: 1, EventType: "digest.daily", RunID: runID,
		Project:      notify.ProjectRef{ID: run.ProjectID, Name: run.ProjectName},
		DashboardURL: strings.TrimRight(os.Getenv("DASHBOARD_URL"), "/"),
		Digest: &notify.DigestPayload{
			Date: run.RunDate,
			Window: notify.DigestWindow{
				From: run.WindowFrom.UTC().Format(time.RFC3339Nano),
				To:   run.WindowTo.UTC().Format(time.RFC3339Nano),
			},
			SchemaVersion:   4,
			Timezone:        run.Timezone,
			GeneratedCards:  generated,
			OverflowCount:   overflowCount,
			ReceiptItems:    receiptItems,
			ReceiptOverflow: receiptOverflow,
			DeliveryAlert:   deliveryAlert,
			// The renderer budgets its cap by mode, so it must be told which
			// mode produced this payload rather than inferring it.
			UnifiedCards: run.Mode == UnifiedCardsOn,
		},
	}
	if err := eventPayload.Validate(); err != nil {
		return fmt.Errorf("validate notification payload: %w", err)
	}
	eventJSON, err := json.Marshal(eventPayload)
	if err != nil {
		return fmt.Errorf("encode notification payload: %w", err)
	}

	for identity, outcome := range accounted {
		reason := ""
		if outcome == "deferred" {
			reason = overflowReasons[identity]
			for _, item := range payload.Deferred {
				if cardIdentity(item.ErrorGroupID, item.EpisodeID) == identity {
					reason = strings.TrimSpace(item.Reason)
					break
				}
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE digest_run_items SET outcome=$4,reason=NULLIF($5,'')
			WHERE project_id=$1 AND run_id=$2 AND COALESCE(error_group_id,episode_id)=$3`,
			run.ProjectID, runID, identity, outcome, reason); err != nil {
			return fmt.Errorf("store digest item outcome: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE digest_unified_run_items SET outcome=$4,reason=NULLIF($5,'')
			WHERE project_id=$1 AND run_id=$2 AND error_group_id=$3`,
			run.ProjectID, runID, identity, outcome, reason); err != nil {
			return fmt.Errorf("store unified digest item outcome: %w", err)
		}
		candidate := byIdentity[identity]
		publishedCard := deliveredGenerated[identity] || deliveredReceipts[identity]
		// ON writes no issue_publications at all: status governs repetition and
		// the run ledger handles dedup. The episode gate belongs to OFF, which
		// still runs the one-shot lane.
		if outcome == "included" && publishedCard && run.Mode != UnifiedCardsOn && candidate.EpisodeID != "" {
			if _, err := tx.Exec(ctx, `INSERT INTO issue_publications (project_id,episode_id,channel)
				VALUES ($1,$2,'digest') ON CONFLICT DO NOTHING`, run.ProjectID, candidate.EpisodeID); err != nil {
				return fmt.Errorf("write digest receipt: %w", err)
			}
		}
	}
	var eventID string
	if err := tx.QueryRow(ctx, `INSERT INTO outbound_events (project_id,event_type,dedup_key,payload)
		VALUES ($1,'digest.daily',$2,$3::jsonb)
		ON CONFLICT (project_id,dedup_key) DO UPDATE SET dedup_key=EXCLUDED.dedup_key
		RETURNING id::text`, run.ProjectID, "digest.daily:"+run.ProjectID+":"+runID, eventJSON).Scan(&eventID); err != nil {
		return fmt.Errorf("write digest outbox event: %w", err)
	}
	deliveries, err := tx.Exec(ctx, `INSERT INTO outbound_deliveries (event_id,destination_id)
		SELECT $1,id FROM notification_destinations
		 WHERE project_id=$2 AND enabled AND 'digest.daily'=ANY(event_types)
		ON CONFLICT (event_id,destination_id) DO NOTHING`, eventID, run.ProjectID)
	if err != nil {
		return fmt.Errorf("write digest deliveries: %w", err)
	}
	if deliveries.RowsAffected() == 0 {
		return errors.New("digest has no enabled destination")
	}
	if _, err := tx.Exec(ctx, `UPDATE digest_runs SET status='delivered',rendered_payload=$2::jsonb
		WHERE id=$1`, runID, eventJSON); err != nil {
		return fmt.Errorf("complete digest run: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit digest publication: %w", err)
	}
	return nil
}

func receiptForUnifiedFallback(candidate Candidate) notify.ReceiptItem {
	state := "report_ready"
	switch {
	case candidate.SpellStartedAt != nil && candidate.Status != "":
		// ON candidates carry their live status, so the receipt line is the same
		// mechanical one prod renders today.
		state = receiptState(candidate.Status, candidate.HasSavedDiff)
	case candidate.Outcome == "verified_fix" && candidate.PRURL != "":
		state = "pr_open"
	}
	// Sanitized exactly like toReceiptItems and build.go: this item is
	// persisted in digest_runs.rendered_payload and shipped in the outbox
	// event, so the renderer cleaning prose again on the way out would not
	// un-persist a leaked secret. HasSavedDiff is carried for the same reason
	// its state is: the two constructors must emit the same item for one
	// incident.
	item := notify.ReceiptItem{
		Kind: candidate.Kind, IncidentID: candidate.ErrorGroupID,
		Title:           narrative.SanitizeExcerpt(candidate.Title, excerptMax),
		OccurrenceCount: int64(candidate.OccurrenceCount), ReceiptState: state,
		PRURL: candidate.PRURL, HasSavedDiff: candidate.HasSavedDiff,
		HasValidatedDiagnosis: candidate.HasValidatedDiagnosis,
		ActionableSince:       candidate.SpellStartedAt,
	}
	if candidate.HasValidatedDiagnosis {
		item.RootCauseExcerpt = narrative.SanitizeExcerpt(candidate.RootCause, excerptMax)
		item.MitigationExcerpt = narrative.SanitizeExcerpt(candidate.Mitigation, excerptMax)
	}
	return item
}

func loadValidationCandidates(ctx context.Context, tx pgx.Tx, projectID, runID string) ([]Candidate, error) {
	return loadFrozenCandidates(ctx, tx, projectID, runID)
}

type candidateQueryError struct{ err error }

func (e candidateQueryError) Error() string { return e.err.Error() }
func (e candidateQueryError) Unwrap() error { return e.err }

func candidateStillPublishable(ctx context.Context, tx pgx.Tx, projectID string, candidate Candidate) error {
	var open bool
	var inquiryDecision, diagnosisOutcome string
	var diagnosisDecidedAt time.Time
	if err := tx.QueryRow(ctx, `SELECT ep.closed_at IS NULL,
		(SELECT decision FROM issue_inquiry_decisions inquiry
		  WHERE inquiry.project_id=ep.project_id AND inquiry.episode_id=ep.id
		  ORDER BY inquiry.decided_at DESC,inquiry.id DESC LIMIT 1),
		(SELECT outcome FROM diagnosis_decisions diagnosis
		  WHERE diagnosis.project_id=ep.project_id AND diagnosis.episode_id=ep.id
		  ORDER BY diagnosis.decided_at DESC,diagnosis.id DESC LIMIT 1),
		(SELECT decided_at FROM diagnosis_decisions diagnosis
		  WHERE diagnosis.project_id=ep.project_id AND diagnosis.episode_id=ep.id
		  ORDER BY diagnosis.decided_at DESC,diagnosis.id DESC LIMIT 1)
		FROM issue_episodes ep WHERE ep.project_id=$1 AND ep.id=$2
		  AND ep.canonical_issue_id=$3`, projectID, candidate.EpisodeID, candidate.IssueID).Scan(
		&open, &inquiryDecision, &diagnosisOutcome, &diagnosisDecidedAt,
	); err != nil {
		return candidateQueryError{fmt.Errorf("candidate %s is stale or unknown: %w", candidate.EpisodeID, err)}
	}
	if !open {
		return fmt.Errorf("candidate %s is stale because its episode closed", candidate.EpisodeID)
	}
	if inquiryDecision != "investigate" || diagnosisOutcome != candidate.Outcome || !diagnosisDecidedAt.Equal(candidate.DecidedAt) {
		return fmt.Errorf("candidate %s is stale because its latest decision changed", candidate.EpisodeID)
	}
	return nil
}

func equalStringSet(left, right []string) bool {
	a, b := append([]string(nil), left...), append([]string(nil), right...)
	sort.Strings(a)
	sort.Strings(b)
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func firstUngroundedNumber(card writtenDigestCard, candidate Candidate) (string, bool) {
	allowed := map[string]struct{}{
		strconv.Itoa(candidate.AffectedUsers):   {},
		strconv.Itoa(candidate.OccurrenceCount): {},
	}
	// Session counts are real facts only for narrative-backed cards. Error-kind
	// candidates carry them as COALESCE-0, and whitelisting those would ground
	// the digit '0' on every card, letting invented zero-claims publish.
	if candidate.ObservationQuote != "" {
		allowed[strconv.Itoa(candidate.SessionCount)] = struct{}{}
		allowed[strconv.Itoa(candidate.IdentifiedCount)] = struct{}{}
	}
	// The prompt orders the writer to copy account names and links exactly, so
	// digits inside them ("42Floors", PR #42) must be grounded facts — without
	// this, a faithfully copied account name fails the entire day's digest.
	if number := prNumber(candidate.PRURL); number > 0 {
		allowed[strconv.Itoa(number)] = struct{}{}
	}
	// The renderer no longer prints the measured impact as a counts line, so the
	// card's own prose carries it. Both numbers are frozen facts, refreshed on
	// every freeze, so a card that names them is grounded and one that invents a
	// visit count is not.
	if candidate.ImpactVisits != nil {
		allowed[strconv.FormatInt(*candidate.ImpactVisits, 10)] = struct{}{}
	}
	if candidate.ImpactRecovered != nil {
		allowed[strconv.FormatInt(*candidate.ImpactRecovered, 10)] = struct{}{}
	}
	// RootCause is listed in its own right, not left to the Summary alias: the
	// alias holds the cause only while it is non-empty, and the Why sentence is
	// written from the cause, so its digits must ground on the cause itself.
	sources := []string{candidate.Title, candidate.Summary, candidate.RootCause, candidate.ValidAction,
		candidate.RoutePurpose, candidate.Route, candidate.ObservationQuote}
	sources = append(sources, candidate.Accounts...)
	for _, source := range sources {
		for _, number := range proseNumber.FindAllString(normalizeProseNumbers(source), -1) {
			allowed[number] = struct{}{}
		}
	}
	for _, field := range []string{card.Title, card.Copy, card.Why, card.Action} {
		for _, number := range proseNumber.FindAllString(normalizeProseNumbers(field), -1) {
			if _, ok := allowed[number]; !ok {
				return number, true
			}
		}
	}
	return "", false
}

func truncateRunes(value string, limit int) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit])
}

// prNumber extracts the pull-request number, or 0. It reuses the same path
// shape projectPullRequest validates.
func prNumber(prURL string) int {
	u, err := url.Parse(prURL)
	if err != nil {
		return 0
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 4 || parts[2] != "pull" {
		return 0
	}
	n, err := strconv.Atoi(parts[3])
	if err != nil {
		return 0
	}
	return n
}

func projectPullRequest(raw, repo string) bool {
	u, err := url.Parse(raw)
	if err != nil || !strings.EqualFold(u.Scheme, "https") || !strings.EqualFold(u.Hostname(), "github.com") {
		return false
	}
	repo = strings.TrimSuffix(strings.TrimSpace(repo), ".git")
	if parsed, err := url.Parse(repo); err == nil && parsed.Host != "" {
		repo = strings.Trim(parsed.Path, "/")
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	return len(parts) == 4 &&
		strings.EqualFold(parts[0]+"/"+parts[1], strings.Trim(repo, "/")) &&
		parts[2] == "pull" && parts[3] != ""
}
