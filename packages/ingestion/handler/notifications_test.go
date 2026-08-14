package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/handler"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

const notificationCipherSecret = "notification-handler-test-secret-32-bytes"

type fixedDigestBuilder struct {
	payload notify.EventPayload
	calls   atomic.Int64
}

func (b *fixedDigestBuilder) Build(context.Context, string, time.Time) (notify.EventPayload, error) {
	b.calls.Add(1)
	return b.payload, nil
}

func notificationRouter(t *testing.T, cloud bool, extraHosts []string) (*handler.Dependencies, http.Handler, string, string, string) {
	t.Helper()
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	cipher, err := notify.NewConfigCipher([]byte(notificationCipherSecret))
	if err != nil {
		t.Fatal(err)
	}
	deps.JWTSecret = []byte(authTestJWTSecret)
	deps.ConfigCipher = cipher
	deps.NotifyExtraHosts = extraHosts
	deps.NotifySender = notify.NewSender(time.Second, extraHosts)
	if cloud {
		deps.AuthProvider = cloudAuthStub{}
	}
	return deps, handler.NewRouterWithPool(deps, pool), orgID, projectID, authTestJWTSecret
}

func notificationHTTP(t *testing.T, router http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(method, path, reader)
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: handler.AccessCookieName, Value: token})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func notificationToken(t *testing.T, userID, orgID, email string) string {
	t.Helper()
	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), userID, orgID, email)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestNotificationDestinationCRUDAndTestEndpointOSS(t *testing.T) {
	var sinkCalls atomic.Int64
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sinkCalls.Add(1)
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), "Test notification from Opslane") {
			t.Errorf("unexpected test body: %s", body)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer sink.Close()
	parsedSink, err := url.Parse(sink.URL)
	if err != nil {
		t.Fatal(err)
	}

	_, router, orgID, projectID, _ := notificationRouter(t, false, []string{parsedSink.Host})
	token := notificationToken(t, "oss-user", orgID, "oss@example.com")
	secretPath := "/webhook-secret-1234"
	create := notificationHTTP(t, router, http.MethodPost,
		"/api/v1/projects/"+projectID+"/notification-destinations", token,
		map[string]any{"name": "Production alerts", "webhook_url": sink.URL + secretPath},
	)
	if create.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	if strings.Contains(create.Body.String(), secretPath) || strings.Contains(create.Body.String(), sink.URL) {
		t.Fatalf("create response leaked webhook: %s", create.Body.String())
	}
	var created struct {
		ID                string `json:"id"`
		ConfigFingerprint string `json:"config_fingerprint"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil || created.ID == "" || !strings.HasSuffix(created.ConfigFingerprint, "****1234") {
		t.Fatalf("unexpected create response: %s err=%v", create.Body.String(), err)
	}

	list := notificationHTTP(t, router, http.MethodGet,
		"/api/v1/projects/"+projectID+"/notification-destinations", token, nil)
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"can_manage":true`) || strings.Contains(list.Body.String(), secretPath) {
		t.Fatalf("unexpected list response: status=%d body=%s", list.Code, list.Body.String())
	}

	patch := notificationHTTP(t, router, http.MethodPatch,
		"/api/v1/projects/"+projectID+"/notification-destinations/"+created.ID, token,
		map[string]any{"name": "Renamed", "enabled": false},
	)
	if patch.Code != http.StatusOK || !strings.Contains(patch.Body.String(), `"name":"Renamed"`) || !strings.Contains(patch.Body.String(), `"enabled":false`) {
		t.Fatalf("patch status=%d body=%s", patch.Code, patch.Body.String())
	}

	testResponse := notificationHTTP(t, router, http.MethodPost,
		"/api/v1/projects/"+projectID+"/notification-destinations/"+created.ID+"/test", token, map[string]any{})
	if testResponse.Code != http.StatusOK || !strings.Contains(testResponse.Body.String(), `"ok":true`) || sinkCalls.Load() != 1 {
		t.Fatalf("test status=%d calls=%d body=%s", testResponse.Code, sinkCalls.Load(), testResponse.Body.String())
	}

	deleted := notificationHTTP(t, router, http.MethodDelete,
		"/api/v1/projects/"+projectID+"/notification-destinations/"+created.ID, token, nil)
	if deleted.Code != http.StatusOK || !strings.Contains(deleted.Body.String(), `"ok":true`) {
		t.Fatalf("delete status=%d body=%s", deleted.Code, deleted.Body.String())
	}
}

