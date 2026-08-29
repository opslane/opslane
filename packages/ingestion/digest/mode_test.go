package digest

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
)

func TestReadUnifiedCardsMode(t *testing.T) {
	for _, tc := range []struct {
		name, value string
		want        UnifiedCardsMode
		warn        bool
	}{
		{name: "empty", want: UnifiedCardsOff},
		{name: "off", value: "off", want: UnifiedCardsOff},
		// Shadow mode is deleted: the retired value is just another unknown
		// value, so a stale deployment setting fails closed to off.
		{name: "shadow", value: "shadow", want: UnifiedCardsOff, warn: true},
		{name: "on", value: "on", want: UnifiedCardsOn},
		{name: "invalid", value: "enabled", want: UnifiedCardsOff, warn: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// The warning is once-per-process by design; each subtest needs its
			// own budget to assert the warn independently.
			invalidUnifiedCardsModeWarning = sync.Once{}
			t.Cleanup(func() { invalidUnifiedCardsModeWarning = sync.Once{} })
			t.Setenv("DIGEST_UNIFIED_CARDS", tc.value)
			var logs bytes.Buffer
			old := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
			t.Cleanup(func() { slog.SetDefault(old) })
			if got := ReadUnifiedCardsMode(); got != tc.want {
				t.Fatalf("mode = %q, want %q", got, tc.want)
			}
			if strings.Contains(logs.String(), "DIGEST_UNIFIED_CARDS") != tc.warn {
				t.Fatalf("warning=%v logs=%q", tc.warn, logs.String())
			}
		})
	}
}
