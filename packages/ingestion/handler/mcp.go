package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/opslane/opslane/packages/ingestion/db"
	mcpformat "github.com/opslane/opslane/packages/ingestion/mcp"
)

var mcpLimiter = newRateLimiter(120)
var incidentUUID = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

func (d *Dependencies) MCPHandler() http.Handler {
	server := mcpsdk.NewServer(&mcpsdk.Implementation{
		Name:    "opslane",
		Version: "1.0.0",
	}, nil)
	d.registerMCPTools(server)

	transport := mcpsdk.NewStreamableHTTPHandler(
		func(*http.Request) *mcpsdk.Server { return server },
		&mcpsdk.StreamableHTTPOptions{
			Stateless:           true,
			JSONResponse:        true,
			MaxRequestBodyBytes: 1 << 20,
		},
	)

	verifier := func(ctx context.Context, token string, _ *http.Request) (*mcpauth.TokenInfo, error) {
		lookup, err := d.Queries.LookupProjectKey(ctx, token)
		if errors.Is(err, db.ErrProjectKeyExpired) {
			recordMCPAuth("expired", "", "")
			return nil, fmt.Errorf("invalid api key: %w", mcpauth.ErrInvalidToken)
		}
		if errors.Is(err, db.ErrProjectKeyInvalid) {
			recordMCPAuth("invalid", "", "")
			return nil, fmt.Errorf("invalid api key: %w", mcpauth.ErrInvalidToken)
		}
		if err != nil {
			recordMCPAuth("lookup_error", "", "")
			return nil, err
		}

		outcome := "ok"
		if lookup.Scope != db.ScopeAPI {
			outcome = "wrong_scope"
		}
		recordMCPAuth(outcome, lookup.ProjectID, lookup.KeyID)
		expiration := time.Time{}
		if lookup.ExpiresAt != nil {
			expiration = *lookup.ExpiresAt
		}
		return &mcpauth.TokenInfo{
			Scopes:     []string{lookup.Scope},
			Expiration: expiration,
			Extra: map[string]any{
				"project_id": lookup.ProjectID,
				"org_id":     lookup.OrgID,
				"key_id":     lookup.KeyID,
			},
		}, nil
	}

	handler := d.mcpProjectContext(rateLimitByProject(mcpLimiter)(transport))
	handler = mcpauth.RequireBearerToken(verifier, &mcpauth.RequireBearerTokenOptions{
		Scopes:                 []string{db.ScopeAPI},
		AllowMissingExpiration: true,
	})(handler)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := strings.Fields(r.Header.Get("Authorization"))
		if len(header) != 2 || !strings.EqualFold(header[0], "Bearer") {
			recordMCPAuth("missing", "", "")
		}
		handler.ServeHTTP(w, r)
	})
}

