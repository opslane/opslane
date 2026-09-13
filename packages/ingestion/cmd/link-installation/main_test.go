package main

import "testing"

const (
	testOrg     = "0ff3bcae-0000-4000-8000-000000000001"
	testProject = "5a64d496-0000-4000-8000-000000000002"
)

func TestParseArgsAcceptsFullCommand(t *testing.T) {
	got, err := parseArgs([]string{
		"-installation", "161250809", "-org", testOrg, "-expect-account", "agentwebpro",
		"-project", testProject, "-repo", "agentwebpro/agentweb", "-apply",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := config{
		InstallationID: 161250809, OrgID: testOrg, ExpectAccount: "agentwebpro",
		ProjectID: testProject, Repo: "agentwebpro/agentweb", Apply: true,
	}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseArgsDefaultsToDryRun(t *testing.T) {
	got, err := parseArgs([]string{"-installation", "1", "-org", testOrg, "-expect-account", "acme"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Apply {
		t.Fatal("expected a dry run without -apply")
	}
}

func TestParseArgsRejectsBadInput(t *testing.T) {
	cases := map[string][]string{
		"missing installation":     {"-org", testOrg, "-expect-account", "acme"},
		"non-numeric installation": {"-installation", "abc", "-org", testOrg, "-expect-account", "acme"},
		"zero installation":        {"-installation", "0", "-org", testOrg, "-expect-account", "acme"},
		"missing org":              {"-installation", "1", "-expect-account", "acme"},
		"org not a UUID":           {"-installation", "1", "-org", "nope", "-expect-account", "acme"},
		"missing expect-account":   {"-installation", "1", "-org", testOrg},
		"blank expect-account":     {"-installation", "1", "-org", testOrg, "-expect-account", "  "},
		"project not a UUID":       {"-installation", "1", "-org", testOrg, "-expect-account", "acme", "-project", "nope"},
		"repo without project":     {"-installation", "1", "-org", testOrg, "-expect-account", "acme", "-repo", "acme/web"},
		"stray argument":           {"-installation", "1", "-org", testOrg, "-expect-account", "acme", "extra"},
		"unknown flag":             {"-installation", "1", "-org", testOrg, "-expect-account", "acme", "-force"},
	}
	for name, args := range cases {
		if _, err := parseArgs(args); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}
