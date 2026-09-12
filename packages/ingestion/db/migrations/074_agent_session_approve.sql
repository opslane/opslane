-- Agent-driven onboarding: sessions start without a repo, carry the agent's
-- proposed project name and git remote for the approve page, and live long
-- enough for a slow sign-up (2h, was 15m).
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS project_name TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS git_remote TEXT;
ALTER TABLE agent_sessions ALTER COLUMN expires_at SET DEFAULT now() + interval '2 hours';
