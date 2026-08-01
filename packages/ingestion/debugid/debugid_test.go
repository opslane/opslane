package debugid

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type vectorFile struct {
	Cases []vector `json:"cases"`
}

type vector struct {
	Name         string `json:"name"`
	InputB64     string `json:"input_b64"`
	Outcome      string `json:"outcome"`
	SHA256       string `json:"sha256"`
	DebugID      string `json:"debug_id"`
	CanonicalB64 string `json:"canonical_b64"`
	RejectReason string `json:"reject_reason"`
}

func TestCompute(t *testing.T) {
	path := filepath.Join("..", "..", "..", "test-fixtures", "debug-id", "vectors.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}

	var vectors vectorFile
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("decode vectors: %v", err)
	}

	for _, test := range vectors.Cases {
		t.Run(test.Name, func(t *testing.T) {
			input, err := base64.StdEncoding.DecodeString(test.InputB64)
			if err != nil {
				t.Fatalf("decode input: %v", err)
			}

			result, err := Compute(input)
			if test.Outcome == "ok" {
				if err != nil {
					t.Fatalf("Compute() error = %v", err)
				}
				if result.ContentSHA256 != test.SHA256 {
					t.Errorf("ContentSHA256 = %q, want %q", result.ContentSHA256, test.SHA256)
				}
				if result.DebugID != test.DebugID {
					t.Errorf("DebugID = %q, want %q", result.DebugID, test.DebugID)
				}
				wantCanonical, err := base64.StdEncoding.DecodeString(test.CanonicalB64)
				if err != nil {
					t.Fatalf("decode canonical_b64: %v", err)
				}
				if !bytes.Equal(result.Canonical, wantCanonical) {
					t.Errorf("Canonical =\n%q\nwant\n%q", result.Canonical, wantCanonical)
				}
				if result.CanonicalSize != int64(len(wantCanonical)) {
					t.Errorf("CanonicalSize = %d, want %d", result.CanonicalSize, len(wantCanonical))
				}
				return
			}

			if err == nil {
				t.Fatalf("Compute() succeeded, want %q rejection", test.RejectReason)
			}
			debugIDErr, ok := err.(*Error)
			if !ok {
				t.Fatalf("Compute() error = %T %v, want *Error", err, err)
			}
			if debugIDErr.Reason != test.RejectReason {
				t.Errorf("reason = %q, want %q", debugIDErr.Reason, test.RejectReason)
			}
		})
	}
}

func TestComputeRejectsOversizeCanonical(t *testing.T) {
	if testing.Short() {
		t.Skip("allocates more than 100 MiB")
	}

	prefix := []byte(`{"version":3,"sources":["a.ts"],"names":[],"mappings":"AAAA","sourcesContent":["`)
	suffix := []byte(`"]}`)
	input := make([]byte, len(prefix)+maxCanonicalBytes+len(suffix))
	copy(input, prefix)
	for i := len(prefix); i < len(prefix)+maxCanonicalBytes; i++ {
		input[i] = 'x'
	}
	copy(input[len(prefix)+maxCanonicalBytes:], suffix)

	_, err := Compute(input)
	debugIDErr, ok := err.(*Error)
	if !ok || debugIDErr.Reason != "too_large" {
		t.Fatalf("Compute() error = %T %v, want *Error reason too_large", err, err)
	}
}
