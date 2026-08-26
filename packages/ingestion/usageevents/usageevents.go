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
	sendTimeout   = 2 * time.Second
	maxConcurrent = 8
	maxTextBytes  = 8000
)

var (
	mu         sync.RWMutex
	webhookURL string
	sink       func(event string, props map[string]string)
	sem        = make(chan struct{}, maxConcurrent)
	// mcp_tool_used is the only per-customer-call event, so it gets its own
	// small pool: an MCP client hammering tools can exhaust at most semMCP,
	// never the slots signup/first-event/digest sends rely on.
	semMCP   = make(chan struct{}, 2)
	inflight sync.WaitGroup
	client   = &http.Client{Timeout: sendTimeout}
	// logger is a test seam. nil means "resolve slog.Default() at call time":
	// this package initializes before main() installs the JSON handler, so a
	// default captured here would bypass structured logging forever.
	logger *slog.Logger
)

func warn(msg string, args ...any) {
	l := logger
	if l == nil {
		l = slog.Default()
	}
	l.Warn(msg, args...)
}

// Configure validates and stores the webhook URL. On error the package is
// left disabled, so invalid configuration cannot leave a stale URL active.
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

// Emit posts one usage event without blocking or returning an error. It is a
// no-op when unconfigured and copies props before returning.
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
			defer func() { _ = recover() }()
			testSink(event, copied)
		}()
		return
	}
	pool := sem
	if event == "mcp_tool_used" {
		pool = semMCP
	}
	select {
	case pool <- struct{}{}:
	default:
		warn("usage event dropped: send queue full", "event", event)
		return
	}
	inflight.Add(1)
	go func() {
		defer inflight.Done()
		defer func() { <-pool }()
		defer func() {
			if recover() != nil {
				warn("usage event send panicked", "event", event)
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
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(map[string]string{"text": text})
	if err != nil {
		warn("usage event marshal failed", "event", event)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, &body)
	if err != nil {
		warn("usage event request build failed", "event", event)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		warn("usage event send failed", "event", event)
		return
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		warn("usage event rejected", "event", event, "status", resp.StatusCode)
	}
}

// SetSinkForTest replaces HTTP delivery with a synchronous callback. The
// returned function restores both the previous sink and configuration.
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

func resetForTest() {
	inflight.Wait()
	mu.Lock()
	webhookURL = ""
	sink = nil
	mu.Unlock()
}
