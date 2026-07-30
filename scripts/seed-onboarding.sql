-- Deterministic onboarding-reporting seed. Apply scripts/seed-e2e.sql first.
--
-- Raw development public ingest key:
-- opslane_pk_onxw4z3fojrw63lqmfrwg33vnq_qrstuvwxyzABCDEFGHIJKLMNOPQRSTUV0123456789A
-- Raw poll token: opt_9001e986d7d75a0051a2e832119dc17b3aec0390e8d1b986b0c2212fbc23cb5c
--
-- Matching pending file (~/.opslane/pending/00000000-0000-4000-8000-00000000a001.json):
-- {"poll_id":"00000000-0000-4000-8000-00000000a001","poll_token":"opt_9001e986d7d75a0051a2e832119dc17b3aec0390e8d1b986b0c2212fbc23cb5c","api_url":"http://localhost:8082","repo":"opslane/defender-test-fixture","created_at":"2026-07-21T00:00:00.000Z"}

INSERT INTO environments (id, project_id, name) VALUES
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000010', 'development')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO project_api_keys
  (id, key_id, project_id, scope, token_prefix, secret_hash, label)
VALUES
  ('00000000-0000-0000-0000-000000001001',
   'onxw4z3fojrw63lqmfrwg33vnq',
   '00000000-0000-0000-0000-000000000010',
   'ingest',
   'opslane_pk',
   'e2add58b4892f2e3fde7989de34205c96a5b5dc1f195acb16c2bdbbfd73f304f',
   'e2e agent setup')
ON CONFLICT (id) DO UPDATE SET
  project_id = EXCLUDED.project_id,
  secret_hash = EXCLUDED.secret_hash,
  revoked_at = NULL,
  revoked_by_user_id = NULL;

INSERT INTO agent_sessions (
  id, repo_url, status, org_id, project_id, poll_token_hash, agent_key_pub,
  api_key_sealed, expires_at, completed_at, key_claimed_at, failure_reason
) VALUES (
  '00000000-0000-4000-8000-00000000a001',
  'opslane/defender-test-fixture',
  'provisioned',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000010',
  '1dd1432510c1f0541b2e3aeb3cc70e35766471c7e3859c8e370f47194da988e6',
  '9cjjJ7AOfdXVKfWwI3CsBHLxOf1YvmCOh+/V/KAG8Qk=',
  'gULXg04LcWTbbMRokirsvc3FdFuqTv/1YhRn/gfU9mdpEiPwRAbJeWi2S4plJp0n3vUmTDh5pt7RoqCsWtrHYsuD0lkK1+zTi0wW0mT3lf1ffiGC4VvftLh7Y+BAKzPJ56lg2iRUJpWfDjz467TaI9FxD+ZeaqaXGQxuOWAae5tS+LJcXaI8PEqo02Fl',
  now() + interval '24 hours',
  NULL,
  NULL,
  NULL
)
ON CONFLICT (id) DO UPDATE SET
  status = 'provisioned',
  org_id = EXCLUDED.org_id,
  project_id = EXCLUDED.project_id,
  poll_token_hash = EXCLUDED.poll_token_hash,
  agent_key_pub = EXCLUDED.agent_key_pub,
  api_key_sealed = EXCLUDED.api_key_sealed,
  expires_at = EXCLUDED.expires_at,
  completed_at = NULL,
  key_claimed_at = NULL,
  failure_reason = NULL;
