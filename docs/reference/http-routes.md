# HTTP routes

All routes registered by the ingestion API (`packages/ingestion/handler/routes.go`). Auth column legend: **none** (public), **poll token** (`X-Opslane-Poll-Token` for one agent session), **SDK** (`X-API-Key` project-scoped public ingest key; rate-limited per project, and origin-gated — unconditionally on the browser-only endpoints, and on `/api/v1/events` only when the request presents `Origin` or `Referer`), and **session** (dashboard JWT cookie or CLI token).

These are curated tables, not a stability contract — the API is early-stage and may change. The [drift check](../../scripts/check-docs-drift.mjs) fails the repository test gate (`pnpm test`, which CI runs) if this page and `routes.go` disagree.

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
| POST | `/auth/oauth/verify-email` | flow cookie + same origin | Complete a hosted OAuth email challenge and resume the browser or CLI flow |
| POST | `/auth/password/forgot` | none | Send a password-reset email with an enumeration-safe response |
| POST | `/auth/password/reset` | none | Set a new password from a reset token and revoke local refresh sessions |
| GET | `/auth/login` | none | Begin the configured identity-provider sign-in |
| GET | `/auth/github` | none | Compatibility redirect to `/auth/login` |
| GET | `/auth/callback` | none | Configured identity-provider callback |
| GET | `/auth/github/callback` | none | Compatibility callback alias for existing GitHub App configurations |
| GET+POST | `/oauth/authorize` | none | CLI PKCE authorization |
| POST | `/oauth/token` | none | CLI PKCE token exchange |
| POST | `/api/v1/agent/setup` | none | Agent-first onboarding start |
| GET | `/api/v1/agent/poll/{sessionID}` | poll token (`X-Opslane-Poll-Token`) | Agent onboarding poll |
| GET | `/agent/auth/{sessionID}` | none | Agent onboarding browser auth |
| GET | `/agent/auth/callback` | none | Agent onboarding callback |
| POST | `/api/v1/github/webhook` | HMAC | GitHub webhook receiver — requires `X-GitHub-Delivery` (400 without it); responds `processed`, `no_match`, or `duplicate` (idempotent on redelivery) |

The agent callback requires `code`, `installation_id`, and UUID `state`; definitive failures are returned by polling as machine-readable reasons. `/auth/callback` dispatches UUID-state GitHub App installs to the agent flow and handles other states through the existing browser-login/install flow.

## SDK (X-API-Key)

| Method | Path | Origin-gated | Purpose |
| --- | --- | --- | --- |
| POST | `/api/v1/events` | browser callers only | Ingest an error event; optional payload `environment` is project-gated and falls back to production |
| POST | `/api/v1/replays/init` | yes | Begin a replay upload |
| POST | `/api/v1/replays/{replayID}/complete` | yes | Finish a replay upload |
| POST | `/api/v1/replays/{replayID}/fail` | yes | Record a replay upload failure |
| POST | `/api/v1/sessions/init` | yes | Register a tenant-owned session with optional payload `environment`; returns the recording kill switch |
| POST | `/api/v1/sessions/{sessionID}/chunks/{seq}` | yes | Store and commit one gzipped replay chunk (max 5MiB) |
| POST | `/api/v1/ingest/ping` | no | Verify that a public ingest key still authenticates; returns 204 without project data |

## Source-map upload (X-API-Key)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| PUT | `/api/v1/sourcemaps/{debugID}` | secret source-map key | Upload one immutable source map after server-side debug-ID verification |

## Session (dashboard/CLI)

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
| GET | `/api/v1/admin/overview` | Operator-only cross-tenant observability overview incl. best-effort agent-onboarding funnel (404 unless allowlisted) |
| GET | `/api/v1/admin/jobs` | Operator-only recent jobs (404 unless allowlisted) |
| POST | `/api/v1/onboard/provision` | Provision an org/project for a repo and seal the API key into an agent session for poll delivery |
| POST | `/api/v1/onboarding/setup` | First-run setup |
| GET | `/api/v1/projects` | List projects |
| POST | `/api/v1/projects` | Create project |
| PATCH | `/api/v1/projects/{projectID}` | Update project settings, including `friction_autonomy`, `pr_posture`, and the admin-gated `allow_payload_environment` override flag (partial: omitted/null fields are preserved, so `github_repo` can no longer be cleared here) |
| GET | `/api/v1/projects/{projectID}/fix-stats` | Per-kind fix generation and PR outcome receipts |
| GET | `/api/v1/projects/{projectID}/environments` | List environments |
| POST | `/api/v1/projects/{projectID}/environments` | Create environment |
| GET | `/api/v1/projects/{projectID}/event-count` | Event count stats |
| GET | `/api/v1/projects/{projectID}/incidents` | List incidents |
| GET | `/api/v1/projects/{projectID}/incidents/{incidentID}` | Incident detail |
| GET | `/api/v1/projects/{projectID}/notification-destinations` | List project notification destinations and recent delivery state |
| POST | `/api/v1/projects/{projectID}/notification-destinations` | Create a Slack notification destination |
| PATCH | `/api/v1/projects/{projectID}/notification-destinations/{destID}` | Update a notification destination |
| DELETE | `/api/v1/projects/{projectID}/notification-destinations/{destID}` | Delete a notification destination |
| POST | `/api/v1/projects/{projectID}/notification-destinations/{destID}/test` | Send a test notification |
| GET | `/api/v1/projects/{projectID}/replays/{replayID}` | Fetch a replay |
| GET | `/api/v1/projects/{projectID}/sessions` | List sessions with filters and keyset pagination |
| GET | `/api/v1/projects/{projectID}/sessions/{sessionID}` | Session detail and scrubbed chunk manifest |
| GET | `/api/v1/projects/{projectID}/sessions/{sessionID}/chunks/{seq}` | Fetch one decoded, re-redacted scrubbed chunk |
| GET | `/api/v1/projects/{projectID}/incidents/{incidentID}/affected-users` | Affected users |
| GET | `/api/v1/projects/{projectID}/incidents/{incidentID}/sample-event` | Fetch the redacted representative error event for traceback, breadcrumbs, and request context |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/fix` | Trigger an eligible error or approved friction fix |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/resolve` | Resolve incident |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/archive` | Archive incident |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/unarchive` | Unarchive incident |
| GET | `/api/v1/projects/{projectID}/accounts` | List B2B accounts |
| GET | `/api/v1/projects/{projectID}/accounts/{accountID}` | Account detail |
| GET | `/api/v1/projects/{projectID}/accounts/{accountID}/incidents` | Account incidents |
| GET | `/api/v1/github/setup` | GitHub App install callback |
| GET | `/api/v1/github/status` | GitHub App status |
| GET | `/api/v1/github/repos` | List installable repos |
| PUT | `/api/v1/projects/{projectID}/github` | Set project repo config |
| GET | `/api/v1/projects/{projectID}/github` | Get project repo config |
| DELETE | `/api/v1/projects/{projectID}/github` | Remove project repo config |
| POST | `/api/v1/projects/{projectID}/setup-pr` | Open SDK setup PR |
| GET | `/api/v1/projects/{projectID}/setup-pr` | Setup PR status |

## Internal service reads

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/internal/v1/projects/{projectID}/sessions/{sessionID}/chunks/{seq}` | `X-Internal-Token` | Worker fetch of one decoded, re-redacted scrubbed chunk |

## Catch-all

Any other path serves the dashboard SPA from `DASHBOARD_DIR` (missing static assets 404 rather than falling back to `index.html`).
