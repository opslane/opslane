# Agent-driven onboarding: "paste this into your agent"

Date: 2026-09-11. Status: implementation authorized on 2026-09-12; verification in progress below. Earlier proposals are retained as design history; the decision table and later decisions take precedence.

The question: everybody installs SDKs through a coding agent now. How do we make Opslane onboarding a single line the user pastes into Claude Code, Codex, or Cursor, where the agent does everything and stops only when it needs the human: sign up, approve, connect GitHub, connect Slack?

## 1. What other tools ship (fetched 2026-09-11)

| Tool | Entry point | Auth handoff | Human stops | Verification |
|---|---|---|---|---|
| Deepline | `code.deepline.com/INSTALL.md` (same body at `/SKILL.md`; 25 lines, SKILL.md frontmatter) | CLI `deepline setup --json`: unauthenticated `POST /auth/cli/register` returns a claim URL, CLI opens it (or prints it), polls `/auth/cli/status` until the human signs in, saves the revealed key locally | Sign-in link only; then a scripted "Deepline is ready. What would you like to do?" | `deepline --version` preflight, `doctor --json` on failure. No test event |
| Sentry | `docs.sentry.io/ai/`, `skills.sentry.dev`, `npx @sentry/agent-plugin install` | Hosted MCP with OAuth on first tool call; CLI `sentry auth login` is a device-code flow | Signup is human-only ("there is no agent flow for account creation"); `create_project` proposed and created on a yes | Strongest in the survey: boot the real app, throw through the real init path with a unique marker, poll `search_events` ~30s, show URL. "The task isn't done until the event is seen in Sentry." Then check frames are not minified |
| PostHog | `npx @posthog/wizard` (the wizard wraps the Claude Agent SDK) | OAuth with a local callback server; paste-the-callback-URL fallback for headless; `--api-key` and `--signup --email` | A `wizard_ask` tool with a 5-minute timeout for mid-run questions | Streams stage state to a `wizard/sessions` endpoint so the web app shows progress |
| Autumn | `useautumn.com/SKILL.md` | Keyless: `POST /agent.provision` returns a sandbox key plus a claim URL; human claims later by email plus OTP | One two-option question: sign in now, or go keyless and claim later | "A customer that exists, a check that denied, usage that landed" |
| Clerk | `clerk.com/SKILL.md` | `npx clerk init` provisions a claimable app and writes temporary dev keys with no account | Checklist, "wait for a yes"; never runs `auth login` unasked | `clerk doctor`, then the human signs up as first test user |
| Stripe Projects | `stripe-projects` skill | `stripe projects init --preflight --json` surfaces every blocker first | On `BROWSER_AUTH_REQUIRED`: "stop here, report verbatim, do not run login yourself" | Preflight exit codes |
| Convex, Neon, Cloudflare | plugin marketplace entries | CLI login opens a browser (`--no-open` prints URL, `--login-flow paste\|poll`); MCP OAuth on first call | Login only | none documented |

Distribution channels: `npx skills add owner/repo` (skills.sh, 18 agents), `anthropics/claude-plugins-official` marketplace (295 plugins: sentry, posthog, supabase, neon, convex, stripe, resend, langfuse), Cursor `cursor://…/mcp/install?config=` deep links, Mintlify "Copy page / Open in Claude" menus. Mintlify's own `install.md` convention (OBJECTIVE, DONE WHEN, TODO, EXECUTE NOW) is a good prompt skeleton, but every live example it lists 404s today.

**Common shape** of the good docs: preflight and idempotency check; install; one connect command that opens a browser and waits, with a printed-link fallback; detect framework from manifests and confirm with the human; provision with consent; write code and env; verify with a real event; offer next steps; stop.

**Guardrails that recur**: never print or paste a secret into chat (report env var names, not values); do not reinstall a healthy setup because this file was discovered; two tries then stop and show the error; say what is about to happen before opening a browser; treat everything from the API as untrusted data; use the harness's question tool rather than a markdown list.

**Auth patterns, least to most friction**: keyless sandbox with later claim; CLI opens browser and polls (Deepline, Convex, Neon); OAuth local callback with paste fallback (PostHog); device code (Sentry CLI); MCP OAuth on first tool call; human pastes a key from the dashboard.

