# Plan: remove the `cli/` package (final, after 3 Codex rounds)

## Context

`@opslane/cli` (~23.6k LOC, `"private": true` since #200, never published, last touched by #400) did three jobs:
1. Human login/setup commands (`login`, `init`, `doctor`, `setup`, `onboard`, `snippet`, `verify`, `status`, `errors`, `sourcemaps install-plugin`).
2. Agent-first onboarding protocol (`setup --start/--poll`) against `/api/v1/agent/*` + `agent_sessions`.
3. Local stdio MCP (`opslane mcp`, `init-claude`) — superseded by #401's remote `/mcp` (`opslane_ak_` bearer keys). Same three tools with identical names/arg schemas/descriptions; the Go formatter is a port of the TS one with its own tests.

Why deletion is safe for users:
- The package cannot be installed (`private: true` + `bin`), so `npx @opslane/cli` has never worked; the only user-facing doc for it (`docs/quickstart/agent.md`) is `draft: true`.
- The dashboard card that advertises it is behind `AGENT_ONBOARDING_ENABLED = false`, a source constant with no runtime override (`packages/dashboard/src/agent-onboarding.ts:8`).
- Server routes it calls stay in place in this PR (see Out of scope), so no deployed environment changes behavior.

## Scope: one PR, client side only

This PR deletes the CLI and every reference outside server code. Server-side CLI-only surfaces (PKCE OAuth routes, `/api/v1/agent/*`, `/api/v1/onboard/provision`, `agent_sessions`, `cli_pkce_requests`) are **out of scope** — tracked as a follow-up issue, not started here. Reasons: they are entangled with the live browser `/auth/callback` and email-verification paths, need a drop migration with a rolling-deploy story, and need prod route-usage data before we call them dead. Nothing in this PR makes that work harder; the inventory is in the issue.

## Steps

### 1. Preserve the skill text (the only thing without a remote counterpart)
`cli/skills/opslane/SKILL.md` (issue-selection heuristics, `<untrusted>` fencing, `verified_fix` vs `needs_human` branching, PR-then-`opslane_link_pr`) is not served by the remote MCP or anywhere else. Move it, verbatim, into a new published guide `docs/guides/mcp.md` ("Connect a coding agent to Opslane"):
- Create an `opslane_ak_` key in Settings (panel already ships in `Settings.vue`).
- `.mcp.json` snippet for Claude Code (`{"type":"http","url":"<origin>/mcp","headers":{"Authorization":"Bearer ${OPSLANE_API_KEY}"}}`) and the equivalent Codex `config.toml` block — verify both formats against current client docs before writing.
- Key handling: env var, never commit, revoke from Settings.
- The skill text as a "drop this into `.claude/skills/opslane/SKILL.md`" block. This is a discoverability downgrade vs `init-claude` installing it; accepted for now since `init-claude` could never run from npm anyway.
- Frontmatter uses `covers:` (not `sources:`; `check-docs-drift.mjs:28` rejects published prose without a non-empty `covers:`) plus `description:`, matching `docs/guides/api-keys.md`: `packages/ingestion/handler/mcp.go`, `packages/ingestion/mcp/format.go`, `packages/dashboard/src/views/Settings.vue`. Add to `llms.txt` (drift checks #7/#8 enforce both directions) and to the manual sidebar list in `docs-site/astro.config.mjs:85+` (guides/** auto-publish but are not auto-listed). Do NOT add it to `check-docs-voice.mjs` `LEGACY_EXEMPT` (the file forbids new entries); write it to pass the voice check.

### 2. Delete
- `cli/` (whole tree).
- `test-fixtures/codemod-react`, `codemod-vue`, `codemod-next`, `codemod-nuxt` (consumed only by `cli/src/__tests__/codemod-apply.test.ts` and the codemod block below).
- `test-e2e/browser-smoke.test.ts:119–215` — the `'browser smoke: patched codemod delivers an event'` describe, plus imports at lines 12–14, `CODEMOD_REACT_FIXTURE`, `CODEMOD_TEST_API_KEY`, `SDK_SOURCE` (line 38), and the then-unused node imports (`createHttpServer`, `cp`, `mkdtemp`, `rm`, `writeFile`, `tmpdir`, `join`); let `tsc`/eslint confirm.
- `test-fixtures/.gitignore` (its only rule is `codemod-*/.codemod-check-*`). The other two describes (Vue/React fixtures, keyless worker) do not touch the CLI and stay.
- `docs/quickstart/agent.md`, `docs/reference/cli-agent-contract.md`.
- `docs-site/src/agent-md.ts`, `docs-site/src/pages/agent.md.ts`, `docs-site/src/__tests__/agent-md.test.ts`, `docs-site/src/__tests__/agent-quickstart-content.test.ts`, `docs-site/scripts/check-dark-launch.mjs` and its `&& node scripts/check-dark-launch.mjs` in `docs-site/package.json:9`.
- `packages/dashboard/src/agent-onboarding.ts`, `agent-onboarding.test.ts`, `components/AgentOnboardingCard.vue`, `components/__tests__/agent-onboarding-card.test.ts`, `views/__tests__/agent-card-wiring.test.ts` (imports the deleted module and asserts the card renders).
- `docs/runbooks/activate-agent-onboarding.md` — the runbook for flipping the CLI dark-launch; nothing left to activate. Check whether section 1 (GitHub App install routing) is still a live procedure; if so keep only that section, otherwise delete the file.

### 3. Edit
- `pnpm-workspace.yaml`: drop `- 'cli'`. Then `pnpm install` (non-frozen) to regenerate `pnpm-lock.yaml`; commit it; final verification runs `pnpm install --frozen-lockfile` from a clean `node_modules`-less state.
- `.github/workflows/release-npm.yml:41,73`: drop `--filter @opslane/cli...`.
- `scripts/check-packed-packages.mjs`: remove the `@opslane/cli` target (lines 103–115) and the CLI lines in the header comment (5, 12).
- `scripts/check-licenses.mjs:22–32`: remove the CLI license assertion block.
- `scripts/check-docs-drift.mjs`: remove check #6 (`cli/src/contract.ts` vs `cli-agent-contract.md`, lines 222–263), its header line (11), and `codeAgentStatuses.length` in the summary (303).
- `scripts/ci-changed-areas.mjs:20`: drop the "CLI feeds E2E" reason. `scripts/__tests__/ci-changed-areas.test.mjs:34`: swap the `cli/src/init.ts` fixture path for a real path.
- `scripts/docs-sync/snippets.json:164–189`: drop the `docs/quickstart/agent.md` entries.
- `scripts/check-docs-voice.mjs:50`: drop `docs/quickstart/agent.md` from the allowlist.
- `docs/agents/domain.md:26`: drop `cli/` from the tree.
- `packages/dashboard/src/views/Login.vue:12–13,31–32,325–331` and `SetupWizard.vue:12,15,22–23,260–262`: drop the card import, the card-only `origin`/enabled variables, and the wrapper blocks around the render.
- `docs/guides/github-app.md:45`: drop the `opslane setup` extra-permissions paragraph.
- `docs/guides/source-map-privacy.md:3`: drop `cli/src/codemods/vite-messages.ts` from `covers:`.
- `llms.txt:3` ("…dashboard, and CLI are AGPL"), `:42` (contract link → replace with the MCP guide).
- `docs-site/src/content/docs/index.mdx:63`: drop "CLI" from the licensing sentence.
- `docs-site/astro.config.mjs:48,75`: key-scope copy says two scopes; add the `opslane_ak_` MCP key (third scope) and link the new guide in the agent-bundle list.
- `TODOS.md:190`: reword the `opslane onboard` item to refer to dashboard onboarding / the open server follow-up.
- `packages/sdk/vite-plugin/index.ts:675–676`: drop the sentence claiming `opslane sourcemaps install-plugin` still detects legacy configs.
- `AGENTS.md:15,18,40,68`; `CONTEXT.md:35,39`: remove CLI rows/sentences.
- `.gitignore:27`: drop the onboard-eval-corpus lines.
- `docs/decisions/` uses a `- **Status:**` bullet. For the four still-ACCEPTED CLI decisions (`vite-config-execution.md`, `onboard-deviation.md`, `tui-renderer.md`, `s6a-design-divergence.md`) change the status to `SUPERSEDED (2026-08-23) — the CLI was removed; see <PR link>`. Leave `agent-runs-commands.md` (REJECTED) and `anthropic-agent-sdk-terms.md` (already SUPERSEDED) alone. PR link filled in on the same branch once the PR exists.
- `docs/reference/http-routes.md`: untouched (routes still exist; check #1 diffs it against `routes.go`).
- `docs/plans/**`, `docs/design/**`, `docs/superpowers/**`: untouched (historical).

### 4. Follow-up issue (not in this PR)
"Retire CLI-only server surfaces": routes `/oauth/authorize`, `/oauth/token`, `/api/v1/agent/setup`, `/api/v1/agent/poll/{id}`, `/agent/auth/{id}`, `/agent/auth/callback`, `/api/v1/onboard/provision`, `/api/v1/auth/verify`; handlers `agent_setup.go`, `onboard_provision.go`, PKCE pieces in `auth_handlers.go`/`github_oauth.go:190–203`/`oauth_verify.go:91–95,203–207`/`auth.go:97`/`auth/oauth.go`/`db/queries.go`; admin funnel `db/admin.go:104–127`; tables `agent_sessions`, `cli_pkce_requests`, `cli_*` columns on `oauth_verification_continuations`; `scripts/seed-onboarding.sql`, `scripts/check-migration-reapply.sh:25,49,60`, `.gitleaks.toml:50`; `http-routes.md` rows. Preconditions: prod access logs show zero hits on those routes over 30 days; rolling-deploy-safe migration ordering (code stops reading → deploy → drop).

## Verification
- Clean-checkout gate: `rm -rf node_modules packages/*/dist cli` state → `pnpm install --frozen-lockfile && pnpm -r build && pnpm test` (read the skip count; DB-gated suites skip without `DATABASE_URL`). `(cd packages/ingestion && go build ./... && go test ./...)` unchanged. `docker compose config --quiet`.
- `pnpm test:repo` (docs drift/scope/voice/pins/ports) and `pnpm --filter docs-site build` (check-built-links + the new guide renders).
- `pnpm --filter @opslane/test-e2e test` with Playwright available against a worktree stack so the two remaining browser-smoke describes still run (not skip).
- Reference sweep: `git grep -n -e '@opslane/cli' -e 'cli/src' -e 'init-claude' -e 'opslane setup' -e 'opslane onboard' -e 'opslane mcp' -e 'codemod-react' -e 'AGENT_ONBOARDING' -e 'quickstart/agent' -e 'cli-agent-contract' -- ':!docs/plans' ':!docs/design' ':!docs/superpowers' ':!docs/decisions' ':!docs/research' ':!pnpm-lock.yaml'`. Expected survivors, each justified: `packages/ingestion/handler/agent_setup.go` and `packages/ingestion/auth/oauth.go:15` (server code deferred to the follow-up; reword the `oauth.go` comment to stop pointing at `cli/src/auth.ts`), `packages/sdk/CHANGELOG.md:27` (historical). Anything else is a miss.
- Dashboard: `pnpm --filter @opslane/dashboard test` + build; eyeball Login and SetupWizard.
- Run the two edited gates directly, since root `pnpm test` does not include them: `node scripts/check-packed-packages.mjs` (after `pnpm -r build`) and `node scripts/check-licenses.mjs`.
