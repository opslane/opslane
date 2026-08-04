# Endpoint-Bearing SK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sk format becomes `opslane_sk_<keyid:26>_<secret:43>_<payload>` where the payload is base64url JSON `{v,iat,url}`; one env var (`OPSLANE_SOURCEMAP_KEY`) fully configures uploads; `OPSLANE_ENDPOINT` is removed. Hard cutover.

**Architecture:** Spec: `docs/design/2026-08-04-endpoint-bearing-sk-design.md` + `docs/plans/2026-08-04-sourcemap-token.md` (rev 5). Go side: a payload codec + URL canonicalizer in `db`, `ParseProjectKey` gains fixed-offset payload parsing, constructors require an endpoint for sourcemaps scope, mint-key seals it in. TS side: a mirrored decoder in the vite-plugin validates the full grammar and routes uploads to the embedded URL. One shared golden-vector fixture pins both. No schema change, no migration.

**Tech Stack:** Go 1.25 (stdlib only), TypeScript ESM strict, Vitest colocated `__tests__`, existing `test-fixtures/` vector conventions.

## Global Constraints

- No new dependencies anywhere.
- pk grammar untouched; any trailing payload on a pk is rejected.
- Total raw-key length cap 4096 bytes enforced BEFORE any base64/JSON work; url ≤ 2048.
- URL policy: absolute origin; https, or http only for loopback hosts (`localhost`, `127.0.0.1`, `[::1]`); no userinfo/path/query/fragment; lowercase scheme+host; default ports stripped; no trailing slash.
- Payload: raw unpadded base64url; UTF-8 JSON; exactly `{v:1, iat: RFC3339 UTC string, url}`; unknown/duplicate/missing fields rejected; `iat` validated for format only.
- One validation contract: Go parser and TS decoder enforce identical rules against the same vectors.
- Warnings never echo key material.
- Frozen S0 §3 amendment is explicit (Task 5); repo guardrail: change contracts explicitly.
- Verification: `(cd packages/ingestion && go build ./... && go test ./...)` (Go via `docker run --rm --network host -v "$PWD":/repo -w /repo/packages/ingestion -v /tmp/gocache:/gocache -e GOCACHE=/gocache/build -e GOMODCACHE=/gocache/mod golang:1.25 ...` from repo root), `pnpm --filter @opslane/sdk build && pnpm --filter @opslane/sdk test`, `pnpm --filter @opslane/worker test`, `node scripts/check-docs-drift.mjs`.

---

### Task 1: Go payload codec, URL canonicalizer, ParseProjectKey, golden vectors

**Files:**
- Create: `packages/ingestion/db/sk_payload.go`
- Create: `test-fixtures/sourcemap-key/vectors.json`
- Modify: `packages/ingestion/db/project_keys.go` (`ParseProjectKey` only in this task)
- Test: `packages/ingestion/db/sk_payload_test.go` (vector-driven), extend `project_keys_test.go` if present (else the new test file covers parse)

**Interfaces:**
- Produces:
```go
// CanonicalIngestURL validates and canonicalizes an ingestion origin per the
// frozen URL policy. Returns the canonical form or an error naming the rule.
func CanonicalIngestURL(raw string) (string, error)

// EncodeSKPayload builds the base64url payload segment for a canonical URL.
// iat is caller-supplied so vectors and tests are deterministic.
func EncodeSKPayload(canonicalURL string, iat time.Time) (string, error)

// ParseSKPayload strictly decodes a payload segment: exactly {v:1, iat, url},
// unknown/duplicate/missing fields rejected, URL policy enforced.
func ParseSKPayload(segment string) (SKPayload, error)

type SKPayload struct {
	V   int    `json:"v"`
	IAT string `json:"iat"`
	URL string `json:"url"`
}

const MaxRawKeyLen = 4096
```
- `ParseProjectKey` keeps its exact signature and return type (`*ParsedProjectKey{KeyID, Secret, Scope}`) — downstream auth is untouched. It additionally accepts (and strictly validates) a trailing payload on sk keys and rejects one on pk keys.

- [x] **Step 1: Write the golden-vector fixture**

