package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

// wireFixtureDir is the frozen-fixture dir relative to this package
// (packages/ingestion/handler -> repo root is ../../..).
const wireFixtureDir = "../../../test-fixtures/wire/events"

type wireFixture struct {
	Timestamp string `json:"timestamp"`
	Error     struct {
		Type    string `json:"type"`
		Message string `json:"message"`
		Stack   string `json:"stack"`
	} `json:"error"`
	Breadcrumbs    json.RawMessage `json:"breadcrumbs"`
	Context        json.RawMessage `json:"context"`
	Platform       string          `json:"platform"`
	Runtime        json.RawMessage `json:"runtime"`
	SDKVersion     string          `json:"sdk_version"`
	Release        string          `json:"release"`
	DebugMeta      json.RawMessage `json:"debug_meta"`
	NetworkTimings json.RawMessage `json:"network_timings"`
	CommitSHA      string          `json:"commit_sha"`
	SessionID      string          `json:"session_id"`
	Environment    string          `json:"environment"`
	ContextUser    *struct {
		ID          string `json:"id"`
		Email       string `json:"email"`
		AccountID   string `json:"account_id"`
		AccountName string `json:"account_name"`
	} `json:"-"`
}

func expectedStoredContext(t *testing.T, fixture wireFixture) json.RawMessage {
	t.Helper()
	if len(fixture.Runtime) == 0 {
		return fixture.Context
	}
	var contextObject map[string]json.RawMessage
	contextJSON := fixture.Context
	if len(contextJSON) == 0 {
		contextJSON = json.RawMessage(`{}`)
	}
	if err := json.Unmarshal(contextJSON, &contextObject); err != nil {
		t.Fatalf("parse fixture context: %v", err)
	}
	if contextObject == nil {
		contextObject = map[string]json.RawMessage{}
	}
	contextObject["runtime"] = fixture.Runtime
	merged, err := json.Marshal(contextObject)
	if err != nil {
		t.Fatalf("merge expected runtime: %v", err)
	}
	return merged
}

func fixturePaths(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(wireFixtureDir)
	if err != nil {
		t.Fatalf("read fixture dir: %v", err)
	}
	var paths []string
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			paths = append(paths, filepath.Join(wireFixtureDir, entry.Name()))
		}
	}
	if len(paths) == 0 {
		t.Fatalf("no wire fixtures found in %s", wireFixtureDir)
	}
	return paths
}

func readFixture(t *testing.T, path string) ([]byte, wireFixture) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture wireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}

	var contextObject struct {
		User *struct {
			ID          string `json:"id"`
			Email       string `json:"email"`
			AccountID   string `json:"account_id"`
			AccountName string `json:"account_name"`
		} `json:"user"`
	}
	if err := json.Unmarshal(fixture.Context, &contextObject); err != nil {
		t.Fatalf("parse fixture context: %v", err)
	}
	fixture.ContextUser = contextObject.User
	return raw, fixture
}

func postFixture(t *testing.T, deps *handler.Dependencies, rawKey string, body []byte) map[string]string {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", rawKey)
	recorder := httptest.NewRecorder()
	handler.NewRouter(deps).ServeHTTP(recorder, req)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d (%s)", recorder.Code, recorder.Body.String())
	}
	var response map[string]string
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return response
}

// semanticJSONEqual compares stored JSONB text against expected raw JSON,
// ignoring key order and whitespace (Postgres reserializes JSONB).
func semanticJSONEqual(t *testing.T, label, gotText string, want json.RawMessage) {
	t.Helper()
	if len(want) == 0 {
		return
	}
	var got, expected any
	if err := json.Unmarshal([]byte(gotText), &got); err != nil {
		t.Fatalf("%s: unmarshal stored: %v", label, err)
	}
	if err := json.Unmarshal(want, &expected); err != nil {
		t.Fatalf("%s: unmarshal fixture: %v", label, err)
	}
	if !reflect.DeepEqual(got, expected) {
		t.Errorf("%s mismatch:\n stored=%s\n fixture=%s", label, gotText, string(want))
	}
}

