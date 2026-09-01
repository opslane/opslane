package billing_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/billing"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/usageevents"
)

func TestSweeperRequiresConfiguredDependencies(t *testing.T) {
	if _, err := (&billing.Sweeper{}).RunOnce(context.Background()); err == nil {
		t.Fatal("RunOnce with missing dependencies returned nil error")
	}
}

func TestSweeperTracksMergedPROnce(t *testing.T) {
	pool, q := billingTestDB(t)
	orgID, projectID, _, groupID := seedBillingGroup(t, pool, q, "happy", "org/billing-happy")
	ref := seedMergedReceipt(t, pool, projectID, groupID, 41, "org/billing-happy")

	var trackCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/customers.get_or_create":
			_, _ = w.Write([]byte(`{"subscriptions":[]}`))
		case "/v1/balances.track":
			trackCalls.Add(1)
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := billingClientForTest(t, server.URL)
	sweeper := &billing.Sweeper{Q: q, Client: client}

	billed, err := sweeper.RunOnce(context.Background())
	if err != nil || billed != 1 {
		t.Fatalf("first RunOnce = (%d, %v), want (1, nil)", billed, err)
	}
	billed, err = sweeper.RunOnce(context.Background())
	if err != nil || billed != 0 {
		t.Fatalf("second RunOnce = (%d, %v), want (0, nil)", billed, err)
	}
	if got := trackCalls.Load(); got != 1 {
		t.Fatalf("track calls = %d, want 1", got)
	}
	var feature string
	var value float64
	if err := pool.QueryRow(context.Background(),
		`SELECT feature_id, value FROM billing_tracked WHERE ref=$1 AND org_id=$2`, ref, orgID,
	).Scan(&feature, &value); err != nil || feature != "merged_prs" || value != 1 {
		t.Fatalf("tracked ledger = (%q, %v, %v), want merged_prs, 1, nil", feature, value, err)
	}
}

func TestSweeperRetriesTrackFailure(t *testing.T) {
	pool, q := billingTestDB(t)
	_, projectID, _, groupID := seedBillingGroup(t, pool, q, "retry", "org/billing-retry")
	ref := seedMergedReceipt(t, pool, projectID, groupID, 42, "org/billing-retry")

	var fail atomic.Bool
	fail.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/customers.get_or_create" {
			_, _ = w.Write([]byte(`{"subscriptions":[]}`))
			return
		}
		if fail.Load() {
			http.Error(w, "unavailable", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	sweeper := &billing.Sweeper{Q: q, Client: billingClientForTest(t, server.URL)}

	if billed, err := sweeper.RunOnce(context.Background()); err == nil || billed != 0 {
		t.Fatalf("failed RunOnce = (%d, %v), want (0, error)", billed, err)
	}
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM billing_tracked WHERE ref=$1`, ref).Scan(&count); err != nil || count != 0 {
		t.Fatalf("ledger after failure = %d, %v, want 0, nil", count, err)
	}
	fail.Store(false)
	if billed, err := sweeper.RunOnce(context.Background()); err != nil || billed != 1 {
		t.Fatalf("retry RunOnce = (%d, %v), want (1, nil)", billed, err)
	}
}

func TestSweeperAlertsSessionCeilingOnce(t *testing.T) {
	pool, q := billingTestDB(t)
	orgID, projectID, envID, _ := seedBillingGroup(t, pool, q, "sessions", "org/billing-sessions")
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO sessions (id, project_id, environment_id, started_at) VALUES
		 ($1, $3, $4, now()), ($2, $3, $4, now())`,
		"billing-session-a-"+projectID, "billing-session-b-"+projectID, projectID, envID,
	); err != nil {
		t.Fatalf("seed sessions: %v", err)
	}

	events := make([]string, 0)
	restore := usageevents.SetSinkForTest(func(event string, props map[string]string) {
		if props["org_id"] == orgID {
			events = append(events, event)
		}
	})
	defer restore()
	if err := usageevents.Configure("http://localhost:1"); err != nil {
		t.Fatalf("configure usage events: %v", err)
	}
	sweeper := &billing.Sweeper{Q: q, Client: billingClientForTest(t, "http://localhost:1"), SessionAlertThreshold: 1}
	if _, err := sweeper.RunOnce(context.Background()); err != nil {
		t.Fatalf("first RunOnce: %v", err)
	}
	if _, err := sweeper.RunOnce(context.Background()); err != nil {
		t.Fatalf("second RunOnce: %v", err)
	}
	if len(events) != 1 || events[0] != "session_ceiling_exceeded" {
		t.Fatalf("events = %v, want one session_ceiling_exceeded", events)
	}
	ref := fmt.Sprintf("sessions_alert:%s:%s", orgID, time.Now().UTC().Format("2006-01"))
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM billing_tracked WHERE ref=$1`, ref).Scan(&count); err != nil || count != 1 {
		t.Fatalf("session alert ledger = %d, %v, want 1, nil", count, err)
	}
}

func TestSweeperAlertsAmbiguousOrgWithoutBilling(t *testing.T) {
	pool, q := billingTestDB(t)
	orgID, projectID, _, groupID := seedBillingGroup(t, pool, q, "ambiguous", "org/shared-billing-repo")
	ref := seedMergedReceipt(t, pool, projectID, groupID, 43, "org/shared-billing-repo")
	other, err := q.CreateOrg(context.Background(), fmt.Sprintf("billing-other-%d", time.Now().UnixNano()))
	if err != nil {
		t.Fatalf("create other org: %v", err)
	}
	repo := "ORG/SHARED-BILLING-REPO"
	if _, err := q.CreateProject(context.Background(), other.ID, "other", &repo); err != nil {
		t.Fatalf("create other project: %v", err)
	}
	t.Cleanup(func() { cleanupBillingOrg(t, pool, other.ID) })

	events := make([]string, 0)
	restore := usageevents.SetSinkForTest(func(event string, _ map[string]string) { events = append(events, event) })
	defer restore()
	if err := usageevents.Configure("http://localhost:1"); err != nil {
		t.Fatalf("configure usage events: %v", err)
	}
	sweeper := &billing.Sweeper{Q: q, Client: billingClientForTest(t, "http://localhost:1")}
	for range 2 {
		if billed, err := sweeper.RunOnce(context.Background()); err != nil || billed != 0 {
			t.Fatalf("RunOnce ambiguous = (%d, %v), want (0, nil)", billed, err)
		}
	}
	if len(events) != 1 || events[0] != "billing_ambiguous_org" {
		t.Fatalf("events = %v, want one billing_ambiguous_org", events)
	}
	var count int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM billing_tracked WHERE ref=$1 AND org_id=$2`, "ambiguous:"+ref, orgID,
	).Scan(&count); err != nil || count != 1 {
		t.Fatalf("ambiguous ledger = %d, %v, want 1, nil", count, err)
	}
}