`test-fixtures/sourcemap-key/vectors.json` (deterministic: fixed iat; keyid `mzxw6ytboi3damrrgi3tknzxgq` and this secret are ALREADY in `.gitleaks.toml`'s fixture allowlist regex — using them keeps the scanner clean without weakening it, since real keys carry random key IDs):

```json
{
  "version": 1,
  "valid": [
    {
      "name": "https origin",
      "keyid": "mzxw6ytboi3damrrgi3tknzxgq",
      "secret": "E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA",
      "endpoint": "https://ingest.opslane.com",
      "iat": "2026-08-04T00:00:00Z",
      "raw": "<computed in Step 3 and pasted back — Go encoder output, byte-exact>"
    },
    {
      "name": "loopback http with port",
      "keyid": "mzxw6ytboi3damrrgi3tknzxgq",
      "secret": "E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA",
      "endpoint": "http://localhost:8082",
      "iat": "2026-08-04T00:00:00Z",
      "raw": "<computed>"
    },
    {
      "name": "default port stripped",
      "keyid": "mzxw6ytboi3damrrgi3tknzxgq",
      "secret": "E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA",
      "endpoint": "https://ingest.opslane.com:443/",
      "canonical": "https://ingest.opslane.com",
      "iat": "2026-08-04T00:00:00Z",
      "raw": "<computed — identical to the first vector's payload url>"
    }
  ],
  "decoderInvalid": [
    {"name": "bare key (no payload)", "raw": "opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA", "acceptedByServer": true, "reason": "legacy_format"},
    {"name": "empty payload segment", "rawSuffix": "_", "reason": "empty_payload"},
    {"name": "bad base64", "payload": "!!!", "reason": "bad_base64"},
    {"name": "padded base64", "payloadOf": "{\"v\":1,\"iat\":\"2026-08-04T00:00:00Z\",\"url\":\"https://a.example\"}", "padded": true, "reason": "bad_base64"},
    {"name": "wrong version", "payloadJson": {"v": 2, "iat": "2026-08-04T00:00:00Z", "url": "https://a.example"}, "reason": "bad_version"},
    {"name": "unknown field", "payloadJson": {"v": 1, "iat": "2026-08-04T00:00:00Z", "url": "https://a.example", "x": 1}, "reason": "unknown_field"},
    {"name": "missing url", "payloadJson": {"v": 1, "iat": "2026-08-04T00:00:00Z"}, "reason": "missing_field"},
    {"name": "duplicate field", "payloadRawJson": "{\"v\":1,\"v\":1,\"iat\":\"2026-08-04T00:00:00Z\",\"url\":\"https://a.example\"}", "reason": "duplicate_field"},
    {"name": "bad iat", "payloadJson": {"v": 1, "iat": "yesterday", "url": "https://a.example"}, "reason": "bad_iat"},
    {"name": "http non-loopback", "payloadJson": {"v": 1, "iat": "2026-08-04T00:00:00Z", "url": "http://ingestion:8080"}, "reason": "url_scheme"},
    {"name": "url with path", "payloadJson": {"v": 1, "iat": "2026-08-04T00:00:00Z", "url": "https://a.example/api"}, "reason": "url_not_origin"},
    {"name": "url with userinfo", "payloadJson": {"v": 1, "iat": "2026-08-04T00:00:00Z", "url": "https://u:p@a.example"}, "reason": "url_not_origin"},
    {"name": "payload on pk", "raw": "opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq_eyJ2IjoxfQ", "reason": "payload_on_pk"},
    {"name": "oversize", "oversizeTo": 5000, "reason": "too_long"},
    {"name": "escaped duplicate key", "payloadRawJson": "{\"v\":1,\"\\u0076\":1,\"iat\":\"2026-08-04T00:00:00Z\",\"url\":\"https://a.example\"}", "reason": "duplicate_field"},
    {"name": "trailing delimiter", "payloadOf": "{\"v\":1,\"iat\":\"2026-08-04T00:00:00Z\",\"url\":\"https://a.example\"}}", "reason": "bad_json"},
    {"name": "non-UTC iat", "payloadJson": {"v": 1, "iat": "2026-08-04T01:00:00+01:00", "url": "https://a.example"}, "reason": "bad_iat"},
    {"name": "wrong field type", "payloadJson": {"v": "1", "iat": "2026-08-04T00:00:00Z", "url": "https://a.example"}, "reason": "bad_field_type"},
    {"name": "non-integer v literal", "payloadRawJson": "{\"v\":1.0,\"iat\":\"2026-08-04T00:00:00Z\",\"url\":\"https://a.example\"}", "reason": "bad_field_type"},
    {"name": "url with query", "payloadJson": {"v": 1, "iat": "2026-08-04T00:00:00Z", "url": "https://a.example?x=1"}, "reason": "url_not_origin"},
    {"name": "url with fragment", "payloadJson": {"v": 1, "iat": "2026-08-04T00:00:00Z", "url": "https://a.example#f"}, "reason": "url_not_origin"},
    {"name": "empty host", "payloadJson": {"v": 1, "iat": "2026-08-04T00:00:00Z", "url": "https:///"}, "reason": "url_invalid"},
    {"name": "unicode host", "payloadJson": {"v": 1, "iat": "2026-08-04T00:00:00Z", "url": "https://bücher.example"}, "reason": "url_host_ascii"},
    {"name": "port leading zero", "payloadJson": {"v": 1, "iat": "2026-08-04T00:00:00Z", "url": "https://a.example:0443"}, "reason": "url_port"},
    {"name": "port out of range", "payloadJson": {"v": 1, "iat": "2026-08-04T00:00:00Z", "url": "https://a.example:99999"}, "reason": "url_port"},
    {"name": "bad keyid width", "raw": "opslane_sk_short_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA", "reason": "bad_grammar"},
    {"name": "bad secret alphabet", "raw": "opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_%%%SOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA", "reason": "bad_grammar"},
    {"name": "oversize url in payload", "urlOfLength": 3000, "reason": "url_too_long"}
  ],
  "valid_MERGE_NOTE": "the ipv6 entry below belongs in the valid array — single list, both suites iterate it",
  "validExtra": [
    {"name": "ipv6 loopback", "keyid": "mzxw6ytboi3damrrgi3tknzxgq", "secret": "E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA", "endpoint": "http://[::1]:8082", "iat": "2026-08-04T00:00:00Z", "raw": "<computed>"}
  ],
  "encoderInvalid": [
    {"endpoint": "ftp://a.example", "reason": "url_scheme"},
    {"endpoint": "https://a.example/api", "reason": "url_not_origin"},
    {"endpoint": "not a url", "reason": "url_invalid"},
    {"endpoint": "http://internal-host:8080", "reason": "url_scheme"}
  ]
}
```
Semantics of the fields: the Go and TS tests construct raw keys from these
pieces (a `payloadJson` entry is minified, base64url-encoded unpadded, and
appended to the standard sk prefix+keyid+secret; `payloadRawJson` is used
verbatim to preserve duplicates). The `acceptedByServer: true` entry is the
one deliberate divergence: the SERVER accepts a bare sk (routing is client
concern), the PLUGIN rejects it — both suites assert their own side.

- [x] **Step 2: Write failing Go tests (vector-driven)**

`packages/ingestion/db/sk_payload_test.go`:
```go
package db

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

type skVectors struct {
	Valid []struct {
		Name, Keyid, Secret, Endpoint, Canonical, IAT, Raw string
	} `json:"valid"`
	DecoderInvalid []json.RawMessage `json:"decoderInvalid"`
	EncoderInvalid []struct{ Endpoint, Reason string } `json:"encoderInvalid"`
}

func loadSKVectors(t *testing.T) skVectors {
	t.Helper()
	data, err := os.ReadFile("../../../test-fixtures/sourcemap-key/vectors.json")
	if err != nil { t.Fatalf("read vectors: %v", err) }
	var v skVectors
	if err := json.Unmarshal(data, &v); err != nil { t.Fatalf("parse vectors: %v", err) }
	return v
}

func TestEncodeSKPayloadMatchesVectors(t *testing.T) {
	for _, vec := range loadSKVectors(t).Valid {
		canonical, err := CanonicalIngestURL(vec.Endpoint)
		if err != nil { t.Fatalf("%s: canonicalize: %v", vec.Name, err) }
		if vec.Canonical != "" && canonical != vec.Canonical {
			t.Fatalf("%s: canonical = %q, want %q", vec.Name, canonical, vec.Canonical)
		}
		iat, _ := time.Parse(time.RFC3339, vec.IAT)
		payload, err := EncodeSKPayload(canonical, iat)
		if err != nil { t.Fatalf("%s: encode: %v", vec.Name, err) }
		raw := "opslane_sk_" + vec.Keyid + "_" + vec.Secret + "_" + payload
		if raw != vec.Raw {
			t.Fatalf("%s: raw mismatch\n got %s\nwant %s", vec.Name, raw, vec.Raw)
		}
	}
}

func TestParseProjectKeyAcceptsVectorRaws(t *testing.T) {
	for _, vec := range loadSKVectors(t).Valid {
		parsed, err := ParseProjectKey(vec.Raw)
		if err != nil { t.Fatalf("%s: parse: %v", vec.Name, err) }
		if parsed.KeyID != vec.Keyid || parsed.Secret != vec.Secret || parsed.Scope != ScopeSourcemaps {
			t.Fatalf("%s: parsed wrong identity", vec.Name)
		}
	}
	// Bare sk still parses at the server (routing is a client concern).
	bare := "opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA"
	if _, err := ParseProjectKey(bare); err != nil {
		t.Fatalf("bare sk must stay server-valid: %v", err)
	}
	// pk with a payload is refused.
	pkPayload := "opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq_eyJ2IjoxfQ"
	if _, err := ParseProjectKey(pkPayload); err == nil {
		t.Fatal("payload on pk must be rejected")
	}
	// Length cap fires before decode.
	long := "opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA_" + strings.Repeat("A", MaxRawKeyLen)
	if _, err := ParseProjectKey(long); err == nil {
		t.Fatal("oversize must be rejected")
	}
	// Empty trailing payload is refused.
	if _, err := ParseProjectKey(bare + "_"); err == nil {
		t.Fatal("empty payload must be rejected")
	}
}

func TestParseSKPayloadRejectsInvalid(t *testing.T) {
	cases := []struct{ name, segment string }{
		{"bad base64", "!!!"},
		{"wrong version", b64({"v":2 ...})}, // build helpers below construct these from the fixture
	}
	_ = cases // Implementer: consume EVERY decoderInvalid entry. Write one
	// buildRaw(vec) helper handling ALL construction fields (raw, rawSuffix,
	// payload, payloadOf+padded, payloadJson, payloadRawJson, oversizeTo,
	// urlOfLength) and route each entry to the right assertion target:
	// full-raw entries (raw/rawSuffix/oversizeTo/grammar) against
	// ParseProjectKey (expect opaque failure), payload-shaped entries against
	// ParseSKPayload (expect the reason-token prefix). The ipv6 vector lives
	// in the SINGLE valid array and is iterated with the others.
}
```
(The third test's construction helper is small: minify `payloadJson` with
`json.Marshal`... except `duplicate field`, which uses `payloadRawJson`
verbatim; base64url-encode unpadded. Write it concretely in the test file.)

- [x] **Step 3: Implement, then pin the vector raws**

`packages/ingestion/db/sk_payload.go`:
```go
package db

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	MaxRawKeyLen   = 4096
	maxPayloadURL  = 2048
	skPrefixLen    = len("opslane_sk_") // 11
	keyIDLen       = 26
	secretLen      = 43
	// Fixed offsets (design §4): keyid [11:37), sep 37, secret [38:81), sep 81.
	secretEnd = skPrefixLen + keyIDLen + 1 + secretLen // 81
)

type SKPayload struct {
	V   int    `json:"v"`
	IAT string `json:"iat"`
	URL string `json:"url"`
}

// CanonicalIngestURL enforces the frozen URL policy and returns the
// canonical origin: lowercase scheme+host, default ports stripped, no
// trailing slash, https (http for loopback hosts only), nothing but origin.
func CanonicalIngestURL(raw string) (string, error) {
	if len(raw) > maxPayloadURL {
		return "", fmt.Errorf("endpoint url exceeds %d bytes", maxPayloadURL)
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || !u.IsAbs() {
		return "", fmt.Errorf("endpoint must be an absolute URL")
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	loopback := host == "localhost" || host == "127.0.0.1" || host == "::1"
	switch scheme {
	case "https":
	case "http":
		if !loopback {
			return "", fmt.Errorf("http endpoints are allowed only for loopback hosts")
		}
	default:
		return "", fmt.Errorf("endpoint scheme must be https (or http for loopback)")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("endpoint must be an origin only: no userinfo, path, query, or fragment")
	}
	// ASCII-only hostnames: sidesteps Go-vs-JS IDNA divergence entirely.
	for i := 0; i < len(host); i++ {
		if host[i] >= 0x80 {
			return "", fmt.Errorf("endpoint hostname must be ASCII (punycode it yourself if needed)")
		}
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.Atoi(port)
		// Reject leading zeros and out-of-range ports so Go and JS agree:
		// JS URL normalizes ":0443"; we refuse it instead of normalizing.
		if err != nil || n < 1 || n > 65535 || (len(port) > 1 && port[0] == '0') {
			return "", fmt.Errorf("endpoint port must be 1-65535 without leading zeros")
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

// EncodeSKPayload builds the trailing payload segment. The URL must already
// be canonical (callers go through CanonicalIngestURL first).
func EncodeSKPayload(canonicalURL string, iat time.Time) (string, error) {
	if again, err := CanonicalIngestURL(canonicalURL); err != nil || again != canonicalURL {
		return "", fmt.Errorf("EncodeSKPayload requires a canonical URL")
	}
	body, err := json.Marshal(SKPayload{V: 1, IAT: iat.UTC().Format(time.RFC3339), URL: canonicalURL})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(body), nil
}

// ParseSKPayload strictly decodes a payload segment.
func ParseSKPayload(segment string) (SKPayload, error) {
	var zero SKPayload
	if segment == "" {
		return zero, fmt.Errorf("empty payload")
	}
	body, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil || strings.ContainsAny(segment, "=") {
		return zero, fmt.Errorf("payload is not unpadded base64url")
	}
	// One strict pass: token-walk the top-level object, collecting each key
	// exactly once, then require clean EOF. dec.More() alone is NOT an EOF
	// check (it returns false before a stray '}' too); only io.EOF from the
	// next Token() proves the input is fully consumed.
	fields, err := walkStrictObject(body) // map[string]json.RawMessage
	if err != nil {
		return zero, err
	}
	var p SKPayload
	if err := json.Unmarshal(fields["v"], &p.V); err != nil {
		return zero, fmt.Errorf("payload field v invalid")
	}
	if err := json.Unmarshal(fields["iat"], &p.IAT); err != nil {
		return zero, fmt.Errorf("payload field iat invalid")
	}
	if err := json.Unmarshal(fields["url"], &p.URL); err != nil {
		return zero, fmt.Errorf("payload field url invalid")
	}
	if p.V != 1 {
		return zero, fmt.Errorf("unsupported payload version %d", p.V)
	}
	iat, err := time.Parse(time.RFC3339, p.IAT)
	if err != nil || !strings.HasSuffix(p.IAT, "Z") || iat.Location() != time.UTC {
		return zero, fmt.Errorf("iat must be an RFC 3339 UTC (Z-suffixed) timestamp")
	}
	canonical, err := CanonicalIngestURL(p.URL)
	if err != nil || canonical != p.URL {
		return zero, fmt.Errorf("payload url is not a canonical allowed origin")
	}
	return p, nil
}

// walkStrictObject decodes exactly one top-level JSON object with exactly
// the keys v, iat, url, each once (duplicates via escaped spellings like
// \u0076 are caught because Token() returns the decoded key string), and
// requires clean EOF: the closing '}' is consumed and the next Token()
// must return io.EOF.
func walkStrictObject(body []byte) (map[string]json.RawMessage, error) {
	dec := json.NewDecoder(strings.NewReader(string(body)))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, fmt.Errorf("payload must be a JSON object")
	}
	fields := map[string]json.RawMessage{}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("payload JSON invalid")
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, fmt.Errorf("payload JSON invalid")
		}
		if _, dup := fields[key]; dup {
			return nil, fmt.Errorf("payload field %q must appear exactly once", key)
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, fmt.Errorf("payload JSON invalid")
		}
		fields[key] = value
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim('}') {
		return nil, fmt.Errorf("payload JSON invalid")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("trailing payload content")
	}
	for _, want := range []string{"v", "iat", "url"} {
		if _, ok := fields[want]; !ok {
			return nil, fmt.Errorf("payload field %q is required", want)
		}
	}
	if len(fields) != 3 {
		return nil, fmt.Errorf("payload has unknown fields")
	}
	return fields, nil
}
```

`ParseProjectKey` in `project_keys.go` becomes:
```go
func ParseProjectKey(raw string) (*ParsedProjectKey, error) {
	if len(raw) > MaxRawKeyLen {
		return nil, fmt.Errorf("malformed key")
	}
	// Fixed-offset grammar: prefix(10)+"_"+keyid(26)+"_"+secret(43)[+"_"+payload].
	// base64url payloads may contain underscores, so offsets, not SplitN.
	parts := strings.SplitN(raw, "_", 4)
	if len(parts) != 4 {
		return nil, fmt.Errorf("malformed key")
	}
	scope, ok := scopeForPrefix(parts[0] + "_" + parts[1])
	if !ok || !keyIDRe.MatchString(parts[2]) {
		return nil, fmt.Errorf("malformed key")
	}
	remainder := parts[3] // secret, possibly followed by "_" + payload
	if len(remainder) < secretLen {
		return nil, fmt.Errorf("malformed key")
	}
	secret := remainder[:secretLen]
	if !secretRe.MatchString(secret) {
		return nil, fmt.Errorf("malformed key")
	}
	switch {
	case len(remainder) == secretLen:
		// Bare key: valid for both scopes (payload is client routing).
	case remainder[secretLen] != '_':
		return nil, fmt.Errorf("malformed key")
	default:
		payload := remainder[secretLen+1:]
		if scope != ScopeSourcemaps {
			return nil, fmt.Errorf("malformed key") // payload on pk
		}
		if _, err := ParseSKPayload(payload); err != nil {
			return nil, fmt.Errorf("malformed key")
		}
	}
	return &ParsedProjectKey{KeyID: parts[2], Secret: secret, Scope: scope}, nil
}
```

Then run the encoder against the fixture inputs, paste the produced `raw`
values into `vectors.json` (Step 1 placeholders), and re-run until
`TestEncodeSKPayloadMatchesVectors` passes byte-exactly.

- [x] **Step 4: Run and commit**

Run: Go container: `go build ./... && go test ./db/`
Expected: PASS, including every existing key test (bare keys still parse).
```bash
git add packages/ingestion/db/ test-fixtures/sourcemap-key/
git commit -m "feat(db): sk payload codec, URL canonicalizer, fixed-offset key parsing"
```

---

### Task 2: Constructors require the endpoint; mint-key seals it

**Files:**
- Modify: `packages/ingestion/db/project_keys.go` (`NewProjectKey`, `CreateProjectKey`, `CreateProjectKeyTx`)
- Modify: EVERY `NewProjectKey`/`CreateProjectKey*` caller. Do NOT trust a
  hand-written line list — enumerate mechanically and classify by the scope
  argument AT EACH SITE:
  ```bash
  grep -rn "NewProjectKey(\|CreateProjectKey(\|CreateProjectKeyTx(" packages/ingestion --include="*.go"
  ```
  Rule per site: scope `ScopeIngest` (or "ingest") → append `, ""`; scope
  `ScopeSourcemaps` → append a valid endpoint (`"https://ingest.test"` in
  tests; the resolved endpoint in mint-key). Sites that pass a variable
  scope get the endpoint threaded as a variable. Format-assertion tests
  (e.g. `db/project_keys_test.go` asserting the raw's shape) need
  STRUCTURAL updates: sk assertions expect the payload segment, pk
  assertions expect the unchanged grammar. `go build ./...` green across
  the module is the completion proof for this step.
- Modify: `packages/ingestion/cmd/mint-key/main.go`
- Test: `packages/ingestion/cmd/mint-key/main_test.go`, `packages/ingestion/db/sk_payload_test.go` (constructor cases)

**Interfaces:**
- Produces:
```go
// endpoint: required canonical-izable URL for ScopeSourcemaps; must be ""
// for ScopeIngest. Passing the wrong combination is an error, so a bare sk
// is unconstructable and a pk can never grow a payload.
func NewProjectKey(scope, endpoint string) (*MintedProjectKey, error)
func (q *Queries) CreateProjectKey(ctx context.Context, projectID, scope, label string, createdByUserID *string, endpoint string) (*MintedProjectKey, error)
func (q *Queries) CreateProjectKeyTx(ctx context.Context, tx pgx.Tx, projectID, scope, label string, createdByUserID *string, endpoint string) (*MintedProjectKey, error)
```
  `MintedProjectKey.Raw` for sourcemaps now includes the payload; DB columns
  are untouched (only keyid/prefix/hash are stored).
- mint-key: `-endpoint <url>` flag; env `OPSLANE_PUBLIC_INGEST_URL`; for
  `-scope sourcemaps` exactly one source must yield a canonical URL (both
  set and differing → exit 2; neither → exit 2), all before `db.Connect`;
  `-scope ingest` with `-endpoint` or the env set is NOT an error for the
  env (deployment-wide config) but the flag is rejected.

- [x] **Step 1: Failing tests**

Constructor cases in `sk_payload_test.go`:
```go
func TestNewProjectKeyEndpointDiscipline(t *testing.T) {
	if _, err := NewProjectKey(ScopeSourcemaps, ""); err == nil {
		t.Fatal("sourcemaps key without endpoint must be unconstructable")
	}
	if _, err := NewProjectKey(ScopeIngest, "https://a.example"); err == nil {
		t.Fatal("ingest key with endpoint must be rejected")
	}
	minted, err := NewProjectKey(ScopeSourcemaps, "https://ingest.opslane.com")
	if err != nil { t.Fatal(err) }
	parsed, err := ParseProjectKey(minted.Raw)
	if err != nil || parsed.Scope != ScopeSourcemaps {
		t.Fatalf("minted key must round-trip: %v", err)
	}
	if !strings.Contains(minted.Raw[secretEnd:], "_") {
		t.Fatal("minted sk must carry a payload")
	}
	pk, err := NewProjectKey(ScopeIngest, "")
	if err != nil { t.Fatal(err) }
	if len(pk.Raw) != secretEnd {
		t.Fatal("pk grammar must be unchanged")
	}
}
```
mint-key test additions (pure helpers, no DB): `resolveEndpoint(flagVal, envVal, scope) (string, error)` cases — sourcemaps: both empty → error; both set, same canonical → ok; both set, different → error; flag only / env only → ok; ingest: flag set → error; env set → ignored, ok.

- [x] **Step 2: Run to verify failure** (Go container, `go test ./db/ ./cmd/mint-key/`)

- [x] **Step 3: Implement**

`NewProjectKey(scope, endpoint string)`:
```go
func NewProjectKey(scope, endpoint string) (*MintedProjectKey, error) {
	prefix, err := prefixForScope(scope)
	if err != nil {
		return nil, err
	}
	switch scope {
	case ScopeSourcemaps:
		if endpoint == "" {
			return nil, fmt.Errorf("sourcemaps keys require an endpoint")
		}
	default:
		if endpoint != "" {
			return nil, fmt.Errorf("endpoint is only valid for sourcemaps keys")
		}
	}
	// ... existing random keyid/secret generation unchanged ...
	raw := prefix + "_" + keyID + "_" + secret
	if scope == ScopeSourcemaps {
		canonical, err := CanonicalIngestURL(endpoint)
		if err != nil {
			return nil, err
		}
		payload, err := EncodeSKPayload(canonical, time.Now())
		if err != nil {
			return nil, err
		}
		raw += "_" + payload
	}
	// SecretHash still hashes ONLY the secret component.
	...
}
```
`CreateProjectKey`/`CreateProjectKeyTx` pass `endpoint` through. The three
`ScopeIngest` call sites gain `, ""` as the final argument.

mint-key: add
```go
func resolveEndpoint(flagVal, envVal, scope string) (string, error) {
	if scope != db.ScopeSourcemaps {
		if flagVal != "" {
			return "", fmt.Errorf("-endpoint is only valid with -scope sourcemaps")
		}
		return "", nil
	}
	flagC, envC := "", ""
	var err error
	if flagVal != "" {
		if flagC, err = db.CanonicalIngestURL(flagVal); err != nil {
			return "", fmt.Errorf("-endpoint: %w", err)
		}
	}
	if envVal != "" {
		if envC, err = db.CanonicalIngestURL(envVal); err != nil {
			return "", fmt.Errorf("OPSLANE_PUBLIC_INGEST_URL: %w", err)
		}
	}
	switch {
	case flagC != "" && envC != "" && flagC != envC:
		return "", fmt.Errorf("-endpoint %q disagrees with OPSLANE_PUBLIC_INGEST_URL %q", flagC, envC)
	case flagC != "":
		return flagC, nil
	case envC != "":
		return envC, nil
	default:
		return "", fmt.Errorf("sourcemaps minting needs OPSLANE_PUBLIC_INGEST_URL or -endpoint")
	}
}
```
Wire into `main()` BEFORE `db.Connect` (validate-before-insert), pass into
`CreateProjectKey`. Instructions text: the sourcemaps output loses the
`.env.local`-optional phrasing change? No — text stays, but explicitly says
the single value carries the destination; no OPSLANE_ENDPOINT mention
anywhere (grep-checked in Task 5).

- [x] **Step 4: Run and commit**

Go container: `go build ./... && go test ./...` (with `--network host` +
`DATABASE_URL` for the DB-backed suites).
```bash
git add packages/ingestion/
git commit -m "feat(ingestion): sourcemap keys are minted with their endpoint sealed in"
```

---

### Task 3: TS decoder + plugin cutover

**Files:**
- Create: `packages/sdk/vite-plugin/sk-key.ts`
- Modify: `packages/sdk/vite-plugin/index.ts` (closeBundle block, lines ~600-640)
- Modify: `packages/sdk/vite-plugin/upload.ts` (`redirect: 'error'`)
- Modify: `packages/sdk/src/__tests__/vite-plugin.test.ts` (closeBundle upload tests at ~331 and ~380 set `opslane_sk_test` + `OPSLANE_ENDPOINT` — replace with a payload-bearing canary from the fixture and drop the endpoint var; add a case asserting the bare-key `OPSLANE_VITE_KEY_INVALID` path)
- Modify: `packages/sdk/vite-plugin/__tests__/env-upload.test.ts` (same: `.env.local` now carries the payload-bearing key only)
- Test: `packages/sdk/vite-plugin/__tests__/sk-key.test.ts` (vector-driven), extend the existing upload tests with the 307-redirect refusal case

**Interfaces:**
- Produces:
```ts
export type ParsedSourceMapKey =
  | { ok: true; url: string }
  | { ok: false; reason: string }; // stable reason strings, never key material
export function parseSourceMapKey(raw: string): ParsedSourceMapKey;
```
  Mirrors the Go contract exactly: length caps first, fixed offsets, strict
  payload (`v===1`, RFC 3339 UTC `iat` with `Z` suffix, canonical URL
  policy, no unknown or duplicate fields). Duplicate detection algorithm,
  concretely: after `JSON.parse` succeeds (rejecting non-objects), rescan
  the decoded JSON TEXT with a minimal top-level-key tokenizer: walk the
  string; at depth 1, each key token is the quoted string before a `:`;
  extract each key token as a raw slice INCLUDING quotes and decode it with
  `JSON.parse(slice)` so escaped spellings like `"\u0076"` normalize to
  `v`; track counts; any repeat → reason `duplicate_field`. Depth tracking
  only needs `{`/`}`/`[`/`]` outside strings and a string-skipper honoring
  backslash escapes — about 30 lines; write it in `sk-key.ts` with its own
  unit cases (the escaped-duplicate vector exercises it).
  `v` strictness note: `JSON.parse` erases the difference between `1` and
  `1.0`, but Go's int unmarshal rejects `1.0` — so the TS tokenizer (which
  already scans raw text for duplicate keys) ALSO captures the raw value
  token of `v` and requires it to be exactly the literal `1`
  (`/^1$/`), pinning the `non-integer v literal` vector to
  `bad_field_type` in both languages.
  Reasons are the shared contract: return exactly the fixture's reason
  strings (`bad_base64`, `bad_version`, `unknown_field`, `missing_field`,
  `duplicate_field`, `bad_iat`, `bad_field_type`, `bad_json`, `url_scheme`,
  `url_not_origin`, `url_invalid`, `url_host_ascii`, `url_port`,
  `url_too_long`, `bad_grammar`, `empty_payload`, `payload_on_pk`,
  `too_long`, `legacy_format`). Go's `ParseSKPayload` returns errors whose
  message BEGINS with the same reason token, asserted vector-by-vector in
  the Go suite.
- Consumes: `test-fixtures/sourcemap-key/vectors.json` (valid raws must all
  parse; every decoderInvalid entry must fail EXCEPT the bare-key entry,
  which must fail in the PLUGIN with reason `legacy_format` — the
  `acceptedByServer` flag tells the TS suite to still assert rejection here).

- [x] **Step 1: Failing vector-driven tests**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSourceMapKey } from '../sk-key';

