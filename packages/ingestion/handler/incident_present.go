package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
	mcpformat "github.com/opslane/opslane/packages/ingestion/mcp"
)

var errInvalidGitHubPR = errors.New("invalid GitHub pull request URL")

func (d *Dependencies) linkIncidentPR(ctx context.Context, projectID, incidentID, rawURL string) error {
	repo, number, ok := parseGitHubPR(rawURL)
	if !ok {
		return errInvalidGitHubPR
	}
	return d.Queries.LinkPR(ctx, projectID, incidentID, rawURL, repo, number)
}

func (d *Dependencies) presentIncident(
	ctx context.Context,
	projectID, incidentID string,
) (*incidentJSON, *db.ErrorGroup, error) {
	group, err := d.Queries.GetErrorGroup(ctx, projectID, incidentID)
	if err != nil || group == nil {
		return nil, group, err
	}
	incident := toIncidentJSON(*group)
	if group.Kind == "friction" {
		state, err := d.Queries.GetTicketIncidentState(ctx, projectID, incidentID)
		if err != nil {
			return nil, group, err
		}
		if state != nil {
			incident.TicketID, incident.PublicationGeneration = &state.TicketID, &state.Generation
			incident.FixSubstate, incident.InvestigationStatus = &state.FixSubstate, &state.InvestigationStatus
			incident.CauseCoverage = &state.CauseCoverage
			readiness := "ineligible"
			if state.InvestigationStatus == "pending" {
				readiness = "pending"
			}
			if state.TicketStatus == "published" && state.GroupStatus != "archived" && state.Generation == state.LiveGeneration &&
				state.InvestigationStatus == "done" && state.CauseCoverage >= 0.5 && state.Cause != "" && state.Brief != "" {
				readiness = "eligible"
				incident.RootCause = &state.Cause
				incident.AgentTaskBrief = &state.Brief
			} else {
				incident.RootCause, incident.SuggestedMitigation = nil, nil
			}
			group.InvestigationReadiness, incident.InvestigationReadiness = &readiness, &readiness
		}
	}
	if pipeline, err := d.Queries.IssuePipelineRecords(ctx, projectID, []string{incidentID}); err == nil {
		attachPipelineState(&incident, pipeline[incidentID])
	}
	if err := d.attachTicketFacts(ctx, projectID, &incident); err != nil {
		return nil, group, err
	}
	return &incident, group, nil
}

func (d *Dependencies) presentMCPIncident(
	ctx context.Context,
	projectID, incidentID string,
) (*mcpformat.IssueInput, error) {
	incident, _, err := d.presentIncident(ctx, projectID, incidentID)
	if err != nil {
		return nil, err
	}
	if incident == nil {
		return nil, nil
	}
	evidence, err := d.Queries.IssueEvidence(ctx, projectID, incidentID)
	if err != nil {
		return nil, err
	}
	formattedEvidence, err := toMCPEvidence(evidence)
	if err != nil {
		return nil, err
	}
	// Friction incidents have no episode, so the episode-based evidence above
	// carries no recording. The watchable session is the friction replay; surface
	// it so the agent can point a human at it.
	if incident.Kind == "friction" {
		sessionID, anchorMs, ok, werr := d.Queries.WatchableSessionForGroup(ctx, incidentID, projectID)
		switch {
		case werr != nil:
			// Degrade to no replay, but do not hide a query/schema regression.
			slog.WarnContext(ctx, "friction watchable session lookup failed",
				"incident_id", incidentID, "error", werr)
		case ok:
			formattedEvidence.ReplayPointers = append(formattedEvidence.ReplayPointers, mcpformat.EvidenceReplayPointer{
				AnchorKind: "friction",
				SessionID:  sessionID,
				AnchorMS:   anchorMs,
				Retained:   true,
			})
			formattedEvidence.Availability.Recording = "available"
		}
	}
	var state *string
	if incident.State != "" {
		state = &incident.State
	}
	var cause *mcpformat.IssueCause
	chosen, cerr := d.Queries.ChosenDiagnosis(ctx, projectID, incidentID)
	if cerr != nil {
		slog.WarnContext(ctx, "chosen diagnosis lookup failed", "incident_id", incidentID, "error", cerr)
	} else if chosen != nil {
		cause = &mcpformat.IssueCause{
			Kind: chosen.CauseKind, Paths: chosen.Paths,
			DecidedAt: chosen.DecidedAt.Format("2006-01-02"),
			Commit:    chosen.Commit, FromPastRound: chosen.FromPastRound,
		}
	}
	var latest *mcpformat.IssueResult
	if result, rerr := d.Queries.LatestPipelineResult(ctx, projectID, incidentID); rerr != nil {
		slog.WarnContext(ctx, "latest pipeline result lookup failed", "incident_id", incidentID, "error", rerr)
	} else if result != nil && (chosen == nil || !result.DecidedAt.Equal(chosen.DecidedAt)) {
		latest = &mcpformat.IssueResult{
			Outcome: result.Outcome, Reason: result.Reason,
			DecidedAt: result.DecidedAt.Format("2006-01-02"),
		}
	}
	earliestMatching, matchingIssues := "", 0
	if anchor, aerr := d.Queries.RelatedAnchor(ctx, projectID, incidentID); aerr != nil {
		slog.WarnContext(ctx, "related anchor lookup failed", "incident_id", incidentID, "error", aerr)
	} else if anchor != nil {
		if totals, terr := d.Queries.RelatedEventTotals(ctx, projectID, anchor.EnvironmentID, anchor.Platform, anchor.Message, -1); terr != nil {
			slog.WarnContext(ctx, "related totals lookup failed", "incident_id", incidentID, "error", terr)
		} else {
			earliestMatching = totals.FirstSeen.Format("2006-01-02")
			matchingIssues = totals.IssueCount
		}
	}
	incidentView := mcpformat.MCPIncident{
		TicketID:               incident.TicketID,
		ID:                     incident.ID,
		Kind:                   incident.Kind,
		Title:                  incident.Title,
		Status:                 incident.Status,
		OccurrenceCount:        incident.OccurrenceCount,
		AffectedUsersCount:     incident.AffectedUsersCount,
		FirstSeen:              incident.FirstSeen,
		LastSeen:               incident.LastSeen,
		State:                  state,
		EpisodeID:              incident.EpisodeID,
		RootCause:              incident.RootCause,
		PRURL:                  incident.PrURL,
		SignalType:             incident.SignalType,
		ElementSelector:        incident.ElementSelector,
		PageURLNormalized:      incident.PageURLNormalized,
		InvestigationReadiness: incident.InvestigationReadiness,
	}
	return &mcpformat.IssueInput{
		Incident: incidentView, Evidence: *formattedEvidence,
		Cause: cause, LatestResult: latest,
		EarliestMatching: earliestMatching, MatchingIssues: matchingIssues,
	}, nil
}

