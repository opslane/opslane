package digest

import (
	"log/slog"
	"os"
	"strings"
	"sync"
)

type UnifiedCardsMode string

// The flag has exactly two values. "shadow" existed briefly in an unshipped
// draft and is deliberately not honored: a stale deployment carrying it falls
// through to the invalid branch and runs off.
const (
	UnifiedCardsOff UnifiedCardsMode = "off"
	UnifiedCardsOn  UnifiedCardsMode = "on"
)

var invalidUnifiedCardsModeWarning sync.Once

// ReadUnifiedCardsMode fails closed: missing or malformed configuration never
// enables authoring or changes publication semantics.
func ReadUnifiedCardsMode() UnifiedCardsMode {
	raw := strings.TrimSpace(os.Getenv("DIGEST_UNIFIED_CARDS"))
	switch UnifiedCardsMode(raw) {
	case UnifiedCardsOn:
		return UnifiedCardsOn
	case UnifiedCardsOff, "":
		return UnifiedCardsOff
	default:
		invalidUnifiedCardsModeWarning.Do(func() {
			slog.Warn("invalid DIGEST_UNIFIED_CARDS; unified digest cards remain off", "value", raw)
		})
		return UnifiedCardsOff
	}
}
