package handler

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
)

const webhookTestDSN = "postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"

func TestVerifyWebhookSignature_Valid(t *testing.T) {
	secret := "test-secret"
	payload := []byte(`{"action":"closed"}`)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if !verifyWebhookSignature(payload, secret, sig) {
		t.Error("expected valid signature to pass verification")
	}
}

func TestVerifyWebhookSignature_Invalid(t *testing.T) {
	secret := "test-secret"
	payload := []byte(`{"action":"closed"}`)

	if verifyWebhookSignature(payload, secret, "sha256=deadbeef") {
		t.Error("expected invalid signature to fail verification")
	}
}

func TestVerifyWebhookSignature_EmptySignature(t *testing.T) {
	if verifyWebhookSignature([]byte("test"), "secret", "") {
		t.Error("expected empty signature to fail verification")
	}
}

func TestVerifyWebhookSignature_WrongPrefix(t *testing.T) {
	if verifyWebhookSignature([]byte("test"), "secret", "sha1=abc") {
		t.Error("expected wrong prefix to fail verification")
	}
}

func TestVerifyWebhookSignature_WrongSecret(t *testing.T) {
	payload := []byte(`{"action":"closed"}`)
	mac := hmac.New(sha256.New, []byte("correct-secret"))
	mac.Write(payload)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if verifyWebhookSignature(payload, "wrong-secret", sig) {
		t.Error("expected wrong secret to fail verification")
	}
}

func TestHandleWebhook_MissingDeliveryHeaderRejected(t *testing.T) {
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")
	deps := &Dependencies{}
	body := []byte(`{"action":"closed","pull_request":{"number":1,"merged":true},"repository":{"full_name":"org/x"}}`)
	mac := hmac.New(sha256.New, []byte("receipt-test-secret"))
	_, _ = mac.Write(body)

	request := httptest.NewRequest(http.MethodPost, "/api/v1/github/webhook", bytes.NewReader(body))
	request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	request.Header.Set("X-GitHub-Event", "pull_request")
	response := httptest.NewRecorder()
	deps.HandleWebhook(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body: %s)", response.Code, response.Body.String())
	}
}

func TestHandleWebhook_NonDefaultBranchPushIgnored(t *testing.T) {
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")
	deps := &Dependencies{}
	body := []byte(`{"ref":"refs/heads/feature","after":"abc123","repository":{"full_name":"org/x","default_branch":"main"}}`)
	response := sendSignedGitHubEvent(t, deps, body, "push-non-default", "push")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	assertWebhookStatus(t, response, "ignored")
}

func TestHandleWebhook_DefaultBranchPushEnqueuesProductContext(t *testing.T) {
	pool := webhookTestPool(t)
	queries := db.New(pool)
	repo, projectID, _ := seedWebhookPR(t, pool, queries)
	// Creating a project with a repository now enqueues a connect-time
	// product_context job. Retire it so this test exercises the push enqueue
	// itself and not the supersession arm, which deliberately nulls
	// changed_paths for an already-active refresh.
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_group_jobs SET status = 'completed'
		  WHERE project_id = $1 AND job_type = 'product_context'`, projectID,
	); err != nil {
		t.Fatalf("retire connect job: %v", err)
	}
	deps := &Dependencies{Queries: queries}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")
	deliveryID := "push-" + uuid.NewString()
	body := []byte(fmt.Sprintf(`{
		"ref":"refs/heads/main",
		"after":"abc123",
		"repository":{"full_name":%q,"default_branch":"main"},
		"commits":[{"added":["src/new.ts"],"modified":["src/assets.ts"],"removed":[]}]
	}`, repo))

	response := sendSignedGitHubEvent(t, deps, body, deliveryID, "push")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	assertWebhookStatus(t, response, "queued")

	var payload string
	if err := pool.QueryRow(context.Background(),
		`SELECT payload::text FROM error_group_jobs
		  WHERE project_id=$1 AND job_type='product_context' AND status='pending'`, projectID,
	).Scan(&payload); err != nil {
		t.Fatalf("query product-context job: %v", err)
	}
	if !strings.Contains(payload, `"commit_sha": "abc123"`) ||
		!strings.Contains(payload, `"delivery_id": "`+deliveryID+`"`) ||
		!strings.Contains(payload, `"src/assets.ts"`) ||
		!strings.Contains(payload, `"src/new.ts"`) {
		t.Fatalf("unexpected product-context payload: %s", payload)
	}

	redelivery := sendSignedGitHubEvent(t, deps, body, deliveryID, "push")
	if redelivery.Code != http.StatusOK {
		t.Fatalf("redelivery status = %d, body = %s", redelivery.Code, redelivery.Body.String())
	}
	var count int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM error_group_jobs
		  WHERE project_id=$1 AND job_type='product_context' AND payload->>'delivery_id'=$2`,
		projectID, deliveryID,
	).Scan(&count); err != nil {
		t.Fatalf("count product-context jobs: %v", err)
	}
	if count != 1 {
		t.Fatalf("product-context jobs = %d, want 1", count)
	}
}

