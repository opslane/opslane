package minio

import (
	"context"
	"net/url"
	"testing"
	"time"
)

func TestPresignedGetURLUsesPublicEndpoint(t *testing.T) {
	client, err := New(
		"http://minio.internal:9000",
		"https://replays.example.com",
		"test-key",
		"test-secret",
		"opslane-replays",
		"us-east-1",
	)
	if err != nil {
		t.Fatal(err)
	}

	raw, err := client.PresignedGetURL(context.Background(), "sessions/p/s/frames/v1/t100_a.png", 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Host != "replays.example.com" {
		t.Fatalf("presigned URL host = %q, want public endpoint", parsed.Host)
	}
	if parsed.Query().Get("X-Amz-Signature") == "" {
		t.Fatalf("URL is not signed: %s", raw)
	}
}
