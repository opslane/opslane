package db

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// skVectorsPath is shared with the TypeScript decoder suite: both sides prove
// the same grammar against the same bytes.
const skVectorsPath = "../../../test-fixtures/sourcemap-key/vectors.json"

// skFixtureBareKey is the prefix+keyid+secret every constructed vector builds
// on. The key id and secret are the frozen fixture pair allowlisted in
// .gitleaks.toml.
const skFixtureBareKey = "opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA"

type skVectorValid struct {
	Name      string `json:"name"`
	Keyid     string `json:"keyid"`
	Secret    string `json:"secret"`
	Endpoint  string `json:"endpoint"`
	Canonical string `json:"canonical"`
	IAT       string `json:"iat"`
	Raw       string `json:"raw"`
}

// skVectorInvalid carries every construction field the fixture may use. A
// vector sets exactly one of them; buildSKVector turns it into either a full
// raw key or a bare payload segment.
type skVectorInvalid struct {
	Name             string          `json:"name"`
	Reason           string          `json:"reason"`
	AcceptedByServer bool            `json:"acceptedByServer"`
	Raw              string          `json:"raw"`
	RawSuffix        string          `json:"rawSuffix"`
	Payload          string          `json:"payload"`
	PayloadOf        string          `json:"payloadOf"`
	Padded           bool            `json:"padded"`
	PayloadJSON      json.RawMessage `json:"payloadJson"`
	PayloadRawJSON   string          `json:"payloadRawJson"`
	OversizeTo       int             `json:"oversizeTo"`
	URLOfLength      int             `json:"urlOfLength"`
}

type skVectors struct {
	Valid          []skVectorValid   `json:"valid"`
	DecoderInvalid []skVectorInvalid `json:"decoderInvalid"`
	EncoderInvalid []struct {
		Endpoint string `json:"endpoint"`
		Reason   string `json:"reason"`
	} `json:"encoderInvalid"`
}

func loadSKVectors(t *testing.T) skVectors {
	t.Helper()
	data, err := os.ReadFile(skVectorsPath)
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v skVectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(v.Valid) == 0 || len(v.DecoderInvalid) == 0 || len(v.EncoderInvalid) == 0 {
		t.Fatalf("vectors file is missing a suite: %d valid, %d decoderInvalid, %d encoderInvalid",
			len(v.Valid), len(v.DecoderInvalid), len(v.EncoderInvalid))
	}
	return v
}

type skTarget int

const (
	// targetRawKey routes a vector at ParseProjectKey, which must fail
	// opaquely: the auth layer never names which part of a credential lost.
	targetRawKey skTarget = iota
	// targetPayload routes a vector at ParseSKPayload, whose errors carry a
	// reason token prefix so the plugin can explain the failure.
	targetPayload
)

// buildSKVector is the single construction helper every decoderInvalid vector
// goes through, so a fixture entry cannot silently skip the suite.
func buildSKVector(t *testing.T, vec skVectorInvalid) (skTarget, string) {
	t.Helper()
	switch {
	case vec.Raw != "":
		return targetRawKey, vec.Raw
	case vec.RawSuffix != "":
		return targetRawKey, skFixtureBareKey + vec.RawSuffix
	case vec.OversizeTo > 0:
		pad := vec.OversizeTo - len(skFixtureBareKey) - 1
		if pad < 1 {
			t.Fatalf("%s: oversizeTo %d is not longer than the bare key", vec.Name, vec.OversizeTo)
		}
		return targetRawKey, skFixtureBareKey + "_" + strings.Repeat("A", pad)
	case vec.Payload != "":
		return targetPayload, vec.Payload
	case vec.PayloadOf != "":
		if vec.Padded {
			return targetPayload, base64.URLEncoding.EncodeToString([]byte(vec.PayloadOf))
		}
		return targetPayload, base64.RawURLEncoding.EncodeToString([]byte(vec.PayloadOf))
	case vec.PayloadRawJSON != "":
		// Verbatim: minifying would collapse the duplicate keys under test.
		return targetPayload, base64.RawURLEncoding.EncodeToString([]byte(vec.PayloadRawJSON))
	case len(vec.PayloadJSON) > 0:
		var minified bytes.Buffer
		if err := json.Compact(&minified, vec.PayloadJSON); err != nil {
			t.Fatalf("%s: minify payloadJson: %v", vec.Name, err)
		}
		return targetPayload, base64.RawURLEncoding.EncodeToString(minified.Bytes())
	case vec.URLOfLength > 0:
		const scheme, tld = "https://", ".example"
		fill := vec.URLOfLength - len(scheme) - len(tld)
		if fill < 1 {
			t.Fatalf("%s: urlOfLength %d is too short", vec.Name, vec.URLOfLength)
		}
		long := scheme + strings.Repeat("a", fill) + tld
		body, err := json.Marshal(SKPayload{V: 1, IAT: "2026-08-04T00:00:00Z", URL: long})
		if err != nil {
			t.Fatalf("%s: marshal long url payload: %v", vec.Name, err)
		}
		return targetPayload, base64.RawURLEncoding.EncodeToString(body)
	}
	t.Fatalf("%s: vector has no construction field", vec.Name)
	return targetPayload, ""
}