func TestHandleWebhook_NewerPushSupersedesClaimedProductContext(t *testing.T) {
	pool := webhookTestPool(t)
	queries := db.New(pool)
	repo, projectID, _ := seedWebhookPR(t, pool, queries)
	deps := &Dependencies{Queries: queries}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")

	firstDelivery := "push-" + uuid.NewString()
	firstBody := []byte(fmt.Sprintf(`{
		"ref":"refs/heads/main","after":"commit-1",
		"repository":{"full_name":%q,"default_branch":"main"},
		"commits":[{"modified":["src/first.ts"]}]
	}`, repo))
	response := sendSignedGitHubEvent(t, deps, firstBody, firstDelivery, "push")
	if response.Code != http.StatusOK {
		t.Fatalf("first push status = %d, body = %s", response.Code, response.Body.String())
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_group_jobs
		    SET status='claimed', worker_id='stale-worker', claimed_at=now(),
		        lease_expires_at=now()+interval '5 minutes'
		  WHERE project_id=$1 AND job_type='product_context'`, projectID,
	); err != nil {
		t.Fatalf("claim first product-context job: %v", err)
	}

	secondDelivery := "push-" + uuid.NewString()
	secondBody := []byte(fmt.Sprintf(`{
		"ref":"refs/heads/main","after":"commit-2",
		"repository":{"full_name":%q,"default_branch":"main"},
		"commits":[{"modified":["src/second.ts"]}]
	}`, repo))
	response = sendSignedGitHubEvent(t, deps, secondBody, secondDelivery, "push")
	if response.Code != http.StatusOK {
		t.Fatalf("second push status = %d, body = %s", response.Code, response.Body.String())
	}

	var status, commit string
	var workerID *string
	var fullRefresh bool
	if err := pool.QueryRow(context.Background(),
		`SELECT status::text, worker_id, payload->>'commit_sha',
		        payload->'changed_paths' = 'null'::jsonb
		   FROM error_group_jobs
		  WHERE project_id=$1 AND job_type='product_context'`, projectID,
	).Scan(&status, &workerID, &commit, &fullRefresh); err != nil {
		t.Fatalf("query superseded product-context job: %v", err)
	}
	if status != "pending" || workerID != nil || commit != "commit-2" {
		t.Fatalf("superseded job = status %q worker %v commit %q", status, workerID, commit)
	}
	if !fullRefresh {
		t.Fatal("superseded job must request a full refresh")
	}
}

func TestHandleWebhook_PROutcomeReceipts(t *testing.T) {
	pool := webhookTestPool(t)
	queries := db.New(pool)
	repo, projectID, groupID := seedWebhookPR(t, pool, queries)
	deps := &Dependencies{Queries: queries}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")

	mergedBody := []byte(fmt.Sprintf(
		`{"action":"closed","pull_request":{"number":42,"merged":true},"repository":{"full_name":%q}}`,
		repo,
	))
	mergeDeliveryID := "delivery-" + uuid.NewString()

	t.Run("merge inserts receipt", func(t *testing.T) {
		response := sendSignedWebhook(t, deps, mergedBody, mergeDeliveryID)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
		assertWebhookStatus(t, response, "processed")

		var gotGroupID, gotProjectID, outcome, deliveryID string
		var prNumber int
		var occurredAtNonNull bool
		err := pool.QueryRow(context.Background(),
			`SELECT error_group_id, project_id, pr_number, outcome, github_delivery_id,
			        occurred_at IS NOT NULL
			 FROM pr_outcomes WHERE github_delivery_id = $1`,
			mergeDeliveryID,
		).Scan(&gotGroupID, &gotProjectID, &prNumber, &outcome, &deliveryID, &occurredAtNonNull)
		if err != nil {
			t.Fatalf("query PR outcome: %v", err)
		}
		if gotGroupID != groupID || gotProjectID != projectID || prNumber != 42 || outcome != "merged" || deliveryID != mergeDeliveryID || !occurredAtNonNull {
			t.Fatalf("unexpected PR outcome: group=%q project=%q pr=%d outcome=%q delivery=%q occurred_at_non_null=%v",
				gotGroupID, gotProjectID, prNumber, outcome, deliveryID, occurredAtNonNull)
		}
	})

	t.Run("redelivery does not duplicate receipt", func(t *testing.T) {
		response := sendSignedWebhook(t, deps, mergedBody, mergeDeliveryID)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
		assertWebhookStatus(t, response, "duplicate")

		var count int
		if err := pool.QueryRow(context.Background(),
			`SELECT count(*) FROM pr_outcomes WHERE github_delivery_id = $1`,
			mergeDeliveryID,
		).Scan(&count); err != nil {
			t.Fatalf("count PR outcomes: %v", err)
		}
		if count != 1 {
			t.Fatalf("receipt count = %d, want 1", count)
		}
	})

	t.Run("no match inserts no receipt", func(t *testing.T) {
		body := []byte(`{"action":"closed","pull_request":{"number":999,"merged":true},"repository":{"full_name":"org/not-managed"}}`)
		noMatchDeliveryID := "delivery-" + uuid.NewString()
		response := sendSignedWebhook(t, deps, body, noMatchDeliveryID)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
		assertWebhookStatus(t, response, "no_match")

		var count int
		if err := pool.QueryRow(context.Background(),
			`SELECT count(*) FROM pr_outcomes WHERE github_delivery_id = $1`,
			noMatchDeliveryID,
		).Scan(&count); err != nil {
			t.Fatalf("count PR outcomes: %v", err)
		}
		if count != 0 {
			t.Fatalf("receipt count = %d, want 0", count)
		}
	})
}

func webhookTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = webhookTestDSN
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("skipping webhook DB test: cannot connect to postgres: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("skipping webhook DB test: postgres not reachable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedWebhookPR(t *testing.T, pool *pgxpool.Pool, queries *db.Queries) (repo, projectID, groupID string) {
	t.Helper()
	ctx := context.Background()
	suffix := uuid.NewString()
	org, err := queries.CreateOrg(ctx, "webhook-receipt-"+suffix)
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	t.Cleanup(func() {
		statements := []string{
			`DELETE FROM pr_outcomes WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM error_group_jobs WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM error_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM project_api_keys WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`UPDATE projects SET default_environment_id = NULL WHERE org_id = $1`,
			`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM projects WHERE org_id = $1`,
			`DELETE FROM orgs WHERE id = $1`,
		}
		for _, statement := range statements {
			if _, err := pool.Exec(context.Background(), statement, org.ID); err != nil {
				t.Logf("cleanup warning: %v", err)
			}
		}
	})

	repo = "org/webhook-" + suffix
	project, err := queries.CreateProject(ctx, org.ID, "webhook-project", &repo)
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	environment, err := queries.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("create environment: %v", err)
	}
	result, err := queries.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            project.ID,
		DefaultEnvironmentID: environment.ID,
		ErrorType:            "TypeError",
		ErrorMessage:         "webhook receipt test",
		StackTraceRaw:        "at app.js:1:1",
		Fingerprint:          "webhook-" + suffix,
		Title:                "Webhook receipt test",
	})
	if err != nil {
		t.Fatalf("insert error event and group: %v", err)
	}
	prURL := "https://github.com/" + repo + "/pull/42"
	if err := queries.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
		ProjectID: project.ID,
		GroupID:   result.GroupID,
		Status:    "pr_created",
		PrURL:     &prURL,
	}); err != nil {
		t.Fatalf("mark group pr_created: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET pr_number = 42 WHERE id = $1`, result.GroupID); err != nil {
		t.Fatalf("set PR number: %v", err)
	}
	return repo, project.ID, result.GroupID
}

