package usageevents

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

func TestEmitNoopWhenUnconfigured(t *testing.T) {
	t.Cleanup(resetForTest)
	resetForTest()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer srv.Close()
	Emit("user_signed_up", map[string]string{"email": "a@b.c"})
	if hits.Load() != 0 || Enabled() {
		t.Fatal("unconfigured usage events must be disabled and make no request")
	}
}

func TestEmitPostsSanitizedPayload(t *testing.T) {
	t.Cleanup(resetForTest)
	resetForTest()
	body := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body <- string(b)
	}))
	defer srv.Close()
	if err := Configure(srv.URL); err != nil {
		t.Fatal(err)
	}
	Emit("needs_human_created", map[string]string{"title": "<script>\nboom & bust"})
	select {
	case b := <-body:
		for _, want := range []string{`*needs_human_created*`, `&lt;script&gt;`, `&amp;`, `boom`} {
			if !strings.Contains(b, want) {
				t.Fatalf("payload %q missing %q", b, want)
			}
		}
		if strings.Contains(b, "<script>") {
			t.Fatalf("payload not escaped: %q", b)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no request received")
	}
}

func TestConfigureRejectsBadURLAndDisables(t *testing.T) {
	t.Cleanup(resetForTest)
	resetForTest()
	if err := Configure("https://hooks.example/T/B/x"); err != nil {
		t.Fatal(err)
	}
	if err := Configure("not-a-url"); err == nil {
		t.Fatal("Configure(bad) should error")
	}
	if Enabled() {
		t.Fatal("rejected Configure must disable the package")
	}
}

func TestEmitDoesNotBlockOnSlowServer(t *testing.T) {
	t.Cleanup(resetForTest)
	resetForTest()
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	defer srv.Close()
	defer close(release)
	_ = Configure(srv.URL)
	start := time.Now()
	Emit("user_signed_up", nil)
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("Emit blocked for %v", elapsed)
	}
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}
func (b *syncBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.buf.String() }

func TestEmitNeverLogsURL(t *testing.T) {
	resetForTest()
	buf := &syncBuffer{}
	old := logger
	logger = slog.New(slog.NewTextHandler(buf, nil))
	t.Cleanup(func() { resetForTest(); logger = old })
	const secret = "https://127.0.0.1:1/services/SECRETPATH"
	_ = Configure(secret)
	Emit("user_signed_up", nil)
	inflight.Wait()
	out := buf.String()
	if !strings.Contains(out, "usage event send failed") {
		t.Fatalf("expected failure log; got %s", out)
	}
	if strings.Contains(out, "SECRETPATH") {
		t.Fatalf("log leaked webhook URL: %s", out)
	}
}

func TestTextCappedAt8000Bytes(t *testing.T) {
	t.Cleanup(resetForTest)
	resetForTest()
	body := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { b, _ := io.ReadAll(r.Body); body <- string(b) }))
	defer srv.Close()
	_ = Configure(srv.URL)
	props := map[string]string{}
	for i := 0; i < 60; i++ {
		props[fmt.Sprintf("k%02d", i)] = strings.Repeat("é", 400)
	}
	Emit("digest_delivered", props)
	select {
	case b := <-body:
		var decoded map[string]string
		if err := json.Unmarshal([]byte(b), &decoded); err != nil {
			t.Fatalf("invalid JSON: %v", err)
		}
		if got := len(decoded["text"]); got > 8000 {
			t.Fatalf("text is %d bytes", got)
		}
		if !utf8.ValidString(decoded["text"]) {
			t.Fatal("cap split a rune")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no request received")
	}
}

func TestSetSinkForTestIsSynchronous(t *testing.T) {
	t.Cleanup(resetForTest)
	resetForTest()
	_ = Configure("https://hooks.example/T/B/x")
	var got []string
	restore := SetSinkForTest(func(event string, props map[string]string) { got = append(got, event+":"+props["k"]) })
	defer restore()
	p := map[string]string{"k": "v"}
	Emit("issue_created", p)
	p["k"] = "mutated-after-emit"
	if len(got) != 1 || got[0] != "issue_created:v" {
		t.Fatalf("sink saw %v", got)
	}
}

func TestSetSinkForTestRecoversPanics(t *testing.T) {
	t.Cleanup(resetForTest)
	resetForTest()
	_ = Configure("https://hooks.example/T/B/x")
	restore := SetSinkForTest(func(string, map[string]string) { panic("boom") })
	defer restore()
	Emit("issue_created", nil)
}
