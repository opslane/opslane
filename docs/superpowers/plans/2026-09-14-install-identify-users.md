# Agent Runbook: Identify Users Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent setup runbook add `setUser` and `clearUser` to the user's app, so Opslane can name the person and customer company behind each error.

**Architecture:** Documentation-only change. `docs-site/public/INSTALL.md` is the runbook a coding agent follows when told "Set up https://docs.opslane.com/INSTALL.md"; `docs-site/public/SKILL.md` is the same file served under a second name and must stay byte-identical (`scripts/check-docs-drift.mjs:28`). `docs/install.md` is the human install guide; it already documents `setUser`, and its summary of what the agent does must mention identification.

**Tech Stack:** Markdown runbook read by coding agents; Node check scripts (`pnpm test:repo`); docs site build (`pnpm --filter @opslane/docs-site build`).

**Spec:** Problem, facts, and requirements below (no separate spec file).

## Problem

A real onboarding on 2026-09-13 (org "Harsha Vankayalapati", repo AgentWebPro/agentweb-customer-portal) ended with errors but no user identity. Step 4 of the runbook installs the SDK and `init`, and nothing tells the agent to call `setUser`. Without it every session is anonymous: the dashboard shows **No user identification**, Opslane cannot connect repeat activity to a person or account, and anonymous activity cannot start a standalone session-recording issue (`docs/install.md`, "Always call setUser").

## Facts the instructions must respect

- API (`packages/sdk/src/core.ts:16-49`, exported from `@opslane/sdk`): `setUser({ id: string; email?: string; account?: { id: string; name?: string } })`, ignored when `id` is empty; `clearUser()`. Identity is module state attached to every later error event as `context.user = { id, email, account_id, account_name }` (`core.ts:55-83`) until `clearUser` runs.
- Session rotation is keyed on the user ID only (`packages/sdk/src/session.ts:146`), and the server keeps one account per end user (`packages/ingestion/db/sessions.go:288`). Calling `setUser` again with the same ID and a different account does not start a new session and relabels that user's account.
- The SDK is browser code. The runbook initializes Next.js inside a `'use client'` provider effect (`INSTALL.md` step 4). The human guide says `init` first, then `setUser` from a client component (`docs/install.md:46`, `:135`).
- `setUser` sends the user ID and email unmasked; the privacy guide says to disclose identification in the app's privacy notice (`docs/guides/replay-privacy.md:30`, `:52`).
- Step 5 proves an event arrived, not that it carried identity. Step 11 prints each step's self-reported note (`INSTALL.md` step 11).

## Requirements

- R1. Browser only: call `setUser`/`clearUser` from client-side code after `init` has run; in SSR frameworks only from a client component; never from server components, loaders, actions, route handlers, or middleware.
- R2. Follow the app's settled auth state, not a single sign-in function: do nothing while auth is still loading; call `setUser` whenever the settled signed-in user becomes known or changes (fresh sign-in, a session restored on page load, a different user signing in); call `clearUser()` whenever settled state becomes signed out (sign-out, session expiry, logout in another tab).
- R3. Fields: `id` is the app's stable user ID, never a display name. `account` is the customer organization, workspace, or team the user is working in; omit it when the app has none. Do not promise account-switch tracking (see Facts).
- R4. Privacy: `email` and `account.name` are optional. Include them only when the app already shares that data with error-monitoring or analytics tools; otherwise send IDs only. Never log or print the user or session object. Tell the user that identification is on and belongs in their privacy notice.
- R5. Every separately built bundle that calls `init` needs its own identification.
- R6. No sign-in: skip identification and say so in the `install_sdk` progress note.
- R7. Truthful records: the progress note says `setUser added` or `no sign-in`; the commit message does not claim identification unconditionally; step 10 may commit the file or files where `setUser` and `clearUser` were added.
- R8. `docs/install.md`'s "Let your agent do it" paragraph says the agent identifies signed-in users.
- R9. SKILL.md stays byte-identical to INSTALL.md, and the docs site build still serves both.

## Non-goals

- No SDK, server, or data-model change (including account-switch tracking), no new agent progress step, no new state fact.
- No change to the dashboard setup wizard's manual snippet.
- No change to the human install guide beyond R8.

## Global Constraints

- Published prose rules (`scripts/check-docs-voice.mjs`, applied to `docs/install.md`): no em dashes or en dashes, no banned AI vocabulary, no project-internal terminology. Apply the same rules to INSTALL.md even though the voice check does not scan it.
- Runbook voice: imperative, short sentences, code in backticks, no new headers.
- Commits use `git -c user.email=abhishek@opslane.com commit`, and messages end with a blank line then `Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv`.
- Do not push or open a PR from the implementation task.

