-- scripts/seed-e2e.sql
-- Idempotent seed for E2E testing. Run against Opslane DB.
--
-- Usage:
--   PGPASSWORD=opslane_dev psql -h localhost -p 5434 -U opslane -d opslane -f scripts/seed-e2e.sql
--
-- Test public ingest key (raw):
-- opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq
-- SHA256(secret): 769e8d95aa246a02d94d48c42fb7183e531c85c41d5b3456ddb90011712d8bd7

INSERT INTO orgs (id, name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'E2E Test Org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO projects (id, org_id, name, github_repo, default_branch) VALUES
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001',
   'Opslane Test Fixture', 'opslane/defender-test-fixture', 'main')
ON CONFLICT (id) DO NOTHING;

INSERT INTO environments (id, project_id, name) VALUES
  ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000010', 'production')
ON CONFLICT (id) DO NOTHING;

INSERT INTO project_api_keys
  (id, key_id, project_id, scope, token_prefix, secret_hash, label)
VALUES
  ('00000000-0000-0000-0000-000000001000',
   'mzxw6ytboi3damrrgi3tknzxgq',
   '00000000-0000-0000-0000-000000000010',
   'ingest',
   'opslane_pk',
   '769e8d95aa246a02d94d48c42fb7183e531c85c41d5b3456ddb90011712d8bd7',
   'e2e fixture')
ON CONFLICT (id) DO UPDATE SET
  project_id = EXCLUDED.project_id,
  secret_hash = EXCLUDED.secret_hash,
  revoked_at = NULL,
  revoked_by_user_id = NULL;

-- Secret source-map key for the primary fixture (raw, shown only for E2E).
-- A source-map key ends in a base64url payload carrying the upload origin, so
-- the raw value is per-deployment; the payload is elided here (it is neither
-- hashed nor stored, and a fully formed key is refused by the docs publisher):
-- opslane_sk_nbxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAA…_<payload>
-- Mint a usable one with:
--   OPSLANE_PUBLIC_INGEST_URL=http://localhost:8082 go run ./cmd/mint-key \
--     -project 00000000-0000-0000-0000-000000000010 -scope sourcemaps
INSERT INTO project_api_keys
  (id, key_id, project_id, scope, token_prefix, secret_hash, label)
VALUES
  ('00000000-0000-0000-0000-000000001100',
   'nbxw6ytboi3damrrgi3tknzxgq',
   '00000000-0000-0000-0000-000000000010',
   'sourcemaps',
   'opslane_sk',
   '67d260caf3fb036990b4d21bf0733af700155609945bfcb1ae7355a5b6357ee9',
   'e2e source maps')
ON CONFLICT (id) DO UPDATE SET
  project_id = EXCLUDED.project_id,
  secret_hash = EXCLUDED.secret_hash,
  revoked_at = NULL,
  revoked_by_user_id = NULL;

-- A second fixed project makes cross-project source-map isolation
-- discriminating: it can report an event carrying project 1's debug ID before
-- project 2 uploads the same map.
INSERT INTO projects (id, org_id, name, github_repo, default_branch) VALUES
  ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001',
   'Opslane Isolation Fixture', 'opslane/defender-test-fixture', 'main')
ON CONFLICT (id) DO NOTHING;

INSERT INTO environments (id, project_id, name) VALUES
  ('00000000-0000-0000-0000-000000000200', '00000000-0000-0000-0000-000000000020', 'production')
ON CONFLICT (id) DO NOTHING;

-- Raw project-2 ingest key:
-- opslane_pk_ndxw6ytboi3damrrgi3tknzxgq_E2EINGESTSECRETBBBBBBBBBBBBBBBBBBBBBBBBBBBB
INSERT INTO project_api_keys
  (id, key_id, project_id, scope, token_prefix, secret_hash, label)
VALUES
  ('00000000-0000-0000-0000-000000002000',
   'ndxw6ytboi3damrrgi3tknzxgq',
   '00000000-0000-0000-0000-000000000020',
   'ingest',
   'opslane_pk',
   '8560f0955838c94371bc064e9f40ce4a2390107a0d80651e3886251e675a90a4',
   'e2e isolation ingest')
ON CONFLICT (id) DO UPDATE SET
  project_id = EXCLUDED.project_id,
  secret_hash = EXCLUDED.secret_hash,
  revoked_at = NULL,
  revoked_by_user_id = NULL;

-- Raw project-2 source-map key (payload elided, as above):
-- opslane_sk_ncxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETBBBB…_<payload>
INSERT INTO project_api_keys
  (id, key_id, project_id, scope, token_prefix, secret_hash, label)
VALUES
  ('00000000-0000-0000-0000-000000002100',
   'ncxw6ytboi3damrrgi3tknzxgq',
   '00000000-0000-0000-0000-000000000020',
   'sourcemaps',
   'opslane_sk',
   'a61a22ece1ef51461677aae27b2014ed72e33eae0de334d7188c16e47acd0e36',
   'e2e isolation source maps')
ON CONFLICT (id) DO UPDATE SET
  project_id = EXCLUDED.project_id,
  secret_hash = EXCLUDED.secret_hash,
  revoked_at = NULL,
  revoked_by_user_id = NULL;

-- Test user for auth E2E (password: testpassword123, bcrypt cost 10)
INSERT INTO users (id, org_id, email, password_hash, name) VALUES
  ('00000000-0000-0000-0000-000000010000', '00000000-0000-0000-0000-000000000001',
   'admin@e2e.test', '$2b$10$G63dr4R.8EijgojPPTsQ8uC0hdGaPvtQ4UiSqj9Nbi0DH0Wh/xgi2', 'E2E Admin')
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash;

-- Test user for dashboard auth (password: defender123, bcrypt cost 10)
INSERT INTO users (id, org_id, email, password_hash, name) VALUES
  ('00000000-0000-0000-0000-000000020000', '00000000-0000-0000-0000-000000000001',
   'test@opslane.dev', '$2a$10$ke5hsybfrQnnbUqXdRmd9uyOS5rJNHlv1iegB0d9kVVO4N/O66ag6', 'Test User')
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
