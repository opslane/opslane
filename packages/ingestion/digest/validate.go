package digest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

type writtenDigestPayload struct {
	Included []writtenDigestCard  `json:"included"`
	Deferred []deferredDigestItem `json:"deferred"`
}

type writtenDigestCard struct {
	EpisodeID    string   `json:"episodeId"`
	Copy         string   `json:"copy"`
	Action       string   `json:"action"`
	Label        string   `json:"label"`
	ClaimedUsers *int     `json:"claimedUsers,omitempty"`
	Accounts     []string `json:"accounts,omitempty"`
	PRURL        string   `json:"prUrl,omitempty"`
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
	WindowFrom  string
	WindowTo    string
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

func validateAndPublish(ctx context.Context, pool *pgxpool.Pool, runID string) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin digest publication: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var run validationRun
	if err := tx.QueryRow(ctx, `
		SELECT r.project_id::text,p.name,COALESCE(p.github_repo,''),r.status,
		       r.run_date::text,r.window_from::text,r.window_to::text,COALESCE(r.writer_payload,r.payload)
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
		if strings.TrimSpace(card.Copy) == "" || strings.TrimSpace(card.Action) == "" {
			return fmt.Errorf("malformed card for episode %s", card.EpisodeID)
		}
		if internalVocabulary.MatchString(card.Copy) || internalVocabulary.MatchString(card.Action) {
			return fmt.Errorf("internal vocabulary in card for episode %s", card.EpisodeID)
		}
		if card.Label != candidate.Label {
			return fmt.Errorf("unsupported label for episode %s", card.EpisodeID)
		}
		if card.ClaimedUsers != nil && *card.ClaimedUsers != candidate.AffectedUsers {
			return fmt.Errorf("unsupported count for episode %s", card.EpisodeID)
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
		if err := candidateStillPublishable(ctx, tx, run.ProjectID, candidate); err != nil {
			return err
		}
		generated = append(generated, notify.GeneratedDigestCard{
			EpisodeID: candidate.EpisodeID, IncidentID: candidate.IssueID,
			Title: candidate.Title, Label: candidate.Label, Copy: strings.TrimSpace(card.Copy),
			Action: strings.TrimSpace(card.Action), AffectedUsers: candidate.AffectedUsers,
			Accounts: candidate.Accounts, PRURL: candidate.PRURL,
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

	eventPayload := notify.EventPayload{
		Version: 1, EventType: "digest.daily", RunID: runID,
		Project:      notify.ProjectRef{ID: run.ProjectID, Name: run.ProjectName},
		DashboardURL: strings.TrimRight(os.Getenv("DASHBOARD_URL"), "/"),
		Digest: &notify.DigestPayload{
			Date:           run.RunDate,
			Window:         notify.DigestWindow{From: run.WindowFrom, To: run.WindowTo},
			SchemaVersion:  3,
			GeneratedCards: generated,
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
