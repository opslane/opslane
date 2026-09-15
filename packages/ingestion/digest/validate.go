package digest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	ingestiondb "github.com/opslane/opslane/packages/ingestion/db"
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
	Steps              string   `json:"steps,omitempty"`
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
// spends one cap across decisions, receipts and fixes. Since #496 an ON run
// carries no receipts, so in practice its cap covers generated cards alone.
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
// actionable set. It is a variable so a test can inject the database failure
// that OFF degrades around and ON retries; production always uses the real
// query.
var loadActionableCandidatesForValidation = func(ctx context.Context, tx pgx.Tx, projectID string, status actionableStatusSet, evaluatedAt time.Time) ([]actionableCandidate, error) {
	return loadActionableCandidates(ctx, tx, projectID, status, evaluatedAt)
}

// ValidateAndPublish rechecks model output against the immutable snapshots and
// publishes the run, its outbox event and deliveries (and, in OFF, its receipts)
// atomically.
func ValidateAndPublish(ctx context.Context, pool *pgxpool.Pool, runID string, secret ...[]byte) error {
	key := []byte(os.Getenv("JWT_SECRET"))
	if len(secret) > 0 {
		key = secret[0]
	}
	err := validateAndPublish(ctx, pool, runID, key)
	if err != nil && !transientDatabaseError(err) {
		// Validation and transactional failures leave no publication side effects.
		// Marking failed separately lets the scheduler re-enqueue the same frozen run.
		// A transient database failure leaves the run written or validated
		// instead, so the next tick validates the same writer payload again
		// rather than buying a rewrite.
		_, _ = pool.Exec(ctx, `UPDATE digest_runs SET status='failed'
			WHERE id=$1 AND status NOT IN ('delivered')`, runID)
	}
	return err
}

// transientDatabaseError says whether a publication failure came from the
// database being briefly unavailable or contended, not from the digest. Only
// those are worth retrying unchanged: connection loss (08), transaction
// rollbacks such as serialization failures and deadlocks (40), exhausted
// resources (53), operator intervention such as a shutdown (57), and network
// timeouts or a dropped connection (EOF). Everything else, including a
// malformed payload, a query bug, or a protocol violation (08P01, which a
// client bug reproduces on every retry), fails the run so the writer gets
// another turn.
func transientDatabaseError(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && len(pgErr.Code) >= 2 {
		if pgErr.Code == "08P01" {
			return false
		}
		switch pgErr.Code[:2] {
		case "08", "40", "53", "57":
			return true
		}
	}
	if pgconn.Timeout(err) || pgconn.SafeToRetry(err) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, context.DeadlineExceeded)
}

// internalVocabulary matches pipeline state words as whole tokens. The customer
// message may never carry them; validation fails closed when a writer leaks one.
var internalVocabulary = regexp.MustCompile(`(?i)(^|[^a-z0-9_])(needs_human|verified_fix|report_ready|do_not_pursue|unable_to_establish_cause)($|[^a-z0-9_])`)

// provenanceVocabulary matches the confirmer's evidence language when it leaks
// into customer prose: timeline line ids (L23, L29-L38, line 12) and the names
// of the verification material. A production replay shipped both in card copy.
// The worker's note validator uses the same alternation, so a note that passed
// confirmation cannot sink its card here.
var provenanceVocabulary = regexp.MustCompile(`(?i)\bL\d+(?:\s*[-\x{2013}]\s*L?\d+)?\b|\b(?:timelines?|screenshots?|frames?)\b|\bline\s+\d+\b`)

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
// validator rejects stays current and holds its card back every day forever;
// with it, tomorrow's run re-authors.
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
		// The transaction is about to be abandoned; another statement on it
		// would only fail again and hide the original error.
		return validated, renderMode, err
	}
	if retireErr := retireRejectedCachedCard(ctx, tx, run, candidate); retireErr != nil {
		return validated, renderMode, unifiedInfrastructureError{retireErr}
	}
	slog.Warn("rejected digest card cache retired", "diagnostic", "cache_rejected",
		"error_group_id", candidate.ErrorGroupID, "error", err)
	return validated, renderMode, err
}

