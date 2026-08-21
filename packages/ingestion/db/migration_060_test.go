package db_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// TestMigration060AdoptsThePreRewriteWorld applies every migration except the
// cutover backfill, seeds the pre-rewrite shape, then applies the backfill and
// checks what the pipeline needs afterwards.
func TestMigration060AdoptsThePreRewriteWorld(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	ctx := context.Background()

	var backfill string
	for _, file := range migrationFiles(t) {
		if strings.HasPrefix(filepath.Base(file), "060_") {
			backfill = file
			continue
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
	if backfill == "" {
		t.Fatal("060 cutover backfill migration not found")
	}

	// Pre-rewrite state: three issues and their observations, no identities.
	if _, err := pool.Exec(ctx, `
		INSERT INTO orgs (id, name) VALUES ('11111111-1111-1111-1111-111111111111', 'cutover');
		INSERT INTO projects (id, org_id, name, github_repo)
		  VALUES ('22222222-2222-2222-2222-222222222222',
		          '11111111-1111-1111-1111-111111111111', 'app', 'owner/repo');
		INSERT INTO environments (id, project_id, name)
		  VALUES ('33333333-3333-3333-3333-333333333333',
		          '22222222-2222-2222-2222-222222222222', 'production');

		INSERT INTO error_groups
		  (id, project_id, fingerprint, title, kind, status, first_seen, last_seen, resolved_at)
		VALUES
		  ('aaaaaaaa-0000-0000-0000-000000000001',
		   '22222222-2222-2222-2222-222222222222', 'fp-active', 'Active issue',
		   'error', 'new', now() - interval '20 days', now(), NULL),
		  ('aaaaaaaa-0000-0000-0000-000000000002',
		   '22222222-2222-2222-2222-222222222222', 'fp-resolved', 'Resolved issue',
		   'error', 'resolved', now() - interval '40 days', now() - interval '30 days',
		   now() - interval '29 days'),
		  ('aaaaaaaa-0000-0000-0000-000000000003',
		   '22222222-2222-2222-2222-222222222222', 'fp-friction', 'Dead click',
		   'friction', 'new', now() - interval '10 days', now(), NULL);

		INSERT INTO error_events
		  (id, project_id, environment_id, error_group_id, timestamp,
		   error_type, error_message, stack_trace_raw, created_at)
		VALUES
		  ('bbbbbbbb-0000-0000-0000-000000000001',
		   '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333',
		   'aaaaaaaa-0000-0000-0000-000000000001', now(), 'TypeError', 'boom', 'at x',
		   now() - interval '2 days'),
		  ('bbbbbbbb-0000-0000-0000-000000000002',
		   '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333',
		   'aaaaaaaa-0000-0000-0000-000000000001', now(), 'TypeError', 'boom', 'at x',
		   now() - interval '1 day'),
		  ('bbbbbbbb-0000-0000-0000-000000000003',
		   '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333',
		   'aaaaaaaa-0000-0000-0000-000000000002', now(), 'TypeError', 'old', 'at y',
		   now() - interval '35 days');
	`); err != nil {
		t.Fatalf("seed pre-cutover world: %v", err)
	}

	if err := applyMigration(t, psql, dsn, backfill); err != nil {
		t.Fatalf("apply backfill: %v", err)
	}

	// Every issue gets exactly one episode, and only unresolved issues get an
	// open one. A resolved issue with an open round would look live on day one.
	var episodes, openEpisodes int
	if err := pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE closed_at IS NULL)
		  FROM issue_episodes`).Scan(&episodes, &openEpisodes); err != nil {
		t.Fatal(err)
	}
	if episodes != 3 {
		t.Errorf("episodes = %d, want 3 (one per adopted issue)", episodes)
	}
	if openEpisodes != 2 {
		t.Errorf("open episodes = %d, want 2 (the resolved issue's round is closed)", openEpisodes)
	}

	// Each issue's own fingerprint becomes its alias, typed by the issue's kind.
	var aliasKind string
	if err := pool.QueryRow(ctx, `
		SELECT fingerprint_kind FROM canonical_issue_fingerprints
		 WHERE fingerprint = 'fp-friction'`).Scan(&aliasKind); err != nil {
		t.Fatal(err)
	}
	if aliasKind != "friction" {
		t.Errorf("friction alias kind = %q, want friction", aliasKind)
	}
	var aliases int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM canonical_issue_fingerprints
		 WHERE confirmed_by = 'exact' AND identity_version = 2`).Scan(&aliases); err != nil {
		t.Fatal(err)
	}
	if aliases != 3 {
		t.Errorf("aliases = %d, want 3", aliases)
	}

	// The backfill merges nothing: three issues in, three issues out.
	var merges int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM issue_merges`).Scan(&merges); err != nil {
		t.Fatal(err)
	}
	if merges != 0 {
		t.Errorf("merges = %d, want 0; the backfill must not combine issues", merges)
	}

	// Every observation settles onto the issue it already belonged to, carrying
	// that issue's episode. identity.ConfirmMerge refuses to merge an issue
	// holding events without settled identity, so a gap here would make every
	// adopted issue permanently unmergeable.
	var unsettled int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		  FROM error_events e
		  LEFT JOIN error_event_identities i
		    ON i.project_id = e.project_id AND i.event_id = e.id
		 WHERE e.error_group_id IS NOT NULL
		   AND (i.event_id IS NULL OR i.status <> 'settled')`).Scan(&unsettled); err != nil {
		t.Fatal(err)
	}
	if unsettled != 0 {
		t.Errorf("%d observations have no settled identity; ConfirmMerge would refuse forever", unsettled)
	}

	var mismatched int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		  FROM error_event_identities i
		  JOIN error_events e
		    ON e.project_id = i.project_id AND e.id = i.event_id
		  JOIN issue_episodes ep ON ep.id = i.episode_id
		 WHERE i.canonical_issue_id <> e.error_group_id
		    OR ep.canonical_issue_id <> e.error_group_id
		    OR i.resolved_fingerprint IS NOT NULL`).Scan(&mismatched); err != nil {
		t.Fatal(err)
	}
	if mismatched != 0 {
		t.Errorf("%d identities point at the wrong issue, wrong episode, or claim a resolved fingerprint", mismatched)
	}

	// Adopted rounds are already published on the digest channel, so the first
	// message after cutover cannot introduce them as new.
	var unpublished int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		  FROM issue_episodes ep
		  LEFT JOIN issue_publications p
		    ON p.project_id = ep.project_id AND p.episode_id = ep.id AND p.channel = 'digest'
		 WHERE ep.sequence = 1 AND p.episode_id IS NULL`).Scan(&unpublished); err != nil {
		t.Fatal(err)
	}
	if unpublished != 0 {
		t.Errorf("%d adopted rounds have no digest receipt; they would announce themselves as new", unpublished)
	}
}

