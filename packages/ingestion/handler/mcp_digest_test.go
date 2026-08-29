package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

type bearerTransport struct {
	token string
	base  http.RoundTripper
}

func (transport bearerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	clone := request.Clone(request.Context())
	clone.Header.Set("Authorization", "Bearer "+transport.token)
	return transport.base.RoundTrip(clone)
}

func connectMCP(t *testing.T, endpoint, token string) *mcpsdk.ClientSession {
	t.Helper()
	client := mcpsdk.NewClient(&mcpsdk.Implementation{Name: "opslane-test", Version: "1"}, nil)
	session, err := client.Connect(context.Background(), &mcpsdk.StreamableClientTransport{
		Endpoint:             endpoint,
		DisableStandaloneSSE: true,
		HTTPClient: &http.Client{Transport: bearerTransport{
			token: token,
			base:  http.DefaultTransport,
		}},
	}, nil)
	if err != nil {
		t.Fatalf("connect MCP client: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func callDigestTool(t *testing.T, deps *handler.Dependencies, poolURL, projectID string) string {
	t.Helper()
	key, err := deps.Queries.CreateProjectKey(context.Background(), projectID, db.ScopeAPI, "mcp", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler.NewRouterWithPool(deps, deps.Queries.Pool()))
	t.Cleanup(server.Close)
	session := connectMCP(t, server.URL+poolURL, key.Raw)
	result, err := session.CallTool(context.Background(), &mcpsdk.CallToolParams{Name: "opslane_digest"})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError || len(result.Content) != 1 {
		t.Fatalf("digest result = %+v", result)
	}
	content, ok := result.Content[0].(*mcpsdk.TextContent)
	if !ok {
		t.Fatalf("digest content = %#v", result.Content)
	}
	return content.Text
}

func TestMCPDigestUsesAuthenticatedProject(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	insertDeliveredDigest(t, pool, projectID, "2026-08-21",
		`{"event_type":"digest.daily","digest":{"schema_version":4,"date":"2026-08-21","generated_cards":[{"episode_id":"e-1","incident_id":"i-1","title":"Dead clicks on /assets","label":"new","outcome":"needs_human","copy":"ignored","action":"Review the fix","affected_users":6,"accounts":["acme"]}]}}`)
	key, err := deps.Queries.CreateProjectKey(ctx, projectID, db.ScopeAPI, "mcp", nil, "")
	if err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(handler.NewRouterWithPool(deps, pool))
	t.Cleanup(server.Close)
	session := connectMCP(t, server.URL+"/mcp", key.Raw)
	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, tool := range tools.Tools {
		found = found || tool.Name == "opslane_digest"
	}
	if !found {
		t.Fatalf("opslane_digest missing from tools: %+v", tools.Tools)
	}
	result, err := session.CallTool(ctx, &mcpsdk.CallToolParams{Name: "opslane_digest"})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError || len(result.Content) != 1 {
		t.Fatalf("digest result = %+v", result)
	}
	text, ok := result.Content[0].(*mcpsdk.TextContent)
	if !ok || !strings.Contains(text.Text, "i-1") || !strings.Contains(text.Text, projectID) ||
		!strings.Contains(text.Text, "6 users") {
		t.Fatalf("digest text = %#v", result.Content)
	}
}

func TestMCPDigestRendersReceiptsAndStoredVersions(t *testing.T) {
	for _, tc := range []struct {
		name    string
		runDate string
		payload string
		wants   []string
		rejects []string
	}{
		{name: "receipts-only v4", runDate: "2026-08-27", payload: `{"event_type":"digest.daily","digest":{"schema_version":4,"date":"2026-08-27","receipt_items":[{"kind":"error","incident_id":"i-wait","title":"Dead clicks on /assets","receipt_state":"awaiting_approval","occurrence_count":198,"pr_url":"https://github.com/o/r/pull/9"}],"receipt_overflow":1}}`, wants: []string{"2026-08-27", "i-wait", "Waiting"}, rejects: []string{"No digest has been delivered"}},
		{name: "v2", runDate: "2026-08-20", payload: `{"event_type":"digest.daily","digest":{"schema_version":2,"date":"2026-08-20","receipt_items":[{"kind":"error","incident_id":"i-v2","title":"Old issue","receipt_state":"awaiting_approval"}]}}`, wants: []string{"i-v2", "Waiting"}},
		{name: "v1", runDate: "2026-08-01", payload: `{"event_type":"digest.daily","digest":{"date":"2026-08-01"}}`, wants: []string{"2026-08-01", "older format"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deps, pool := testDeps(t)
			orgID, projectID, _, _ := seedTenant(t, deps.Queries)
			t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
			insertDeliveredDigest(t, pool, projectID, tc.runDate, tc.payload)
			text := callDigestTool(t, deps, "/mcp", projectID)
			for _, want := range tc.wants {
				if !strings.Contains(text, want) {
					t.Fatalf("digest missing %q: %s", want, text)
				}
			}
			for _, reject := range tc.rejects {
				if strings.Contains(text, reject) {
					t.Fatalf("digest unexpectedly contains %q: %s", reject, text)
				}
			}
		})
	}
}

func TestMCPDigestNoDeliveredRun(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	text := callDigestTool(t, deps, "/mcp", projectID)
	if !strings.Contains(text, "No digest has been delivered for "+projectID+" yet") {
		t.Fatalf("digest text = %q", text)
	}
}
