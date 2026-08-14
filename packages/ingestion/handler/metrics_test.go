package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/grouping"
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

func TestRecordDebugIDGrouping_AppearsInMetrics(t *testing.T) {
	before := debugIDGroupingTotal.Load()
	RecordDebugIDGrouping()

	w := httptest.NewRecorder()
	Metrics(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	want := fmt.Sprintf("opslane_ingest_debug_id_grouping_total %d", before+1)
	if !strings.Contains(w.Body.String(), want) {
		t.Fatalf("debug-ID grouping metric missing %q:\n%s", want, w.Body.String())
	}
}

func TestRecordNetworkTimingDiscard_AppearsInMetrics(t *testing.T) {
	RecordNetworkTimingDiscard("bad_url")
	RecordNetworkTimingDiscard("unbounded_label")

	w := httptest.NewRecorder()
	Metrics(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := w.Body.String()
	if !strings.Contains(body, `opslane_network_timings_discarded_total{reason="bad_url"}`) {
		t.Fatalf("network timing discard metric missing:\n%s", body)
	}
	if strings.Contains(body, `reason="unbounded_label"`) {
		t.Fatalf("unexpected unbounded reason label:\n%s", body)
	}
}

func TestRecordSuppressed_AppearsInMetrics(t *testing.T) {
	before := suppressedResizeObserverTotal.Load()
	RecordSuppressed("resize_observer")
	RecordSuppressed("unknown")

	w := httptest.NewRecorder()
	Metrics(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	want := fmt.Sprintf(`opslane_suppressed_events_total{rule="resize_observer"} %d`, before+1)
	if !strings.Contains(w.Body.String(), want) {
		t.Fatalf("suppression metric missing %q:\n%s", want, w.Body.String())
	}
	for _, rule := range []string{"script_error", "extension_only"} {
		if !strings.Contains(w.Body.String(), `opslane_suppressed_events_total{rule="`+rule+`"}`) {
			t.Fatalf("fixed suppression rule %q missing:\n%s", rule, w.Body.String())
		}
	}
}

// suppressedCount reads a rule's counter back out of the exposition text.
// Reporting found=false covers both halves of the wiring: a rule missing from the
// RecordSuppressed switch AND a rule missing its line in Metrics.
func suppressedCount(t *testing.T, rule string) (count int64, found bool) {
	t.Helper()
	w := httptest.NewRecorder()
	Metrics(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	prefix := `opslane_suppressed_events_total{rule="` + rule + `"} `
	for _, line := range strings.Split(w.Body.String(), "\n") {
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		parsed, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, prefix)), 10, 64)
		if err != nil {
			t.Fatalf("rule %q counter is not an integer: %q", rule, line)
		}
		return parsed, true
	}
	return 0, false
}

// Suppression deletes customer events. A rule that Suppress can return but that
// RecordSuppressed silently ignores would drop that data with no counter and no
// log line, so the two sets must not be allowed to drift.
func TestRecordSuppressed_EveryRuleHasACounter(t *testing.T) {
	if len(grouping.SuppressRules) == 0 {
		t.Fatal("grouping.SuppressRules is empty — the drift guard would pass vacuously")
	}
	for _, rule := range grouping.SuppressRules {
		t.Run(rule, func(t *testing.T) {
			before, found := suppressedCount(t, rule)
			if !found {
				t.Fatalf("rule %q has no opslane_suppressed_events_total line in Metrics", rule)
			}
			RecordSuppressed(rule)
			after, _ := suppressedCount(t, rule)
			if after != before+1 {
				t.Fatalf("rule %q is not wired into RecordSuppressed: counter %d -> %d", rule, before, after)
			}
		})
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
