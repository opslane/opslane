package identity

import (
	"bytes"
	"context"
	"os"
	"testing"
)

func TestSettleAttachesTwoFingerprintsToOneIssue(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	a := seedResolvedEvent(t, pool, f, uniqueFingerprint("entry-index-aaa"), "src/Assets.vue", "deleteAsset")
	b := seedResolvedEvent(t, pool, f, uniqueFingerprint("entry-index-bbb"), "src/Assets.vue", "deleteAsset")

	ra, err := Settle(ctx, pool, f.ProjectID, a)
	if err != nil {
		t.Fatalf("settle a: %v", err)
	}
	rb, err := Settle(ctx, pool, f.ProjectID, b)
	if err != nil {
		t.Fatalf("settle b: %v", err)
	}
	if ra.CanonicalIssueID != rb.CanonicalIssueID {
		t.Errorf("same source location must settle to one issue: %s != %s", ra.CanonicalIssueID, rb.CanonicalIssueID)
	}
	var issues int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM error_groups WHERE project_id=$1`, f.ProjectID).Scan(&issues); err != nil {
		t.Fatal(err)
	}
	if issues != 1 {
		t.Errorf("issues = %d, want 1", issues)
	}
}

func TestSettleRecordsConflictWithoutMerging(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	raw := uniqueFingerprint("raw")
	envelope := Envelope{Version: ResolverVersion, Frames: []Frame{{
		OriginalFile: "src/Conflict.vue", OriginalFunction: "submit", OriginalLine: 7,
	}}}
	resolved := Hash(envelope)
	issueA := seedIssueWithAlias(t, pool, f, raw, "raw")
	issueB := seedIssueWithAlias(t, pool, f, resolved, "resolved")
	eventID := seedResolvedEvent(t, pool, f, raw, "src/Conflict.vue", "submit")

	res, err := Settle(ctx, pool, f.ProjectID, eventID)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if res.State != "conflict" {
		t.Errorf("state = %q, want conflict", res.State)
	}
	var aliasCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM canonical_issue_fingerprints
		  WHERE project_id=$1 AND canonical_issue_id IN ($2,$3)`,
		f.ProjectID, issueA, issueB).Scan(&aliasCount); err != nil {
		t.Fatal(err)
	}
	if aliasCount != 2 {
		t.Errorf("conflict must not rebind aliases: got %d, want 2", aliasCount)
	}
	var conflicts int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_alias_conflicts
		  WHERE project_id=$1 AND event_id=$2 AND status='open'`,
		f.ProjectID, eventID).Scan(&conflicts); err != nil {
		t.Fatal(err)
	}
	if conflicts != 1 {
		t.Errorf("open conflicts = %d, want 1", conflicts)
	}
	if retry, err := Settle(ctx, pool, f.ProjectID, eventID); err != nil || retry.State != "conflict" {
		t.Fatalf("conflict retry = %#v, %v; want terminal conflict", retry, err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_alias_conflicts
		  WHERE project_id=$1 AND event_id=$2`, f.ProjectID, eventID).Scan(&conflicts); err != nil {
		t.Fatal(err)
	}
	if conflicts != 1 {
		t.Errorf("conflict retry wrote %d ledger rows, want 1", conflicts)
	}
}

func TestSettleIsIdempotent(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	eventID := seedResolvedEvent(t, pool, f, uniqueFingerprint("raw"), "src/A.vue", "f")

	first, err := Settle(ctx, pool, f.ProjectID, eventID)
	if err != nil {
		t.Fatalf("first settle: %v", err)
	}
	second, err := Settle(ctx, pool, f.ProjectID, eventID)
	if err != nil {
		t.Fatalf("second settle: %v", err)
	}
	if first.CanonicalIssueID != second.CanonicalIssueID {
		t.Errorf("retry changed the issue: %s -> %s", first.CanonicalIssueID, second.CanonicalIssueID)
	}
	var occurrences int
	if err := pool.QueryRow(ctx,
		`SELECT occurrence_count FROM error_groups WHERE id=$1`, first.CanonicalIssueID).Scan(&occurrences); err != nil {
		t.Fatal(err)
	}
	if occurrences != 1 {
		t.Errorf("occurrence_count = %d, want 1 (retry must not double-count)", occurrences)
	}
	var environmentOccurrences int
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(sum(occurrence_count),0) FROM error_group_environments
		  WHERE error_group_id=$1`, first.CanonicalIssueID).Scan(&environmentOccurrences); err != nil {
		t.Fatal(err)
	}
	if environmentOccurrences != 1 {
		t.Errorf("environment occurrence_count = %d, want 1", environmentOccurrences)
	}
}

func TestSettleNeverReadsSampleEventID(t *testing.T) {
	src, err := os.ReadFile("settle.go")
	if err != nil {
		t.Fatalf("read settle.go: %v", err)
	}
	if bytes.Contains(src, []byte("sample_event_id")) {
		t.Error("settle.go must not reference the mutable representative event")
	}
}

func TestSettleRequiresATerminalResolution(t *testing.T) {
	pool := testPool(t)
	f := seedProject(t, pool)
	eventID := seedEventWithResolutionStatus(t, pool, f, "pending")
	if _, err := Settle(context.Background(), pool, f.ProjectID, eventID); err == nil {
		t.Fatal("pending resolution must not settle")
	}
	assertIdentityStatus(t, pool, f.ProjectID, eventID, "pending")
}

func TestSettleUsesRawAliasForNoMapResolution(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	eventID := seedEventWithResolutionStatus(t, pool, f, "no_map")
	result, err := Settle(ctx, pool, f.ProjectID, eventID)
	if err != nil {
		t.Fatalf("settle raw fallback: %v", err)
	}
	var aliases int
	var resolved *string
	if err := pool.QueryRow(ctx,
		`SELECT (SELECT count(*) FROM canonical_issue_fingerprints
		          WHERE project_id=$1 AND canonical_issue_id=$2),resolved_fingerprint
		   FROM error_event_identities WHERE project_id=$1 AND event_id=$3`,
		f.ProjectID, result.CanonicalIssueID, eventID).Scan(&aliases, &resolved); err != nil {
		t.Fatal(err)
	}
	if aliases != 1 || resolved != nil {
		t.Errorf("raw fallback aliases=%d resolved=%v, want 1 and nil", aliases, resolved)
	}
}
