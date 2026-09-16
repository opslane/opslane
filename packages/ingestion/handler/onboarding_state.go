package handler

import "net/http"

type onboardingStateJSON struct {
	OnboardingComplete bool    `json:"onboarding_complete"`
	ProjectID          *string `json:"project_id"`
	HasEvents          bool    `json:"has_events"`
	GitHubConnected    bool    `json:"github_connected"`
	GitHubMode         string  `json:"github_mode"`
	SlackConnected     bool    `json:"slack_connected"`
}

// evaluateOnboarding derives onboarding facts from the server. has_events is
// org-wide because an agent may attach any project. Stored completion wins
// over fact regression; optional integration failures degrade to no nag.
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

	// A failed lookup is never answered as "no project". The setup page waits on
	// a project-less org instead of redirecting, so swallowing this error would
	// leave it polling forever with nothing on screen to say anything is wrong.
	projectID, repo, err := d.Queries.NewestProjectIDAndRepo(r.Context(), orgID)
	if err != nil {
		return state, err
	}
	state.ProjectID = projectID
	if projectID == nil {
		// No project means no events; integrations cannot be connected yet.
		return state, nil
	}

	if onboarded {
		// has_events stays a truthful data fact after completion (a backfilled
		// org may never have ingested). Degrade open on error: completion is
		// already set.
		if hasEvents, optionalErr := d.Queries.OrgHasEvents(r.Context(), orgID); optionalErr == nil {
			state.HasEvents = hasEvents
		} else {
			state.HasEvents = true
		}
		state.GitHubConnected = d.optionalGitHubConnected(r, orgID, repo)
		if connected, optionalErr := d.Queries.HasEnabledDigestDestination(r.Context(), *projectID); optionalErr == nil {
			state.SlackConnected = connected
		} else {
			state.SlackConnected = true
		}
		return state, nil
	}

	state.HasEvents, err = d.Queries.OrgHasEvents(r.Context(), orgID)
	if err != nil {
		return state, err
	}
	state.GitHubConnected = d.optionalGitHubConnected(r, orgID, repo)
	// Slack is optional before completion too: degrade to "connected" (no nag)
	// as the onboarded branch does, rather than failing the poll the setup page
	// depends on to notice the first event.
	if connected, optionalErr := d.Queries.HasEnabledDigestDestination(r.Context(), *projectID); optionalErr == nil {
		state.SlackConnected = connected
	} else {
		state.SlackConnected = true
	}
	return state, nil
}

func (d *Dependencies) optionalGitHubConnected(r *http.Request, orgID string, repo *string) bool {
	repoAttached := repo != nil && *repo != ""
	if d.GitHubAppSlug == "" {
		return repoAttached
	}
	active, err := d.Queries.OrgHasActiveGitHubInstallation(r.Context(), orgID)
	if err != nil {
		return true
	}
	if !active || !repoAttached {
		return false
	}
	covered, err := d.Queries.RepoCoveredByActiveInstallation(r.Context(), orgID, *repo)
	if err != nil {
		return true
	}
	return covered
}

// OnboardingState returns the server-derived onboarding facts.
func (d *Dependencies) OnboardingState(w http.ResponseWriter, r *http.Request) {
	state, err := d.evaluateOnboarding(r, OrgIDFromCtx(r.Context()))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to compute onboarding state")
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// OnboardingComplete records completion when the sole hard gate is met: any
// project in the org has received an event.
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

	hasEvents, err := d.Queries.OrgHasEvents(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to compute onboarding state")
		return
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
