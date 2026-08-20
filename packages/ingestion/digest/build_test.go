package digest

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Kept in sync with db/testhelper_test.go's constant of the same name.
const defaultTestDSN = "postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	// Mirror db/testhelper_test.go: fall back to the Compose DSN rather than
	// skipping outright, so a bare `go test ./...` actually exercises this
	// package instead of reporting ok having run nothing.
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

type digestFixture struct {
	OrgID, ProjectID, EnvID string
	User1, User2            string
	SessIn1, SessIn2        string
	SessOld                 string
}

func setPipelineState(t *testing.T, pool *pgxpool.Pool, projectID, groupID, state string, decidedAt time.Time) {
	t.Helper()
	ctx := context.Background()
	if state == "absent" {
		if _, err := pool.Exec(ctx,
			`DELETE FROM issue_episodes WHERE project_id=$1 AND canonical_issue_id=$2`,
			projectID, groupID); err != nil {
			t.Fatalf("clear pipeline state: %v", err)
		}
		return
	}
	var episodeID string
	if err := pool.QueryRow(ctx, `
		WITH inserted AS (
		  INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence)
		  SELECT $1,$2,COALESCE(max(sequence),0)+1
		    FROM issue_episodes WHERE project_id=$1 AND canonical_issue_id=$2
		  ON CONFLICT DO NOTHING RETURNING id
		)
		SELECT id::text FROM inserted
		UNION ALL
		SELECT id::text FROM issue_episodes
		 WHERE project_id=$1 AND canonical_issue_id=$2
		ORDER BY 1 LIMIT 1`, projectID, groupID).Scan(&episodeID); err != nil {
		t.Fatalf("ensure episode: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM issue_inquiry_decisions WHERE project_id=$1 AND episode_id=$2`,
		projectID, episodeID); err != nil {
		t.Fatalf("clear inquiry decisions: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM issue_decisions WHERE project_id=$1 AND episode_id=$2`,
		projectID, episodeID); err != nil {
		t.Fatalf("clear factual decisions: %v", err)
	}
	decision := "watch"
	if state == "eligible" || state == "pending" {
		decision = "open_inquiry"
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO issue_decisions
		  (project_id,episode_id,decision,reason,users_7d,anon_7d,rule_version,decided_at)
		VALUES ($1,$2,$3,'test',2,0,1,$4)`, projectID, episodeID, decision, decidedAt); err != nil {
		t.Fatalf("seed factual decision: %v", err)
	}
	if state == "eligible" {
		if _, err := pool.Exec(ctx, `
			INSERT INTO issue_inquiry_decisions
			  (project_id,episode_id,decision,reason,evaluated_units,evidence_signature,
			   model,prompt_version,decided_at)
			VALUES ($1,$2,'investigate','test',2,$3,'test',1,$4)`,
			projectID, episodeID, "sig-"+uuid.NewString(), decidedAt); err != nil {
			t.Fatalf("seed inquiry decision: %v", err)
		}
	}
}

func setAllPipelineStates(t *testing.T, pool *pgxpool.Pool, projectID, state string, decidedAt time.Time) {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT id::text FROM error_groups WHERE project_id=$1`, projectID)
	if err != nil {
		t.Fatalf("list groups for pipeline state: %v", err)
	}
	var groupIDs []string
	for rows.Next() {
		var groupID string
		if err := rows.Scan(&groupID); err != nil {
			rows.Close()
			t.Fatalf("scan group for pipeline state: %v", err)
		}
		groupIDs = append(groupIDs, groupID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("list groups for pipeline state: %v", err)
	}
	rows.Close()
	for _, groupID := range groupIDs {
		setPipelineState(t, pool, projectID, groupID, state, decidedAt)
	}
}

func seedDigestFixture(t *testing.T, pool *pgxpool.Pool, now time.Time) digestFixture {
	return seedDigestFixtureWithSessionAge(t, pool, now, 30*time.Hour)
}

func seedDigestFixtureWithSessionAge(t *testing.T, pool *pgxpool.Pool, now time.Time, oldestSessionAge time.Duration) digestFixture {
	t.Helper()
	ctx := context.Background()
	f := digestFixture{
		User1:   uuid.NewString(),
		User2:   uuid.NewString(),
		SessIn1: "sess-" + uuid.NewString(),
		SessIn2: "sess-" + uuid.NewString(),
		SessOld: "sess-" + uuid.NewString(),
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, sql)
		}
	}
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('digest-test') RETURNING id`).Scan(&f.OrgID); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	orgID := f.OrgID
	t.Cleanup(func() {
		for _, stmt := range []string{
			`DELETE FROM outbound_deliveries WHERE destination_id IN (SELECT id FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1))`,
			`DELETE FROM outbound_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM friction_signals WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM pr_outcomes WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM error_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM error_group_affected_users WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1))`,
			`DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM end_users WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`UPDATE projects SET default_environment_id = NULL WHERE org_id = $1`,
			`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM projects WHERE org_id = $1`,
			`DELETE FROM orgs WHERE id = $1`,
		} {
			if _, err := pool.Exec(context.Background(), stmt, orgID); err != nil {
				t.Errorf("cleanup: %v", err)
			}
		}
	})
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1,'digest-proj') RETURNING id`, orgID).Scan(&f.ProjectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	projectID := f.ProjectID
	if err := pool.QueryRow(ctx, `INSERT INTO environments (project_id, name) VALUES ($1,'production') RETURNING id`, projectID).Scan(&f.EnvID); err != nil {
		t.Fatalf("seed env: %v", err)
	}
	envID := f.EnvID
	exec(`UPDATE projects SET default_environment_id=$2 WHERE id=$1`, projectID, envID)

	exec(`INSERT INTO end_users (id, project_id, external_user_id, account_name) VALUES
		($2::uuid,$1::uuid,'u1-'||($2::uuid)::text,'acme.example'),
		($3::uuid,$1::uuid,'u2-'||($3::uuid)::text,'globex.example')`, projectID, f.User1, f.User2)
	exec(`INSERT INTO sessions (id, project_id, environment_id, end_user_id, started_at) VALUES
		($3,$1,$2,$6,$7),
		($4,$1,$2,$8,$9),
		($5,$1,$2,$6,$10)`,
		projectID, envID, f.SessIn1, f.SessIn2, f.SessOld,
		f.User1, now.Add(-3*time.Hour), f.User2, now.Add(-1*time.Hour), now.Add(-oldestSessionAge))

	var frictionGroupID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status, signal_type,
		 page_url_normalized, first_seen, last_seen, occurrence_count, affected_users_count)
		VALUES ($1,$2,'fp-friction','Rage clicks on /x','friction','insight','rage_click',
		 '/x',$3,$3,999,999) RETURNING id`, projectID, envID, now.Add(-48*time.Hour)).Scan(&frictionGroupID); err != nil {
		t.Fatalf("seed friction group: %v", err)
	}
	exec(`INSERT INTO friction_signals
		(session_id, project_id, environment_id, end_user_id, rule_version, signal_type,
		 fingerprint, page_url_normalized, occurred_at, occurrence_count, incident_id)
		VALUES
		($4,$1,$2,$6,1,'rage_click','fp-friction','/x',$8,3,$3),
		($5,$1,$2,$7,1,'rage_click','fp-friction','/x',$9,2,$3)`,
		projectID, envID, frictionGroupID, f.SessIn1, f.SessIn2, f.User1, f.User2,
		now.Add(-3*time.Hour), now.Add(-1*time.Hour))
	exec(`INSERT INTO friction_signals
		(session_id, project_id, environment_id, end_user_id, rule_version, signal_type,
		 fingerprint, page_url_normalized, occurred_at, occurrence_count, incident_id, retracted_at)
		VALUES ($4,$1,$2,$5,1,'rage_click','fp-friction','/x',$6,50,$3,now())`,
		projectID, envID, frictionGroupID, f.SessOld, f.User1, now.Add(-2*time.Hour))

	var newGroupID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status,
		 first_seen, last_seen, occurrence_count, affected_users_count)
		VALUES ($1,$2,'fp-new','TypeError: boom','error','new',$3,$3,7,2) RETURNING id`,
		projectID, envID, now.Add(-5*time.Hour)).Scan(&newGroupID); err != nil {
		t.Fatalf("seed new group: %v", err)
	}
	exec(`INSERT INTO error_group_affected_users (error_group_id, end_user_id, first_seen, last_seen) VALUES
		($1,$3,$2,$2),
		($1,$4,$2,$2)`, newGroupID, now.Add(-5*time.Hour), f.User1, f.User2)

	var prGroupID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status, first_seen, last_seen,
		 occurrence_count, affected_users_count, pr_created_at, pr_number, pr_url, root_cause)
		VALUES ($1,$2,'fp-pr','NullPointer in checkout','error','pr_created',$3,$3,4,1,$4,42,
		 'https://github.example/pr/42','CheckoutForm dereferences cart.items before load. Second sentence.') RETURNING id`,
		projectID, envID, now.Add(-6*time.Hour), now.Add(-4*time.Hour)).Scan(&prGroupID); err != nil {
		t.Fatalf("seed pr group: %v", err)
	}
	exec(`INSERT INTO pr_outcomes (project_id, error_group_id, pr_number, outcome, github_delivery_id, occurred_at)
		VALUES ($1::uuid,$2::uuid,17,'merged','digest-test-old-pr-'||($2::uuid)::text,$3)`,
		projectID, prGroupID, now.Add(-72*time.Hour))

	exec(`INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status, first_seen, last_seen,
		 occurrence_count, affected_users_count, needs_human_at, reason_code, reason_message, remediation)
		VALUES ($1,$2,'fp-nh','Error: cancelled','error','needs_human',$3,$3,2,1,$4,
		 'external_cause','Cause looks external.','Review manually.')`,
		projectID, envID, now.Add(-50*time.Hour), now.Add(-2*time.Hour))
	exec(`INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status, first_seen, last_seen,
		 occurrence_count, affected_users_count, needs_human_at, reason_code, reason_message, remediation)
		VALUES ($1,$2,'fp-nh-old','Old thing','error','needs_human',$3,$3,1,1,$3,
		 'external_cause','Old.','Review.')`,
		projectID, envID, now.Add(-10*24*time.Hour))

	setAllPipelineStates(t, pool, projectID, "eligible", now.Add(-time.Hour))

	return f
}

