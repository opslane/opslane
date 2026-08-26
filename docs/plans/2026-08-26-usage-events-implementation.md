# Usage Event Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eight operator-facing usage events (signup, login, first SDK event, issue admitted, fix PR opened, needs-human, digest delivered, MCP call) posted best-effort to a single Slack incoming webhook, no-op unless `USAGE_EVENTS_SLACK_WEBHOOK` is set.

**Architecture:** Two independent fire-and-forget senders, one per runtime: a Go package `packages/ingestion/usageevents` and a worker module `packages/worker/src/usage-events.ts`. No queue, no new table except one `environments.first_event_at` column. Emission is tied to committed state transitions; delivery is best-effort (loss and rare duplicates tolerated).

**Tech Stack:** Go 1.24 (net/http, log/slog, unicode/utf8), Node 22 TypeScript (fetch, AbortSignal, TextEncoder), Postgres migration via plain SQL, Vitest, `go test`.

**Spec:** `docs/design/2026-08-26-usage-events.md` — read it first; the delivery contract and per-event anchors there govern every task.

## Global Constraints

- `USAGE_EVENTS_SLACK_WEBHOOK` unset ⇒ every emit path is a no-op; no HTTP request may ever be made (spec R1).
- Zero-throw: telemetry must never fail a request, job, or digest (spec R7). In Go every send runs in a recovered goroutine; in TS the ENTIRE emit body sits inside try/catch (even synchronous throws from a stubbed `fetch` must not escape).
- Never log the webhook URL, in any runtime, on any path (spec R6). Go network errors embed the URL in `url.Error` — log a constant string, never `err.Error()`. Same for TS fetch rejections.
- Emit only AFTER the relevant DB transaction commits, never inside it. (Non-transactional autocommit inserts count as committed once the call returns.)
- Sanitize all customer-controlled text: CR/LF → space, escape `&` `<` `>`, per-value truncation at 300 runes/code points (never splitting a rune or surrogate pair). The assembled message TEXT is capped at 8000 UTF-8 bytes at a rune boundary before JSON encoding; JSON escaping may push the wire payload slightly above that, which is fine (Slack's limit is far higher) — the cap bounds abuse, it is not a wire contract.
- Server-side ESM + strict TypeScript; `unknown` + narrowing, never `any`. Vitest tests colocated in `__tests__`.
- New Go package license: AGPL-3.0-only (server side); do NOT put any of this in `shared/` (MIT boundary).
- Migrations must be re-runnable: `IF NOT EXISTS` / idempotent UPDATE (CI replays all migrations).
- Test determinism: cross-package tests never assert against a live goroutine race. `usageevents.SetSinkForTest` (Task 1) makes emits synchronous and capturable; use it everywhere outside the `usageevents` package itself.
- Go test runs: `set -o pipefail` before any piped `go test`; gate on skips with `-v` output plus `if grep -q -- '--- SKIP:' <log>; then exit 1; fi` (non-`-v` output does not reliably print skips, and `grep -c` exits 1 on a zero count). Export the full AGENTS.md worktree env block (DATABASE_URL AND the MinIO/replay variables) first — without the storage vars ~30 tests skip while reporting `ok`.

---

### Task 1: Go `usageevents` package

**Files:**
- Create: `packages/ingestion/usageevents/usageevents.go`
- Create: `packages/ingestion/usageevents/sanitize.go`
- Test: `packages/ingestion/usageevents/usageevents_test.go`
- Test: `packages/ingestion/usageevents/sanitize_test.go`

**Interfaces:**
- Consumes: nothing (leaf package; the env read happens in main.go in Task 7).
- Produces, used by every later ingestion task:
  - `Configure(webhookURL string) error` — validates; on error the package becomes/stays DISABLED (a bad value never leaves a previous good value active).
  - `Enabled() bool`
  - `Emit(event string, props map[string]string)` — copies `props` before returning; never blocks; never panics.
  - `SanitizeValue(s string) string`
  - `SetSinkForTest(fn func(event string, props map[string]string)) (restore func())` — test seam: when set, `Emit` calls `fn` synchronously (after the no-op gate and props copy) instead of sending HTTP. The sink call is wrapped in `recover()` so a panicking test sink cannot break the caller (zero-throw holds even under the seam); sinks must not block. `restore` reverts BOTH the sink and the webhook configuration to their prior values, so a test's `Configure` cannot leak into later tests and send real HTTP.

- [ ] **Step 1: Write the failing tests**

`packages/ingestion/usageevents/sanitize_test.go`:

```go
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
	in := strings.Repeat("é", 400)
	got := SanitizeValue(in)
	runes := []rune(got)
	if len(runes) != 301 { // 300 kept + "…"
		t.Fatalf("got %d runes, want 301", len(runes))
	}
	if runes[len(runes)-1] != '…' {
		t.Fatalf("truncated value must end with …, got %q", string(runes[len(runes)-1]))
	}
	for _, r := range got {
		if r == '�' {
			t.Fatal("truncation split a rune")
		}
	}
}
```

`packages/ingestion/usageevents/usageevents_test.go`:

```go
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
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
	}))
	defer srv.Close()
	Emit("user_signed_up", map[string]string{"email": "a@b.c"})
	// Unconfigured Emit returns before spawning anything; no wait needed.
	if hits.Load() != 0 {
		t.Fatalf("expected 0 requests, got %d", hits.Load())
	}
	if Enabled() {
		t.Fatal("Enabled() must be false when unconfigured")
	}
}

func TestEmitPostsSanitizedPayload(t *testing.T) {
	t.Cleanup(resetForTest)
	resetForTest()
	body := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body <- string(b)
	}))
	defer srv.Close()
	if err := Configure(srv.URL); err != nil {
		t.Fatalf("Configure: %v", err)
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
		t.Fatalf("good Configure: %v", err)
	}
	if err := Configure("not-a-url"); err == nil {
		t.Fatal("Configure(bad) should error")
	}
	if Enabled() {
		t.Fatal("a rejected Configure must disable the package, not keep the old URL")
	}
}

func TestEmitDoesNotBlockOnSlowServer(t *testing.T) {
	t.Cleanup(resetForTest)
	resetForTest()
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer srv.Close()
	defer close(release)
	_ = Configure(srv.URL)
	start := time.Now()
	Emit("user_signed_up", nil)
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("Emit blocked for %v", elapsed)
	}
}

// syncBuffer makes the log target race-safe: the send goroutine writes while
// the test reads.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestEmitNeverLogsURL(t *testing.T) {
	resetForTest() // drains any prior sends BEFORE the logger swap
	buf := &syncBuffer{}
	old := logger
	logger = slog.New(slog.NewTextHandler(buf, nil))
	t.Cleanup(func() {
		resetForTest() // drain again before restoring the logger
		logger = old
	})
	const secret = "https://127.0.0.1:1/services/SECRETPATH"
	_ = Configure(secret) // unroutable: the send fails fast
	Emit("user_signed_up", nil)
	inflight.Wait() // deterministic: the failure log has been written by now
	out := buf.String()
	if !strings.Contains(out, "usage event send failed") {
		t.Fatalf("expected the failure log line; got: %s", out)
	}
	if strings.Contains(out, "SECRETPATH") {
		t.Fatalf("log output leaked the webhook URL: %s", out)
	}
}

func TestTextCappedAt8000Bytes(t *testing.T) {
	t.Cleanup(resetForTest)
	resetForTest()
	body := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body <- string(b)
	}))
	defer srv.Close()
	_ = Configure(srv.URL)
	props := map[string]string{}
	for i := 0; i < 60; i++ { // 60 × ~300 runes ≫ 8000 bytes
		props[fmt.Sprintf("k%02d", i)] = strings.Repeat("é", 400)
	}
	Emit("digest_delivered", props)
	select {
	case b := <-body:
		var decoded map[string]string
		if err := json.Unmarshal([]byte(b), &decoded); err != nil {
			t.Fatalf("payload is not valid JSON (mid-rune cut?): %v", err)
		}
		if got := len(decoded["text"]); got > 8000 {
			t.Fatalf("text is %d bytes, cap is 8000", got)
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
	restore := SetSinkForTest(func(event string, props map[string]string) {
		got = append(got, event+":"+props["k"])
	})
	defer restore()
	p := map[string]string{"k": "v"}
	Emit("issue_created", p)
	p["k"] = "mutated-after-emit"
	if len(got) != 1 || got[0] != "issue_created:v" {
		t.Fatalf("sink saw %v; props must be copied before Emit returns", got)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/ingestion && go test ./usageevents/...`
Expected: FAIL to compile ("undefined: SanitizeValue", "undefined: Emit").

- [ ] **Step 3: Implement the package**

`packages/ingestion/usageevents/sanitize.go`:

```go
package usageevents

import "strings"

const maxValueRunes = 300

// SanitizeValue makes one customer-controlled value safe for Slack mrkdwn:
// newlines cannot create fake fields, <...> cannot become links or mentions,
// and truncation never splits a rune.
func SanitizeValue(s string) string {
	s = strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ").Replace(s)
	s = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
	runes := []rune(s)
	if len(runes) > maxValueRunes {
		s = string(runes[:maxValueRunes]) + "…"
	}
	return s
}
```

`packages/ingestion/usageevents/usageevents.go`:

```go
// Package usageevents posts operator-facing product usage events to a Slack
// incoming webhook. Delivery is best-effort: zero-throw, 2s timeout, no
// retries, bounded concurrency. Unconfigured (the default) it is a no-op, so
// self-hosted installs emit nothing unless the operator opts in.
package usageevents

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	sendTimeout     = 2 * time.Second
	maxConcurrent   = 8
	maxTextBytes    = 8000
)

var (
	mu         sync.RWMutex
	webhookURL string
	sink       func(event string, props map[string]string) // test seam; nil in production
	sem        = make(chan struct{}, maxConcurrent)
	inflight   sync.WaitGroup // lets tests drain sends before swapping logger/config
	client     = &http.Client{Timeout: sendTimeout}
	logger     = slog.Default()
)

// Configure validates and stores the webhook URL. On error the package is
// left DISABLED (any previously configured URL is cleared) so a bad value can
// never silently keep stale configuration alive. The URL is never logged.
func Configure(raw string) error {
	mu.Lock()
	defer mu.Unlock()
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		webhookURL = ""
		return fmt.Errorf("usage events webhook URL is not a valid http(s) URL")
	}
	webhookURL = raw
	return nil
}

func Enabled() bool {
	mu.RLock()
	defer mu.RUnlock()
	return webhookURL != ""
}

// Emit posts one usage event. It never blocks the caller, never returns an
// error, and is a no-op when unconfigured. props is copied before Emit
// returns, so callers may reuse or mutate their map afterwards.
func Emit(event string, props map[string]string) {
	mu.RLock()
	target := webhookURL
	testSink := sink
	mu.RUnlock()
	if target == "" {
		return
	}
	copied := make(map[string]string, len(props))
	for k, v := range props {
		copied[k] = v
	}
	if testSink != nil {
		func() {
			defer func() { _ = recover() }() // zero-throw holds under the seam too
			testSink(event, copied)
		}()
		return
	}
	select {
	case sem <- struct{}{}:
	default:
		logger.Warn("usage event dropped: send queue full", "event", event)
		return
	}
	inflight.Add(1)
	go func() {
		defer inflight.Done()
		defer func() { <-sem }()
		defer func() {
			if r := recover(); r != nil {
				logger.Warn("usage event send panicked", "event", event)
			}
		}()
		send(target, event, copied)
	}()
}

func send(target, event string, props map[string]string) {
	var b strings.Builder
	fmt.Fprintf(&b, "*%s*", SanitizeValue(event))
	keys := make([]string, 0, len(props))
	for k := range props {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, "\n%s=%s", k, SanitizeValue(props[k]))
	}
	text := b.String()
	if len(text) > maxTextBytes {
		cut := maxTextBytes
		for cut > 0 && !utf8.RuneStart(text[cut]) {
			cut--
		}
		text = text[:cut]
	}
	body, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		logger.Warn("usage event marshal failed", "event", event)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		logger.Warn("usage event request build failed", "event", event)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		// Constant string on purpose: url.Error embeds the webhook URL.
		logger.Warn("usage event send failed", "event", event)
		return
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		logger.Warn("usage event rejected", "event", event, "status", resp.StatusCode)
	}
}

// SetSinkForTest replaces HTTP delivery with a synchronous callback. TEST
// SUPPORT ONLY: downstream packages use it for deterministic emit assertions.
// The returned func restores BOTH the previous sink and the previous webhook
// configuration, so a test's Configure cannot leak real HTTP into later tests.
func SetSinkForTest(fn func(event string, props map[string]string)) func() {
	mu.Lock()
	prevSink, prevURL := sink, webhookURL
	sink = fn
	mu.Unlock()
	return func() {
		mu.Lock()
		sink, webhookURL = prevSink, prevURL
		mu.Unlock()
	}
}

// resetForTest drains in-flight sends, then clears configuration and sink;
// same-package tests only. Draining first means no old goroutine can touch a
// swapped logger or trip the race detector after reset returns. Sends are
// bounded by the 2s client timeout, so the wait is bounded too.
func resetForTest() {
	inflight.Wait()
	mu.Lock()
	webhookURL = ""
	sink = nil
	mu.Unlock()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/ingestion && go test ./usageevents/... && go vet ./usageevents/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/usageevents/
git commit -m "feat(ingestion): usageevents package — best-effort operator Slack notifications"
```

---

### Task 2: Worker `usage-events.ts`

**Files:**
- Create: `packages/worker/src/usage-events.ts`
- Test: `packages/worker/src/__tests__/usage-events.test.ts`

**Interfaces:**
- Consumes: `logger` from `./logger.js` (existing: `logger.warn(message, fields?)`).
- Produces: `emitUsageEvent(event: string, props: Record<string, string>): void` and `sanitizeValue(s: string): string`. Task 8 imports `emitUsageEvent` from `'./usage-events.js'`.

- [ ] **Step 1: Write the failing tests**

`packages/worker/src/__tests__/usage-events.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitUsageEvent, sanitizeValue } from '../usage-events.js';

describe('sanitizeValue', () => {
  it('flattens newlines and escapes mrkdwn', () => {
    expect(sanitizeValue('a\r\nb\nc')).toBe('a b c');
    expect(sanitizeValue('<!channel> & <x|y>')).toBe('&lt;!channel&gt; &amp; &lt;x|y&gt;');
  });

  it('truncates without splitting surrogate pairs', () => {
    const out = sanitizeValue('😀'.repeat(400));
    expect([...out].length).toBe(301); // 300 kept + ellipsis
    expect(out.endsWith('…')).toBe(true);
    expect(out.includes('�')).toBe(false);
  });
});

describe('emitUsageEvent', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['USAGE_EVENTS_SLACK_WEBHOOK'];
  });

  it('is a no-op when the env var is unset', () => {
    emitUsageEvent('fix_pr_opened', { project: 'p' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs a sanitized payload when configured', async () => {
    process.env['USAGE_EVENTS_SLACK_WEBHOOK'] = 'https://hooks.example/T/B/x';
    emitUsageEvent('needs_human_created', { title: '<a>\nb' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hooks.example/T/B/x');
    const body = JSON.parse((init as RequestInit).body as string) as { text: string };
    expect(body.text).toContain('*needs_human_created*');
    expect(body.text).toContain('&lt;a&gt; b');
    expect(body.text).not.toContain('<a>');
  });

  it('never throws when fetch rejects asynchronously', async () => {
    process.env['USAGE_EVENTS_SLACK_WEBHOOK'] = 'https://hooks.example/T/B/x';
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED https://hooks.example/T/B/x'));
    expect(() => emitUsageEvent('fix_pr_opened', {})).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  });

  it('never throws when fetch throws synchronously', () => {
    process.env['USAGE_EVENTS_SLACK_WEBHOOK'] = 'https://hooks.example/T/B/x';
    fetchMock.mockImplementation(() => {
      throw new Error('sync boom https://hooks.example/T/B/x');
    });
    expect(() => emitUsageEvent('fix_pr_opened', {})).not.toThrow();
  });

  it('caps the text at 8000 UTF-8 bytes and keeps the event line', async () => {
    process.env['USAGE_EVENTS_SLACK_WEBHOOK'] = 'https://hooks.example/T/B/x';
    const props: Record<string, string> = {};
    for (let i = 0; i < 60; i++) props[`k${String(i).padStart(2, '0')}`] = 'é'.repeat(400);
    emitUsageEvent('digest_delivered', props);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    ) as { text: string };
    expect(new TextEncoder().encode(body.text).length).toBeLessThanOrEqual(8000);
    expect(body.text.startsWith('*digest_delivered*')).toBe(true); // trim drops trailing lines, never the event line
    expect(body.text.includes('�')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/worker && npx vitest run src/__tests__/usage-events.test.ts`
Expected: FAIL ("Cannot find module '../usage-events.js'").

- [ ] **Step 3: Implement**

`packages/worker/src/usage-events.ts`:

```ts
// Best-effort operator usage notifications. Mirrors the Go
// packages/ingestion/usageevents contract: no-op when unconfigured,
// zero-throw, 2s timeout, no retries. Deliberately duplicated instead of
// shared/ (that boundary is MIT; this is server-side AGPL code).
import { logger } from './logger.js';

const MAX_VALUE_CODEPOINTS = 300;
const MAX_TEXT_BYTES = 8000;

export function sanitizeValue(s: string): string {
  const flat = s.replace(/\r\n|\r|\n/g, ' ');
  const escaped = flat
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const points = [...escaped];
  if (points.length > MAX_VALUE_CODEPOINTS) {
    return points.slice(0, MAX_VALUE_CODEPOINTS).join('') + '…';
  }
  return escaped;
}

export function emitUsageEvent(event: string, props: Record<string, string>): void {
  try {
    // Read per-call so tests and late configuration both work.
    const url = process.env['USAGE_EVENTS_SLACK_WEBHOOK'];
    if (!url) return;

    const lines = [`*${sanitizeValue(event)}*`];
    for (const key of Object.keys(props).sort()) {
      lines.push(`${key}=${sanitizeValue(props[key] ?? '')}`);
    }
    let text = lines.join('\n');
    // Cap the text in UTF-8 bytes without splitting a code point: values are
    // already capped at 300 code points each, so trimming whole trailing
    // lines converges fast and keeps the message well-formed.
    const enc = new TextEncoder();
    while (enc.encode(text).length > MAX_TEXT_BYTES && text.includes('\n')) {
      text = text.slice(0, text.lastIndexOf('\n'));
    }

    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(2000),
    })
      .then((res) => {
        if (!res.ok) {
          safeWarn('usage event rejected', { event, status: res.status });
        }
      })
      .catch(() => {
        // Never log the error object: fetch errors embed the webhook URL.
        safeWarn('usage event send failed', { event });
      });
  } catch {
    // Zero-throw contract: even a synchronously-throwing fetch stub, a
    // broken TextEncoder, or property access on a hostile props object must
    // not escape into the caller.
    safeWarn('usage event emit failed', { event });
  }
}

// Even the logger throwing must not escape the zero-throw contract (or turn
// a fire-and-forget promise into an unhandled rejection).
function safeWarn(message: string, fields: Record<string, unknown>): void {
  try {
    logger.warn(message, fields);
  } catch {
    // deliberately nothing
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/worker && npx vitest run src/__tests__/usage-events.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/usage-events.ts packages/worker/src/__tests__/usage-events.test.ts
git commit -m "feat(worker): usage-events module — best-effort operator Slack notifications"
```

---

### Task 3: Migration 062 + `first_event_at` claim in `CaptureError`

**Files:**
- Create: `packages/ingestion/db/migrations/062_environment_first_event.sql`
- Modify: `packages/ingestion/db/capture.go` (receipt at :14-22, tx body, commit at :136)
- Test: `packages/ingestion/db/capture_first_event_test.go`

**Interfaces:**
- Consumes: existing `CaptureError(ctx, p IngestParams) (*CaptureReceipt, error)` and `captureEnvironment` (capture.go:145) which returns `environmentID`.
- Produces: three additive `CaptureReceipt` fields: `EnvironmentID string`, `FirstEvent bool`, `EnvironmentAgeSeconds int64` (whole seconds, floor). Existing callers unaffected.

**Known scope limit (from the spec, restated so nobody "fixes" it):** the claim runs on the error-event ingest path (`POST /api/v1/events` → `CaptureError`). An environment that only ever produces session/friction data never claims `first_event_at` and never pings; that is accepted for v1 and documented in the design doc.

- [ ] **Step 1: Write the migration**

`packages/ingestion/db/migrations/062_environment_first_event.sql`:

```sql
-- Track when an environment first received an SDK event. NULL means "never".
-- The ingest path claims this once per environment (first_event_at IS NULL
-- guard) to drive the sdk_first_event_received usage event.
--
-- Backfill uses group tables, not raw event tables: retention purges raw
-- error_events/friction_events first, while groups persist and stay small.
-- Environments with no evidence keep NULL so a genuine first event still
-- registers later. Re-running this file is safe: both UPDATEs only tighten
-- or fill values.
ALTER TABLE environments ADD COLUMN IF NOT EXISTS first_event_at TIMESTAMPTZ;

-- Error evidence: error_group_environments (018) -> error_groups.
UPDATE environments e
SET first_event_at = evidence.earliest
FROM (
  SELECT ege.environment_id, MIN(g.created_at) AS earliest
  FROM error_group_environments ege
  JOIN error_groups g ON g.id = ege.error_group_id
  GROUP BY ege.environment_id
) AS evidence
WHERE e.id = evidence.environment_id
  AND e.first_event_at IS NULL;

-- Friction evidence: friction_groups carries environment_id and
-- first_seen_at directly (001_baseline.sql:379-392).
UPDATE environments e
SET first_event_at = fg.earliest
FROM (
  SELECT environment_id, MIN(first_seen_at) AS earliest
  FROM friction_groups
  GROUP BY environment_id
) AS fg
WHERE e.id = fg.environment_id
  AND (e.first_event_at IS NULL OR fg.earliest < e.first_event_at);
```

- [ ] **Step 2: Write the failing DB test**

`packages/ingestion/db/capture_first_event_test.go` — the `db` package's existing tests show the seeding style (`grep -n "CreateOrg" packages/ingestion/db/*_test.go` and copy the minimal org→project→environment setup; the package already has a `testPool`-style helper — reuse it, or copy the 15-line pattern from `notify/testhelper_test.go:13-25`). Required assertions, written as real code:

1. First `CaptureError` on a fresh environment → `receipt.FirstEvent == true`, `receipt.EnvironmentAgeSeconds >= 0`, and `environments.first_event_at IS NOT NULL` when read back.
2. Second `CaptureError` on the same environment → `receipt.FirstEvent == false`.
3. Two concurrent `CaptureError` calls (goroutines + WaitGroup) on a second fresh environment → exactly one receipt has `FirstEvent == true`.
4. Backfill convergence: run the two migration UPDATE statements (inline via `pool.Exec`) twice; assert the value after the second run equals the value after the first (the friction UPDATE may legitimately move a value EARLIER on its first run, so assert convergence, not no-op). Also assert an environment whose existing `first_event_at` is earlier than all evidence is untouched.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/ingestion && set -o pipefail && go test ./db/ -run TestCaptureErrorClaimsFirstEvent -v 2>&1 | tail -10`
Expected: FAIL to compile ("receipt.FirstEvent undefined").

- [ ] **Step 4: Implement the claim in capture.go**

Extend `CaptureReceipt` (capture.go:14):

```go
type CaptureReceipt struct {
	EventID             string
	CaptureHandle       string
	EnvironmentOutcome  EnvironmentOutcome
	EnvironmentDiverged bool
	EnvironmentID       string
	// FirstEvent is true when this capture claimed the environment's
	// first_event_at: at-most-once per environment via the IS NULL guard.
	FirstEvent bool
	// EnvironmentAgeSeconds is floor(first_event_at - created_at) in whole
	// seconds; only meaningful when FirstEvent is true.
	EnvironmentAgeSeconds int64
}
```

Inside the tx, after `captureEnvironment` returns `environmentID`, before `tx.Commit` (around capture.go:130):

```go
	var firstEvent bool
	var envAgeSeconds int64
	err = tx.QueryRow(ctx, `
		UPDATE environments
		   SET first_event_at = now()
		 WHERE id = $1 AND first_event_at IS NULL
		 RETURNING floor(EXTRACT(EPOCH FROM (first_event_at - created_at)))::bigint`,
		environmentID,
	).Scan(&envAgeSeconds)
	switch {
	case err == nil:
		firstEvent = true
	case errors.Is(err, pgx.ErrNoRows):
		// already claimed — the common case
	default:
		return nil, fmt.Errorf("claim first event: %w", err)
	}
```

Thread `EnvironmentID: environmentID, FirstEvent: firstEvent, EnvironmentAgeSeconds: envAgeSeconds` into the returned receipt at capture.go:139.

- [ ] **Step 5: Run tests, verify pass, run the full db package**

Run (with the full AGENTS.md env block exported): `cd packages/ingestion && set -o pipefail && go test ./db/... -v 2>&1 | tee /tmp/dbtest.log | tail -5 ; if grep -q -- '--- SKIP:' /tmp/dbtest.log; then echo 'SKIPPED TESTS'; exit 1; fi`
Expected: PASS; skip count explained (0, or only pre-existing storage skips if MinIO env is absent — with the block exported it must be 0).

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/db/migrations/062_environment_first_event.sql packages/ingestion/db/capture.go packages/ingestion/db/capture_first_event_test.go
git commit -m "feat(ingestion): claim environments.first_event_at in CaptureError (migration 062 + backfill)"
```

---

### Task 4: Auth events — `created` flag + signup/login emits

**Files:**
- Modify: `packages/ingestion/db/queries.go` (`ProvisionFromIdentity` :2532, `ProvisionFromIdentityTx` :2552)
- Modify: `packages/ingestion/handler/embedded_auth.go` (`completeEmbeddedLogin` :35, callers `PasswordLogin` :139/:166, `Signup` :168/:216, `VerifyEmail` :249)
- Modify: `packages/ingestion/handler/github_oauth.go` (`completeOAuthIdentity` :415/:429, legacy `provisionGitHubIdentityContext` :523/:541-570)
- Test: `packages/ingestion/db/provision_created_test.go`, `packages/ingestion/handler/auth_usage_events_test.go`

**Interfaces:**
- Consumes: `usageevents.Emit`, `usageevents.SetSinkForTest` (Task 1).
- Produces — **breaking signature changes, all callers updated in this task**:
  - `ProvisionFromIdentity(ctx, identity) (userID, orgID string, created bool, err error)`
  - `ProvisionFromIdentityTx(ctx, tx, identity) (userID, orgID string, created bool, err error)` (set `created = true` in the new-user branch at queries.go:2612)
  - `completeEmbeddedLogin(w, r, identity, flow string)` with flow ∈ {"login", "signup", "verify"}.

- [ ] **Step 1: Write the failing DB test**

`packages/ingestion/db/provision_created_test.go` — real code in the seeding style of `auth_identities_test.go:22`:

1. Provision a brand-new identity → `created == true`.
2. Provision the same identity again → `created == false`, same `userID`.

- [ ] **Step 2: Write the failing handler test**

`packages/ingestion/handler/auth_usage_events_test.go` — the handler package has existing auth-flow tests (`grep -ln "PasswordLogin\|Signup(" packages/ingestion/handler/*_test.go` for the scaffolding). Capture emits with the synchronous sink:

```go
	var events []string
	restore := usageevents.SetSinkForTest(func(event string, props map[string]string) {
		events = append(events, event)
	})
	t.Cleanup(restore)
	// usageevents must be Configure()d for Emit to pass the enabled gate:
	if err := usageevents.Configure("https://hooks.example/T/B/x"); err != nil { t.Fatal(err) }
```

Required behaviors:
1. Fresh signup through the `Signup` handler → exactly `["user_signed_up"]`, no `user_logged_in`.
2. Login of that same user through `PasswordLogin` → appends exactly `["user_logged_in"]`.
3. `VerifyEmail` for an existing user → appends nothing.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/ingestion && set -o pipefail && go test ./db/ -run TestProvisionFromIdentityCreated -v 2>&1 | tail -5`
Expected: FAIL to compile (wrong arity).

- [ ] **Step 4: Implement the signature change and embedded-auth emits**

`ProvisionFromIdentityTx`: `created` is true exactly when the `if userID == ""` branch at queries.go:2612 runs. Update both functions' returns; fix every caller (`grep -rn "ProvisionFromIdentity" packages/ingestion --include="*.go" | grep -v _test`); callers that don't care take `_`.

`completeEmbeddedLogin` (embedded_auth.go:35): `ProvisionFromIdentity` commits internally (queries.go:2545), so emitting right after it returns is post-commit:

```go
func (d *Dependencies) completeEmbeddedLogin(w http.ResponseWriter, r *http.Request, identity auth.Identity, flow string) {
	...
	userID, orgID, created, err := d.Queries.ProvisionFromIdentity(r.Context(), identity)
	if err != nil { ...existing error handling unchanged... }
	if created {
		usageevents.Emit("user_signed_up", map[string]string{
			"email": identity.Email, "provider": identity.Provider,
			"user_id": userID, "org_id": orgID,
		})
	} else if flow == "login" {
		usageevents.Emit("user_logged_in", map[string]string{
			"email": identity.Email, "user_id": userID, "org_id": orgID,
		})
	}
}
```

Placement: put the emit block at the END of `completeEmbeddedLogin`, AFTER `issueTokenPairCookie` (embedded_auth.go:51) — still post-commit, and a failure while issuing the session no longer reports a login that never completed. (For `created`, the user row exists either way; keeping both emits at the same site is simpler and the signup case is accurate regardless.)

Callers pass `"login"` (PasswordLogin :166), `"signup"` (Signup :216), `"verify"` (VerifyEmail). Before coding, open `packages/ingestion/auth/provider.go` and use the REAL field names on `auth.Identity` for email/provider — if they differ from `identity.Email`/`identity.Provider`, use what exists.

Verification-gated flows: if the configured embedded provider defers provisioning to email verification, `created == true` fires during `VerifyEmail` instead of `Signup` — which is correct: the `created` flag, not the handler, decides `user_signed_up`. Write the handler test against whichever flow the EXISTING embedded-auth tests exercise (read them first); the required invariants are (a) exactly one `user_signed_up` per new user regardless of which handler completes provisioning, (b) `user_logged_in` only from the `"login"` flow, (c) `VerifyEmail`/`"verify"` never emits `user_logged_in`.

- [ ] **Step 5: Wire the OAuth paths**

`completeOAuthIdentity` cloud branch (github_oauth.go:429): now receives `created`; emit `user_signed_up` when true, else `user_logged_in` (the browser OAuth callback is an interactive login; the CLI flow branch at :451 must NOT emit `user_logged_in` — machine auth). Legacy path (`provisionGitHubIdentityContext`, :541-570): `CreateUserGitHub` runs in autocommit (no surrounding tx — queries.go:2733 uses `q.pool.QueryRow` directly), so emitting immediately after it returns successfully satisfies the post-commit rule; emit `user_signed_up` there, and `user_logged_in` on the `existing != nil` path when the flow is the browser callback.

- [ ] **Step 6: Run tests and build**

Run: `cd packages/ingestion && go build ./... && set -o pipefail && go test ./db/ ./handler/ -v 2>&1 | tee /tmp/authtest.log | tail -5 ; if grep -q -- '--- SKIP:' /tmp/authtest.log; then echo 'SKIPPED TESTS'; exit 1; fi`
Expected: PASS including every pre-existing auth test at the new arity.

- [ ] **Step 7: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/db/provision_created_test.go packages/ingestion/handler/embedded_auth.go packages/ingestion/handler/github_oauth.go packages/ingestion/handler/auth_usage_events_test.go
git commit -m "feat(ingestion): user_signed_up / user_logged_in usage events via provisioning created flag"
```

---

### Task 5: `sdk_first_event_received` emit in the ingest handler

**Files:**
- Modify: `packages/ingestion/handler/error_event.go` (after the `CaptureError` call at :250)
- Test: `packages/ingestion/handler/error_event_first_event_test.go`

**Interfaces:**
- Consumes: `CaptureReceipt.FirstEvent`, `.EnvironmentID`, `.EnvironmentAgeSeconds` (Task 3); `usageevents.Emit` + `SetSinkForTest` (Task 1). Use ONLY identifiers already in scope in the handler (`projectID`, the request's environment name); do NOT add a DB query to the hot ingest path.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

`packages/ingestion/handler/error_event_first_event_test.go` — reuse the ingest scaffolding from `handler/error_event_test.go`. With the synchronous sink installed (as in Task 4 Step 2): POST one event for a fresh environment → exactly one captured emit, event `sdk_first_event_received`, props containing `project_id` and `environment_age_s`; POST a second event → no further emits.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ingestion && set -o pipefail && go test ./handler/ -run FirstEvent -v 2>&1 | tail -5`
Expected: FAIL (no emit yet).

- [ ] **Step 3: Implement the emit**

In `error_event.go` immediately after the successful `CaptureError` return (:250):

```go
	if receipt.FirstEvent {
		usageevents.Emit("sdk_first_event_received", map[string]string{
			"project_id":        projectID,
			"environment_id":    receipt.EnvironmentID,
			"environment_age_s": strconv.FormatInt(receipt.EnvironmentAgeSeconds, 10),
		})
	}
```

(Add the environment NAME only if the handler already holds it in a local; check the surrounding function — `EnvironmentIDFromCtx` is set by middleware at project_keys.go:66, and the request payload may carry the name. Do not query for it.)

- [ ] **Step 4: Run tests**

Run: `cd packages/ingestion && set -o pipefail && go test ./handler/ -v 2>&1 | tee /tmp/htest.log | tail -5 ; if grep -q -- '--- SKIP:' /tmp/htest.log; then echo 'SKIPPED TESTS'; exit 1; fi`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/error_event.go packages/ingestion/handler/error_event_first_event_test.go
git commit -m "feat(ingestion): sdk_first_event_received usage event on first environment event"
```

---

### Task 6: `issue_created` at filter admission + `digest_delivered` at dispatcher success

**Files:**
- Modify: `packages/ingestion/filter/dispatch.go` (`Dispatcher` struct :27, its constructor, `admitOne` tail)
- Modify: `packages/ingestion/main.go` (thread `queries.DashboardURL` into the filter dispatcher constructor)
- Modify: `packages/ingestion/notify/dispatcher.go` (`deliverClaim` :360-411, `finishClaim` :414)
- Test: `packages/ingestion/filter/dispatch_usage_event_test.go`, `packages/ingestion/notify/dispatcher_usage_event_test.go`

**Interfaces:**
- Consumes: `usageevents.Emit` + `SetSinkForTest`; `notify.BuildIncidentURL(dashboardURL, errorGroupID, projectID) string` (url.go:10). Import direction `filter → notify` is safe: notify imports no opslane packages (dispatcher.go imports only pgx/stdlib; db imports notify, not the reverse), so no cycle.
- Produces:
  - `filter.Dispatcher` gains a `dashboardURL string` field set by its constructor (find the constructor with `grep -n "func New" packages/ingestion/filter/*.go`; add the parameter and update EVERY call site — `grep -rn "filter.New\|NewDispatcher" packages/ingestion --include="*.go"` — including test and fixture constructions, not just main.go).
  - `finishClaim` signature becomes `finishClaim(ctx, claim, projectID, destType string, payload *EventPayload, outcome Outcome, metricRecorded bool)`. ALL NINE call sites update (dispatcher.go :366, :379, :383, :387, :391, :397, :402, :407, :411): pass `nil` at the eight early-exit sites, pass the decoded `payload` at the :411 success site (it is decoded before :407's `event_payload_invalid` check, so it is in scope there).

Per-destination semantics are the spec's documented contract ("one message per (run, destination)") — do not dedupe across destinations.

- [ ] **Step 1: Write the failing tests**

`filter/dispatch_usage_event_test.go`: seed an admitted episode the way `filter/evaluate_test.go` seeds them (same `testPool(t)` pattern), install the synchronous sink, run one dispatcher tick → exactly one `issue_created` emit whose props include `issue_id` and a `url` only when a dashboard URL was configured; run the tick again → no additional emit (ON CONFLICT path).

`notify/dispatcher_usage_event_test.go`: copy the seeding from `dispatcher_db_test.go` (outbound event + destination + delivery row); use `event_type='digest.daily'` and a payload JSON with `{"version":1,"event_type":"digest.daily","run_id":"r1","project":{"id":"p1","name":"Acme"},"digest":{"date":"2026-08-26","top_new_issues":[],"needs_human_backlog":3, ...minimum valid fields...}}`; stub the sender to report delivered (the dispatcher tests already show how the sender is injected via `NewSender`/interface — follow them); run the loop once → exactly one `digest_delivered` emit with `project_id=p1` and `needs_human_backlog=3`. Also: a `retry` outcome → no emit.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/ingestion && set -o pipefail && go test ./filter/ ./notify/ -run UsageEvent -v 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement `issue_created`**

`admitOne` tail (filter/dispatch.go):

```go
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit filter admission: %w", err)
	}
	admitted := tag.RowsAffected() == 1
	if admitted {
		props := map[string]string{
			"project_id": projectID,
			"issue_id":   issueID,
			"episode_id": episodeID,
		}
		if url := notify.BuildIncidentURL(d.dashboardURL, issueID, projectID); url != "" {
			props["url"] = url
		}
		usageevents.Emit("issue_created", props)
	}
	return admitted, nil
}
```

No title prop: nothing in `admitOne`'s scope has it, and this path must not gain a SELECT for cosmetics — the URL takes the reader to the titled incident.

- [ ] **Step 4: Implement `digest_delivered`**

Change `finishClaim` per the Interfaces block; inside it, after `updated, err := d.complete(...)`:

```go
	if err == nil && updated && outcome.Class == "delivered" &&
		payload != nil && payload.EventType == "digest.daily" {
		props := map[string]string{
			"project_id":   projectID,
			"project_name": payload.Project.Name,
			"run_id":       payload.RunID,
		}
		if payload.Digest != nil {
			props["date"] = payload.Digest.Date
			props["new_issues"] = strconv.Itoa(len(payload.Digest.TopNewIssues))
			props["needs_human_backlog"] = strconv.Itoa(payload.Digest.NeedsHumanBacklog)
		}
		usageevents.Emit("digest_delivered", props)
	}
```

- [ ] **Step 5: Run tests**

Run: `cd packages/ingestion && go build ./... && set -o pipefail && go test ./filter/ ./notify/ -v 2>&1 | tee /tmp/fntest.log | tail -5 ; if grep -q -- '--- SKIP:' /tmp/fntest.log; then echo 'SKIPPED TESTS'; exit 1; fi`
Expected: PASS; every pre-existing dispatcher contract test green.

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/filter/dispatch.go packages/ingestion/notify/dispatcher.go packages/ingestion/main.go packages/ingestion/filter/dispatch_usage_event_test.go packages/ingestion/notify/dispatcher_usage_event_test.go
git commit -m "feat(ingestion): issue_created and digest_delivered usage events"
```

---

### Task 7: `mcp_tool_used` wrapper + startup wiring

**Files:**
- Modify: `packages/ingestion/handler/mcp.go` (`registerMCPTools` :92)
- Modify: `packages/ingestion/main.go` (next to the `DASHBOARD_URL` read at :150)
- Test: `packages/ingestion/handler/mcp_usage_event_test.go`

**Interfaces:**
- Consumes: `usageevents` (Task 1); `ProjectIDFromCtx`/`OrgIDFromCtx`. The ctx reaching each tool handler already carries both (existing handlers read `ProjectIDFromCtx(ctx)` at mcp.go:99/:135/:161 — the `mcpProjectContext` middleware at :196 installs them on the request context the SDK threads through), so a wrapper around the handler func sees the same values. `result.IsError` is a real field on this SDK's `CallToolResult` (set at mcp.go:185).
- Produces: unexported generic helper in mcp.go:

```go
func trackTool[In, Out any](
	name string,
	h func(context.Context, *mcpsdk.CallToolRequest, In) (*mcpsdk.CallToolResult, Out, error),
) func(context.Context, *mcpsdk.CallToolRequest, In) (*mcpsdk.CallToolResult, Out, error) {
	return func(ctx context.Context, req *mcpsdk.CallToolRequest, in In) (*mcpsdk.CallToolResult, Out, error) {
		res, out, err := h(ctx, req, in)
		if err == nil && res != nil && !res.IsError {
			usageevents.Emit("mcp_tool_used", map[string]string{
				"tool": name, "project_id": ProjectIDFromCtx(ctx), "org_id": OrgIDFromCtx(ctx),
			})
		}
		return res, out, err
	}
}
```

- [ ] **Step 1: Write the failing test**

`handler/mcp_usage_event_test.go`: copy the live-session scaffolding from `mcp_digest_test.go:70` (`session.CallTool(ctx, &mcpsdk.CallToolParams{Name: "opslane_digest"})`), install the synchronous sink + `Configure`. One successful `opslane_digest` call → exactly one `mcp_tool_used` emit with `tool=opslane_digest` and a non-empty `project_id`. One failing `opslane_issue` call (garbage ID → the handler sets `IsError`, mcp.go:185) → no additional emit.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ingestion && set -o pipefail && go test ./handler/ -run McpUsageEvent -v 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement**

Wrap the three handler funcs at their `mcpsdk.AddTool` sites (mcp.go:95, :126, :152): `trackTool("opslane_digest", func(...){...})`. Then startup wiring in main.go next to :150:

```go
	if raw := os.Getenv("USAGE_EVENTS_SLACK_WEBHOOK"); raw != "" {
		if err := usageevents.Configure(raw); err != nil {
			slog.Error("usage events disabled: invalid USAGE_EVENTS_SLACK_WEBHOOK") // never the value
		}
	}
	slog.Info("usage events", "enabled", usageevents.Enabled())
```

- [ ] **Step 4: Run tests**

Run: `cd packages/ingestion && go build ./... && set -o pipefail && go test ./handler/ -run Mcp -v 2>&1 | tail -5`
Expected: PASS, existing MCP tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/mcp.go packages/ingestion/handler/mcp_usage_event_test.go packages/ingestion/main.go
git commit -m "feat(ingestion): mcp_tool_used usage event + startup wiring for USAGE_EVENTS_SLACK_WEBHOOK"
```

---

### Task 8: Worker events — `needs_human_created` and `fix_pr_opened`

**Files:**
- Modify: `packages/worker/src/db.ts` (`updateGroupStatus` :1206 / its UPDATE :1289-1325; check `updateGroupInvestigation` :2758)
- Modify: `packages/worker/src/pipeline.ts` (success return path :365-376)
- Modify: `packages/worker/src/index.ts` (startup enabled/disabled log near :154-166)
- Test: `packages/worker/src/__tests__/usage-events-emits.test.ts`

**Interfaces:**
- Consumes: `emitUsageEvent` (Task 2). The UPDATE's inner CTE ALREADY returns `prior.previous_status` (`RETURNING g.id, prior.previous_status`, db.ts:1325); only the outer statement changes from `SELECT id FROM updated_group` to `SELECT id, previous_status FROM updated_group`.
- Produces: no signature changes.

- [ ] **Step 1: Write the failing tests**

`packages/worker/src/__tests__/usage-events-emits.test.ts` — mock `../usage-events.js` with `vi.mock` (as `index.test.ts:7` mocks `../db.js`), and mock the pool the way db.ts's existing tests do (`grep -rn "getPool" packages/worker/src/__tests__/ | head` for the pattern). Required assertions, written as real code with `vi.clearAllMocks()` in `beforeEach`:

1. `updateGroupStatus(..., 'needs_human', {reason})` where the mocked query returns `previous_status: 'investigating'` → `emitUsageEvent` called exactly once with `'needs_human_created'` and props containing `error_group_id`, `project_id`, `reason`.
2. Same call, mocked `previous_status: 'needs_human'` → NOT called (spec R4: retry/lease recovery does not re-emit).
3. `updateGroupStatus(..., 'resolved')` → NOT called.
4. Pipeline: with `createPR` mocked to `{ status: 'created', prUrl: 'https://github.com/o/r/pull/1', prNumber: 1 }` → one `'fix_pr_opened'` emit with `pr_url` and `draft:'false'`; with `deliveryPosture` driving `pr_draft` → emit has `draft:'true'`. (Emit fires for BOTH postures; `draft` distinguishes.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/worker && npx vitest run src/__tests__/usage-events-emits.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `needs_human_created` in `updateGroupStatus`**

Change the outer `SELECT id FROM updated_group` (end of statement, db.ts:1325 area) to `SELECT id, previous_status FROM updated_group`. After the existing row-count/lease checks pass:

```ts
  const previousStatus = rows[0]?.previous_status as string | undefined;
  if (status === 'needs_human' && previousStatus !== 'needs_human') {
    emitUsageEvent('needs_human_created', {
      error_group_id: errorGroupId,
      project_id: projectId,
      reason: fields?.reason ?? '',
      url: incidentUrlFor(errorGroupId, projectId),
    });
  }
```

Do NOT import `buildIncidentUrl` from pipeline.ts into db.ts — pipeline consumes db functions, so that import would be circular. Instead add a tiny local helper in `usage-events.ts` (dependency-neutral: it imports only `logger`) and import `incidentUrlFor` from there:

```ts
// usage-events.ts — mirror of the Go notify.BuildIncidentURL shape, minimal:
export function incidentUrlFor(errorGroupId: string, projectId: string): string {
  const base = process.env['DASHBOARD_URL'];
  if (!base || !/^https?:\/\//.test(base)) return '';
  return `${base.replace(/\/+$/, '')}/incidents/${encodeURIComponent(errorGroupId)}?project_id=${encodeURIComponent(projectId)}`;
}
```

(Check the path shape against the Go builder `notify/url.go:10` output — the URL format `/incidents/<group>?project_id=<project>` is what its test at `notify/url_test.go` asserts; keep them identical.) No project-name or title lookup here: `updateGroupStatus` runs under lease timing constraints and must not gain a DB read; IDs + URL satisfy the spec's ID-fallback clause.

Then read `updateGroupInvestigation` (db.ts:2758): if its UPDATE can set `needs_human`, apply the identical previous-status-guarded emit; if it cannot, leave it and note that in the commit body.

- [ ] **Step 4: Implement `fix_pr_opened` in pipeline.ts**

In the success return path (:365-376) — this branch is only reached when `prResult.status === 'created'` (the `'failed'` case returned at :356), and note the reused-PR idempotency path (pr.ts:825 returns the existing PR as `'created'`) will re-emit on retry, a tolerated duplicate per the delivery contract:

```ts
  emitUsageEvent('fix_pr_opened', {
    project_id: input.projectId,
    error_group_id: input.errorGroupId,
    pr_url: prResult.prUrl,
    draft: deliveryPosture === 'draft' ? 'true' : 'false',
    incident_url: input.incidentUrl ?? '',
    title: input.title ?? '',
  });
```

- [ ] **Step 5: Startup log in index.ts**

Near the env clamp table (:154-166):

```ts
logger.info('usage events', { enabled: Boolean(process.env['USAGE_EVENTS_SLACK_WEBHOOK']) });
```

- [ ] **Step 6: Run the full worker suite**

Run: `cd packages/worker && npx vitest run 2>&1 | tail -10 && npx tsc --noEmit`
Expected: PASS including all pre-existing `updateGroupStatus` contract tests (they guard lease/terminal semantics — if any fail, the bug is in your change).

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/db.ts packages/worker/src/pipeline.ts packages/worker/src/index.ts packages/worker/src/__tests__/usage-events-emits.test.ts
git commit -m "feat(worker): needs_human_created and fix_pr_opened usage events"
```

---

### Task 9: Compose plumbing, repo gate, live smoke

**Files:**
- Modify: `docker-compose.yml` (`USAGE_EVENTS_SLACK_WEBHOOK: ${USAGE_EVENTS_SLACK_WEBHOOK:-}` on BOTH `ingestion` and `worker` services)
- Modify: `docs/install.md` (optional operator usage notifications: env var name, the eight events in one sentence, unset = off, and a privacy warning that messages carry customer emails and error titles so the channel should be private)

- [ ] **Step 1: Compose + docs edits; `docker compose config --quiet` stays clean**

- [ ] **Step 2: Full repository gate**

```bash
set -o pipefail
# Export the FULL AGENTS.md worktree env block first (ports, DATABASE_URL,
# MinIO/replay vars) — without the storage vars ~30 Go tests skip silently.
pnpm install --frozen-lockfile && pnpm -r build && pnpm test
(cd packages/ingestion && go build ./... && go test ./... -v 2>&1 | tee /tmp/gotest.log | tail -5)
# grep -c exits 1 when the count is 0, so use grep -q as the gate:
if grep -q -- '--- SKIP:' /tmp/gotest.log; then echo 'SKIPPED TESTS — env incomplete'; exit 1; fi
docker compose config --quiet
```

- [ ] **Step 3: Live smoke (worktree stack, per the AGENTS.md port block)**

1. Start an in-network catcher on the compose network (the digest-v4 rig technique — host networking is blocked). Resolve the network name first and clean up any stale sink:

   ```bash
   NET=$(docker network ls --format '{{.Name}}' | grep -m1 "$(basename "$PWD")_default")
   docker rm -f usage-sink 2>/dev/null || true
   docker run -d --name usage-sink --network "$NET" mendhak/http-https-echo:latest
   # teardown at the end of the smoke: docker rm -f usage-sink
   ```

   Then `export USAGE_EVENTS_SLACK_WEBHOOK=http://usage-sink:8080/hook` for both containers (compose env) and `docker compose up -d --build ingestion worker`.
2. Apply ONLY the new migration against the already-migrated stack DB — `psql "$DATABASE_URL" -f packages/ingestion/db/migrations/062_environment_first_event.sql -v ON_ERROR_STOP=1` — not a full replay against retained data (replay-safety is CI-guarded on a clean DB, but this smoke's DB is retained state; a fresh disposable stack may replay everything instead). Seed `scripts/seed-e2e.sql`.
3. Sign up a FRESH user through the signup API (the `user_signed_up` assertion requires a genuinely new user — seeded credentials cannot produce it). If the embedded flow gates on email verification, complete `VerifyEmail` too: the `created` flag makes the signup event fire at whichever step performs provisioning. Then log the same user in once for `user_logged_in`.
4. Send SDK events until the filter admits (2 impact units for error episodes), then wait one filter sweep interval (30s).
5. Make one MCP tool call with a project API key.
6. Force a digest run (forced-payload technique from the digest-v4 rig notes).
7. Assert via `docker logs usage-sink`: the SET of events includes `user_signed_up`, `sdk_first_event_received`, `issue_created`, `mcp_tool_used`, `digest_delivered`. Do NOT assert arrival order — both runtimes send fire-and-forget.
8. Backfill idempotence on the live DB: re-run migration 062 (`psql "$DATABASE_URL" -f packages/ingestion/db/migrations/062_environment_first_event.sql`) → both UPDATEs report `UPDATE 0`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml docs/install.md
git commit -m "feat: wire USAGE_EVENTS_SLACK_WEBHOOK through compose + document operator usage notifications"
```

---

## Self-review notes

- Spec coverage: R1 (T1/T2), R2 (T4), R3 (T3 + T9.8), R4 (T8.2), R5 (T1/T2 sanitize + truncation tests), R6 (T1 URL-leak test; constant-string error logs in both senders), R7 (T1 recover + T2 whole-body try/catch). All 8 events: signup/login T4, first-event T3+T5, issue_created T6, digest_delivered T6, mcp T7, fix_pr/needs_human T8.
- Verified-against-code anchors this plan relies on: `friction_groups(environment_id, first_seen_at)` 001_baseline.sql:379-392; CTE `RETURNING g.id, prior.previous_status` db.ts:1325; `PRResult.status 'created'|'failed'` pr.ts:112-114; `finishClaim` call sites dispatcher.go:366-411 (nine); `result.IsError` mcp.go:185; filter imports (no notify → no cycle) dispatch.go:3-12; `ProjectIDFromCtx` works inside tool closures mcp.go:99.
- Also verified: `PRInput` carries `incidentUrl` and `title` (pr.ts:71-110), and `deliveryPosture` is in scope at the pipeline success return (pipeline.ts:365).
- Remaining open-the-file markers for the implementer (facts that vary with the checkout, not placeholders): `auth.Identity` field names (T4), whether `updateGroupInvestigation` can reach `needs_human` (T8), filter constructor name and call-site list (T6), exact incident URL path shape vs `notify/url_test.go` (T8).
