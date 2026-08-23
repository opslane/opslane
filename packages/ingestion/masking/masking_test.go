package masking_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/masking"
)

// ---------------------------------------------------------------------------
// RedactHeaders
// ---------------------------------------------------------------------------

func TestRedactHeaders_SensitiveHeadersRedacted(t *testing.T) {
	headers := map[string]string{
		"Authorization":        "Bearer sk_live_abc123",
		"Proxy-Authorization":  "Basic xyz",
		"Authentication":       "secret",
		"Cookie":               "session=xyz",
		"Set-Cookie":           "session=xyz; HttpOnly",
		"X-Api-Key":            "key-12345",
		"X-CSRF-Token":         "csrf-value",
		"X-Auth-Token":         "auth-value",
		"X-Access-Token":       "access-value",
		"X-Amz-Security-Token": "aws-value",
		"Private-Token":        "gitlab-value",
		"X-Gitlab-Token":       "gitlab-hook-value",
		"X-Vault-Token":        "vault-value",
		"X-Goog-Api-Key":       "goog-value",
		"X-Refresh-Token":      "refresh-value",
		"X-Session-Token":      "session-token-value",
		"X-Session-Id":         "session-id-value",
		"Content-Type":         "application/json",
	}

	got := masking.RedactHeaders(headers)

	sensitive := []string{
		"Authorization", "Proxy-Authorization", "Authentication", "Cookie",
		"Set-Cookie", "X-Api-Key", "X-CSRF-Token", "X-Auth-Token",
		"X-Access-Token", "X-Amz-Security-Token", "Private-Token",
		"X-Gitlab-Token", "X-Vault-Token", "X-Goog-Api-Key",
		"X-Refresh-Token", "X-Session-Token", "X-Session-Id",
	}
	for _, key := range sensitive {
		if got[key] != "[REDACTED]" {
			t.Errorf("RedactHeaders[%q] = %q, want %q", key, got[key], "[REDACTED]")
		}
	}
}

func TestRedactHeaders_SafeHeadersUntouched(t *testing.T) {
	headers := map[string]string{
		"Content-Type": "application/json",
		"Accept":       "text/html",
		"User-Agent":   "OpslaneSDK/1.0",
	}

	got := masking.RedactHeaders(headers)

	for key, want := range headers {
		if got[key] != want {
			t.Errorf("RedactHeaders[%q] = %q, want %q", key, got[key], want)
		}
	}
}

// ---------------------------------------------------------------------------
// RedactBody
// ---------------------------------------------------------------------------

func TestRedactBody_APIKeyPrefixes(t *testing.T) {
	cases := []struct {
		name  string
		input string
	}{
		{"sk_live", `config: sk_live_abcdef1234567890`},
		{"sk_test", `key=sk_test_ABCDEFGHIJK`},
		{"AKIA", `aws_key: AKIAIOSFODNN7EXAMPLE`},
		{"ghp", `token: ghp_ABCDEFghijkl12345678`},
		{"gho", `oauth: gho_xyz123456789`},
		{"def", `ingest_key: def_keyvalue99`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := masking.RedactBody(tc.input)
			if strings.Contains(got, tc.name+"_") && tc.name != "AKIA" {
				// For prefix-style keys the prefix itself should be gone.
				t.Errorf("RedactBody still contains key material for %s: %s", tc.name, got)
			}
			if !strings.Contains(got, "[REDACTED]") {
				t.Errorf("RedactBody did not insert [REDACTED] for %s: %s", tc.name, got)
			}
		})
	}
}

