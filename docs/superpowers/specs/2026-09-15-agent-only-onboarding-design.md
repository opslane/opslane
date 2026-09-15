# Agent-only onboarding

Date: 2026-09-15. Branch: `abhishekray07/change-onboarding`. Status: revision 2, after Codex review round 1.

## Problem

A new sign-up lands on `/setup`, a four-step web wizard (`packages/dashboard/src/views/SetupWizard.vue`, 609 lines): create project, copy a snippet and wait for an event, connect GitHub, connect Slack. Since #476 its first screen also offers `Set up https://docs.opslane.com/INSTALL.md` for a coding agent. The agent path does everything the wizard does, plus user identification, source maps, MCP and a PR. The wizard is a second onboarding story to maintain, and it competes with the path we want people on.

When a user takes the agent path today, the wizard tab is left behind on its first step. The agent prints an approve link, and the user approves on `/agent/approve/:id`. That route and project-qualified links are exempt from the onboarding guard (`route-project.ts:1`, `router.ts:73`), but the approve page's **Open dashboard** and **Open the test error** refuse to navigate until `getMe()` reports `onboarding_complete` (`AgentApprove.vue:158-164`). Only two things set that: the wizard's last step, and the agent's `POST /agent/poll/{id}/complete` at runbook step 11, which comes after GitHub, Slack, source maps, MCP and the PR. Any plain `/` visit before then is redirected to `/setup` (`router.ts:68-77`).

## Decisions (2026-09-15, with Abhishek)

1. **Keep the approve link.** The prompt stays `Set up https://docs.opslane.com/INSTALL.md`. The agent registers, prints the approve link, and the signed-in user clicks it. No pre-authorized code in the prompt and no runbook change.
2. **Agent only.** `/setup` has no manual path: no project form, no snippet, no key. Someone without a coding agent cannot onboard from the app.
3. **Hosted only.** The prompt keeps pointing at the hosted runbook, which targets `https://app.opslane.com`. A self-hosted `/setup` shows the same prompt, which is wrong for that instance. That is a follow-up issue.
4. **The dashboard marks onboarding complete on the first event.** Neither `/setup` nor the approve page waits for runbook step 11. Both call the existing `POST /api/v1/onboarding/complete` once they observe an event.
5. **The onboarding event gate becomes org-wide.** `GET /onboarding/state` and `POST /onboarding/complete` currently check events on the org's newest project only (`onboarding_state.go:29`, `:67`, `:132-139`). An agent can attach an older project, or two approvals can create two projects, and then the approve page sees an event (`facts.has_events`, session-scoped) while completion returns 422 forever. Both endpoints switch to "any project in this org has an error event", through a new `db.OrgHasEvents(orgID)` (`EXISTS` over `error_events` joined to `projects`, using `idx_error_events_project`). `project_id` in the state response stays the newest project.

The agent's own completion is not changed. It still requires an unexpired, approved session and an event since that session was created (`agent_session_routes.go:40`, `:346`). After the dashboard has completed onboarding, that call returns 200 when its own conditions hold, because `MarkOrgOnboarded` only writes a null `onboarded_at`.

## Flow

### `/setup`

1. Sign-up and sign-in are unchanged. `completePostAuth` (`post-auth.ts`) still honours a parked destination (such as an approve link) first, and otherwise sends a not-onboarded user to `/setup`.
2. On mount, call `getMe()`.
   - It fails with anything other than an expired session: show "Could not load your account." with **Try again**. Read nothing else until it succeeds. (An expired session is handled by the API client, which redirects to `/login`, `api.ts:127-134`.)
3. Read `GET /onboarding/state` once, then every 3 seconds, one request in flight at a time.
   - `onboarding_complete` and `project_id` set: cache `opslane_onboarding_complete=1`, write `opslane_project_id`/`opslane_project_name` from `listProjects()` (same restore the wizard does), `router.push('/')`.
   - `onboarding_complete` and `project_id` null: stay on the page and keep polling. Redirecting would loop, because `App.vue:45` sends a project-less org back to `/setup`.
   - Otherwise, a cloud `member`: show the existing "Ask an organization admin to finish setup" screen and keep polling, so the member gets in once an admin's setup completes. Members never call complete.
   - Otherwise (admin or owner, or any role when not cloud): show the setup page.
4. The setup page is one screen: a heading, `AgentPasteBox`, and one status line. The wording is neutral about who created the project or sent the event, because an older project or another person can satisfy both facts:

   | Server state | Status line |
   | --- | --- |
   | `project_id` null | Waiting for your agent. It will give you a link to approve. |
   | `project_id` set, `has_events` false | Project ready. Waiting for the first event from your app. |
   | `has_events` true | First event received. Opening your dashboard… |
   | state request failed | Could not check setup status. Retrying. (keeps polling) |

5. On the first state that has `has_events: true` and not `onboarding_complete`, stop polling and call `completeOnboarding()`.
   - 200: cache the flag, restore project storage, `router.push('/')`.
   - Any other failure: show the error with **Try again**, which re-runs the complete call. Stay on `/setup`.
