package billing

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFromEnvNilWithoutKey(t *testing.T) {
	for _, key := range []string{"", " \t\n "} {
		t.Run(key, func(t *testing.T) {
			t.Setenv("AUTUMN_SECRET_KEY", key)
			if got := FromEnv(); got != nil {
				t.Fatal("FromEnv() returned a client without a non-empty secret key")
			}
		})
	}
}

func TestFromEnvUsesDefaultsAndOverrides(t *testing.T) {
	t.Run("defaults", func(t *testing.T) {
		t.Setenv("AUTUMN_SECRET_KEY", "test-key")
		t.Setenv("AUTUMN_BASE_URL", "")
		t.Setenv("AUTUMN_PRO_PLAN_ID", "")
		t.Setenv("AUTUMN_FREE_PLAN_ID", "")

		got := FromEnv()
		if got == nil {
			t.Fatal("FromEnv() = nil")
		}
		if got.baseURL != defaultBaseURL || got.proPlanID != defaultProPlanID || got.freePlanID != defaultFreePlanID {
			t.Fatalf("FromEnv() = %#v", got)
		}
	})

	t.Run("overrides", func(t *testing.T) {
		t.Setenv("AUTUMN_SECRET_KEY", "  test-key  ")
		t.Setenv("AUTUMN_BASE_URL", " https://autumn.test/ ")
		t.Setenv("AUTUMN_PRO_PLAN_ID", " paid ")
		t.Setenv("AUTUMN_FREE_PLAN_ID", " starter ")

		got := FromEnv()
		if got == nil {
			t.Fatal("FromEnv() = nil")
		}
		if got.secretKey != "test-key" || got.baseURL != "https://autumn.test/" || got.proPlanID != "paid" || got.freePlanID != "starter" {
			t.Fatalf("FromEnv() = %#v", got)
		}
	})
}

func TestCheckAllowed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/balances.check" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.Header.Get("x-api-version"); got != "2.3.0" {
			t.Errorf("x-api-version = %q", got)
		}
		body := decodeBody(t, r)
		if body["customer_id"] != "org-123" || body["feature_id"] != "investigations" {
			t.Errorf("body = %#v", body)
		}
		_, _ = w.Write([]byte(`{"allowed":true,"balance":{"feature_id":"investigations","granted":25,"remaining":12,"usage":13,"unlimited":false,"overage_allowed":false,"next_reset_at":1788220800000}}`))
	}))
	defer srv.Close()

	got := testClient(srv).Check(context.Background(), "org-123", "investigations")
	if !got.Allowed || got.FailedOpen {
		t.Fatalf("Check() = %#v", got)
	}
	if got.Balance == nil || got.Balance.FeatureID != "investigations" || got.Balance.Remaining != 12 {
		t.Fatalf("Check() balance = %#v", got.Balance)
	}
}

func TestCheckDenied(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"allowed":false,"balance":{"feature_id":"investigations","granted":25,"remaining":0,"usage":25,"unlimited":false,"overage_allowed":false,"next_reset_at":1788220800000}}`))
	}))
	defer srv.Close()

	got := testClient(srv).Check(context.Background(), "org-123", "investigations")
	if got.Allowed || got.FailedOpen || got.Balance == nil || got.Balance.Usage != 25 {
		t.Fatalf("Check() = %#v", got)
	}
}

func TestCheckFailsOpenOn500(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "provider unavailable", http.StatusInternalServerError)
	}))
	defer srv.Close()

	got := testClient(srv).Check(context.Background(), "org-123", "investigations")
	if !got.Allowed || !got.FailedOpen {
		t.Fatalf("Check() = %#v", got)
	}
}

func TestCheckFailsOpenOnTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(200 * time.Millisecond):
			_, _ = w.Write([]byte(`{"allowed":false}`))
		}
	}))
	defer srv.Close()
	client := testClient(srv)
	client.httpc.Timeout = 10 * time.Millisecond

	got := client.Check(context.Background(), "org-123", "investigations")
	if !got.Allowed || !got.FailedOpen {
		t.Fatalf("Check() = %#v", got)
	}
}

func TestCheckStrictSurfacesError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "provider unavailable", http.StatusBadGateway)
	}))
	defer srv.Close()

	if _, err := testClient(srv).CheckStrict(context.Background(), "org-123", "investigations"); err == nil {
		t.Fatal("CheckStrict() error = nil")
	}
}

func TestCheckMalformedVerdictFailsOpen(t *testing.T) {
	for _, body := range []string{`{}`, `{"allowed":"false"}`} {
		t.Run(body, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(body))
			}))
			defer srv.Close()

			got := testClient(srv).Check(context.Background(), "org-123", "investigations")
			if !got.Allowed || !got.FailedOpen {
				t.Fatalf("Check() = %#v, want marked fail-open", got)
			}
		})
	}
}

func TestTrack200IsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer srv.Close()

	err := testClient(srv).Track(context.Background(), "org-123", "merged_prs", "pr:one", 1, time.Unix(1_788_220_800, 0))
	if err != nil {
		t.Fatalf("Track() error = %v", err)
	}
}

func TestTrackIdempotencyConflictIsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"duplicate_idempotency_key","message":"duplicate"}`))
	}))
	defer srv.Close()

	if err := testClient(srv).Track(context.Background(), "org-123", "merged_prs", "pr:one", 1, time.Now()); err != nil {
		t.Fatalf("Track() error = %v", err)
	}
}

