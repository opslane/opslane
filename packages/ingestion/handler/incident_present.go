package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

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
	if pipeline, err := d.Queries.IssuePipelineRecords(ctx, projectID, []string{incidentID}); err == nil {
		attachPipelineState(&incident, pipeline[incidentID])
	}
	return &incident, group, nil
}

func (d *Dependencies) presentMCPIncident(
	ctx context.Context,
	projectID, incidentID string,
) (*mcpformat.MCPIncident, *mcpformat.IssueEvidence, error) {
	incident, _, err := d.presentIncident(ctx, projectID, incidentID)
	if err != nil {
		return nil, nil, err
	}
	if incident == nil {
		return nil, nil, nil
	}
	evidence, err := d.Queries.IssueEvidence(ctx, projectID, incidentID)
	if err != nil {
		return nil, nil, err
	}
	formattedEvidence, err := toMCPEvidence(evidence)
	if err != nil {
		return nil, nil, err
	}
	var state *string
	if incident.State != "" {
		state = &incident.State
	}
	return &mcpformat.MCPIncident{
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
	}, formattedEvidence, nil
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
		})
	}
	return result, nil
}
