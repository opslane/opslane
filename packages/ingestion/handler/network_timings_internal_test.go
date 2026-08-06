package handler

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSanitizeNetworkTimings(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"absent", ``, `[]`},
		{"non-array container", `{"a":1}`, `[]`},
		{"non-object entry", `["x"]`, `[]`},
		{"bad transport", `[{"transport":"grpc","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"ok"}]`, `[]`},
		{"bad method", `[{"transport":"fetch","method":"get@","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"ok"}]`, `[]`},
		{"bad outcome", `[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"weird"}]`, `[]`},
		{"negative duration", `[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":-2,"outcome":"ok"}]`, `[]`},
		{"duration over cap", `[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":600001,"outcome":"ok"}]`, `[]`},
		{"control chars in url", "[{\"transport\":\"fetch\",\"method\":\"GET\",\"url\":\"https://a.test/\\u0000\",\"started_at_ms\":1,\"duration_ms\":2,\"outcome\":\"ok\"}]", `[]`},
		{"status out of range", `[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"ok","status":0}]`, `[]`},
		{"missing duration", `[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"outcome":"ok"}]`, `[]`},
		{"null started_at", `[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":null,"duration_ms":2,"outcome":"ok"}]`, `[]`},
		{"hyphenated method the SDK can emit is accepted", `[{"transport":"xhr","method":"PROPFIND-VERY-LO","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"ok"}]`, `[{"transport":"xhr","method":"PROPFIND-VERY-LO","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"ok"}]`},
		{
			"valid entry is retained and its query stripped",
			`[{"transport":"fetch","method":"get","url":"https://a.test/x?token=abc","started_at_ms":1,"duration_ms":2,"outcome":"timeout"}]`,
			`[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"timeout"}]`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := sanitizeNetworkTimings(json.RawMessage(tc.in))
			if got != tc.want {
				t.Fatalf("sanitizeNetworkTimings(%s) = %s, want %s", tc.in, got, tc.want)
			}
		})
	}
}

func TestSanitizeNetworkTimingsCapsAtTwenty(t *testing.T) {
	var entries []string
	for i := 0; i < 30; i++ {
		entries = append(entries, `{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"ok","status":200}`)
	}
	raw := "[" + strings.Join(entries, ",") + "]"

	var got []map[string]any
	if err := json.Unmarshal([]byte(sanitizeNetworkTimings(json.RawMessage(raw))), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 20 {
		t.Fatalf("retained %d entries, want 20", len(got))
	}
}