func TestSweeperDoesNotEmitWhenReceiptWasConcurrentlyMarked(t *testing.T) {
	pool, q := billingTestDB(t)
	orgID, projectID, _, groupID := seedBillingGroup(t, pool, q, "concurrent", "org/billing-concurrent")
	ref := seedMergedReceipt(t, pool, projectID, groupID, 44, "org/billing-concurrent")
	if inserted, err := q.MarkBillingTracked(context.Background(), ref, orgID, "merged_prs", 1); err != nil || !inserted {
		t.Fatalf("pre-mark = (%v, %v), want (true, nil)", inserted, err)
	}

	events := make([]string, 0)
	restore := usageevents.SetSinkForTest(func(event string, _ map[string]string) { events = append(events, event) })
	defer restore()
	if err := usageevents.Configure("http://localhost:1"); err != nil {
		t.Fatalf("configure usage events: %v", err)
	}
	sweeper := &billing.Sweeper{Q: q, Client: billingClientForTest(t, "http://localhost:1")}
	if billed, err := sweeper.RunOnce(context.Background()); err != nil || billed != 0 {
		t.Fatalf("RunOnce pre-marked = (%d, %v), want (0, nil)", billed, err)
	}
	if len(events) != 0 {
		t.Fatalf("events = %v, want none", events)
	}
}

func billingTestDB(t *testing.T) (*pgxpool.Pool, *db.Queries) {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect DB: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool, db.New(pool)
}

func billingClientForTest(t *testing.T, baseURL string) *billing.Client {
	t.Helper()
	t.Setenv("AUTUMN_SECRET_KEY", "sk_test")
	t.Setenv("AUTUMN_BASE_URL", baseURL)
	client := billing.FromEnv()
	if client == nil {
		t.Fatal("billing.FromEnv returned nil")
	}
	return client
}

func seedBillingGroup(t *testing.T, pool *pgxpool.Pool, q *db.Queries, suffix, repo string) (string, string, string, string) {
	t.Helper()
	ctx := context.Background()
	name := fmt.Sprintf("billing-sweeper-%s-%d", suffix, time.Now().UnixNano())
	org, err := q.CreateOrg(ctx, name)
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	project, err := q.CreateProject(ctx, org.ID, name, &repo)
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	env, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("create environment: %v", err)
	}
	result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID: project.ID, DefaultEnvironmentID: env.ID,
		ErrorType: "TypeError", ErrorMessage: "boom", StackTraceRaw: "at app.js:1:1",
		Fingerprint: "fp-" + name, Title: "TypeError: boom",
	})
	if err != nil {
		t.Fatalf("create group: %v", err)
	}
	t.Cleanup(func() { cleanupBillingOrg(t, pool, org.ID) })
	return org.ID, project.ID, env.ID, result.GroupID
}

func seedMergedReceipt(t *testing.T, pool *pgxpool.Pool, projectID, groupID string, pr int, repo string) string {
	t.Helper()
	ctx := context.Background()
	var fixJobID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, status)
		 VALUES ($1,$2,'fix','completed') RETURNING id`, groupID, projectID,
	).Scan(&fixJobID); err != nil {
		t.Fatalf("seed fix job: %v", err)
	}
	deliveryID := fmt.Sprintf("billing-sweeper-%s-%d", projectID, pr)
	if _, err := pool.Exec(ctx,
		`INSERT INTO pr_outcomes
		 (error_group_id,project_id,pr_number,outcome,github_delivery_id,fix_job_id,occurred_at,github_repo)
		 VALUES ($1,$2,$3,'merged',$4,$5,now(),$6)`,
		groupID, projectID, pr, deliveryID, fixJobID, repo,
	); err != nil {
		t.Fatalf("seed receipt: %v", err)
	}
	return fmt.Sprintf("pr:%s:%s:%d", projectID, repo, pr)
}

func cleanupBillingOrg(t *testing.T, pool *pgxpool.Pool, orgID string) {
	t.Helper()
	ctx := context.Background()
	queries := []string{
		`DELETE FROM billing_tracked WHERE org_id=$1`,
		`DELETE FROM pr_outcomes WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
		`DELETE FROM error_group_jobs WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
		`DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
		`DELETE FROM error_events WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
		`DELETE FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
		`UPDATE projects SET default_environment_id=NULL WHERE org_id=$1`,
		`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
		`DELETE FROM projects WHERE org_id=$1`,
		`DELETE FROM orgs WHERE id=$1`,
	}
	for _, query := range queries {
		if _, err := pool.Exec(ctx, query, orgID); err != nil {
			t.Logf("cleanup billing org: %v", err)
		}
	}
}
