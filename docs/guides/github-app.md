---
covers:
  - packages/worker/src/github-app.ts
  - packages/worker/src/pr.ts
  - packages/worker/src/repo-clone.ts
  - packages/worker/src/setup-pr.ts
  - packages/ingestion/auth/github_provider.go
  - packages/ingestion/handler/agent_setup.go
  - packages/ingestion/handler/routes.go
  - packages/ingestion/main.go
description: Give Opslane access to your repository with a GitHub App or a personal access token.
---

# Connect GitHub

Opslane needs access to your repository to read your code, open pull requests, and watch your CI. There are two ways to give it access. Pick one.

## Quick way: a personal access token

Good for trying Opslane on a repo or two. Create a GitHub token with **Contents** read/write, **Pull requests** read/write, and read access to **Checks** and **Commit statuses**. (A classic token's `repo` scope covers all of these.) Then:

```bash
export GITHUB_TOKEN=github_pat_...
docker compose up -d
```

A token only lets Opslane clone, open PRs, and read CI. It doesn't power dashboard sign-in or the repo picker, so set each project's repo through the API instead of the dashboard:

```bash
PUT /api/v1/projects/{projectID}/github
```

## Full way: a GitHub App

Use a GitHub App for anything beyond a quick trial. It scopes access to the repos you pick and powers dashboard sign-in.

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

Each project maps to one repository. In the dashboard: project → Settings → GitHub → pick the repo. Opslane stores only the repo name and authenticates through your App or token each time it acts.

## What Opslane does with the access

It clones your repo to read your code, opens pull requests on its own branches (never force-pushing, and never to your branches), reads CI for the exact commit it pushed, and never merges. When it can't do something, it stops with a reason. See [reason codes](../reference/reason-codes.md).