// TestMigration060IsReapplySafeWithData re-runs the backfill over a world it has
// already adopted. run-migrations.sh replays every file on every start, so a
// second pass must not open a second round, rebind an alias, or duplicate a
// receipt.
func TestMigration060IsReapplySafeWithData(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	ctx := context.Background()

	files := migrationFiles(t)
	for _, file := range files {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO orgs (id, name) VALUES ('44444444-4444-4444-4444-444444444444', 'replay');
		INSERT INTO projects (id, org_id, name, github_repo)
		  VALUES ('55555555-5555-5555-5555-555555555555',
		          '44444444-4444-4444-4444-444444444444', 'app', 'owner/repo');
		INSERT INTO environments (id, project_id, name)
		  VALUES ('66666666-6666-6666-6666-666666666666',
		          '55555555-5555-5555-5555-555555555555', 'production');
		INSERT INTO error_groups
		  (id, project_id, fingerprint, title, kind, status, first_seen, last_seen)
		VALUES ('cccccccc-0000-0000-0000-000000000001',
		        '55555555-5555-5555-5555-555555555555', 'fp-replay', 'Replay issue',
		        'error', 'new', now() - interval '5 days', now());
		INSERT INTO error_events
		  (id, project_id, environment_id, error_group_id, timestamp,
		   error_type, error_message, stack_trace_raw)
		VALUES ('dddddddd-0000-0000-0000-000000000001',
		        '55555555-5555-5555-5555-555555555555',
		        '66666666-6666-6666-6666-666666666666',
		        'cccccccc-0000-0000-0000-000000000001', now(),
		        'TypeError', 'boom', 'at x');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	backfill := ""
	for _, file := range files {
		if strings.HasPrefix(filepath.Base(file), "060_") {
			backfill = file
		}
	}
	for pass := 1; pass <= 2; pass++ {
		if err := applyMigration(t, psql, dsn, backfill); err != nil {
			t.Fatalf("backfill pass %d: %v", pass, err)
		}
	}

	var episodes, aliases, identities, receipts int
	if err := pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM issue_episodes),
		       (SELECT count(*) FROM canonical_issue_fingerprints),
		       (SELECT count(*) FROM error_event_identities),
		       (SELECT count(*) FROM issue_publications)`,
	).Scan(&episodes, &aliases, &identities, &receipts); err != nil {
		t.Fatal(err)
	}
	if episodes != 1 || aliases != 1 || identities != 1 || receipts != 1 {
		t.Errorf("after two passes: episodes=%d aliases=%d identities=%d receipts=%d, want 1 each",
			episodes, aliases, identities, receipts)
	}
}