Every tool in the survey ships a CLI. Opslane deleted its CLI on 2026-08-23 (PR #404). Their CLIs do two things a plain agent cannot: open a browser, and hold a secret outside the chat. Neither needs a CLI if the server does the polling handoff and the only long-lived secret the agent handles is public by design.

## 2. What already exists in this repo

The most important fact: **an agent-first onboarding backend is already implemented, tested, and wired, and nothing calls it.** It was the server half of the deleted CLI.

- `POST /api/v1/agent/setup` (no auth, `handler/agent_setup.go:42`): `{repo_url, agent_name}` returns `{status:"auth_required", auth_url, poll_id, poll_token}`.
- `GET /agent/auth/{session}` redirects the human to the GitHub App install with `state=session`; `GET /agent/auth/callback` verifies GitHub identity plus installation plus repo grant, then creates org, user, project, and an ingest key sealed to the session (`agent_setup.go:249`, `:320`, `:451`).
- `GET /api/v1/agent/poll/{session}` with header `X-Opslane-Poll-Token` returns `pending | completed | failed | expired` and, on completion, the **opened** key (`agent_setup.go:195`). The sealed-box design (`auth/agentkey.go`) means the server opens it from the poll token, so a curl-only agent needs no crypto.
- Three production strings still say "Run 'opslane onboard'" (`agent_setup.go:86`, `:193`, `:309`). The command no longer exists.
- A PKCE `GET/POST /oauth/authorize` plus `POST /oauth/token` flow with a localhost-only redirect also exists with no client (`auth_handlers.go:554`, `:761`).

What the v2 wizard (shipped, `docs/design/2026-08-26-onboarding-v2.md`) decided, all of which the agent path should inherit:

- One hard gate: first event received. GitHub and Slack are deferable with persistent banners.
- Server facts drive the step: `GET /api/v1/onboarding/state` returns `next_step` from `create_project | install_sdk | connect_github | connect_slack | done`.
- Ingest key `opslane_pk_` is public by design and goes inline in the snippet; the snippet always carries `endpoint`.
- Test by throwing through the real init path, then poll `GET /projects/{id}/event-count` until `has_events`.
- Slack: create disabled, test, enable on `ok:true`.

Mismatch with the existing agent backend: it uses the GitHub App install as the identity proof and requires `repo_url` up front. That makes GitHub the first hard gate, the opposite of the v2 decision, and has no path for email or WorkOS sign-up. The auth URL should land on the dashboard's normal sign-in, not on GitHub.

Confirmed dead end (live test 2026-09-11 on `opslane/marketing`): when the app is already installed on the GitHub org, `installations/new` shows the existing installation with Save disabled and never redirects back. The callback (`agent_setup.go:352`) needs a fresh install's `installation_id` plus OAuth `code`, so the session polls until expiry. The live backend therefore handles only a GitHub org that has never installed the app. The redesigned GitHub step must branch on the org's existing installation: not installed → install link or defer; installed but repo unattached → agent infers the repo from the git remote, confirms, and attaches through a session-scoped repo update; installed and attached → skip.

Other surfaces: MCP at `/mcp` takes an `opslane_ak_` bearer key and exposes six tools but cannot create a project or mint a key, so it cannot bootstrap itself. `examples/agent-skills/opslane/SKILL.md` is the post-install "work the digest" skill. `llms.txt` is a docs index, not a runbook. There is no user-facing INSTALL.md.

Why this is not the deleted setup-PR agent: that agent ran in our sandbox, cloned the repo, and rooted everything at the repo root with no workspace awareness. Here the user's own agent runs inside the user's checkout with the user's build tools and can ask the user which app to instrument. The monorepo failure that killed the setup-PR agent does not transfer.

Second live test 2026-09-11 (`importcsv/marketing`, Next.js, fresh GitHub org): the whole loop worked with one human stop, but two gaps showed. (1) The poll returned `key_ok` and the agent guessed "GitHub install may still be pending"; the statuses (pending → provisioned → key_ok → app_reporting, `queries.go:4410-4432`) are undocumented in the response, so the runbook needs a glossary or the poll needs `completed: true` plus a hint. (2) The poll carries no event fact, so the agent told the human to check the dashboard. `app_reporting` flips on the SDK's first session init (`session.go:158`), which proves wiring but not an error. Smallest fix: add `has_events` and `latest_error_group_url` to the poll response from the query at `read_api.go:1241`.

Outcome of that test: prod showed zero events and zero sessions for the project. Root cause from the browser console: the site's Content-Security-Policy `connect-src` did not include `app.opslane.com`, so the browser refused both the event POST and session init. Invisible from the server. `docs/install.md` does not mention CSP; the runbook needs a `connect-src` preflight and a "read the browser console when has_events stays false" rule.

Why Sentry never hits this: its Next.js wizard sets `tunnelRoute`, a same-origin rewrite, so `connect-src 'self'` covers it and ad blockers miss it. Our SDK rejects a non-absolute `endpoint` (`config.ts:92`), so no tunnel is possible today. Design addition: accept a same-origin path as `endpoint`, resolve it against the page origin, and have the Next.js and Vite recipes add a rewrite to `https://app.opslane.com/api`. Server side needs nothing: proxied requests carry the app's own origin and a new project has no allowlist. The agent had already declared success. The runbook must (a) probe the key from the terminal with `POST /api/v1/ingest/ping` and header `X-API-Key` (204 on success, exists at `routes.go:105`), (b) never write a provider that skips init silently, (c) restart the dev server after writing env, and (d) keep polling `has_events` and debugging until the event is seen.

## 3. Proposed design (tracer bullet)

**Deliverable**: `https://app.opslane.com/INSTALL.md` (also served at `/SKILL.md` and mirrored in docs). The docs quickstart, README, and the empty-state dashboard all show one line:

```text
Set up https://app.opslane.com/INSTALL.md
```

**Human stops, in order**: (1) open one link, sign in or sign up, click Approve. (2) optional: install the GitHub App. (3) optional: paste a Slack webhook URL. Nothing else asks the human for anything except confirming which app to instrument in a multi-app repo.

### 3.1 Flow

1. **Preflight.** Check for `@opslane/sdk` in any `package.json` and for `OPSLANE`-prefixed env var names (names only). If present, run the verification step and stop; do not reinstall.
2. **Register.** `POST /api/v1/agent/setup` with `{project_name, agent_name, framework_hint}`. Response: `{auth_url, poll_id, poll_token, expires_in}`. The agent tells the human in one line what is about to happen, then prints the link.
3. **Human approves.** `auth_url` opens the dashboard at `/agent/approve/{session}`. Unauthenticated users go through the normal sign-in or sign-up and return. The page says "Claude Code on `<agent_name>` wants to set up Opslane for `<project_name>`", with an org picker for users who belong to several. Approve creates the project through the existing idempotent setup path and mints an ingest key.
4. **Poll.** The agent polls `GET /api/v1/agent/poll/{session}` every 3 seconds up to the session TTL. On `completed` it receives `{project_id, ingest_key, dashboard_url, api_key}`. The ingest key is the public `opslane_pk_` key. The `api_key` is an `opslane_ak_` key so the agent can also install the MCP server and the digest skill in the same session. One approval grants both.
5. **Detect and install.** Framework from manifests (Vue, React, Next.js, plain), workspace layout from `pnpm-workspace.yaml`, `turbo.json`, `nx.json`. In a multi-app repo the agent asks which app with the harness question tool. It installs the SDK, writes the snippet from `docs/install.md`, puts the key in the framework's env file, and reports the env var name.
6. **Verify.** Start the app, throw `Error('opslane-test')` through the real init path (a temporary button, as the wizard does), poll `GET /api/v1/agent/poll/{session}/state` until `has_events` is true, remove the button, and show the issue link. The task is not done until the event is seen; the doc says so.
7. **GitHub.** The state response carries `github_connected` and `github_install_url`. If not connected the agent prints the install link and asks once: connect now, or later. Later means the dashboard banner takes over.
8. **Slack.** Ask once for a webhook URL or later. If given, the agent calls the session-scoped create-test-enable endpoint. A failed test is reported verbatim; two tries then stop.
9. **Finish.** `POST /api/v1/agent/poll/{session}/complete` sets `onboarded_at`. The agent offers the MCP install line from `docs/guides/mcp.md` and the digest skill, then stops.

### 3.2 Server changes (M1)

- `POST /api/v1/agent/setup`: `repo_url` becomes optional; add `project_name` and `framework_hint`. Drop the repo-based `already_configured` branch. Delete the three "opslane onboard" strings.
- `GET /agent/auth/{session}`: redirect to the dashboard approve route instead of the GitHub App install. The GitHub callback branch in `AgentAuthCallback` is no longer the completion path; the approve page is.
- New `POST /api/v1/agent/approve/{session}` (cookie auth, admin-if-cloud): creates project plus ingest key plus api key, seals both to the session, marks completed. Reuses `ProvisionProject` idempotency and the wizard's `onboardingSetup` rules (existing un-onboarded org with a project returns that project).
- New session-scoped endpoints authenticated by `X-Opslane-Poll-Token`, valid for the session TTL (2 hours):
  - `GET /api/v1/agent/poll/{session}/state`: the same fact evaluator as `/onboarding/state` plus `github_install_url` and `latest_error_group_url`.
  - `POST /api/v1/agent/poll/{session}/slack`: webhook URL in, runs create-disabled, test, enable; returns `{ok, error}`.
  - `POST /api/v1/agent/poll/{session}/complete`: the same rule as `/onboarding/complete`.
  The poll token stays the only secret the agent holds. This avoids widening `opslane_ak_` beyond `/mcp`.
- Serve `INSTALL.md` and `SKILL.md` from the ingestion service with `text/markdown` so `curl -sL` returns the raw body (Sentry's note: summarizing fetch tools drop configuration details, so the doc tells the agent to curl it).

### 3.3 Dashboard changes (M2)

- `/agent/approve/:id` route behind the normal auth guard: agent name, project name, org picker, Approve and Deny. Deny marks the session failed with `authorization_denied`.
- Empty state and the wizard's first screen show the paste line next to the manual path.
- Optional later: the agent posts its stage to the session and the approve page turns into a live progress view (Sentry and PostHog both do this).

### 3.4 Source maps

The v2 wizard deferred source maps because the step cost a human effort; with an agent doing the work that argument is gone, and the second live test ended with the agent silent on the topic. Facts: only Vite has a plugin (`docs/guides/source-maps.md:52`); on cloud no user can mint a `sourcemaps`-scope key, since the key endpoint accepts only `api` and `ingest` (`api_keys.go:78`) and the guide's `mint-key` runs inside the server container. Plan: (1) Vite now: approve payload returns a sourcemaps key, the agent adds the plugin, and one human stop says "add `OPSLANE_SOURCEMAP_KEY` to CI, value in Settings" so the secret never transits chat; needs the key endpoint to accept the scope and a Settings view. (2) Next.js later: a `withOpslane` next.config wrapper doing debug-ID injection and post-build upload. Until then the runbook must say "not supported for Next.js yet" rather than nothing.

### 3.5 Not in v1

- No CLI. Curl plus JSON is enough for Claude Code, Codex, Cursor, and Copilot. If a harness with no shell shows up, a thin `npx @opslane/setup` can wrap the same endpoints later.
- No keyless sandbox (Autumn and Clerk). Our sign-up is already one link; keyless would add a claim flow for little gain.
- No Next.js source-map integration and no `release` configuration.
- No plugin marketplace or skills.sh submission until the flow has run on three real repos.

### 3.6 INSTALL.md draft

```markdown
---
name: opslane-setup
description: Install the Opslane browser SDK, verify the first event, and connect GitHub and Slack.
---

# Install Opslane

Opslane captures production browser errors and friction, investigates them, and opens verified fix PRs. Read this file with `curl -sL`; summarizing fetch tools drop details.

Do everything below yourself. Stop only where this file says STOP. Never print a key into chat; refer to env vars by name. Two tries to fix any failing step, then show the error and stop.

## 1. Preflight

Search every package.json for `@opslane/sdk`. If it is installed, skip to step 5.

## 2. Register this setup

Tell the user: "I'm going to register this setup with Opslane and give you a link to approve it." Then:

    curl -s -X POST https://app.opslane.com/api/v1/agent/setup \
      -H 'content-type: application/json' \
      -d '{"project_name":"<repo name>","agent_name":"<harness> on <hostname>","framework_hint":"<vue|react|nextjs|other>"}'

Save `poll_id` and `poll_token` for this session.

## 3. STOP: ask the user to approve

Show `auth_url` and say: "Open this link, sign in or create an account, and click Approve. I'll wait." Then poll every 3 seconds:

    curl -s https://app.opslane.com/api/v1/agent/poll/<poll_id> -H 'X-Opslane-Poll-Token: <poll_token>'

`pending`: keep waiting. `failed` or `expired`: show `message` verbatim and stop. `completed`: continue with `ingest_key`, `api_key`, `project_id`, `dashboard_url`.

## 4. Install the SDK

Detect the framework from the manifest. In a workspace with several apps, ask the user which app to instrument. Install `@opslane/sdk`, add the init snippet for that framework (React, Vue, Next.js, or plain), and put the ingest key in the framework's public env var (`VITE_OPSLANE_API_KEY` or `NEXT_PUBLIC_OPSLANE_API_KEY`). Always pass `endpoint: "https://app.opslane.com"` and `environment: "development"`.

## 5. Verify with a real event

Add a temporary button that throws `new Error('opslane-test')`, start the dev server, click it (or ask the user to), and poll:

    curl -s https://app.opslane.com/api/v1/agent/poll/<poll_id>/state -H 'X-Opslane-Poll-Token: <poll_token>'

Wait until `has_events` is true, then remove the button and show `latest_error_group_url`. Do not stop at "check your dashboard"; if no event arrives in 2 minutes, debug the init path.

## 6. STOP: GitHub (optional)

If `github_connected` is false, show `github_install_url` and ask: connect now, or later? On now, wait until `github_connected` flips. On later, continue.

## 7. STOP: Slack (optional)

Ask for a Slack incoming-webhook URL, or later. On a URL:

    curl -s -X POST https://app.opslane.com/api/v1/agent/poll/<poll_id>/slack \
      -H 'X-Opslane-Poll-Token: <poll_token>' -d '{"webhook_url":"..."}'

Report `error` verbatim on failure.

## 8. Finish

    curl -s -X POST https://app.opslane.com/api/v1/agent/poll/<poll_id>/complete -H 'X-Opslane-Poll-Token: <poll_token>'

Then offer to add the Opslane MCP server and digest skill (see /docs/guides/mcp.md) using `api_key`, and say: "Opslane is set up. Your first real error will show up in the daily digest."
```

## 4. Open questions for the decision

1. Should approval by an existing org member create a new project or attach to an existing one? Proposal: the approve page offers both when the org already has projects.
2. Should the session also return an `opslane_ak_` key for MCP? Proposal: yes, labelled `agent-setup`, visible and revocable in Settings.
3. Do we keep the GitHub-App-as-identity path at all? Proposal: delete it with the CLI strings; the approve page replaces it.

## 5. Decisions (grill 2026-09-11)

| # | Decision | Chosen |
|---|---|---|
| 1 | Identity and project creation | Dashboard approve page `/agent/approve/{id}` behind normal sign-in; GitHub becomes an optional later stop |
| 2 | Existing org on Approve | Picker: existing project whose repo matches the agent's git remote is preselected, else "Create <name>" |
| 3 | MCP key | Approve also mints an `opslane_ak_` labelled `agent-setup`; agent writes it into the harness MCP config, never echoes it |
| 4 | Agent credential after approval | Poll token; session-scoped routes `state`, `slack`, `github`, `progress`, `complete` under `/api/v1/agent/poll/{id}/`; TTL 2h |
| 5 | Waiting | Long-poll `?wait=30` on poll and state; server checks once a second |
| 6 | Test click | Agent uses a browser tool when it has one, otherwise asks the human to click |
| 7 | CSP and ad blockers | SDK accepts a same-origin `endpoint` path; Next.js recipe tunnels through a rewrite by default; other recipes preflight `connect-src` |
| 8 | Source maps | In v1 for both Vite and Next.js, one release; Next.js via a bundler-agnostic post-build command in `@opslane/sdk` that stamps debug IDs, uploads, strips maps |
| 9 | Source-map secret into CI | Agent asks where they deploy, shows the redacted command, runs `gh secret set` or `vercel env add` on a yes; otherwise the human copies it from Settings |
| 10 | Old GitHub-callback agent path | Delete, with the `opslane onboard` strings |
| 11 | Runbook location | `docs-site/public/INSTALL.md` (Starlight serves raw, as `llms.txt` proves); landing page, dashboard empty state, and wizard show the paste box |
| 12 | Progress panel | Yes: fixed step list shown up front; server facts drive approve, first event, GitHub, Slack, maps; agent reports drive install, MCP, and failure reasons |
| 13 | Start | Half-day throwaway spike: approve page, long-poll, `has_events`, runbook, real agent on the fixture app against a compose stack |

Locked without a question: GitHub step attaches the repo from the git remote after confirmation when the App is already installed; Slack stays webhook create-disabled → test → enable; snippet defaults to `environment: development` and the runbook names the production variable.

## 6. Spike outcome (2026-09-11, throwaway, uncommitted on `abhishekray07/onboarding-agent`)

Rig: compose stack `spikeagent` on 8202/5602/9202 (no worker), fresh projectless org seeded, human played by Playwright with a minted session cookie because the local `github` auth provider has no password sign-up. Agent: headless `claude -p "Set up http://localhost:8202/INSTALL.md"` with the Playwright MCP, in a scaffolded Vite+Vue app with no SDK.

Changes made (about 350 lines): migration 074 `agent_sessions.project_name`; `ApproveAgentSession` (project + env + ingest key + `agent-setup` api key, sealed as a JSON bundle); `POST /api/v1/agent/setup` takes `project_name` and no repo; `/agent/auth/{id}` redirects to the SPA `/agent/approve/{id}`; `GET/POST /api/v1/agent/approve/{id}` behind the cookie; poll gained `?wait=30` long-poll, `until=event`, `approved`, `has_events`, `latest_error_group_url`, `next`, `status_help`, and returns `ingest_key` + `api_key`; dashboard `AgentApprove.vue` on a parked-path route; runbook at `packages/dashboard/public/INSTALL.md` written origin-relative.

Result: **one human stop, zero guesses.** 16 turns, 123 seconds, $1.04. The agent curled the runbook raw, redacted `poll_token` in its own transcript output, wrote the key to a gitignored `.env.local` and never printed it (0 key matches in the full transcript), installed the SDK from npm, added init and the Vue plugin, started the dev server, opened it in its headless browser, clicked the test button itself, long-polled `until=event`, saw `has_events: true`, removed the button, and reported. Server facts: session `app_reporting`, 1 error event, 1 browser session, keys `ingest:agent setup` and `api:agent-setup`. Deep link unauthenticated → `/login` with the path parked → back to the approve page after sign-in, project name prefilled from the repo.

Gaps the spike surfaced:
- `latest_error_group_url` was absent because grouping runs in the worker, which the rig did not start. The runbook's "show the issue link" step needs the worker, or the poll must fall back to the project's issues page.
- Headless `-p` mode cannot ask questions, so the MCP offer (step 6) was skipped silently. Interactive runs will ask; the runbook should say "if you cannot ask, skip and mention it".
- Local `github` auth provider exposes no sign-up, so the new-user path was simulated, not exercised. Prod is WorkOS and hosts sign-up, so this is a rig limit, not a product one.
- INSTALL.md written with a 0600 umask made the container's non-root user 403; the Dockerfile copy should normalise modes, or the file should live in `docs-site/public` per decision 11.
- Existing Go agent tests fail: the handler ones assume the GitHub-callback flow, and the db ones run against the shared test database on 5434, which lacks migration 074. Both get rewritten with the approve flow in the real implementation.

### Decisions added after Codex review (grill 2, 2026-09-11)

| # | Decision | Chosen |
|---|---|---|
| 14 | MCP key handoff | Key written to `~/.opslane/env`; harness config references `${OPSLANE_API_KEY}`; user adds one `source` line. No secret in argv or transcript |
| 15 | GitHub stop link | Agent sends the human to Opslane Settings to click Install GitHub App (sets the org-binding state cookie); no bare GitHub URL, no new deep-link route |
| 16 | Legacy `POST /api/v1/onboard/provision` | Deleted in this release with its DB provisioning, tests, and the raw-key poll fallback |
| 17 | Indexed source maps (Turbopack) | Add `@jridgewell/trace-mapping` (MIT) to flatten before stamping |
| 18 | Mechanics accepted as a block | failed Slack test deletes the disabled row and "Slack connected" = any enabled Slack destination; state long-poll defaults to `until=change`, unknown `until` is 400; server-derived steps accept `failed`/`skipped` diagnostics only; every SDK request sends `credentials: 'omit'`; no `OPSLANE_SOURCEMAP_KEY` means skip with exit 0 and no Next.js maps; poll limiter 60/min/IP |


## 7. Release smoke

Executed on 2026-09-12 in isolated Compose project `agentsmoke20260912`, using ports 8242 (API), 5642 (Postgres), and 9242 (MinIO). The original spike stack and its data remained intact. Ingestion and worker images were rebuilt, migrations applied, and `scripts/seed-e2e.sql` loaded. Both services were healthy.

Each agent started in a bare app with the raw runbook and installed the SDK tarball packed from this branch. Package-lock and ESM resolution confirmed the local package; the published npm SDK was not substituted. Playwright supplied the browser, and a minted local session cookie represented a projectless human. Real sign-up and OAuth were outside this rig.

| Fixture | Turns | Seconds | Cost (USD) | Required human stops |
| --- | ---: | ---: | ---: | ---: |
| Vue + Vite | 17 | 133.333 | 1.2043 | 1: approve |
| Next.js 16.3.5 | 23 | 207.848 | 1.7594 | 1: approve |

Both agents installed the SDK, clicked the temporary error button, observed the first event, provided an issue URL, and removed the button and `.opslane-setup`. Each approval page showed seven rows before approval; approve, SDK installation, and first event became done. GitHub, Slack, source maps, and MCP were explicitly deferred with notes in noninteractive mode. Both transcripts contained zero matches for poll-token or Opslane-key patterns.

The Next.js app hydrated before setup under `connect-src 'self'`. After setup, production events used `/opslane/api/v1/events` on the app's own origin and returned HTTP 202 with the CSP unchanged. Both production fixtures omitted an application HttpOnly cookie from event requests. Development used webpack with polling because the shared host had exhausted inotify instances; production used Turbopack.

Source-map keys were created through each project's Settings UI. Production builds uploaded maps; browser errors resolved through completed `stack_resolve` jobs to `src/App.vue:5` and `turbopack:///[project]/app/opslane-provider.tsx:11`. Resolution evidence is stored in `error_event_resolutions.envelope.frames`, rather than the illustrative `resolved_file` columns in the plan.

Live verification found and fixed project selection in direct Settings links. It also found two source-bearing Next.js map files without matching JavaScript siblings, requiring cleanup after a wholly successful CLI run. The final packed SDK uploaded two Vue maps and eight Next.js maps, removed all generated maps (including two extra Next.js artifacts), and retained correct source resolution in both production fixtures. Both issue pages displayed the original source file and line, with the raw stack retained below it.

Verification results:

- Frozen dependency install and full workspace build after moving all ignored `dist` outputs aside.
- Dashboard: 415 tests passed. SDK: 397 tests passed with zero skips, including Chromium, Firefox, and WebKit and residual-map cleanup/retry cases.
- Worker: 1,625 tests passed against a separate disposable database, including six explicitly enabled reliability tests. Five external Anthropic API contract tests were skipped because no API key was configured. The first attempt shared the smoke worker's global queue and set `DASHBOARD_URL`; correcting that setup cleared three failures without changing worker code or tests.
- Other workspace suites: docs 21, agent-core 35, reliability 5, and fixture 2 tests passed.
- Documentation build, route drift, and repository checks passed. The port checker must run without a pinned `REPLAY_STORE_PUBLIC_ENDPOINT` because it intentionally changes the MinIO port.
- Go handler suite: 607 tests passed with zero test skips; subsequent approval-expiry and source-frame display regressions also passed. The database suite passed 435 tests with zero skips in 689 seconds, including clean migration application, idempotency, and roll-forward. It required a 30-minute package timeout after exceeding Go's default ten-minute timeout. All other Go packages, build, and vet passed.

Scratch fixtures, private setup material, and raw proof logs are under `/tmp/onboarding-agent-proof/`; they are not repository artifacts.

### Release checklist

- [x] Complete the source-map and issue-page checks and remove the isolated smoke stack.
- [ ] Publish the SDK, server, dashboard, and docs together.
- [ ] Confirm hosted INSTALL.md and SKILL.md serve identical raw content.
- [ ] In the separate opslane.com repository, add a “Paste into your agent” box containing `Set up https://docs.opslane.com/INSTALL.md`, a copy button, agent logos, and a manual fallback linking to `https://docs.opslane.com/install/`. Merge it the same day. The release is not complete until that box is live.
