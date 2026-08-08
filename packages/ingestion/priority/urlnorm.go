// Package priority computes issue priority scores.
package priority

import (
	"net/url"
	"regexp"
	"strings"
)

var (
	numericSeg   = regexp.MustCompile(`^\d+$`)
	uuidSeg      = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	jwtSeg       = regexp.MustCompile(`^eyJ[A-Za-z0-9_-]+\.`)
	hexSeg       = regexp.MustCompile(`^[0-9a-fA-F]{16,}$`)
	mixedSeg     = regexp.MustCompile(`^(?:[A-Za-z0-9+/=_]*\d[A-Za-z0-9+/=_]*[A-Za-z][A-Za-z0-9+/=_]*|[A-Za-z0-9+/=_]*[A-Za-z][A-Za-z0-9+/=_]*\d[A-Za-z0-9+/=_]*)$`)
	base64urlSeg = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

// MaxPatternBytes bounds a normalized pattern. route_map keys on
// (project_id, pattern) with a btree, which refuses an index tuple over about
// a third of an 8KB page — and whether a given path trips that depends on how
// well it compresses, not on its length alone. Page URLs arrive through a
// public ingest key, so an unbounded pattern is a denial of service on the
// whole project's classification rather than a cosmetic problem: every route
// is written in one transaction, so a single unindexable row aborts all of
// them. This cap sits far below the btree limit and far above any real route.
const MaxPatternBytes = 512

// NormalizePageURL maps an observed URL or bare path to a normalized,
// templated path. Opaque segments are removed before the value is stored or
// sent to a classifier.
func NormalizePageURL(raw string) string {
	if raw == "" {
		return ""
	}
	var path, frag string
	if strings.HasPrefix(raw, "/") {
		path = raw
		// A bare path carries its own fragment. url.Parse splits that off in
		// the absolute branch, so do it here too, or "/#!/reports" loses its
		// route to the delimiter trim below and collapses onto "/" — putting
		// every hashbang page of an SPA under one classification.
		if i := strings.Index(path, "#"); i >= 0 {
			frag, path = path[i+1:], path[:i]
		}
	} else {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			return "/not-parseable"
		}
		path, frag = u.EscapedPath(), u.Fragment
	}
	if strings.HasPrefix(frag, "!") {
		path = strings.TrimPrefix(frag, "!")
	}
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	segs := strings.Split(strings.Trim(path, "/"), "/")
	out := make([]string, 0, len(segs))
	for _, s := range segs {
		// A framework context segment carries per-session state, not route
		// identity. packages/worker/src/friction/fingerprint.ts drops these
		// too; dropping them on both sides is what keeps an error group and a
		// friction group on the same page keyed alike.
		if s == "" || strings.HasPrefix(s, "_ctx_") {
			continue
		}
		out = append(out, templateSegment(s))
	}
	return boundPattern("/" + strings.Join(out, "/"))
}

// templateSegment replaces an opaque path segment with a placeholder. Every
// path that stores or forwards a normalized URL routes through here; anything
// that skips it publishes whatever the segment held.
func templateSegment(s string) string {
	if dec, err := url.PathUnescape(s); err == nil {
		s = dec
	}
	switch {
	case numericSeg.MatchString(s), uuidSeg.MatchString(s):
		return ":id"
	case jwtSeg.MatchString(s), hexSeg.MatchString(s),
		len(s) >= 16 && !strings.Contains(s, "-") && mixedSeg.MatchString(s),
		len(s) >= 25 && !strings.ContainsAny(s, "-_"),
		len(s) >= 22 && base64urlSeg.MatchString(s) && (strings.ContainsAny(s, "0123456789") || s != strings.ToLower(s)):
		return ":token"
	}
	return s
}

// boundPattern collapses anything past the cap onto a single sentinel.
// Truncating instead would leave cardinality unbounded, which is the half of
// the problem that costs money: every distinct pattern is a stored row and a
// line the classifier is asked to reason about.
func boundPattern(pattern string) string {
	if len(pattern) > MaxPatternBytes {
		return "/too-long"
	}
	return pattern
}
