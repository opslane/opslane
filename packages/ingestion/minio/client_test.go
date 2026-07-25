package minio_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

func testClient(t *testing.T) *minioPkg.Client {
	t.Helper()
	endpoint := os.Getenv("REPLAY_STORE_ENDPOINT")
	if endpoint == "" {
		t.Skip("REPLAY_STORE_ENDPOINT not set; skipping integration test")
	}
	c, err := minioPkg.New(
		endpoint, os.Getenv("REPLAY_STORE_PUBLIC_ENDPOINT"),
		os.Getenv("REPLAY_STORE_ACCESS_KEY"), os.Getenv("REPLAY_STORE_SECRET_KEY"),
		os.Getenv("REPLAY_STORE_BUCKET"), os.Getenv("REPLAY_STORE_REGION"),
	)
	if err != nil {
		t.Fatalf("minio client: %v", err)
	}
	return c
}

func TestRemoveObject(t *testing.T) {
	c := testClient(t)
	ctx := context.Background()
	key := fmt.Sprintf("test/remove-%d.json", time.Now().UnixNano())

	if err := c.PutObject(ctx, key, []byte(`{}`), "application/json"); err != nil {
		t.Fatalf("put: %v", err)
	}
	if _, err := c.StatObject(ctx, key); err != nil {
		t.Fatalf("stat before remove: %v", err)
	}
	if err := c.RemoveObject(ctx, key); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if _, err := c.StatObject(ctx, key); err == nil {
		t.Fatal("object still exists after RemoveObject")
	}
}

// Retention deletes keys that may already be gone (crash mid-sweep, concurrent
// replica). That must not be an error, or the sweep wedges permanently.
func TestRemoveObject_MissingKeyIsNotAnError(t *testing.T) {
	c := testClient(t)
	key := fmt.Sprintf("test/never-existed-%d.json", time.Now().UnixNano())
	if err := c.RemoveObject(context.Background(), key); err != nil {
		t.Fatalf("removing a missing key returned %v, want nil (retention must be idempotent)", err)
	}
}

func TestRemovePrefix(t *testing.T) {
	c := testClient(t)
	ctx := context.Background()
	base := fmt.Sprintf("test/prefix-%d", time.Now().UnixNano())
	inside := []string{base + "/a.gz", base + "/nested/b.gz"}
	outside := base + "-other/c.gz"
	for _, key := range append(inside, outside) {
		if err := c.PutObject(ctx, key, []byte("x"), "application/gzip"); err != nil {
			t.Fatalf("put %s: %v", key, err)
		}
	}
	t.Cleanup(func() { _ = c.RemoveObject(context.Background(), outside) })

	if err := c.RemovePrefix(ctx, base+"/"); err != nil {
		t.Fatalf("remove prefix: %v", err)
	}
	for _, key := range inside {
		if _, err := c.StatObject(ctx, key); err == nil {
			t.Fatalf("object %s survived prefix removal", key)
		}
	}
	if _, err := c.StatObject(ctx, outside); err != nil {
		t.Fatalf("neighboring prefix was removed: %v", err)
	}
}
