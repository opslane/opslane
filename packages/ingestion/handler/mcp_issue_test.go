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

func TestMCPIssueReturnsPresentedIncidentAndEvidence(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, envID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	groupID, _ := seedEpisodeWithAnchor(t, pool, projectID, envID,
		`{"version":2,"frames":[{"original_file":"src/MainView.tsx","original_line":25}]}`)
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET root_cause = 'request_types is null' WHERE id = $1`, groupID); err != nil {
		t.Fatal(err)
	}
	key, err := deps.Queries.CreateProjectKey(ctx, projectID, db.ScopeAPI, "mcp", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler.NewRouterWithPool(deps, pool))
	t.Cleanup(server.Close)
	session := connectMCP(t, server.URL+"/mcp", key.Raw)

	result, err := session.CallTool(ctx, &mcpsdk.CallToolParams{
		Name: "opslane_issue", Arguments: map[string]any{"id": "https://app.opslane.test/issues/" + groupID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError || len(result.Content) != 1 {
		t.Fatalf("issue result = %+v", result)
	}
	text := result.Content[0].(*mcpsdk.TextContent).Text
	for _, want := range []string{"request_types is null", "src/MainView.tsx:25", groupID, "3 occurrences"} {
		if !strings.Contains(text, want) {
			t.Fatalf("issue text missing %q:\n%s", want, text)
		}
	}

	missing, err := session.CallTool(ctx, &mcpsdk.CallToolParams{
		Name: "opslane_issue", Arguments: map[string]any{"id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !missing.IsError || !strings.Contains(missing.Content[0].(*mcpsdk.TextContent).Text, "not found") {
		t.Fatalf("missing issue result = %+v", missing)
	}
}
