package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func completeFixtureSourceMap(t *testing.T, fixture *sourceMapHandlerFixture) (string, string) {
	t.Helper()
	batchID := fixture.createDefaultBatch(t)
	if response := fixture.upload(t, batchID, fixture.debugID, fixture.raw); response.Code != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", response.Code, response.Body.String())
	}
	if response := fixture.complete(t, batchID); response.Code != http.StatusOK {
		t.Fatalf("complete status=%d body=%s", response.Code, response.Body.String())
	}
	var objectKey string
	if err := fixture.pool.QueryRow(context.Background(), `
		SELECT object_key
		FROM sourcemap_files
		WHERE project_id = $1 AND debug_id = $2`,
		fixture.projectID, fixture.debugID,
	).Scan(&objectKey); err != nil {
		t.Fatal(err)
	}
	return batchID, objectKey
}

func verifyFixtureSourceMap(
	t *testing.T, fixture *sourceMapHandlerFixture, batchID string,
) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"batch_id": batchID, "debug_id": fixture.debugID,
		"generated_line": 1, "generated_column": 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/projects/"+fixture.projectID+"/sourcemaps/verify", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+dashboardToken(t, fixture.orgID))
	response := httptest.NewRecorder()
	fixture.router.ServeHTTP(response, req)
	return response
}

func TestTwoProjectsSameDebugIDIsolated(t *testing.T) {
	first := newSourceMapHandlerFixture(t)
	second := newSourceMapHandlerFixture(t)
	firstBatch, firstKey := completeFixtureSourceMap(t, first)
	secondBatch, secondKey := completeFixtureSourceMap(t, second)

	if first.debugID != second.debugID {
		t.Fatalf("fixtures computed different debug IDs: %s != %s", first.debugID, second.debugID)
	}
	if firstKey == secondKey ||
		!strings.Contains(firstKey, first.projectID) ||
		!strings.Contains(secondKey, second.projectID) {
		t.Fatalf("object keys are not project-isolated: %q %q", firstKey, secondKey)
	}
	var rows int
	if err := first.pool.QueryRow(context.Background(), `
		SELECT count(*) FROM sourcemap_files
		WHERE debug_id = $1 AND project_id IN ($2, $3)`,
		first.debugID, first.projectID, second.projectID,
	).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("source-map rows=%d want 2", rows)
	}
	for _, item := range []struct {
		fixture *sourceMapHandlerFixture
		batchID string
	}{
		{first, firstBatch},
		{second, secondBatch},
	} {
		response := verifyFixtureSourceMap(t, item.fixture, item.batchID)
		if response.Code != http.StatusOK {
			t.Fatalf("verify project %s status=%d body=%s",
				item.fixture.projectID, response.Code, response.Body.String())
		}
	}
}

func TestDeleteProjectLeavesOtherProjectIntact(t *testing.T) {
	first := newSourceMapHandlerFixture(t)
	second := newSourceMapHandlerFixture(t)
	_, firstKey := completeFixtureSourceMap(t, first)
	secondBatch, secondKey := completeFixtureSourceMap(t, second)

	prefix, err := first.deps.Queries.DeleteProject(context.Background(), first.projectID)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.storage.RemovePrefix(context.Background(), prefix); err != nil {
		t.Fatal(err)
	}

	var firstRows int
	if err := first.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM sourcemap_files WHERE project_id = $1`, first.projectID,
	).Scan(&firstRows); err != nil {
		t.Fatal(err)
	}
	if firstRows != 0 {
		t.Fatalf("deleted project still has %d source-map rows", firstRows)
	}
	if _, err := first.storage.StatObject(context.Background(), firstKey); err == nil {
		t.Fatal("deleted project's source-map object still exists")
	}
	if _, err := second.storage.StatObject(context.Background(), secondKey); err != nil {
		t.Fatalf("other project's object was removed: %v", err)
	}
	response := verifyFixtureSourceMap(t, second, secondBatch)
	if response.Code != http.StatusOK {
		t.Fatalf("other project verify status=%d body=%s", response.Code, response.Body.String())
	}
}
