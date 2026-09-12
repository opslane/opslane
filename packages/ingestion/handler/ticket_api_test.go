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
	if w := request(http.MethodPost, "/fix", false); w.Code != http.StatusUnauthorized {
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
	if w := request(http.MethodPost, "/fix", true); w.Code != http.StatusConflict {
		t.Fatalf("unverified fix=%d %s", w.Code, w.Body.String())
	}
	var queued int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM error_group_jobs WHERE error_group_id=$1 AND job_type='investigate' AND status='pending'`, group).Scan(&queued); err != nil || queued != 0 {
		t.Fatalf("a refused fix must not queue an investigation: queued=%d error=%v", queued, err)
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

// An insight is never fixable: readiness stays ineligible even with a finished
// investigation, and a fix request is refused (grilling decision Q1).
func TestTicketInsightIsNeverFixable(t *testing.T) {
	router, q, pool := authTestRouter(t)
	org, project, environment, _ := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org) })
	ctx := context.Background()
	var ticket, group string
	if err := pool.QueryRow(ctx, `INSERT INTO friction_tickets(project_id,environment_id,name,control,what_happened,kind,status,live_generation)
		VALUES($1,$2,'Export needs many clicks','Export','Export needed repeated clicks','ux_insight','published',1) RETURNING id`, project, environment).Scan(&ticket); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups(project_id,fingerprint,title,first_seen,last_seen,kind,status,ticket_id,publication_generation,fix_substate,investigation_status,root_cause,occurrence_count,affected_users_count)
		VALUES($1,$2,'Export needs many clicks',now(),now(),'friction','awaiting_approval',$3,1,'none','done','The export button offers no bulk action.',5,5) RETURNING id`, project, "ticket|"+ticket, ticket).Scan(&group); err != nil {
		t.Fatal(err)
	}
	var job string
	if err := pool.QueryRow(ctx, `INSERT INTO error_group_jobs(project_id,error_group_id,job_type,status,ticket_id,publication_generation,source_id)
		VALUES($1,$2,'investigate','completed',$3,1,$2) RETURNING id`, project, group, ticket).Scan(&job); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO diagnosis_decisions(error_group_id,project_id,job_id,outcome,decision_reason,diagnosis,model,prompt_version,basis,confidence)
		VALUES($1,$2,$3,'code_fix','The export button offers no bulk action.','{"agentTaskBrief":"Add a bulk export action."}'::jsonb,'test','friction-ticket-v1','friction_classify','high')`, group, project, job); err != nil {
		t.Fatal(err)
	}
	// One confirmed recording whose signal the cause explains, so coverage is 1
	// and only the kind can keep this incident from being fixable.
	confirmJob := ""
	if err := pool.QueryRow(ctx, `INSERT INTO error_group_jobs(project_id,error_group_id,job_type,status,ticket_id,publication_generation,source_id)
		VALUES($1,$2,'friction_confirm','completed',$3,1,$2) RETURNING id`, project, group, ticket).Scan(&confirmJob); err != nil {
		t.Fatal(err)
	}
	batch := ""
	if err := pool.QueryRow(ctx, `INSERT INTO friction_confirm_batches(ticket_id,job_id,manifest,arrival_boundary_at_select,live_generation_at_select,status_at_select,status)
		VALUES($1,$2,'[]',0,1,'published','finalized') RETURNING id`, ticket, confirmJob).Scan(&batch); err != nil {
		t.Fatal(err)
	}
	endUser, session := "", "insight-"+ticket
	if err := pool.QueryRow(ctx, `INSERT INTO end_users(project_id,external_user_id) VALUES($1,$2) RETURNING id`, project, session).Scan(&endUser); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sessions(id,project_id,environment_id,end_user_id,started_at) VALUES($1,$2,$3,$4,now())`, session, project, environment, endUser); err != nil {
		t.Fatal(err)
	}
	signal := ""
	if err := pool.QueryRow(ctx, `INSERT INTO friction_signals(session_id,project_id,environment_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,observation_id,narrative_id)
		VALUES($1,$2,$3,3,'narrative',$1,'/export',now(),'o','n') RETURNING id`, session, project, environment).Scan(&signal); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO friction_ticket_matches(ticket_id,session_id,project_id,environment_id,arrival_number,source,occurred_at,end_user_id)
		VALUES($1,$2,$3,$4,1,'strong',now(),$5)`, ticket, session, project, environment, endUser); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO friction_ticket_match_observations(ticket_id,session_id,signal_id) VALUES($1,$2,$3)`, ticket, session, signal); err != nil {
		t.Fatal(err)
	}
	attempt := ""
	if err := pool.QueryRow(ctx, `INSERT INTO friction_check_attempts(batch_id,ticket_id,session_id,outcome,signal_ids,note,cost_to_user,model)
		VALUES($1,$2,$3,'confirmed',jsonb_build_array($4::text),'Clicked export repeatedly','annoyance','test') RETURNING id`, batch, ticket, session, signal).Scan(&attempt); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO friction_checks(ticket_id,session_id,attempt_id,outcome) VALUES($1,$2,$3,'confirmed')`, ticket, session, attempt); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET explained_signal_ids=jsonb_build_array($2::text) WHERE id=$1`, group, signal); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `ALTER TABLE diagnosis_decisions DISABLE TRIGGER diagnosis_decisions_immutable_row`); err != nil {
			t.Error(err)
			return
		}
		for _, sql := range []string{
			`DELETE FROM diagnosis_decisions WHERE project_id=$1`,
			`DELETE FROM friction_checks WHERE ticket_id IN (SELECT id FROM friction_tickets WHERE project_id=$1)`,
			`DELETE FROM friction_check_attempts WHERE ticket_id IN (SELECT id FROM friction_tickets WHERE project_id=$1)`,
			`DELETE FROM friction_confirm_batches WHERE ticket_id IN (SELECT id FROM friction_tickets WHERE project_id=$1)`,
			`DELETE FROM friction_ticket_match_observations WHERE ticket_id IN (SELECT id FROM friction_tickets WHERE project_id=$1)`,
			`DELETE FROM friction_ticket_matches WHERE project_id=$1`,
			`DELETE FROM friction_signals WHERE project_id=$1`,
			`DELETE FROM sessions WHERE project_id=$1`,
			`DELETE FROM end_users WHERE project_id=$1`,
		} {
			if _, err := pool.Exec(ctx, sql, project); err != nil {
				t.Error(err)
			}
		}
		if _, err := pool.Exec(ctx, `ALTER TABLE diagnosis_decisions ENABLE TRIGGER diagnosis_decisions_immutable_row`); err != nil {
			t.Error(err)
		}
	})
	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), "insight-user", org, "insight@example.test")
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/projects/" + project + "/incidents/" + group
	request := func(method, suffix string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path+suffix, strings.NewReader(`{}`))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	w := request(http.MethodGet, "")
	if w.Code != http.StatusOK {
		t.Fatalf("read=%d %s", w.Code, w.Body.String())
	}
	var incident struct {
		InvestigationReadiness *string `json:"investigation_readiness"`
		RootCause              *string `json:"root_cause"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &incident); err != nil {
		t.Fatal(err)
	}
	if incident.InvestigationReadiness == nil || *incident.InvestigationReadiness != "cause_only" || incident.RootCause == nil {
		t.Fatalf("insight shows its cause but is never fix-eligible: %+v", incident)
	}
	if w := request(http.MethodPost, "/fix"); w.Code != http.StatusConflict {
		t.Fatalf("insight fix=%d %s", w.Code, w.Body.String())
	}
	// The only investigate job is the completed one seeded above (it anchors the
	// diagnosis_decisions foreign key). The refused fix queued nothing at all.
	var fixJobs, investigateJobs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE job_type='fix'),count(*) FILTER (WHERE job_type='investigate')
		FROM error_group_jobs WHERE error_group_id=$1`, group).Scan(&fixJobs, &investigateJobs); err != nil || fixJobs != 0 || investigateJobs != 1 {
		t.Fatalf("insight fix request queued %d fix and %d investigate jobs (err=%v)", fixJobs, investigateJobs, err)
	}
}