---

### Task 1: Runbook and install guide

**Files:**
- Modify: `docs-site/public/INSTALL.md` (step 4's last paragraphs; step 10's "Commit only files" paragraph and its `git commit --only -m` body)
- Modify: `docs-site/public/SKILL.md` (full copy of INSTALL.md)
- Modify: `docs/install.md:22`

**Interfaces:** none (documentation).

- [ ] **Step 1: Confirm the drift check passes before editing**

Run: `node scripts/check-docs-drift.mjs`
Expected: exit 0.

- [ ] **Step 2: Add the identification paragraph to step 4**

In `docs-site/public/INSTALL.md`, step 4 currently ends with these two paragraphs:

```text
**Plain**: call `init` before any other script runs.

If the site sets a Content-Security-Policy and you are not tunnelling, add `https://app.opslane.com` to `connect-src`. If a dev server was already running before the env file was written, restart it; public env vars are inlined at start. Then `opslane_progress install_sdk done "<framework>"`.
```

Insert this paragraph between them, as its own paragraph:

```text
**Identify users.** Opslane can only say which person and customer hit an error if the app calls `setUser`. Find the app's client-side auth state: an auth provider, a session hook, or the store that holds the current user. Wire identification to that state, in browser code that runs after `init`: while auth is still loading, do nothing; whenever the settled signed-in user becomes known or changes, including a session restored on page load, call `setUser({ id, email, account: { id, name } })` from `@opslane/sdk`; whenever it becomes signed out, including session expiry and logout in another tab, call `clearUser()`. In Next.js and other server-rendered apps, do this only in a client component, never in server components, loaders, actions, route handlers, or middleware. `id` is the app's stable user ID, never a display name. `account` is the customer organization, workspace, or team the user is working in; omit it when the app has none. `email` and `account.name` are optional: include them only when the app already shares that data with error-monitoring or analytics tools, otherwise send the IDs alone. Never log or print the user or session object. Every separately built bundle that calls `init` needs its own identification. If the app has no sign-in, skip this. When you add it, tell the user that user IDs (and emails, if sent) now go to Opslane and belong in their privacy notice.
```

Then change the end of the Content-Security-Policy paragraph from

```text
Then `opslane_progress install_sdk done "<framework>"`.
```

to

```text
Then `opslane_progress install_sdk done "<framework>, setUser added"`, or `"<framework>, no sign-in"` when the app has no sign-in.
```

- [ ] **Step 3: Let step 10 commit the identification change**

In step 10's paragraph that starts "Commit only files this runbook created or changed", replace

```text
the init snippet or provider component, `next.config.*` or `vite.config.*`,
```

with

```text
the init snippet or provider component, the file or files where `setUser` and `clearUser` were added, `next.config.*` or `vite.config.*`,
```

In the bash block, replace the start of the commit body string

```text
"Installs @opslane/sdk, initializes it with the public ingest key from the environment, and uploads source maps on production builds.
```

with

```text
"Installs @opslane/sdk, initializes it with the public ingest key from the environment, identifies the signed-in user where the app has sign-in, and uploads source maps on production builds.
```

Leave the rest of that string and the block unchanged.

- [ ] **Step 4: Update the install guide summary**

In `docs/install.md`, replace

```text
Your agent installs the SDK, verifies an error from your app, and configures source-map uploads.
```

with

```text
Your agent installs the SDK, identifies signed-in users, verifies an error from your app, and configures source-map uploads.
```

- [ ] **Step 5: Copy the runbook to its second name**

Run: `cp docs-site/public/INSTALL.md docs-site/public/SKILL.md`

- [ ] **Step 6: Run the checks**

```bash
set -o pipefail
pnpm test:repo > /tmp/claude-1000/idu-test-repo.log 2>&1; echo "test:repo exit=$?"; tail -8 /tmp/claude-1000/idu-test-repo.log
cmp docs-site/public/INSTALL.md docs-site/public/SKILL.md && echo IDENTICAL
grep -c "setUser" docs-site/public/INSTALL.md
sed -n '/^## 10\./,/^## 11\./p' docs-site/public/INSTALL.md | awk '/^```bash$/{f=1;next} /^```$/{f=0} f' \
  | sed 's/files=(<exact paths, one per array element, quoted>)/files=(a)/' > /tmp/claude-1000/idu-step10.sh