func TestNotificationDestinationTestEventType(t *testing.T) {
	var sinkCalls atomic.Int64
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		sinkCalls.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer sink.Close()
	parsedSink, err := url.Parse(sink.URL)
	if err != nil {
		t.Fatal(err)
	}
	deps, router, orgID, projectID, _ := notificationRouter(t, false, []string{parsedSink.Host})
	token := notificationToken(t, "digest-user", orgID, "digest@example.com")
	create := notificationHTTP(t, router, http.MethodPost,
		"/api/v1/projects/"+projectID+"/notification-destinations", token,
		map[string]any{"name": "Digest preview", "webhook_url": sink.URL + "/hook"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	builder := &fixedDigestBuilder{payload: notify.EventPayload{
		Version:   1,
		EventType: "digest.daily",
		Project:   notify.ProjectRef{ID: projectID, Name: "Digest project"},
		Digest: &notify.DigestPayload{
			Date:     "2026-08-07",
			Watching: notify.DigestWatching{Sessions: 1, Users: 1},
		},
	}}
	deps.DigestBuilder = builder
	path := "/api/v1/projects/" + projectID + "/notification-destinations/" + created.ID + "/test"

	digestResponse := notificationHTTP(t, router, http.MethodPost, path, token, map[string]any{"event_type": "digest.daily"})
	if digestResponse.Code != http.StatusOK || !strings.Contains(digestResponse.Body.String(), `"classification":"delivered"`) {
		t.Fatalf("digest test status=%d body=%s", digestResponse.Code, digestResponse.Body.String())
	}
	if builder.calls.Load() != 1 || sinkCalls.Load() != 1 {
		t.Fatalf("builder calls=%d sink calls=%d", builder.calls.Load(), sinkCalls.Load())
	}

	bogus := notificationHTTP(t, router, http.MethodPost, path, token, map[string]any{"event_type": "bogus"})
	if bogus.Code != http.StatusBadRequest {
		t.Fatalf("bogus status=%d body=%s", bogus.Code, bogus.Body.String())
	}
	unknownField := notificationHTTP(t, router, http.MethodPost, path, token, map[string]any{
		"event_type": "digest.daily",
		"extra":      true,
	})
	if unknownField.Code != http.StatusBadRequest {
		t.Fatalf("unknown-field status=%d body=%s", unknownField.Code, unknownField.Body.String())
	}
	trailingRequest := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{} {}`))
	trailingRequest.Header.Set("Content-Type", "application/json")
	trailingRequest.AddCookie(&http.Cookie{Name: handler.AccessCookieName, Value: token})
	trailingResponse := httptest.NewRecorder()
	router.ServeHTTP(trailingResponse, trailingRequest)
	if trailingResponse.Code != http.StatusBadRequest {
		t.Fatalf("trailing-json status=%d body=%s", trailingResponse.Code, trailingResponse.Body.String())
	}
	deps.DigestBuilder = nil
	unavailable := notificationHTTP(t, router, http.MethodPost, path, token, map[string]any{"event_type": "digest.daily"})
	if unavailable.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable status=%d body=%s", unavailable.Code, unavailable.Body.String())
	}

	issueResponse := notificationHTTP(t, router, http.MethodPost, path, token, nil)
	if issueResponse.Code != http.StatusOK || !strings.Contains(issueResponse.Body.String(), `"classification":"delivered"`) {
		t.Fatalf("empty-body issue test status=%d body=%s", issueResponse.Code, issueResponse.Body.String())
	}
}

func TestNotificationDestinationValidationAndCrossOrg(t *testing.T) {
	deps, router, orgID, projectID, _ := notificationRouter(t, false, nil)
	token := notificationToken(t, "oss-user", orgID, "oss@example.com")
	for _, webhookURL := range []string{
		"http://hooks.slack.com/services/T/B/x",
		"https://evil.example.com/services/T/B/x",
		"https://a:b@hooks.slack.com/services/T/B/x",
		"https://hooks.slack.com:8443/services/T/B/x",
	} {
		response := notificationHTTP(t, router, http.MethodPost,
			"/api/v1/projects/"+projectID+"/notification-destinations", token,
			map[string]any{"name": "Invalid", "webhook_url": webhookURL},
		)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("url %q status=%d body=%s", webhookURL, response.Code, response.Body.String())
		}
	}
	unsupported := notificationHTTP(t, router, http.MethodPost,
		"/api/v1/projects/"+projectID+"/notification-destinations", token,
		map[string]any{
			"name":        "Unsupported event",
			"webhook_url": "https://hooks.slack.com/services/T/B/x",
			"event_types": []string{"issue.pr_created"},
		},
	)
	if unsupported.Code != http.StatusBadRequest {
		t.Fatalf("unsupported event status=%d body=%s", unsupported.Code, unsupported.Body.String())
	}

	otherOrg, err := deps.Queries.CreateOrg(context.Background(), "notification-cross-org")
	if err != nil {
		t.Fatal(err)
	}
	otherToken := notificationToken(t, "other-user", otherOrg.ID, "other@example.com")
	response := notificationHTTP(t, router, http.MethodGet,
		"/api/v1/projects/"+projectID+"/notification-destinations", otherToken, nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-org status=%d body=%s", response.Code, response.Body.String())
	}
	if _, err := deps.Queries.Pool().Exec(context.Background(), `DELETE FROM orgs WHERE id = $1`, otherOrg.ID); err != nil {
		t.Fatal(err)
	}
}

func TestNotificationDestinationEventTypes(t *testing.T) {
	_, router, orgID, projectID, _ := notificationRouter(t, false, nil)
	token := notificationToken(t, "event-types-user", orgID, "event-types@example.com")
	path := "/api/v1/projects/" + projectID + "/notification-destinations"

	create := notificationHTTP(t, router, http.MethodPost, path, token, map[string]any{
		"name":        "Digest alerts",
		"webhook_url": "https://hooks.slack.com/services/T/B/x",
	})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	var created struct {
		ID         string   `json:"id"`
		EventTypes []string `json:"event_types"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if len(created.EventTypes) != 2 || created.EventTypes[0] != "issue.created" || created.EventTypes[1] != "digest.daily" {
		t.Fatalf("create event_types = %v", created.EventTypes)
	}

	updatePath := path + "/" + created.ID
	for _, eventTypes := range [][]string{{}, {"bogus"}} {
		response := notificationHTTP(t, router, http.MethodPatch, updatePath, token, map[string]any{"event_types": eventTypes})
		if response.Code != http.StatusBadRequest {
			t.Fatalf("PATCH event_types=%v status=%d body=%s", eventTypes, response.Code, response.Body.String())
		}
	}

	response := notificationHTTP(t, router, http.MethodPatch, updatePath, token, map[string]any{
		"event_types": []string{"issue.created"},
	})
	if response.Code != http.StatusOK {
		t.Fatalf("valid PATCH status=%d body=%s", response.Code, response.Body.String())
	}
	var updated struct {
		EventTypes []string `json:"event_types"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if len(updated.EventTypes) != 1 || updated.EventTypes[0] != "issue.created" {
		t.Fatalf("PATCH event_types = %v", updated.EventTypes)
	}
}

func TestNotificationDestinationDeliveryPolicy(t *testing.T) {
	_, router, orgID, projectID, _ := notificationRouter(t, false, nil)
	token := notificationToken(t, "policy-user", orgID, "policy@example.com")
	path := "/api/v1/projects/" + projectID + "/notification-destinations"

	create := notificationHTTP(t, router, http.MethodPost, path, token, map[string]any{
		"name": "After triage", "webhook_url": "https://hooks.slack.com/services/T/B/x",
		"delivery_policy": "post_triage",
	})
	if create.Code != http.StatusCreated || !strings.Contains(create.Body.String(), `"delivery_policy":"post_triage"`) {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	update := notificationHTTP(t, router, http.MethodPatch, path+"/"+created.ID, token, map[string]any{
		"delivery_policy": "immediate",
	})
	if update.Code != http.StatusOK || !strings.Contains(update.Body.String(), `"delivery_policy":"immediate"`) {
		t.Fatalf("update status=%d body=%s", update.Code, update.Body.String())
	}
	for _, body := range []map[string]any{
		{"name": "Bad", "webhook_url": "https://hooks.slack.com/services/T/B/x", "delivery_policy": "whenever"},
		{"name": "Bad event", "webhook_url": "https://hooks.slack.com/services/T/B/x", "event_types": []string{"issue.triaged"}},
	} {
		response := notificationHTTP(t, router, http.MethodPost, path, token, body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid create status=%d body=%s", response.Code, response.Body.String())
		}
	}
}

func TestNotificationDestinationCloudAdminAuthorization(t *testing.T) {
	deps, router, orgID, projectID, _ := notificationRouter(t, true, nil)
	user, err := deps.Queries.CreateUserGitHub(
		context.Background(), orgID, fmt.Sprintf("notify-%d@example.com", time.Now().UnixNano()), "Notify User",
		time.Now().UnixNano(), "notify-user", "",
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := deps.Queries.CreateMembership(context.Background(), user.ID, orgID, "member"); err != nil {
		t.Fatal(err)
	}
	token := notificationToken(t, user.ID, orgID, user.Email)
	path := "/api/v1/projects/" + projectID + "/notification-destinations"

	list := notificationHTTP(t, router, http.MethodGet, path, token, nil)
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"can_manage":false`) {
		t.Fatalf("member list status=%d body=%s", list.Code, list.Body.String())
	}
	create := notificationHTTP(t, router, http.MethodPost, path, token,
		map[string]any{"name": "Denied", "webhook_url": "https://hooks.slack.com/services/T/B/x"})
	if create.Code != http.StatusForbidden {
		t.Fatalf("member create status=%d body=%s", create.Code, create.Body.String())
	}

	if err := deps.Queries.SetMembershipRole(context.Background(), user.ID, orgID, "admin"); err != nil {
		t.Fatal(err)
	}
	create = notificationHTTP(t, router, http.MethodPost, path, token,
		map[string]any{"name": "Allowed", "webhook_url": "https://hooks.slack.com/services/T/B/x"})
	if create.Code != http.StatusCreated {
		t.Fatalf("admin create status=%d body=%s", create.Code, create.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil || created.ID == "" {
		t.Fatalf("decode created destination: %v body=%s", err, create.Body.String())
	}
	if err := deps.Queries.SetMembershipRole(context.Background(), user.ID, orgID, "member"); err != nil {
		t.Fatal(err)
	}
	for _, request := range []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodPatch, path + "/" + created.ID, map[string]any{"enabled": false}},
		{http.MethodDelete, path + "/" + created.ID, nil},
		{http.MethodPost, path + "/" + created.ID + "/test", map[string]any{}},
	} {
		response := notificationHTTP(t, router, request.method, request.path, token, request.body)
		if response.Code != http.StatusForbidden {
			t.Fatalf("member %s %s status=%d body=%s", request.method, request.path, response.Code, response.Body.String())
		}
	}
}