6. Lifecycle: every awaited call (`getMe`, state, `listProjects`, complete) checks a generation counter after it resolves and does nothing if the page unmounted or a newer action started. `App.vue:196` keys the route component on the active project, so the page can remount mid-request. The approve page already uses this pattern (`AgentApprove.vue:72`, `:126-139`).

### Approve page

7. `AgentApprove.vue` keeps its checklist. In `openDestination`, when `getMe()` reports not complete:
   - latest `info.facts.has_events` true: call `completeOnboarding()`, then continue to the destination on success. On failure show its message in the existing navigation message slot with **Check again**.
   - otherwise: keep today's "Your agent is still finishing setup" message.
   The complete call runs under the page's existing `mounted` check.

## Changes

### Dashboard

- Replace `views/SetupWizard.vue` with `views/Setup.vue`. Route name stays `setup`, path stays `/setup`.
- `components/AgentPasteBox.vue`: drop the `variant` prop and both footer lines (the `wizard` slot and the empty-state "Setup guide" link to `/setup`). `IssuesList.vue` and `SessionsList.vue` keep using the box.
- `views/AgentApprove.vue`: Flow step 7.
- `api.ts`: delete `onboardingSetup`, `OnboardingSetupResponse`, `getEventStatus`, `EventStatus`.
- `types/api.ts`: delete `OnboardingState.next_step`.
- Components and API functions the wizard used that other views still use stay (`RepoSelector`, `CodeBlock`, notification and GitHub API functions are used by Settings).
- Old `localStorage` keys `opslane_onboarding_key_<projectId>` are left alone. They hold a public ingest key and nothing reads them after this change.

### Ingestion

- Delete `POST /api/v1/onboarding/setup` (`handler/routes.go:146`), the `OnboardingSetup` handler, `db.OnboardingProvision` and `db.ErrOrgOnboarded`.
- Delete `handler/onboarding.go` after moving its two survivors into `handler/read_api.go`, where their remaining callers are: the rate limiter (used by `CreateProjectEndpoint`, `read_api.go:1054`; rename it `projectCreateLimiter`) and `environmentJSON` (`read_api.go:1105`, `:1297`).
- Keep `provisionProjectTx`, `EnsureProjectDefaultEnvironmentTx`, `CreateProjectKeyTx`, `RevokeExcessOnboardingKeysTx` and `HasEvents`: each has other callers (`POST /projects`, agent provisioning, key minting, `GET /projects/{id}/event-count`).
- Add `db.OrgHasEvents(ctx, orgID)`. `evaluateOnboarding` and `OnboardingComplete` use it instead of `HasEvents(newestProject)`.
- Remove `next_step` from `onboardingStateJSON` and `evaluateOnboarding`. Keep every other field: `OnboardingBanners.vue` reads `github_connected` and `slack_connected`, and `/setup` reads `project_id`, `has_events`, `onboarding_complete`.
- `MarkOrgOnboarded`: drop the transaction and advisory lock. Their only purpose was serializing against `OnboardingProvision` (comment at `queries.go:4237-4240`); a single conditional `UPDATE` remains.
- No migration. `projects.idempotency_token` and `orgs.onboarded_at` stay in use.

### Tests

- `views/__tests__/setup-wizard.test.ts` becomes `views/__tests__/setup.test.ts`: complete-with-project redirect, complete-without-project stays, member screen polls and never completes, each status line, auto-complete then navigate, complete failure shows **Try again** and stays, `getMe` failure blocks state reads, and a deferred state or complete response that resolves after unmount writes nothing and does not navigate.
- `views/__tests__/agent-approve.test.ts`: add has-events completion, completion failure, and keep the no-events refusal.
- `components/__tests__/agent-paste-box.test.ts`: remove variant assertions.
- `components/__tests__/onboarding-banners.test.ts:13`: drop `next_step` from the fixture.
- `handler/onboarding_test.go`: delete `TestOnboardingSetupIdempotency`. Migrate `TestOnboardingState_GitHubConnectedRequiresRepoCoverage` (`:136`) to `POST /api/v1/projects` with `{"name":"web","github_repo":"acme/web"}`. Keep the helpers `seedTenantNoProject`, `onboardingHTTP`, `mustDecodeOnboarding`.
- `handler/onboarding_state_test.go`: seed through `POST /api/v1/projects`; assert `project_id`/`has_events`/`onboarding_complete` instead of `next_step`; assert `POST /api/v1/onboarding/setup` returns 404; add a case where the event lands on an older project and complete still returns 200.
- New handler test: the dashboard completes onboarding, then `POST /agent/poll/{id}/complete` for an approved, unexpired session with an event since creation returns 200.
- `handler/project_provisioning_test.go:108`: drop `/onboarding/setup` from the cloud-member 403 table.
- `db` test for `OrgHasEvents`: false with no events, true for an event on any project of the org, false for another org's event.
- `test-e2e/dashboard-mock-harness.ts`: the mocked state stays waiting (`project_id: null`, `has_events: false`, no `next_step`), so the smoke stays on `/setup`. Update the comment at line 111.
- `test-e2e/dashboard-design-system.test.ts:82` and `dashboard-screenshots.test.ts:60`: new identity regex for the setup heading; rename fixture `setup-github-mock` to `setup-waiting-mock`.

