package identity

import (
	"crypto/sha256"
	"fmt"
	"strings"
)

const IdentityVersion = 2

// ResolverVersion is the envelope contract version. It must equal
// RESOLVER_VERSION in packages/worker/src/resolve/envelope.ts.
const ResolverVersion = 2

const maxIdentityFrames = 5

type GeneratedPos struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}

type Frame struct {
	OriginalFile     string       `json:"original_file"`
	OriginalFunction string       `json:"original_function"`
	OriginalLine     int          `json:"original_line"`
	Generated        GeneratedPos `json:"generated"`
}

type Envelope struct {
	Version int     `json:"version"`
	Frames  []Frame `json:"frames"`
}

// CanonicalString serializes an envelope into the identity key input.
// Anonymous functions include their original line so unrelated callbacks in
// the same file do not merge.
func CanonicalString(env Envelope) string {
	frames := env.Frames
	if len(frames) > maxIdentityFrames {
		frames = frames[:maxIdentityFrames]
	}
	parts := make([]string, 0, len(frames)+1)
	parts = append(parts, fmt.Sprintf("v%d", env.Version))
	for _, frame := range frames {
		file := strings.ReplaceAll(frame.OriginalFile, "\\", "/")
		if frame.OriginalFunction == "" || frame.OriginalFunction == "<anonymous>" {
			parts = append(parts, fmt.Sprintf("%s#L%d", file, frame.OriginalLine))
			continue
		}
		parts = append(parts, fmt.Sprintf("%s#%s", file, frame.OriginalFunction))
	}
	return strings.Join(parts, "|")
}

func Hash(env Envelope) string {
	sum := sha256.Sum256([]byte(CanonicalString(env)))
	return fmt.Sprintf("%x", sum[:16])
}
