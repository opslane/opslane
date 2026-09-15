package db

import "testing"

func TestTimelineAnchorMs(t *testing.T) {
	const timeline = `{"startTs":1000000,"lines":[
		{"t":"open","s":null,"r":"/view","a":1001000},
		{"t":"idle 30s","s":null,"r":"/view","a":1002000,"k":"idle"},
		{"t":"no time","s":null,"r":"/view","a":null},
		{"t":"click Apply","s":"#apply","r":"/view","a":1871000},
		{"t":"nothing happens","s":null,"r":"/view","a":1875000},
		{"t":"clock skew","s":null,"r":"/view","a":999000}
	]}`
	cases := []struct {
		name  string
		lines []string
		body  string
		want  int64
		ok    bool
	}{
		{"earliest cited line wins regardless of citation order", []string{"L5", "L4"}, timeline, 1871000, true},
		{"idle lines are skipped", []string{"L2", "L4"}, timeline, 1871000, true},
		{"lines without a timestamp are skipped", []string{"L3", "L5"}, timeline, 1875000, true},
		{"out-of-range and malformed ids are skipped", []string{"L0", "L99", "4", "L4x", "l4"}, timeline, 0, false},
		{"a line before startTs is raised to startTs", []string{"L6"}, timeline, 1000000, true},
		{"no citations", nil, timeline, 0, false},
		{"missing timeline", []string{"L4"}, "", 0, false},
		{"malformed timeline", []string{"L4"}, `{"lines":"nope"}`, 0, false},
		{"timeline without startTs", []string{"L1"}, `{"lines":[{"t":"x","s":null,"r":"/","a":1001000}]}`, 0, false},
		{"timeline with null startTs", []string{"L1"}, `{"startTs":null,"lines":[{"t":"x","s":null,"r":"/","a":1001000}]}`, 0, false},
		{"non-positive timestamps are skipped", []string{"L1", "L2"}, `{"startTs":1000000,"lines":[{"t":"x","s":null,"r":"/","a":-5},{"t":"y","s":null,"r":"/","a":0}]}`, 0, false},
		{"timestamps beyond 2^53 are skipped", []string{"L1", "L2"}, `{"startTs":1000000,"lines":[{"t":"x","s":null,"r":"/","a":1e300},{"t":"y","s":null,"r":"/","a":1002000}]}`, 1002000, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := timelineAnchorMs(tc.lines, []byte(tc.body))
			if got != tc.want || ok != tc.ok {
				t.Fatalf("timelineAnchorMs(%v)=(%d,%v) want (%d,%v)", tc.lines, got, ok, tc.want, tc.ok)
			}
		})
	}
}
