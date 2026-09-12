package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func insertLegacyActionTicket(t *testing.T, pool *pgxpool.Pool, project, environment string) string {
	t.Helper()
	ctx := context.Background()
	var ticket, group string
	if err := pool.QueryRow(ctx, `INSERT INTO friction_tickets(project_id,environment_id,name,control,what_happened,kind,status,live_generation)
 VALUES($1,$2,'Save stalls','Save','Save stalls','defect','published',1) RETURNING id`, project, environment).Scan(&ticket); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups(project_id,fingerprint,title,first_seen,last_seen,kind,status,ticket_id,publication_generation,fix_substate,investigation_status)
 VALUES($1,$2,'Save stalls',now(),now(),'friction','awaiting_approval',$3,1,'none','pending') RETURNING id`, project, "ticket|"+ticket, ticket).Scan(&group); err != nil {
		t.Fatal(err)
	}
	return group
}

func TestTicketLegacyActionsReturnConflict(t *testing.T) {
	deps, pool := testDeps(t)
	org, project, environment, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org) })
	seedProjectRepo(t, pool, project, "acme/app")
	group := insertLegacyActionTicket(t, pool, project, environment)
	router := handler.NewRouterWithPool(deps, pool)
	for _, action := range []string{"link-pr", "resolve"} {
		t.Run(action, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+project+"/incidents/"+group+"/"+action, strings.NewReader(`{"url":"https://github.com/acme/app/pull/42"}`))
			req.Header.Set("Authorization", "Bearer "+dashboardToken(t, org))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "known problems") {
				t.Errorf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			var status, fix string
			var pr *string
			if err := pool.QueryRow(context.Background(), `SELECT status,fix_substate,pr_url FROM error_groups WHERE id=$1`, group).Scan(&status, &fix, &pr); err != nil {
				t.Fatal(err)
			}
			if status != "awaiting_approval" || fix != "none" || pr != nil {
				t.Errorf("legacy action mutated ticket: status=%s fix=%s pr=%v", status, fix, pr)
			}
		})
	}
}
