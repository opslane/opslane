package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/notify"
)

func TestRecordStacklessAccepted_AppearsInMetrics(t *testing.T) {
	RecordStacklessAccepted()

	req := httptest.NewRequest("GET", "/metrics", nil)
	w := httptest.NewRecorder()
	Metrics(w, req)

	body := w.Body.String()
	if !strings.Contains(body, "opslane_stackless_events_total") {
		t.Errorf("expected opslane_stackless_events_total in /metrics output, got:\n%s", body)
	}
}

func TestNotificationDeliveriesAppearInMetrics(t *testing.T) {
	countBefore := func(outcome string) int64 {
		for _, metric := range notify.DeliveryMetricsSnapshot() {
			if metric.DestinationType == "slack" && metric.Outcome == outcome {
				return metric.Count
			}
		}
		return 0
	}
	deliveredBefore := countBefore("delivered")
	retryBefore := countBefore("retry")
	notify.RecordDelivery("slack", "delivered")
	notify.RecordDelivery("slack", "delivered")
	notify.RecordDelivery("slack", "retry")

	req := httptest.NewRequest("GET", "/metrics", nil)
	w := httptest.NewRecorder()
	Metrics(w, req)
	body := w.Body.String()
	if !strings.Contains(body, "# TYPE opslane_notification_deliveries_total counter") {
		t.Fatalf("notification metric metadata missing:\n%s", body)
	}
	if want := fmt.Sprintf(`opslane_notification_deliveries_total{type="slack",outcome="delivered"} %d`, deliveredBefore+2); !strings.Contains(body, want) {
		t.Fatalf("delivered metric missing:\n%s", body)
	}
	if want := fmt.Sprintf(`opslane_notification_deliveries_total{type="slack",outcome="retry"} %d`, retryBefore+1); !strings.Contains(body, want) {
		t.Fatalf("retry metric missing:\n%s", body)
	}
}

func TestKeyAuthMetricRenders(t *testing.T) {
	RecordKeyAuth("ok")
	RecordKeyAuth("invalid_key")

	rec := httptest.NewRecorder()
	Metrics(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	for _, want := range []string{
		`opslane_key_auth_total{outcome="ok"}`,
		`opslane_key_auth_total{outcome="invalid_key"}`,
	} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("metrics output missing %q", want)
		}
	}
}