bash -n /tmp/claude-1000/idu-step10.sh && echo STEP10-PARSES
grep -nP '[\x{2013}\x{2014}]' docs-site/public/INSTALL.md docs/install.md || echo NO-DASHES
pnpm --filter @opslane/docs-site build > /tmp/claude-1000/idu-docs-build.log 2>&1; echo "docs build exit=$?"
cmp docs-site/dist/INSTALL.md docs-site/public/INSTALL.md && cmp docs-site/dist/SKILL.md docs-site/public/SKILL.md && echo DIST-MATCHES
```

Expected: `test:repo exit=0`, `IDENTICAL`, a count of at least 3, `STEP10-PARSES`, `NO-DASHES`, `docs build exit=0`, `DIST-MATCHES`. If the build writes the files somewhere other than `docs-site/dist/`, find them with `find docs-site/dist -name INSTALL.md` and compare those.

- [ ] **Step 7: Commit**

```bash
git add docs-site/public/INSTALL.md docs-site/public/SKILL.md docs/install.md
git -c user.email=abhishek@opslane.com commit -m "docs(install): have the setup agent identify signed-in users

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

---

## Verification (after Task 1, run by the orchestrator, not the implementer)

The change is instructions for an agent, so verify by having fresh agents follow them on small apps and checking what reaches Opslane at runtime. No fixture in `test-fixtures/` has authentication, so build throwaway apps in the session scratchpad.

**Setup.** Build and pack the SDK so fixtures use current code: `pnpm --filter @opslane/sdk build && (cd packages/sdk && npm pack --pack-destination <scratch>)`. Start a local stub on a free port that answers `POST /api/v1/events` with 202 and records each JSON body, and answers any other `/api/v1/*` request with 204.

**Fixture A, Vite + React + TypeScript with async auth.** `src/auth.tsx` exposes `{ status: 'loading' | 'signedIn' | 'signedOut', user }`. On load it stays `loading` for 300 ms, then restores a saved session from `localStorage` if present. `signIn(email)` sets `{ id: 'u_42', email, displayName: 'Ada', org: { id: 'org_7', name: 'Acme' } }` (a second button signs in `u_99` at `org_9`). A session expiry timer switches to `signedOut` after 5 seconds without a button click. `src/main.tsx` calls `init({ apiKey: 'opslane_pk_test', endpoint: 'http://localhost:<stub>', environment: 'development', replay: { enabled: false } })` and renders the app, and `src/App.tsx` has a "Throw" button that throws `new Error('probe')`. No `setUser` anywhere. Install the packed SDK, commit in a throwaway git repo.

**Fixture B, Next.js placement.** Files only, no install or build: `app/layout.tsx` (server component that reads a session with `await getSession()` and passes `user` to `<AuthProvider user={user}>`), `app/auth-provider.tsx` (`'use client'`, holds the user in state), and `app/opslane-provider.tsx` (the runbook's client provider with `init`). No `setUser` anywhere.

**Fixture C, no sign-in.** Fixture A with `auth.tsx` removed and `App.tsx` reduced to the Throw button, building cleanly.

**Agent runs.** For each fixture, give a fresh general-purpose subagent the INSTALL.md rules section (top of file), all of step 4, and step 10's "Commit only files" paragraph, plus the fixture path. It edits the fixture (no Opslane registration, no network) and reports the progress note it would send and the files it would commit.

**Pass criteria.**
- A, static: `setUser` is called with `id: user.id` (not `displayName`) and `account: { id: org.id, ... }`, from the auth-state effect, not only inside `signIn`; `clearUser()` runs when status becomes `signedOut`; nothing happens while `loading`; no user or session object is logged; the committed-files list includes the edited file; the note is `..., setUser added`; `tsc --noEmit` and `vite build` pass.
- A, runtime: serve the build with `vite preview` and drive it with Playwright (Chromium is installed). Record the stub's event bodies for each probe: throw before sign-in (no `context.user`); sign in `u_42` and throw (`context.user.id === 'u_42'`, `account_id === 'org_7'`); reload and throw after restore (`u_42` again); sign in `u_99` and throw (`u_99`, `org_9`); wait for expiry and throw (no `context.user`); sign in, sign out, throw (no `context.user`).
- B: identification lands only in a `'use client'` file (the auth provider or the Opslane provider), none in `app/layout.tsx` or any server file; `init` runs before or in the same client effect chain as `setUser`.
- C: no identification code is added and the note is `..., no sign-in`.
