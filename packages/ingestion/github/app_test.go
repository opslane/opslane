package github

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func generateTestKey(t *testing.T) (*rsa.PrivateKey, []byte) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
	return key, pemBytes
}

func TestGenerateAppJWT(t *testing.T) {
	key, pemBytes := generateTestKey(t)

	signed, err := GenerateAppJWT("12345", pemBytes)
	if err != nil {
		t.Fatalf("GenerateAppJWT: %v", err)
	}

	// Parse and verify the token
	parsed, err := jwt.Parse(signed, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
			t.Fatalf("unexpected signing method: %v", token.Header["alg"])
		}
		return &key.PublicKey, nil
	})
	if err != nil {
		t.Fatalf("parse JWT: %v", err)
	}

	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		t.Fatal("claims not MapClaims")
	}

	iss, _ := claims.GetIssuer()
	if iss != "12345" {
		t.Errorf("issuer = %q, want %q", iss, "12345")
	}

	if claims["iat"] == nil || claims["exp"] == nil {
		t.Error("missing iat or exp claim")
	}
}

func TestGenerateAppJWT_InvalidPEM(t *testing.T) {
	_, err := GenerateAppJWT("123", []byte("not a pem"))
	if err == nil {
		t.Error("expected error for invalid PEM")
	}
}

func TestExchangeOAuthCode(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.Header.Get("Accept") != "application/json" {
			t.Errorf("Accept = %s, want application/json", r.Header.Get("Accept"))
		}

		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.FormValue("client_id") != "test-client" {
			t.Errorf("client_id = %s", r.FormValue("client_id"))
		}
		if r.FormValue("code") != "test-code" {
			t.Errorf("code = %s", r.FormValue("code"))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(UserToken{
			AccessToken: "ghu_xxxxxxxxxxxx",
			TokenType:   "bearer",
			Scope:       "user:email",
		})
	}))
	defer ts.Close()

	// Override the OAuth URL for testing
	origClient := httpClient
	httpClient = ts.Client()
	defer func() { httpClient = origClient }()

	// We need to redirect the request to our test server.
	// Since ExchangeOAuthCode hardcodes github.com, we use a custom transport.
	httpClient = &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			req.URL.Scheme = "http"
			req.URL.Host = ts.Listener.Addr().String()
			return http.DefaultTransport.RoundTrip(req)
		}),
	}

	token, err := ExchangeOAuthCode("test-client", "test-secret", "test-code")
	if err != nil {
		t.Fatalf("ExchangeOAuthCode: %v", err)
	}
	if token.AccessToken != "ghu_xxxxxxxxxxxx" {
		t.Errorf("access_token = %s", token.AccessToken)
	}
}

func TestListInstallationRepos(t *testing.T) {
	callCount := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if r.Header.Get("Authorization") != "token test-token" {
			t.Errorf("auth = %s", r.Header.Get("Authorization"))
		}

		resp := installationReposResponse{
			Repositories: []Repo{
				{FullName: "owner/repo1", Private: false, DefaultBranch: "main"},
				{FullName: "owner/repo2", Private: true, DefaultBranch: "master"},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer ts.Close()

	origClient := httpClient
	httpClient = &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			req.URL.Scheme = "http"
			req.URL.Host = ts.Listener.Addr().String()
			return http.DefaultTransport.RoundTrip(req)
		}),
	}
	defer func() { httpClient = origClient }()

	repos, err := ListInstallationRepos("test-token")
	if err != nil {
		t.Fatalf("ListInstallationRepos: %v", err)
	}
	if len(repos) != 2 {
		t.Fatalf("got %d repos, want 2", len(repos))
	}
	if repos[0].FullName != "owner/repo1" {
		t.Errorf("repo[0] = %s", repos[0].FullName)
	}
	if repos[1].Private != true {
		t.Error("repo[1] should be private")
	}
}

func TestGetInstallationToken_ClassifiesGoneAndSuspended(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"deleted installation", http.StatusNotFound, `{"message":"Not Found"}`, ErrInstallationGone},
		{"suspended installation", http.StatusForbidden, `{"message":"This installation has been suspended"}`, ErrInstallationSuspended},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			orig := httpClient
			httpClient = &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: tc.status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}
			defer func() { httpClient = orig }()
			_, err := GetInstallationToken("jwt", 42)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestGetInstallationToken_OtherErrorsAreNotClassified(t *testing.T) {
	orig := httpClient
	httpClient = &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusBadGateway, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`upstream`))}, nil
	})}
	defer func() { httpClient = orig }()
	_, err := GetInstallationToken("jwt", 42)
	if err == nil || errors.Is(err, ErrInstallationGone) || errors.Is(err, ErrInstallationSuspended) {
		t.Fatalf("502 must stay a generic error, got %v", err)
	}
}

