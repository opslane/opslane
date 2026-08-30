package db_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
)

// freshDB returns a fully migrated disposable database because decisions are immutable.
func freshDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s failed: %v", file, err)
		}
	}
	return pool
}

type decisionFixture struct {
	Outcome, Model, Basis, CauseKind, Diagnosis, CauseLocation, DecidedAt string
}

func insertDecision(t *testing.T, pool *pgxpool.Pool, projectID, groupID, episodeID string, f decisionFixture) {
	t.Helper()
	basis := f.Basis
	if basis == "" {
		basis = "local_defect"
	}
	model := f.Model
	if model == "" {
		model = "claude"
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO diagnosis_decisions
		   (error_group_id,project_id,episode_id,outcome,decision_reason,diagnosis,cause_location,
		    model,prompt_version,basis,cause_kind,confidence,decided_at)
		 VALUES ($1,$2,NULLIF($3,'')::uuid,$4,'seeded',NULLIF($5,'')::jsonb,NULLIF($6,''),
		         $7,'v1',$8,NULLIF($9,''),'high',$10::timestamptz)`,
		groupID, projectID, episodeID, f.Outcome, f.Diagnosis, f.CauseLocation,
		model, basis, f.CauseKind, f.DecidedAt); err != nil {
		t.Fatalf("insert decision: %v", err)
	}
}

func openSecondRound(t *testing.T, pool *pgxpool.Pool, projectID, groupID string) string {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE issue_episodes SET closed_at=now() WHERE project_id=$1 AND canonical_issue_id=$2 AND closed_at IS NULL`, projectID, groupID); err != nil {
		t.Fatalf("close first round: %v", err)
	}
	var id string
	if err := pool.QueryRow(ctx, `INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence) VALUES ($1,$2,2) RETURNING id`, projectID, groupID).Scan(&id); err != nil {
		t.Fatalf("open second round: %v", err)
	}
	return id
}

func seedIssueFixture(t *testing.T, pool *pgxpool.Pool) (orgID, projectID, environmentID, groupID string) {
	t.Helper()
	ctx := context.Background()
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ($1) RETURNING id`, fmt.Sprintf("org-%d", time.Now().UnixNano())).Scan(&orgID); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1,'p') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO environments (project_id, name) VALUES ($1,'production') RETURNING id`, projectID).Scan(&environmentID); err != nil {
		t.Fatalf("seed environment: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, status, kind, platform, environment_id) VALUES ($1,$2,'Nu: Error deleting Assets',now(),now(),'needs_human','error','browser',$3) RETURNING id`, projectID, fmt.Sprintf("fp-seed-%d", time.Now().UnixNano()), environmentID).Scan(&groupID); err != nil {
		t.Fatalf("seed error group: %v", err)
	}
	return orgID, projectID, environmentID, groupID
}

func TestChosenDiagnosisRejectsEachUnusableRowForItsOwnReason(t *testing.T) {
	ctx := context.Background()
	pool := freshDB(t)
	_, projectID, _, groupID := seedIssueFixture(t, pool)
	episodeID, _ := seedEpisodeBackedInvestigation(t, pool, projectID, groupID, "")
	q := db.New(pool)
	insertDecision(t, pool, projectID, groupID, episodeID, decisionFixture{Outcome: "needs_human", Model: "deterministic-fix-verification", Diagnosis: `{"cause_locations":["fix-stage.py"]}`, DecidedAt: "2026-08-28T18:00:00Z"})
	insertDecision(t, pool, projectID, groupID, episodeID, decisionFixture{Outcome: "code_fix", Basis: "invalid_verdict", Diagnosis: `{"cause_locations":["rejected.py"]}`, DecidedAt: "2026-08-28T17:00:00Z"})
	insertDecision(t, pool, projectID, groupID, episodeID, decisionFixture{Outcome: "needs_more_context", Basis: "citation_unresolvable", Diagnosis: `{"cause_locations":["ghost.py"]}`, DecidedAt: "2026-08-28T16:30:00Z"})
	insertDecision(t, pool, projectID, groupID, episodeID, decisionFixture{Outcome: "unable_to_establish_cause", Basis: "insufficient_evidence", Diagnosis: `{"cause_locations":["unknown.py"]}`, DecidedAt: "2026-08-28T16:00:00Z"})
	insertDecision(t, pool, projectID, groupID, episodeID, decisionFixture{Outcome: "code_fix", CauseKind: "local_code", Diagnosis: `{"cause_locations":["server/app/routes/api/resources/asset.py","vue3/client/src/x.ts"],"investigatedCommit":"324cc988"}`, DecidedAt: "2026-08-28T15:00:00Z"})
	got, err := q.ChosenDiagnosis(ctx, projectID, groupID)
	if err != nil {
		t.Fatalf("ChosenDiagnosis: %v", err)
	}
	if got == nil {
		t.Fatal("returned nil")
	}
	if len(got.Paths) != 2 || got.Paths[0] != "server/app/routes/api/resources/asset.py" {
		t.Fatalf("paths = %v", got.Paths)
	}
	if got.CauseKind != "local_code" || got.Commit != "324cc988" || got.FromPastRound {
		t.Fatalf("got = %+v", got)
	}
}

