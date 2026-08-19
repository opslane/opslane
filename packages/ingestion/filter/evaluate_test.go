package filter

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultTestDSN = "postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"

type filterFixture struct {
	projectID     string
	environmentID string
	episodeID     string
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

func seedEpisode(t *testing.T, pool *pgxpool.Pool) filterFixture {
	t.Helper()
	ctx := context.Background()
	var orgID string
	f := filterFixture{}
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ($1) RETURNING id`, "filter-"+uuid.NewString()).Scan(&orgID); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id,name) VALUES ($1,'filter-test') RETURNING id`, orgID).Scan(&f.projectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO environments (project_id,name) VALUES ($1,'production') RETURNING id`, f.projectID).Scan(&f.environmentID); err != nil {
		t.Fatalf("seed environment: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE projects SET default_environment_id=$2 WHERE id=$1`, f.projectID, f.environmentID); err != nil {
		t.Fatalf("set default environment: %v", err)
	}
	var issueID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_groups
		   (project_id,environment_id,fingerprint,title,platform,first_seen,last_seen,occurrence_count,status)
		 VALUES ($1,$2,$3,'TypeError: filter','javascript',now(),now(),0,'new') RETURNING id`,
		f.projectID, f.environmentID, "filter:"+uuid.NewString()).Scan(&issueID); err != nil {
		t.Fatalf("seed issue: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence) VALUES ($1,$2,1) RETURNING id`,
		f.projectID, issueID).Scan(&f.episodeID); err != nil {
		t.Fatalf("seed episode: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM error_group_jobs WHERE project_id=$1`, f.projectID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM error_events WHERE project_id=$1`, f.projectID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM error_groups WHERE project_id=$1`, f.projectID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM end_users WHERE project_id=$1`, f.projectID)
		_, _ = pool.Exec(context.Background(), `UPDATE projects SET default_environment_id=NULL WHERE id=$1`, f.projectID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM environments WHERE project_id=$1`, f.projectID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM projects WHERE id=$1`, f.projectID)
		if _, err := pool.Exec(context.Background(), `DELETE FROM orgs WHERE id=$1`, orgID); err != nil {
			t.Logf("cleanup warning: %v", err)
		}
	})
	return f
}