func TestEncodeSKPayloadMatchesVectors(t *testing.T) {
	for _, vec := range loadSKVectors(t).Valid {
		canonical, err := CanonicalIngestURL(vec.Endpoint)
		if err != nil {
			t.Fatalf("%s: canonicalize: %v", vec.Name, err)
		}
		want := vec.Canonical
		if want == "" {
			want = vec.Endpoint
		}
		if canonical != want {
			t.Fatalf("%s: canonical = %q, want %q", vec.Name, canonical, want)
		}
		iat, err := time.Parse(time.RFC3339, vec.IAT)
		if err != nil {
			t.Fatalf("%s: fixture iat: %v", vec.Name, err)
		}
		payload, err := EncodeSKPayload(canonical, iat)
		if err != nil {
			t.Fatalf("%s: encode: %v", vec.Name, err)
		}
		raw := "opslane_sk_" + vec.Keyid + "_" + vec.Secret + "_" + payload
		if raw != vec.Raw {
			t.Fatalf("%s: raw mismatch\n got %s\nwant %s", vec.Name, raw, vec.Raw)
		}
	}
}

func TestParseSKPayloadRoundTripsVectors(t *testing.T) {
	for _, vec := range loadSKVectors(t).Valid {
		// Fixed offset, not LastIndex: a base64url payload may itself contain '_'.
		segment := vec.Raw[len("opslane_sk_")+len(vec.Keyid)+1+len(vec.Secret)+1:]
		payload, err := ParseSKPayload(segment)
		if err != nil {
			t.Fatalf("%s: parse payload: %v", vec.Name, err)
		}
		want := vec.Canonical
		if want == "" {
			want = vec.Endpoint
		}
		if payload.V != 1 || payload.IAT != vec.IAT || payload.URL != want {
			t.Fatalf("%s: payload = %+v, want v=1 iat=%q url=%q", vec.Name, payload, vec.IAT, want)
		}
	}
}

func TestParseProjectKeyAcceptsVectorRaws(t *testing.T) {
	for _, vec := range loadSKVectors(t).Valid {
		parsed, err := ParseProjectKey(vec.Raw)
		if err != nil {
			t.Fatalf("%s: parse: %v", vec.Name, err)
		}
		if parsed.KeyID != vec.Keyid || parsed.Secret != vec.Secret || parsed.Scope != ScopeSourcemaps {
			t.Fatalf("%s: parsed wrong identity: %+v", vec.Name, parsed)
		}
	}
	// Bare sk still parses at the server (routing is a client concern).
	if _, err := ParseProjectKey(skFixtureBareKey); err != nil {
		t.Fatalf("bare sk must stay server-valid: %v", err)
	}
	// pk with a payload is refused.
	pkPayload := "opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq_eyJ2IjoxfQ"
	if _, err := ParseProjectKey(pkPayload); err == nil {
		t.Fatal("payload on pk must be rejected")
	}
	// Length cap fires before decode.
	long := skFixtureBareKey + "_" + strings.Repeat("A", MaxRawKeyLen)
	if _, err := ParseProjectKey(long); err == nil {
		t.Fatal("oversize must be rejected")
	}
	// Empty trailing payload is refused.
	if _, err := ParseProjectKey(skFixtureBareKey + "_"); err == nil {
		t.Fatal("empty payload must be rejected")
	}
}

func TestParseSKPayloadRejectsInvalid(t *testing.T) {
	for _, vec := range loadSKVectors(t).DecoderInvalid {
		t.Run(vec.Name, func(t *testing.T) {
			target, value := buildSKVector(t, vec)
			switch target {
			case targetRawKey:
				_, err := ParseProjectKey(value)
				if vec.AcceptedByServer {
					if err != nil {
						t.Fatalf("server must accept this key: %v", err)
					}
					return
				}
				if err == nil {
					t.Fatalf("ParseProjectKey must reject %s", vec.Name)
				}
				if err.Error() != "malformed key" {
					t.Fatalf("auth-layer error must stay opaque, got %q", err)
				}
			case targetPayload:
				_, err := ParseSKPayload(value)
				if err == nil {
					t.Fatalf("ParseSKPayload must reject %s", vec.Name)
				}
				if !strings.HasPrefix(err.Error(), vec.Reason+": ") {
					t.Fatalf("error %q must start with reason token %q", err, vec.Reason)
				}
			}
		})
	}
	// The empty-payload reason token is only reachable through the codec: the
	// auth layer folds it into "malformed key".
	if _, err := ParseSKPayload(""); err == nil || !strings.HasPrefix(err.Error(), "empty_payload: ") {
		t.Fatalf("empty segment error = %v, want empty_payload prefix", err)
	}
}

func TestCanonicalIngestURLRejectsInvalid(t *testing.T) {
	for _, vec := range loadSKVectors(t).EncoderInvalid {
		_, err := CanonicalIngestURL(vec.Endpoint)
		if err == nil {
			t.Fatalf("CanonicalIngestURL(%q) must fail", vec.Endpoint)
		}
		if !strings.HasPrefix(err.Error(), vec.Reason+": ") {
			t.Fatalf("CanonicalIngestURL(%q) error %q must start with reason token %q",
				vec.Endpoint, err, vec.Reason)
		}
	}
}

func TestEncodeSKPayloadRequiresCanonicalURL(t *testing.T) {
	iat := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	if _, err := EncodeSKPayload("https://ingest.opslane.com:443/", iat); err == nil {
		t.Fatal("non-canonical URL must be rejected by the encoder")
	}
}

func TestEncodeSKPayloadNormalizesIATToUTC(t *testing.T) {
	zone := time.FixedZone("CET", 3600)
	segment, err := EncodeSKPayload("https://ingest.opslane.com",
		time.Date(2026, 8, 4, 1, 0, 0, 0, zone))
	if err != nil {
		t.Fatal(err)
	}
	payload, err := ParseSKPayload(segment)
	if err != nil {
		t.Fatal(err)
	}
	if payload.IAT != "2026-08-04T00:00:00Z" {
		t.Fatalf("iat = %q, want the Z-suffixed UTC instant", payload.IAT)
	}
}
