# Agent-only onboarding

Date: 2026-09-15. Branch: `abhishekray07/change-onboarding`. Status: revision 1, before Codex review.

## Problem

A new sign-up lands on `/setup`, a four-step web wizard (`packages/dashboard/src/views/SetupWizard.vue`, 609 lines): create project, copy a snippet and wait for an event, connect GitHub, connect Slack. Since #476, the first screen of that wizard also offers `Set up https://docs.opslane.com/INSTALL.md` for a coding agent. The agent path does everything the wizard does, plus user identification, source maps, MCP, and a PR. The wizard is now a second onboarding story to maintain, and it competes for attention with the path we want people on.

When a user takes the agent path today, the wizard tab is left behind. The agent prints an approve link, the user approves on `/agent/approve/:id`, and the router keeps bouncing them to `/setup` until the agent's final `complete` call (runbook step 11), which comes after GitHub, Slack, source maps, MCP and the PR.

## Decisions (2026-09-15, with Abhishek)

1. **Keep the approve link.** The prompt stays `Set up https://docs.opslane.com/INSTALL.md`. The agent registers, prints the approve link, and the signed-in user clicks it. No pre-authorized code in the prompt, no runbook change.
2. **Agent only.** `/setup` has no manual path: no project form, no snippet, no key. Someone without a coding agent cannot onboard from the app.
3. **Hosted only.** The prompt keeps pointing at the hosted runbook, which targets `https://app.opslane.com`. A self-hosted `/setup` shows that same prompt, which is wrong for that instance. That gap is a follow-up issue, not part of this change.
4. **The dashboard marks onboarding complete on the first event.** Neither `/setup` nor the approve page waits for the agent's step 11. Both call the existing `POST /api/v1/onboarding/complete` as soon as they observe `has_events`. The first event is already the only hard gate (`OnboardingComplete`, `handler/onboarding_state.go:119`). The agent's later `complete` call stays a no-op (`MarkOrgOnboarded` only sets `onboarded_at` when it is null).

## Flow

1. Sign-up and sign-in are unchanged. `completePostAuth` (`post-auth.ts`) still sends a not-onboarded user to `/setup`, and the router guard (`router.ts:68-77`) still redirects not-onboarded sessions there.
2. `/setup` mounts:
   - `getMe()` reports `onboarding_complete`: cache the flag, restore project storage, go to `/`. (Unchanged from the wizard.)
   - Cloud `member` role: show the existing "Ask an organization admin to finish setup" screen and do nothing else. (Unchanged.)
   - Otherwise render the setup page and start polling.
3. The setup page is one screen: a heading, `AgentPasteBox` (prompt line plus copy button), and one status line driven by `GET /api/v1/onboarding/state`, read every 3 seconds with one request in flight at a time:

   | Server state | Status line |
   | --- | --- |
   | `project_id` null | Waiting for your agent. It will give you a link to approve. |
   | `project_id` set, `has_events` false | Approved. Your agent is installing the SDK and sending a test error. |
   | `has_events` true | Test error received. Opening your dashboard… |
   | `onboarding_complete` true | (navigate to `/` immediately) |
   | request failed | Could not check setup status. Retrying. (keeps polling) |

4. On the first poll that returns `has_events: true`, stop polling and call `completeOnboarding()`.
   - 200: set `opslane_onboarding_complete`, restore project storage (same helper the wizard uses), `router.push('/')`.
   - Any error: show the message with a **Try again** button that re-runs the complete call. Do not navigate.
5. The approve page (`AgentApprove.vue`) keeps its checklist. Its **Open dashboard** and **Open the test error** actions currently refuse to navigate until `getMe()` reports `onboarding_complete` (`AgentApprove.vue:158-164`). New behaviour: when `getMe()` says not complete and the page's latest `facts.has_events` is true, call `completeOnboarding()` and navigate on success. When `has_events` is false, keep today's "Your agent is still finishing setup" message. This covers a user who closed the `/setup` tab.

Why the dashboard and not the server marks completion: the completion write already exists behind an authenticated, admin-gated POST, and both pages already hold a signed-in session. Moving it into `GET /onboarding/state` or event ingest would put a write in a read path or the hot ingest path.

## Changes

### Dashboard

- Replace `views/SetupWizard.vue` with `views/Setup.vue` implementing the flow above. Route name stays `setup`, path stays `/setup`.
- `components/AgentPasteBox.vue`: drop the `variant` prop and both footer lines (the `wizard` slot and the empty-state "Setup guide" link to `/setup`). `IssuesList.vue` and `SessionsList.vue` keep using the box.
- `views/AgentApprove.vue`: the completion change in Flow step 5.
- `api.ts`: delete `onboardingSetup`, `OnboardingSetupResponse`, `getEventStatus`, `EventStatus`.
- `types/api.ts`: delete `OnboardingState.next_step`.
- `SetupWizard.vue`'s imports that become unused elsewhere stay in place if other views use them (`RepoSelector`, `CodeBlock`, notification and GitHub API functions are used by Settings).
- Stale `localStorage` keys `opslane_onboarding_key_<projectId>` written by the old wizard are left alone. They hold a public ingest key and nothing reads them after this change.

### Ingestion

