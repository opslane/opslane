package handler

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

type agentStepJSON struct {
	Status    string `json:"status"`
	Note      string `json:"note"`
	UpdatedAt string `json:"updated_at"`
}

type agentFacts struct {
	HasEvents           bool                     `json:"has_events"`
	LatestErrorGroupURL *string                  `json:"latest_error_group_url"`
	IssuesURL           string                   `json:"issues_url"`
	GitHubConnected     bool                     `json:"github_connected"`
	GitHubInstalled     bool                     `json:"github_installed"`
	GitHubMode          string                   `json:"github_mode"`
	GitHubConnectURL    string                   `json:"github_connect_url"`
	GitHubRepo          *string                  `json:"github_repo"`
	SlackConnected      bool                     `json:"slack_connected"`
	SourcemapsUploaded  bool                     `json:"sourcemaps_uploaded"`
	Steps               map[string]agentStepJSON `json:"steps"`
}

// agentSessionFacts evaluates the server-side truth for a bound session.
// Every field is derived from tables, never from what the agent said, and a
// lookup error reads as "not connected", never as connected.
func (d *Dependencies) agentSessionFacts(r *http.Request, s *db.AgentSession) agentFacts {
	ctx := r.Context()
	origin := d.publicOrigin(r)
	f := agentFacts{GitHubMode: "app", GitHubConnectURL: origin + "/settings#github", Steps: map[string]agentStepJSON{}}
	if d.GitHubAppSlug == "" {
		f.GitHubMode = "pat"
	}
	if s.ProjectID == nil || s.OrgID == nil {
		return f
	}
	projectID, orgID := *s.ProjectID, *s.OrgID
	f.IssuesURL = origin + "/?project_id=" + projectID
	f.GitHubConnectURL = origin + "/settings?project_id=" + projectID + "#github"
	// Events count only from when the session started, so attaching an
	// existing project with history does not pass the first-event proof.
	if has, err := d.Queries.HasEventsSince(ctx, projectID, s.CreatedAt); err == nil {
		f.HasEvents = has
	}
	if f.HasEvents {
		if latest, err := d.Queries.LatestErrorGroupID(ctx, projectID); err == nil && latest != nil {
			u := origin + "/issues/" + *latest + "?project_id=" + projectID
			f.LatestErrorGroupURL = &u
		}
	}
	if repo, err := d.Queries.GetProjectGitHubConfig(ctx, orgID, projectID); err == nil {
		f.GitHubRepo = repo
	}
	repoAttached := f.GitHubRepo != nil && *f.GitHubRepo != ""
	if f.GitHubMode == "app" {
		if ok, err := d.Queries.OrgHasActiveGitHubInstallation(ctx, orgID); err == nil && ok {
			f.GitHubInstalled = true
		}
		f.GitHubConnected = f.GitHubInstalled && repoAttached
	} else {
		// PAT mode has no install step: a configured token is the installation.
		f.GitHubInstalled = strings.TrimSpace(os.Getenv("GITHUB_TOKEN")) != ""
		f.GitHubConnected = repoAttached
	}
	if ok, err := d.Queries.HasEnabledSlackDestination(ctx, projectID); err == nil {
		f.SlackConnected = ok
	}
	if ok, err := d.Queries.HasSourcemapUploads(ctx, projectID); err == nil {
		f.SourcemapsUploaded = ok
	}
	if steps, err := d.Queries.ListAgentSteps(ctx, s.ID); err == nil {
		for _, st := range steps {
			f.Steps[st.Step] = agentStepJSON{Status: st.Status, Note: st.Note, UpdatedAt: st.UpdatedAt.UTC().Format(time.RFC3339)}
		}
	}
	return f
}

// mergeFacts flattens agentFacts into a response map.
func mergeFacts(resp map[string]any, f agentFacts) {
	b, _ := json.Marshal(f)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for k, v := range m {
		resp[k] = v
	}
}

func agentNextHint(status string, f agentFacts) string {
	switch {
	case f.HasEvents:
		return "First event received. Remove the test button and show latest_error_group_url, or issues_url while grouping catches up."
	case status == "app_reporting":
		return "The SDK is loaded in a browser. Trigger the test error, then poll state with ?wait=30&until=event."
	default:
		return "Install the SDK with ingest_key, load the app, trigger the test error, then poll state with ?wait=30&until=event."
	}
}

const agentStatusHelp = "provisioned: approved, keys ready. key_ok: keys delivered. app_reporting: the SDK has loaded in a browser. Only has_events proves an error arrived."

// parseWait clamps the ?wait query value to 0..30 seconds.
func parseWait(raw string) int {
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0
	}
	if n > 30 {
		return 30
	}
	return n
}
