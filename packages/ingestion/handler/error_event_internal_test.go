package handler

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSanitizeDebugMeta_ExposesValidatedImages(t *testing.T) {
	raw := json.RawMessage(`{"images":[
		{"type":"sourcemap","code_file":"https://cdn.example.net/app.js","debug_id":"afa8111b-3697-ce9d-b9e5-4e52afdb3b57"}
	]}`)

	got := sanitizeDebugMeta(raw)

	if len(got.Images) != 1 {
		t.Fatalf("want 1 validated image, got %d", len(got.Images))
	}
	if got.Images[0].CodeFile != "https://cdn.example.net/app.js" {
		t.Errorf("code_file not carried through: %q", got.Images[0].CodeFile)
	}
	if got.Images[0].DebugID != "afa8111b-3697-ce9d-b9e5-4e52afdb3b57" {
		t.Errorf("debug_id not carried through: %q", got.Images[0].DebugID)
	}
	if got.ImageCount != 1 {
		t.Errorf("ImageCount must keep its existing meaning, got %d", got.ImageCount)
	}
}

// Images must agree with the JSON that gets stored. If validation discarded an
// entry, grouping must not have seen it either.
func TestSanitizeDebugMeta_ImagesAgreeWithStoredJSON(t *testing.T) {
	raw := json.RawMessage(`{"images":[
		{"type":"sourcemap","code_file":"https://cdn.example.net/good.js","debug_id":"afa8111b-3697-ce9d-b9e5-4e52afdb3b57"},
		{"type":"not-a-sourcemap","code_file":"https://cdn.example.net/bad.js","debug_id":"bbbbbbbb-3697-ce9d-b9e5-4e52afdb3b57"},
		"not-an-object"
	]}`)

	got := sanitizeDebugMeta(raw)

	if len(got.Images) != got.ImageCount {
		t.Errorf("Images (%d) must match ImageCount (%d)", len(got.Images), got.ImageCount)
	}
	for _, image := range got.Images {
		if !strings.Contains(got.JSON, image.DebugID) {
			t.Errorf("image %q was exposed to grouping but is absent from the stored JSON", image.DebugID)
		}
	}
}

func TestSanitizeDebugMeta_NoImagesYieldsNoSourceImages(t *testing.T) {
	for name, raw := range map[string]json.RawMessage{
		"absent":    nil,
		"empty":     json.RawMessage(`{"images":[]}`),
		"malformed": json.RawMessage(`not json`),
	} {
		if got := sanitizeDebugMeta(raw); len(got.Images) != 0 {
			t.Errorf("%s debug_meta must yield no images, got %d", name, len(got.Images))
		}
	}
}
