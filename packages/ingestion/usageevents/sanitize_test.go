package usageevents

import (
	"strings"
	"testing"
)

func TestSanitizeValue(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"newlines flattened", "a\r\nb\nc", "a b c"},
		{"mrkdwn escaped", `<!channel> & <https://evil|x>`, "&lt;!channel&gt; &amp; &lt;https://evil|x&gt;"},
		{"plain preserved", "TypeError: x is undefined", "TypeError: x is undefined"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SanitizeValue(tc.in); got != tc.want {
				t.Fatalf("SanitizeValue(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestSanitizeValueTruncatesRuneSafe(t *testing.T) {
	got := SanitizeValue(strings.Repeat("é", 400))
	runes := []rune(got)
	if len(runes) != 301 || runes[len(runes)-1] != '…' {
		t.Fatalf("got %d runes ending %q, want 301 ending …", len(runes), runes[len(runes)-1])
	}
	for _, r := range got {
		if r == '�' {
			t.Fatal("truncation split a rune")
		}
	}
}