func TestChosenDiagnosisReadsLegacyRowsWithNoStructuredList(t *testing.T) {
	ctx := context.Background()
	pool := freshDB(t)
	_, projectID, _, groupID := seedIssueFixture(t, pool)
	episodeID, _ := seedEpisodeBackedInvestigation(t, pool, projectID, groupID, "")
	insertDecision(t, pool, projectID, groupID, episodeID, decisionFixture{Outcome: "code_fix", CauseKind: "local_code", Diagnosis: `{"one_line_description":"old"}`, CauseLocation: "server/app/routes/api/resources/asset.py, vue3/client/src/x.ts", DecidedAt: "2026-08-28T15:00:00Z"})
	got, err := db.New(pool).ChosenDiagnosis(ctx, projectID, groupID)
	if err != nil || got == nil || len(got.Paths) != 2 || got.Paths[0] != "server/app/routes/api/resources/asset.py" {
		t.Fatalf("got=%v err=%v", got, err)
	}
}

func TestChosenDiagnosisDoesNotReachIntoAnEarlierRound(t *testing.T) {
	ctx := context.Background()
	pool := freshDB(t)
	_, projectID, _, groupID := seedIssueFixture(t, pool)
	firstRound, _ := seedEpisodeBackedInvestigation(t, pool, projectID, groupID, "")
	insertDecision(t, pool, projectID, groupID, firstRound, decisionFixture{Outcome: "code_fix", CauseKind: "local_code", Diagnosis: `{"cause_locations":["old.py"]}`, DecidedAt: "2026-08-01T10:00:00Z"})
	openSecondRound(t, pool, projectID, groupID)
	got, err := db.New(pool).ChosenDiagnosis(ctx, projectID, groupID)
	if err != nil || got != nil {
		t.Fatalf("got=%v err=%v", got, err)
	}
}

func TestChosenDiagnosisFlagsAnIssueThatNeverHadARound(t *testing.T) {
	ctx := context.Background()
	pool := freshDB(t)
	_, projectID, _, groupID := seedIssueFixture(t, pool)
	insertDecision(t, pool, projectID, groupID, "", decisionFixture{Outcome: "code_fix", CauseKind: "local_code", Diagnosis: `{"cause_locations":["legacy.py"]}`, DecidedAt: "2026-06-01T10:00:00Z"})
	got, err := db.New(pool).ChosenDiagnosis(ctx, projectID, groupID)
	if err != nil || got == nil || !got.FromPastRound {
		t.Fatalf("got=%v err=%v", got, err)
	}
}

func TestLatestPipelineResultIncludesFixRowsAndStaysInTheCurrentRound(t *testing.T) {
	ctx := context.Background()
	pool := freshDB(t)
	_, projectID, _, groupID := seedIssueFixture(t, pool)
	firstRound, _ := seedEpisodeBackedInvestigation(t, pool, projectID, groupID, "")
	insertDecision(t, pool, projectID, groupID, firstRound, decisionFixture{Outcome: "code_fix", Diagnosis: `{"cause_locations":["old.py"]}`, DecidedAt: "2026-08-01T10:00:00Z"})
	secondRound := openSecondRound(t, pool, projectID, groupID)
	insertDecision(t, pool, projectID, groupID, secondRound, decisionFixture{Outcome: "code_fix", Diagnosis: `{"cause_locations":["new.py"]}`, DecidedAt: "2026-08-28T15:00:00Z"})
	insertDecision(t, pool, projectID, groupID, secondRound, decisionFixture{Outcome: "needs_human", Model: "deterministic-fix-verification", DecidedAt: "2026-08-28T18:00:00Z"})
	got, err := db.New(pool).LatestPipelineResult(ctx, projectID, groupID)
	if err != nil || got == nil {
		t.Fatalf("got=%v err=%v", got, err)
	}
	if got.DecidedAt.Format("2006-01-02T15:04:05Z") != "2026-08-28T18:00:00Z" {
		t.Fatalf("chose %v", got.DecidedAt)
	}
}
