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
	"testing"

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
		ProjectID:     project.ID,
		EnvironmentID: environment.ID,
		ErrorType:     "TypeError",
		ErrorMessage:  "webhook receipt test",
		StackTraceRaw: "at app.js:1:1",
		Fingerprint:   "webhook-" + suffix,
		Title:         "Webhook receipt test",
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
	t.Helper()
	mac := hmac.New(sha256.New, []byte("receipt-test-secret"))
	_, _ = mac.Write(body)

	request := httptest.NewRequest(http.MethodPost, "/api/v1/github/webhook", bytes.NewReader(body))
	request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	request.Header.Set("X-GitHub-Event", "pull_request")
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
