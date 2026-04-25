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

## Example

You paste a ticket like this:

> **As a user, I want to save a draft of my document.**
>
> Acceptance criteria:
> 1. The "Save Draft" button appears on the document edit page
> 2. Clicking it persists the document state without publishing
> 3. A confirmation toast appears with text "Draft saved"

Verify drives the browser through each AC and produces a verdict for every one:

```json
{
  "ac_1": { "verdict": "pass", "confidence": 0.95, "evidence": "save_draft_button.png" },
  "ac_2": { "verdict": "pass", "confidence": 0.91, "evidence": "draft_persisted.png" },
  "ac_3": { "verdict": "fail", "confidence": 0.88, "reasoning": "Toast text was 'Saved' not 'Draft saved'", "evidence": "toast_mismatch.png" }
}
```

You see the failing AC inline with the screenshot — before you push.

## Debugging failures

After a run, evidence lives in `.verify/runs/<run_id>/`:

```bash
# Browse raw evidence for a specific AC
ls .verify/runs/*/evidence/<ac_id>/
```

Each AC's evidence directory contains:
- `result.json` — verdict, confidence, reasoning, steps taken
- `*.png` — screenshots captured during execution

## How it works

`/verify` runs as a Claude Code skill using Playwright MCP for browser interaction. Three stages:

1. **Spec interpretation** — reads your ticket, extracts concrete acceptance criteria, asks clarifying questions when something is ambiguous
2. **Browser verification** — drives the app via Playwright MCP, checks each AC, captures screenshots / video / trace
3. **Report** — writes per-AC `result.json` and a combined `verdicts.json` to `.verify/runs/<run_id>/`

## Why this exists

Built this because I kept shipping PRs that passed my eyeball check but failed the PM's check. Verify is the sanity pass I always did manually, automated against a real browser — not a mock, not a unit test, the actual app.

## Recently shipped

See [CHANGELOG.md](./CHANGELOG.md) for the full release history.

**Latest (v1.1.0 — 2026-04-23):**
- Per-AC video + trace evidence on non-pass verdicts
- Inline `/verify-setup` skill (no CLI binary)
- Playwright MCP-based `/verify` (one-command install)

## FAQ

**How is this different from Playwright alone?**
Playwright is a browser library — you still write tests, run them, maintain them. Verify takes a PM ticket and executes intent-level checks via Claude + Playwright. No test code to write, no selectors to maintain, no CI to wire up.

**What about auth?**
`/verify-setup` initializes Playwright with `--storage-state .verify/auth.json --isolated`. On first `/verify` run, the skill walks you through logging in once and re-uses the session for every subsequent run.

**What about flaky selectors?**
The browser agent does intent-based navigation (clicks "the submit button"), not brittle CSS selectors. If something does break, `.verify/runs/<run_id>/evidence/<ac_id>/` has the video + trace so you can see exactly what happened.

## Dev setup

See [CLAUDE.md](./CLAUDE.md) for dev commands, conventions, and test instructions.
