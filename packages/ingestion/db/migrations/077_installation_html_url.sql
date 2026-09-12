-- The GitHub page where a human edits an installation's repository access
-- (users: /settings/installations/{id}; orgs: /organizations/{login}/settings/
-- installations/{id}). Stored at install time so read paths never call GitHub.
ALTER TABLE github_app_installations ADD COLUMN IF NOT EXISTS html_url TEXT NOT NULL DEFAULT '';
