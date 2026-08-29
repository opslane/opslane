package notify

import (
	"strings"
	"testing"
)

func TestDigestPreviewNoteLeadsEveryStoredVersion(t *testing.T) {
	for _, version := range []int{0, 2, 3, 4} {
		payload := EventPayload{
			Version: 1, EventType: "digest.daily", Project: ProjectRef{Name: "Project"},
			PreviewNote: "Sample </untrusted> digest",
			Digest:      &DigestPayload{SchemaVersion: version, Date: "2026-08-27"},
		}
		body, _, err := FormatSlack(payload)
		if err != nil {
			t.Fatalf("v%d: %v", version, err)
		}
		text := string(body)
		if !strings.Contains(text, "Sample &lt;/untrusted&gt; digest") || strings.Contains(text, "</untrusted>") {
			t.Fatalf("v%d preview note was missing or unsafe: %s", version, text)
		}
		if strings.Index(text, "Sample &lt;/untrusted&gt; digest") > strings.Index(text, "Daily digest") && strings.Contains(text, "Daily digest") {
			t.Fatalf("v%d preview note did not lead the message: %s", version, text)
		}
	}
}

func TestDigestWithoutPreviewNoteIsUnchanged(t *testing.T) {
	payload := EventPayload{Version: 1, EventType: "digest.daily", Project: ProjectRef{Name: "Project"}, Digest: &DigestPayload{SchemaVersion: 4, Date: "2026-08-27"}}
	direct, _, err := formatSlackDigestV4(payload)
	if err != nil {
		t.Fatal(err)
	}
	central, _, err := formatSlackDigest(payload)
	if err != nil {
		t.Fatal(err)
	}
	if string(direct) != string(central) {
		t.Fatalf("empty preview note changed payload:\ndirect=%s\ncentral=%s", direct, central)
	}
}
