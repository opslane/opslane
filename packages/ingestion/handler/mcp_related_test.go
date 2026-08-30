package handler

import (
	"context"
	"strings"
	"testing"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func registeredMCPToolNames(t *testing.T) []string {
	t.Helper()
	ctx := context.Background()
	server := mcpsdk.NewServer(&mcpsdk.Implementation{Name: "opslane", Version: "test"}, nil)
	(&Dependencies{}).registerMCPTools(server)
	serverTransport, clientTransport := mcpsdk.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })
	client := mcpsdk.NewClient(&mcpsdk.Implementation{Name: "test", Version: "test"}, nil)
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = clientSession.Close() })
	listed, err := clientSession.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range listed.Tools {
		names = append(names, tool.Name)
	}
	return names
}
func TestRelatedEventsToolIsRegistered(t *testing.T) {
	names := registeredMCPToolNames(t)
	if !strings.Contains(strings.Join(names, ","), "opslane_related_events") {
		t.Fatalf("missing; tools=%v", names)
	}
}
