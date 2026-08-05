package db_test

import (
	"context"
	"os"
	"regexp"
	"sort"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

type regressionFixture struct {
	q         *db.Queries
	projectID string
	envID     string
}

func newRegressionFixture(t *testing.T, name string) regressionFixture {
	t.Helper()
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, name)
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	project, err := q.CreateProject(ctx, org.ID, name+"-project", ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	environment, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}

	return regressionFixture{q: q, projectID: project.ID, envID: environment.ID}
}

func (f regressionFixture) ingest(t *testing.T, fingerprint, release string, eventTime time.Time) *db.IngestResult {
	t.Helper()
	result, err := f.q.InsertErrorEventAndGroup(context.Background(), db.IngestParams{
		ProjectID:            f.projectID,
		DefaultEnvironmentID: f.envID,
		ErrorType:            "TypeError",
		ErrorMessage:         "regression test error",
		StackTraceRaw:        "at regression.js:1:1",
		Fingerprint:          fingerprint,
		Title:                "TypeError: regression test error",
		Release:              release,
		EventTime:            eventTime,
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup(%q, %q): %v", fingerprint, release, err)
	}
	return result
}

func (f regressionFixture) markResolved(t *testing.T, groupID string, resolvedRelease *string, reasonCode *string) {
	t.Helper()
	if _, err := f.q.Pool().Exec(context.Background(),
		`UPDATE error_groups
		 SET status = 'resolved', resolved_at = now(), resolved_reason = 'manual',
		     resolved_in_release = $2, reason_code = $3,
		     reason_message = CASE WHEN $3::text IS NULL THEN NULL ELSE 'reason' END,
		     remediation = CASE WHEN $3::text IS NULL THEN NULL ELSE 'remediation' END
		 WHERE id = $1 AND project_id = $4`,
		groupID, resolvedRelease, reasonCode, f.projectID,
	); err != nil {
		t.Fatalf("mark group resolved: %v", err)
	}
}

func TestRegressionReleaseOrderingAndFallbacks(t *testing.T) {
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	resolvedRelease := "release-resolved"

	tests := []struct {
		name            string
		candidate       string
		storedRelease   *string
		seedOlder       bool
		wantRequeued    bool
		wantFinalStatus string
	}{
		{name: "strictly older release stays resolved", candidate: "release-older", storedRelease: &resolvedRelease, seedOlder: true, wantFinalStatus: "resolved"},
		{name: "same release regresses", candidate: resolvedRelease, storedRelease: &resolvedRelease, wantRequeued: true, wantFinalStatus: "queued"},
		{name: "newer release regresses", candidate: "release-newer", storedRelease: &resolvedRelease, wantRequeued: true, wantFinalStatus: "queued"},
		{name: "missing incoming release falls back", candidate: "", storedRelease: &resolvedRelease, wantRequeued: true, wantFinalStatus: "queued"},
		{name: "missing resolved release falls back", candidate: "release-newer", storedRelease: nil, wantRequeued: true, wantFinalStatus: "queued"},
		{name: "unranked resolved release falls back", candidate: "release-newer", storedRelease: ptrStr("release-never-seen"), wantRequeued: true, wantFinalStatus: "queued"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newRegressionFixture(t, "regression-order-"+tc.name)
			if tc.seedOlder {
				fixture.ingest(t, "older-release-seed", tc.candidate, base)
			}
			initial := fixture.ingest(t, "target", resolvedRelease, base.Add(time.Hour))
			fixture.markResolved(t, initial.GroupID, tc.storedRelease, nil)

			result := fixture.ingest(t, "target", tc.candidate, base.Add(2*time.Hour))
			if result.Requeued != tc.wantRequeued {
				t.Fatalf("Requeued = %v, want %v", result.Requeued, tc.wantRequeued)
			}

			var status string
			var resolvedInRelease, resolvedReason *string
			if err := fixture.q.Pool().QueryRow(context.Background(),
				`SELECT status, resolved_in_release, resolved_reason FROM error_groups WHERE id = $1`,
				initial.GroupID,
			).Scan(&status, &resolvedInRelease, &resolvedReason); err != nil {
				t.Fatalf("read group provenance: %v", err)
			}
			if status != tc.wantFinalStatus {
				t.Errorf("status = %q, want %q", status, tc.wantFinalStatus)
			}
			if tc.wantRequeued && (resolvedInRelease != nil || resolvedReason != nil) {
				t.Errorf("requeue left provenance: resolved_in_release=%v resolved_reason=%v", resolvedInRelease, resolvedReason)
			}
		})
	}
}

