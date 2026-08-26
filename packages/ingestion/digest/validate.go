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
	"github.com/opslane/opslane/packages/ingestion/notify"
)

type writtenDigestPayload struct {
	Included []writtenDigestCard  `json:"included"`
	Deferred []deferredDigestItem `json:"deferred"`
}

type writtenDigestCard struct {
	EpisodeID          string   `json:"episodeId"`
	Title              string   `json:"title,omitempty"`
	Copy               string   `json:"copy"`
	Action             string   `json:"action"`
	Label              string   `json:"label"`
	ClaimedUsers       *int     `json:"claimedUsers,omitempty"`
	ClaimedOccurrences *int     `json:"claimedOccurrences,omitempty"`
	Accounts           []string `json:"accounts,omitempty"`
	PRURL              string   `json:"prUrl,omitempty"`
}

type deferredDigestItem struct {
	EpisodeID string `json:"episodeId"`
	Reason    string `json:"reason"`
}

type validationRun struct {
	ProjectID   string
	ProjectName string
	GithubRepo  string
	Status      string
	RunDate     string
	WindowFrom  time.Time
	WindowTo    time.Time
	Payload     []byte
}

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

func validateAndPublish(ctx context.Context, pool *pgxpool.Pool, runID string) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin digest publication: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var run validationRun
	if err := tx.QueryRow(ctx, `
		SELECT r.project_id::text,p.name,COALESCE(p.github_repo,''),r.status,
		       r.run_date::text,r.window_from,r.window_to,COALESCE(r.writer_payload,r.payload)
		  FROM digest_runs r JOIN projects p ON p.id=r.project_id
		 WHERE r.id=$1 FOR UPDATE OF r`, runID).Scan(
		&run.ProjectID, &run.ProjectName, &run.GithubRepo, &run.Status,
		&run.RunDate, &run.WindowFrom, &run.WindowTo, &run.Payload,
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
	byEpisode := make(map[string]Candidate, len(candidates))
	for _, candidate := range candidates {
		byEpisode[candidate.EpisodeID] = candidate
	}
	accounted := make(map[string]string, len(candidates))
	generated := make([]notify.GeneratedDigestCard, 0, len(payload.Included))
	for _, card := range payload.Included {
		candidate, ok := byEpisode[card.EpisodeID]
		if !ok {
			return fmt.Errorf("unknown episode %s", card.EpisodeID)
		}
		if previous := accounted[card.EpisodeID]; previous != "" {
			return fmt.Errorf("duplicate action for episode %s", card.EpisodeID)
		}
		accounted[card.EpisodeID] = "included"
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
			ReplayURL: replayURL,
			PRNumber:  prNumber(candidate.PRURL),
		})
	}
	for _, item := range payload.Deferred {
		if _, ok := byEpisode[item.EpisodeID]; !ok {
			return fmt.Errorf("unknown episode %s", item.EpisodeID)
		}
		if accounted[item.EpisodeID] != "" {
			return fmt.Errorf("duplicate disposition for episode %s", item.EpisodeID)
		}
		if strings.TrimSpace(item.Reason) == "" {
			return fmt.Errorf("deferred episode %s has no reason", item.EpisodeID)
		}
		if internalVocabulary.MatchString(item.Reason) {
			return fmt.Errorf("internal vocabulary in deferred reason for episode %s", item.EpisodeID)
		}
		accounted[item.EpisodeID] = "deferred"
	}
	for _, candidate := range candidates {
		if accounted[candidate.EpisodeID] == "" {
			return fmt.Errorf("candidate %s was not accounted for", candidate.EpisodeID)
		}
	}

	// The renderer shows at most DigestV4CardCap cards, so cards past the cap
	// must NOT be marked included here: an issue_publications receipt for a
	// never-rendered card would exclude that issue from every future digest —
	// it silently disappears without ever reaching the reader. Overflow cards
	// are deferred instead (decisions keep priority), which the freeze
	// re-admits into the next digest.
	overflowReasons := make(map[string]string)
	sort.SliceStable(generated, func(i, j int) bool {
		return generated[i].Outcome == "needs_human" && generated[j].Outcome != "needs_human"
	})
	overflowCount := 0
	if len(generated) > notify.DigestV4CardCap {
		for _, dropped := range generated[notify.DigestV4CardCap:] {
			accounted[dropped.EpisodeID] = "deferred"
			overflowReasons[dropped.EpisodeID] = "digest overflow: held for the next digest"
		}
		overflowCount = len(generated) - notify.DigestV4CardCap
		generated = generated[:notify.DigestV4CardCap]
	}

	// Actionable receipts and their candidate ledger are one publication unit:
	// ledger "included" plus this run's delivered status is the durable receipt
	// publication record. Episode-keyed issue_publications remains owned by the
	// frozen lane above. A savepoint keeps failures in this additive lane from
	// suppressing otherwise valid frozen cards.
	receiptItems := []notify.ReceiptItem(nil)
	receiptOverflow := 0
	deliveryAlert := ""
	if _, err := tx.Exec(ctx, `SAVEPOINT actionable_delivery`); err != nil {
		return fmt.Errorf("open actionable delivery savepoint: %w", err)
	}
	var actionableErr error
	var actionableEvaluatedAt time.Time
	if err := tx.QueryRow(ctx, `SELECT transaction_timestamp()`).Scan(&actionableEvaluatedAt); err != nil {
		actionableErr = fmt.Errorf("load actionable evaluation clock: %w", err)
	}
	var actionableEval evaluation
	if actionableErr == nil {
		frozenIncidentIDs := make(map[string]bool, len(generated))
		for _, card := range generated {
			frozenIncidentIDs[card.IncidentID] = true
		}
		actionableCandidates, err := loadActionableCandidates(ctx, tx, run.ProjectID)
		if err != nil {
			actionableErr = err
		} else {
			actionableEval = evaluateActionable(actionableCandidates, frozenIncidentIDs, actionableEvaluatedAt)
		}
	}
	if actionableErr == nil {
		var err error
		receiptItems, err = toReceiptItems(actionableEval.Included)
		if err != nil {
			actionableErr = fmt.Errorf("map actionable receipts: %w", err)
		}
		receiptOverflow = actionableEval.Overflow
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
			GeneratedCards:  generated,
			OverflowCount:   overflowCount,
			ReceiptItems:    receiptItems,
			ReceiptOverflow: receiptOverflow,
			DeliveryAlert:   deliveryAlert,
		},
	}
	if err := eventPayload.Validate(); err != nil {
		return fmt.Errorf("validate notification payload: %w", err)
	}
	eventJSON, err := json.Marshal(eventPayload)
	if err != nil {
		return fmt.Errorf("encode notification payload: %w", err)
	}

	for episodeID, outcome := range accounted {
		reason := ""
		if outcome == "deferred" {
			reason = overflowReasons[episodeID]
			for _, item := range payload.Deferred {
				if item.EpisodeID == episodeID {
					reason = strings.TrimSpace(item.Reason)
					break
				}
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE digest_run_items SET outcome=$4,reason=NULLIF($5,'')
			WHERE project_id=$1 AND run_id=$2 AND episode_id=$3`,
			run.ProjectID, runID, episodeID, outcome, reason); err != nil {
			return fmt.Errorf("store digest item outcome: %w", err)
		}
		if outcome == "included" {
			if _, err := tx.Exec(ctx, `INSERT INTO issue_publications (project_id,episode_id,channel)
				VALUES ($1,$2,'digest') ON CONFLICT DO NOTHING`, run.ProjectID, episodeID); err != nil {
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

func loadValidationCandidates(ctx context.Context, tx pgx.Tx, projectID, runID string) ([]Candidate, error) {
	return loadFrozenCandidates(ctx, tx, projectID, runID)
}

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
		return fmt.Errorf("candidate %s is stale or unknown: %w", candidate.EpisodeID, err)
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
	// The prompt orders the writer to copy account names and links exactly, so
	// digits inside them ("42Floors", PR #42) must be grounded facts — without
	// this, a faithfully copied account name fails the entire day's digest.
	if number := prNumber(candidate.PRURL); number > 0 {
		allowed[strconv.Itoa(number)] = struct{}{}
	}
	sources := []string{candidate.Title, candidate.Summary, candidate.ValidAction, candidate.RoutePurpose}
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
