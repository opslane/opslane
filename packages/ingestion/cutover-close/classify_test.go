package main

import "testing"

// allRemovable mirrors the accept condition groupRemovable applies while
// streaming rows (every event removable, and at least one event seen), so the
// table below can exercise the classification without a live database.
func allRemovable(events []eventForClose) bool {
	if len(events) == 0 {
		return false
	}
	for _, event := range events {
		if !eventRemovable(event) {
			return false
		}
	}
	return true
}

func TestGroupRemovable(t *testing.T) {
	family := "Failed to fetch dynamically imported module: https://a.com/c-Ab12.js"
	noise := "Script error."
	ordinary := "Cannot read properties of null (reading 'includes')"
	cases := []struct {
		name   string
		events []eventForClose
		want   bool
	}{
		{"all family", []eventForClose{{Platform: "javascript", Message: family}}, true},
		{"family + stackless noise", []eventForClose{{Platform: "javascript", Message: family}, {Platform: "javascript", Message: noise}}, true},
		{"mixed with ordinary NOT removable", []eventForClose{{Platform: "javascript", Message: family}, {Platform: "javascript", Message: ordinary, Stack: "at f (https://a.com/x.js:1:1)"}}, false},
		{"all ordinary NOT removable", []eventForClose{{Platform: "javascript", Message: ordinary, Stack: "at f (https://a.com/x.js:1:1)"}}, false},
		{"python event NEVER removable even with family-looking message", []eventForClose{{Platform: "python", Message: family}}, false},
		{"one python event poisons an otherwise-removable group", []eventForClose{{Platform: "javascript", Message: family}, {Platform: "python", Message: family}}, false},
		{"no events NOT removable", nil, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := allRemovable(testCase.events); got != testCase.want {
				t.Fatalf("allRemovable(%v) = %v, want %v", testCase.events, got, testCase.want)
			}
		})
	}
}
