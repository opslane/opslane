package notify

import (
	"fmt"
	"time"
)

// EventPayload is the versioned, add-only notification payload.
type EventPayload struct {
	Version      int            `json:"version"`
	EventType    string         `json:"event_type"`
	RunID        string         `json:"run_id,omitempty"`
	Issue        *IssueRef      `json:"issue,omitempty"`
	Project      ProjectRef     `json:"project"`
	Environment  string         `json:"environment,omitempty"`
	DashboardURL string         `json:"dashboard_url,omitempty"`
	PreviewNote  string         `json:"preview_note,omitempty"`
	Digest       *DigestPayload `json:"digest,omitempty"`
	Outcome      *TriagePayload `json:"outcome,omitempty"`
}

// Validate enforces the tagged-union contract: exactly one event body,
// matching event_type. Publish paths must call this before marshalling.
func (p EventPayload) Validate() error {
	switch p.EventType {
	case "issue.created":
		if p.Issue == nil || p.Digest != nil || p.Outcome != nil {
			return fmt.Errorf("issue.created requires issue body only")
		}
	case "digest.daily":
		if p.Digest == nil || p.Issue != nil || p.Outcome != nil {
			return fmt.Errorf("digest.daily requires digest body only")
		}
	case "issue.triaged":
		if p.Issue == nil || p.Outcome == nil || p.Digest != nil {
			return fmt.Errorf("issue.triaged requires issue and outcome bodies only")
		}
	default:
		return fmt.Errorf("unknown event_type %q", p.EventType)
	}
	return nil
}

type IssueRef struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	FirstSeen string `json:"first_seen"`
}

type ProjectRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type TriagePayload struct {
	Status     string       `json:"status"`
	ReasonCode *string      `json:"reason_code"`
	Label      string       `json:"label"`
	Impact     TriageImpact `json:"impact"`
}

type TriageImpact struct {
	Users7D        int `json:"users_7d"`
	AnonSessions7D int `json:"anon_sessions_7d"`
}

type DigestPayload struct {
	Date                string          `json:"date"`
	Window              DigestWindow    `json:"window"`
	Insights            []DigestInsight `json:"insights"`
	InsightsHasMore     bool            `json:"insights_has_more"`
	TopNewIssues        []DigestIssue   `json:"top_new_issues"`
	TopNewIssuesHasMore bool            `json:"top_new_issues_has_more"`
	Outcomes            DigestOutcomes  `json:"outcomes"`
	NeedsHumanBacklog   int             `json:"needs_human_backlog"`
	Watching            DigestWatching  `json:"watching"`
	SchemaVersion       int             `json:"schema_version,omitempty"`
	// Timezone is the project's digest timezone; the renderer uses it to show
	// calendar dates (the waiting-since line) in the reader's local day.
	Timezone        string                `json:"timezone,omitempty"`
	ReceiptItems    []ReceiptItem         `json:"receipt_items,omitempty"`
	TriageCounts    *DigestTriageCounts   `json:"triage_counts,omitempty"`
	HeldBackCount   int                   `json:"held_back_count,omitempty"`
	ReceiptOverflow int                   `json:"receipt_overflow,omitempty"`
	GeneratedCards  []GeneratedDigestCard `json:"generated_cards,omitempty"`
	// OverflowCount is how many validated cards were deferred past the render
	// cap; the renderer's "And N more" line reports it.
	OverflowCount int    `json:"overflow_count,omitempty"`
	DeliveryAlert string `json:"delivery_alert,omitempty"`
	// UnifiedCards is the run's stored unified_cards_mode, stamped by the
	// validator. It is the renderer's only mode signal, and it exists because
	// the two modes budget the render cap differently: ON is one list of
	// incidents where a receipt is a card that could not be authored, so cards
	// and receipts share the cap; OFF is the pre-removal format, kept so
	// payloads frozen under the retired switch render unchanged: the cap
	// covers generated cards only and receipts render below them with their own
	// overflow line. Absent (false) means OFF, so a payload written before this
	// field existed renders exactly as it did then.
	UnifiedCards bool `json:"unified_cards,omitempty"`
}

// GeneratedDigestCard is model-authored prose grounded in a frozen candidate.
// Its IDs, counts, accounts and links have all been mechanically validated.
type GeneratedDigestCard struct {
	EpisodeID        string     `json:"episode_id"`
	IncidentID       string     `json:"incident_id"`
	Kind             string     `json:"kind,omitempty"`
	Title            string     `json:"title"`
	Label            string     `json:"label"`
	Outcome          string     `json:"outcome,omitempty"`
	Copy             string     `json:"copy"`
	Action           string     `json:"action"`
	AffectedUsers    int        `json:"affected_users"`
	OccurrenceCount  int        `json:"occurrence_count,omitempty"`
	SignalCount      int64      `json:"signal_count,omitempty"`
	Accounts         []string   `json:"accounts"`
	PRURL            string     `json:"pr_url,omitempty"`
	ReplayURL        string     `json:"replay_url,omitempty"`
	PRNumber         int        `json:"pr_number,omitempty"`
	ActionableSince  *time.Time `json:"actionable_since,omitempty"`
	FrictionCategory string     `json:"friction_category,omitempty"`
	Route            string     `json:"route,omitempty"`
	SessionCount     int        `json:"session_count,omitempty"`
	IdentifiedCount  int        `json:"identified_count,omitempty"`
	ObservationQuote string     `json:"observation_quote,omitempty"`
}

