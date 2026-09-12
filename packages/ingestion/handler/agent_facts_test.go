package handler

import "testing"

func TestParseWait(t *testing.T) {
	cases := map[string]int{"": 0, "abc": 0, "-3": 0, "0": 0, "7": 7, "30": 30, "31": 30, "999": 30}
	for in, want := range cases {
		if got := parseWait(in); got != want {
			t.Errorf("parseWait(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestAgentNextHint(t *testing.T) {
	if h := agentNextHint("provisioned", agentFacts{}); h == "" || h == agentNextHint("app_reporting", agentFacts{}) {
		t.Fatalf("hints must differ by status: %q", h)
	}
	if h := agentNextHint("app_reporting", agentFacts{HasEvents: true}); h != agentNextHint("provisioned", agentFacts{HasEvents: true}) {
		t.Fatal("once has_events is true the hint no longer depends on status")
	}
}