func reasonCodeCatalog(t *testing.T) []string {
	t.Helper()
	source, err := os.ReadFile("../../../shared/src/types.ts")
	if err != nil {
		t.Fatalf("read ReasonCode catalog: %v", err)
	}
	block := regexp.MustCompile(`(?s)export type ReasonCode =(.+?);`).FindSubmatch(source)
	if block == nil {
		t.Fatal("ReasonCode catalog not found in shared/src/types.ts")
	}
	matches := regexp.MustCompile(`'([^']+)'`).FindAllSubmatch(block[1], -1)
	codes := make([]string, 0, len(matches))
	for _, match := range matches {
		codes = append(codes, string(match[1]))
	}
	if len(codes) == 0 {
		t.Fatal("ReasonCode catalog is empty")
	}
	sort.Strings(codes)
	return codes
}

func TestRegressionReasonCodePermanenceMatchesCatalog(t *testing.T) {
	permanent := map[string]bool{
		"auth_invalid":            true,
		"low_confidence_fix":      true,
		"policy_blocked":          true,
		"repro_not_achievable":    true,
		"tests_failed":            true,
		"triage_unfixable":        true,
		"unfixable_infra":         true,
		"unfixable_no_app_frames": true,
		"unfixable_test_error":    true,
		"unfixable_third_party":   true,
	}
	fixture := newRegressionFixture(t, "regression-reason-catalog")
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	resolvedRelease := "release-resolved"

	for i, code := range reasonCodeCatalog(t) {
		t.Run(code, func(t *testing.T) {
			fingerprint := "reason-" + code
			initial := fixture.ingest(t, fingerprint, resolvedRelease, base.Add(time.Duration(i)*time.Minute))
			fixture.markResolved(t, initial.GroupID, &resolvedRelease, &code)

			result := fixture.ingest(t, fingerprint, "release-newer", base.Add(24*time.Hour+time.Duration(i)*time.Minute))
			wantRequeued := !permanent[code]
			if result.Requeued != wantRequeued {
				t.Errorf("reason %q: Requeued = %v, want %v", code, result.Requeued, wantRequeued)
			}
		})
	}
}

func TestRegressionManualResolveStampsNewestReleaseByFirstSeen(t *testing.T) {
	fixture := newRegressionFixture(t, "regression-manual-provenance")
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)

	// Ranking is by first-seen created_at (server arrival, ingest order), not the
	// client timestamp. release-b is ingested after release-a's first event, so it
	// is the newest release even though release-a keeps receiving later events.
	target := fixture.ingest(t, "manual-target", "release-a", base)
	fixture.ingest(t, "release-b-seed", "release-b", base.Add(2*time.Hour))
	fixture.ingest(t, "manual-target", "release-a", base.Add(4*time.Hour))

	if err := fixture.q.ResolveErrorGroup(context.Background(), fixture.projectID, target.GroupID); err != nil {
		t.Fatalf("ResolveErrorGroup: %v", err)
	}
	var status, resolvedReason string
	var resolvedInRelease *string
	if err := fixture.q.Pool().QueryRow(context.Background(),
		`SELECT status, resolved_reason, resolved_in_release FROM error_groups WHERE id = $1`,
		target.GroupID,
	).Scan(&status, &resolvedReason, &resolvedInRelease); err != nil {
		t.Fatalf("read resolved provenance: %v", err)
	}
	if status != "resolved" || resolvedReason != "manual" {
		t.Errorf("resolved state = (%q, %q), want (resolved, manual)", status, resolvedReason)
	}
	if resolvedInRelease == nil || *resolvedInRelease != "release-b" {
		t.Errorf("resolved_in_release = %v, want release-b", resolvedInRelease)
	}
}
