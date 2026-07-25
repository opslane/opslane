package scrubber

import (
	"testing"
	"time"
)

// The tick interval is the caller's to choose. It is deliberately NOT bounded
// by the retained 30s eligibility grace in ClaimUnscrubbedChunks: that grace is
// a floor on when a chunk becomes claimable, not on how often we look, and is
// no longer load-bearing now that chunk uploads are not presigned (#194).
func TestResolveInterval(t *testing.T) {
	tests := []struct {
		name string
		in   time.Duration
		want time.Duration
	}{
		{"caller's value is honored", 5 * time.Second, 5 * time.Second},
		{"main.go's production argument", 15 * time.Second, 15 * time.Second},
		{"a one-second CI interval is honored", time.Second, time.Second},
		{"an interval above the grace is not clamped", time.Minute, time.Minute},
		{"zero falls back to the default", 0, defaultInterval},
		{"negative falls back to the default", -time.Second, defaultInterval},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveInterval(tt.in); got != tt.want {
				t.Fatalf("resolveInterval(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

// defaultInterval must stay reachable, so a future refactor cannot make the
// zero path dead code the way retention's clamp once did.
func TestResolveInterval_DefaultIsReachable(t *testing.T) {
	if got := resolveInterval(0); got != 15*time.Second {
		t.Fatalf("resolveInterval(0) = %v, want 15s", got)
	}
}
