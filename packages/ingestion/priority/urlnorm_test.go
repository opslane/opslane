package priority

import "testing"

func TestNormalizePageURL(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"empty", "", ""},
		{"plain path", "https://app.example.com/assets", "/assets"},
		{"host collapsed", "https://api.example.com/licenses", "/licenses"},
		{"raw ip collapsed", "https://54.186.188.118/alerts", "/alerts"},
		{"bare path accepted", "/licenses", "/licenses"},
		{"numeric id", "https://app.example.com/assets/2985977", "/assets/:id"},
		{"uuid id", "https://a.example.com/x/6428e085-905a-40e4-9c67-d0b9772ceec6", "/x/:id"},
		{"hashbang fragment", "https://app.example.com/#!/reports", "/reports"},
		{"hashbang with id", "https://app.example.com/#!/assets/42", "/assets/:id"},
		{"forge known module", "https://x.cdn.prod.atlassian-dev.net/a/b/c/issue-context/_ctx_abc/", "forge:issue-context"},
		{"forge unknown module", "https://x.cdn.prod.atlassian-dev.net/a/b/c/custom-thing/_ctx_abc/", "forge:custom-thing"},
		// No marker means the module is the last segment, not "unknown":
		// fingerprint.ts strips _ctx_ before friction groups are stamped, so
		// this is the shape the friction side arrives in.
		{"forge no ctx marker", "https://x.cdn.prod.atlassian-dev.net/a/b/c/", "forge:c"},
		{"forge module without marker", "https://x.cdn.prod.atlassian-dev.net/a/b/issue-context/", "forge:issue-context"},
		{"forge module without marker templated", "https://x.cdn.prod.atlassian-dev.net/a/b/9f8e7d6c5b4a3928/", "forge::token"},
		{"forge root has no module", "https://x.cdn.prod.atlassian-dev.net/", "forge:unknown"},
		{"jwt segment", "https://app.example.com/c/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dQw4w9WgXcQ", "/c/:token"},
		{"hex token", "https://app.example.com/sign/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "/sign/:token"},
		{"percent-encoded token", "https://app.example.com/sign/a1b2c3d4e5f6a7b8%2Bc9d0e1f2a3b4c5d6", "/sign/:token"},
		{"long word kept", "https://app.example.com/administration", "/administration"},
		{"hyphenated words kept", "https://app.example.com/settings/field-sync", "/settings/field-sync"},
		{"mixed alnum token", "https://app.example.com/t/x9k2mQ84hzL0pR7vN3wY", "/t/:token"},
		{"long alpha-only token", "https://app.example.com/k/qwrtypsdfghjklzxcvbnmqwrtyp", "/k/:token"},
		{"base64url with hyphen", "https://app.example.com/v/Ab3dEf-gH1jKl_mN0pQr5s", "/v/:token"},
		{"hyphenated slug kept", "https://app.example.com/getting-started-with-forms", "/getting-started-with-forms"},
		{"query stripped", "https://app.example.com/assets?x=1", "/assets"},
		{"root", "https://app.example.com/", "/"},
		{"garbage", "not a url", "/not-parseable"},

		// A bare path carries its own fragment, so it must reach the same
		// route the absolute form does instead of collapsing onto "/".
		{"bare hashbang fragment", "/#!/reports", "/reports"},
		{"bare hashbang with id", "/#!/assets/42", "/assets/:id"},
		{"bare query stripped", "/orders/123?token=secret", "/orders/:id"},

		// The forge branch returns before the main templating loop, so it has
		// to template the module segment itself or it publishes opaque ids.
		{"forge opaque module templated", "https://x.cdn.prod.atlassian-dev.net/a/9f8e7d6c5b4a3928/_ctx_x", "forge::token"},
		{"forge numeric module templated", "https://x.cdn.prod.atlassian-dev.net/a/402931/_ctx_x", "forge::id"},

		// A bare suffix test also matches lookalike domains, which would route
		// an attacker-chosen path through the forge branch.
		{"forge lookalike host is not forge", "https://evilatlassian-dev.net/a/SUPERSECRETTOKEN12345/_ctx_x", "/a/:token/_ctx_x"},
		{"forge apex host", "https://atlassian-dev.net/a/issue-context/_ctx_x", "forge:issue-context"},
	}
	// route_map's btree primary key refuses an oversized pattern, and one such
	// row aborts the transaction that writes every other route for the project.
	long := "https://app.example.com"
	for i := 0; i < 400; i++ {
		long += "/abcdefgh"
	}
	cases = append(cases, struct{ name, in, want string }{
		"oversized path collapses to one sentinel", long, "/too-long",
	})
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := NormalizePageURL(c.in); got != c.want {
				t.Errorf("NormalizePageURL(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

// The two kinds reach NormalizePageURL in different shapes: error groups from
// the raw browser URL, friction groups from a value fingerprint.ts already
// normalized (origin kept, _ctx_ segments dropped). Both must land on one
// pattern or route_map weights only half the incidents on a page.
func TestForgeConvergesAcrossBothStampingPaths(t *testing.T) {
	cases := []struct{ name, raw, preNormalized, want string }{
		{
			"forge panel",
			"https://x.cdn.prod.atlassian-dev.net/a/b/issue-context/_ctx_abc/",
			"https://x.cdn.prod.atlassian-dev.net/a/b/issue-context",
			"forge:issue-context",
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
