package priority

import (
	"encoding/json"
	"os"
	"testing"
)

func TestNormalizePageURL(t *testing.T) {
	raw, err := os.ReadFile("../../../test-fixtures/url-normalization/vectors.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture struct {
		Vectors []struct {
			Name string `json:"name"`
			In   string `json:"in"`
			Want string `json:"want"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(fixture.Vectors) < 50 {
		t.Fatalf("fixture suspiciously small: %d rows", len(fixture.Vectors))
	}
	seen := make(map[string]bool, len(fixture.Vectors))
	for i, tc := range fixture.Vectors {
		if tc.Name == "" {
			t.Fatalf("row %d: empty name (schema guard — a malformed row must not silently pass)", i)
		}
		if seen[tc.Name] {
			t.Errorf("duplicate fixture name %q", tc.Name)
		}
		seen[tc.Name] = true
		if tc.In == "" && tc.Name != "empty input stays empty" {
			t.Fatalf("row %q: empty input on a row not named for it", tc.Name)
		}
		if got := NormalizePageURL(tc.In); got != tc.Want {
			t.Errorf("%s: NormalizePageURL(%q) = %q, want %q", tc.Name, tc.In, got, tc.Want)
		}
	}

	// route_map's btree primary key refuses an oversized pattern, and one such
	// row aborts the transaction that writes every other route for the project.
	long := "https://app.example.com"
	for i := 0; i < 400; i++ {
		long += "/abcdefgh"
	}
	if got := NormalizePageURL(long); got != "/too-long" {
		t.Errorf("oversized path: NormalizePageURL() = %q, want /too-long", got)
	}
}

// The two kinds reach NormalizePageURL in different shapes: error groups from
// the raw browser URL, friction groups from a value fingerprint.ts already
// normalized (origin kept, _ctx_ segments dropped). Both must land on one
// pattern or route_map weights only half the incidents on a page.
func TestConvergesAcrossBothStampingPaths(t *testing.T) {
	cases := []struct{ name, raw, preNormalized, want string }{
		{
			"embedded panel with a context segment",
			"https://x.cdn.prod.example.net/a/b/issue-context/_ctx_abc/",
			"https://x.cdn.prod.example.net/a/b/issue-context",
			"/a/b/issue-context",
		},
		{
			"ordinary page",
			"https://app.test/orders/4021",
			"https://app.test/orders/:id",
			"/orders/:id",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gotError := NormalizePageURL(c.raw)
			gotFriction := NormalizePageURL(c.preNormalized)
			if gotError != c.want || gotFriction != c.want {
				t.Errorf("error path = %q, friction path = %q, want both %q", gotError, gotFriction, c.want)
			}
		})
	}
}