- Delete `POST /api/v1/onboarding/setup` (`handler/routes.go:146`), `handler/onboarding.go` (`OnboardingSetup`, `onboardingLimiter`; move `environmentJSON` if anything else uses it), `db.OnboardingProvision`, and `db.ErrOrgOnboarded`.
- Keep `provisionProjectTx`, `EnsureProjectDefaultEnvironmentTx`, `CreateProjectKeyTx`, `RevokeExcessOnboardingKeysTx`: each has other callers (`POST /projects`, agent provisioning, key minting).
- Remove `next_step` from `onboardingStateJSON` and `evaluateOnboarding`. Keep every other field: `OnboardingBanners.vue` reads `github_connected` and `slack_connected`, and `/setup` reads `project_id`, `has_events`, `onboarding_complete`.
- Keep `GET /projects/{projectID}/event-count` (Go route). Only its dashboard client goes.
- No migration. `projects.idempotency_token` and `orgs.onboarded_at` stay in use by `POST /projects` and completion.

### Tests

- `views/__tests__/setup-wizard.test.ts` becomes `views/__tests__/setup.test.ts` covering: already-complete redirect, member screen, each status line, auto-complete then navigate, complete failure shows **Try again** and does not navigate, polling stops on unmount.
- `views/__tests__/agent-approve.test.ts`: add the has-events completion case and keep the not-yet-has-events refusal case.
- `components/__tests__/agent-paste-box.test.ts`: remove variant assertions.
- `handler/onboarding_test.go`: delete `TestOnboardingSetupIdempotency`; keep `TestOnboardingState_GitHubConnectedRequiresRepoCoverage` and the shared helpers (`seedTenantNoProject`, `onboardingHTTP`, `mustDecodeOnboarding`) that other tests use.
- `handler/onboarding_state_test.go`: seed the project through `POST /api/v1/projects` instead of `/onboarding/setup`, assert on `project_id`/`has_events`/`onboarding_complete` instead of `next_step`, and assert `POST /api/v1/onboarding/setup` now returns 404.
- `handler/project_provisioning_test.go:108`: drop `/onboarding/setup` from the cloud-member 403 table.
- `test-e2e/dashboard-mock-harness.ts`: the mocked onboarding state must stay on the waiting state (`project_id: null`, `has_events: false`, no `next_step`), otherwise the new page completes and leaves `/setup` during the smoke. Update the comment at line 111.
- `test-e2e/dashboard-design-system.test.ts:82` and `dashboard-screenshots.test.ts:60`: new identity regex for the setup heading; rename fixture `setup-github-mock` to `setup-waiting-mock`.

### Docs

- `docs/install.md:28`: remove the wizard sentence. The manual steps stay for people who already have a key.
- `docs/guides/api-keys.md:26`, `docs/guides/github-app.md:34` and `:77`, `docs/guides/slack-notifications.md:30`: replace wizard references with the agent setup or Settings. Drop `packages/dashboard/src/views/SetupWizard.vue` from any doc's covered-paths frontmatter (at least `slack-notifications.md:7`).

## Out of scope (file as issues)

- **Self-hosted `/setup`.** The prompt points at the hosted runbook. A fix is an instance-served `/INSTALL.md` with the origin substituted.
- **No ingest key without an agent.** Settings' key form offers only MCP and source-map scopes, and Settings is behind the onboarding guard.
- **Orgs with several projects that never onboarded.** State and complete both read the newest project. If an agent attaches an older project, `/setup` never sees `has_events` and the user waits for the agent's step 11. New sign-ups have one project, so this only affects pre-existing orgs.

## Acceptance criteria

1. A new cloud admin who signs up lands on `/setup` and sees the heading, the prompt line, a copy button and the waiting status. There is no project-name input, framework tab, GitHub control, Slack control or "Do this later" button.
2. The copy button writes exactly `Set up https://docs.opslane.com/INSTALL.md` to the clipboard.
3. With `/setup` open and no reload, the status line moves from waiting to approved within 6 seconds of an agent session being approved.
4. Within 6 seconds of the first event reaching the project, `/setup` calls `POST /onboarding/complete`, `localStorage.opslane_onboarding_complete` becomes `1`, and the browser is on `/` with the project selected.
5. If `POST /onboarding/complete` fails, `/setup` shows the error and a **Try again** button, stays on `/setup`, and a retry that succeeds navigates to `/`.
6. An already-onboarded session that opens `/setup` is sent to `/` without calling `POST /onboarding/complete`.
7. A cloud member of a not-onboarded org sees the ask-an-admin screen, and no onboarding state or complete request is sent.
8. On the approve page after approval, with `/setup` closed, **Open dashboard** navigates once the first event has arrived (it calls complete itself), and still shows the "still finishing" message before the first event.
9. `POST /api/v1/onboarding/setup` returns 404. `GET /api/v1/onboarding/state` has no `next_step`. `OnboardingBanners` still shows the GitHub and Slack reminders from that response.
10. The agent's own `POST /agent/poll/{id}/complete` still returns 200 after the dashboard has already completed onboarding.
11. `pnpm --filter @opslane/dashboard build`, `pnpm --filter @opslane/dashboard test`, `go build ./...`, `go test ./handler ./db` with `DATABASE_URL` set and zero skips in the touched packages, and the dashboard e2e smoke and screenshot suites pass.
12. Live: on a local stack, a signed-in fresh org opens `/setup`, a headless agent runs a local copy of the runbook pointed at that stack, the user approves in the browser, and the `/setup` tab reaches `/` on its own after the test error arrives.
13. No doc outside `docs/plans/`, `docs/design/`, `docs/research/` and `docs/superpowers/` still describes the onboarding wizard.

## Review log

(empty; filled in after each Codex round)