func sendSignedWebhook(t *testing.T, deps *Dependencies, body []byte, deliveryID string) *httptest.ResponseRecorder {
	return sendSignedGitHubEvent(t, deps, body, deliveryID, "pull_request")
}

func sendSignedGitHubEvent(t *testing.T, deps *Dependencies, body []byte, deliveryID, eventType string) *httptest.ResponseRecorder {
	t.Helper()
	mac := hmac.New(sha256.New, []byte("receipt-test-secret"))
	_, _ = mac.Write(body)

	request := httptest.NewRequest(http.MethodPost, "/api/v1/github/webhook", bytes.NewReader(body))
	request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	request.Header.Set("X-GitHub-Event", eventType)
	request.Header.Set("X-GitHub-Delivery", deliveryID)
	response := httptest.NewRecorder()
	deps.HandleWebhook(response, request)
	return response
}

func assertWebhookStatus(t *testing.T, response *httptest.ResponseRecorder, want string) {
	t.Helper()
	var body struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Status != want {
		t.Fatalf("response status = %q, want %q (body: %s)", body.Status, want, response.Body.String())
	}
}

func seedWebhookInstallation(t *testing.T, queries *db.Queries, repos string) (orgID string, installationID int64) {
	t.Helper()
	ctx := context.Background()
	org, err := queries.CreateOrg(ctx, "webhook-inst-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	installationID = time.Now().UnixNano()
	if _, err := queries.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, $3)`, installationID, org.ID, repos); err != nil {
		t.Fatal(err)
	}
	if err := queries.SetOrgGitHubInstallation(ctx, org.ID, installationID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = queries.Pool().Exec(context.Background(), `DELETE FROM github_app_installations WHERE org_id = $1`, org.ID)
		_, _ = queries.Pool().Exec(context.Background(), `DELETE FROM orgs WHERE id = $1`, org.ID)
	})
	return org.ID, installationID
}

func webhookRepos(t *testing.T, queries *db.Queries, installationID int64) string {
	t.Helper()
	var raw string
	if err := queries.Pool().QueryRow(context.Background(),
		`SELECT repos::text FROM github_app_installations WHERE installation_id=$1`, installationID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestHandleWebhook_InstallationDeletedRetiresRecord(t *testing.T) {
	pool := webhookTestPool(t)
	queries := db.New(pool)
	orgID, installationID := seedWebhookInstallation(t, queries, `["acme/web"]`)
	deps := &Dependencies{Queries: queries}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")
	body := []byte(fmt.Sprintf(`{"action":"deleted","installation":{"id":%d,"account":{"login":"acme","id":1}}}`, installationID))

	response := sendSignedGitHubEvent(t, deps, body, "inst-"+uuid.NewString(), "installation")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	assertWebhookStatus(t, response, "applied")
	if active, _ := queries.OrgHasActiveGitHubInstallation(context.Background(), orgID); active {
		t.Fatal("deleted installation must read inactive")
	}
	if pointer, _ := queries.GetOrgGitHubInstallation(context.Background(), orgID); pointer != 0 {
		t.Fatalf("org pointer must be cleared: %d", pointer)
	}
	again := sendSignedGitHubEvent(t, deps, body, "inst-"+uuid.NewString(), "installation")
	if again.Code != http.StatusOK {
		t.Fatalf("redelivery status=%d", again.Code)
	}
	assertWebhookStatus(t, again, "applied")
}

func TestHandleWebhook_InstallationSuspendUnsuspendCreatedAndPermissions(t *testing.T) {
	pool := webhookTestPool(t)
	queries := db.New(pool)
	orgID, installationID := seedWebhookInstallation(t, queries, `["acme/web"]`)
	deps := &Dependencies{Queries: queries}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")
	ctx := context.Background()
	send := func(action, extra string) *httptest.ResponseRecorder {
		body := []byte(fmt.Sprintf(`{"action":%q,"installation":{"id":%d}%s}`, action, installationID, extra))
		response := sendSignedGitHubEvent(t, deps, body, action+"-"+uuid.NewString(), "installation")
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", action, response.Code, response.Body.String())
		}
		return response
	}
	assertWebhookStatus(t, send("suspend", ""), "applied")
	if active, _ := queries.OrgHasActiveGitHubInstallation(ctx, orgID); active {
		t.Fatal("suspended installation must read inactive")
	}
	assertWebhookStatus(t, send("unsuspend", ""), "applied")
	if active, _ := queries.OrgHasActiveGitHubInstallation(ctx, orgID); !active {
		t.Fatal("unsuspended installation must read active again")
	}
	if _, err := queries.RetireGitHubInstallation(ctx, installationID, ""); err != nil {
		t.Fatal(err)
	}
	assertWebhookStatus(t, send("unsuspend", ""), "applied")
	if active, _ := queries.OrgHasActiveGitHubInstallation(ctx, orgID); !active {
		t.Fatal("unsuspend after retire must restore the org pointer")
	}
	assertWebhookStatus(t, send("created", `,"repositories":[{"full_name":"acme/api"},{"full_name":"acme/web"}]`), "applied")
	if got := webhookRepos(t, queries, installationID); got != `["acme/api", "acme/web"]` {
		t.Fatalf("created must replace the repo list: %s", got)
	}
	assertWebhookStatus(t, send("new_permissions_accepted", ""), "applied")
	if got := webhookRepos(t, queries, installationID); got != `["acme/api", "acme/web"]` {
		t.Fatalf("permissions event must not touch repos: %s", got)
	}
	assertWebhookStatus(t, send("renamed", ""), "ignored")
}

func TestHandleWebhook_InstallationRepositoriesAddedRemoved(t *testing.T) {
	pool := webhookTestPool(t)
	queries := db.New(pool)
	_, installationID := seedWebhookInstallation(t, queries, `["acme/web"]`)
	deps := &Dependencies{Queries: queries}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")

	added := []byte(fmt.Sprintf(`{"action":"added","installation":{"id":%d},"repositories_added":[{"full_name":"acme/api"}],"repositories_removed":[]}`, installationID))
	response := sendSignedGitHubEvent(t, deps, added, "a-"+uuid.NewString(), "installation_repositories")
	if response.Code != http.StatusOK {
		t.Fatalf("added status=%d body=%s", response.Code, response.Body.String())
	}
	assertWebhookStatus(t, response, "applied")
	removed := []byte(fmt.Sprintf(`{"action":"removed","installation":{"id":%d},"repositories_added":[],"repositories_removed":[{"full_name":"acme/web"}]}`, installationID))
	if response := sendSignedGitHubEvent(t, deps, removed, "r-"+uuid.NewString(), "installation_repositories"); response.Code != http.StatusOK {
		t.Fatalf("removed status=%d", response.Code)
	}
	if got := webhookRepos(t, queries, installationID); got != `["acme/api"]` {
		t.Fatalf("repos after add+remove: %s", got)
	}
	empty := []byte(fmt.Sprintf(`{"action":"added","installation":{"id":%d},"repositories_added":[],"repositories_removed":[]}`, installationID))
	assertWebhookStatus(t, sendSignedGitHubEvent(t, deps, empty, "e-"+uuid.NewString(), "installation_repositories"), "applied")
	odd := []byte(fmt.Sprintf(`{"action":"renamed","installation":{"id":%d},"repositories_added":[{"full_name":"acme/x"}]}`, installationID))
	assertWebhookStatus(t, sendSignedGitHubEvent(t, deps, odd, "o-"+uuid.NewString(), "installation_repositories"), "ignored")
	if got := webhookRepos(t, queries, installationID); got != `["acme/api"]` {
		t.Fatalf("unsupported action must not mutate: %s", got)
	}
}

func TestHandleWebhook_UnknownInstallationIsIgnored(t *testing.T) {
	pool := webhookTestPool(t)
	deps := &Dependencies{Queries: db.New(pool)}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")
	for _, tc := range []struct{ event, body string }{
		{"installation", `{"action":"created","installation":{"id":1},"repositories":[{"full_name":"x/y"}]}`},
		{"installation_repositories", `{"action":"added","installation":{"id":1},"repositories_added":[{"full_name":"x/y"}]}`},
	} {
		response := sendSignedGitHubEvent(t, deps, []byte(tc.body), "x-"+uuid.NewString(), tc.event)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d", tc.event, response.Code)
		}
		assertWebhookStatus(t, response, "ignored")
	}
}

func TestHandleWebhook_InstallationDeletedClearsLegacyPointerWithoutRow(t *testing.T) {
	pool := webhookTestPool(t)
	queries := db.New(pool)
	ctx := context.Background()
	org, err := queries.CreateOrg(ctx, "legacy-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM orgs WHERE id = $1`, org.ID) })
	legacyID := time.Now().UnixNano()
	if err := queries.SetOrgGitHubInstallation(ctx, org.ID, legacyID); err != nil {
		t.Fatal(err)
	}
	deps := &Dependencies{Queries: queries}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")
	body := []byte(fmt.Sprintf(`{"action":"deleted","installation":{"id":%d}}`, legacyID))
	r := sendSignedGitHubEvent(t, deps, body, "l-"+uuid.NewString(), "installation")
	if r.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", r.Code, r.Body.String())
	}
	assertWebhookStatus(t, r, "applied")
	if pointer, _ := queries.GetOrgGitHubInstallation(ctx, org.ID); pointer != 0 {
		t.Fatalf("legacy pointer must be cleared: %d", pointer)
	}
}

