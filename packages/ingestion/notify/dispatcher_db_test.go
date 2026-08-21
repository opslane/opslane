package notify

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func testCipher(t *testing.T) *ConfigCipher {
	t.Helper()
	cipher, err := NewConfigCipher([]byte(testSecret))
	if err != nil {
		t.Fatal(err)
	}
	return cipher
}

func TestDispatcherClaimLeaseAndFencing(t *testing.T) {
	pool := testPool(t)
	cipher := testCipher(t)
	seed := seedDelivery(t, pool, cipher, "http://sink.test:9999/hook")
	d := New(pool, cipher, Options{LeaseDuration: 2 * time.Minute, ExtraHosts: []string{"sink.test:9999"}})

	claims, err := d.claim(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	claim, ok := claimFor(claims, seed.DeliveryID)
	if !ok {
		t.Fatalf("seeded delivery not claimed; batch = %+v", claims)
	}
	if claim.Attempts != 1 || claim.LeaseGeneration != 1 {
		t.Fatalf("claim = %+v", claim)
	}
	again, err := d.claim(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, reclaimed := claimFor(again, seed.DeliveryID); reclaimed {
		t.Fatalf("leased delivery was claimed again; batch = %+v", again)
	}

	stale := claim
	stale.LeaseGeneration++
	updated, err := d.complete(context.Background(), stale, Outcome{Class: "delivered"})
	if err != nil || updated {
		t.Fatalf("stale completion updated=%v err=%v", updated, err)
	}
	var status string
	var attempts int
	var generation int64
	var leaseExpires time.Time
	if err := pool.QueryRow(context.Background(), `
		SELECT status, attempts, lease_generation, lease_expires_at
		FROM outbound_deliveries WHERE id = $1`, seed.DeliveryID).Scan(&status, &attempts, &generation, &leaseExpires); err != nil {
		t.Fatal(err)
	}
	if status != "delivering" || attempts != 1 || generation != 1 || time.Until(leaseExpires) < time.Minute {
		t.Fatalf("row status=%s attempts=%d generation=%d lease=%s", status, attempts, generation, leaseExpires)
	}
}

func TestDispatcherClaimSkipsExhaustedRows(t *testing.T) {
	pool := testPool(t)
	cipher := testCipher(t)
	seed := seedDelivery(t, pool, cipher, "http://sink.test:9999/hook")
	if _, err := pool.Exec(context.Background(), `UPDATE outbound_deliveries SET attempts = max_attempts WHERE id = $1`, seed.DeliveryID); err != nil {
		t.Fatal(err)
	}
	claims, err := New(pool, cipher, Options{}).claim(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if claim, ok := claimFor(claims, seed.DeliveryID); ok {
		t.Fatalf("exhausted row was claimed: %+v", claim)
	}
}

func TestDispatcherReapsExpiredAndExhaustedClaims(t *testing.T) {
	pool := testPool(t)
	cipher := testCipher(t)
	retrySeed := seedDelivery(t, pool, cipher, "http://sink.test:9999/retry")
	failedSeed := seedDelivery(t, pool, cipher, "http://sink.test:9999/fail")
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		UPDATE outbound_deliveries SET status = 'delivering', attempts = 1,
		  lease_expires_at = now() - interval '1 second' WHERE id = $1`, retrySeed.DeliveryID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE outbound_deliveries SET status = 'delivering', attempts = max_attempts,
		  lease_expires_at = now() - interval '1 second' WHERE id = $1`, failedSeed.DeliveryID); err != nil {
		t.Fatal(err)
	}

	// reapExpired sweeps the whole table, so its count includes rows other
	// packages seeded. The contract this test owns is the state each of its two
	// rows lands in, asserted below.
	if _, err := New(pool, cipher, Options{}).reapExpired(ctx); err != nil {
		t.Fatalf("reap: %v", err)
	}
	var retryStatus string
	var retryAt time.Time
	if err := pool.QueryRow(ctx, `SELECT status, next_attempt_at FROM outbound_deliveries WHERE id = $1`, retrySeed.DeliveryID).Scan(&retryStatus, &retryAt); err != nil {
		t.Fatal(err)
	}
	if retryStatus != "pending" || !retryAt.After(time.Now()) {
		t.Fatalf("retry status=%s at=%s", retryStatus, retryAt)
	}
	var failedStatus string
	var failedReason *string
	if err := pool.QueryRow(ctx, `SELECT status, last_error FROM outbound_deliveries WHERE id = $1`, failedSeed.DeliveryID).Scan(&failedStatus, &failedReason); err != nil {
		t.Fatal(err)
	}
	if failedStatus != "failed" || failedReason == nil || *failedReason != "lease expired on final attempt" {
		t.Fatalf("failed status=%s reason=%v", failedStatus, failedReason)
	}
}

func TestDispatcherHTTPOutcomesPersistExpectedState(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		retryAfter string
		wantStatus string
	}{
		{"delivered", 200, "", "delivered"},
		{"permanent", 400, "", "failed"},
		{"rate limited", 429, "2", "pending"},
		{"server error", 500, "", "pending"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			pool := testPool(t)
			cipher := testCipher(t)
			server := newScriptedServer(t, tc.status, tc.retryAfter)
			defer server.Close()
			seed := seedDelivery(t, pool, cipher, server.URL+"/hook")
			d := New(pool, cipher, Options{ExtraHosts: []string{serverHost(server)}})
			claims, err := d.claim(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			claim, ok := claimFor(claims, seed.DeliveryID)
			if !ok {
				t.Fatalf("seeded delivery not claimed; batch = %+v", claims)
			}
			d.deliverClaim(context.Background(), claim)

			var status string
			var nextAttempt time.Time
			if err := pool.QueryRow(context.Background(), `SELECT status, next_attempt_at FROM outbound_deliveries WHERE id = $1`, seed.DeliveryID).Scan(&status, &nextAttempt); err != nil {
				t.Fatal(err)
			}
			if status != tc.wantStatus {
				t.Fatalf("status=%s want=%s", status, tc.wantStatus)
			}
			if status == "pending" && !nextAttempt.After(time.Now()) {
				t.Fatalf("next attempt not delayed: %s", nextAttempt)
			}
		})
	}
}

func newScriptedServer(t *testing.T, status int, retryAfter string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte("response"))
	}))
}

