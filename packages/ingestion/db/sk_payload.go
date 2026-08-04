package db

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Codec errors are prefixed with a stable reason token ("bad_iat: ...") so the
// upload plugin can explain a bad key to a developer and so the Go and
// TypeScript suites can assert the same failure against the same vector.
// ParseProjectKey deliberately discards those tokens: an auth-layer error must
// never reveal which part of a credential was recognised.
const (
	// MaxRawKeyLen caps the whole raw key. It is enforced before any base64 or
	// JSON work so a hostile key cannot buy decoding time.
	MaxRawKeyLen = 4096
	// maxPayloadURL caps the embedded endpoint.
	maxPayloadURL = 2048
	// Grammar widths: "opslane_sk_" + keyid(26) + "_" + secret(43) [+ "_" + payload].
	secretLen = 43
)

type SKPayload struct {
	V   int    `json:"v"`
	IAT string `json:"iat"`
	URL string `json:"url"`
}

// CanonicalIngestURL enforces the frozen URL policy and returns the canonical
// origin: lowercase scheme+host, default ports stripped, no trailing slash,
// https (http for loopback hosts only), nothing but the origin.
func CanonicalIngestURL(raw string) (string, error) {
	if len(raw) > maxPayloadURL {
		return "", fmt.Errorf("url_too_long: endpoint url exceeds %d bytes", maxPayloadURL)
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || !u.IsAbs() {
		return "", fmt.Errorf("url_invalid: endpoint must be an absolute URL")
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	loopback := host == "localhost" || host == "127.0.0.1" || host == "::1"
	switch scheme {
	case "https":
	case "http":
		if !loopback {
			return "", fmt.Errorf("url_scheme: http endpoints are allowed only for loopback hosts")
		}
	default:
		return "", fmt.Errorf("url_scheme: endpoint scheme must be https (or http for loopback)")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("url_not_origin: endpoint must be an origin only: no userinfo, path, query, or fragment")
	}
	// ASCII-only hostnames: sidesteps Go-vs-JS IDNA divergence entirely.
	for i := 0; i < len(host); i++ {
		if host[i] >= 0x80 {
			return "", fmt.Errorf("url_host_ascii: endpoint hostname must be ASCII (punycode it yourself if needed)")
		}
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.Atoi(port)
		// Reject leading zeros and out-of-range ports so Go and JS agree: the
		// JS URL parser normalizes ":0443"; we refuse it instead.
		if err != nil || n < 1 || n > 65535 || (len(port) > 1 && port[0] == '0') {
			return "", fmt.Errorf("url_port: endpoint port must be 1-65535 without leading zeros")
		}
	}
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	hostport := host
	if strings.Contains(host, ":") { // IPv6 literal
		hostport = "[" + host + "]"
	}
	if port != "" {
		hostport += ":" + port
	}
	return scheme + "://" + hostport, nil
}

// EncodeSKPayload builds the trailing payload segment. The URL must already be
// canonical, so callers go through CanonicalIngestURL first.
func EncodeSKPayload(canonicalURL string, iat time.Time) (string, error) {
	if again, err := CanonicalIngestURL(canonicalURL); err != nil || again != canonicalURL {
		return "", fmt.Errorf("url_not_canonical: EncodeSKPayload requires a canonical URL")
	}
	body, err := json.Marshal(SKPayload{V: 1, IAT: iat.UTC().Format(time.RFC3339), URL: canonicalURL})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(body), nil
}

// ParseSKPayload strictly decodes a payload segment: exactly {v:1, iat, url},
// with unknown, duplicate, and missing fields rejected and the URL policy
// enforced.
func ParseSKPayload(segment string) (SKPayload, error) {
	var zero SKPayload
	if segment == "" {
		return zero, fmt.Errorf("empty_payload: payload segment is empty")
	}
	body, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil || strings.Contains(segment, "=") {
		return zero, fmt.Errorf("bad_base64: payload is not unpadded base64url")
	}
	fields, err := walkStrictObject(body)
	if err != nil {
		return zero, err
	}
	var p SKPayload
	if err := json.Unmarshal(fields["v"], &p.V); err != nil {
		return zero, fmt.Errorf("bad_field_type: payload field v must be an integer")
	}
	if err := json.Unmarshal(fields["iat"], &p.IAT); err != nil {
		return zero, fmt.Errorf("bad_field_type: payload field iat must be a string")
	}
	if err := json.Unmarshal(fields["url"], &p.URL); err != nil {
		return zero, fmt.Errorf("bad_field_type: payload field url must be a string")
	}
	if p.V != 1 {
		return zero, fmt.Errorf("bad_version: unsupported payload version %d", p.V)
	}
	iat, err := time.Parse(time.RFC3339, p.IAT)
	if err != nil || !strings.HasSuffix(p.IAT, "Z") || iat.Location() != time.UTC {
		return zero, fmt.Errorf("bad_iat: iat must be an RFC 3339 UTC (Z-suffixed) timestamp")
	}
	canonical, err := CanonicalIngestURL(p.URL)
	if err != nil {
		return zero, err
	}
	if canonical != p.URL {
		return zero, fmt.Errorf("url_not_canonical: payload url is not in canonical form")
	}
	return p, nil
}

// walkStrictObject decodes exactly one top-level JSON object with exactly the
// keys v, iat, and url, each appearing once. Duplicates spelled with escapes
// such as "v" are caught too, because Token() returns the decoded key. The
// closing '}' is consumed and the following Token() must return io.EOF:
// dec.More() alone is not an EOF check, since it also reports false in front
// of a stray '}'.
func walkStrictObject(body []byte) (map[string]json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, fmt.Errorf("bad_json: payload must be a JSON object")
	}
	fields := map[string]json.RawMessage{}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("bad_json: payload JSON is invalid")
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, fmt.Errorf("bad_json: payload JSON is invalid")
		}
		if _, dup := fields[key]; dup {
			return nil, fmt.Errorf("duplicate_field: payload field %q must appear exactly once", key)
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, fmt.Errorf("bad_json: payload JSON is invalid")
		}
		fields[key] = value
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim('}') {
		return nil, fmt.Errorf("bad_json: payload JSON is invalid")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("bad_json: payload has trailing content")
	}
	for _, want := range []string{"v", "iat", "url"} {
		if _, ok := fields[want]; !ok {
			return nil, fmt.Errorf("missing_field: payload field %q is required", want)
		}
	}
	if len(fields) != 3 {
		return nil, fmt.Errorf("unknown_field: payload has unknown fields")
	}
	return fields, nil
}
