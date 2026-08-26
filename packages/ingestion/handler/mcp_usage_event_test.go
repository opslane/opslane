package handler

import (
	"context"
	"errors"
	"testing"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/opslane/opslane/packages/ingestion/usageevents"
)

func TestTrackToolEmitsOnlyForSuccessfulResults(t *testing.T) {
	var events []map[string]string
	restore := usageevents.SetSinkForTest(func(event string, props map[string]string) {
		if event != "mcp_tool_used" {
			t.Fatalf("event = %q", event)
		}
		events = append(events, props)
	})
	t.Cleanup(restore)
	if err := usageevents.Configure("https://hooks.example/T/B/x"); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), ctxProjectID, "project-1")
	ctx = context.WithValue(ctx, ctxOrgID, "org-1")

	success := trackTool("opslane_digest", func(context.Context, *mcpsdk.CallToolRequest, struct{}) (*mcpsdk.CallToolResult, any, error) {
		return textToolResult("ok"), nil, nil
	})
	if _, _, err := success(ctx, nil, struct{}{}); err != nil {
		t.Fatal(err)
	}
	failureResult := trackTool("opslane_issue", func(context.Context, *mcpsdk.CallToolRequest, struct{}) (*mcpsdk.CallToolResult, any, error) {
		return errorToolResult("bad id"), nil, nil
	})
	_, _, _ = failureResult(ctx, nil, struct{}{})
	failureError := trackTool("opslane_link_pr", func(context.Context, *mcpsdk.CallToolRequest, struct{}) (*mcpsdk.CallToolResult, any, error) {
		return nil, nil, errors.New("database failed")
	})
	_, _, _ = failureError(ctx, nil, struct{}{})

	if len(events) != 1 || events[0]["tool"] != "opslane_digest" ||
		events[0]["project_id"] != "project-1" || events[0]["org_id"] != "org-1" {
		t.Fatalf("events = %+v", events)
	}
}