const vectors = JSON.parse(readFileSync(
  resolve(__dirname, '../../../../test-fixtures/sourcemap-key/vectors.json'), 'utf8'));

describe('parseSourceMapKey', () => {
  it('accepts every valid vector and extracts the canonical url', () => {
    for (const vec of vectors.valid) {
      const parsed = parseSourceMapKey(vec.raw);
      expect(parsed, vec.name).toEqual({ ok: true, url: vec.canonical ?? vec.endpoint });
    }
  });
  it('rejects every invalid vector with the vector's exact reason', () => {
    for (const vec of vectors.decoderInvalid) {
      const raw = buildRawFromVector(vec); // same construction semantics as Go
      const parsed = parseSourceMapKey(raw);
      expect(parsed.ok, vec.name).toBe(false);
      if (!parsed.ok && vec.reason) {
        // Stable reasons ARE the contract: the warning text names them, and
        // Go's ParseSKPayload errors carry the same strings (asserted in the
        // Go suite). A generic catch-all reason fails this test.
        expect(parsed.reason, vec.name).toBe(vec.reason);
      }
    }
  });
  it('never includes key material in reasons', () => {
    const parsed = parseSourceMapKey('opslane_sk_x');
    if (!parsed.ok) expect(parsed.reason).not.toContain('opslane_sk_x');
  });
});
```

- [x] **Step 2: Run to verify failure** (`pnpm --filter @opslane/sdk test -- sk-key`)

- [x] **Step 3: Implement `sk-key.ts` and rewire closeBundle**

closeBundle replacement for the env block:
```ts
      const rawKey = process.env['OPSLANE_SOURCEMAP_KEY']
        ?? fileEnv['OPSLANE_SOURCEMAP_KEY'];
      if (process.env['OPSLANE_ENDPOINT'] ?? fileEnv['OPSLANE_ENDPOINT']) {
        warnOnce(
          'OPSLANE_VITE_ENDPOINT_REMOVED',
          'OPSLANE_ENDPOINT is no longer used: the key itself carries the upload URL. Remove the variable.',
        );
      }
      if (rawKey) {
        const parsed = parseSourceMapKey(rawKey);
        if (!parsed.ok) {
          warnOnce(
            'OPSLANE_VITE_KEY_INVALID',
            `OPSLANE_SOURCEMAP_KEY is not a valid endpoint-bearing key (${parsed.reason}). ` +
            'Re-mint the key with a current server; bare keys from before the format change are no longer accepted. Upload skipped.',
          );
        } else {
          const entries = mapsWillShip()
            ? await collectVerifiedFromDisk()
            : [...uploadPayloads.values()];
          const outcome = await uploadSourceMaps(entries, { endpoint: parsed.url, key: rawKey });
          // ...existing failure/summary reporting unchanged...
        }
      }
