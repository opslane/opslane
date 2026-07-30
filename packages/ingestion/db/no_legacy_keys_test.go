package db_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNoLegacyKeyTableReferences(t *testing.T) {
	needle := "environment" + "_api_keys"
	err := filepath.Walk("..", func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(body), needle) {
			t.Errorf("%s still references the dropped key table", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
