package db

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNoRuntimeReferenceToDigestReadiness(t *testing.T) {
	// scripts/ holds operator SQL that runs against production; a script keyed
	// on the frozen table acts on permanently stale rows, so it counts as a
	// runtime reference even though nothing imports it.
	roots := []string{"../", "../../worker/src", "../../../scripts"}
	var offenders []string
	for _, root := range roots {
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return nil
			}
			if strings.Contains(path, "/migrations/") || strings.HasSuffix(path, "_test.go") || strings.HasSuffix(path, ".test.ts") {
				return nil
			}
			if ext := filepath.Ext(path); ext != ".go" && ext != ".ts" && ext != ".sql" {
				return nil
			}
			body, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			if bytes.Contains(body, []byte("digest_readiness")) {
				offenders = append(offenders, path)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("scan runtime sources: %v", err)
		}
	}
	if len(offenders) > 0 {
		t.Errorf("digest readiness table still referenced at runtime:\n  %s", strings.Join(offenders, "\n  "))
	}
}
