package notify

import "fmt"

// EventPayload is the versioned, add-only notification payload.
type EventPayload struct {
	Version      int            `json:"version"`
	EventType    string         `json:"event_type"`
	Issue        *IssueRef      `json:"issue,omitempty"`
	Project      ProjectRef     `json:"project"`
	Environment  string         `json:"environment,omitempty"`
	DashboardURL string         `json:"dashboard_url,omitempty"`
	Digest       *DigestPayload `json:"digest,omitempty"`
}

// Validate enforces the tagged-union contract: exactly one event body,
// matching event_type. Publish paths must call this before marshalling.
func (p EventPayload) Validate() error {
	switch p.EventType {
	case "issue.created":
		if p.Issue == nil || p.Digest != nil {
			return fmt.Errorf("issue.created requires issue body only")
		}
	case "digest.daily":
		if p.Digest == nil || p.Issue != nil {
			return fmt.Errorf("digest.daily requires digest body only")
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
