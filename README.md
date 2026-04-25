# Verify

**Self-serve QA for your PR, before you push.**

Paste the ticket. Verify drives a browser against your local dev server and checks each requirement. Pass/fail + screenshots, inline in Claude Code. No CI. No tests to write. No infrastructure.

![Verify report screenshot](docs/report-screenshot.png)

## Install (90 seconds)

**Prerequisites:** Claude Code with OAuth login (`claude login`).

Three commands, in order:

**1. Add Playwright MCP** (one-time per machine)

```bash
claude mcp add playwright -- npx @playwright/mcp@latest --storage-state .verify/auth.json --isolated
```

Restart Claude Code after this command.

**2. Set up the project** (one-time per project, run from your repo root)

```bash
/verify-setup
```

Auto-detects your dev server port, indexes routes and selectors from your codebase, and writes `.verify/config.json` + `.verify/app.json`.

**3. Verify a PR** (run anytime)

```bash
/verify
```

Paste the ticket. Verify reviews it for ambiguities, drives the browser through each requirement via Playwright MCP, and reports pass/fail with screenshots — all inline.

## Debugging failures

After a run, evidence lives in `.verify/runs/<run_id>/`:

```bash
# Browse raw evidence for a specific AC
ls .verify/runs/*/evidence/<ac_id>/
```

Each AC's evidence directory contains:
- `result.json` — verdict, confidence, reasoning, steps taken
- `*.png` — screenshots captured during execution

## Architecture

`/verify` runs as a Claude Code skill using Playwright MCP for browser interaction:

1. **Spec Interpreter** — reviews acceptance criteria for ambiguities, asks clarifying questions
2. **AC Extractor** — parses the spec into concrete, testable acceptance criteria using seed data and known routes
3. **Browser Verification** — navigates the app via Playwright MCP, checks each AC, collects screenshots
4. **Report** — writes per-AC `result.json` and a combined `verdicts.json`

### Dev setup

See [CLAUDE.md](./CLAUDE.md) for full dev commands, conventions, and test instructions.
