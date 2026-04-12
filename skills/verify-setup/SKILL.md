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

Read the project's `package.json` and look at the `scripts.dev`, `scripts.start`, and `scripts.serve` entries for port numbers. Check for:

- Flags like `-p 3000`, `--port 5173`, `--port=8080`
- Inline env vars like `PORT=3000`

If no port found in package.json, check these files in order:
- `.env.local`, `.env.development`, `.env` — look for `PORT=XXXX`
- `vite.config.ts`, `vite.config.js`, `vite.config.mjs` — look for `server.port` or `port:` in the config
- `docker-compose.yml` — look for port mappings like `"3000:3000"`

If the detected port is `0`, warn the user: "Port 0 means the OS picks a random port. Please tell me the actual port your dev server runs on."

If no port is found in any file, default to `3000` and tell the user.

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

For each test file, extract:
- URLs from `page.goto()`, `cy.visit()`, or equivalent navigation calls
- Selectors from `page.locator()`, `page.getByTestId()`, `page.getByRole()`, `cy.get()`, etc.
- If tests use Page Object Models or helper files, follow the imports to resolve actual selectors

Group selectors by the URL/page they're used on. Keep it compact, max 10 selectors per page. Prefer `data-testid` and role selectors.

Build a JSON object with this schema:
```json
{"pages": {"/url": {"selectors": {"name": {"value": ".selector", "source": "file:line"}}, "source_tests": ["file.spec.ts"]}}}
```

If no test files are found, use `{"pages": {}}`.

### Step 7: Write app.json

Merge the routes and pages into a single JSON object and write it using the Write tool to `.verify/app.json`:

```json
{
  "indexed_at": "2026-04-11T12:00:00.000Z",
  "routes": { ... },
  "pages": { ... }
}
```

Use the current ISO timestamp for `indexed_at`.

### Step 8: Configure Playwright MCP

Check if Playwright MCP is already configured by attempting to use any Playwright MCP tool (e.g., list resources from the playwright server).

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