func TestTrackOther409IsError(t *testing.T) {
	for _, body := range []string{`{"code":"some_other_conflict"}`, `not-json`} {
		t.Run(body, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(body))
			}))
			defer srv.Close()

			if err := testClient(srv).Track(context.Background(), "org-123", "merged_prs", "pr:one", 1, time.Now()); err == nil {
				t.Fatal("Track() error = nil")
			}
		})
	}
}

func TestTrackSendsIdempotencyKeyAndTimestamp(t *testing.T) {
	occurredAt := time.Date(2026, time.August, 31, 23, 59, 58, 123_000_000, time.UTC)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/balances.track" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.Header.Get("Idempotency-Key"); got != "pr:one" {
			t.Errorf("Idempotency-Key = %q", got)
		}
		body := decodeBody(t, r)
		if body["idempotency_key"] != "pr:one" {
			t.Errorf("body idempotency_key = %#v", body["idempotency_key"])
		}
		if body["timestamp"] != float64(occurredAt.UnixMilli()) {
			t.Errorf("body timestamp = %#v", body["timestamp"])
		}
	}))
	defer srv.Close()

	if err := testClient(srv).Track(context.Background(), "org-123", "merged_prs", "pr:one", 1, occurredAt); err != nil {
		t.Fatalf("Track() error = %v", err)
	}
}

func TestEnsureCustomerReturnsPlanID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/customers.get_or_create" {
			t.Errorf("path = %q", r.URL.Path)
		}
		body := decodeBody(t, r)
		if body["customer_id"] != "org-123" || body["name"] != "Acme" || body["auto_enable_plan_id"] != "free" {
			t.Errorf("body = %#v", body)
		}
		_, _ = w.Write([]byte(`{"subscriptions":[{"plan_id":"free","status":"expired"},{"plan_id":"pro","status":"active"}]}`))
	}))
	defer srv.Close()

	planID, err := testClient(srv).EnsureCustomer(context.Background(), "org-123", "Acme")
	if err != nil {
		t.Fatalf("EnsureCustomer() error = %v", err)
	}
	if planID != "pro" {
		t.Fatalf("EnsureCustomer() plan = %q", planID)
	}
}

func TestEnsureCustomerNon2xxIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no customer", http.StatusBadRequest)
	}))
	defer srv.Close()

	if _, err := testClient(srv).EnsureCustomer(context.Background(), "org-123", "Acme"); err == nil {
		t.Fatal("EnsureCustomer() error = nil")
	}
}

func TestAttachProReturnsPaymentURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/billing.attach" {
			t.Errorf("path = %q", r.URL.Path)
		}
		body := decodeBody(t, r)
		if body["customer_id"] != "org-123" || body["plan_id"] != "pro" || body["success_url"] != "https://opslane.example/settings" {
			t.Errorf("body = %#v", body)
		}
		_, _ = w.Write([]byte(`{"payment_url":"https://checkout.stripe.test/session"}`))
	}))
	defer srv.Close()

	url, err := testClient(srv).AttachPro(context.Background(), "org-123", "https://opslane.example/settings")
	if err != nil {
		t.Fatalf("AttachPro() error = %v", err)
	}
	if url != "https://checkout.stripe.test/session" {
		t.Fatalf("AttachPro() = %q", url)
	}
}

func TestAttachProEmptyURLIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"payment_url":null}`))
	}))
	defer srv.Close()

	if _, err := testClient(srv).AttachPro(context.Background(), "org-123", "https://opslane.example/settings"); err == nil {
		t.Fatal("AttachPro() error = nil")
	}
}

func TestPortalURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/billing.open_customer_portal" {
			t.Errorf("path = %q", r.URL.Path)
		}
		body := decodeBody(t, r)
		if body["customer_id"] != "org-123" || body["return_url"] != "https://opslane.example/settings" {
			t.Errorf("body = %#v", body)
		}
		_, _ = w.Write([]byte(`{"url":"https://billing.stripe.test/session"}`))
	}))
	defer srv.Close()

	url, err := testClient(srv).PortalURL(context.Background(), "org-123", "https://opslane.example/settings")
	if err != nil {
		t.Fatalf("PortalURL() error = %v", err)
	}
	if url != "https://billing.stripe.test/session" {
		t.Fatalf("PortalURL() = %q", url)
	}
}

func decodeBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Errorf("decode body: %v", err)
	}
	return body
}

func testClient(srv *httptest.Server) *Client {
	return &Client{
		baseURL:    srv.URL,
		secretKey:  "test-key",
		proPlanID:  defaultProPlanID,
		freePlanID: defaultFreePlanID,
		httpc:      srv.Client(),
	}
}