type panicFormatter struct{}

func (panicFormatter) Format(EventPayload) ([]byte, string, error) {
	panic("formatter panic")
}

func TestDispatcherRecoversPerDeliveryPanic(t *testing.T) {
	pool := testPool(t)
	cipher := testCipher(t)
	seed := seedDelivery(t, pool, cipher, "http://sink.test:9999/hook")
	d := New(pool, cipher, Options{ExtraHosts: []string{"sink.test:9999"}})
	claims, err := d.claim(context.Background())
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim=%+v err=%v", claims, err)
	}
	original := Formatters["slack"]
	Formatters["slack"] = panicFormatter{}
	t.Cleanup(func() { Formatters["slack"] = original })

	d.deliverClaim(context.Background(), claims[0])
	var status string
	var reason *string
	if err := pool.QueryRow(context.Background(), `SELECT status, last_error FROM outbound_deliveries WHERE id = $1`, seed.DeliveryID).Scan(&status, &reason); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || reason == nil || *reason != "delivery_panic" {
		t.Fatalf("status=%s reason=%v", status, reason)
	}
}

func TestDispatcherNetworkFailureDoesNotPersistWebhook(t *testing.T) {
	pool := testPool(t)
	cipher := testCipher(t)
	secretPath := "/services/T/B/do-not-store-this"
	seed := seedDelivery(t, pool, cipher, "http://sink.test:9999"+secretPath)
	d := New(pool, cipher, Options{ExtraHosts: []string{"sink.test:9999"}})
	d.sender.Client = &http.Client{Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		return nil, &url.Error{Op: "Post", URL: request.URL.String(), Err: errors.New("dial " + request.URL.String())}
	})}
	claims, err := d.claim(context.Background())
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim=%+v err=%v", claims, err)
	}
	d.deliverClaim(context.Background(), claims[0])
	var reason *string
	if err := pool.QueryRow(context.Background(), `SELECT last_error FROM outbound_deliveries WHERE id = $1`, seed.DeliveryID).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason == nil || strings.Contains(*reason, secretPath) || strings.Contains(*reason, "do-not-store-this") {
		t.Fatalf("unsafe last_error: %v", reason)
	}
}