func (d *Dependencies) registerMCPTools(server *mcpsdk.Server) {
	type noArguments struct{}
	mcpsdk.AddTool(server, &mcpsdk.Tool{
		Name: "opslane_digest",
		Description: "The issues selected for the latest delivered Opslane digest, as facts. " +
			"Start here when working the daily digest.",
	}, func(ctx context.Context, _ *mcpsdk.CallToolRequest, _ noArguments) (*mcpsdk.CallToolResult, any, error) {
		projectID := ProjectIDFromCtx(ctx)
		runDate, rawCards, err := d.Queries.LatestDeliveredDigest(ctx, projectID)
		if err != nil {
			return nil, nil, err
		}
		cards := make([]mcpformat.DigestCard, 0)
		if len(rawCards) > 0 && string(rawCards) != "null" {
			if err := json.Unmarshal(rawCards, &cards); err != nil {
				return nil, nil, fmt.Errorf("decode delivered digest: %w", err)
			}
		}
		var runDatePointer *string
		if runDate != "" {
			runDatePointer = &runDate
		}
		body := mcpformat.FormatDigest(mcpformat.DigestInput{
			RunDate:      runDatePointer,
			Cards:        cards,
			ProjectLabel: projectID,
		})
		return textToolResult(body), nil, nil
	})

	type issueArguments struct {
		ID string `json:"id" jsonschema:"Full incident UUID, or a dashboard URL containing it"`
	}
	mcpsdk.AddTool(server, &mcpsdk.Tool{
		Name: "opslane_issue",
		Description: "Everything Opslane knows about one issue, including its diagnosis, " +
			"resolved source frames, failing requests, state, and pull request.",
	}, func(ctx context.Context, _ *mcpsdk.CallToolRequest, input issueArguments) (*mcpsdk.CallToolResult, any, error) {
		incidentID, ok := parseIncidentID(input.ID)
		if !ok {
			return errorToolResult("Could not read an incident id. Pass the full UUID or the dashboard URL from the digest."), nil, nil
		}
		incident, evidence, err := d.presentMCPIncident(ctx, ProjectIDFromCtx(ctx), incidentID)
		if err != nil {
			return nil, nil, err
		}
		if incident == nil {
			return errorToolResult("Issue not found for this project."), nil, nil
		}
		return textToolResult(mcpformat.FormatIssue(mcpformat.IssueInput{
			Incident: *incident,
			Evidence: *evidence,
		})), nil, nil
	})

	type linkPRArguments struct {
		ID  string `json:"id" jsonschema:"Full incident UUID, or a dashboard URL containing it"`
		URL string `json:"url" jsonschema:"GitHub pull request URL"`
	}
	mcpsdk.AddTool(server, &mcpsdk.Tool{
		Name: "opslane_link_pr",
		Description: "Record a GitHub pull request on an Opslane issue. This marks a PR as " +
			"in flight; it does not claim the issue is resolved.",
	}, func(ctx context.Context, _ *mcpsdk.CallToolRequest, input linkPRArguments) (*mcpsdk.CallToolResult, any, error) {
		incidentID, ok := parseIncidentID(input.ID)
		if !ok {
			return errorToolResult("Could not read an incident id. Pass the full UUID or the dashboard URL from the digest."), nil, nil
		}
		if err := d.linkIncidentPR(ctx, ProjectIDFromCtx(ctx), incidentID, input.URL); err != nil {
			switch {
			case errors.Is(err, errInvalidGitHubPR):
				return errorToolResult("URL must be a GitHub pull request, for example https://github.com/owner/repo/pull/123."), nil, nil
			case errors.Is(err, db.ErrIncidentNotFound):
				return errorToolResult("Issue not found for this project."), nil, nil
			case errors.Is(err, db.ErrPRRepoMismatch):
				return errorToolResult("That pull request is not in this project's repository."), nil, nil
			case errors.Is(err, db.ErrPRAlreadyLinked):
				return errorToolResult("The issue already has a pull request, or is resolved, archived, or merged."), nil, nil
			default:
				return nil, nil, err
			}
		}
		return textToolResult(fmt.Sprintf("Linked %s to %s. The issue will resolve through the merge workflow.", input.URL, incidentID)), nil, nil
	})
}

func textToolResult(body string) *mcpsdk.CallToolResult {
	return &mcpsdk.CallToolResult{Content: []mcpsdk.Content{&mcpsdk.TextContent{Text: body}}}
}

func errorToolResult(body string) *mcpsdk.CallToolResult {
	result := textToolResult(body)
	result.IsError = true
	return result
}

func parseIncidentID(input string) (string, bool) {
	match := incidentUUID.FindString(strings.TrimSpace(input))
	if match == "" {
		return "", false
	}
	return strings.ToLower(match), true
}

func (d *Dependencies) mcpProjectContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		info := mcpauth.TokenInfoFromContext(r.Context())
		if info == nil {
			writeJSONError(w, http.StatusUnauthorized, "missing token context")
			return
		}
		projectID, projectOK := info.Extra["project_id"].(string)
		orgID, orgOK := info.Extra["org_id"].(string)
		if !projectOK || projectID == "" || !orgOK || orgID == "" {
			writeJSONError(w, http.StatusInternalServerError, "invalid token context")
			return
		}
		ctx := context.WithValue(r.Context(), ctxProjectID, projectID)
		ctx = context.WithValue(ctx, ctxOrgID, orgID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func recordMCPAuth(outcome, projectID, keyID string) {
	RecordMCPAuth(outcome)
	attributes := []any{"outcome", outcome}
	if projectID != "" {
		attributes = append(attributes, "project_id", projectID)
	}
	if keyID != "" {
		attributes = append(attributes, "key_id", keyID)
	}
	slog.Info("mcp bearer authentication", attributes...)
}
