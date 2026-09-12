# GitHub connection self-healing design

Date: 2026-09-12. Branch: `abhishekray07/github-self-heal`. Companion plan: `docs/superpowers/plans/2026-09-12-github-self-healing.md`.

## Problem

Two real onboarding runs on 2026-09-12 (sessions `b9025247` for `abhishekray07/guardrail` and `8c4f3394` for `importcsv/marketing`) failed the GitHub step. Prod ingestion logs at 15:01:25Z show `failed to get installation token ... GitHub API error (status 404)` for installation `160980074`, the ID recorded on the org. The installation had been removed and recreated directly on GitHub, and Opslane never learned:

1. `HandleWebhook` processes only `pull_request` and `push`. `installation` and `installation_repositories` events are answered `ignored`, so a delete, suspend, or repo change on GitHub leaves `orgs.github_installation_id` and `github_app_installations.repos` stale forever.
2. `attachGitHubRepo` and `ListGitHubRepos` turn a GitHub 404 on the token call into HTTP 502 "could not reach GitHub". Cloudflare replaces every origin 502 with its own HTML page, so the agent and the Settings page received `<!DOCTYPE html>` instead of JSON. The Settings page rendered that HTML as the repository error.
3. When the token does work but the repo is not in the installation, the 400 message says "install it, then retry" without saying where. The human had no link to the GitHub page that adds a repository to an existing installation.
4. The runbook lets the agent give up after two non-200s and write "GitHub connected" in its summary while recording the step as failed.
5. The runbook leaves the SDK changes uncommitted in the working tree. Users expect the agent to finish by opening a pull request.

## Requirements

R1. **Self-heal a gone installation.** When GitHub answers 404 (deleted) or 403 with "suspended" for an installation token, mark the `github_app_installations` row suspended and null `orgs.github_installation_id` when it points at that installation. `github_installed` then reads false, Settings shows the Install button (whose OAuth-state callback links the new installation), and the agent is told to connect. Respond 409 with `code: "github_installation_gone"` and `github_connect_url`.

R2. **Keep installations current from GitHub webhooks.** Handle `installation` (`created`, `deleted`, `suspend`, `unsuspend`, `new_permissions_accepted`) and `installation_repositories` (`added`, `removed`) for installations Opslane already knows. Unknown installation IDs are logged and ignored: the OAuth-state callback is the only path that binds an installation to an org. Handlers are idempotent under redelivery.

R3. **Never emit 502 for a GitHub upstream failure.** Network errors and non-404 GitHub errors respond 503 with `Retry-After: 10` and `code: "github_unreachable"`. The dashboard's fetch wrapper turns any non-JSON error body into a one-line message so an HTML page can never render inside the UI.

R4. **Tell the human where to add the repo.** When the installation is live but the repo is not in it, respond 400 with `code: "repo_not_in_installation"` and `add_repo_url` set to the installation's `html_url` from `GET /app/installations/{id}` (a user installation resolves to `https://github.com/settings/installations/{id}`, an org installation to `https://github.com/organizations/{login}/settings/installations/{id}`). Settings renders the link. The runbook shows it, waits for the human, and retries the attach.

R5. **Runbook honesty.** The agent never says GitHub is connected unless the last state read has `github_connected: true`. The final summary is built from the recorded step statuses, one line per step.

R6. **Runbook ends with a pull request.** After source maps and MCP and before `complete`, the agent commits the setup changes on branch `opslane-setup` and opens a pull request with `gh` when it is authenticated, otherwise pushes the branch and prints the compare URL. It never commits the env file or `.opslane-setup/`. This is an outward action, so it says what it is about to do and asks first. Progress step `pull_request` is recorded and shown on the approve page.

## Non-goals

- Binding an installation created directly on GitHub to an org without the OAuth-state callback (no safe way to know which org).
- Changing the 502s in billing and embedded-auth handlers; they are not GitHub paths.
- Multi-installation selection for onboarding (already handled per repo by commit 84afe07).

## Status codes and error bodies

| Condition | Status | `code` | Extra fields |
|---|---|---|---|
| installation deleted or suspended on GitHub | 409 | `github_installation_gone` | `github_connect_url` |
| GitHub unreachable or unexpected 5xx | 503 + `Retry-After: 10` | `github_unreachable` | none |
| repo not in installation | 400 | `repo_not_in_installation` | `add_repo_url` (omitted if lookup fails) |
| no installation recorded | 400 | `github_not_installed` | `github_connect_url` |

Existing writers: `writeJSONError` emits `{"error": "<human message>"}` and `writeJSONErrorCode` emits `{"error": "<human message>", "code": "<machine code>"}`. The new helper keeps that shape (`error` is the sentence, `code` is the machine string) and adds the extra fields, so every existing client that reads `error` keeps working.

## Hosted rollout note

The hosted GitHub App must subscribe to the **Installation** and **Installation repositories** events in its GitHub App settings, or R2 never fires. This is a manual step in the GitHub App configuration, recorded in the plan's final task.

## Grill decisions (2026-09-12, after two Codex rounds)

- **G1.** The agent prints the session's own install link (`/agent/github/{id}`); the page asks the human to sign in first, mints the install state for them, and sends them to GitHub. Supersedes decision 15 of the onboarding grill ("Settings page plus Install button, no deep link").
- **G2.** The pull-request step asks "Create a new branch and open a PR?", commits with `git commit --only` on the setup's own files, and never refuses because the user had something staged.
- **G3.** `github_connected` requires the repo to be listed by an active installation. A GitHub-side removal shows "lost access" with the add-repo link; Opslane never clears project config on a GitHub-side change (Disconnect in Settings remains the explicit way).
- **G4.** Migration 076 drops the `agent_session_steps.step` CHECK; the Go allowlist is the only gate for step names.
- **G5.** When the App already covers the repo, the agent attaches without asking and announces it with the undo location; it stops only for install, reinstall, or add-repo, and every stop offers "later".
- **G6.** Completing an install stays admin-only in cloud; the install page tells a member to hand the link to an admin, and the agent records the step as skipped for that reason.