// TestWireFixtures_AcceptedAndStored replays every frozen fixture and asserts the
// full contract round-trips. sdk_version is accepted (implicit in the 202) but is
// not persisted by ingestion, so it is intentionally not asserted against the DB.
func TestWireFixtures_AcceptedAndStored(t *testing.T) {
	deps, pool := testDeps(t)

	for _, path := range fixturePaths(t) {
		path := path
		t.Run(filepath.Base(path), func(t *testing.T) {
			_, _, _, rawKey := seedTenant(t, deps.Queries)
			raw, fixture := readFixture(t, path)

			response := postFixture(t, deps, rawKey, raw)
			eventID := response["event_id"]
			if eventID == "" || response["group_id"] == "" {
				t.Fatalf("missing ids in response: %v", response)
			}
			if response["error_group_id"] != response["group_id"] {
				t.Errorf("error_group_id %q != group_id %q", response["error_group_id"], response["group_id"])
			}

			var (
				timestamp                                                         time.Time
				errorType, errorMessage, stack, release, sessionID, eventPlatform string
				breadcrumbsText, contextText, debugMetaText, networkTimingsText   string
				commitSHA                                                         string
				groupID, endUserID                                                *string
			)
			if err := pool.QueryRow(context.Background(), `
				SELECT "timestamp", error_type, error_message, stack_trace_raw,
				       COALESCE(release,''), COALESCE(session_id,''),
				       breadcrumbs::text, context::text, debug_meta::text, network_timings::text,
				       COALESCE(commit_sha, ''),
				       error_group_id::text, end_user_id::text, platform
				FROM error_events WHERE id = $1`, eventID).
				Scan(&timestamp, &errorType, &errorMessage, &stack, &release, &sessionID,
					&breadcrumbsText, &contextText, &debugMetaText, &networkTimingsText, &commitSHA,
					&groupID, &endUserID, &eventPlatform); err != nil {
				t.Fatalf("query stored event: %v", err)
			}

			wantTimestamp, err := time.Parse(time.RFC3339, fixture.Timestamp)
			if err != nil {
				t.Fatalf("parse fixture timestamp: %v", err)
			}
			if !timestamp.Equal(wantTimestamp) {
				t.Errorf("timestamp = %v, want %v", timestamp, wantTimestamp)
			}
			wantType := fixture.Error.Type
			if wantType == "" {
				wantType = "Error"
			}
			if errorType != wantType {
				t.Errorf("error_type = %q, want %q", errorType, wantType)
			}
			if errorMessage != fixture.Error.Message {
				t.Errorf("error_message = %q, want %q", errorMessage, fixture.Error.Message)
			}
			if stack != fixture.Error.Stack {
				t.Errorf("stack_trace_raw = %q, want %q", stack, fixture.Error.Stack)
			}
			if release != fixture.Release {
				t.Errorf("release = %q, want %q", release, fixture.Release)
			}
			if sessionID != fixture.SessionID {
				t.Errorf("session_id = %q, want %q", sessionID, fixture.SessionID)
			}
			if groupID != nil {
				t.Errorf("captured event already has stable error_group_id %q", *groupID)
			}
			semanticJSONEqual(t, "breadcrumbs", breadcrumbsText, fixture.Breadcrumbs)
			semanticJSONEqual(t, "context", contextText, expectedStoredContext(t, fixture))
			expectedDebugMeta := fixture.DebugMeta
			if len(expectedDebugMeta) == 0 {
				expectedDebugMeta = json.RawMessage(`{"images":[]}`)
			}
			semanticJSONEqual(t, "debug_meta", debugMetaText, expectedDebugMeta)
			wantTimings := fixture.NetworkTimings
			if len(wantTimings) == 0 {
				wantTimings = json.RawMessage(`[]`)
			}
			semanticJSONEqual(t, "network_timings", networkTimingsText, wantTimings)
			if commitSHA != fixture.CommitSHA {
				t.Errorf("commit_sha = %q, want %q", commitSHA, fixture.CommitSHA)
			}

			wantPlatform := fixture.Platform
			if wantPlatform == "" {
				wantPlatform = "javascript"
			}
			if eventPlatform != wantPlatform {
				t.Errorf("event platform = %q, want %q", eventPlatform, wantPlatform)
			}
			var rawFingerprint, identityStatus string
			if err := pool.QueryRow(context.Background(), `
				SELECT raw_fingerprint, status FROM error_event_identities
				WHERE event_id=$1`, eventID).Scan(&rawFingerprint, &identityStatus); err != nil {
				t.Fatalf("query pending identity: %v", err)
			}
			if rawFingerprint != response["group_id"] || identityStatus != "pending" {
				t.Errorf("pending identity = fingerprint:%q status:%q, response handle:%q", rawFingerprint, identityStatus, response["group_id"])
			}

			if fixture.ContextUser == nil {
				if endUserID != nil {
					t.Errorf("unexpected end_user_id %q for fixture without context.user", *endUserID)
				}
				return
			}
			if endUserID == nil {
				t.Fatalf("expected end_user_id set for fixture with context.user")
			}
			var externalID, externalAccountID, accountName, email string
			if err := pool.QueryRow(context.Background(), `
				SELECT external_user_id, COALESCE(external_account_id,''),
				       COALESCE(account_name,''), COALESCE(email,'')
				FROM end_users WHERE id = $1`, *endUserID).
				Scan(&externalID, &externalAccountID, &accountName, &email); err != nil {
				t.Fatalf("query end_user: %v", err)
			}
			if externalID != fixture.ContextUser.ID {
				t.Errorf("external_user_id = %q, want %q", externalID, fixture.ContextUser.ID)
			}
			if email != fixture.ContextUser.Email {
				t.Errorf("end_user email = %q, want %q", email, fixture.ContextUser.Email)
			}
			if externalAccountID != fixture.ContextUser.AccountID {
				t.Errorf("external_account_id = %q, want %q", externalAccountID, fixture.ContextUser.AccountID)
			}
			if accountName != fixture.ContextUser.AccountName {
				t.Errorf("account_name = %q, want %q", accountName, fixture.ContextUser.AccountName)
			}
		})
	}
}