func TestBuildDigestSections(t *testing.T) {
	pool := testPool(t)
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	s := New(pool, "https://dash.example")

	payload, err := s.Build(context.Background(), f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := payload.Validate(); err != nil {
		t.Fatalf("invalid envelope: %v", err)
	}
	d := payload.Digest

	if len(d.Insights) != 1 {
		t.Fatalf("insights = %d, want 1", len(d.Insights))
	}
	in := d.Insights[0]
	if in.Occurrences != 5 || in.AffectedUsers != 2 {
		t.Errorf("windowed metrics = %d occ / %d users, want 5/2", in.Occurrences, in.AffectedUsers)
	}
	if in.ReplayURL != nil {
		t.Errorf("replay without proven chunk coverage = %v, want nil", in.ReplayURL)
	}
	if len(in.Accounts) != 2 || in.AccountsMore != 0 {
		t.Errorf("accounts = %v +%d", in.Accounts, in.AccountsMore)
	}

	if len(d.TopNewIssues) != 1 || d.TopNewIssues[0].Title != "TypeError: boom" {
		t.Fatalf("top_new_issues = %+v", d.TopNewIssues)
	}
	if d.TopNewIssues[0].RootCauseExcerpt != nil {
		t.Errorf("uninvestigated group must have nil excerpt")
	}
	if len(d.TopNewIssues[0].Accounts) != 2 {
		t.Errorf("issue accounts = %v", d.TopNewIssues[0].Accounts)
	}

	if len(d.Outcomes.PRsOpened) != 1 || d.Outcomes.PRsOpened[0].PRNumber != 42 {
		t.Fatalf("prs_opened = %+v", d.Outcomes.PRsOpened)
	}
	if d.Outcomes.PRsOpened[0].Merged {
		t.Errorf("PR #42 reported merged from unrelated receipt")
	}
	if got := d.Outcomes.PRsOpened[0].RootCauseExcerpt; got == nil || *got != "CheckoutForm dereferences cart.items before load." {
		t.Errorf("excerpt = %v", got)
	}
	if len(d.Outcomes.NeedsHuman) != 1 || d.Outcomes.NeedsHuman[0].Title != "Error: cancelled" {
		t.Fatalf("needs_human = %+v", d.Outcomes.NeedsHuman)
	}
	if d.NeedsHumanBacklog != 2 {
		t.Errorf("backlog = %d, want 2", d.NeedsHumanBacklog)
	}
	if d.Watching.Sessions != 2 || d.Watching.Users != 2 {
		t.Errorf("watching = %+v", d.Watching)
	}
}

func TestBuildDigestReplayLinksRequireCoverage(t *testing.T) {
	pool := testPool(t)
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	ctx := context.Background()

	seedChunks := func(sessionID string, anchor time.Time, covered bool) {
		t.Helper()
		if !covered {
			if _, err := pool.Exec(ctx, `INSERT INTO session_chunks
				(session_id,seq,project_id,object_key,has_full_snapshot,scrubbed_at,first_event_ms,last_event_ms)
				VALUES ($1,0,$2,$3,true,now(),$4::bigint,$4::bigint+1)`,
				sessionID, f.ProjectID, "digest/"+sessionID+"/0", anchor.UnixMilli()); err != nil {
				t.Fatal(err)
			}
			return
		}
		spans := [][2]int64{
			{anchor.Add(-20 * time.Second).UnixMilli(), anchor.Add(-8 * time.Second).UnixMilli()},
			{anchor.Add(-8 * time.Second).UnixMilli(), anchor.Add(2 * time.Second).UnixMilli()},
			{anchor.Add(2 * time.Second).UnixMilli(), anchor.Add(16 * time.Second).UnixMilli()},
		}
		for i, span := range spans {
			if _, err := pool.Exec(ctx, `INSERT INTO session_chunks
				(session_id,seq,project_id,object_key,has_full_snapshot,scrubbed_at,first_event_ms,last_event_ms)
				VALUES ($1,$2,$3,$4,$5,now(),$6,$7)`,
				sessionID, i, f.ProjectID, fmt.Sprintf("digest/%s/%d", sessionID, i), i == 0, span[0], span[1]); err != nil {
				t.Fatal(err)
			}
		}
	}

	insightCoveredAt := now.Add(-3 * time.Hour)
	seedChunks(f.SessIn1, insightCoveredAt, true)
	seedChunks(f.SessIn2, now.Add(-time.Hour), false)
	if _, err := pool.Exec(ctx, `UPDATE friction_signals SET adjudication_status='accepted'
		WHERE project_id=$1 AND retracted_at IS NULL`, f.ProjectID); err != nil {
		t.Fatal(err)
	}

	issueAt := now.Add(-5 * time.Hour)
	seedChunks(f.SessOld, issueAt, true)
	var issueID string
	if err := pool.QueryRow(ctx, `SELECT id FROM error_groups WHERE project_id=$1 AND fingerprint='fp-new'`, f.ProjectID).Scan(&issueID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO error_events
		(project_id,environment_id,error_group_id,session_id,"timestamp",error_type,error_message,stack_trace_raw)
		VALUES ($1,$2,$3,$4,$5,'TypeError','boom','at digest')`,
		f.ProjectID, f.EnvID, issueID, f.SessOld, issueAt); err != nil {
		t.Fatal(err)
	}

	payload, err := New(pool, "https://dash.example").Build(ctx, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if got := payload.Digest.Insights[0].ReplayURL; got == nil || *got != "https://dash.example/sessions/"+f.SessIn1+"?t="+fmt.Sprint(insightCoveredAt.UnixMilli()) {
		t.Fatalf("covered friction fallback replay = %v", got)
	}
	if got := payload.Digest.TopNewIssues[0].ReplayURL; got == nil || *got != "https://dash.example/sessions/"+f.SessOld+"?t="+fmt.Sprint(issueAt.UnixMilli()) {
		t.Fatalf("covered error replay = %v", got)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM session_chunks WHERE session_id=$1`, f.SessOld); err != nil {
		t.Fatal(err)
	}
	payload, err = New(pool, "https://dash.example").Build(ctx, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if got := payload.Digest.TopNewIssues[0].ReplayURL; got != nil {
		t.Fatalf("issue replay without coverage = %v, want nil", got)
	}
}

func TestBuildDigestSectionsRequirePipelineEligibility(t *testing.T) {
	for _, status := range []string{"absent", "ineligible", "pending"} {
		t.Run(status, func(t *testing.T) {
			pool := testPool(t)
			now := time.Now().UTC().Truncate(time.Second)
			f := seedDigestFixture(t, pool, now)
			ctx := context.Background()

			var mergedID string
			if err := pool.QueryRow(ctx, `INSERT INTO error_groups
				(project_id, environment_id, fingerprint, title, kind, status, first_seen, last_seen,
				 occurrence_count, affected_users_count, pr_created_at, pr_number, pr_url)
				VALUES ($1,$2,$3,'Merged today','error','merged',$4,$4,1,1,$5,88,'https://github.example/pr/88') RETURNING id`,
				f.ProjectID, f.EnvID, "fp-merged-gate-"+uuid.NewString(), now.Add(-72*time.Hour), now.Add(-48*time.Hour)).Scan(&mergedID); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO pr_outcomes
				(project_id,error_group_id,pr_number,outcome,github_delivery_id,occurred_at)
				VALUES ($1,$2,88,'merged',$3,$4)`, f.ProjectID, mergedID, "gate-"+uuid.NewString(), now.Add(-time.Hour)); err != nil {
				t.Fatal(err)
			}
			setAllPipelineStates(t, pool, f.ProjectID, status, now.Add(-time.Hour))

			payload, err := New(pool, "https://dash.example").Build(ctx, f.ProjectID, now)
			if err != nil {
				t.Fatal(err)
			}
			d := payload.Digest
			if len(d.Insights) != 0 || len(d.TopNewIssues) != 0 || len(d.Outcomes.PRsOpened) != 0 || len(d.Outcomes.NeedsHuman) != 0 {
				t.Fatalf("%s readiness leaked into digest: %+v", status, d)
			}
			if len(d.Outcomes.PRsMerged) != 0 {
				t.Fatalf("%s merged group leaked into digest: %+v", status, d.Outcomes.PRsMerged)
			}
		})
	}
}

func TestBuildDigestQuietDay(t *testing.T) {
	pool := testPool(t)
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `DELETE FROM friction_signals WHERE project_id=$1`, f.ProjectID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM error_group_affected_users WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id=$1)`, f.ProjectID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM pr_outcomes WHERE project_id=$1`, f.ProjectID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM error_groups WHERE project_id=$1`, f.ProjectID); err != nil {
		t.Fatal(err)
	}

	payload, err := New(pool, "https://dash.example").Build(ctx, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	d := payload.Digest
	if len(d.Insights) != 0 || len(d.TopNewIssues) != 0 || len(d.Outcomes.PRsOpened) != 0 || len(d.Outcomes.PRsMerged) != 0 || len(d.Outcomes.NeedsHuman) != 0 {
		t.Fatalf("quiet digest has list items: %+v", d)
	}
	if d.Watching.Sessions != 2 || d.Watching.Users != 2 || d.NeedsHumanBacklog != 0 {
		t.Fatalf("quiet digest watching/backlog = %+v / %d", d.Watching, d.NeedsHumanBacklog)
	}
}

func TestBuildDigestCapsTopNewIssues(t *testing.T) {
	pool := testPool(t)
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	for i := 0; i < 3; i++ {
		if _, err := pool.Exec(context.Background(), `INSERT INTO error_groups
			(project_id, environment_id, fingerprint, title, kind, status, first_seen, last_seen,
			 occurrence_count, affected_users_count)
			VALUES ($1,$2,$3,$4,'error','new',$5,$5,1,1)`,
			f.ProjectID, f.EnvID, "fp-cap-"+uuid.NewString(), "cap issue", now.Add(-time.Duration(i+1)*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	setAllPipelineStates(t, pool, f.ProjectID, "eligible", now.Add(-time.Hour))
	payload, err := New(pool, "https://dash.example").Build(context.Background(), f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(payload.Digest.TopNewIssues) != 3 || !payload.Digest.TopNewIssuesHasMore {
		t.Fatalf("top new issues = %d has_more=%v", len(payload.Digest.TopNewIssues), payload.Digest.TopNewIssuesHasMore)
	}
}

func TestBuildDigestExcludesSupersededSignals(t *testing.T) {
	pool := testPool(t)
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		WITH source AS (
			SELECT id FROM friction_signals WHERE session_id=$1 AND retracted_at IS NULL
		), replacement AS (
			SELECT id FROM friction_signals WHERE session_id=$2 AND retracted_at IS NULL
		)
		UPDATE friction_signals SET superseded_by=(SELECT id FROM replacement)
		WHERE id=(SELECT id FROM source)`, f.SessIn1, f.SessIn2); err != nil {
		t.Fatal(err)
	}
	payload, err := New(pool, "https://dash.example").Build(ctx, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	got := payload.Digest.Insights[0]
	if got.Occurrences != 2 || got.AffectedUsers != 1 {
		t.Fatalf("superseded signal counted: %+v", got)
	}
}

func TestBuildDigestInsightAccountsOverflowAndAnonymous(t *testing.T) {
	pool := testPool(t)
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	ctx := context.Background()
	var groupID string
	if err := pool.QueryRow(ctx, `SELECT id FROM error_groups WHERE project_id=$1 AND kind='friction'`, f.ProjectID).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	for _, account := range []string{"initech.example", "umbrella.example"} {
		userID := uuid.NewString()
		sessionID := "sess-" + uuid.NewString()
		if _, err := pool.Exec(ctx, `INSERT INTO end_users
			(id,project_id,external_user_id,account_name) VALUES ($1,$2,$3,$4)`,
			userID, f.ProjectID, "user-"+userID, account); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO sessions
			(id,project_id,environment_id,end_user_id,started_at) VALUES ($1,$2,$3,$4,$5)`,
			sessionID, f.ProjectID, f.EnvID, userID, now.Add(-30*time.Minute)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO friction_signals
			(session_id,project_id,environment_id,end_user_id,rule_version,signal_type,fingerprint,
			 page_url_normalized,occurred_at,occurrence_count,incident_id)
			VALUES ($1,$2,$3,$4,1,'rage_click','fp-friction','/x',$5,1,$6)`,
			sessionID, f.ProjectID, f.EnvID, userID, now.Add(-30*time.Minute), groupID); err != nil {
			t.Fatal(err)
		}
	}
	anonSession := "sess-" + uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO sessions
		(id,project_id,environment_id,started_at) VALUES ($1,$2,$3,$4)`,
		anonSession, f.ProjectID, f.EnvID, now.Add(-15*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO friction_signals
		(session_id,project_id,environment_id,rule_version,signal_type,fingerprint,
		 page_url_normalized,occurred_at,occurrence_count,incident_id)
		VALUES ($1,$2,$3,1,'rage_click','fp-friction','/x',$4,1,$5)`,
		anonSession, f.ProjectID, f.EnvID, now.Add(-15*time.Minute), groupID); err != nil {
		t.Fatal(err)
	}

	payload, err := New(pool, "https://dash.example").Build(ctx, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	insight := payload.Digest.Insights[0]
	if len(insight.Accounts) != 3 || insight.AccountsMore != 1 {
		t.Fatalf("accounts = %v +%d", insight.Accounts, insight.AccountsMore)
	}
	for _, account := range insight.Accounts {
		if account == "" {
			t.Fatal("anonymous traffic produced an account name")
		}
	}
}

func TestBuildDigestMergedReceiptsAreEventTimeTruth(t *testing.T) {
	pool := testPool(t)
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	ctx := context.Background()
	var mergedGroupID, staleGroupID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status, first_seen, last_seen,
		 occurrence_count, affected_users_count, pr_created_at, pr_number, pr_url, merged_at)
		VALUES ($1,$2,$3,'merged by receipt','error','merged',$4,$4,1,1,$4,77,'https://github.example/pr/77',$5)
		RETURNING id`, f.ProjectID, f.EnvID, "fp-merged-"+uuid.NewString(), now.Add(-72*time.Hour), now.Add(-time.Hour)).Scan(&mergedGroupID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO pr_outcomes
		(project_id,error_group_id,pr_number,outcome,github_delivery_id,occurred_at)
		VALUES ($1,$2,77,'merged',$3,$4)`, f.ProjectID, mergedGroupID, "delivery-"+uuid.NewString(), now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	setPipelineState(t, pool, f.ProjectID, mergedGroupID, "eligible", now.Add(-time.Hour))
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status, first_seen, last_seen,
		 occurrence_count, affected_users_count, pr_created_at, pr_number, pr_url, merged_at)
		VALUES ($1,$2,$3,'stale mutable stamp','error','merged',$4,$4,1,1,$4,78,'https://github.example/pr/78',$5)
		RETURNING id`, f.ProjectID, f.EnvID, "fp-stale-"+uuid.NewString(), now.Add(-72*time.Hour), now.Add(-time.Hour)).Scan(&staleGroupID); err != nil {
		t.Fatal(err)
	}
	payload, err := New(pool, "https://dash.example").Build(ctx, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(payload.Digest.Outcomes.PRsMerged) != 1 || payload.Digest.Outcomes.PRsMerged[0].PRNumber != 77 {
		t.Fatalf("merged receipts = %+v", payload.Digest.Outcomes.PRsMerged)
	}
	for _, item := range payload.Digest.Outcomes.PRsOpened {
		if item.PRNumber == 77 {
			t.Fatalf("old opened PR overlapped opened outcomes: %+v", item)
		}
	}
	_ = staleGroupID
}

func TestBuildDigestUsesProjectLocalDate(t *testing.T) {
	pool := testPool(t)
	now := time.Date(2026, 8, 7, 13, 30, 0, 123456789, time.UTC)
	f := seedDigestFixture(t, pool, now)
	if _, err := pool.Exec(context.Background(), `UPDATE projects SET digest_timezone='Pacific/Auckland' WHERE id=$1`, f.ProjectID); err != nil {
		t.Fatal(err)
	}
	payload, err := New(pool, "https://dash.example").Build(context.Background(), f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if payload.Digest.Date != "2026-08-08" {
		t.Fatalf("local date = %q", payload.Digest.Date)
	}
	windowTo, err := time.Parse(time.RFC3339Nano, payload.Digest.Window.To)
	if err != nil || !windowTo.Equal(now) {
		t.Fatalf("window to = %q (%v), want exact %s", payload.Digest.Window.To, err, now)
	}
}

func TestBuildReceiptItemsExcludesStaleProblems(t *testing.T) {
	pool := testPool(t)
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	ctx := context.Background()

	seedEligibleGroup := func(lastSeen time.Time) string {
		t.Helper()
		var groupID string
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
			 occurrence_count,affected_users_count,pr_created_at,pr_url)
			VALUES ($1,$2,$3,'Receipt liveness','error','pr_created',$4,$4,1,1,$5,$6)
			RETURNING id`, f.ProjectID, f.EnvID, "liveness-"+uuid.NewString(), lastSeen,
			now.Add(-time.Hour), "https://github.example/pr/1").Scan(&groupID); err != nil {
			t.Fatal(err)
		}
		setPipelineState(t, pool, f.ProjectID, groupID, "eligible", now.Add(-time.Hour))
		return groupID
	}

	// Seeded either side of the boundary itself, not merely far from it: 10d
	// vs 2h passes for any cutoff between them, so it would not notice the
	// interval being retuned to 3 or 9 days.
	staleID := seedEligibleGroup(now.Add(-receiptLivenessWindow - time.Hour))
	freshID := seedEligibleGroup(now.Add(-receiptLivenessWindow + time.Hour))
	longGoneID := seedEligibleGroup(now.Add(-30 * 24 * time.Hour))
	payload, err := New(pool, "https://dash.example").Build(ctx, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	ids := make(map[string]bool, len(payload.Digest.ReceiptItems))
	for _, item := range payload.Digest.ReceiptItems {
		ids[item.IncidentID] = true
	}
	if ids[staleID] {
		t.Error("problem seen just outside the liveness window must not appear")
	}
	if !ids[freshID] {
		t.Error("problem seen just inside the liveness window must appear")
	}
	if ids[longGoneID] {
		t.Error("problem seen 30 days ago must not appear")
	}
}

func TestBuildReceiptItemsPriorityWindowCapAndGate(t *testing.T) {
	pool := testPool(t)
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	ctx := context.Background()
	for _, stmt := range []string{
		`DELETE FROM friction_signals WHERE project_id=$1`,
		`DELETE FROM pr_outcomes WHERE project_id=$1`,
		`DELETE FROM error_events WHERE project_id=$1`,
		`DELETE FROM error_group_affected_users WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id=$1)`,
		`DELETE FROM error_groups WHERE project_id=$1`,
	} {
		if _, err := pool.Exec(ctx, stmt, f.ProjectID); err != nil {
			t.Fatal(err)
		}
	}

	var highestID string
	for i := 0; i < 14; i++ {
		var groupID string
		title := fmt.Sprintf("Rank %02d", i)
		if i == 13 {
			title = "Top `receipt` at https://customer.example/pay\nsk_live_secret"
		}
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
			 occurrence_count,affected_users_count,pr_created_at,pr_url,priority_score)
			VALUES ($1,$2,$3,$4,'error','pr_draft',$5,$5,$6,1,$5,$7,$8) RETURNING id`,
			f.ProjectID, f.EnvID, "receipt-"+uuid.NewString(), title,
			now.Add(-time.Hour), i+1, fmt.Sprintf("https://github.example/pr/%d", i), i,
		).Scan(&groupID); err != nil {
			t.Fatal(err)
		}
		if i == 13 {
			highestID = groupID
		}
		setPipelineState(t, pool, f.ProjectID, groupID, "eligible", now.Add(-30*time.Minute))
	}
	var heldGroupID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
		 occurrence_count,affected_users_count,needs_human_at,reason_code,reason_message,remediation)
		VALUES ($1,$2,$3,'Held receipt','error','needs_human',$4,$4,1,1,$4,
		 'no_usable_diagnosis','No usable diagnosis.','Review manually.') RETURNING id`,
		f.ProjectID, f.EnvID, "held-"+uuid.NewString(), now.Add(-20*time.Minute)).Scan(&heldGroupID); err != nil {
		t.Fatal(err)
	}
	setPipelineState(t, pool, f.ProjectID, heldGroupID, "ineligible", now.Add(-20*time.Minute))

	payload, err := New(pool, "https://dash.example").Build(ctx, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	d := payload.Digest
	if d.SchemaVersion != 2 || len(d.ReceiptItems) != receiptCap || d.ReceiptOverflow != 4 {
		t.Fatalf("receipt cap/version/overflow = v%d %d +%d", d.SchemaVersion, len(d.ReceiptItems), d.ReceiptOverflow)
	}
	if d.ReceiptItems[0].IncidentID != highestID {
		t.Fatalf("priority ordering starts with %s, want %s", d.ReceiptItems[0].IncidentID, highestID)
	}
	if got := d.ReceiptItems[0].Title; strings.Contains(got, "https://") || strings.ContainsAny(got, "`\n") || strings.Contains(got, "sk_live") {
		t.Fatalf("title was not sanitized before payload storage: %q", got)
	}
	if d.TriageCounts == nil || d.TriageCounts.PRsAwaitingReview != 14 || d.TriageCounts.NeedsDecision != 1 {
		t.Fatalf("triage = %+v", d.TriageCounts)
	}
	if d.HeldBackCount != 1 {
		t.Fatalf("held_back_count = %d, want 1", d.HeldBackCount)
	}

	later, err := New(pool, "https://dash.example").Build(ctx, f.ProjectID, now.Add(25*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(later.Digest.ReceiptItems) != 0 || later.Digest.ReceiptOverflow != 0 || later.Digest.TriageCounts == nil {
		t.Fatalf("expired receipt window = %+v", later.Digest)
	}
}

func TestBuildReceiptItemsStatesAndValidatedProse(t *testing.T) {
	pool := testPool(t)
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	ctx := context.Background()
	for _, stmt := range []string{
		`DELETE FROM friction_signals WHERE project_id=$1`,
		`DELETE FROM pr_outcomes WHERE project_id=$1`,
		`DELETE FROM error_events WHERE project_id=$1`,
		`DELETE FROM error_group_affected_users WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id=$1)`,
		`DELETE FROM error_groups WHERE project_id=$1`,
	} {
		if _, err := pool.Exec(ctx, stmt, f.ProjectID); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		// The 033 FK blocks deleting this fixture's groups/project while decision
		// rows reference them, and 034 makes decisions insert-only, so cleanup
		// follows cleanupTenant's documented wedge — but in ONE transaction, so a
		// killed test run can never leave the immutability trigger disabled on the
		// retained database (ALTER TABLE is transactional; abort re-enables it).
		cleanupCtx := context.Background()
		tx, err := pool.Begin(cleanupCtx)
		if err != nil {
			t.Errorf("cleanup begin: %v", err)
			return
		}
		defer tx.Rollback(cleanupCtx)
		for _, step := range []struct {
			sql  string
			args []any
		}{
			{sql: `ALTER TABLE diagnosis_decisions DISABLE TRIGGER diagnosis_decisions_immutable_row`},
			{sql: `DELETE FROM diagnosis_decisions WHERE project_id=$1`, args: []any{f.ProjectID}},
			{sql: `ALTER TABLE diagnosis_decisions ENABLE TRIGGER diagnosis_decisions_immutable_row`},
		} {
			if _, err := tx.Exec(cleanupCtx, step.sql, step.args...); err != nil {
				t.Errorf("cleanup diagnosis decisions: %v", err)
				return
			}
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Errorf("cleanup commit: %v", err)
		}
	})

	type receiptSeed struct {
		status, wantState  string
		withDiff, decision bool
		prURL              string
	}
	seeds := []receiptSeed{
		{status: "pr_draft", wantState: "pr_draft", prURL: "https://github.example/pr/1"},
		{status: "awaiting_approval", wantState: "awaiting_approval", decision: true},
		{status: "needs_human", wantState: "attempt_failed_with_diff", withDiff: true, decision: true},
		{status: "needs_human", wantState: "attempt_failed_no_diff", decision: true},
		{status: "investigated", wantState: "report_ready", decision: true},
	}
	wants := map[string]string{}
	for i, seed := range seeds {
		var groupID string
		candidateDiff := ""
		if seed.withDiff {
			candidateDiff = "diff --git a/a.ts b/a.ts"
		}
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
			 occurrence_count,affected_users_count,pr_url,candidate_diff,root_cause,suggested_mitigation,
			 reason_code,reason_message,remediation,needs_human_at,pr_created_at)
			VALUES ($1,$2,$3,$4,'error',$5,$6::timestamptz,$6::timestamptz,$7,1,NULLIF($8,''),NULLIF($9,''),
			 'Cause at https://customer.example/pay\nwith *detail*.', 'Guard the value.',
			 CASE WHEN $5::error_group_status='needs_human' THEN 'fix_failed' END,
			 CASE WHEN $5::error_group_status='needs_human' THEN 'Fix failed.' END,
			 CASE WHEN $5::error_group_status='needs_human' THEN 'Review the report.' END,
			 CASE WHEN $5::error_group_status='needs_human' THEN $6::timestamptz END,
			 CASE WHEN $5::error_group_status IN ('pr_created','pr_draft') THEN $6::timestamptz END)
			RETURNING id`, f.ProjectID, f.EnvID, "state-"+uuid.NewString(),
			fmt.Sprintf("State %d", i), seed.status, now.Add(-time.Hour), i+1, seed.prURL, candidateDiff,
		).Scan(&groupID); err != nil {
			t.Fatal(err)
		}
		wants[groupID] = seed.wantState
		if seed.decision {
			if _, err := pool.Exec(ctx, `INSERT INTO diagnosis_decisions
				(error_group_id,project_id,outcome,decision_reason,diagnosis,model,prompt_version,basis,confidence,decided_at)
				VALUES ($1,$2,'not_actionable','test',$3::jsonb,'test','test','external','high',$4)`,
				groupID, f.ProjectID, `{"evidence":[{"path":"a.ts","detail":"d","symptomLink":"s"}]}`,
				now.Add(-30*time.Minute)); err != nil {
				t.Fatal(err)
			}
		}
		setPipelineState(t, pool, f.ProjectID, groupID, "eligible", now.Add(-30*time.Minute))
	}
	for i := 0; i < 2; i++ {
		var heldGroupID string
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
			 occurrence_count,affected_users_count,needs_human_at,reason_code,reason_message,remediation)
			VALUES ($1,$2,$3,'Held','error','needs_human',$4,$4,1,1,$4,
			 'no_usable_diagnosis','No diagnosis.','Review manually.') RETURNING id`,
			f.ProjectID, f.EnvID, "held-state-"+uuid.NewString(), now.Add(-time.Hour)).Scan(&heldGroupID); err != nil {
			t.Fatal(err)
		}
		setPipelineState(t, pool, f.ProjectID, heldGroupID, "ineligible", now.Add(-time.Hour))
	}

	payload, err := New(pool, "https://dash.example").Build(ctx, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(payload.Digest.ReceiptItems) != 5 || payload.Digest.HeldBackCount != 2 {
		t.Fatalf("items/held = %d/%d", len(payload.Digest.ReceiptItems), payload.Digest.HeldBackCount)
	}
	for _, item := range payload.Digest.ReceiptItems {
		if item.ReceiptState != wants[item.IncidentID] {
			t.Errorf("%s state = %s, want %s", item.IncidentID, item.ReceiptState, wants[item.IncidentID])
		}
		if (item.ReceiptState == "pr_open" || item.ReceiptState == "pr_draft") && item.RootCauseExcerpt != "" {
			t.Errorf("unvalidated PR prose rendered: %q", item.RootCauseExcerpt)
		}
		if item.ReceiptState != "pr_open" && item.ReceiptState != "pr_draft" && (item.RootCauseExcerpt == "" || strings.Contains(item.RootCauseExcerpt, "https://") || strings.ContainsAny(item.RootCauseExcerpt, "*`")) {
			t.Errorf("validated prose missing or dirty: %q", item.RootCauseExcerpt)
		}
	}
}

func TestReceiptStateSurfacesApproval(t *testing.T) {
	cases := map[string]string{
		"awaiting_approval": "awaiting_approval",
		"pr_draft":          "pr_draft",
		"pr_created":        "pr_open",
		"investigated":      "report_ready",
	}
	for groupStatus, want := range cases {
		if got := receiptState(groupStatus, false); got != want {
			t.Errorf("receiptState(%q) = %q, want %q", groupStatus, got, want)
		}
	}
}

func TestDigestExcerptAndSessionURLHelpers(t *testing.T) {
	s := New(nil, "https://dash.example/")
	if got := s.sessionURLAt("a/b", 123); got == nil || *got != "https://dash.example/sessions/a%2Fb?t=123" {
		t.Fatalf("anchored session URL = %v", got)
	}
	if got := s.sessionURLAt("", 5); got != nil {
		t.Fatalf("empty anchored session URL = %v, want nil", got)
	}
	if rootCauseExcerpt(nil) != nil {
		t.Fatal("nil root cause returned an excerpt")
	}
	empty := "  "
	if rootCauseExcerpt(&empty) != nil {
		t.Fatal("empty root cause returned an excerpt")
	}
	prose := "First sentence. Second sentence."
	if got := rootCauseExcerpt(&prose); got == nil || *got != "First sentence." {
		t.Fatalf("first sentence = %v", got)
	}
	long := strings.Repeat("界", 230)
	got := rootCauseExcerpt(&long)
	if got == nil || len([]rune(*got)) != 220 || !strings.HasSuffix(*got, "…") {
		t.Fatalf("bounded excerpt has %d runes: %v", len([]rune(*got)), got)
	}
}

// The fix phase appends a delivery-outcome row (model
// 'deterministic-fix-verification', diagnosis NULL) after the investigation's
// diagnosis row, and insight and parked results now persist their terminal
// outcome as 'needs_human' with the diagnosis attached. Neither may cost a
// group its validated diagnosis: the reader keys on the newest
// diagnosis-bearing decision, not the newest row of any kind.
func TestBuildDigestValidatedDiagnosisSurvivesFixTerminalRows(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)

	validDiagnosis := `{"evidence":[{"path":"a.ts","detail":"d","symptomLink":"s"}],"agentTaskBrief":"guard the null selection before rebuild"}`
	t.Cleanup(func() {
		// 034 makes decision rows insert-only and 033 blocks deleting their
		// groups, so this test's rows follow the documented wedge in one
		// transaction before the fixture cleanup (LIFO) reaches projects.
		cleanupCtx := context.Background()
		tx, err := pool.Begin(cleanupCtx)
		if err != nil {
			t.Errorf("cleanup begin: %v", err)
			return
		}
		defer tx.Rollback(cleanupCtx)
		for _, step := range []string{
			`ALTER TABLE diagnosis_decisions DISABLE TRIGGER diagnosis_decisions_immutable_row`,
			`DELETE FROM diagnosis_decisions WHERE project_id='` + f.ProjectID + `'`,
			`ALTER TABLE diagnosis_decisions ENABLE TRIGGER diagnosis_decisions_immutable_row`,
		} {
			if _, err := tx.Exec(cleanupCtx, step); err != nil {
				t.Errorf("cleanup diagnosis decisions: %v", err)
				return
			}
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Errorf("cleanup commit: %v", err)
		}
	})
	seedGroup := func(title string) string {
		t.Helper()
		var groupID string
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
			 occurrence_count,affected_users_count,needs_human_at,reason_code,reason_message,remediation)
			VALUES ($1,$2,$3,$4,'error','needs_human',$5,$5,1,1,$5,
			 'low_confidence_fix','Fix below floor.','Review the diff.') RETURNING id`,
			f.ProjectID, f.EnvID, "fixterm-"+uuid.NewString(), title, now.Add(-time.Hour),
		).Scan(&groupID); err != nil {
			t.Fatal(err)
		}
		setPipelineState(t, pool, f.ProjectID, groupID, "eligible", now.Add(-30*time.Minute))
		return groupID
	}
	seedDecision := func(groupID, outcome, model, diagnosis string, at time.Time) {
		t.Helper()
		var diagArg any
		if diagnosis != "" {
			diagArg = diagnosis
		}
		if _, err := pool.Exec(ctx, `INSERT INTO diagnosis_decisions
			(error_group_id,project_id,outcome,decision_reason,diagnosis,model,prompt_version,basis,confidence,decided_at)
			VALUES ($1,$2,$3,'test',$4::jsonb,$5,'test','local_defect','high',$6)`,
			groupID, f.ProjectID, outcome, diagArg, model, at); err != nil {
			t.Fatal(err)
		}
	}

	// A newer fix-verification appendix row must not shadow the diagnosis.
	shadowed := seedGroup("Shadowed by fix terminal")
	seedDecision(shadowed, "code_fix", "claude-test", validDiagnosis, now.Add(-40*time.Minute))
	seedDecision(shadowed, "needs_human", "deterministic-fix-verification", "", now.Add(-20*time.Minute))

	// An insight/parked row persists outcome needs_human WITH its diagnosis.
	parked := seedGroup("Parked with diagnosis")
	seedDecision(parked, "needs_human", "claude-test", validDiagnosis, now.Add(-30*time.Minute))

	// A diagnosis-less needs_human row alone stays unpublishable.
	bare := seedGroup("Preflight only")
	seedDecision(bare, "needs_human", "deterministic-preflight", "", now.Add(-30*time.Minute))

	payload, err := New(pool, "https://dash.example").Build(ctx, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	included := map[string]bool{}
	for _, item := range payload.Digest.ReceiptItems {
		included[item.Title] = true
	}
	if !included["Shadowed by fix terminal"] {
		t.Fatalf("fix-terminal appendix row shadowed a validated diagnosis; items=%v", included)
	}
	if !included["Parked with diagnosis"] {
		t.Fatalf("needs_human decision with a valid diagnosis did not validate; items=%v", included)
	}
	if included["Preflight only"] {
		t.Fatalf("diagnosis-less needs_human decision published; items=%v", included)
	}
}
