package notify

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDigestEnvelopeOmitsIssueAndEnvironment(t *testing.T) {
	p := EventPayload{
		Version: 1, EventType: "digest.daily",
		Project: ProjectRef{ID: "p1", Name: "acme"},
		Digest:  &DigestPayload{Date: "2026-08-07"},
	}
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, forbidden := range []string{`"issue"`, `"environment"`} {
		if strings.Contains(s, forbidden) {
			t.Errorf("digest envelope must omit %s, got %s", forbidden, s)
		}
	}
	if !strings.Contains(s, `"digest"`) {
		t.Errorf("digest envelope missing digest body: %s", s)
	}
}

func TestIssueEnvelopeUnchanged(t *testing.T) {
	p := EventPayload{
		Version: 1, EventType: "issue.created",
		Issue:       &IssueRef{ID: "g1", Title: "boom", FirstSeen: "2026-08-07T00:00:00Z"},
		Project:     ProjectRef{ID: "p1", Name: "acme"},
		Environment: "production",
	}
	b, _ := json.Marshal(p)
	s := string(b)
	for _, required := range []string{`"issue"`, `"environment":"production"`, `"title":"boom"`} {
		if !strings.Contains(s, required) {
			t.Errorf("issue envelope missing %s: %s", required, s)
		}
	}
	if strings.Contains(s, `"digest"`) {
		t.Errorf("issue envelope must omit digest: %s", s)
	}
}

func TestValidateExactlyOneBody(t *testing.T) {
	cases := []struct {
		name    string
		payload EventPayload
		wantErr bool
	}{
		{"issue ok", EventPayload{EventType: "issue.created", Issue: &IssueRef{ID: "g"}}, false},
		{"digest ok", EventPayload{EventType: "digest.daily", Digest: &DigestPayload{}}, false},
		{"issue missing body", EventPayload{EventType: "issue.created"}, true},
		{"digest missing body", EventPayload{EventType: "digest.daily"}, true},
		{"issue with digest body", EventPayload{EventType: "issue.created", Issue: &IssueRef{ID: "g"}, Digest: &DigestPayload{}}, true},
		{"unknown type", EventPayload{EventType: "bogus", Issue: &IssueRef{ID: "g"}}, true},
	}
	for _, c := range cases {
		if err := c.payload.Validate(); (err != nil) != c.wantErr {
			t.Errorf("%s: err=%v wantErr=%v", c.name, err, c.wantErr)
		}
	}
}
