package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestListEnvironmentsReportsRollupReadiness(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, environmentID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	deps.JWTSecret = sessionReadSecret
	router := handler.NewRouterWithPool(deps, pool)
	token := dashboardToken(t, orgID)
	ctx := context.Background()

	var originalStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM rollup_backfill_state WHERE id`).Scan(&originalStatus); err != nil {
		t.Fatalf("read original rollup state: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `UPDATE rollup_backfill_state SET status = $1 WHERE id`, originalStatus)
	})

	assertResponse := func(status string, wantReady bool) {
		t.Helper()
		if _, err := pool.Exec(ctx, `UPDATE rollup_backfill_state SET status = $1 WHERE id`, status); err != nil {
			t.Fatalf("set rollup status: %v", err)
		}
		response := dashboardRequest(t, router, token,
			"/api/v1/projects/"+projectID+"/environments")
		if response.Code != http.StatusOK {
			t.Fatalf("list environments = %d: %s", response.Code, response.Body.String())
		}
		var body struct {
			Environments []struct {
				ID string `json:"id"`
			} `json:"environments"`
			RollupReady bool `json:"rollup_ready"`
		}
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatalf("decode environments response: %v", err)
		}
		if len(body.Environments) != 1 || body.Environments[0].ID != environmentID {
			t.Fatalf("environments = %#v, want %s", body.Environments, environmentID)
		}
		if body.RollupReady != wantReady {
			t.Fatalf("rollup_ready = %v with status %q, want %v", body.RollupReady, status, wantReady)
		}
	}

	assertResponse("running", false)
	assertResponse("complete", true)

	invalid := dashboardRequest(t, router, token,
		"/api/v1/projects/"+projectID+"/environments?used_by=unknown")
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid used_by = %d, want 400: %s", invalid.Code, invalid.Body.String())
	}
}
