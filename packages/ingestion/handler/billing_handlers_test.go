package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/billing"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestBillingDisabledRoutesDoNotExistBeforeAuthentication(t *testing.T) {
	router := handler.NewRouter(&handler.Dependencies{JWTSecret: []byte(authTestJWTSecret)})
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/billing/summary"},
		{http.MethodPost, "/api/v1/billing/checkout"},
		{http.MethodPost, "/api/v1/billing/portal"},
	} {
		response := doRequest(router, tc.method, tc.path, nil)
		if response.Code != http.StatusNotFound {
			t.Errorf("%s %s status=%d body=%s, want 404", tc.method, tc.path, response.Code, response.Body.String())
		}
	}

	config := doRequest(router, http.MethodGet, "/auth/config", nil)
	var body map[string]any
	if err := json.Unmarshal(config.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode auth config: %v", err)
	}
	if enabled, ok := body["billing_enabled"].(bool); !ok || enabled {
		t.Fatalf("auth config billing_enabled = %#v, want false", body["billing_enabled"])
	}
}

func TestBillingSummaryCloudAuthorizationAndBalances(t *testing.T) {
	var providerCalls int
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		providerCalls++
		body := decodeBillingProviderBody(t, r)
		switch r.URL.Path {
		case "/v1/customers.get_or_create":
			if body["customer_id"] == "" || body["name"] == "" {
				t.Errorf("customer body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"subscriptions":[{"plan_id":"free","status":"active"}]}`))
		case "/v1/balances.check":
			feature, _ := body["feature_id"].(string)
			switch feature {
			case "merged_prs":
				_, _ = w.Write([]byte(`{"allowed":true,"balance":{"feature_id":"merged_prs","granted":2,"remaining":1,"usage":1,"unlimited":false,"overage_allowed":false,"next_reset_at":1788220800000}}`))
			case "investigations":
				_, _ = w.Write([]byte(`{"allowed":false,"balance":{"feature_id":"investigations","granted":25,"remaining":0,"usage":25,"unlimited":false,"overage_allowed":false,"next_reset_at":1788220800000}}`))
			default:
				http.Error(w, "unexpected feature", http.StatusBadRequest)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer provider.Close()

	adminRouter, adminToken, _ := newBillingRouter(t, provider, true, "admin")
	response := billingRequest(adminRouter, http.MethodGet, "/api/v1/billing/summary", adminToken)
	if response.Code != http.StatusOK {
		t.Fatalf("admin summary status=%d body=%s", response.Code, response.Body.String())
	}
	var summary struct {
		PlanID   string `json:"plan_id"`
		Features []struct {
			FeatureID string  `json:"feature_id"`
			Allowed   bool    `json:"allowed"`
			Granted   float64 `json:"granted"`
			Usage     float64 `json:"usage"`
			Remaining float64 `json:"remaining"`
		} `json:"features"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &summary); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	if summary.PlanID != "free" || len(summary.Features) != 2 {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.Features[0].FeatureID != "merged_prs" || !summary.Features[0].Allowed || summary.Features[0].Granted != 2 || summary.Features[0].Usage != 1 || summary.Features[0].Remaining != 1 {
		t.Fatalf("merged_prs summary = %+v", summary.Features[0])
	}
	if summary.Features[1].FeatureID != "investigations" || summary.Features[1].Allowed || summary.Features[1].Usage != 25 {
		t.Fatalf("investigations summary = %+v", summary.Features[1])
	}

	memberRouter, memberToken, _ := newBillingRouter(t, provider, true, "member")
	callsBeforeMember := providerCalls
	if response := billingRequest(memberRouter, http.MethodGet, "/api/v1/billing/summary", memberToken); response.Code != http.StatusForbidden {
		t.Fatalf("member summary status=%d body=%s", response.Code, response.Body.String())
	}
	if providerCalls != callsBeforeMember {
		t.Fatal("member denial called billing provider")
	}
	if response := billingRequest(adminRouter, http.MethodGet, "/api/v1/billing/summary", ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated summary status=%d body=%s", response.Code, response.Body.String())
	}

	config := doRequest(adminRouter, http.MethodGet, "/auth/config", nil)
	if !strings.Contains(config.Body.String(), `"billing_enabled":true`) {
		t.Fatalf("enabled auth config body=%s", config.Body.String())
	}
}

func TestBillingSummarySelfHostedAuthenticatedOperator(t *testing.T) {
	provider := billingSummaryProvider(t)
	defer provider.Close()
	router, token, _ := newBillingRouter(t, provider, false, "member")
	response := billingRequest(router, http.MethodGet, "/api/v1/billing/summary", token)
	if response.Code != http.StatusOK {
		t.Fatalf("self-host summary status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestBillingSummaryProviderFailureIsStrict(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/customers.get_or_create" {
			_, _ = w.Write([]byte(`{"subscriptions":[{"plan_id":"free","status":"active"}]}`))
			return
		}
		http.Error(w, "provider down", http.StatusInternalServerError)
	}))
	defer provider.Close()
	router, token, _ := newBillingRouter(t, provider, true, "admin")
	response := billingRequest(router, http.MethodGet, "/api/v1/billing/summary", token)
	if response.Code != http.StatusBadGateway || !strings.Contains(response.Body.String(), "billing provider unavailable") {
		t.Fatalf("strict summary status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestBillingSummaryMissingBalanceIsStrict(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/customers.get_or_create" {
			_, _ = w.Write([]byte(`{"subscriptions":[{"plan_id":"free","status":"active"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"allowed":true}`))
	}))
	defer provider.Close()
	router, token, _ := newBillingRouter(t, provider, true, "admin")
	response := billingRequest(router, http.MethodGet, "/api/v1/billing/summary", token)
	if response.Code != http.StatusBadGateway || !strings.Contains(response.Body.String(), "billing provider unavailable") {
		t.Fatalf("malformed summary status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestBillingCheckoutAndPortal(t *testing.T) {
	t.Setenv("DASHBOARD_URL", "https://dashboard.example/")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := decodeBillingProviderBody(t, r)
		switch r.URL.Path {
		case "/v1/billing.attach":
			if body["success_url"] != "https://dashboard.example/settings?tab=billing" {
				t.Errorf("checkout body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"payment_url":"https://checkout.stripe.test/session"}`))
		case "/v1/billing.open_customer_portal":
			if body["return_url"] != "https://dashboard.example/settings?tab=billing" {
				t.Errorf("portal body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"url":"https://billing.stripe.test/session"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer provider.Close()
	router, token, _ := newBillingRouter(t, provider, true, "admin")

	for _, tc := range []struct {
		path    string
		wantURL string
	}{
		{"/api/v1/billing/checkout", "https://checkout.stripe.test/session"},
		{"/api/v1/billing/portal", "https://billing.stripe.test/session"},
	} {
		response := billingRequest(router, http.MethodPost, tc.path, token)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), fmt.Sprintf(`"url":%q`, tc.wantURL)) {
			t.Fatalf("POST %s status=%d body=%s", tc.path, response.Code, response.Body.String())
		}
	}
}

func TestBillingCheckoutEmptyPaymentURLIsClearError(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"payment_url":null}`))
	}))
	defer provider.Close()
	router, token, _ := newBillingRouter(t, provider, true, "admin")
	response := billingRequest(router, http.MethodPost, "/api/v1/billing/checkout", token)
	if response.Code != http.StatusBadGateway || !strings.Contains(response.Body.String(), "already subscribed or no payment is needed") {
		t.Fatalf("empty checkout status=%d body=%s", response.Code, response.Body.String())
	}
}

func newBillingRouter(t *testing.T, provider *httptest.Server, cloud bool, role string) (http.Handler, string, string) {
	t.Helper()
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "billing-handler-"+fmt.Sprint(time.Now().UnixNano()))
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org.ID) })
	user, err := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("billing-handler-%d@example.com", time.Now().UnixNano()), "Billing User", time.Now().UnixNano(), "billing-user", "")
	if err != nil {
		t.Fatalf("CreateUserGitHub: %v", err)
	}
	if cloud {
		if err := q.CreateMembership(ctx, user.ID, org.ID, role); err != nil {
			t.Fatalf("CreateMembership: %v", err)
		}
	}
	t.Setenv("AUTUMN_SECRET_KEY", "test-key")
	t.Setenv("AUTUMN_BASE_URL", provider.URL)
	t.Setenv("AUTUMN_PRO_PLAN_ID", "pro")
	t.Setenv("AUTUMN_FREE_PLAN_ID", "free")
	client := billing.FromEnv()
	deps := &handler.Dependencies{Queries: q, JWTSecret: []byte(authTestJWTSecret), Billing: client}
	if cloud {
		deps.AuthProvider = cloudAuthStub{}
	}
	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), user.ID, org.ID, user.Email)
	if err != nil {
		t.Fatalf("SignAccessToken: %v", err)
	}
	return handler.NewRouter(deps), token, org.ID
}

func billingRequest(router http.Handler, method, path, token string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewReader(nil))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func decodeBillingProviderBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Errorf("decode provider body: %v", err)
	}
	return body
}

func billingSummaryProvider(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := decodeBillingProviderBody(t, r)
		switch r.URL.Path {
		case "/v1/customers.get_or_create":
			_, _ = w.Write([]byte(`{"subscriptions":[{"plan_id":"free","status":"active"}]}`))
		case "/v1/balances.check":
			feature, _ := body["feature_id"].(string)
			_, _ = fmt.Fprintf(w, `{"allowed":true,"balance":{"feature_id":%q,"granted":1,"remaining":1,"usage":0,"unlimited":false,"overage_allowed":false,"next_reset_at":1788220800000}}`, feature)
		default:
			http.NotFound(w, r)
		}
	}))
}
