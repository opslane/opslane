---
name: verify-setup
description: One-time setup for /verify. Auto-detects dev server and indexes the app.
---

# /verify-setup

Run once before using /verify on a new project. This skill does everything inline, no npm install needed.

## Prerequisites

- Dev server running locally (any framework)

## Steps

Follow these steps in order. Do not skip ahead.

### Step 1: Scaffold .verify/

```bash
mkdir -p .verify
```

Check if `.gitignore` already contains `.verify/`:

```bash
grep -q '^\.verify/$' .gitignore 2>/dev/null || echo '.verify/' >> .gitignore
```

If `.gitignore` didn't exist, create it with `.verify/` as the first line.

### Step 2: Detect dev server port

Find the dev server port. Check in this order:
1. `package.json` scripts (`dev`, `start`, `serve`) — look for `-p`, `--port`, or `PORT=` flags
2. `.env.local`, `.env.development`, `.env` — look for `PORT=XXXX`
3. Framework configs (`vite.config.*`, `next.config.*`) — look for port settings

If the detected port is `0`, warn the user and ask for the actual port. If no port found, default to `3000` and tell the user.

### Step 3: Ping the dev server

```bash
curl -sf http://localhost:{PORT} > /dev/null 2>&1
```

If this fails, wait 3 seconds and retry once:

```bash
sleep 3 && curl -sf http://localhost:{PORT} > /dev/null 2>&1
```

If it still fails, tell the user: "Dev server not running at http://localhost:{PORT}. Start it and re-run /verify-setup." Stop here.

### Step 4: Write config.json

Use the Write tool to create `.verify/config.json`:

```json
{
  "baseUrl": "http://localhost:{PORT}"
}
```

If `.verify/config.json` already exists, read it first and only update the `baseUrl` field. Preserve any other fields.

### Step 5: Index routes

Find all user-facing pages and routes in this app. Look for route definitions, page components, URL patterns.

Check any framework:
- Next.js: `app/` directory (route segments) or `pages/` directory
- Remix: `routes/` directory
- React Router: look for `<Route>` components or `createBrowserRouter` configs
- Express/Hono/Fastify: look for `.get()`, `.post()` route definitions
- SvelteKit: `routes/` directory
- Nuxt: `pages/` directory

This may be a monorepo. Check under `apps/`, `packages/`, `src/`.

Skip API routes (`/api/*`). Only include user-facing pages.

Build a JSON object with this schema:
```json
{"routes": {"/path": {"component": "file/path.tsx"}}}
```

Each key is a URL path. Each value has a `component` field with the source file path.

If no routes are found, use `{"routes": {}}`.

### Step 6: Index selectors from tests

Find the e2e/integration test suite in this project. Look for:
- Playwright tests (`.spec.ts`, `.test.ts` in `e2e/`, `tests/`, `test/`)
- Cypress tests (`.cy.ts`, `.cy.js`)

This may be a monorepo. Check under `packages/`, `apps/`, `tests/`, `e2e/`.

For each test file, extract the URLs navigated to and selectors used. Group selectors by URL/page. Keep it compact — max 10 selectors per page. Prefer `data-testid` and role selectors.

Build a JSON object with this schema:
```json
{"pages": {"/url": {"selectors": {"name": {"value": ".selector", "source": "file:line"}}, "source_tests": ["file.spec.ts"]}}}
```

If no test files are found, use `{"pages": {}}`.

### Step 7: Write app.json

Merge the routes and pages into a single JSON object and write it using the Write tool to `.verify/app.json`:

```json
{
  "indexed_at": "<current ISO timestamp>",
  "routes": { ... },
  "pages": { ... }
}
```

### Step 8: Configure Playwright MCP

Check if Playwright MCP is already configured: use `ListMcpResourcesTool` with `server="playwright"`. If it returns results, Playwright is configured.

If not configured, tell the user:

> Playwright MCP is required for /verify. Install it:
>
> ```
> claude mcp add playwright -- npx @playwright/mcp@latest --storage-state .verify/auth.json --isolated
> ```
>
> Then restart Claude Code and re-run /verify-setup to confirm.

If already configured, skip this step.

### Step 9: Done

Print a summary:

```
Setup complete:
  Base URL: http://localhost:{PORT} (source: {PORT_SOURCE})
  Routes:   {N} routes indexed
  Pages:    {N} pages with selectors
  Config:   .verify/config.json
  Index:    .verify/app.json

Run /verify to verify your changes.
```

## Troubleshooting

**"Dev server not running"** — Start your dev server first, then re-run `/verify-setup`.

**Wrong port detected** — Tell the skill the correct port: "My dev server runs on port 5173".

**Playwright MCP not found** — Run `claude mcp add playwright -- npx @playwright/mcp@latest --storage-state .verify/auth.json --isolated` and restart Claude Code.

**Auth expired during /verify** — Log into your app in the Playwright browser session, or provide credentials when prompted by `/verify`.
