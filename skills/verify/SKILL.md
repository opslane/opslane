---
name: verify
description: Verify frontend changes against spec acceptance criteria. Uses Playwright MCP for browser interaction.
---

# /verify

Verify your frontend changes before pushing.

## Prerequisites
- Dev server running (e.g. `npm run dev`)
- Playwright MCP configured in Claude Code (see install section below)
- Auth set up if app requires login (`/verify-setup`)

## Playwright MCP Install

If Playwright MCP is not available, show this:

> /verify requires Playwright MCP for browser interaction.
>
> **Install:**
> ```
> claude mcp add playwright -- npx @playwright/mcp@next --storage-state .verify/auth.json --isolated --caps=devtools --output-dir .verify/mcp-output
> ```
>
> `@next` is required — video + trace tools ship only in the alpha. `--caps=devtools` exposes them; `--output-dir` pins a known drop zone.
> Restart Claude Code, then re-run `/verify`.

## Conversation Flow

This skill is turn-based. Each turn has a trigger and a bounded set of actions. **Never skip ahead.**

---

## Turn 1: Spec Intake

**Trigger:** User invokes `/verify`.

**Check for arguments first.** If the user passed a file path as an argument (e.g. `/verify path/to/spec.md`), skip this turn entirely — go straight to Turn 2 using that path.

**Otherwise**, try smart spec discovery first:

```bash
find . -maxdepth 3 -name "*.md" \( -name "*spec*" -o -name "*plan*" -o -name "*requirements*" -o -name "*acceptance*" \) -not -path "./.verify/*" -not -path "./node_modules/*" -not -path "./.git/*" 2>/dev/null | head -5
```

- If **exactly 1 file** found: suggest it. "Found a likely spec: `path/to/spec.md`. Use this? (y/n)"
- If **multiple files** found: show the list and ask the user to pick one.
- If **no files** found: "What spec are you verifying? Paste the spec content or give a file path."

Do not call any other tools. End your response and wait.

---

## Turn 2: Pre-flight + MCP Check

**Trigger:** User has provided a spec (pasted content, file path, or confirmed a discovered file).

1. If they gave a **file path** — read the file with the Read tool.
2. If they **pasted content** — `mkdir -p .verify` then write to `.verify/spec.md`.

**MCP preflight:** Check if Playwright MCP is available:

```
Use ListMcpResourcesTool with server="playwright"
```

- If the server exists → Playwright MCP is available, proceed.
- If "Server not found" → show the install instructions from the Prerequisites section. Stop.
- If MCP is configured but non-responsive (e.g. connection error), show: "Playwright MCP is configured but not responding. Try restarting Claude Code."

**Dev server check:**

```bash
BASE_URL=$(cat .verify/config.json 2>/dev/null | grep -o '"baseUrl"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -o 'http[^"]*' || echo "http://localhost:3000")
curl -sf "$BASE_URL" > /dev/null 2>&1 || { echo "Dev server not running at $BASE_URL"; exit 1; }
```

**Auth check:** Navigate to the app and check if you're logged in:

```
Use mcp__playwright__browser_navigate to go to $BASE_URL
Use mcp__playwright__browser_snapshot to read the page
```

If the page shows a login/signup form instead of authenticated content, try these sources in order:

**1. Credentials file referenced from `.verify/config.json`.** Check for a `credentials` field:

```bash
python3 -c "import json; c=json.load(open('.verify/config.json')); print(c.get('credentials',''))" 2>/dev/null
```

