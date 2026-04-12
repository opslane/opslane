# TODOS

Deferred work captured from plan reviews. Each item includes enough context to pick up in 3 months.

---

## ~~P2 — Demo PR auto-close~~ SUPERSEDED

> Server being removed in a separate branch. No server-side PR handling.

---

## ~~P2 — /config command for ongoing config edits~~ SUPERSEDED

> Server being removed in a separate branch. Config is now `.verify/config.json` written by the inline `/verify-setup` skill.

---

## ~~P3 — org_id-based ownership check on POST /auth/installed~~ SUPERSEDED

> Server being removed in a separate branch.

---

## ~~P3 — Rate limiting on /auth/status and POST /auth/installed~~ SUPERSEDED

> Server being removed in a separate branch.

---

## P2 — Auto-extract seed credentials during /verify-setup

**What:** During `/verify-setup`, scan seed files for email/password pairs and store them in `app.json` as `seed_accounts`. `/verify` could then offer these as defaults instead of asking the user.

**Why:** Currently users manually provide credentials during `/verify`. Most apps with seed data already have test accounts defined in their seed files (e.g., `prisma.user.create({ data: { email: 'admin@example.com', password: 'test123' } })`). Auto-extraction would make setup nearly zero-input.

**Context:** The `/verify-setup` skill already reads project files to index routes and selectors. Adding a step to scan seed files (e.g., `prisma/seed.ts`, `db/seeds/`) for email+password pairs near `user.create`/`user.upsert` calls follows the same pattern. Store as `app.json.seed_accounts: Array<{email: string, password: string, role?: string}>`.

**Depends on:** Login recipe auth plan (docs/plans/2026-03-20-login-recipe-auth.md) must ship first.

**Effort:** S human → XS with CC+gstack

---

## ~~P2 — Multi-ORM Setup Writer support~~ SUPERSEDED

> Removed: v1 removes setup-writer entirely. If setup-writer is re-added in v2, this TODO becomes relevant again.

---

## P2 — Create eval cases for /verify skill output

**What:** Create eval cases that test the `/verify` skill output (`verdicts.json`) against known-good verdicts on eval repos. 2-3 golden input/output pairs.

**Why:** Eval coverage is needed to catch prompt regressions. The spikes will produce initial eval data, but structured eval cases should be formalized.

**Context:** Eval cases test end-to-end: given a known spec + known app state → expected verdicts (pass/fail/blocked matches human judgment). Use spike results from Documenso as the first eval cases. Build fresh with vitest — no pipeline dependency.

**Depends on:** v1 skill shipping first + spike results.

**Effort:** S human → XS with CC+gstack

---

## ~~P3 — Multi-condition entity graph merging~~ SUPERSEDED

> Removed: v1 removes setup-writer and graph-setup entirely. If setup-writer is re-added in v2, this TODO becomes relevant again.

---

## ~~P2 — Optional Judge stage for executor accuracy~~ SUPERSEDED

> Pipeline stages removed. If judge stage is needed, it would be a separate skill or inline step in `/verify`, not a pipeline stage.

---

## ~~P3 — CI mode with GitHub comment reporting~~ SUPERSEDED

> Both CLI and server being removed. CI mode would need to be rethought as a skill or GitHub Action.

---

## ~~P1 — Automated npm publish workflow (GH Actions)~~ SUPERSEDED

> No npm package. `/verify-setup` runs inline as a Claude Code skill.

---

## ~~P1 — Publish smoke test in CI~~ SUPERSEDED

> No npm package to publish or smoke test.

---

## ~~P2 — Credential redaction in prompt logs~~ SUPERSEDED

> No prompt logs written with inline skill. Credentials never touch disk in the skill-only architecture.
