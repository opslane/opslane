package retention

import (
	"testing"
	"time"
)

func TestAgentRunCutoffKeepsRetentionPlusOneUTCDay(t *testing.T) {
	// 20:00 on 14 September in UTC-7 is already 15 September in UTC.
	now := time.Date(2026, 9, 14, 20, 0, 0, 0, time.FixedZone("UTC-7", -7*3600))
	cutoff := agentRunCutoff(now, 3)
	if want := time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC); !cutoff.Equal(want) {
		t.Fatalf("cutoff = %v, want %v", cutoff, want)
	}
	for _, tc := range []struct {
		day     string
		removed bool
	}{
		{"2026-09-12", false}, // inside retention
		{"2026-09-11", false}, // exactly retention plus one day
		{"2026-09-10", true},
	} {
		day, ok := parseAgentRunDay("agent-runs/p/" + tc.day + "/")
		if !ok {
			t.Fatalf("parseAgentRunDay(%s) failed", tc.day)
		}
		if got := day.Before(cutoff); got != tc.removed {
			t.Errorf("day %s removed = %v, want %v", tc.day, got, tc.removed)
		}
	}
	if _, ok := parseAgentRunDay("agent-runs/p/not-a-day/"); ok {
		t.Fatal("a folder that is not a date must not be treated as a day")
	}
}
