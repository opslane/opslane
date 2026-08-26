package handler

import "net/http"

type onboardingStateJSON struct {
	OnboardingComplete bool    `json:"onboarding_complete"`
	NextStep           string  `json:"next_step"`
	ProjectID          *string `json:"project_id"`
	HasEvents          bool    `json:"has_events"`
	GitHubConnected    bool    `json:"github_connected"`
	GitHubMode         string  `json:"github_mode"`
	SlackConnected     bool    `json:"slack_connected"`
}

// evaluateOnboarding derives wizard state from server facts. Stored completion
// wins over fact regression; optional integration failures degrade to no nag.
func (d *Dependencies) evaluateOnboarding(r *http.Request, orgID string) (onboardingStateJSON, error) {
	state := onboardingStateJSON{GitHubMode: "app"}
	if d.GitHubAppSlug == "" {
		state.GitHubMode = "pat"
	}

	onboarded, err := d.Queries.OrgOnboarded(r.Context(), orgID)
	if err != nil {
		return state, err
	}
	state.OnboardingComplete = onboarded

	projectID, repo, err := d.Queries.NewestProjectIDAndRepo(r.Context(), orgID)
	if err != nil {
		if onboarded {
			state.NextStep = "done"
			return state, nil
		}
		return state, err
	}
	state.ProjectID = projectID

	if onboarded {
		state.NextStep = "done"
		// has_events stays a truthful data fact even post-completion (a
		// backfilled org may never have ingested); completion-wins lives in
		// next_step alone. Degrade open on error: completion is already set.
		if projectID != nil {
			if hasEvents, optionalErr := d.Queries.HasEvents(r.Context(), *projectID); optionalErr == nil {
				state.HasEvents = hasEvents
			} else {
				state.HasEvents = true
			}
		}
		state.GitHubConnected = d.optionalGitHubConnected(r, orgID, repo)
		if projectID != nil {
			if connected, optionalErr := d.Queries.HasEnabledDigestDestination(r.Context(), *projectID); optionalErr == nil {
				state.SlackConnected = connected
			} else {
				state.SlackConnected = true
			}
		}
		return state, nil
	}

	if projectID == nil {
		state.NextStep = "create_project"
		return state, nil
	}

	state.HasEvents, err = d.Queries.HasEvents(r.Context(), *projectID)
	if err != nil {
		return state, err
	}
	state.GitHubConnected = d.optionalGitHubConnected(r, orgID, repo)
	state.SlackConnected, err = d.Queries.HasEnabledDigestDestination(r.Context(), *projectID)
	if err != nil {
		return state, err
	}

	switch {
	case !state.HasEvents:
		state.NextStep = "install_sdk"
	case !state.GitHubConnected:
		state.NextStep = "connect_github"
	case !state.SlackConnected:
		state.NextStep = "connect_slack"
	default:
		state.NextStep = "done"
	}
	return state, nil
}

func (d *Dependencies) optionalGitHubConnected(r *http.Request, orgID string, repo *string) bool {
	repoAttached := repo != nil && *repo != ""
	if d.GitHubAppSlug == "" {
		return repoAttached
	}
	installationID, err := d.Queries.GetOrgGitHubInstallation(r.Context(), orgID)
	if err != nil {
		return true
	}
	return installationID > 0 && repoAttached
}

// OnboardingState returns the server-derived wizard state.
func (d *Dependencies) OnboardingState(w http.ResponseWriter, r *http.Request) {
	state, err := d.evaluateOnboarding(r, OrgIDFromCtx(r.Context()))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to compute onboarding state")
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// OnboardingComplete records completion when the sole hard gate, a received event, is met.
func (d *Dependencies) OnboardingComplete(w http.ResponseWriter, r *http.Request) {
	orgID := OrgIDFromCtx(r.Context())
	onboarded, err := d.Queries.OrgOnboarded(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to compute onboarding state")
		return
	}
	if onboarded {
		writeJSON(w, http.StatusOK, map[string]any{"onboarding_complete": true})
		return
	}

	projectID, _, err := d.Queries.NewestProjectIDAndRepo(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to compute onboarding state")
		return
	}
	hasEvents := false
	if projectID != nil {
		hasEvents, err = d.Queries.HasEvents(r.Context(), *projectID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to compute onboarding state")
			return
		}
	}
	if !hasEvents {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": "missing_facts", "missing": []string{"first_event"},
		})
		return
	}
	if err := d.Queries.MarkOrgOnboarded(r.Context(), orgID); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to complete onboarding")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"onboarding_complete": true})
}