```
upload.ts: add `redirect: 'error'` to the fetch init, plus a unit test that
a 307 response surfaces as a failed entry rather than a followed redirect
(the in-process test server responds 307 with a Location).

- [x] **Step 4: Run and commit**

`pnpm --filter @opslane/sdk build && pnpm --filter @opslane/sdk test`
```bash
git add packages/sdk/vite-plugin/ packages/sdk/src/__tests__/vite-plugin.test.ts
git commit -m "feat(sdk): plugin reads the upload URL from the endpoint-bearing key"
```

---

### Task 4: Secret hygiene audit + missing surfaces

**Files:**
- Modify: `packages/worker/src/harness/redact.ts` (add credential family)
- Modify: `packages/worker/src/repo-clone.ts` (child-env denylist: add `OPSLANE_SOURCEMAP_KEY`; locate the env construction for spawned git/agent processes and exclude it)
- Modify: `packages/ingestion/handler/admin.go` (`secretRedactors`: add the family)
- Modify: `scripts/docs-sync/publish.mjs` (raw-key fingerprints)
- Test: colocated tests per surface with realistic canaries

**Interfaces:**
- The canary: a full new-format key built from the fixture's first valid
  vector (`vectors.valid[0].raw`) — every surface must swallow the WHOLE
  key including payload, not truncate at the secret.

- [x] **Step 1: Failing canary tests**

- `redact.ts` test: `scrubSecrets(\`clone failed for ${CANARY}\`)` contains
  neither the secret nor the payload substring.
- `admin.go` test: `redactAdminError` on a string embedding the canary
  yields `[REDACTED]` with no `opslane_sk_` remnant.
- Audit-only assertions (already-tolerant patterns): masking.go test with
  the canary (pattern `opslane_(pk|sk)_[A-Za-z0-9_-]+` — greedy tail
  swallows the payload; assert it), `envfile.ts` refusal test with the
  canary, gitleaks: add the canary (with the fixture keyid) to the scanner
  test corpus if one exists, else verify `.gitleaks.toml`'s allowlist
  comment still holds and add a note.
- `publish.mjs`: extend its pattern list with
  `/opslane_(?:pk|sk)_[A-Za-z0-9_-]{26}_[A-Za-z0-9_-]+/` and a test that a
  doc containing the canary is refused.
- `repo-clone.ts` test: the spawned-process env (however the module exposes
  it for testing; add a small seam if none exists) lacks
  `OPSLANE_SOURCEMAP_KEY` when the parent env carries it.

- [x] **Step 2: Implement the four changes; run all three package suites; commit**

```bash
git add packages/worker/src/ packages/ingestion/handler/ packages/ingestion/masking/ cli/src/ scripts/docs-sync/
git commit -m "fix(hygiene): endpoint-bearing keys scrubbed on every secret surface"
```

---

### Task 5: Cutover — fixtures, E2E, docs, amendment

**Files:**
- Modify: `test-e2e/helpers.ts` — this is the WHOLE runtime cutover: `sourcemap-resolution.test.ts` mints tenants at runtime through `mintProjectKey`/`seedProjectSourceMapKey` (helpers.ts:86+; there are no SK_A/SK_B constants anymore). The sourcemaps branch appends a payload for the stack URL (`http://localhost:8082`, loopback-allowed), built with the same unpadded-base64url JSON the TS decoder validates; `iat` may be `new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')` (tests never compare it, but it must be Z-suffixed to pass validation).
- Modify: `scripts/seed-e2e.sql` (comments document new-format raw examples; stored hashes unchanged since the secret component is unchanged)
- Modify: `test-e2e/build-helpers.ts` (stop SETTING `OPSLANE_ENDPOINT`; keep it in the managed-clear list so ambient values cannot leak in)
- Modify: `docs/design/2026-07-29-keys-sourcemaps-s0-contracts.md` (§3 amendment note: sk grammar gains the trailing payload; bare sks remain valid server credentials; nothing mints them)
- Modify: `docker-compose.yml` (ingestion service: pass through `OPSLANE_PUBLIC_INGEST_URL` with a sensible compose default, e.g. `http://localhost:8082`) and `.env.example` (document it)
- Modify: docs, complete inventory: `docs/guides/source-maps.md`, `docs/reference/environment-variables.md` (add `OPSLANE_PUBLIC_INGEST_URL`, delete `OPSLANE_ENDPOINT`), `docs/reference/sdk-options.md`, `packages/sdk/README.md:~68`, `docs/install.md:~38`, `docs/guides/source-maps-migration.md:~11`, `docs/guides/vue.md:~64` — every current-doc mention of the two-var pair becomes the one-key story
- Test: full gates + live E2E

**Interfaces:** consumes everything above.

- [x] **Step 1: Fixture and doc edits as listed**

Grep gate for the dead variable — TARGETED, because (a) historical
plans/ADRs legitimately mention it and (b) the Python SDK has its own
`OPSLANE_ENDPOINT` runtime variable that is a DIFFERENT, unaffected
contract (see `test-e2e/python-smoke.test.ts:175`) and must not be touched:
```bash
grep -rn "\bOPSLANE_ENDPOINT\b" packages/sdk test-e2e/build-helpers.ts test-e2e/helpers.ts docs/guides docs/reference docs/install.md \
  | grep -v node_modules | grep -v VITE_OPSLANE_ENDPOINT | grep -v CHANGELOG
```
Expected surviving hits, each individually justified: the plugin's
`OPSLANE_VITE_ENDPOINT_REMOVED` warning path and `build-helpers.ts`'s
managed-CLEAR list (protects against ambient values; never sets it) — and
nothing else. Two pre-existing stragglers must be FIXED in Task 3, not
excused: the stale removal-note comment at the bottom of
`packages/sdk/vite-plugin/index.ts` (~line 663, still describes the
two-var flow) is rewritten for the one-key story. `VITE_OPSLANE_ENDPOINT`
(the browser SDK's runtime endpoint) and the Python SDK's variable are
different contracts and stay untouched.

- [x] **Step 2: Full verification**

- Go container: `go build ./... && go test ./...` (DB-backed included).
- `pnpm -r build` then `pnpm --filter @opslane/sdk test`, `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`, `pnpm --filter @opslane/cli test` (envfile canary lives there).
- Repo-wide: `pnpm test:repo` (docs-sync publisher test) and `node scripts/check-docs-drift.mjs`.
- `docker compose config --quiet`.
- Gitleaks: run the same pinned command CI uses (see `.github/workflows/ci.yml`'s gitleaks step) against the working tree; expected clean because every canary reuses the allowlisted `mzxw...` fixture key ID. If any new path still trips, extend `.gitleaks.toml`'s path allowlist for `test-fixtures/sourcemap-key/` explicitly rather than weakening the rule.
- Live: rebuild compose ingestion+worker, seed, run
  `npx vitest run sourcemap-resolution` in `test-e2e` — 3/3.
- Live negative: build the fixture with a BARE sk in `OPSLANE_SOURCEMAP_KEY`
  → build log shows `OPSLANE_VITE_KEY_INVALID`, zero uploads.
- mint-key live: `-scope sourcemaps -endpoint http://localhost:8082` →
  printed key parses (TS + Go), uploads 201 against the stack.

- [x] **Step 3: Commit**

```bash
git add test-e2e/ scripts/seed-e2e.sql docs/ docker-compose.yml .env.example packages/sdk/README.md
git commit -m "feat!: hard cutover to endpoint-bearing source-map keys"
```

---

### Task 6: Production cutover (operator runbook — requires prod access, run after merge+deploy)

Not executable from this repo; recorded so R8 is complete and auditable.

- [ ] Deploy the release containing Tasks 1-5 (server accepts both formats, so order-safe).
- [ ] Set `OPSLANE_PUBLIC_INGEST_URL=https://<prod ingest origin>` on the prod ingestion service.
- [ ] Re-mint, per project (AMFJ 2, smoke): `go run ./cmd/mint-key -project <uuid> -scope sourcemaps` (endpoint from the env). Record each new key's key ID and the OLD key IDs.
- [ ] Update CI: AMFJ 2's `OPSLANE_SOURCEMAP_KEY`, and the smoke project's stored key; delete `OPSLANE_ENDPOINT` from both.
- [ ] Trigger one deploy of AMFJ 2; confirm the build log shows `Uploaded N/N source maps` and `sourcemap_files` gains rows.
- [ ] EXPLICITLY REVOKE the old key IDs (`UPDATE project_api_keys SET revoked_at = now() WHERE key_id IN ('<old-1>', '<old-2>');`).
- [ ] Probe: an upload with either old key returns 401.

---

## Self-Review Notes

- Spec coverage: format+offsets+caps → Task 1; unconstructable bare sk +
  validate-before-insert minting → Task 2; one-var plugin + redirect:error +
  three warning states → Task 3; all seven hygiene surfaces → Task 4 (three
  changed, four audited-with-canaries); cutover inventory incl. E2E fixtures,
  seeds, docs, §3 amendment → Task 5. Deploy-order safety comes free: server
  accepts bare keys, so no ordering constraint exists inside this branch.
- Type consistency: `NewProjectKey(scope, endpoint string)` used identically
  in Tasks 1-2; `parseSourceMapKey` return shape consistent in Task 3;
  vector fixture semantics defined once (Task 1 Step 1) and referenced by
  both suites.
- Deliberate divergence documented: bare sk = server-valid, plugin-rejected
  (`acceptedByServer` flag in the fixture).