// DigestTriageCounts are point-in-time counts rendered in the digest header.
type DigestTriageCounts struct {
	PRsAwaitingReview int `json:"prs_awaiting_review"`
	NeedsDecision     int `json:"needs_decision"`
}

// ReceiptItem is one digest card. Kind is error, friction, or cluster.
type ReceiptItem struct {
	Kind              string `json:"kind"`
	IncidentID        string `json:"incident_id"`
	Title             string `json:"title"`
	OccurrenceCount   int64  `json:"occurrence_count"`
	ImpactClass       string `json:"impact_class,omitempty"`
	ImpactVisits      *int64 `json:"impact_visits,omitempty"`
	ImpactRecovered   *int64 `json:"impact_visits_recovered,omitempty"`
	ReceiptState      string `json:"receipt_state"`
	PRURL             string `json:"pr_url,omitempty"`
	SessionURL        string `json:"session_url,omitempty"`
	RootCauseExcerpt  string `json:"root_cause_excerpt,omitempty"`
	MitigationExcerpt string `json:"mitigation_excerpt,omitempty"`
	HasSavedDiff      bool   `json:"has_saved_diff,omitempty"`
	// HasValidatedDiagnosis is the same fact digest.publishable admits the item
	// on. Copy shows it directly rather than inferring it from
	// RootCauseExcerpt: a validated diagnosis whose group carries no root_cause
	// sanitizes to an empty excerpt, and the card would then deny a cause the
	// item was admitted for having.
	HasValidatedDiagnosis bool       `json:"has_validated_diagnosis,omitempty"`
	ClusterIncidentIDs    []string   `json:"cluster_incident_ids,omitempty"`
	ActionableSince       *time.Time `json:"actionable_since,omitempty"`
}

type DigestWindow struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type DigestInsight struct {
	SignalType    string   `json:"signal_type"`
	Page          string   `json:"page"`
	Occurrences   int64    `json:"occurrences"`
	AffectedUsers int      `json:"affected_users"`
	Accounts      []string `json:"accounts"`
	AccountsMore  int      `json:"accounts_more"`
	ReplayURL     *string  `json:"replay_url"`
	URL           string   `json:"url"`
}

type DigestIssue struct {
	Title            string   `json:"title"`
	URL              string   `json:"url"`
	RootCauseExcerpt *string  `json:"root_cause_excerpt"`
	Occurrences      int64    `json:"occurrences"`
	AffectedUsers    int      `json:"affected_users"`
	Accounts         []string `json:"accounts"`
	AccountsMore     int      `json:"accounts_more"`
	ReplayURL        *string  `json:"replay_url"`
}

type DigestPROpened struct {
	Title            string  `json:"title"`
	PRURL            string  `json:"pr_url"`
	PRNumber         int     `json:"pr_number"`
	Merged           bool    `json:"merged"`
	RootCauseExcerpt *string `json:"root_cause_excerpt"`
}

type DigestPRMerged struct {
	Title    string `json:"title"`
	PRURL    string `json:"pr_url"`
	PRNumber int    `json:"pr_number"`
}

type DigestNeedsHuman struct {
	Title         string   `json:"title"`
	URL           string   `json:"url"`
	ReasonMessage string   `json:"reason_message"`
	Accounts      []string `json:"accounts"`
	AccountsMore  int      `json:"accounts_more"`
}

type DigestOutcomes struct {
	PRsOpened         []DigestPROpened   `json:"prs_opened"`
	PRsMerged         []DigestPRMerged   `json:"prs_merged"`
	NeedsHuman        []DigestNeedsHuman `json:"needs_human"`
	PRsOpenedHasMore  bool               `json:"prs_opened_has_more"`
	PRsMergedHasMore  bool               `json:"prs_merged_has_more"`
	NeedsHumanHasMore bool               `json:"needs_human_has_more"`
}

type DigestWatching struct {
	Sessions int64 `json:"sessions"`
	Users    int64 `json:"users"`
}

// Formatter renders one event for a destination type.
type Formatter interface {
	Format(EventPayload) (body []byte, contentType string, err error)
}

type formatterFunc func(EventPayload) ([]byte, string, error)

func (f formatterFunc) Format(payload EventPayload) ([]byte, string, error) {
	return f(payload)
}

// Formatters is the destination-type formatter registry.
var Formatters = map[string]Formatter{
	"slack": formatterFunc(FormatSlack),
}
