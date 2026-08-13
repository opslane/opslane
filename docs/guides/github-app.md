---
covers:
  - packages/worker/src/github-app.ts
  - packages/worker/src/pr.ts
  - packages/worker/src/repo-clone.ts
  - packages/worker/src/setup-pr.ts
  - packages/ingestion/auth/github_provider.go
  - packages/ingestion/handler/agent_setup.go
  - packages/ingestion/handler/routes.go
  - packages/ingestion/main.godescription: Give Opslane access to your repository with a GitHub App or a personal access token.
---

# Connecting GitHub

The worker needs GitHub access for cloning during investigation, publishing fix PRs, and reading repository CI for draft promotion. There are two credential modes; pick one.

## Mode 1: personal access token (worker-only, fastest to try)

Create a token for the repositories you want Opslane to work on. A classic PAT needs the **`repo`** scope, which covers contents, pull requests, checks, and commit statuses. For a fine-grained PAT, grant **Contents: read/write**, **Pull requests: read/write**, and read access to **Checks** and **Commit statuses**. Then:

```bash
export GITHUB_TOKEN=github_pat_...
docker compose up -d
```

Be clear about what this mode covers: **the worker only** — cloning, opening PRs, and observing CI. It does **not** enable dashboard sign-in (that's GitHub OAuth, which needs App client credentials) or the dashboard's repository picker (which lists App installations). With PAT-only, set the project's repository via the API (`PUT /api/v1/projects/{projectID}/github`) or a seed script rather than the dashboard. Suitable for trying the pipeline; use Mode 2 for anything multi-user.

## Mode 2: GitHub App

A GitHub App gives you short-lived installation tokens scoped to explicitly selected repositories, dashboard sign-in (OAuth), and webhooks.

**Hosted Opslane** already has the App — you just install it: Dashboard → Settings → GitHub → *Install*, which sends you to `github.com/apps/<slug>/installations/new`; pick the repositories; you land back in the dashboard with status connected.

**Self-host** requires creating your own App once (GitHub → Settings → Developer settings → GitHub Apps):

- Permissions: **Contents** read/write, **Pull requests** read/write, **Checks** read
- Event subscriptions: **Pull request** — required; the webhook handler acts on `pull_request` `closed` events to transition merged/closed fix PRs, so without this subscription incidents stay in `pr_created` forever
- Callback URL: `https://your-instance/auth/github/callback`
- Setup URL: `https://your-instance/api/v1/github/setup`
- Webhook URL: `https://your-instance/api/v1/github/webhook` + a webhook secret

### Extra requirements for agent onboarding

If agents will set up projects via `opslane setup` (see the agent quickstart), the App additionally needs:

- **"Request user authorization (OAuth) during installation" enabled** — the agent flow verifies the authorizing human's identity in the same interaction as the install.
- **Account permission "Email addresses: Read-only"** — the identity check reads the authorizer's verified email; without this permission every agent authorization fails with "GitHub check failed".
- The **Callback URL** must be your server's `/auth/github/callback` (one shared callback dispatches both the web login flow and agent sessions).

Existing installations must approve the **Checks: read** permission upgrade in
GitHub before Opslane can observe CI. Until it is approved, draft PRs remain drafts
and their evidence records `permission_denied`; Opslane does not silently treat
missing access or zero visible checks as a pass. The dashboard's GitHub settings
section shows the same upgrade notice.

Then provide its identity to both services before `docker compose up`:

```bash
export GITHUB_APP_ID=...
export GITHUB_APP_PRIVATE_KEY="$(cat your-app.private-key.pem)"
export GITHUB_APP_CLIENT_ID=...        # OAuth sign-in
export GITHUB_APP_CLIENT_SECRET=...    # OAuth sign-in
export GITHUB_APP_SLUG=your-app-slug
export GITHUB_WEBHOOK_SECRET=...
export DASHBOARD_ORIGIN=http://localhost:8082   # Compose setup
```

## Point a project at a repository

Each Opslane project maps to one repository: Dashboard → project → Settings → GitHub → choose from the repositories your installation can see. (API: `PUT /api/v1/projects/{projectID}/github` — only the repo name is stored; authentication always comes from the App installation or token at use time.)

## The setup PR

Once connected, Opslane can open a **setup PR** against your repo that adds the SDK initialization for you. It is triggered automatically inside the initial project-setup wizard (after the ingest key step); for an **existing** project there is no dashboard button — invoke it via the API:

```bash
POST /api/v1/projects/{projectID}/setup-pr
```

Merge the PR, deploy, trigger a test error, and confirm the first event arrives — same flow as the [install guide](../install.md).

## What Opslane will and won't do with this access

Covered precisely in [trust](../architecture/trust.md): clones for investigation, reserves and reconciles stable Opslane fix branches (no force pushes, never to customer branches), opens ready or draft PRs, reads CI for the exact published commit, and never merges. Access failures surface as explicit incident states or evidence: `missing_github_token`, `repo_access_denied`, `auth_invalid`, `policy_blocked`, and CI `permission_denied` — each with remediation ([reason codes](../reference/reason-codes.md)).
