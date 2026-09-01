---
description: Every registered HTTP route with its authentication mode.
---
# HTTP routes

All routes registered by the Opslane API (`packages/ingestion/handler/routes.go`). Auth column legend: **none** (public), **poll token** (`X-Opslane-Poll-Token` for one automated repository setup), **SDK** (`X-API-Key` project-scoped public ingest key; rate-limited per project, and origin-gated on browser requests), and **session** (signed-in dashboard session).

These are curated tables, not a stability contract. The API is early-stage and may change. The [drift check](../../scripts/check-docs-drift.mjs) fails the repository test gate (`pnpm test`, which CI runs) if this page and `routes.go` disagree.

## Public

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness + dependency checks |
| GET | `/metrics` | none | Internal metrics |
| POST | `/auth/refresh` | none | Rotate session tokens |
| GET | `/auth/config` | none | Discover embedded sign-in, sign-up, and password-reset capabilities |
| POST | `/auth/password` | none | Sign in with provider-managed email and password; issues local session cookies |
| POST | `/auth/signup` | none | Create a provider account and begin required email verification |
| POST | `/auth/verify-email` | none | Complete email verification and issue local session cookies |
| POST | `/auth/oauth/verify-email` | flow cookie + same origin | Complete a hosted OAuth email challenge and resume sign-in |
| POST | `/auth/password/forgot` | none | Send a password-reset email with an enumeration-safe response |
| POST | `/auth/password/reset` | none | Set a new password from a reset token and revoke local refresh sessions |
| GET | `/auth/login` | none | Begin the configured identity-provider sign-in |
| GET | `/auth/github` | none | Compatibility redirect to `/auth/login` |
| GET | `/auth/callback` | none | Configured identity-provider callback |
| GET | `/auth/github/callback` | none | Compatibility callback alias for existing GitHub App configurations |
| GET+POST | `/oauth/authorize` | none | Begin an authorization request using PKCE |
| POST | `/oauth/token` | none | Exchange a PKCE authorization code for a session token |
| POST | `/api/v1/agent/setup` | none | Start automated repository setup |
| GET | `/api/v1/agent/poll/{sessionID}` | poll token (`X-Opslane-Poll-Token`) | Check automated repository setup status |
| GET | `/agent/auth/{sessionID}` | none | Browser authentication for automated repository setup |
| GET | `/agent/auth/callback` | none | Authentication callback for automated repository setup |
| POST | `/api/v1/github/webhook` | HMAC | Receive GitHub pull-request and default-branch push events; requires `X-GitHub-Delivery` (400 without it). Push events refresh Opslane's understanding of your pages and user actions. |
| POST | `/mcp` | MCP key in `Authorization: Bearer ...` | Call the remote MCP tools for one project |

The automated-setup callback requires `code`, `installation_id`, and UUID `state`. It returns final failures to the setup client as machine-readable reasons when the client checks status. `/auth/callback` sends GitHub App installs with a UUID `state` to automated setup and handles other states through the existing browser login and installation process.

## SDK (X-API-Key)

| Method | Path | Origin-gated | Purpose |
| --- | --- | --- | --- |
| POST | `/api/v1/events` | browser callers only | Store an error event and queue source-map processing. Receiving an error does not immediately create an issue, investigation, or alert. |
| POST | `/api/v1/replays/init` | yes | Begin a replay upload |
| POST | `/api/v1/replays/{replayID}/complete` | yes | Finish a replay upload |
| POST | `/api/v1/replays/{replayID}/fail` | yes | Record a replay upload failure |
| POST | `/api/v1/sessions/init` | yes | Register a tenant-owned session with optional payload `environment`; returns whether the project allows session recording |
| POST | `/api/v1/sessions/{sessionID}/chunks/{seq}` | yes | Store and commit one gzipped replay chunk (max 5MiB) |
| POST | `/api/v1/ingest/ping` | no | Verify that a public ingest key still authenticates; returns 204 without project data |

## Source-map upload (X-API-Key)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| PUT | `/api/v1/sourcemaps/{debugID}` | secret source-map key | Upload one immutable source map after the server verifies its build identifier, which matches the map to a built file |