func TestVerifyInstallation_ReturnsHTMLURLAndGone(t *testing.T) {
	orig := httpClient
	httpClient = &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/app/installations/7" {
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(
				`{"id":7,"account":{"login":"acme","id":9},"html_url":"https://github.com/organizations/acme/settings/installations/7"}`))}, nil
		}
		return &http.Response{StatusCode: http.StatusNotFound, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}
	defer func() { httpClient = orig }()
	info, err := VerifyInstallation("jwt", 7)
	if err != nil || info.HTMLURL != "https://github.com/organizations/acme/settings/installations/7" {
		t.Fatalf("info=%+v err=%v", info, err)
	}
	if _, err := VerifyInstallation("jwt", 8); !errors.Is(err, ErrInstallationGone) {
		t.Fatalf("404 must be ErrInstallationGone, got %v", err)
	}
}

func TestGetUser(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/user" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-user-token" {
			t.Errorf("auth = %s", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(GitHubUser{
			ID:        42,
			Login:     "testuser",
			Name:      "Test User",
			Email:     "test@example.com",
			AvatarURL: "https://avatars.githubusercontent.com/u/42",
		})
	}))
	defer ts.Close()

	origClient := httpClient
	httpClient = &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			req.URL.Scheme = "http"
			req.URL.Host = ts.Listener.Addr().String()
			return http.DefaultTransport.RoundTrip(req)
		}),
	}
	defer func() { httpClient = origClient }()

	user, err := GetUser("test-user-token")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if user.ID != 42 || user.Login != "testuser" {
		t.Errorf("user = %+v", user)
	}
}

func TestDeleteBranchIsIdempotent(t *testing.T) {
	for _, status := range []int{http.StatusNoContent, http.StatusNotFound} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var gotPath, gotAuth string
			origClient := httpClient
			httpClient = &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
				gotPath = req.URL.EscapedPath()
				gotAuth = req.Header.Get("Authorization")
				return &http.Response{
					StatusCode: status,
					Body:       io.NopCloser(strings.NewReader("")),
					Header:     make(http.Header),
				}, nil
			})}
			defer func() { httpClient = origClient }()

			if err := DeleteBranch("token", "owner/repo", "opslane/fix-1234"); err != nil {
				t.Fatalf("DeleteBranch: %v", err)
			}
			if gotPath != "/repos/owner/repo/git/refs/heads/opslane%2Ffix-1234" {
				t.Fatalf("path = %q", gotPath)
			}
			if gotAuth != "Bearer token" {
				t.Fatalf("authorization = %q", gotAuth)
			}
		})
	}
}

func TestGetUserEmails(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]GitHubEmail{
			{Email: "private@example.com", Primary: false, Verified: true},
			{Email: "primary@example.com", Primary: true, Verified: true},
		})
	}))
	defer ts.Close()

	origClient := httpClient
	httpClient = &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			req.URL.Scheme = "http"
			req.URL.Host = ts.Listener.Addr().String()
			return http.DefaultTransport.RoundTrip(req)
		}),
	}
	defer func() { httpClient = origClient }()

	emails, err := GetUserEmails("test-token")
	if err != nil {
		t.Fatalf("GetUserEmails: %v", err)
	}
	if len(emails) != 2 {
		t.Fatalf("got %d emails", len(emails))
	}
	if !emails[1].Primary {
		t.Error("second email should be primary")
	}
}

func TestListUserInstallations(t *testing.T) {
	callCount := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if r.URL.Path != "/user/installations" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer ghu_tok" {
			t.Errorf("auth header = %s", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("page") == "2" {
			fmt.Fprint(w, `{"installations":[{"id":222}]}`)
			return
		}
		w.Header().Set("Link", `<https://api.github.com/user/installations?page=2>; rel="next"`)
		fmt.Fprint(w, `{"installations":[{"id":111}]}`)
	}))
	defer ts.Close()

	origClient := httpClient
	httpClient = &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		req.URL.Scheme = "http"
		req.URL.Host = ts.Listener.Addr().String()
		return http.DefaultTransport.RoundTrip(req)
	})}
	defer func() { httpClient = origClient }()

	ids, err := ListUserInstallations("ghu_tok")
	if err != nil {
		t.Fatalf("ListUserInstallations: %v", err)
	}
	if len(ids) != 2 || ids[0] != 111 || ids[1] != 222 {
		t.Errorf("ids = %v, want [111 222]", ids)
	}
	if callCount != 2 {
		t.Errorf("expected pagination (2 calls), got %d", callCount)
	}
}

func TestHasNextPage(t *testing.T) {
	tests := []struct {
		header string
		want   bool
	}{
		{"", false},
		{`<https://api.github.com/repos?page=2>; rel="next"`, true},
		{`<https://api.github.com/repos?page=1>; rel="prev"`, false},
		{`<https://api.github.com/repos?page=1>; rel="prev", <https://api.github.com/repos?page=3>; rel="next"`, true},
	}
	for _, tt := range tests {
		got := hasNextPage(tt.header)
		if got != tt.want {
			t.Errorf("hasNextPage(%q) = %v, want %v", tt.header, got, tt.want)
		}
	}
}

// roundTripperFunc adapts a function to http.RoundTripper.
type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}