func TestRedactsProjectKeys(t *testing.T) {
	cases := map[string]string{
		"public key": "opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_aB-_cD3fGhIjKlMnOpQrStUvWxYz0123456789",
		"secret key": "opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_aB-_cD3fGhIjKlMnOpQrStUvWxYz0123456789",
		"api key":    "opslane_ak_mzxw6ytboi3damrrgi3tknzxgq_aB-_cD3fGhIjKlMnOpQrStUvWxYz0123456789",
		"legacy key": "def_2f1c9a44-1b3e-4f4a-9c7a-4b2d8e6f0a11",
		// vectors.valid[0].raw from test-fixtures/sourcemap-key/vectors.json.
		// The greedy tail must swallow the trailing payload too, not stop at
		// the secret.
		"endpoint-bearing secret key": "opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA" +
			"_eyJ2IjoxLCJpYXQiOiIyMDI2LTA4LTA0VDAwOjAwOjAwWiIsInVybCI6Imh0dHBzOi8vaW5nZXN0Lm9wc2xhbmUuY29tIn0",
	}
	for name, key := range cases {
		t.Run(name, func(t *testing.T) {
			got := masking.RedactBody("token=" + key + " end")
			if strings.Contains(got, key) {
				t.Errorf("key survived redaction: %q", got)
			}
			if tail := key[len(key)-8:]; strings.Contains(got, tail) {
				t.Errorf("key tail %q survived redaction: %q", tail, got)
			}
		})
	}
}

func TestRedactBody_PasswordFields(t *testing.T) {
	cases := []struct {
		name  string
		input string
		field string
	}{
		{
			"password",
			`{"username":"alice","password":"secret123"}`,
			"password",
		},
		{
			"passwd",
			`{"passwd":"hunter2","user":"bob"}`,
			"passwd",
		},
		{
			"secret",
			`{"secret":"s3cr3t_v4lu3","app":"myapp"}`,
			"secret",
		},
		{
			"token",
			`{"token":"tok_abcdef","id":1}`,
			"token",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := masking.RedactBody(tc.input)
			// The key should still be present.
			if !strings.Contains(got, `"`+tc.field+`"`) {
				t.Errorf("RedactBody removed the key %q itself: %s", tc.field, got)
			}
			// The original secret value should be gone.
			if strings.Contains(got, "secret123") ||
				strings.Contains(got, "hunter2") ||
				strings.Contains(got, "s3cr3t_v4lu3") ||
				strings.Contains(got, "tok_abcdef") {
				t.Errorf("RedactBody did not redact value for %q: %s", tc.field, got)
			}
			// [REDACTED] should appear as the replacement value.
			if !strings.Contains(got, `"[REDACTED]"`) {
				t.Errorf("RedactBody did not insert [REDACTED] for %q: %s", tc.field, got)
			}
		})
	}
}

func TestRedactBody_CaseInsensitiveKeyPrefix(t *testing.T) {
	// AKIA is uppercase in the regex but should also match as written.
	input := `access_key: AKIAIOSFODNN7EXAMPLE`
	got := masking.RedactBody(input)
	if strings.Contains(got, "AKIAIOSFODNN7EXAMPLE") {
		t.Errorf("expected AKIA key to be redacted, got: %s", got)
	}
}

func TestRedactBody_JWT(t *testing.T) {
	jwt := "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
	got := masking.RedactBody("Authorization: Bearer " + jwt)
	if strings.Contains(got, jwt) {
		t.Errorf("RedactBody leaked a JWT: %s", got)
	}
	if !strings.Contains(got, "[REDACTED]") {
		t.Errorf("RedactBody did not insert [REDACTED] for JWT: %s", got)
	}
}

func TestRedactURL(t *testing.T) {
	cases := []struct {
		name   string
		in     string
		leaked []string
	}{
		{"basic-auth", "see https://alice:s3cr3t@api.example.com/x", []string{"alice", "s3cr3t"}},
		{"token-query", "https://api.example.com/cb?access_token=ghp_abc123&ok=1", []string{"ghp_abc123"}},
		{"api-key-query", "https://x.io/a?api_key=def_zzz&page=2", []string{"def_zzz"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := masking.RedactURL(tc.in)
			for _, s := range tc.leaked {
				if strings.Contains(got, s) {
					t.Errorf("RedactURL leaked %q: %s", s, got)
				}
			}
			if !strings.Contains(got, "[REDACTED]") {
				t.Errorf("RedactURL did not insert [REDACTED]: %s", got)
			}
		})
	}
	if got := masking.RedactURL("https://x.io/a?page=2&ok=1"); !strings.Contains(got, "page=2") {
		t.Errorf("RedactURL clobbered a safe param: %s", got)
	}
}