func toMCPEvidence(evidence db.IssueEvidenceResult) (*mcpformat.IssueEvidence, error) {
	result := &mcpformat.IssueEvidence{
		Frames:         make([]mcpformat.EvidenceFrame, 0, len(evidence.Frames)),
		FailedRequests: make([]mcpformat.EvidenceFailedRequest, 0, len(evidence.FailedRequests)),
		ReplayPointers: make([]mcpformat.EvidenceReplayPointer, 0, len(evidence.ReplayPointers)),
		Availability: mcpformat.EvidenceAvailability{
			Recording: evidence.Recording,
			SourceMap: evidence.SourceMap,
		},
	}
	for _, frame := range evidence.Frames {
		var envelope any
		if len(frame.Envelope) > 0 {
			if err := json.Unmarshal(frame.Envelope, &envelope); err != nil {
				return nil, fmt.Errorf("decode evidence frame: %w", err)
			}
		}
		result.Frames = append(result.Frames, mcpformat.EvidenceFrame{
			AnchorKind: frame.AnchorKind,
			Status:     frame.Status,
			Envelope:   envelope,
			CommitSHA:  frame.CommitSHA,
		})
	}
	for _, failure := range evidence.FailedRequests {
		result.FailedRequests = append(result.FailedRequests, mcpformat.EvidenceFailedRequest{
			PageRoute:       failure.PageRoute,
			Method:          failure.Method,
			EndpointPattern: failure.EndpointPattern,
			Status:          failure.Status,
			ActionSelector:  failure.ActionSelector,
		})
	}
	for _, pointer := range evidence.ReplayPointers {
		result.ReplayPointers = append(result.ReplayPointers, mcpformat.EvidenceReplayPointer{
			AnchorKind: pointer.AnchorKind,
			SessionID:  pointer.SessionID,
			AnchorMS:   pointer.AnchorMs,
			Retained:   pointer.Retained,
		})
	}
	return result, nil
}

// attachTicketFacts keeps ticket list and detail counts on the same verified
// seven-day projection as the digest, including zero-evidence responses.
func (d *Dependencies) attachTicketFacts(ctx context.Context, projectID string, inc *incidentJSON) error {
	if inc.Kind != "friction" {
		return nil
	}
	f, err := db.LoadTicketDigestFacts(ctx, d.Queries.Pool(), projectID, inc.ID, time.Now())
	if err != nil {
		return err
	}
	if f == nil {
		return nil
	}
	inc.TicketID = &f.TicketID
	inc.PublicationGeneration = &f.Generation
	inc.FixSubstate = &f.FixSubstate
	inc.InvestigationStatus = &f.InvestigationStatus
	inc.CauseCoverage = &f.Coverage
	inc.VerifiedUsers = &f.VerifiedUsers
	inc.VerifiedSessions = &f.VerifiedSessions
	inc.AffectedUsersCount = f.VerifiedUsers
	inc.OccurrenceCount = len(f.SignalIDs)
	inc.ImpactClass = nil
	inc.ImpactVisits = nil
	inc.ImpactRecovered = nil
	inc.Story = fmt.Sprintf("%d users · %d sessions this week", f.VerifiedUsers, f.VerifiedSessions)
	if !f.OnCard() {
		inc.RootCause = nil
		inc.SuggestedMitigation = nil
	}
	return nil
}
