package handler_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestMCPLinkPRReturnsTypedOutcomes(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	seedProjectRepo(t, pool, projectID, "acme/app")
	key, err := deps.Queries.CreateProjectKey(ctx, projectID, db.ScopeAPI, "mcp", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler.NewRouterWithPool(deps, pool))
	t.Cleanup(server.Close)
	session := connectMCP(t, server.URL+"/mcp", key.Raw)

	call := func(id, url string) *mcpsdk.CallToolResult {
		t.Helper()
		result, err := session.CallTool(ctx, &mcpsdk.CallToolParams{
			Name: "opslane_link_pr", Arguments: map[string]any{"id": id, "url": url},
		})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}

	groupID := insertGroup(t, pool, projectID, "error", "mcp-link", "boom", nil, nil, nil)
	linked := call(groupID, "https://github.com/acme/app/pull/42")
	if linked.IsError || !strings.Contains(linked.Content[0].(*mcpsdk.TextContent).Text, "Linked") {
		t.Fatalf("linked result = %+v", linked)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM error_groups WHERE id = $1`, groupID).Scan(&status); err != nil || status != "pr_created" {
		t.Fatalf("linked status = %q, err = %v", status, err)
	}

	for _, tc := range []struct {
		name, id, url, want string
	}{
		{name: "already linked", id: groupID, url: "https://github.com/acme/app/pull/43", want: "already"},
		{name: "foreign repo", id: insertGroup(t, pool, projectID, "error", "mcp-foreign", "boom", nil, nil, nil), url: "https://github.com/other/app/pull/1", want: "repository"},
		{name: "bad url", id: insertGroup(t, pool, projectID, "error", "mcp-bad-url", "boom", nil, nil, nil), url: "https://github.com/acme/app/issues/1", want: "GitHub pull request"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result := call(tc.id, tc.url)
			if !result.IsError || !strings.Contains(result.Content[0].(*mcpsdk.TextContent).Text, tc.want) {
				t.Fatalf("result = %+v", result)
			}
		})
	}
}