func TestRedactRequestURL(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"drops the whole query string", "https://api.example.com/v1/search?q=hi&token=abc", "https://api.example.com/v1/search"},
		{"drops userinfo", "https://user:pw@api.example.com/v1/search", "https://api.example.com/v1/search"},
		{"drops a token-bearing fragment", "https://api.example.com/cb#access_token=abc", "https://api.example.com/cb"},
		{"drops a prefixed token fragment", "https://api.example.com/cb#oauth_access_token=abc", "https://api.example.com/cb"},
		{"keeps a route fragment", "https://app.example.com/x#/dashboard", "https://app.example.com/x#/dashboard"},
		{"leaves a clean URL alone", "https://api.example.com/v1/items", "https://api.example.com/v1/items"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := masking.RedactRequestURL(tc.in); got != tc.want {
				t.Fatalf("RedactRequestURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestRedactRequestURLUnparseable(t *testing.T) {
	got := masking.RedactRequestURL("://not a url?token=abc")
	if strings.Contains(got, "abc") {
		t.Fatalf("RedactRequestURL leaked a token: %q", got)
	}
	if got := masking.RedactRequestURL("https://a.test/%zz?email=user@example.com"); strings.Contains(got, "user@example.com") {
		t.Fatalf("RedactRequestURL leaked a malformed URL query: %q", got)
	}
}

func TestRedactContext(t *testing.T) {
	in := []byte(`{"user":{"id":"u1","email":"a@b.com"},"auth":{"Authorization":"Bearer ghp_tok123"},"note":"key sk_live_zzz here","url":"https://u:p@h/x","n":7}`)
	out := masking.RedactContext(in)
	s := string(out)
	for _, leak := range []string{"ghp_tok123", "sk_live_zzz", "u:p@h"} {
		if strings.Contains(s, leak) {
			t.Errorf("RedactContext leaked %q: %s", leak, s)
		}
	}
	if !strings.Contains(s, "a@b.com") || !strings.Contains(s, `"id":"u1"`) {
		t.Errorf("RedactContext clobbered safe fields: %s", s)
	}
	if got := string(masking.RedactContext([]byte("not json"))); got != "not json" {
		t.Errorf("RedactContext mangled non-JSON: %q", got)
	}
}

// ---------------------------------------------------------------------------
// RedactBreadcrumbs -- integration-level
// ---------------------------------------------------------------------------

func TestSensitiveFieldsAreRedacted(t *testing.T) {
	breadcrumbs := []map[string]interface{}{
		{
			"type":      "http",
			"category":  "xhr",
			"timestamp": 1700000000,
			"data": map[string]string{
				"url":           "https://api.example.com/users",
				"method":        "POST",
				"Authorization": "Bearer sk_live_supersecret123",
				"Cookie":        "session=abc123",
				"Content-Type":  "application/json",
			},
		},
		{
			"type":      "http",
			"category":  "fetch",
			"timestamp": 1700000001,
			"data": map[string]string{
				"url":       "https://api.example.com/login",
				"method":    "POST",
				"X-Api-Key": "ghp_tokenvalue1234",
			},
		},
		{
			"type":      "console",
			"category":  "log",
			"timestamp": 1700000002,
			"data": map[string]string{
				"message": "all good",
			},
		},
	}

	raw, err := json.Marshal(breadcrumbs)
	if err != nil {
		t.Fatalf("marshal breadcrumbs: %v", err)
	}

	redacted := masking.RedactBreadcrumbs(raw)

	// Parse back to verify.
	var result []map[string]json.RawMessage
	if err := json.Unmarshal(redacted, &result); err != nil {
		t.Fatalf("unmarshal redacted breadcrumbs: %v", err)
	}

	// Verify first breadcrumb data.
	var data0 map[string]string
	if err := json.Unmarshal(result[0]["data"], &data0); err != nil {
		t.Fatalf("unmarshal data[0]: %v", err)
	}
	if data0["Authorization"] != "[REDACTED]" {
		t.Errorf("breadcrumb[0] Authorization = %q, want [REDACTED]", data0["Authorization"])
	}
	if data0["Cookie"] != "[REDACTED]" {
		t.Errorf("breadcrumb[0] Cookie = %q, want [REDACTED]", data0["Cookie"])
	}
	if data0["Content-Type"] != "application/json" {
		t.Errorf("breadcrumb[0] Content-Type = %q, want application/json", data0["Content-Type"])
	}
	// The URL value should remain (not sensitive header).
	if data0["url"] != "https://api.example.com/users" {
		t.Errorf("breadcrumb[0] url = %q, want https://api.example.com/users", data0["url"])
	}

	// Verify second breadcrumb data.
	var data1 map[string]string
	if err := json.Unmarshal(result[1]["data"], &data1); err != nil {
		t.Fatalf("unmarshal data[1]: %v", err)
	}
	if data1["X-Api-Key"] != "[REDACTED]" {
		t.Errorf("breadcrumb[1] X-Api-Key = %q, want [REDACTED]", data1["X-Api-Key"])
	}

	// Verify third breadcrumb data is untouched.
	var data2 map[string]string
	if err := json.Unmarshal(result[2]["data"], &data2); err != nil {
		t.Fatalf("unmarshal data[2]: %v", err)
	}
	if data2["message"] != "all good" {
		t.Errorf("breadcrumb[2] message = %q, want 'all good'", data2["message"])
	}

	// Global assertion: no raw secret material should survive.
	redactedStr := string(redacted)
	leaked := []string{
		"sk_live_supersecret123",
		"session=abc123",
		"ghp_tokenvalue1234",
	}
	for _, secret := range leaked {
		if strings.Contains(redactedStr, secret) {
			t.Errorf("redacted breadcrumbs still contain %q", secret)
		}
	}
}

func TestRedactBreadcrumbs_NilAndEmpty(t *testing.T) {
	if got := masking.RedactBreadcrumbs(nil); got != nil {
		t.Errorf("RedactBreadcrumbs(nil) = %v, want nil", got)
	}
	if got := masking.RedactBreadcrumbs([]byte{}); len(got) != 0 {
		t.Errorf("RedactBreadcrumbs(empty) = %v, want empty", got)
	}
}

func TestRedactBreadcrumbs_InvalidJSON(t *testing.T) {
	bad := []byte(`not json at all`)
	got := masking.RedactBreadcrumbs(bad)
	if string(got) != string(bad) {
		t.Errorf("RedactBreadcrumbs(invalid) modified input: got %q", string(got))
	}
}

func TestRedactBreadcrumbs_MixedTypeData(t *testing.T) {
	// Breadcrumb where data has non-string values (int, bool) alongside
	// sensitive header keys. The sensitive keys must still be redacted.
	breadcrumbs := []map[string]interface{}{
		{
			"type":     "http",
			"category": "xhr",
			"data": map[string]interface{}{
				"Authorization": "Bearer sk_live_secret999",
				"Cookie":        "session=leaked",
				"status_code":   200,
				"ok":            true,
				"Content-Type":  "application/json",
			},
		},
	}

	raw, err := json.Marshal(breadcrumbs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	redacted := masking.RedactBreadcrumbs(raw)
	redactedStr := string(redacted)

	if strings.Contains(redactedStr, "sk_live_secret999") {
		t.Errorf("Authorization value not redacted: %s", redactedStr)
	}
	if strings.Contains(redactedStr, "session=leaked") {
		t.Errorf("Cookie value not redacted: %s", redactedStr)
	}
	// Non-sensitive fields should survive
	if !strings.Contains(redactedStr, "application/json") {
		t.Errorf("Content-Type value was incorrectly redacted: %s", redactedStr)
	}
	if !strings.Contains(redactedStr, "200") {
		t.Errorf("status_code value was incorrectly redacted: %s", redactedStr)
	}
}

func TestRedactBreadcrumbs_APIKeysInValues(t *testing.T) {
	// Breadcrumb where a non-header-name field value contains an API key.
	breadcrumbs := []map[string]interface{}{
		{
			"type":     "http",
			"category": "xhr",
			"data": map[string]string{
				"body": `{"api_key":"def_abcdef12345","user":"test"}`,
			},
		},
	}

	raw, err := json.Marshal(breadcrumbs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	redacted := masking.RedactBreadcrumbs(raw)
	if strings.Contains(string(redacted), "def_abcdef12345") {
		t.Errorf("API key in breadcrumb value was not redacted: %s", string(redacted))
	}
}

func TestRedactBreadcrumbs_NestedHeaders(t *testing.T) {
	// Secrets nested below the top level of "data" (e.g. data.request.headers.*)
	// must be redacted too, not just top-level keys.
	breadcrumbs := []map[string]interface{}{
		{
			"type": "http",
			"data": map[string]interface{}{
				"request": map[string]interface{}{
					"headers": map[string]interface{}{
						"Authorization": "Bearer xoxb-prod-secret",
						"Cookie":        "sid=prodsecret",
					},
				},
			},
		},
	}
	raw, err := json.Marshal(breadcrumbs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(masking.RedactBreadcrumbs(raw))
	for _, leak := range []string{"xoxb-prod-secret", "sid=prodsecret"} {
		if strings.Contains(got, leak) {
			t.Errorf("nested secret %q survived breadcrumb redaction: %s", leak, got)
		}
	}
}

func TestRedactRecording(t *testing.T) {
	rec := []byte(`{"events":[{"type":2,"timestamp":1,"data":{"access_token":"xoxb-prod-secret","headers":{"Authorization":"Bearer xoxb-prod-secret"},"note":"ghp_recleak1","ok":true}}],"meta":{"page_url":"https://u:pw@h/x?access_token=tok123"}}`)
	got := string(masking.RedactRecording(rec))
	for _, leak := range []string{"xoxb-prod-secret", "ghp_recleak1", "u:pw@h", "tok123"} {
		if strings.Contains(got, leak) {
			t.Errorf("recording leak %q survived: %s", leak, got)
		}
	}
	if !json.Valid([]byte(got)) {
		t.Errorf("RedactRecording produced invalid JSON: %s", got)
	}
	// Non-secret structure must survive.
	if !strings.Contains(got, `"type":2`) || !strings.Contains(got, "true") {
		t.Errorf("RedactRecording clobbered non-secret structure: %s", got)
	}
	// Non-JSON input falls back to string-level redaction (never returned verbatim).
	if out := string(masking.RedactRecording([]byte("token ghp_rawleak2 here"))); strings.Contains(out, "ghp_rawleak2") {
		t.Errorf("non-JSON recording not redacted: %s", out)
	}
}

func TestRedactBreadcrumbs_RedactsFieldsOutsideData(t *testing.T) {
	raw := []byte(`[{"type":"http","message":"token ghp_topLevelSecret123","headers":{"Authorization":"Bearer xoxb-top-secret"}}]`)
	got := string(masking.RedactBreadcrumbs(raw))
	for _, leak := range []string{"ghp_topLevelSecret123", "xoxb-top-secret"} {
		if strings.Contains(got, leak) {
			t.Errorf("secret %q outside data survived breadcrumb redaction: %s", leak, got)
		}
	}
	if !strings.Contains(got, `"type":"http"`) {
		t.Errorf("benign field clobbered: %s", got)
	}
}

func TestRedactBreadcrumbs_PreservesLargeIntegers(t *testing.T) {
	raw := []byte(`[{"timestamp_ns":1721430000123456789,"data":{"status_code":200}}]`)
	got := string(masking.RedactBreadcrumbs(raw))
	if !strings.Contains(got, "1721430000123456789") {
		t.Errorf("int64-scale value lost precision through redaction: %s", got)
	}
	if !strings.Contains(got, "200") {
		t.Errorf("numeric data field clobbered: %s", got)
	}
}

func TestRedactURL_NonHTTPSchemes(t *testing.T) {
	for _, tc := range []struct{ in, leak string }{
		{"connect to postgres://svc:dbpassword1@db.internal/app failed", "dbpassword1"},
		{"redis://default:cachepw2@cache:6379 timed out", "cachepw2"},
		{"amqp://guest:queuepw3@mq/vhost unreachable", "queuepw3"},
	} {
		got := masking.RedactURL(tc.in)
		if strings.Contains(got, tc.leak) {
			t.Errorf("RedactURL leaked DSN credential %q: %s", tc.leak, got)
		}
	}
}