If the printed path is non-empty AND starts with `.verify/` (the skill's allowed file zone — reject anything outside), use the **Read tool** to read the file directly. Parse the email and password in-head — never echo them to the shell or print them to stdout.

Supported formats:
- **key=value** (one per line):
  ```
  email=user@example.com
  password=secret
  ```
- **JSON**: `{"email": "user@example.com", "password": "secret"}`

Then log in via Playwright:
- `mcp__playwright__browser_type` into the email textbox (use the `ref` from the snapshot) — pass the email as the `text` argument
- `mcp__playwright__browser_type` into the password textbox — pass the password as the `text` argument
- `mcp__playwright__browser_click` on the submit button (usually labeled "Sign In", "Log in", or equivalent)
- `mcp__playwright__browser_snapshot` — confirm the page URL no longer matches `/signin`/`/login`/`/auth`

Tell the user briefly: "Logged in using credentials from `{CREDS_FILE}`." Never include the email or password in any output, result.json, or report.

**2. User-provided credentials in chat.** If no `credentials` field is set (or the file is missing / unreadable), fall back to asking:

> "You're not logged in. Either add a `credentials` field to `.verify/config.json` pointing at a file under `.verify/`, or paste an email/password here and I'll log in via the browser."

If the user pastes creds, use the same Playwright type+click sequence to log in, then snapshot to confirm.

**3. Neither worked.** Write verdict `auth_expired` for each AC and stop — tell the user to set up credentials and retry.

Proceed to Turn 3.

---

## Turn 3: Spec Interpreter

**Trigger:** Pre-flight passed.

Review the spec inline. For each AC, check:

1. **Reveal action** — does it say "shown/displayed/visible" without saying how? → flag
2. **Preconditions** — requires specific data to exist? → flag
3. **Target** — UI element identifiable by label or text? If too vague → flag
4. **Success** — clear pass/fail? If not → flag

If **no ambiguities**: skip Turn 4, go directly to Turn 5.
If **ambiguities found**: ask the first flagged question. End response and wait.

---

## Turn 4: Clarification Loop

**Trigger:** User answered a clarifying question.

Keep a running list of AC annotations, e.g.:
- AC3: expiry date revealed via hover on Pending badge
- AC1: expiration field is inline in the send dialog

Note the answer and add it to the list. If more ambiguities remain — ask the next one and wait.

When all answered — proceed to Turn 5.

---

## Turn 5: Extract ACs + Verify with Playwright MCP

**Trigger:** All ambiguities resolved (or there were none).

This turn has three phases: AC extraction, verification, and reporting.

### Phase 1: Extract Acceptance Criteria

Read the spec content and any clarifications. Also read context files if they exist:

- `.verify/app.json` — known routes, use for specific navigation paths in AC descriptions
- `.verify/seed-data.txt` — actual database records, use for specific data references (limit: first 8000 chars)
- `.verify/learnings.md` — corrections from past verification runs

Extract testable ACs. Each AC must be concrete enough for browser verification:

**AC quality standard — this is critical:**
- BAD: "The settings form shows an expiration field"
- GOOD: "The team document settings page (/t/{teamUrl}/settings/document) shows a 'Default Envelope Expiration' combobox with options 'Never expires' and 'Custom duration'"

USE THE SEED DATA. If the spec says "a document with expiration set" and seed data shows a recipient "recipient-expiry@test.documenso.com", reference those exact values.

USE THE ROUTES. If app routes show `/t/personal_xyz/settings/document`, reference that navigation path.

**Extraction rules:**
- Each AC: one specific testable behavior
- Skip ACs requiring external services (Stripe, email, OAuth)
- Pure UI ACs with multiple checks on the same page should be split into individual ACs (one behavior each)
- NEVER use template variables like {envId}, {orgId} — resolve to actual values from routes or seed data

Present the AC list to the user: "I've extracted N acceptance criteria. Here's the plan: [list ACs]. Starting verification now."

### Phase 2: Verify Each AC with Playwright MCP

Set up the evidence directory:

```bash
RUN_ID=$(date +%Y%m%d-%H%M%S)
mkdir -p .verify/runs/$RUN_ID/evidence
mkdir -p .verify/mcp-output/traces
# Purge stale artifacts from prior crashed runs so this run's recordings don't collide
rm -f .verify/mcp-output/*.webm 2>/dev/null || true
rm -f .verify/mcp-output/traces/trace-*.trace .verify/mcp-output/traces/trace-*.network .verify/mcp-output/traces/trace-*.stacks 2>/dev/null || true
```

For EACH acceptance criterion, follow this sequence:

1. **Navigate** to the right page using `mcp__playwright__browser_navigate`.
   - Use known routes from `.verify/app.json` for direct URLs.
   - REUSE navigation context from previous ACs — the browser session persists.

1a. **Start recording evidence — ALWAYS, immediately after navigate, before any snapshot.** This is mandatory. Even if you suspect the AC will be blocked, start recording first — the recording itself is evidence. First clear any stale loose trace files so the post-hoc zip picks up exactly this AC's run:
   ```bash
   rm -f .verify/mcp-output/traces/trace-*.trace .verify/mcp-output/traces/trace-*.network .verify/mcp-output/traces/trace-*.stacks 2>/dev/null || true
   ```
   Then:
   - `mcp__playwright__browser_start_tracing` (takes NO args — writes loose `.verify/mcp-output/traces/trace-<timestamp>.{trace,network,stacks}` + `resources/`)
   - `mcp__playwright__browser_start_video` with `filename: ".verify/mcp-output/${RUN_ID}-{ac_id}.webm"` (CWD-relative path — the file lands exactly where you point it)

2. **Check preconditions** — use `mcp__playwright__browser_snapshot` to read the page.
   - If required data is not visible after the first snapshot → verdict `blocked`. Do NOT jump to the next AC — skip to step 4a (stop recording) so evidence flushes, then step 7 (write result).

3. **Interact** as needed:
   - `mcp__playwright__browser_click` — click elements (use `ref` from snapshot)
   - `mcp__playwright__browser_type` — type into inputs
   - `mcp__playwright__browser_hover` — hover for tooltips
   - `mcp__playwright__browser_press_key` — keyboard actions
   - `mcp__playwright__browser_wait_for` — wait for animations/loads

4. **Collect evidence** — take a screenshot after verification:
   - `mcp__playwright__browser_take_screenshot`
   - The screenshot is returned inline in the tool result. Note the screenshot filename in your result.json.

4a. **Stop recording evidence — ALWAYS, before writing result.json.** This is mandatory on every AC regardless of verdict (pass, fail, blocked, error, timeout, auth_expired — all of them). Without stop, the video/trace never flushes to disk and you lose the evidence.
   - `mcp__playwright__browser_stop_video` (takes NO args — uses the filename given at start)
   - `mcp__playwright__browser_stop_tracing` (takes NO args — flushes loose files to `.verify/mcp-output/traces/`)
   - Step 7 decides keep (non-pass) or drop (pass).

5. **Check for auth redirect** — if the page URL path contains `/login`, `/signin`, `/signup`, `/auth/` (as a standalone segment, not a prefix like `/authorize`), or `/forgot-password`, AND the AC does not intentionally target an auth page:
   - Write verdict `auth_expired` with observed: "Auth redirect — session may have expired"

6. **Judge the result** — based on what you observed, determine:
   - `verdict`: one of `pass`, `fail`, `blocked`, `unclear`, `error`, `timeout`, `skipped`, `auth_expired`, `spec_unclear`
   - `confidence`: `high`, `medium`, or `low`
   - `reasoning`: what you saw and why you reached this verdict

   Verdict meanings:
   - `pass` — AC verified successfully
   - `fail` — AC clearly not met
   - `blocked` — precondition missing, cannot test
   - `unclear` — partial evidence, cannot determine
   - `error` — Playwright command failed unexpectedly
   - `timeout` — page or element didn't load in time
   - `skipped` — AC skipped (depends on failed prior AC)
   - `auth_expired` — redirected to login page unexpectedly
   - `spec_unclear` — AC description too vague to verify

7. **Write the result** — create the evidence dir and handle recorded artifacts based on verdict.

   ```bash
   mkdir -p .verify/runs/$RUN_ID/evidence/{ac_id}
   ```

   All artifact handling is **tolerant** — missing files are not fatal. Each shell step uses `2>/dev/null || true`.

   - If `verdict == "pass"`: delete this AC's recordings. Set `video: null` and `trace: null` in result.json.
     ```bash
     rm -f .verify/mcp-output/${RUN_ID}-{ac_id}.webm 2>/dev/null || true
     rm -f .verify/mcp-output/traces/trace-*.trace .verify/mcp-output/traces/trace-*.network .verify/mcp-output/traces/trace-*.stacks 2>/dev/null || true
     ```

   - Otherwise (any non-pass verdict): move the video and pack a trace zip. The MCP writes **loose files** named `trace-<timestamp>.{trace,network,stacks}`; `playwright show-trace` only loads a zip whose internal files are named `trace.*`, so we rename while zipping.
     ```bash
     # Video: simple move
     mv .verify/mcp-output/${RUN_ID}-{ac_id}.webm .verify/runs/$RUN_ID/evidence/{ac_id}/ 2>/dev/null || true

     # Trace: rename loose files to trace.* and zip with resources/
     TRACE_TRACE=$(ls -t .verify/mcp-output/traces/trace-*.trace 2>/dev/null | head -1)
     if [ -n "$TRACE_TRACE" ]; then
       TRACE_BASE=${TRACE_TRACE%.trace}
       TMPDIR=$(mktemp -d)
       cp "$TRACE_TRACE" "$TMPDIR/trace.trace"
       cp "${TRACE_BASE}.network" "$TMPDIR/trace.network" 2>/dev/null || true
       cp "${TRACE_BASE}.stacks"  "$TMPDIR/trace.stacks"  2>/dev/null || true
       cp -r .verify/mcp-output/traces/resources "$TMPDIR/" 2>/dev/null || true
       ZIP_DEST="$PWD/.verify/runs/$RUN_ID/evidence/{ac_id}/trace.zip"
       (cd "$TMPDIR" && zip -qr "$ZIP_DEST" .)
       rm -f "$TRACE_BASE".trace "$TRACE_BASE".network "$TRACE_BASE".stacks 2>/dev/null || true
     fi
     ```
     In result.json: set `video` to `"${RUN_ID}-{ac_id}.webm"` iff that file now exists in the evidence dir, else `null`. Set `trace` to `"trace.zip"` iff that file now exists in the evidence dir, else `null`.

   Then use the Write tool to create `.verify/runs/$RUN_ID/evidence/{ac_id}/result.json`:

   ```json
   {
     "ac_id": "{ac_id}",
     "verdict": "pass",
     "confidence": "high",
     "reasoning": "What you observed and why",
     "observed": "Exact text/state on the page",
     "steps_taken": ["navigate to /settings", "snapshot", "click @ref"],
     "screenshots": ["screenshot-filename.png"],
     "video": null,
     "trace": null,
     "blocker": null
   }
   ```

8. **Move to next AC.** Do NOT close or reset the browser between ACs.

### Phase 3: Report Results

After all ACs are verified:

1. Read each `result.json` from the evidence subdirectories and show inline summary:

   For each AC:
   - `pass` → `✓ ac1: pass`
   - anything else → verdict line, then a `replay:` line for the trace zip and a `video:` line for the webm, printed only for artifacts that are non-null in result.json:
     ```
     ✗ ac3: fail — Envelope expiration combobox not rendered on team settings page
         replay: npx playwright show-trace .verify/runs/{RUN_ID}/evidence/ac3/trace.zip
         video:  .verify/runs/{RUN_ID}/evidence/ac3/{RUN_ID}-ac3.webm
     ```
     Skip the line for any artifact whose field is `null` (e.g., if `stop_video` failed and only the trace was retained).

2. Write combined `verdicts.json` using the Write tool to `.verify/runs/$RUN_ID/verdicts.json`. Include `target_url` (from `.verify/config.json`) and `spec` (the spec path or `inline`) so the report has context:

   ```json
   {
     "run_id": "{RUN_ID}",
     "target_url": "https://...",
     "spec": "docs/spec.md",
     "verdicts": [
       {"ac_id": "ac1", "verdict": "pass", "confidence": "high", "reasoning": "..."},
       {"ac_id": "ac2", "verdict": "fail", "confidence": "high", "reasoning": "..."}
     ],
     "summary": {"total": 2, "pass": 1, "fail": 1}
   }
   ```

3. **Collect screenshots into the run dir.** Playwright MCP writes screenshots into the current working directory, not into `.verify/runs/$RUN_ID/`. Move them in so the report can reference them:

   ```bash
   for png in $(cat .verify/runs/$RUN_ID/evidence/*/result.json 2>/dev/null | grep -o '"[^"]*\.png"' | tr -d '"' | sort -u); do
     [ -f "$png" ] && mv "$png" ".verify/runs/$RUN_ID/evidence/$png"
   done
   ```

4. **Generate `report.html`** — single-file HTML report that embeds verdict cards, reasoning, steps, and screenshots. Run this Python script via Bash (pass `RUN_ID` via env so the quoted heredoc stays safe):

   ```bash
   RUN_ID=$RUN_ID python3 - <<'PYEOF'
   import json, os, html
   from pathlib import Path

   def e(v):
       return html.escape("" if v is None else str(v))

   run_dir = Path(f".verify/runs/{os.environ['RUN_ID']}")
   verdicts = json.loads((run_dir / "verdicts.json").read_text())

   badge_color = {"pass": "#16a34a", "fail": "#dc2626", "blocked": "#f59e0b",
                  "unclear": "#6b7280", "error": "#dc2626", "timeout": "#dc2626",
                  "skipped": "#6b7280", "auth_expired": "#dc2626",
                  "spec_unclear": "#f59e0b"}

   cards = []
   for v in verdicts["verdicts"]:
       ac_id = v["ac_id"]
       result_path = run_dir / "evidence" / ac_id / "result.json"
       if not result_path.exists():
           continue
       result = json.loads(result_path.read_text())
       color = badge_color.get(result["verdict"], "#6b7280")
       shots = "".join(
           f'<div class="shot"><img src="evidence/{e(s)}" alt="{e(s)}"/></div>'
           for s in (result.get("screenshots") or [])
       )
       steps = "".join(f"<li>{e(s)}</li>" for s in (result.get("steps_taken") or []))
       video = result.get("video")
       video_html = (
           f'<div class="video"><video controls preload="metadata" src="evidence/{e(ac_id)}/{e(video)}"></video></div>'
           if video else ""
       )
       trace = result.get("trace")
       trace_html = (
           f'<div class="trace"><code>npx playwright show-trace .verify/runs/{e(os.environ["RUN_ID"])}/evidence/{e(ac_id)}/{e(trace)}</code></div>'
           if trace else ""
       )
       cards.append(f'''
       <section class="ac">
         <header>
           <span class="badge" style="background:{color}">{e(result["verdict"]).upper()}</span>
           <h2>{e(ac_id)}</h2>
           <span class="conf">confidence: {e(result.get("confidence","—"))}</span>
         </header>
         <p class="reasoning">{e(result.get("reasoning",""))}</p>
         <details><summary>observed</summary><pre>{e(result.get("observed",""))}</pre></details>
         <details><summary>steps ({len(result.get("steps_taken") or [])})</summary><ol>{steps}</ol></details>
         {video_html}
         {trace_html}
         {shots}
       </section>''')

   summary = verdicts.get("summary") or {}
   total = summary.get("total", len(verdicts["verdicts"]))
   passed = summary.get("pass", sum(1 for v in verdicts["verdicts"] if v["verdict"] == "pass"))
   failed = total - passed

   html = f"""<!doctype html>
   <html lang="en">
   <head>
   <meta charset="utf-8">
   <title>Verify report — {e(verdicts["run_id"])}</title>
   <style>
     :root {{ --bg:#fafafa; --card:#fff; --text:#111; --muted:#6b7280; --line:#e5e7eb; }}
     * {{ box-sizing: border-box; }}
     body {{ font-family: -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 32px; }}
     main {{ max-width: 900px; margin: 0 auto; }}
     h1 {{ font-size: 24px; margin: 0 0 8px; }}
     h2 {{ font-size: 16px; margin: 0; font-family: ui-monospace, monospace; }}
     .meta {{ color: var(--muted); font-size: 14px; margin-bottom: 24px; }}
     .meta code {{ background: #eee; padding: 2px 6px; border-radius: 4px; font-size: 13px; }}
     .summary {{ display: flex; gap: 12px; margin-bottom: 32px; }}
     .summary .chip {{ padding: 8px 16px; border-radius: 999px; font-size: 14px; font-weight: 600; }}
     .summary .chip.pass {{ background: #dcfce7; color: #166534; }}
     .summary .chip.fail {{ background: #fee2e2; color: #991b1b; }}
     .summary .chip.total {{ background: #e5e7eb; color: #374151; }}
     .ac {{ background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }}
     .ac header {{ display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }}
     .badge {{ color: #fff; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 700; letter-spacing: 0.5px; }}
     .conf {{ color: var(--muted); font-size: 13px; margin-left: auto; }}
     .reasoning {{ margin: 8px 0 12px; line-height: 1.5; }}
     details {{ margin: 8px 0; font-size: 14px; }}
     summary {{ cursor: pointer; color: var(--muted); }}
     pre {{ background: #f3f4f6; padding: 8px; border-radius: 6px; overflow-x: auto; font-size: 13px; }}
     ol {{ padding-left: 20px; }}
     .shot {{ margin-top: 12px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }}
     .shot img {{ display: block; width: 100%; height: auto; }}
     .video {{ margin-top: 12px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #000; }}
     .video video {{ display: block; width: 100%; height: auto; }}
     .trace {{ margin-top: 12px; padding: 10px 12px; background: #f3f4f6; border-radius: 6px; font-size: 13px; color: var(--muted); }}
     .trace code {{ background: transparent; padding: 0; font-family: ui-monospace, monospace; color: #111; word-break: break-all; }}
   </style>
   </head>
   <body>
   <main>
     <h1>Verify report</h1>
     <div class="meta">
       Run: <code>{e(verdicts["run_id"])}</code> &nbsp;·&nbsp;
       Target: <code>{e(verdicts.get("target_url","(unknown)"))}</code> &nbsp;·&nbsp;
       Spec: <code>{e(verdicts.get("spec","(inline)"))}</code>
     </div>
     <div class="summary">
       <span class="chip pass">✓ {passed} pass</span>
       <span class="chip fail">✗ {failed} fail</span>
       <span class="chip total">{total} total</span>
     </div>
     {"".join(cards)}
   </main>
   </body>
   </html>
   """

   (run_dir / "report.html").write_text(html)
   print(f"wrote {run_dir / 'report.html'}")
   PYEOF
   ```

5. Show pass/fail summary counts and the report path: "Report: `.verify/runs/$RUN_ID/report.html`".

---

## Hard Constraints — DO NOT VIOLATE

These rules are battle-tested from 15+ real verification runs:

1. **BUDGET:** Aim for 12 Playwright commands per AC max. If you've done 10 commands and haven't resolved the AC, write your best verdict and move on.

2. **PRECONDITION CHECK:** After your first snapshot on the target page, if required data is not visible, write `blocked` immediately. Do NOT explore the entire app looking for data.

3. **BAIL EARLY:** If after 3 navigation attempts you haven't found the target page, write `blocked` and move on.

4. **ONE RECOVERY:** If a Playwright command fails, retry once. Then write the result and move on.

5. **NO CODEBASE ACCESS:** Do not use Read, Bash, Glob, Grep, `ls`, `git`, or `rg` to access source code files (.ts, .tsx, .js, .jsx, .py, .rb, etc). You are testing the running app, not the code. The ONLY files you may read/write are under `.verify/` and the user-provided spec file.

6. **NO DATA MUTATION:** Do not submit forms that change app state, create accounts, or modify data. Read-only verification only.

7. **AUTH REDIRECT:** If you land on a login page unexpectedly, write verdict `auth_expired`. Suggest the user re-run `/verify-setup`.

8. **ALWAYS WRITE RESULT:** Before moving to the next AC, you MUST write the result JSON. A partial result is better than no result. **Also always handle recorded artifacts before moving on** — delete on pass, move video + zip trace on non-pass, tolerant of missing files. Orphaned `.webm` or loose `trace-*.*` files in `.verify/mcp-output/` will be purged at the start of the next run, but can collide within a single run if left in place.

9. **RECORDING BOOKENDS ARE MANDATORY:** Every AC must call `browser_start_tracing` + `browser_start_video` (step 1a) right after navigate, and `browser_stop_video` + `browser_stop_tracing` (step 4a) right before writing result.json. Every verdict — including `blocked`, `error`, `timeout`, `auth_expired` — runs the full bookend. Without `stop_*`, Playwright never flushes the files to disk and you lose the evidence.

---

## Error Handling

| Failure | Action |
|---------|--------|
| Dev server not running | Print error, stop |
| Playwright MCP not available | Show install instructions, stop |
| Playwright MCP configured but crashed | "Playwright MCP not responding. Try restarting Claude Code." |
| Auth redirect on all ACs | "Auth cookies expired. Re-run `/verify-setup` to import fresh cookies." |
| Playwright command timeout | Write `timeout` for current AC, continue to next |
| All ACs blocked | "Check dev server and auth. Run `/verify-setup` to reconfigure." |

---

## Quick Reference

```bash
/verify-setup                       # one-time setup (port detection + cookie export + app indexing)
/verify                             # run verification
/verify path/to/spec.md             # run with specific spec
open .verify/runs/*/report.html     # open the HTML report in a browser
cat .verify/runs/*/verdicts.json    # check verdicts as JSON
ls .verify/runs/*/evidence/         # browse evidence (each AC has a subdirectory)
```
