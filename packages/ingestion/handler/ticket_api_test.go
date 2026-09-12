package handler_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestTicketIncidentActionsAndOpenedWebhook(t *testing.T) {
	router, q, pool := authTestRouter(t)
	org, project, environment, _ := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org) })
	ctx := context.Background()
	var ticket, group string
	if err := pool.QueryRow(ctx, `INSERT INTO friction_tickets(project_id,environment_id,name,control,what_happened,kind,status,live_generation)
		VALUES($1,$2,'Save stalls','Save','Save stalls','defect','published',1) RETURNING id`, project, environment).Scan(&ticket); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups(project_id,fingerprint,title,first_seen,last_seen,kind,status,ticket_id,publication_generation,fix_substate,investigation_status,root_cause,occurrence_count,affected_users_count,impact_visits,impact_visits_recovered)
		VALUES($1,$2,'Save stalls',now(),now(),'friction','awaiting_approval',$3,1,'none','failed','Unsupported cause',999,123,999,17) RETURNING id`, project, "ticket|"+ticket, ticket).Scan(&group); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, sql := range []string{`DELETE FROM friction_pr_events WHERE ticket_id=$1`, `DELETE FROM friction_fix_attempts WHERE ticket_id=$1`} {
			if _, err := pool.Exec(ctx, sql, ticket); err != nil {
				t.Error(err)
			}
		}
	})
	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), "ticket-api-user", org, "ticket@example.test")
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/projects/" + project + "/incidents/" + group
	request := func(method, suffix string, authenticated bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path+suffix, strings.NewReader(`{}`))
		if authenticated {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	if w := request(http.MethodPost, "/reinvestigate", false); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous action=%d", w.Code)
	}
	w := request(http.MethodGet, "", true)
	if w.Code != http.StatusOK {
		t.Fatalf("read=%d %s", w.Code, w.Body.String())
	}
	var incident struct {
		VerifiedUsers      *int     `json:"verified_users"`
		VerifiedSessions   *int     `json:"verified_sessions"`
		OccurrenceCount    int      `json:"occurrence_count"`
		AffectedUsersCount int      `json:"affected_users_count"`
		ImpactVisits       *int     `json:"impact_visits"`
		Story              string   `json:"story"`
		TicketID           *string  `json:"ticket_id"`
		CauseCoverage      *float64 `json:"cause_coverage"`
		RootCause          *string  `json:"root_cause"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &incident); err != nil {
		t.Fatal(err)
	}
	if incident.TicketID == nil || *incident.TicketID != ticket || incident.CauseCoverage == nil || *incident.CauseCoverage != 0 || incident.RootCause != nil {
		t.Fatalf("wrong ticket presentation: %+v", incident)
	}
	if incident.VerifiedUsers == nil || *incident.VerifiedUsers != 0 || incident.VerifiedSessions == nil || *incident.VerifiedSessions != 0 || incident.OccurrenceCount != 0 || incident.AffectedUsersCount != 0 || incident.ImpactVisits != nil || incident.Story != "0 users · 0 sessions this week" {
		t.Fatalf("unverified totals leaked: %+v", incident)
	}
	if w := request(http.MethodPost, "/reinvestigate", true); w.Code != http.StatusAccepted {
		t.Fatalf("reinvestigate=%d %s", w.Code, w.Body.String())
	}
	if w := request(http.MethodPost, "/fix", true); w.Code != http.StatusConflict {
		t.Fatalf("unverified fix=%d %s", w.Code, w.Body.String())
	}
	var queued int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM error_group_jobs WHERE error_group_id=$1 AND job_type='investigate' AND status='pending'`, group).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("queued=%d error=%v", queued, err)
	}

	// The authenticated GitHub event is a durable receipt; the worker applies it.
	repo := "ticket-api/" + ticket
	var attempt string
	if err := pool.QueryRow(ctx, `INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status,pr_number,github_repo)
		VALUES($1,$2,1,'active',73,$3) RETURNING id`, ticket, group, repo).Scan(&attempt); err != nil {
		t.Fatal(err)
	}
	const secret = "ticket-webhook-test-secret"
	t.Setenv("GITHUB_WEBHOOK_SECRET", secret)
	body := fmt.Sprintf(`{"action":"opened","pull_request":{"number":73,"html_url":"https://github.com/%s/pull/73"},"repository":{"full_name":"%s"}}`, repo, repo)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(body))
	r := httptest.NewRequest(http.MethodPost, "/api/v1/github/webhook", strings.NewReader(body))
	r.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	r.Header.Set("X-GitHub-Event", "pull_request")
	r.Header.Set("X-GitHub-Delivery", "ticket-open-"+attempt)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("webhook=%d %s", w.Code, w.Body.String())
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM friction_pr_events e JOIN error_group_jobs j ON j.payload->>'eventId'=e.id::text
		WHERE e.fix_attempt_id=$1 AND e.event='opened' AND NOT e.applied AND j.job_type='friction_pr_event'`, attempt).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("receipt jobs=%d error=%v", queued, err)
	}
	if w := request(http.MethodPost, "/archive", true); w.Code != http.StatusOK {
		t.Fatalf("archive=%d %s", w.Code, w.Body.String())
	}
	if w := request(http.MethodPost, "/unarchive", true); w.Code != http.StatusConflict {
		t.Fatalf("unarchive=%d %s", w.Code, w.Body.String())
	}
	var ticketStatus, attemptStatus string
	if err := pool.QueryRow(ctx, `SELECT t.status,a.status FROM friction_tickets t JOIN friction_fix_attempts a ON a.ticket_id=t.id WHERE a.id=$1`, attempt).Scan(&ticketStatus, &attemptStatus); err != nil || ticketStatus != "archived" || attemptStatus != "superseded" {
		t.Fatalf("archive state ticket=%s attempt=%s error=%v", ticketStatus, attemptStatus, err)
	}
}

func TestTicketFixIntentRequiresAuthenticatedMatchingScope(t *testing.T) {
	_, q, pool := authTestRouter(t)
	const secret = "ticket-action-http-test-secret-at-least-32-bytes"
	router := handler.NewRouter(&handler.Dependencies{Queries: q, JWTSecret: []byte(secret)})
	org, project, _, _ := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org) })
	token, err := auth.SignAccessToken([]byte(secret), "intent-user", org, "intent@example.test")
	if err != nil {
		t.Fatal(err)
	}
	intent, err := auth.SignTicketFixIntent([]byte(secret), auth.TicketFixIntent{ProjectID: project, IncidentID: "different-issue", TicketID: "ticket", Generation: 1, ExpiresAt: time.Now().Add(time.Hour).Unix()})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/projects/" + project + "/incidents/00000000-0000-4000-8000-000000000001/fix"
	for _, tc := range []struct {
		name, method, intent string
		authenticated        bool
		want                 int
	}{
		{"unauthenticated", http.MethodPost, intent, false, http.StatusUnauthorized},
		{"forged", http.MethodPost, "forged", true, http.StatusConflict},
		{"wrong issue", http.MethodPost, intent, true, http.StatusConflict},
		{"no GET mutation", http.MethodGet, intent, true, http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(map[string]string{"intent": tc.intent})
			req := httptest.NewRequest(tc.method, path, strings.NewReader(string(body)))
			if tc.authenticated {
				req.Header.Set("Authorization", "Bearer "+token)
			}
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.want, w.Body.String())
			}
		})
	}
}
