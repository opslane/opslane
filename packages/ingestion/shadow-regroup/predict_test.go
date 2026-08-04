package main

import "testing"

func TestPredict(t *testing.T) {
	rows := []EventRow{
		{ProjectID: "p1", GroupID: "g1", Platform: "javascript", ErrorMessage: "Failed to fetch dynamically imported module: https://a.com/assets/chunk-index.Dlu29ZBh.js"},
		{ProjectID: "p1", GroupID: "g2", Platform: "javascript", ErrorMessage: "Unable to preload CSS for /assets/index-BUccYFyj.css"},
		{ProjectID: "p1", GroupID: "g3", Platform: "javascript", ErrorMessage: "Script error."},
		{ProjectID: "p1", GroupID: "g4", Platform: "javascript", ErrorMessage: "Cannot read properties of null (reading 'includes')", StackRaw: "at f (https://a.com/x.js:1:1)"},
		{ProjectID: "p1", GroupID: "g5", Platform: "javascript", ErrorMessage: "Failed to fetch dynamically imported module: https://a.com/assets/x-Abc12345.js"},
		{ProjectID: "p1", GroupID: "g5", Platform: "javascript", ErrorMessage: "Cannot read properties of undefined (reading 'length')", StackRaw: "at g (https://a.com/y.js:2:2)"},
		{ProjectID: "p1", GroupID: "g6", Platform: "javascript", ErrorMessage: "Script error."},
		{ProjectID: "p1", GroupID: "g6", Platform: "javascript", ErrorMessage: "Some real error", StackRaw: "at h (https://a.com/z.js:3:3)"},
		{ProjectID: "p2", GroupID: "g1", Platform: "javascript", ErrorMessage: "Cannot read properties of null (reading 'x')", StackRaw: "at f (https://b.com/x.js:1:1)"},
		{ProjectID: "p1", GroupID: "g7", Platform: "python", ErrorMessage: "Failed to fetch dynamically imported module: x.js"},
	}

	report := Predict(rows)
	project := report.PerProject["p1"]
	if project.SuppressedByRule["script_error"] != 2 {
		t.Errorf("script_error suppressed = %d, want 2", project.SuppressedByRule["script_error"])
	}
	if want := []string{"g1", "g2"}; !equalStrings(project.FamilyCollapsed, want) {
		t.Errorf("family collapsed = %v, want %v", project.FamilyCollapsed, want)
	}
	if want := []string{"g3"}; !equalStrings(project.NoiseOnly, want) {
		t.Errorf("noise-only = %v, want %v", project.NoiseOnly, want)
	}
	if want := []string{"g5", "g6"}; !equalStrings(project.MixedGroups, want) {
		t.Errorf("mixed groups = %v, want %v", project.MixedGroups, want)
	}
	if project.UnchangedGroups != 4 {
		t.Errorf("unchanged groups = %d, want 4", project.UnchangedGroups)
	}
	if report.PerProject["p2"].UnchangedGroups != 1 {
		t.Errorf("p2 must tally independently, got %+v", report.PerProject["p2"])
	}
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}
