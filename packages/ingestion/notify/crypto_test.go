package notify

import (
	"strings"
	"testing"
)

const testSecret = "0123456789abcdef0123456789abcdef"

func TestSealOpenRoundTrip(t *testing.T) {
	cipher, err := NewConfigCipher([]byte(testSecret))
	if err != nil {
		t.Fatal(err)
	}
	aad := ConfigAAD("dest-1", "proj-1", "slack")
	blob, err := cipher.Seal([]byte(`{"webhook_url":"https://hooks.slack.com/services/T/B/x"}`), aad)
	if err != nil {
		t.Fatal(err)
	}
	got, err := cipher.Open(blob, aad)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "hooks.slack.com") {
		t.Fatalf("round trip mismatch: %s", got)
	}
}

func TestOpenRejectsTransplantedAAD(t *testing.T) {
	cipher, err := NewConfigCipher([]byte(testSecret))
	if err != nil {
		t.Fatal(err)
	}
	blob, err := cipher.Seal([]byte(`{"webhook_url":"u"}`), ConfigAAD("dest-1", "proj-1", "slack"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cipher.Open(blob, ConfigAAD("dest-2", "proj-1", "slack")); err == nil {
		t.Fatal("expected destination AAD mismatch to fail")
	}
	if _, err := cipher.Open(blob, ConfigAAD("dest-1", "proj-other", "slack")); err == nil {
		t.Fatal("expected project AAD mismatch to fail")
	}
	webhookAAD := ConfigAAD("dest-1", "proj-1", "webhook")
	webhookBlob, err := cipher.Seal([]byte(`{"webhook_url":"u"}`), webhookAAD)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cipher.Open(webhookBlob, ConfigAAD("dest-1", "proj-1", "slack")); err == nil {
		t.Fatal("expected destination type AAD mismatch to fail")
	}
	if _, err := cipher.Open(webhookBlob, webhookAAD); err != nil {
		t.Fatalf("matching destination type AAD failed: %v", err)
	}
}

func TestNewConfigCipherRejectsShortSecret(t *testing.T) {
	if _, err := NewConfigCipher([]byte("short")); err == nil {
		t.Fatal("expected short secret rejection")
	}
}
