package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestMCPBearerAuth(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	apiKey, err := deps.Queries.CreateProjectKey(ctx, projectID, db.ScopeAPI, "mcp", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	ingestKey, err := deps.Queries.CreateProjectKey(ctx, projectID, db.ScopeIngest, "browser", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	revokedKey, err := deps.Queries.CreateProjectKey(ctx, projectID, db.ScopeAPI, "revoked", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	expiredKey, err := deps.Queries.CreateProjectKey(ctx, projectID, db.ScopeAPI, "expired", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE project_api_keys
		SET revoked_at = CASE WHEN key_id = $1 THEN now() ELSE revoked_at END,
		    expires_at = CASE WHEN key_id = $2 THEN now() - interval '1 minute' ELSE expires_at END
		WHERE key_id IN ($1, $2)`, revokedKey.KeyID, expiredKey.KeyID); err != nil {
		t.Fatal(err)
	}

	router := handler.NewRouterWithPool(deps, pool)
	request := func(token string, cancelled bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(
			`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if cancelled {
			cancelledContext, cancel := context.WithCancel(req.Context())
			cancel()
			req = req.WithContext(cancelledContext)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	for _, tc := range []struct {
		name      string
		token     string
		cancelled bool
		want      int
	}{
		{name: "missing", want: http.StatusUnauthorized},
		{name: "valid api key", token: apiKey.Raw, want: http.StatusOK},
		{name: "wrong scope", token: ingestKey.Raw, want: http.StatusForbidden},
		{name: "revoked", token: revokedKey.Raw, want: http.StatusUnauthorized},
		{name: "expired", token: expiredKey.Raw, want: http.StatusUnauthorized},
		{name: "database failure", token: apiKey.Raw, cancelled: true, want: http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := request(tc.token, tc.cancelled)
			if response.Code != tc.want {
				t.Fatalf("status = %d, want %d, body = %s", response.Code, tc.want, response.Body.String())
			}
			if tc.token != "" && strings.Contains(response.Body.String(), tc.token) {
				t.Fatal("response leaked bearer token")
			}
			if tc.name == "database failure" && strings.Contains(response.Body.String(), "lookup project key") {
				t.Fatalf("500 body leaked internal DB error detail: %s", response.Body.String())
			}
		})
	}

	// A future expiry must remain valid through the MCP bearer middleware.
	if _, err := pool.Exec(ctx, `UPDATE project_api_keys SET expires_at = $2 WHERE key_id = $1`,
		apiKey.KeyID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if response := request(apiKey.Raw, false); response.Code != http.StatusOK {
		t.Fatalf("future-expiry status = %d, body = %s", response.Code, response.Body.String())
	}

	// Two valid requests above consumed this project's first two slots. The
	// bearer-derived project context must key the limiter for the remaining 118.
	for requestNumber := 3; requestNumber <= 120; requestNumber++ {
		if response := request(apiKey.Raw, false); response.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, body = %s", requestNumber, response.Code, response.Body.String())
		}
	}
	if response := request(apiKey.Raw, false); response.Code != http.StatusTooManyRequests {
		t.Fatalf("request 121 status = %d, want 429, body = %s", response.Code, response.Body.String())
	}

	for _, key := range []string{apiKey.Raw, ingestKey.Raw, revokedKey.Raw, expiredKey.Raw} {
		if strings.Contains(logs.String(), key) {
			t.Fatal("structured auth logs leaked a bearer token")
		}
	}
}

// decodeInitializeResult asserts the body is a successful JSON-RPC initialize
// response for the opslane server, not merely HTTP 200 (JSON-RPC errors also
// ride on 200).
func decodeInitializeResult(t *testing.T, body []byte) {
	t.Helper()
	var response struct {
		Error  *struct{ Message string } `json:"error"`
		Result *struct {
			ServerInfo struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("decode initialize response: %v, body = %s", err, body)
	}
	if response.Error != nil {
		t.Fatalf("initialize returned JSON-RPC error: %+v, body = %s", response.Error, body)
	}
	if response.Result == nil || response.Result.ServerInfo.Name != "opslane" {
		t.Fatalf("initialize result missing serverInfo.name=opslane, body = %s", body)
	}
}

const mcpInitializeBody = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`

// Prod delivers ALB traffic to the container through the ECS Service Connect
// Envoy agent, so the server accepts the connection on 127.0.0.1 while Host
// stays the public domain. The SDK's DNS-rebinding localhost protection must
// not reject that combination — and the bearer gate in front of it must be
// unaffected by disabling it.
func TestMCPBehindLoopbackProxy(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	apiKey, err := deps.Queries.CreateProjectKey(ctx, projectID, db.ScopeAPI, "mcp", nil, "")
	if err != nil {
		t.Fatal(err)
	}

	router := handler.NewRouterWithPool(deps, pool)
	request := func(token string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(mcpInitializeBody))
		req.Host = "app.opslane.com"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req = req.WithContext(context.WithValue(req.Context(), http.LocalAddrContextKey,
			&net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 8080}))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	if rec := request(apiKey.Raw); rec.Code != http.StatusOK {
		t.Fatalf("valid key: status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	} else {
		decodeInitializeResult(t, rec.Body.Bytes())
	}
	// Disabling the Host check must not loosen the bearer gate in this shape.
	if rec := request(""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing token: status = %d, want 401, body = %s", rec.Code, rec.Body.String())
	}
	if rec := request("sk_invalid_token"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("invalid token: status = %d, want 401, body = %s", rec.Code, rec.Body.String())
	}
}

// Same scenario over a real loopback socket, so net/http populates
// LocalAddrContextKey exactly as prod does.
func TestMCPBehindLoopbackProxyRealSocket(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	apiKey, err := deps.Queries.CreateProjectKey(ctx, projectID, db.ScopeAPI, "mcp", nil, "")
	if err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(handler.NewRouterWithPool(deps, pool))
	t.Cleanup(server.Close)
	client := &http.Client{Timeout: 10 * time.Second}

	req, err := http.NewRequest(http.MethodPost, server.URL+"/mcp", strings.NewReader(mcpInitializeBody))
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "app.opslane.com"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+apiKey.Raw)

	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", response.StatusCode, body)
	}
	decodeInitializeResult(t, body)
}