### Docs

- `docs/install.md:28`: remove the wizard sentence. The manual steps stay for people who already have a key.
- `docs/guides/api-keys.md:26`, `docs/guides/github-app.md:34` and `:77`, `docs/guides/slack-notifications.md:30`: replace wizard references with the agent setup or Settings. Drop `packages/dashboard/src/views/SetupWizard.vue` from covered-paths frontmatter wherever it appears (at least `slack-notifications.md:7`).
- `docs/reference/http-routes.md:87-89`: remove the `/onboarding/setup` row; the state row no longer mentions a next step; the complete row says "after any project in the org receives an event".

## Out of scope (file as issues)

- **Self-hosted `/setup`.** The prompt points at the hosted runbook. A fix is an instance-served `/INSTALL.md` with the origin substituted.
- **No ingest key without an agent.** Settings' key form offers only MCP and source-map scopes, and Settings is behind the onboarding guard.

## Acceptance criteria

Timings assume a local stack, a foreground tab and normal response latency.

1. A new cloud admin who signs up lands on `/setup` and sees the heading, the prompt line, a copy button and the waiting status. There is no project-name input, framework tab, GitHub control, Slack control or "Do this later" button.
2. The copy button writes exactly `Set up https://docs.opslane.com/INSTALL.md` to the clipboard.
3. With `/setup` open and no reload, the status line changes to "Project ready" within two poll intervals of the agent session being approved.
4. Within two poll intervals of the first event reaching any project in the org, `/setup` calls `POST /onboarding/complete`, `localStorage.opslane_onboarding_complete` becomes `1`, and the browser is on `/` with a project selected.
5. If `POST /onboarding/complete` fails with a non-401 error, `/setup` shows the error and **Try again**, stays on `/setup`, and a retry that succeeds navigates to `/`.
6. An onboarded org with a project that opens `/setup` is sent to `/` without calling complete. An onboarded org with no projects stays on `/setup` without a redirect loop.
7. A cloud member of a not-onboarded org sees the ask-an-admin screen, never calls complete, and reaches `/` without reloading after an admin's setup completes.
8. On the approve page after approval, **Open dashboard** navigates once the session's first event has arrived (calling complete itself), and still shows the "still finishing" message before it.
9. When the event lands on a project other than the newest, both `/setup` and the approve page complete onboarding (no 422).
10. `POST /api/v1/onboarding/setup` returns 404. `GET /api/v1/onboarding/state` has no `next_step`. `OnboardingBanners` still shows the GitHub and Slack reminders.
11. After the dashboard completes onboarding, the agent's `POST /agent/poll/{id}/complete` returns 200 for an approved, unexpired session with an event since its creation.
12. A state or complete response that arrives after `/setup` unmounts changes no storage and causes no navigation.
13. Gates: `pnpm --filter @opslane/dashboard build` and `test`; `go build ./...`; `go test ./handler ./db` with `DATABASE_URL` and the MinIO/replay-store variables from the root `AGENTS.md` exported, and zero skips reported for those packages; the dashboard e2e smoke; the screenshot suite with `CAPTURE_DASHBOARD_SCREENSHOTS=1` and Chromium available.
14. Live: on a local stack, a signed-in fresh org opens `/setup`, a headless agent runs a local copy of the runbook pointed at that stack, the user approves in the browser, and the `/setup` tab reaches `/` on its own after the test error arrives.
15. No doc outside `docs/plans/`, `docs/design/`, `docs/research/` and `docs/superpowers/` still describes the onboarding wizard or `/onboarding/setup`.

## Review log

**Codex round 1 (medium reasoning), 9 P1 and 2 P2, all accepted:**
- Deleting `onboarding.go` would break the build: the limiter and `environmentJSON` have callers in `read_api.go`. Now moved.
- `TestOnboardingState_GitHubConnectedRequiresRepoCoverage` also posts to `/onboarding/setup`. Now migrated.
- The problem statement misdescribed the guard: approve routes and project-qualified links are exempt; the refusal is in `AgentApprove.vue`. Rewritten.
- `/setup` and the approve page read different event facts, and completion checked only the newest project. Status wording is now neutral, and the gate is org-wide (Decision 5).
- The agent's completion is not unconditional. Decision text and AC11 now state its conditions.
- Timer cleanup alone lets stale responses complete or navigate. Generation checks added (Flow step 6, AC12).
- A completed org with no projects would loop between `/setup` and `/`. Redirect now requires a project (AC6).
- Errors: expired session belongs to the API client; `getMe` failure now blocks state reads.
- Verification prerequisites and timing bounds added (AC13, timings note).
- `docs/reference/http-routes.md`, the banner test fixture, and the now-purposeless advisory lock in `MarkOrgOnboarded` added.