// retireRejectedCachedCard invalidates the cache row a candidate was frozen
// with. The caller guarantees candidate.CachedCard and SpellStartedAt are set.
// Keyed by the full primary key, never by group alone: a concurrent writer may
// already have retired this row and made a newer one current, and a late
// validator must not clobber that replacement.
func retireRejectedCachedCard(ctx context.Context, tx pgx.Tx, run validationRun, candidate Candidate) error {
	if _, err := tx.Exec(ctx, `UPDATE digest_card_copy SET invalidated_at=now()
		WHERE error_group_id=$1 AND spell_started_at=$2 AND authored_at=$3
		  AND invalidated_at IS NULL
		  AND EXISTS (SELECT 1 FROM error_groups g
		    WHERE g.id=digest_card_copy.error_group_id AND g.project_id=$4)`,
		candidate.ErrorGroupID, *candidate.SpellStartedAt,
		candidate.CachedCard.AuthoredAt, run.ProjectID); err != nil {
		return fmt.Errorf("retire rejected digest card cache for %s: %w", candidate.ErrorGroupID, err)
	}
	return nil
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
	card.Steps = stripInvisible(card.Steps)
	if candidate.PromptVersion >= 7 && card.Steps == "" {
		card.Steps = stripInvisible(candidate.Steps)
	}
	card.Action = stripInvisible(card.Action)
	// The instruction line has exactly one correct value, so the model does not
	// own it: overwrite rather than compare. Demoting a good card over wording
	// would waste the authoring call and hold the card back.
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
	// The reverse also holds: the why answers to the stored cause and nothing
	// else, so with no stored cause there is nothing for the sentence to be
	// checked against and it must not publish.
	if strings.TrimSpace(card.Why) != "" && strings.TrimSpace(candidate.RootCause) == "" {
		return card, "", fmt.Errorf("cause sentence for %s has no stored cause to answer to", identity)
	}
	if internalVocabulary.MatchString(card.Title) || internalVocabulary.MatchString(card.Copy) ||
		internalVocabulary.MatchString(card.Why) || internalVocabulary.MatchString(card.Action) || internalVocabulary.MatchString(card.Steps) {
		return card, "", fmt.Errorf("internal vocabulary in card for %s", identity)
	}
	if provenanceVocabulary.MatchString(card.Title) || provenanceVocabulary.MatchString(card.Copy) ||
		provenanceVocabulary.MatchString(card.Why) || provenanceVocabulary.MatchString(card.Steps) {
		return card, "", fmt.Errorf("evidence provenance language in card for %s", identity)
	}
	// The steps cap bounds writer prose. Steps equal to the ticket's own
	// confirmed notes (substituted above, or echoed back from a cached card) are
	// not authored, and cards no longer render them.
	authoredSteps := card.Steps
	if candidate.PromptVersion >= 7 && card.Steps == stripInvisible(candidate.Steps) {
		authoredSteps = ""
	}
	if len([]rune(strings.TrimSpace(card.Title))) > 80 || len([]rune(card.Copy)) > 300 ||
		len([]rune(card.Why)) > 300 || len([]rune(card.Action)) > 300 || len([]rune(authoredSteps)) > 600 {
		return card, "", fmt.Errorf("card length exceeded for %s", identity)
	}
	// Copy and action are digit-free. The renderer prints the measured scale
	// mechanically under the copy, so a number written into the prose is either
	// a duplicate of that line or a stale value repeated from a cached card the
	// day its facts moved. The action is state-stamped and has no number to
	// state at all. The why sentence is exempt and grounds below: a cause can
	// legitimately name a timeout or a status code.
	if candidate.PromptVersion < 7 && (containsDigit(card.Copy) || containsDigit(card.Action)) {
		return card, "", fmt.Errorf("authored copy/action contains a numeric glyph for %s", identity)
	}
	if candidate.PromptVersion >= 7 {
		card.Label = candidate.Label
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
	current, err := candidateStillUnified(ctx, tx, run.ProjectID, candidate, run.WindowTo)
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
		if card.Title != cached.Title || card.Copy != cached.Copy || card.Why != cached.Why || card.Steps != cached.Steps ||
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

// candidateStillUnified re-checks a frozen candidate. Verified ticket evidence
// is judged at the run's frozen evaluation time (window_to): the seven-day
// window must not slide between freeze and publication and flip coverage.
func candidateStillUnified(ctx context.Context, tx pgx.Tx, projectID string, frozen Candidate, evaluatedAt time.Time) (bool, error) {
	if frozen.TicketID != "" {
		facts, err := ingestiondb.LoadTicketDigestFacts(ctx, tx, projectID, frozen.ErrorGroupID, evaluatedAt)
		if err != nil {
			return false, unifiedInfrastructureError{err}
		}
		if facts == nil || !facts.OnCard() || facts.TicketID != frozen.TicketID || facts.Generation != frozen.Generation || facts.EvidenceVersion != frozen.EvidenceVersion || facts.Steps != frozen.Steps || ticketDigestAction(facts.FixSubstate) != frozen.ValidAction {
			return false, nil
		}
		var cause, title string
		var snooze *time.Time
		if err := tx.QueryRow(ctx, `SELECT coalesce(root_cause,''),title,snoozed_until FROM error_groups WHERE id=$1 AND project_id=$2`, frozen.ErrorGroupID, projectID).Scan(&cause, &title, &snooze); err != nil {
			return false, unifiedInfrastructureError{err}
		}
		return cause == frozen.RootCause && title == frozen.Title && (snooze == nil || !snooze.After(time.Now())), nil
	}

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
	var hasValidatedDiagnosis, hasSavedDiff, fixAttempted bool
	var snoozedUntil, actionableSince *time.Time
	if err := tx.QueryRow(ctx, `SELECT g.status::text,g.title,COALESCE(g.signal_type,''),
		COALESCE(g.root_cause,''),COALESCE(g.suggested_mitigation,''),
		md5(COALESCE(g.candidate_diff,'')),NULLIF(btrim(g.candidate_diff),'') IS NOT NULL,
		g.snoozed_until,g.actionable_since,
		COALESCE((SELECT rm.purpose FROM route_map rm
		 WHERE rm.project_id=g.project_id AND g.page_url_normalized LIKE '%' || rm.pattern || '%'
		 ORDER BY length(rm.pattern) DESC LIMIT 1),''),COALESCE(g.pr_url,''),
		COALESCE(g.remediation,''),COALESCE(g.reason_message,''),
		validity.has_validated_diagnosis,`+fixAttemptedSQL("g")+`
		FROM error_groups g
		LEFT JOIN LATERAL (`+diagnosisValidationLateralSQL+`) validity ON true
		WHERE g.project_id=$1 AND g.id=$2`, projectID, frozen.ErrorGroupID).Scan(
		&status, &title, &signalType, &rootCause, &mitigation, &diffIdentity, &hasSavedDiff,
		&snoozedUntil, &actionableSince, &routePurpose, &prURL, &remediation, &reasonMessage,
		&hasValidatedDiagnosis, &fixAttempted,
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
		current.HasSavedDiff, current.FixAttempted = hasSavedDiff, fixAttempted
		current.ValidAction = digestAction(status, hasSavedDiff, prURL, fixAttempted)
		current.Outcome = onCardOutcome(status)
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

// ticketStillOnCard says whether a frozen ticket candidate's live facts still
// describe the card that was frozen: the same ticket is still on the card, and
// neither its publication generation nor its evidence moved since the freeze.
func ticketStillOnCard(frozen Candidate, live actionableCandidate) bool {
	facts := live.TicketFacts
	return facts != nil && facts.OnCard() && facts.TicketID == frozen.TicketID &&
		facts.Generation == frozen.Generation && facts.EvidenceVersion == frozen.EvidenceVersion
}

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
		(error_group_id,spell_started_at,input_fingerprint,title,copy,why,action,model,prompt_version,steps)
		SELECT $1,$2,$3,$4,$5,NULLIF($6,''),$7,'digest-writer',$8,NULLIF($10,'')
		FROM error_groups g WHERE g.id=$1 AND g.project_id=$9
		ON CONFLICT (error_group_id,spell_started_at) WHERE invalidated_at IS NULL DO NOTHING`,
		candidate.ErrorGroupID, *candidate.SpellStartedAt, candidate.Fingerprint,
		strings.TrimSpace(card.Title), strings.TrimSpace(card.Copy), strings.TrimSpace(card.Why),
		strings.TrimSpace(card.Action), digestPromptVersion, run.ProjectID, strings.TrimSpace(card.Steps))
	if err != nil {
		return card, "", unifiedInfrastructureError{fmt.Errorf("cache validated digest card for %s: %w", candidate.ErrorGroupID, err)}
	}
	if command.RowsAffected() == 0 {
		var winner, title, copy, why, action, steps string
		if err := tx.QueryRow(ctx, `SELECT c.input_fingerprint,c.title,c.copy,COALESCE(c.why,''),c.action,COALESCE(c.steps,'')
			FROM digest_card_copy c JOIN error_groups g ON g.id=c.error_group_id
			WHERE g.project_id=$1 AND c.error_group_id=$2 AND c.spell_started_at=$3
			  AND c.invalidated_at IS NULL`, run.ProjectID, candidate.ErrorGroupID,
			*candidate.SpellStartedAt).Scan(&winner, &title, &copy, &why, &action, &steps); err != nil {
			return card, "", unifiedInfrastructureError{fmt.Errorf("load digest cache winner for %s: %w", candidate.ErrorGroupID, err)}
		}
		if winner == candidate.Fingerprint {
			card.Title, card.Copy, card.Why, card.Action, card.Steps = title, copy, why, action, steps
			return card, "cached", nil
		} else {
			slog.Warn("digest cache conflict", "diagnostic", "cache_conflict",
				"error_group_id", candidate.ErrorGroupID, "run_mode", run.Mode,
				"candidate_fingerprint", candidate.Fingerprint, "winner_fingerprint", winner)
		}
	}
	return card, "authored", nil
}

func validateAndPublish(ctx context.Context, pool *pgxpool.Pool, runID string, secret []byte) error {
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
	accounted := make(map[string]string, len(candidates))
	renderModes := make(map[string]string, len(candidates))
	// Why a card-eligible incident was held back: the validation error or the
	// writer's own deferral reason. Stored as the ledger's details.held_reason.
	heldReasons := make(map[string]string, len(candidates))
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
			validated, mode, validationErr := validateUnifiedWrittenCard(ctx, tx, run, card, candidate)
			if validationErr != nil {
				var infrastructureError unifiedInfrastructureError
				if errors.As(validationErr, &infrastructureError) {
					// A database failure is not this card's fault, so it fails the
					// whole attempt; ValidateAndPublish decides retry or failed.
					return fmt.Errorf("validate digest card %s: %w", identity, validationErr)
				}
				slog.Warn("digest card held back", "diagnostic", "card_held_back", "run_id", runID,
					"error_group_id", candidate.ErrorGroupID, "error", validationErr)
				accounted[identity] = "deferred"
				var changedError unifiedCandidateChangedError
				if (candidate.SpellStartedAt == nil || candidate.TicketID != "") && errors.As(validationErr, &changedError) {
					excludedReasons[identity] = reasonNotPublishable
					continue
				}
				excludedReasons[identity] = reasonCardHeldBack
				heldReasons[identity] = validationErr.Error()
				continue
			}
			card = validated
			renderModes[identity] = mode
			replayURL := notify.BuildSessionURL(os.Getenv("DASHBOARD_URL"), candidate.ReplaySessionID, candidate.ReplayAnchorMs)
			generated = append(generated, notify.GeneratedDigestCard{
				EpisodeID: candidate.EpisodeID, IncidentID: candidate.ErrorGroupID, Kind: candidate.Kind,
				TicketID: candidate.TicketID, Generation: candidate.Generation, Steps: strings.TrimSpace(card.Steps), VerifiedUsers: candidate.VerifiedUsers, VerifiedSessions: candidate.VerifiedSessions, Coverage: candidate.Coverage,
				Title: strings.TrimSpace(card.Title), Label: candidate.Label, Outcome: candidate.Outcome,
				Copy: strings.TrimSpace(card.Copy), Why: strings.TrimSpace(card.Why),
				Action:        strings.TrimSpace(card.Action),
				AffectedUsers: candidate.AffectedUsers,
				// Today's measured impact, not the prose's: the copy above may
				// have been authored days ago and cached, while these roll
				// every morning. The renderer prints them under it.
				ImpactVisits: candidate.ImpactVisits, ImpactRecovered: candidate.ImpactRecovered,
				OccurrenceCount: candidate.OccurrenceCount,
				SignalCount:     int64(candidate.OccurrenceCount), Accounts: candidate.Accounts,
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
		accounted[identity] = "deferred"
		if run.Mode != UnifiedCardsOff {
			excludedReasons[identity] = reasonCardHeldBack
			heldReasons[identity] = strings.TrimSpace(item.Reason)
			// A leaked pipeline word is the writer's fault in one sentence, not a
			// reason to lose every sibling card; the ledger records the fact
			// without storing the word.
			if internalVocabulary.MatchString(item.Reason) {
				heldReasons[identity] = "the writer's deferral reason used internal vocabulary"
			}
			// The worker re-grounds a cached card and defers it when that fails,
			// so a rejected cache row can arrive here instead of through the card
			// loop. Retire it the same way, or the incident stays held back until
			// its fingerprint moves.
			if candidate.CachedCard != nil && candidate.SpellStartedAt != nil {
				if err := retireRejectedCachedCard(ctx, tx, run, candidate); err != nil {
					return err
				}
				slog.Warn("deferred digest card cache retired", "diagnostic", "cache_rejected",
					"error_group_id", candidate.ErrorGroupID, "reason", heldReasons[identity])
			}
			continue
		}
		if internalVocabulary.MatchString(item.Reason) {
			return fmt.Errorf("internal vocabulary in deferred reason for episode %s", item.EpisodeID)
		}
	}
	for _, candidate := range candidates {
		identity := candidateIdentity(candidate)
		if accounted[identity] == "" {
			if run.Mode != UnifiedCardsOff {
				accounted[identity] = "deferred"
				excludedReasons[identity] = reasonCardHeldBack
				heldReasons[identity] = "the writer did not account for this incident"
				continue
			}
			return fmt.Errorf("candidate %s was not accounted for", identity)
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
	receiptItems := []notify.ReceiptItem(nil)
	receiptOverflow := 0
	deliveryAlert := ""
	var actionableEvaluatedAt time.Time
	actionableByGroup := make(map[string]actionableCandidate)
	if run.Mode == UnifiedCardsOn {
		if err := tx.QueryRow(ctx, `SELECT transaction_timestamp()`).Scan(&actionableEvaluatedAt); err != nil {
			return fmt.Errorf("load actionable evaluation clock: %w", err)
		}
		live, err := loadActionableCandidatesForValidation(ctx, tx, run.ProjectID, onCardStatusSQL, run.WindowTo)
		if err != nil {
			return fmt.Errorf("reload actionable digest candidates: %w", err)
		}
		for _, candidate := range live {
			actionableByGroup[candidate.GroupID] = candidate
		}
		// A held-back incident whose state moved since the freeze is ledgered as
		// that move, not as a card failure: card_held_back means the incident
		// is still waiting and still card-eligible, and only its card failed.
		for identity, reason := range excludedReasons {
			if reason != reasonCardHeldBack {
				continue
			}
			frozen := byIdentity[identity]
			current, ok := actionableByGroup[frozen.ErrorGroupID]
			switch {
			case !ok:
				excludedReasons[identity] = reasonNotPublishable
			case current.SnoozedUntil != nil && current.SnoozedUntil.After(actionableEvaluatedAt):
				excludedReasons[identity] = reasonSnoozed
			case current.ActionableSince == nil:
				excludedReasons[identity] = reasonMissingWaitingAge
			case frozen.TicketID != "" && !ticketStillOnCard(frozen, current):
				excludedReasons[identity] = reasonNotPublishable
			case !actionablePublishable(current):
				excludedReasons[identity] = reasonNotPublishable
			default:
				continue
			}
			delete(heldReasons, identity)
		}
	} else {
		// Actionable receipts and their candidate ledger are one publication unit:
		// ledger "included" plus this run's delivered status is the durable receipt
		// publication record. Episode-keyed issue_publications remains owned by the
		// frozen lane above. A savepoint keeps failures in this additive lane from
		// suppressing otherwise valid frozen cards.
		//
		// The cross-lane dedup set is built from the PRE-truncation card list: a
		// card deferred past the render cap is re-admitted to tomorrow's frozen
		// digest, and letting today's receipt lane also deliver it would show the
		// same incident twice across two days while today's overflow count
		// contradicts the receipts below it.
		frozenIncidentIDs := make(map[string]bool, len(generated))
		for _, card := range generated {
			frozenIncidentIDs[card.IncidentID] = true
		}
		if _, err := tx.Exec(ctx, `SAVEPOINT actionable_delivery`); err != nil {
			return fmt.Errorf("open actionable delivery savepoint: %w", err)
		}
		var actionableErr error
		if err := tx.QueryRow(ctx, `SELECT transaction_timestamp()`).Scan(&actionableEvaluatedAt); err != nil {
			actionableErr = fmt.Errorf("load actionable evaluation clock: %w", err)
		}
		var actionableEval evaluation
		if actionableErr == nil {
			actionableCandidates, err := loadActionableCandidatesForValidation(ctx, tx, run.ProjectID, m1ActionableStatusSQL, run.WindowTo)
			if err != nil {
				actionableErr = err
			} else {
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
				if candidate.TicketFacts != nil {
					candidate.SessionURL = notify.BuildSessionURL(dashboardURL, candidate.TicketFacts.RepresentativeSessionID, candidate.TicketFacts.RepresentativeAnchorMs)
					continue
				}
				if _, err := tx.Exec(ctx, `SAVEPOINT actionable_replay_lookup`); err != nil {
					slog.Warn("actionable digest replay enrichment abandoned; receipts publish without links",
						"project_id", run.ProjectID, "error", err)
					break
				}
				// Prefer a recording from the current spell; fall back to the
				// incident's history when the spell is too young to have one
				// (see watchableSessionAnySpell for why that is bounded).
				replayFloor := time.Time{}
				if candidate.ActionableSince != nil {
					replayFloor = *candidate.ActionableSince
				}
				sessionID, anchorMs, ok, lookupErr := watchableSessionAnySpell(ctx, tx, candidate.GroupID, run.ProjectID, replayFloor)
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
			for _, item := range receiptItems {
				if _, ok := byIdentity[item.IncidentID]; ok {
					accounted[item.IncidentID] = "included"
				}
			}
		}
		if actionableErr == nil {
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
	}
	baseOverflowCount, baseReceiptOverflow := overflowCount, receiptOverflow
	applyDeliveryCap := func() {
		var dropped []string
		generated, receiptItems, overflowCount, receiptOverflow, dropped = capDigestDelivery(
			run.Mode, generated, receiptItems, baseOverflowCount, baseReceiptOverflow,
		)
		for _, identity := range dropped {
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
	if run.Mode != UnifiedCardsOff {
		for _, candidate := range candidates {
			identity := candidateIdentity(candidate)
			renderMode := renderModes[identity]
			if renderMode == "" {
				continue
			}
			if _, err := tx.Exec(ctx, `UPDATE digest_run_candidate_evaluations SET phase='validation',render_mode=$3,
				details=details || jsonb_build_object('validated_at',$4::text,'unified_cards_mode',$5::text)
				WHERE digest_run_id=$1 AND error_group_id=$2 AND outcome='included'`,
				runID, candidate.ErrorGroupID, renderMode,
				actionableEvaluatedAt.Format(time.RFC3339Nano), run.Mode); err != nil {
				return fmt.Errorf("finalize unified ledger for %s: %w", identity, err)
			}
		}
	}
	schemaVersion := 4
	fresh := run.Mode == UnifiedCardsOn
	for _, candidate := range candidates {
		if candidate.PromptVersion < 7 {
			fresh = false
		}
	}
	var merged []notify.DigestPRMerged
	if fresh {
		schemaVersion = 5
		var err error
		merged, err = mergedThisWeek(ctx, tx, run.ProjectID, run.WindowTo)
		if err != nil {
			return fmt.Errorf("load merged this week: %w", err)
		}
	}
	if fresh {
		currentAction := func(group, action string) (actionableCandidate, error) {
			frozen := byIdentity[group]
			live, ok := actionableByGroup[group]
			if !ok || !ticketStillOnCard(frozen, live) || ticketDigestAction(live.TicketFacts.FixSubstate) != action {
				return actionableCandidate{}, unifiedCandidateChangedError{identity: group}
			}
			// Authored prose must still match the freeze.
			if live.TicketFacts.Steps != frozen.Steps || action != frozen.ValidAction || live.Title != frozen.Title || live.RootCause != frozen.RootCause {
				return actionableCandidate{}, unifiedCandidateChangedError{identity: group}
			}
			return live, nil
		}
		// A secret that cannot sign (unset or under 32 bytes) costs a card its
		// fix link, never the digest: the card still links to its issue page.
		warnedUnsigned := false
		signedFixURL := func(group, ticket string, generation int, latestAttempt string) string {
			actionURL, signErr := ticketFixActionURL(os.Getenv("DASHBOARD_URL"), run.ProjectID, group, ticket, generation, latestAttempt, secret, time.Now())
			if signErr != nil {
				if !warnedUnsigned {
					slog.Warn("digest fix links unavailable; publishing without them",
						"diagnostic", "fix_link_unsigned", "project_id", run.ProjectID, "digest_run_id", runID, "error", signErr)
					warnedUnsigned = true
				}
				return ""
			}
			return actionURL
		}
		excludeStaleAction := func(identity string, actionErr error) bool {
			var changed unifiedCandidateChangedError
			if !errors.As(actionErr, &changed) {
				return false
			}
			accounted[identity] = "deferred"
			excludedReasons[identity] = reasonNotPublishable
			delete(renderModes, identity)
			return true
		}
		keptGenerated := generated[:0]
		for _, card := range generated {
			if card.TicketID != "" {
				var live actionableCandidate
				live, err = currentAction(card.IncidentID, card.Action)
				if err != nil {
					if excludeStaleAction(card.IncidentID, err) {
						continue
					}
					return err
				}
				if card.Action == "Create fix PR" {
					// Attempt lineage is mechanical action state. A fix can complete
					// during authoring without changing any of the authored facts.
					card.ActionURL = signedFixURL(card.IncidentID, card.TicketID, card.Generation, live.TicketFacts.LatestAttemptID)
				} else if card.Action == "Review PR" {
					// The PR link is mechanical lifecycle state and may change while
					// the authored prose is being validated.
					card.PRURL = live.PRURL
					card.PRNumber = prNumber(live.PRURL)
				}
			}
			keptGenerated = append(keptGenerated, card)
		}
		generated = keptGenerated
	}

	for identity, reason := range excludedReasons {
		if _, err := tx.Exec(ctx, `UPDATE digest_run_candidate_evaluations
			SET outcome='excluded',primary_reason_code=$3,phase='validation',
			    render_mode=NULL,
			    details=details || jsonb_strip_nulls(jsonb_build_object(
			      'validation_exclusion',$3::text,'held_reason',NULLIF($4::text,'')))
			WHERE digest_run_id=$1 AND error_group_id=$2`, runID, identity, reason, heldReasons[identity]); err != nil {
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

	if run.Mode == UnifiedCardsOn {
		// A v5 digest shows what a reader can act on and nothing else.
		overflowCount, receiptOverflow = 0, 0
	}
	// With no card to send there is no message. The run still finishes, with its
	// ledger committed (so a rejected cached card stays retired) and its empty
	// payload stored, so the read API and MCP report today's digest as empty
	// instead of resurfacing yesterday's cards.
	send := run.Mode != UnifiedCardsOn || len(generated) > 0
	if !send {
		if len(heldReasons) > 0 {
			// Every card that could have shipped failed its checks. One day of
			// this is a bad writer run; a streak is a broken card lane, and this
			// line is the only place it shows outside the ledger.
			slog.Warn("digest held back every card", "diagnostic", "digest_all_cards_held_back",
				"run_id", runID, "project_id", run.ProjectID, "held_back", len(heldReasons))
		} else {
			slog.Info("digest has no card to send", "diagnostic", "digest_nothing_to_send",
				"run_id", runID, "project_id", run.ProjectID)
		}
		// The merged-PR footer only accompanies cards; alone it would make the
		// stored digest read as non-empty to the read API and MCP.
		merged = nil
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
			SchemaVersion:   schemaVersion,
			MergedThisWeek:  merged,
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
			// Precedence: the writer's own deferral reason, then why validation
			// held the card back, then the render cap.
			reason = overflowReasons[identity]
			if held := heldReasons[identity]; held != "" {
				reason = held
			}
			for _, item := range payload.Deferred {
				// A reason carrying internal vocabulary already failed an OFF run;
				// in ON its held reason above stands in for it.
				if cardIdentity(item.ErrorGroupID, item.EpisodeID) == identity && !internalVocabulary.MatchString(item.Reason) {
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
	if send {
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
	if candidate.PromptVersion >= 7 {
		return firstUngroundedV7Number(card, candidate)
	}
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
	// The measured impact is deliberately absent. The renderer owns those two
	// numbers now, so a card naming one is either repeating the line printed
	// under it or replaying a cached day's value; either way it does not ship.
	sources := []string{candidate.Title, candidate.Summary, candidate.RootCause, candidate.ValidAction,
		candidate.RoutePurpose, candidate.Route, candidate.ObservationQuote}
	sources = append(sources, candidate.Accounts...)
	for _, source := range sources {
		for _, number := range proseNumber.FindAllString(normalizeProseNumbers(source), -1) {
			allowed[number] = struct{}{}
		}
	}
	for _, field := range []string{card.Title, card.Copy, card.Action} {
		for _, number := range proseNumber.FindAllString(normalizeProseNumbers(field), -1) {
			if _, ok := allowed[number]; !ok {
				return number, true
			}
		}
	}
	// The cause sentence grounds against the stored cause alone, not the pooled
	// set. The why is written from RootCause and nothing else, so a digit it
	// borrowed from an account name or an occurrence count is invented as far as
	// the cause is concerned.
	cause := make(map[string]struct{})
	for _, number := range proseNumber.FindAllString(normalizeProseNumbers(candidate.RootCause), -1) {
		cause[number] = struct{}{}
	}
	for _, number := range proseNumber.FindAllString(normalizeProseNumbers(card.Why), -1) {
		if _, ok := cause[number]; !ok {
			return number, true
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
