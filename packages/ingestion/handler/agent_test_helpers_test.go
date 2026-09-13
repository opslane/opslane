package handler

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"testing"
)

type handlerRoundTripperFunc func(*http.Request) (*http.Response, error)

func (f handlerRoundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func callbackTestKey(t *testing.T) []byte {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
}

func cleanupCallbackTenant(t *testing.T, pool *pgxpool.Pool, sessionID string, installationID int64, orgID string) {
	t.Helper()
	ctx := context.Background()
	if sessionID != "" {
		_, _ = pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, sessionID)
	}
	if installationID != 0 {
		_, _ = pool.Exec(ctx, `DELETE FROM installation_landed WHERE installation_id = $1`, installationID)
		_, _ = pool.Exec(ctx, `DELETE FROM github_app_installations WHERE installation_id = $1`, installationID)
	}
	if orgID == "" {
		return
	}
	queries := []string{
		`DELETE FROM pr_outcomes WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_group_jobs WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_group_affected_users WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1))`,
		`DELETE FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM end_users WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM project_api_keys WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`UPDATE projects SET default_environment_id = NULL WHERE org_id = $1`,
		`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM projects WHERE org_id = $1`,
		`DELETE FROM org_invitations WHERE org_id = $1 OR invited_by IN (SELECT id FROM users WHERE org_id = $1)`,
		`DELETE FROM memberships WHERE org_id = $1 OR user_id IN (SELECT id FROM users WHERE org_id = $1)`,
		`DELETE FROM users WHERE org_id = $1`,
		`DELETE FROM orgs WHERE id = $1`,
	}
	for _, query := range queries {
		if _, err := pool.Exec(ctx, query, orgID); err != nil {
			t.Logf("cleanup warning: %v", err)
		}
	}
}