func TestHandleWebhook_InstallationMalformedBodies(t *testing.T) {
	pool := webhookTestPool(t)
	deps := &Dependencies{Queries: db.New(pool)}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")
	for _, tc := range []struct{ event, body string }{
		{"installation", `{"action":"deleted"}`},
		{"installation", `not json`},
		{"installation_repositories", `{"action":"added"}`},
		{"installation_repositories", `not json`},
	} {
		r := sendSignedGitHubEvent(t, deps, []byte(tc.body), "m-"+uuid.NewString(), tc.event)
		if r.Code != http.StatusBadRequest {
			t.Fatalf("%s %q: status=%d body=%s", tc.event, tc.body, r.Code, r.Body.String())
		}
	}
}

func TestHandleWebhook_PermissionsWithReposReplacesAndSuspendClearsPointer(t *testing.T) {
	pool := webhookTestPool(t)
	queries := db.New(pool)
	orgID, installationID := seedWebhookInstallation(t, queries, `["acme/web"]`)
	deps := &Dependencies{Queries: queries}
	t.Setenv("GITHUB_WEBHOOK_SECRET", "receipt-test-secret")
	ctx := context.Background()
	body := []byte(fmt.Sprintf(`{"action":"new_permissions_accepted","installation":{"id":%d,"repository_selection":"selected"},"repositories":[{"full_name":"acme/only"}]}`, installationID))
	assertWebhookStatus(t, sendSignedGitHubEvent(t, deps, body, "p-"+uuid.NewString(), "installation"), "applied")
	if got := webhookRepos(t, queries, installationID); got != `["acme/only"]` {
		t.Fatalf("permissions event with repositories must replace the list: %s", got)
	}
	suspend := []byte(fmt.Sprintf(`{"action":"suspend","installation":{"id":%d}}`, installationID))
	assertWebhookStatus(t, sendSignedGitHubEvent(t, deps, suspend, "s-"+uuid.NewString(), "installation"), "applied")
	if pointer, _ := queries.GetOrgGitHubInstallation(ctx, orgID); pointer != 0 {
		t.Fatalf("suspend must clear the org pointer so the worker stops minting from it: %d", pointer)
	}
	unsuspend := []byte(fmt.Sprintf(`{"action":"unsuspend","installation":{"id":%d}}`, installationID))
	assertWebhookStatus(t, sendSignedGitHubEvent(t, deps, unsuspend, "u-"+uuid.NewString(), "installation"), "applied")
	if pointer, _ := queries.GetOrgGitHubInstallation(ctx, orgID); pointer != installationID {
		t.Fatalf("unsuspend must restore the pointer: %d", pointer)
	}
}
