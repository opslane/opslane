package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func newV2AgentSession(t *testing.T, q *db.Queries, repo string) (*db.AgentSession, string) {
	t.Helper()
	raw, hash, pub, err := auth.NewAgentPollToken()
	if err != nil {
		t.Fatal(err)
	}
	session, err := q.CreateAgentSession(context.Background(), db.CreateAgentSessionParams{
		RepoURL: repo, PollTokenHash: hash, AgentKeyPub: pub,
	})
	if err != nil {
		t.Fatal(err)
	}
	return session, raw
}

func TestCreateAgentSession_V2FieldsRoundTrip(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	repo := "v2-owner/v2-" + uuid.NewString()

	params := db.CreateAgentSessionParams{
		RepoURL: repo, PollTokenHash: "hash-1", AgentKeyPub: "pub-1",
	}
	first, err := q.CreateAgentSession(ctx, params)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	second, err := q.CreateAgentSession(ctx, params)
	if err != nil {
		t.Fatalf("second pending create should be allowed: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = ANY($1::uuid[])`, []string{first.ID, second.ID})
	})

	got, err := q.GetAgentSession(ctx, first.ID)
	if err != nil || got == nil {
		t.Fatalf("get: %v", err)
	}
	if got.PollTokenHash == nil || *got.PollTokenHash != "hash-1" ||
		got.AgentKeyPub == nil || *got.AgentKeyPub != "pub-1" {
		t.Errorf("v2 fields not persisted: %+v", got)
	}
}

func TestAgentSessionV2FailureAndClickAreIdempotent(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	session, _ := newV2AgentSession(t, q, "v2-owner/failure-"+uuid.NewString())
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, session.ID) })

	if err := q.MarkAgentSessionAuthClicked(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	first, err := q.GetAgentSession(ctx, session.ID)
	if err != nil || first.AuthClickedAt == nil {
		t.Fatalf("first click stamp: session=%+v err=%v", first, err)
	}
	if err := q.MarkAgentSessionAuthClicked(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	second, _ := q.GetAgentSession(ctx, session.ID)
	if second.AuthClickedAt == nil || !second.AuthClickedAt.Equal(*first.AuthClickedAt) {
		t.Fatalf("click timestamp changed: first=%v second=%v", first.AuthClickedAt, second.AuthClickedAt)
	}

	changed, err := q.MarkAgentSessionFailed(ctx, session.ID, "repo_not_granted")
	if err != nil || !changed {
		t.Fatalf("mark failed: changed=%v err=%v", changed, err)
	}
	changed, err = q.MarkAgentSessionFailed(ctx, session.ID, "installation_not_yours")
	if err != nil || changed {
		t.Fatalf("second mark: changed=%v err=%v", changed, err)
	}
	failed, _ := q.GetAgentSession(ctx, session.ID)
	if failed.Status != "failed" || failed.FailureReason == nil || *failed.FailureReason != "repo_not_granted" {
		t.Fatalf("failed session = %+v", failed)
	}
}

func TestAgentSessionV2DeliveryStamp(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	session, raw := newV2AgentSession(t, q, "v2-owner/delivery-"+uuid.NewString())
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, session.ID) })

	sealed, err := auth.SealAgentKey(*session.AgentKeyPub, session.ID, "def_delivery-test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE agent_sessions SET status = 'provisioned', api_key_sealed = $2 WHERE id = $1`,
		session.ID, sealed); err != nil {
		t.Fatal(err)
	}
	opened, err := auth.OpenAgentKey(raw, session.ID, sealed)
	if err != nil || opened != "def_delivery-test" {
		t.Fatalf("open: value=%q err=%v", opened, err)
	}
	if err := q.MarkAgentKeyDelivered(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	first, _ := q.GetAgentSession(ctx, session.ID)
	if first.KeyClaimedAt == nil || first.Status != "key_ok" {
		t.Fatalf("first delivery = status %q claimed %v, want key_ok with timestamp", first.Status, first.KeyClaimedAt)
	}
	if err := q.MarkAgentKeyDelivered(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	second, _ := q.GetAgentSession(ctx, session.ID)
	if second.KeyClaimedAt == nil || !second.KeyClaimedAt.Equal(*first.KeyClaimedAt) {
		t.Fatalf("delivery timestamp changed: first=%v second=%v", first.KeyClaimedAt, second.KeyClaimedAt)
	}

}

func TestAgentSessionLifecycleCiphertextPurgePreservesStatus(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	for _, status := range []string{"provisioned", "key_ok", "app_reporting"} {
		t.Run(status, func(t *testing.T) {
			session, _ := newV2AgentSession(t, q, "v2-owner/purge-"+status+"-"+uuid.NewString())
			t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, session.ID) })
			if _, err := pool.Exec(ctx,
				`UPDATE agent_sessions
				 SET status = $2, api_key_sealed = 'sealed-test', expires_at = now() - interval '1 minute'
				 WHERE id = $1`, session.ID, status); err != nil {
				t.Fatal(err)
			}

			if _, err := q.ExpireAgentSessions(ctx); err != nil {
				t.Fatal(err)
			}
			after, err := q.GetAgentSession(ctx, session.ID)
			if err != nil || after == nil {
				t.Fatalf("read purged session: session=%v err=%v", after, err)
			}
			if after.Status != status || after.APIKeySealed != nil {
				t.Fatalf("purged session = status %q sealed %v err=%v, want %s with no ciphertext", after.Status, after.APIKeySealed, err, status)
			}
		})
	}
}

func TestAgentSessionLifecycleStatuses(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	session, _ := newV2AgentSession(t, q, "v2-owner/lifecycle-"+uuid.NewString())
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, session.ID) })

	for _, status := range []string{"provisioned", "app_reporting"} {
		if _, err := pool.Exec(ctx, `UPDATE agent_sessions SET status = $2 WHERE id = $1`, session.ID, status); err != nil {
			t.Fatalf("set lifecycle status %q: %v", status, err)
		}
		got, err := q.GetAgentSession(ctx, session.ID)
		if err != nil || got.Status != status {
			t.Fatalf("lifecycle status = %q err=%v, want %q", got.Status, err, status)
		}
	}
}

func TestCreateAgentSession_ApproveFieldsAndTTL(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	_, hash, pub, err := auth.NewAgentPollToken()
	if err != nil {
		t.Fatal(err)
	}
	name := "acme-dashboard"
	remote := "acme/dashboard"
	s, err := q.CreateAgentSession(ctx, db.CreateAgentSessionParams{
		ProjectName: &name, GitRemote: &remote, PollTokenHash: hash, AgentKeyPub: pub,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, s.ID) })
	if s.ProjectName == nil || *s.ProjectName != name || s.GitRemote == nil || *s.GitRemote != remote {
		t.Fatalf("approve fields not stored: %+v", s)
	}
	if ttl := time.Until(s.ExpiresAt); ttl < 115*time.Minute || ttl > 125*time.Minute {
		t.Fatalf("expected ~2h TTL, got %s", ttl)
	}
	got, err := q.GetAgentSession(ctx, s.ID)
	if err != nil || got == nil || got.ProjectName == nil || *got.ProjectName != name || got.GitRemote == nil {
		t.Fatalf("GetAgentSession did not round-trip: %v %+v", err, got)
	}
}
