package handler

import (
	"fmt"
	"math"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

// === Atomic counters for Prometheus-compatible metrics ===

var (
	eventsIngestedTotal struct {
		mu         sync.Mutex
		byPlatform map[string]*atomic.Int64
	}
	debugMetaDiscardedTotal struct {
		mu       sync.Mutex
		byReason map[string]*atomic.Int64
	}
	networkTimingsDiscardedTotal struct {
		mu       sync.Mutex
		byReason map[string]*atomic.Int64
	}
	commitSHADiscardedTotal             atomic.Int64
	eventsWithDebugImagesTotal          atomic.Int64
	debugMetaRegistryZeroMatchedTotal   atomic.Int64
	debugIDGroupingTotal                atomic.Int64
	jobsEnqueuedTotal                   atomic.Int64
	stacklessEventsTotal                atomic.Int64
	suppressedResizeObserverTotal       atomic.Int64
	suppressedScriptErrorTotal          atomic.Int64
	suppressedExtensionOnlyTotal        atomic.Int64
	ingestEnvironmentResolutionDefault  atomic.Int64
	ingestEnvironmentResolutionInvalid  atomic.Int64
	ingestEnvironmentResolutionExisting atomic.Int64
	ingestEnvironmentResolutionCreated  atomic.Int64
	ingestEnvironmentResolutionSession  atomic.Int64
	projectDefaultInvariantNull         atomic.Int64
	ingestEnvironmentSessionDivergence  atomic.Int64
	ingestSessionCrossProjectConflict   atomic.Int64
	ingestErrorsTotal                   struct {
		mu     sync.Mutex
		byType map[string]*atomic.Int64
	}
	keyAuthMu       sync.Mutex
	keyAuthOutcomes = map[string]*atomic.Uint64{}
	mcpAuthMu       sync.Mutex
	mcpAuthOutcomes = map[string]*atomic.Uint64{
		"ok": {}, "missing": {}, "invalid": {}, "wrong_scope": {}, "expired": {}, "lookup_error": {},
	}

	// Histogram for ingest duration (seconds)
	ingestDuration struct {
		mu      sync.Mutex
		buckets []float64 // upper bounds
		counts  []atomic.Int64
		sum     atomic.Int64 // stored as nanoseconds for precision
		count   atomic.Int64
	}
)

func init() {
	ingestErrorsTotal.byType = make(map[string]*atomic.Int64)
	eventsIngestedTotal.byPlatform = map[string]*atomic.Int64{
		"javascript": {},
		"python":     {},
	}
	debugMetaDiscardedTotal.byReason = make(map[string]*atomic.Int64)
	networkTimingsDiscardedTotal.byReason = make(map[string]*atomic.Int64)
	ingestDuration.buckets = []float64{0.01, 0.05, 0.1, 0.25, 0.5, 1.0}
	ingestDuration.counts = make([]atomic.Int64, len(ingestDuration.buckets))
}

// RecordEventIngested increments the events ingested counter.
func RecordEventIngested(platform string) {
	eventsIngestedTotal.mu.Lock()
	counter, ok := eventsIngestedTotal.byPlatform[platform]
	if !ok {
		counter = &atomic.Int64{}
		eventsIngestedTotal.byPlatform[platform] = counter
	}
	eventsIngestedTotal.mu.Unlock()
	counter.Add(1)
}

func RecordDebugMetaDiscard(reason string) {
	switch reason {
	case "malformed_container", "malformed_images", "non_object_image",
		"bad_type", "bad_code_file", "bad_debug_id",
		"ambiguous_code_file", "over_limit":
	default:
		return
	}
	debugMetaDiscardedTotal.mu.Lock()
	counter, ok := debugMetaDiscardedTotal.byReason[reason]
	if !ok {
		counter = &atomic.Int64{}
		debugMetaDiscardedTotal.byReason[reason] = counter
	}
	debugMetaDiscardedTotal.mu.Unlock()
	counter.Add(1)
}

func RecordNetworkTimingDiscard(reason string) {
	switch reason {
	case "malformed_container", "non_object_entry", "bad_transport", "bad_method",
		"bad_url", "bad_outcome", "bad_started_at", "bad_duration", "bad_ttfb",
		"bad_status", "over_limit":
	default:
		return
	}
	networkTimingsDiscardedTotal.mu.Lock()
	counter, ok := networkTimingsDiscardedTotal.byReason[reason]
	if !ok {
		counter = &atomic.Int64{}
		networkTimingsDiscardedTotal.byReason[reason] = counter
	}
	networkTimingsDiscardedTotal.mu.Unlock()
	counter.Add(1)
}

func RecordCommitSHADiscarded() { commitSHADiscardedTotal.Add(1) }

func RecordEventWithDebugImages() { eventsWithDebugImagesTotal.Add(1) }

func RecordDebugMetaRegistryZeroMatched() {
	debugMetaRegistryZeroMatchedTotal.Add(1)
}

// RecordDebugIDGrouping counts events whose frames were actually rewritten
// onto debug IDs. It is incremented only when a substitution fired, not merely
// when images were present — during rollout the gap between "flag is on" and
// this counter is exactly the population still grouping by URL.
func RecordDebugIDGrouping() {
	debugIDGroupingTotal.Add(1)
}

// RecordJobEnqueued increments the jobs enqueued counter.
func RecordJobEnqueued() {
	jobsEnqueuedTotal.Add(1)
}

// RecordStacklessAccepted increments the counter of accepted events that arrived
// with no stack trace (cross-origin "Script error.", non-Error promise rejections).
// Tracks recovery volume after the stack-optional ingest change.
func RecordStacklessAccepted() {
	stacklessEventsTotal.Add(1)
}

// RecordSuppressed increments a fixed-cardinality rung-0 counter. Unknown rule
// names are ignored so detector changes cannot accidentally create metric-label
// cardinality.
func RecordSuppressed(rule string) {
	switch rule {
	case "resize_observer":
		suppressedResizeObserverTotal.Add(1)
	case "script_error":
		suppressedScriptErrorTotal.Add(1)
	case "extension_only":
		suppressedExtensionOnlyTotal.Add(1)
	}
}

func RecordEnvironmentResolution(outcome db.EnvironmentOutcome) {
	switch outcome {
	case db.EnvironmentOutcomeDefault:
		ingestEnvironmentResolutionDefault.Add(1)
	case db.EnvironmentOutcomeInvalidLabel:
		ingestEnvironmentResolutionInvalid.Add(1)
	case db.EnvironmentOutcomeExisting:
		ingestEnvironmentResolutionExisting.Add(1)
	case db.EnvironmentOutcomeCreated:
		ingestEnvironmentResolutionCreated.Add(1)
	case db.EnvironmentOutcomeSession:
		ingestEnvironmentResolutionSession.Add(1)
	}
}

func RecordProjectDefaultInvariant(reason string) {
	if reason == "null_default" {
		projectDefaultInvariantNull.Add(1)
	}
}

func RecordEnvironmentSessionDivergence() { ingestEnvironmentSessionDivergence.Add(1) }

func RecordSessionCrossProjectConflict() { ingestSessionCrossProjectConflict.Add(1) }

func RecordKeyAuth(outcome string) {
	keyAuthMu.Lock()
	counter, ok := keyAuthOutcomes[outcome]
	if !ok {
		counter = &atomic.Uint64{}
		keyAuthOutcomes[outcome] = counter
	}
	keyAuthMu.Unlock()
	counter.Add(1)
}

func RecordMCPAuth(outcome string) {
	mcpAuthMu.Lock()
	counter, ok := mcpAuthOutcomes[outcome]
	mcpAuthMu.Unlock()
	if ok {
		counter.Add(1)
	}
}

// RecordIngestError increments the error counter for the given error type.
func RecordIngestError(errType string) {
	ingestErrorsTotal.mu.Lock()
	counter, ok := ingestErrorsTotal.byType[errType]
	if !ok {
		counter = &atomic.Int64{}
		ingestErrorsTotal.byType[errType] = counter
	}
	ingestErrorsTotal.mu.Unlock()
	counter.Add(1)
}

// RecordIngestDuration records a request duration for the histogram.
// durationSeconds is the elapsed time in seconds.
func RecordIngestDuration(durationSeconds float64) {
	ingestDuration.count.Add(1)
	// Store sum as microseconds (int64) for atomic safety
	microSeconds := int64(durationSeconds * 1e6)
	ingestDuration.sum.Add(microSeconds)

	for i, bound := range ingestDuration.buckets {
		if durationSeconds <= bound {
			ingestDuration.counts[i].Add(1)
			break // only increment the tightest bucket
		}
	}
}

// Metrics serves Prometheus-compatible text metrics at /metrics.
func Metrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")

	// opslane_events_ingested_total
	fmt.Fprintf(w, "# HELP opslane_events_ingested_total Total error events ingested\n")
	fmt.Fprintf(w, "# TYPE opslane_events_ingested_total counter\n")
	eventsIngestedTotal.mu.Lock()
	platforms := make([]string, 0, len(eventsIngestedTotal.byPlatform))
	for platform := range eventsIngestedTotal.byPlatform {
		platforms = append(platforms, platform)
	}
	sort.Strings(platforms)
	for _, platform := range platforms {
		fmt.Fprintf(w, "opslane_events_ingested_total{platform=%q} %d\n", platform, eventsIngestedTotal.byPlatform[platform].Load())
	}
	eventsIngestedTotal.mu.Unlock()
	fmt.Fprintln(w)

	fmt.Fprintln(w, "# HELP opslane_debug_meta_images_discarded_total Debug metadata images discarded during validation")
	fmt.Fprintln(w, "# TYPE opslane_debug_meta_images_discarded_total counter")
	debugMetaDiscardedTotal.mu.Lock()
	reasons := []string{"malformed_container", "malformed_images", "non_object_image", "bad_type", "bad_code_file", "bad_debug_id", "ambiguous_code_file", "over_limit"}
	for _, reason := range reasons {
		count := int64(0)
		if counter := debugMetaDiscardedTotal.byReason[reason]; counter != nil {
			count = counter.Load()
		}
		fmt.Fprintf(w, "opslane_debug_meta_images_discarded_total{reason=%q} %d\n", reason, count)
	}
	debugMetaDiscardedTotal.mu.Unlock()
	fmt.Fprintln(w)

	fmt.Fprintln(w, "# HELP opslane_network_timings_discarded_total Network timing entries discarded during validation")
	fmt.Fprintln(w, "# TYPE opslane_network_timings_discarded_total counter")
	networkTimingsDiscardedTotal.mu.Lock()
	timingReasons := []string{"malformed_container", "non_object_entry", "bad_transport", "bad_method", "bad_url", "bad_outcome", "bad_started_at", "bad_duration", "bad_ttfb", "bad_status", "over_limit"}
	for _, reason := range timingReasons {
		count := int64(0)
		if counter := networkTimingsDiscardedTotal.byReason[reason]; counter != nil {
			count = counter.Load()
		}
		fmt.Fprintf(w, "opslane_network_timings_discarded_total{reason=%q} %d\n", reason, count)
	}
	networkTimingsDiscardedTotal.mu.Unlock()
	fmt.Fprintln(w)

	fmt.Fprintln(w, "# HELP opslane_commit_sha_discarded_total Invalid optional commit SHA fields discarded")
	fmt.Fprintln(w, "# TYPE opslane_commit_sha_discarded_total counter")
	fmt.Fprintf(w, "opslane_commit_sha_discarded_total %d\n\n", commitSHADiscardedTotal.Load())

	fmt.Fprintln(w, "# HELP opslane_events_with_debug_images_total Events ingested with at least one validated debug image")
	fmt.Fprintln(w, "# TYPE opslane_events_with_debug_images_total counter")
	fmt.Fprintf(w, "opslane_events_with_debug_images_total %d\n\n", eventsWithDebugImagesTotal.Load())

	fmt.Fprintln(w, "# HELP opslane_debug_meta_registry_present_zero_matched_total Instrumented events whose SDK registry matched no stack frame")
	fmt.Fprintln(w, "# TYPE opslane_debug_meta_registry_present_zero_matched_total counter")
	fmt.Fprintf(w, "opslane_debug_meta_registry_present_zero_matched_total %d\n\n", debugMetaRegistryZeroMatchedTotal.Load())

	fmt.Fprintln(w, "# HELP opslane_ingest_debug_id_grouping_total Events whose JavaScript stack frames were rewritten onto debug IDs for grouping")
	fmt.Fprintln(w, "# TYPE opslane_ingest_debug_id_grouping_total counter")
	fmt.Fprintf(w, "opslane_ingest_debug_id_grouping_total %d\n\n", debugIDGroupingTotal.Load())

	// opslane_jobs_enqueued_total
	fmt.Fprintf(w, "# HELP opslane_jobs_enqueued_total Total jobs enqueued\n")
	fmt.Fprintf(w, "# TYPE opslane_jobs_enqueued_total counter\n")
	fmt.Fprintf(w, "opslane_jobs_enqueued_total %d\n\n", jobsEnqueuedTotal.Load())

	// opslane_stackless_events_total
	fmt.Fprintf(w, "# HELP opslane_stackless_events_total Total accepted events with no stack trace\n")
	fmt.Fprintf(w, "# TYPE opslane_stackless_events_total counter\n")
	fmt.Fprintf(w, "opslane_stackless_events_total %d\n\n", stacklessEventsTotal.Load())

	fmt.Fprintln(w, "# HELP opslane_suppressed_events_total Total error events intentionally dropped before grouping")
	fmt.Fprintln(w, "# TYPE opslane_suppressed_events_total counter")
	fmt.Fprintf(w, "opslane_suppressed_events_total{rule=\"resize_observer\"} %d\n", suppressedResizeObserverTotal.Load())
	fmt.Fprintf(w, "opslane_suppressed_events_total{rule=\"script_error\"} %d\n", suppressedScriptErrorTotal.Load())
	fmt.Fprintf(w, "opslane_suppressed_events_total{rule=\"extension_only\"} %d\n\n", suppressedExtensionOnlyTotal.Load())

	fmt.Fprintln(w, "# HELP opslane_ingest_environment_resolution_total Committed telemetry environment resolution outcomes")
	fmt.Fprintln(w, "# TYPE opslane_ingest_environment_resolution_total counter")
	fmt.Fprintf(w, "opslane_ingest_environment_resolution_total{outcome=\"default\"} %d\n", ingestEnvironmentResolutionDefault.Load())
	fmt.Fprintf(w, "opslane_ingest_environment_resolution_total{outcome=\"invalid_label\"} %d\n", ingestEnvironmentResolutionInvalid.Load())
	fmt.Fprintf(w, "opslane_ingest_environment_resolution_total{outcome=\"existing\"} %d\n", ingestEnvironmentResolutionExisting.Load())
	fmt.Fprintf(w, "opslane_ingest_environment_resolution_total{outcome=\"created\"} %d\n", ingestEnvironmentResolutionCreated.Load())
	fmt.Fprintf(w, "opslane_ingest_environment_resolution_total{outcome=\"session_authoritative\"} %d\n\n", ingestEnvironmentResolutionSession.Load())

	fmt.Fprintln(w, "# HELP opslane_project_default_invariant_total Project default compatibility invariant violations")
	fmt.Fprintln(w, "# TYPE opslane_project_default_invariant_total counter")
	fmt.Fprintf(w, "opslane_project_default_invariant_total{reason=\"null_default\"} %d\n\n", projectDefaultInvariantNull.Load())

	fmt.Fprintln(w, "# HELP opslane_ingest_env_session_divergence_total Total environment mismatches involving an existing or out-of-order session")
	fmt.Fprintln(w, "# TYPE opslane_ingest_env_session_divergence_total counter")
	fmt.Fprintf(w, "opslane_ingest_env_session_divergence_total %d\n\n", ingestEnvironmentSessionDivergence.Load())

	fmt.Fprintln(w, "# HELP opslane_ingest_session_cross_project_conflict_total Total session registrations rejected because the id belongs to another project")
	fmt.Fprintln(w, "# TYPE opslane_ingest_session_cross_project_conflict_total counter")
	fmt.Fprintf(w, "opslane_ingest_session_cross_project_conflict_total %d\n\n", ingestSessionCrossProjectConflict.Load())

	fmt.Fprintln(w, "# HELP opslane_key_auth_total Project API key authentication outcomes")
	fmt.Fprintln(w, "# TYPE opslane_key_auth_total counter")
	keyAuthMu.Lock()
	for outcome, counter := range keyAuthOutcomes {
		fmt.Fprintf(w, "opslane_key_auth_total{outcome=%q} %d\n", outcome, counter.Load())
	}
	keyAuthMu.Unlock()
	fmt.Fprintln(w)

	fmt.Fprintln(w, "# HELP opslane_mcp_auth_total MCP bearer authentication outcomes")
	fmt.Fprintln(w, "# TYPE opslane_mcp_auth_total counter")
	mcpAuthMu.Lock()
	for outcome, counter := range mcpAuthOutcomes {
		fmt.Fprintf(w, "opslane_mcp_auth_total{outcome=%q} %d\n", outcome, counter.Load())
	}
	mcpAuthMu.Unlock()
	fmt.Fprintln(w)

	// opslane_ingest_errors_total
	fmt.Fprintf(w, "# HELP opslane_ingest_errors_total Total ingest errors by type\n")
	fmt.Fprintf(w, "# TYPE opslane_ingest_errors_total counter\n")
	ingestErrorsTotal.mu.Lock()
	for errType, counter := range ingestErrorsTotal.byType {
		fmt.Fprintf(w, "opslane_ingest_errors_total{error_type=%q} %d\n", errType, counter.Load())
	}
	ingestErrorsTotal.mu.Unlock()
	fmt.Fprintln(w)

	// opslane_ingest_duration_seconds histogram
	fmt.Fprintf(w, "# HELP opslane_ingest_duration_seconds Ingest request duration\n")
	fmt.Fprintf(w, "# TYPE opslane_ingest_duration_seconds histogram\n")

	cumulativeCount := int64(0)
	for i, bound := range ingestDuration.buckets {
		cumulativeCount += ingestDuration.counts[i].Load()
		fmt.Fprintf(w, "opslane_ingest_duration_seconds_bucket{le=\"%s\"} %d\n",
			formatFloat(bound), cumulativeCount)
	}
	totalCount := ingestDuration.count.Load()
	fmt.Fprintf(w, "opslane_ingest_duration_seconds_bucket{le=\"+Inf\"} %d\n", totalCount)

	sumMicro := ingestDuration.sum.Load()
	sumSeconds := float64(sumMicro) / 1e6
	fmt.Fprintf(w, "opslane_ingest_duration_seconds_sum %s\n", formatFloat(sumSeconds))
	fmt.Fprintf(w, "opslane_ingest_duration_seconds_count %d\n\n", totalCount)

	// opslane_notification_deliveries_total
	fmt.Fprintln(w, "# HELP opslane_notification_deliveries_total Total notification delivery attempts by destination type and outcome")
	fmt.Fprintln(w, "# TYPE opslane_notification_deliveries_total counter")
	for _, metric := range notify.DeliveryMetricsSnapshot() {
		fmt.Fprintf(w, "opslane_notification_deliveries_total{type=%q,outcome=%q} %d\n",
			metric.DestinationType, metric.Outcome, metric.Count)
	}
}

// formatFloat formats a float without trailing zeros.
func formatFloat(f float64) string {
	if f == math.Trunc(f) {
		return fmt.Sprintf("%.1f", f)
	}
	return fmt.Sprintf("%g", f)
}
