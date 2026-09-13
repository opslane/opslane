# GitHub install link: click-time state and operator linking

Date: 2026-09-13. Branch: `abhishekray07/github-link-installation`. Companion plan: `docs/superpowers/plans/2026-09-13-github-install-link.md`.

## Problem

On 2026-09-13 at 00:01:23Z a new user installed the hosted GitHub App (installation `161250809`, account `agentwebpro`) from the setup wizard. GitHub created the installation, but Opslane's callback answered 403 `invalid OAuth state`, so Opslane never recorded it. The dashboard still says GitHub is not connected. The `installation` webhook for it was ignored because the installation maps to no organization. The same failure hit an `importcsv` reinstall on 2026-09-12 at 14:49Z.

Root cause: `GET /api/v1/github/status` mints a new install state, stores it, and overwrites the `__auth_state` cookie on every call. The wizard opens the Install link in a new tab and then polls that endpoint every 4 seconds. The first poll replaces the cookie, so the state GitHub later sends back no longer matches the browser's cookie.

## Requirements

R1. **Status never mints.** `GET /api/v1/github/status` returns `installed`, `installation_id`, and `install_available` (true when this Opslane has a GitHub App slug). It sets no cookie, writes no `oauth_login_states` row, and sends `Cache-Control: no-store`. `install_url` is removed from its response.

R2. **Mint on click.** `POST /api/v1/github/install-url` (session auth, admin on cloud) mints single-use install state for the caller's active organization and user, sets `__auth_state` (Path `/auth`, 30 minutes), and returns `{"install_url": "https://github.com/apps/<slug>/installations/new?state=…"}`. With no App slug it answers 400 `github_app_not_configured`. The agent endpoint `POST /api/v1/agent/github/{sessionID}/install-url` shares the same minting code and keeps its behavior.

R3. **Dashboard opens a click-time page.** The wizard's and Settings' Install links point at the dashboard route `/github/install`. That page calls R2 once and replaces itself with the GitHub URL, the same way `/agent/github/:id` works for agents. The wizard keeps its new tab and 4-second polling, which is now harmless. The route is exempt from the project gate and resumes after sign-in.

R4. **Operator linking.** A `link-installation` command in the ingestion image links an installation that exists on GitHub to an Opslane organization with no user action. It verifies before writing:
1. The App credentials belong to `GITHUB_APP_ID` (`GET /app`).
2. The installation exists for this App and its account login equals `-expect-account`, case-insensitively.
3. An installation token mints, so the installation is not suspended, and its repositories list.
4. The organization exists.
5. The installation is not linked to a different organization, through its installation record or through any organization's legacy `github_installation_id`, which is not unique.
6. When `-project` is given, the project belongs to that organization. The repository resolves from `-repo` or from a single-repository installation. The project is not already connected to a different repository.

Without `-apply` it prints what it found and writes nothing. With `-apply` it writes through `PersistInstallation` in one transaction, then connects the project with `SetProjectGitHubConfig`. It finishes by reading back that this installation is linked only to that organization, is the organization's active installation, and covers the repository.

## Decisions

- **D1.** `install_url` leaves the status response. A dashboard tab loaded before the deploy shows no Install link until it reloads. This is an explicit contract change recorded in `docs/reference/http-routes.md`.
- **D2.** The state lifetime is 30 minutes for both the dashboard and the agent. Choosing repositories or creating a GitHub organization can take longer than the old 5 minutes. The state stays single-use and bound to the user and organization.
- **D3.** Clicking Install twice still replaces the cookie, so only the newest GitHub tab can finish. That is accepted: it needs two deliberate clicks, not a background poll.
- **D4.** The operator command skips the user-ownership proof that the OAuth callback performs. The operator supplies that proof by matching the account login, reviewing the dry run, and getting explicit approval before `-apply`. The command never moves an installation between organizations.
- **D5.** The command is not atomic across the installation write and the project connect. Each half is idempotent, so a failed second half is fixed by re-running with `-apply`. It does not lock the project between its check and its write, so a repository change made in Settings in those seconds would be overwritten; that is accepted for a supervised one-off command.
- **D6.** `POST /api/v1/github/install-url` has no Origin or CSRF-token check, like every other cookie-authenticated POST in this API. SameSite=Lax blocks cross-site requests. A hostile same-site origin could at most replace an in-progress install state, the same exposure the agent endpoint already has, and the state stays bound to the signed-in user and organization. A CSRF layer for the whole API is a separate change.
- **D7.** On the organization route, a member who gets 403 is told to ask an admin, with no shareable link: that URL installs for whichever organization the opener has active. The agent route keeps its shareable link because it names its session's organization.
- **D8.** Only a deployment administrator can run the command in production. The devbox AWS identity is read-only and cannot run the ingestion task definition.

## Non-goals

- Handling GitHub's `setup_action=update` return from "Configure" on an existing installation.
- Linking one installation to several Opslane organizations.
- Changing the agent onboarding runbook, whose link is already click-time.
