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
