package identity

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultTestDSN = "postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"

type identityFixture struct {
	OrgID         string
	ProjectID     string
	EnvironmentID string
}

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = defaultTestDSN
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("skipping DB test: cannot connect to postgres: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("skipping DB test: postgres not reachable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedProject(t *testing.T, pool *pgxpool.Pool) identityFixture {
	t.Helper()
	ctx := context.Background()
	f := identityFixture{}
	if err := pool.QueryRow(ctx,
		`INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
		"identity-test-"+uuid.NewString()).Scan(&f.OrgID); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO projects (org_id, name) VALUES ($1, $2) RETURNING id`,
		f.OrgID, "identity-test").Scan(&f.ProjectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`,
		f.ProjectID).Scan(&f.EnvironmentID); err != nil {
		t.Fatalf("seed environment: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE projects SET default_environment_id=$2 WHERE id=$1`,
		f.ProjectID, f.EnvironmentID); err != nil {
		t.Fatalf("set default environment: %v", err)
	}

	t.Cleanup(func() {
		cleanup := []string{
			`DELETE FROM error_group_jobs WHERE project_id=$1`,
			`DELETE FROM error_events WHERE project_id=$1`,
			`DELETE FROM error_group_affected_users WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id=$1)`,
			`DELETE FROM error_groups WHERE project_id=$1`,
			`UPDATE projects SET default_environment_id=NULL WHERE id=$1`,
			`DELETE FROM environments WHERE project_id=$1`,
			`DELETE FROM projects WHERE id=$1`,
		}
		for _, query := range cleanup {
			if _, err := pool.Exec(context.Background(), query, f.ProjectID); err != nil {
				t.Logf("cleanup warning: %v", err)
			}
		}
		if _, err := pool.Exec(context.Background(), `DELETE FROM orgs WHERE id=$1`, f.OrgID); err != nil {
			t.Logf("cleanup warning: %v", err)
		}
	})
	return f
}

func seedResolvedEvent(t *testing.T, pool *pgxpool.Pool, f identityFixture, rawFingerprint, sourceFile, sourceFunction string) string {
	t.Helper()
	ctx := context.Background()
	var eventID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_events
		   (project_id, environment_id, timestamp, error_type, error_message,
		    stack_trace_raw, platform)
		 VALUES ($1,$2,now(),'TypeError','boom',$3,'javascript')
		 RETURNING id`,
		f.ProjectID, f.EnvironmentID, "at handler ("+rawFingerprint+":1:1)").Scan(&eventID); err != nil {
		t.Fatalf("seed event: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO error_event_identities
		   (project_id,event_id,status,raw_fingerprint,identity_version)
		 VALUES ($1,$2,'pending',$3,$4)`,
		f.ProjectID, eventID, rawFingerprint, IdentityVersion); err != nil {
		t.Fatalf("seed identity: %v", err)
	}
	envelope := Envelope{Version: ResolverVersion, Frames: []Frame{{
		OriginalFile: sourceFile, OriginalFunction: sourceFunction, OriginalLine: 10,
		Generated: GeneratedPos{Line: 1, Column: 1},
	}}}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO error_event_resolutions
		   (project_id,event_id,status,envelope,resolver_version)
		 VALUES ($1,$2,'resolved',$3::jsonb,$4)`,
		f.ProjectID, eventID, encoded, ResolverVersion); err != nil {
		t.Fatalf("seed resolution: %v", err)
	}
	return eventID
}

func seedEventWithResolutionStatus(t *testing.T, pool *pgxpool.Pool, f identityFixture, status string) string {
	t.Helper()
	eventID := seedResolvedEvent(t, pool, f, uniqueFingerprint("resolution-"+status), "src/Pending.vue", "load")
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_event_resolutions SET status=$3,envelope=NULL
		  WHERE project_id=$1 AND event_id=$2`, f.ProjectID, eventID, status); err != nil {
		t.Fatalf("set resolution status: %v", err)
	}
	return eventID
}

func seedStuckSettlingIdentity(t *testing.T, pool *pgxpool.Pool, f identityFixture, claimedAt time.Time) string {
	t.Helper()
	eventID := seedEventWithResolutionStatus(t, pool, f, "no_map")
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_event_identities SET status='settling',claimed_at=$3
		  WHERE project_id=$1 AND event_id=$2`, f.ProjectID, eventID, claimedAt); err != nil {
		t.Fatalf("seed stuck identity: %v", err)
	}
	return eventID
}

func seedIssue(t *testing.T, pool *pgxpool.Pool, f identityFixture, fingerprint string) string {
	t.Helper()
	var issueID string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO error_groups
		   (project_id,environment_id,fingerprint,title,platform,first_seen,last_seen,
		    occurrence_count,affected_users_count,status)
		 VALUES ($1,$2,$3,'TypeError: boom','javascript',now(),now(),0,0,'new')
		 RETURNING id`,
		f.ProjectID, f.EnvironmentID, fingerprint).Scan(&issueID); err != nil {
		t.Fatalf("seed issue: %v", err)
	}
	return issueID
}