func seedIdentifiedEvent(t *testing.T, pool *pgxpool.Pool, f filterFixture, occurredAt time.Time) {
	t.Helper()
	ctx := context.Background()
	var userID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO end_users (project_id,external_user_id,first_seen,last_seen)
		 VALUES ($1,$2,$3,$3) RETURNING id`, f.projectID, uuid.NewString(), occurredAt).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	seedEvent(t, pool, f, f.environmentID, occurredAt, "session-"+uuid.NewString(), &userID)
}

func seedEvent(
	t *testing.T,
	pool *pgxpool.Pool,
	f filterFixture,
	environmentID string,
	occurredAt time.Time,
	sessionID string,
	userID *string,
) string {
	t.Helper()
	ctx := context.Background()
	var eventID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_events
		   (project_id,environment_id,timestamp,error_type,error_message,stack_trace_raw,platform,end_user_id,session_id,created_at)
		 VALUES ($1,$2,$3,'TypeError','filter','at app.js:1:1','javascript',$4,$5,$3) RETURNING id`,
		f.projectID, environmentID, occurredAt, userID, sessionID).Scan(&eventID); err != nil {
		t.Fatalf("seed event: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO error_event_identities
		   (project_id,event_id,status,canonical_issue_id,raw_fingerprint,identity_version,episode_id,settled_at)
		 SELECT $1,$2,'settled',canonical_issue_id,'raw',2,id,$3 FROM issue_episodes WHERE project_id=$1 AND id=$4`,
		f.projectID, eventID, occurredAt, f.episodeID); err != nil {
		t.Fatalf("seed identity: %v", err)
	}
	return eventID
}

func TestFilterAdmitsTwoIdentifiedUsers(t *testing.T) {
	pool := testPool(t)
	f := seedEpisode(t, pool)
	seedIdentifiedEvent(t, pool, f, time.Now().Add(-time.Hour))
	seedIdentifiedEvent(t, pool, f, time.Now())

	decision, err := Evaluate(context.Background(), pool, f.projectID, f.episodeID)
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if decision.Outcome != "open_inquiry" {
		t.Fatalf("outcome = %q, want open_inquiry (reason: %s)", decision.Outcome, decision.Reason)
	}
	if decision.Users7d != 2 || decision.Anon7d != 0 {
		t.Fatalf("reach = users:%d anon:%d, want users:2 anon:0", decision.Users7d, decision.Anon7d)
	}
}

func TestFilterOutcomesAndAffectedUnitCounting(t *testing.T) {
	tests := []struct {
		name      string
		seed      func(*testing.T, *pgxpool.Pool, filterFixture)
		want      string
		wantUsers int
		wantAnon  int
	}{
		{
			name: "identified user plus anonymous session admits",
			seed: func(t *testing.T, pool *pgxpool.Pool, f filterFixture) {
				seedIdentifiedEvent(t, pool, f, time.Now())
				seedEvent(t, pool, f, f.environmentID, time.Now(), "anon-"+uuid.NewString(), nil)
			},
			want: "open_inquiry", wantUsers: 1, wantAnon: 1,
		},
		{
			name: "repeat loop from one user holds",
			seed: func(t *testing.T, pool *pgxpool.Pool, f filterFixture) {
				ctx := context.Background()
				var userID string
				if err := pool.QueryRow(ctx,
					`INSERT INTO end_users (project_id,external_user_id,first_seen,last_seen)
					 VALUES ($1,$2,now(),now()) RETURNING id`, f.projectID, uuid.NewString()).Scan(&userID); err != nil {
					t.Fatalf("seed user: %v", err)
				}
				for range 20 {
					seedEvent(t, pool, f, f.environmentID, time.Now(), "retry-loop", &userID)
				}
			},
			want: "watch", wantUsers: 1, wantAnon: 0,
		},
		{
			name: "session that identifies is not also anonymous",
			seed: func(t *testing.T, pool *pgxpool.Pool, f filterFixture) {
				ctx := context.Background()
				var userID string
				if err := pool.QueryRow(ctx,
					`INSERT INTO end_users (project_id,external_user_id,first_seen,last_seen)
					 VALUES ($1,$2,now(),now()) RETURNING id`, f.projectID, uuid.NewString()).Scan(&userID); err != nil {
					t.Fatalf("seed user: %v", err)
				}
				seedEvent(t, pool, f, f.environmentID, time.Now().Add(-time.Minute), "becomes-known", nil)
				seedEvent(t, pool, f, f.environmentID, time.Now(), "becomes-known", &userID)
			},
			want: "watch", wantUsers: 1, wantAnon: 0,
		},
		{
			name: "quiet work becomes inactive",
			seed: func(t *testing.T, pool *pgxpool.Pool, f filterFixture) {
				for range 3 {
					seedIdentifiedEvent(t, pool, f, time.Now().Add(-8*24*time.Hour))
				}
			},
			want: "inactive", wantUsers: 0, wantAnon: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pool := testPool(t)
			f := seedEpisode(t, pool)
			tt.seed(t, pool, f)
			decision, err := Evaluate(context.Background(), pool, f.projectID, f.episodeID)
			if err != nil {
				t.Fatalf("Evaluate: %v", err)
			}
			if decision.Outcome != tt.want || decision.Users7d != tt.wantUsers || decision.Anon7d != tt.wantAnon {
				t.Fatalf("decision = %#v, want outcome=%s users=%d anon=%d", decision, tt.want, tt.wantUsers, tt.wantAnon)
			}
		})
	}
}

func TestFilterCountsOnlyActionScope(t *testing.T) {
	pool := testPool(t)
	f := seedEpisode(t, pool)
	ctx := context.Background()
	var excludedEnvironmentID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO environments (project_id,name) VALUES ($1,'preview') RETURNING id`,
		f.projectID).Scan(&excludedEnvironmentID); err != nil {
		t.Fatalf("seed excluded environment: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE projects SET action_scope_enabled=true WHERE id=$1`, f.projectID); err != nil {
		t.Fatalf("configure action scope: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO project_action_environments (project_id,environment_id) VALUES ($1,$2)`,
		f.projectID, f.environmentID); err != nil {
		t.Fatalf("allow production environment: %v", err)
	}
	for range 3 {
		seedEvent(t, pool, f, excludedEnvironmentID, time.Now(), "excluded-"+uuid.NewString(), nil)
	}
	seedIdentifiedEvent(t, pool, f, time.Now())

	decision, err := Evaluate(ctx, pool, f.projectID, f.episodeID)
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if decision.Outcome != "watch" || decision.Users7d != 1 || decision.Anon7d != 0 {
		t.Fatalf("decision = %#v, want one in-scope unit on watch", decision)
	}
}

func TestFilterAppendsOnlyWhenDecisionFactsChange(t *testing.T) {
	pool := testPool(t)
	f := seedEpisode(t, pool)
	seedIdentifiedEvent(t, pool, f, time.Now())

	for range 3 {
		if _, err := Evaluate(context.Background(), pool, f.projectID, f.episodeID); err != nil {
			t.Fatalf("Evaluate: %v", err)
		}
	}
	var decisions int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM issue_decisions WHERE project_id=$1 AND episode_id=$2`,
		f.projectID, f.episodeID).Scan(&decisions); err != nil {
		t.Fatalf("count decisions: %v", err)
	}
	if decisions != 1 {
		t.Fatalf("decisions = %d, want 1", decisions)
	}
}
