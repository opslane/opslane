---
covers:
  - packages/worker/src/github-app.ts
  - packages/worker/src/pr.ts
  - packages/worker/src/repo-clone.ts
  - packages/ingestion/auth/github_provider.go
  - packages/ingestion/handler/agent_setup.go
  - packages/ingestion/handler/routes.go
  - packages/ingestion/main.go
description: Give Opslane access to your repository with a GitHub App or a personal access token.
---

# Connect GitHub

Opslane needs access to your repository to read your code, open pull requests, and watch your CI. There are two ways to give it access. Pick one.

## Personal access token mode

Use this mode when self-hosting without a GitHub App. Create a GitHub token with **Contents** read/write, **Pull requests** read/write, and read access to **Checks** and **Commit statuses**. A classic token's `repo` scope covers all of these. Leave `GITHUB_APP_SLUG` unset, then start Opslane with the token:

```bash
export GITHUB_TOKEN=github_pat_...
docker compose up -d
```

A token lets Opslane clone repositories, open pull requests, and read CI. It does not power dashboard sign-in or the GitHub App repo picker. During onboarding, enter the repository as `owner/repo`; Opslane verifies that `GITHUB_TOKEN` can reach it before saving the project setting. You can also attach a repository through the session-authenticated API:

```bash
PUT /api/v1/projects/{projectID}/github
```

## GitHub App mode

Use a GitHub App to scope access to selected repositories and power dashboard sign-in. The onboarding wizard presents the App install link, waits for the installation, and then opens the repo picker. If a GitHub organization admin must approve the installation, choose **Do this later** and finish onboarding; the dashboard keeps a GitHub reminder visible until the installation and repository connection are complete.

On **hosted Opslane** the App already exists: Settings → GitHub → Install, pick your repositories, done.

To **self-host**, create your own App once (GitHub → Settings → Developer settings → GitHub Apps) with:

- Permissions: **Contents** read/write, **Pull requests** read/write, **Checks** read, **Commit statuses** read
- Events: **Pull request** and **Push**
- Callback URL: `https://your-instance/auth/github/callback`
- Webhook URL: `https://your-instance/api/v1/github/webhook` (with a secret)

Then set these before `docker compose up`:

```bash
export GITHUB_APP_ID=...
export GITHUB_APP_PRIVATE_KEY="$(cat your-app.private-key.pem)"
export GITHUB_APP_CLIENT_ID=...
export GITHUB_APP_CLIENT_SECRET=...
export GITHUB_APP_SLUG=your-app-slug
export GITHUB_WEBHOOK_SECRET=...
export DASHBOARD_ORIGIN=http://localhost:8082
```

If you created the App before Opslane read CI, approve the **Checks** and **Commit statuses** read permissions in GitHub. Until you do, Opslane leaves fixes as drafts rather than assuming that missing CI means a fix is fine.

## Point a project at a repo

Each project maps to one repository. In App mode, open project → Settings → GitHub and pick the repo. In PAT mode, enter `owner/repo` in the onboarding wizard or call the project GitHub endpoint. Opslane stores only the repo name and authenticates through your App or token each time it acts.

## What Opslane does with the access

It clones your repo to read your code, opens pull requests on its own branches (never force-pushing, and never to your branches), reads CI for the exact commit it pushed, and never merges. When it can't do something, it stops with a reason. See [reason codes](../reference/reason-codes.md).