func seedIssueWithAlias(t *testing.T, pool *pgxpool.Pool, f identityFixture, fingerprint, kind string) string {
	t.Helper()
	issueID := seedIssue(t, pool, f, "group-"+uuid.NewString())
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO canonical_issue_fingerprints
		   (project_id,fingerprint,fingerprint_kind,canonical_issue_id,identity_version,confirmed_by)
		 VALUES ($1,$2,$3,$4,$5,'exact')`,
		f.ProjectID, fingerprint, kind, issueID, IdentityVersion); err != nil {
		t.Fatalf("seed alias: %v", err)
	}
	return issueID
}

func seedIssueWithEvents(t *testing.T, pool *pgxpool.Pool, f identityFixture, count int) string {
	t.Helper()
	ctx := context.Background()
	issueID := seedIssueWithAlias(t, pool, f, uniqueFingerprint("merge-alias"), "raw")
	episodeID := mustOpenEpisode(t, pool, f.ProjectID, issueID)
	for i := 0; i < count; i++ {
		var eventID string
		if err := pool.QueryRow(ctx,
			`INSERT INTO error_events
			   (project_id,environment_id,error_group_id,timestamp,error_type,error_message,
			    stack_trace_raw,platform)
			 VALUES ($1,$2,$3,now()-$4*interval '1 minute',
			         'TypeError','merge fixture','at merge.js:1:1','javascript')
			 RETURNING id`, f.ProjectID, f.EnvironmentID, issueID, i).Scan(&eventID); err != nil {
			t.Fatalf("seed issue event: %v", err)
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO error_event_identities
			   (project_id,event_id,status,canonical_issue_id,raw_fingerprint,
			    identity_version,episode_id,settled_at)
			 VALUES ($1,$2,'settled',$3,$4,$5,$6,now())`,
			f.ProjectID, eventID, issueID, uniqueFingerprint("event-alias"),
			IdentityVersion, episodeID); err != nil {
			t.Fatalf("seed settled identity: %v", err)
		}
	}
	if _, err := pool.Exec(ctx,
		`UPDATE error_groups SET occurrence_count=$3
		  WHERE project_id=$1 AND id=$2`, f.ProjectID, issueID, count); err != nil {
		t.Fatalf("seed issue count: %v", err)
	}
	return issueID
}

func seedMergeBlocker(t *testing.T, pool *pgxpool.Pool, f identityFixture, issueID, blocker string) {
	t.Helper()
	ctx := context.Background()
	var episodeID string
	if err := pool.QueryRow(ctx,
		`SELECT id::text FROM issue_episodes
		  WHERE project_id=$1 AND canonical_issue_id=$2 AND closed_at IS NULL`,
		f.ProjectID, issueID).Scan(&episodeID); err != nil {
		t.Fatalf("read blocker episode: %v", err)
	}
	switch blocker {
	case "investigation":
		if _, err := pool.Exec(ctx,
			`INSERT INTO error_group_jobs
			   (error_group_id,project_id,episode_id,job_type,status)
			 VALUES ($1,$2,$3,'investigate','pending')`,
			issueID, f.ProjectID, episodeID); err != nil {
			t.Fatalf("seed investigation blocker: %v", err)
		}
	case "publication":
		if _, err := pool.Exec(ctx,
			`INSERT INTO issue_publications (project_id,episode_id,channel)
			 VALUES ($1,$2,'digest')`, f.ProjectID, episodeID); err != nil {
			t.Fatalf("seed publication blocker: %v", err)
		}
	case "unified digest item":
		// The unified digest lane writes no issue_publications rows; a delivered
		// run's frozen item set is what proves a reader saw the incident.
		var runID string
		if err := pool.QueryRow(ctx,
			`INSERT INTO digest_runs
			   (project_id,window_from,window_to,run_date,status,unified_cards_mode)
			 VALUES ($1,now()-interval '24 hours',now(),current_date,
			         'delivered','on')
			 RETURNING id::text`, f.ProjectID).Scan(&runID); err != nil {
			t.Fatalf("seed unified digest run: %v", err)
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO digest_unified_run_items
			   (project_id,run_id,error_group_id,candidate_snapshot)
			 VALUES ($1,$2,$3,'{}'::jsonb)`, f.ProjectID, runID, issueID); err != nil {
			t.Fatalf("seed unified digest item blocker: %v", err)
		}
	default:
		t.Fatalf("unknown blocker %q", blocker)
	}
}

func uniqueFingerprint(prefix string) string {
	return fmt.Sprintf("%s-%s-%d", prefix, uuid.NewString(), time.Now().UnixNano())
}
