# Agent Runbook: Identify Users Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent setup runbook add `setUser` and `clearUser` to the user's app, so Opslane can name the person and customer company behind each error.

**Architecture:** Documentation-only change. `docs-site/public/INSTALL.md` is the runbook a coding agent follows when told "Set up https://docs.opslane.com/INSTALL.md"; `docs-site/public/SKILL.md` is the same file served under a second name and must stay byte-identical (`scripts/check-docs-drift.mjs:28`). `docs/install.md` is the human install guide; it already documents `setUser` but its summary of what the agent does must mention identification.

**Tech Stack:** Markdown runbook read by coding agents; Node check scripts (`pnpm test:repo`).

**Spec:** Problem and requirements below (no separate spec file).

## Problem

A real onboarding on 2026-09-13 (org "Harsha Vankayalapati", repo AgentWebPro/agentweb-customer-portal) ended with errors but no user identity. The runbook's step 4 installs the SDK and `init`, and nothing tells the agent to call `setUser`. Without it every session is anonymous: the dashboard shows **No user identification**, Opslane cannot connect repeat activity to a person or account, and anonymous activity cannot start a standalone session-recording issue (`docs/install.md`, "Always call setUser").

The SDK API (`packages/sdk/src/core.ts:16-49`, exported from `@opslane/sdk`):

```ts
interface UserIdentity { id: string; email?: string; account?: { id: string; name?: string } }
export function setUser(user: UserIdentity): void   // ignored when id is empty
export function clearUser(): void
```

## Requirements

- R1. Step 4 tells the agent to find where the app learns who is signed in and call `setUser({ id, email, account: { id, name } })` from `@opslane/sdk` as soon as the user is known, including when a saved session is restored on page load.
- R2. It says what the fields are: the app's stable user ID (not a display name), the user's email, and `account` as the customer organization, workspace, or team the user belongs to; omit `account` when the app has none; call `setUser` again when the user switches accounts.
- R3. It tells the agent to call `clearUser()` where the user signs out.
- R4. It says every separately built bundle that calls `init` needs its own `setUser`.
- R5. It covers apps without sign-in: skip, and record that in the `install_sdk` progress note.
- R6. It forbids sending anything beyond those fields (no tokens, no other profile data).
- R7. Step 10 lets the agent commit the file or files where `setUser` and `clearUser` were added, and the commit message mentions identification.
- R8. `docs/install.md`'s "Let your agent do it" paragraph says the agent identifies signed-in users.
- R9. SKILL.md stays byte-identical to INSTALL.md.

## Non-goals

- No server change, no new agent progress step, no new state fact. The `install_sdk` note carries the outcome.
- No change to the dashboard setup wizard's manual snippet.
- No change to the human install guide beyond R8; it already documents `setUser`.

## Global Constraints

- Published prose rules (`scripts/check-docs-voice.mjs`, applied to `docs/install.md`): no em dashes or en dashes, no banned AI vocabulary, no project-internal terminology. Follow the same rules in INSTALL.md even though the voice check does not scan it.
- Runbook voice: imperative, short sentences, code in backticks, no headers added.
- Commits use `git -c user.email=abhishek@opslane.com commit`, and messages end with a blank line then `Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv`.
- Do not push or open a PR from the implementation task.

---

### Task 1: Runbook and install guide

**Files:**
- Modify: `docs-site/public/INSTALL.md` (step 4, the paragraph that ends with `opslane_progress install_sdk done "<framework>"`; step 10, the "Commit only files" paragraph and the `git commit --only -m` message)
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
**Identify users.** Find where the app learns who is signed in: an auth provider, a session hook, or the request that loads the current user. As soon as the user is known, including when a saved session is restored on page load, call `setUser({ id, email, account: { id, name } })` from `@opslane/sdk`. Use the app's stable user ID, not a display name. `account` is the customer organization, workspace, or team the user belongs to; omit it when the app has none, and call `setUser` again when the user switches accounts. Send only these fields, never tokens or other profile data. Call `clearUser()` where the user signs out. Every separately built bundle that calls `init` needs its own `setUser`. Without it, Opslane reports every error as anonymous and cannot say which customer hit it. If the app has no sign-in, skip this.
```

Then change the end of the Content-Security-Policy paragraph from

```text
Then `opslane_progress install_sdk done "<framework>"`.
```

to

```text
Then `opslane_progress install_sdk done "<framework>, users identified"`, or `"<framework>, no sign-in"` when you skipped identification.
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

In the bash block, replace the commit body string

```text
"Installs @opslane/sdk, initializes it with the public ingest key from the environment, and uploads source maps on production builds.
```

with

```text
"Installs @opslane/sdk, initializes it with the public ingest key from the environment, identifies signed-in users, and uploads source maps on production builds.
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

- [ ] **Step 6: Run the repository docs checks**

Run: `set -o pipefail; pnpm test:repo 2>&1 | tail -25`
Expected: exit 0, including `docs drift` (SKILL.md identical), `docs scope`, and `docs voice` passing.

Also run: `grep -c "setUser" docs-site/public/INSTALL.md` (expect at least 3) and `cmp docs-site/public/INSTALL.md docs-site/public/SKILL.md && echo IDENTICAL`.

Also run: `bash -n <(sed -n '/^## 10\./,/^## 11\./p' docs-site/public/INSTALL.md | awk '/^```bash$/{f=1;next} /^```$/{f=0} f' | sed 's/files=(<exact paths, one per array element, quoted>)/files=(a)/')` and expect exit 0, so the edited step-10 block still parses.

- [ ] **Step 7: Commit**

```bash
git add docs-site/public/INSTALL.md docs-site/public/SKILL.md docs/install.md
git -c user.email=abhishek@opslane.com commit -m "docs(install): have the setup agent identify signed-in users

Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv"
```

---

## Verification (after Task 1, run by the orchestrator, not the implementer)

The change is instructions for an agent, so verify it by having a fresh agent follow them on a small app with sign-in. No fixture in `test-fixtures/` has authentication.

1. In the session scratchpad, create a minimal Vite + React + TypeScript app with no Opslane code: `src/main.tsx` renders `<AuthProvider><App/></AuthProvider>`; `src/auth.tsx` restores a saved session from `localStorage` on load, exposes `signIn(email)` that sets `{ id: 'u_42', email, displayName, org: { id: 'org_7', name: 'Acme' } }`, `switchOrg(org)`, and `signOut()`; `src/App.tsx` shows sign-in or the user's name with Sign out and a company switcher. Add `@opslane/sdk` from the workspace build (`packages/sdk`) and a stub `init` call in `main.tsx` so only identification is missing. Commit it in a throwaway git repo.
2. Give a fresh general-purpose subagent only the step 4 "Identify users" paragraph and the step 10 file-list sentence from the edited INSTALL.md, and the app path. It must make the change and list the files it would commit.
3. Pass criteria, checked by reading its diff and running `tsc --noEmit` and `vite build`:
   - `setUser` is called with `id: user.id` (not `displayName`), `email`, and `account: { id: org.id, name: org.name }` after `signIn`, after the session restore on load, and after `switchOrg`.
   - `clearUser()` is called in `signOut`.
   - No token or extra profile field is sent.
   - The files it lists for commit include the file it edited.
   - The app still typechecks and builds.
4. Negative case: give a second fresh subagent the same paragraph and a copy of the app with `auth.tsx` removed (no sign-in). Pass: it makes no identification change and reports `no sign-in`.
