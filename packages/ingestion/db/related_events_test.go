package db_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func endUser(t *testing.T, pool *pgxpool.Pool, projectID, key string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `INSERT INTO end_users (project_id, external_user_id) VALUES ($1,$2) ON CONFLICT (project_id, external_user_id) DO UPDATE SET external_user_id=EXCLUDED.external_user_id RETURNING id`, projectID, key).Scan(&id); err != nil {
		t.Fatalf("seed end user: %v", err)
	}
	return id
}

var fingerprintSeq int

func nextFingerprint() int { fingerprintSeq++; return fingerprintSeq }

func seedMatchingGroup(t *testing.T, pool *pgxpool.Pool, projectID, environmentID, platform, message string, userKeys []string, at time.Time) string {
	t.Helper()
	ctx := context.Background()
	var groupID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups (project_id,fingerprint,title,first_seen,last_seen,occurrence_count,affected_users_count,status,kind,platform,environment_id) VALUES ($1,$2,$3,$4,$4,$5,$5,'needs_human','error',$6,$7) RETURNING id`, projectID, fmt.Sprintf("fp-%d", nextFingerprint()), message, at, len(userKeys), platform, environmentID).Scan(&groupID); err != nil {
		t.Fatalf("seed group: %v", err)
	}
	for _, key := range userKeys {
		if _, err := pool.Exec(ctx, `INSERT INTO error_events (project_id,environment_id,error_group_id,"timestamp",error_type,error_message,stack_trace_raw,platform,end_user_id) VALUES ($1,$2,$3,$4,'Nu',$5,'raw',$6,$7)`, projectID, environmentID, groupID, at, message, platform, endUser(t, pool, projectID, key)); err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}
	return groupID
}

func relatedFixture(t *testing.T) (*pgxpool.Pool, string, string) {
	pool := testPool(t)
	orgID, projectID, environmentID, _ := seedIssueFixture(t, pool)
	t.Cleanup(func() { cleanupTenant(t, pool, orgID) })
	return pool, projectID, environmentID
}

func TestRelatedEventTotalsCountsEventsNotRollups(t *testing.T) {
	pool, projectID, environmentID := relatedFixture(t)
	base := time.Date(2026, 7, 27, 10, 0, 0, 0, time.UTC)
	seedMatchingGroup(t, pool, projectID, environmentID, "browser", "Error deleting Assets", []string{"u1", "u2"}, base)
	seedMatchingGroup(t, pool, projectID, environmentID, "browser", "Error deleting Assets", []string{"u1"}, base.Add(48*time.Hour))
	seedMatchingGroup(t, pool, projectID, environmentID, "browser", "Error deleting Asset Types", []string{"u3"}, base)
	seedMatchingGroup(t, pool, projectID, environmentID, "python", "Error deleting Assets", []string{"u4"}, base)
	got, err := db.New(pool).RelatedEventTotals(context.Background(), projectID, environmentID, "browser", "Error deleting Assets", 50)
	if err != nil || got.People != 2 || got.Occurrences != 3 || got.IssueCount != 2 || len(got.Issues) != 2 || !got.FirstSeen.Equal(base) {
		t.Fatalf("got=%+v err=%v", got, err)
	}
}

func TestRelatedEventTotalsExcludesArchivedAndMergedIssues(t *testing.T) {
	pool, p, e := relatedFixture(t)
	base := time.Date(2026, 7, 27, 10, 0, 0, 0, time.UTC)
	keep := seedMatchingGroup(t, pool, p, e, "browser", "Request failed", []string{"u1"}, base)
	archived := seedMatchingGroup(t, pool, p, e, "browser", "Request failed", []string{"u2"}, base)
	merged := seedMatchingGroup(t, pool, p, e, "browser", "Request failed", []string{"u3"}, base)
	pool.Exec(context.Background(), `UPDATE error_groups SET archived_at=now() WHERE id=$1`, archived)
	pool.Exec(context.Background(), `UPDATE error_groups SET merged_at=now() WHERE id=$1`, merged)
	got, err := db.New(pool).RelatedEventTotals(context.Background(), p, e, "browser", "Request failed", 50)
	if err != nil || got.IssueCount != 1 || got.Issues[0].ID != keep {
		t.Fatalf("got=%+v err=%v", got, err)
	}
}

func TestRelatedEventTotalsFlagsAResolvedIssueTheFamilyOutlived(t *testing.T) {
	pool, p, e := relatedFixture(t)
	base := time.Date(2026, 7, 27, 10, 0, 0, 0, time.UTC)
	old := seedMatchingGroup(t, pool, p, e, "browser", "Error deleting Assets", []string{"u1"}, base)
	pool.Exec(context.Background(), `UPDATE error_groups SET status='resolved',resolved_at=$2 WHERE id=$1`, old, base.Add(time.Hour))
	seedMatchingGroup(t, pool, p, e, "browser", "Error deleting Assets", []string{"u2"}, base.Add(72*time.Hour))
	got, err := db.New(pool).RelatedEventTotals(context.Background(), p, e, "browser", "Error deleting Assets", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, issue := range got.Issues {
		if issue.ID == old && !issue.Recurred {
			t.Fatal("resolved issue not flagged")
		}
		if issue.ID != old && issue.Recurred {
			t.Fatal("unresolved issue flagged")
		}
	}
}

func TestRelatedEventTotalsIsScopedToOneEnvironment(t *testing.T) {
	pool, p, e := relatedFixture(t)
	var other string
	if err := pool.QueryRow(context.Background(), `INSERT INTO environments (project_id,name) VALUES ($1,'staging') RETURNING id`, p).Scan(&other); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 7, 27, 10, 0, 0, 0, time.UTC)
	seedMatchingGroup(t, pool, p, e, "browser", "x", []string{"u1"}, base)
	seedMatchingGroup(t, pool, p, other, "browser", "x", []string{"u2"}, base)
	got, err := db.New(pool).RelatedEventTotals(context.Background(), p, e, "browser", "x", 50)
	if err != nil || got.IssueCount != 1 || got.Occurrences != 1 {
		t.Fatalf("got=%+v err=%v", got, err)
	}
}

func TestRelatedEventTotalsTruncatesDeterministically(t *testing.T) {
	pool, p, e := relatedFixture(t)
	base := time.Date(2026, 7, 27, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 5; i++ {
		seedMatchingGroup(t, pool, p, e, "browser", "Request failed", []string{"u1"}, base.Add(time.Duration(i)*time.Hour))
	}
	got, err := db.New(pool).RelatedEventTotals(context.Background(), p, e, "browser", "Request failed", 3)
	if err != nil || len(got.Issues) != 3 || got.Truncated != 2 || got.IssueCount != 5 {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	for i := 1; i < len(got.Issues); i++ {
		if got.Issues[i].FirstSeen.Before(got.Issues[i-1].FirstSeen) {
			t.Fatal("not sorted")
		}
	}
}