func TestWireV110EnvironmentResolution(t *testing.T) {
	deps, pool := testDeps(t)
	_, projectID, keyEnvironmentID, rawKey := seedTenant(t, deps.Queries)
	staging, err := deps.Queries.CreateEnvironment(context.Background(), projectID, "staging")
	if err != nil {
		t.Fatalf("create staging environment: %v", err)
	}
	tests := []struct {
		name              string
		fixture           string
		wantEnvironmentID string
	}{
		{name: "minimal uses project default", fixture: "v1.1.0-minimal.json", wantEnvironmentID: keyEnvironmentID},
		{name: "full resolves staging", fixture: "v1.1.0-full.json", wantEnvironmentID: staging.ID},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			raw, _ := readFixture(t, filepath.Join(wireFixtureDir, test.fixture))
			response := postFixture(t, deps, rawKey, raw)
			var environmentID string
			if err := pool.QueryRow(context.Background(),
				`SELECT environment_id FROM error_events WHERE id = $1`, response["event_id"]).
				Scan(&environmentID); err != nil {
				t.Fatalf("query stored environment: %v", err)
			}
			if environmentID != test.wantEnvironmentID {
				t.Errorf("environment_id = %q, want %q", environmentID, test.wantEnvironmentID)
			}
		})
	}
}

// TestWireFixtures_StableGrouping posts the same fixture twice and asserts the
// same group is reused, proving grouping as well as storage.
func TestWireFixtures_StableGrouping(t *testing.T) {
	deps, _ := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)

	for _, path := range fixturePaths(t) {
		path := path
		t.Run(filepath.Base(path), func(t *testing.T) {
			raw, _ := readFixture(t, path)
			first := postFixture(t, deps, rawKey, raw)
			second := postFixture(t, deps, rawKey, raw)
			if first["group_id"] != second["group_id"] {
				t.Errorf("group_id drifted across identical posts: %q vs %q", first["group_id"], second["group_id"])
			}
		})
	}
}

// TestWireFixtures_UnknownFieldsTolerated locks in forward compatibility: the
// events decoder must keep ignoring fields introduced by newer SDKs.
func TestWireFixtures_UnknownFieldsTolerated(t *testing.T) {
	deps, _ := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)

	raw, _ := readFixture(t, filepath.Join(wireFixtureDir, "v1.0.0-minimal.json"))
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	object["future_field"] = "from a newer SDK"
	object["error"].(map[string]any)["future_error_field"] = 123
	augmented, err := json.Marshal(object)
	if err != nil {
		t.Fatalf("encode augmented fixture: %v", err)
	}

	response := postFixture(t, deps, rawKey, augmented)
	if response["event_id"] == "" {
		t.Errorf("unknown-field payload not stored: %v", response)
	}
}
