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

func TestMCPDigestUsesAuthenticatedProject(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	insertDeliveredDigest(t, pool, projectID, "2026-08-21",
		`{"digest":{"generated_cards":[{"episode_id":"e-1","incident_id":"i-1","title":"Dead clicks on /assets","label":"new","copy":"ignored","action":"Review the fix","affected_users":6,"accounts":["acme"]}]}}`)
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