## Signed-in dashboard

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/auth/me` | Current user |
| GET | `/api/v1/auth/verify` | Validate session |
| POST | `/api/v1/auth/logout` | End session |
| POST | `/auth/switch-org` | Cloud only: rotate the current session into another member organization |
| GET | `/api/v1/invitations` | Cloud org admin: list active-org invitations |
| POST | `/api/v1/invitations` | Cloud org admin: create an active-org invitation |
| DELETE | `/api/v1/invitations/{invitationID}` | Cloud org admin: revoke an outstanding invitation |
| POST | `/api/v1/invitations/accept` | Cloud: accept a single-use, verified-email-bound invitation |
| GET | `/api/v1/billing/summary` | Billing-enabled deployments: read the active org's plan and feature balances (admin on cloud) |
| POST | `/api/v1/billing/checkout` | Billing-enabled deployments: start Pro checkout for the active org (admin on cloud) |
| POST | `/api/v1/billing/portal` | Billing-enabled deployments: open the active org's billing portal (admin on cloud) |
| GET | `/api/v1/admin/overview` | Operator-only cross-tenant monitoring overview, including best-effort progress through automated repository setup (404 unless allowlisted) |
| GET | `/api/v1/admin/jobs` | Operator-only recent jobs (404 unless allowlisted) |
| POST | `/api/v1/onboard/provision` | Create an organization and project for a repository, then store the one-time API key for the setup client to retrieve |
| POST | `/api/v1/onboarding/setup` | Create or resume the first project and return a fresh ingest key |
| GET | `/api/v1/onboarding/state` | Read server-derived onboarding facts and the next step |
| POST | `/api/v1/onboarding/complete` | Mark onboarding complete after the project receives its first event; GitHub and Slack are optional (admin on cloud) |
| GET | `/api/v1/projects` | List projects |
| POST | `/api/v1/projects` | Create project |
| PATCH | `/api/v1/projects/{projectID}` | Update project settings. `friction_autonomy` controls automatic fixes for session-recording issues; `pr_posture` controls whether unverified fixes may open as drafts. A same-project `default_environment_id` must be an explicit UUID string when present. |
| GET | `/api/v1/projects/{projectID}/fix-stats` | Fix-attempt and pull-request outcome counts by issue type |
| GET | `/api/v1/projects/{projectID}/environments` | List all environments, or only environments that contain issues with `used_by=incidents` or sessions with `used_by=sessions` |
| GET | `/api/v1/projects/{projectID}/event-count` | Return `has_events` and the nullable `latest_error_group_id` |
| GET | `/api/v1/projects/{projectID}/digest/latest` | Latest delivered daily summary, or an empty summary when none has been delivered |
| POST | `/api/v1/projects/{projectID}/api-keys` | Create an MCP key or, with `scope: "ingest"`, a browser ingest key; the secret is returned once (admin) |
| GET | `/api/v1/projects/{projectID}/api-keys` | List the project's MCP and ingest keys without showing their secrets (admin) |
| DELETE | `/api/v1/projects/{projectID}/api-keys/{keyID}` | Revoke an MCP or ingest key (admin) |
| GET | `/api/v1/projects/{projectID}/incidents` | List issues |
| GET | `/api/v1/projects/{projectID}/incidents/{incidentID}` | Issue detail |
| GET | `/api/v1/projects/{projectID}/incidents/{incidentID}/evidence` | Saved stack frames, failed requests, links to recordings, and available supporting data for the current issue |
| GET | `/api/v1/projects/{projectID}/notification-destinations` | List project notification destinations and recent delivery state |
| POST | `/api/v1/projects/{projectID}/notification-destinations` | Create a Slack notification destination |
| PATCH | `/api/v1/projects/{projectID}/notification-destinations/{destID}` | Update a notification destination |
| DELETE | `/api/v1/projects/{projectID}/notification-destinations/{destID}` | Delete a notification destination |
| POST | `/api/v1/projects/{projectID}/notification-destinations/{destID}/test` | Send a test notification |
| GET | `/api/v1/projects/{projectID}/replays/{replayID}` | Fetch a replay |
| GET | `/api/v1/projects/{projectID}/sessions` | List sessions with filters and keyset pagination |
| GET | `/api/v1/projects/{projectID}/sessions/{sessionID}` | Session detail and recording metadata with sensitive values removed |
| GET | `/api/v1/projects/{projectID}/sessions/{sessionID}/narrative` | Fetch the session narrative, finding grades, and verification timestamp |
| GET | `/api/v1/projects/{projectID}/sessions/{sessionID}/chunks/{seq}` | Fetch one decoded, redacted part of the recording |
| GET | `/api/v1/projects/{projectID}/incidents/{incidentID}/affected-users` | Affected users |
| GET | `/api/v1/projects/{projectID}/incidents/{incidentID}/sample-event` | Fetch the redacted representative error event for traceback, breadcrumbs, and request context |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/fix` | Start a fix for an issue that is ready to fix, whether it came from an error or a session recording |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/review` | Request another short repository review for the current issue; reuses an investigation already in progress |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/link-pr` | Record a same-repository GitHub pull request without marking the issue resolved |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/resolve` | Resolve issue |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/archive` | Archive issue |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/snooze` | Snooze an actionable issue for up to 30 days; a null or past `until` clears the snooze |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/unarchive` | Restore archived issue |
| GET | `/api/v1/projects/{projectID}/accounts` | List B2B accounts |
| GET | `/api/v1/projects/{projectID}/accounts/{accountID}` | Account detail |
| GET | `/api/v1/projects/{projectID}/accounts/{accountID}/incidents` | Issues for one account |
| GET | `/api/v1/github/setup` | GitHub App install callback |
| GET | `/api/v1/github/status` | GitHub App status |
| GET | `/api/v1/github/repos` | List installable repos |
| PUT | `/api/v1/projects/{projectID}/github` | Set project repo config |
| GET | `/api/v1/projects/{projectID}/github` | Get project repo config |
| DELETE | `/api/v1/projects/{projectID}/github` | Remove project repo config |

## Internal service reads

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/internal/v1/projects/{projectID}/sessions/{sessionID}/chunks/{seq}` | `X-Internal-Token` | Worker fetch of one decoded, redacted part of the recording |
| GET | `/internal/v1/projects/{projectID}/incidents/{incidentID}/status` | `X-Internal-Token` | Read one issue's status for the deployment smoke test |

## Method mismatch

A request whose path is registered but whose method is not returns a JSON `404`, not a `405`.
The router sets one `MethodNotAllowed` handler, so this holds for every route above; an
unregistered method is indistinguishable from an unregistered path. Handlers that write
`405` themselves (password-reset flows) are unaffected.

## Catch-all

Any other path serves the dashboard SPA from `DASHBOARD_DIR` (missing static assets 404 rather than falling back to `index.html`).
