# Session narratives: LLM detection replaces the mechanical friction funnel

**Date:** 2026-08-31 (rev 5 — one-pipeline restructure after grilling + three validation spikes; earlier revs hardened by three codex review rounds)
**Status:** Draft, validated end-to-end on production data
**Scope:** worker (narrative detection, frames verification), ingestion (storage, API, MCP, digest), dashboard, SDK unchanged

## The decision

Friction detection is **one pipeline**, and this design replaces its top of funnel. The mechanical detectors (`dead_click`, `rage_click`) and the adjudication veto stage **retire**. In their place, an LLM narrates every active session from a rich timeline, emits categorized friction observations anchored to elements and routes, and those observations flow into the **existing** machinery: fingerprinted signals → buckets → promotion → incidents → investigation → fix PRs → digest. Nothing downstream is rebuilt; the understanding layer is swapped.

Everything ships as one build. There are **no feature switches**: the pipeline runs wherever a model API key is configured (explicit product decision, 2026-08-31 grilling — single-operator posture accepted; OSS operators who upgrade with a key configured start incurring narrative model spend, called out in release notes).

## Why (validated, not argued)

Three spikes on real AMFJ production data:

1. **Narrative quality (10 sessions):** timeline+DOM narratives produced verified, non-hallucinated findings the detectors are structurally blind to — an expired-license wall behind "dead clicks on project-page", `cursor:auto` elements that never qualify as dead clicks, a 24s typeahead with no loading state.
2. **Frames (5 sessions):** a vision pass over replayer screenshots at cited moments **corrected** confident text-only claims in 2 of 5 sessions. Frames verify; they don't just add.
3. **End-to-end 24h dry run (22 sessions):** the full new pipeline — narratives → fingerprints → promotion gate → digest — produced 5 promoted, plainly actionable cards. The top card (a phantom "fill required fields" error firing alongside every successful save, 11/22 sessions) is a bug the mechanical detector **has never reported** because it isn't a click. Conversely, the mechanical detector's largest standing bucket (171 sessions of "dead clicks" on the react-select dropdown indicator) was **refuted**: narratives that watched those sessions found the dropdowns working — consistent with the 93.9% adjudication rejection rate. Retiring the detectors deletes the biggest false positive in the product.

Costs (Sonnet, measured): ~$0.10/session narrative, ~$0.09 frames verification on struggle-bearing sessions, ~$0.05/day digest copy. AMFJ scale (~260–370 active sessions/day): roughly $700–900/month all-in. Engine decision: **claude-sonnet-5 for everything** (narrative, vision, digest); the client is Anthropic-SDK-with-base-URL so open-source engines (GLM-5.3 measured quality-competitive at ~1/3 cost, Flash untested) are an env change later.

## Pipeline

```
rrweb chunks (R2/MinIO, scrubbed)
   │ readChunksBounded (existing sole read path)
   ▼
evidence renderer ──► line-numbered timeline + line→{selector,route,ts} map
   ▼
session_narrate job ──► LLM ──► observations (category, cited lines, severity)
   │                                │ struggles present?
   │                                ▼
   │                   session_verify_frames job ──► frames (R2) + vision re-grade
   ▼
observation → friction_signal rows (new signal source, generalized fingerprint)
   ▼
EXISTING: buckets → promotion → incident → investigation → fix PR
   ▼                                          ▼
digest "Session intelligence" cards      dashboard + MCP (opslane_issue,
(replaces friction cards; format below)   opslane_session_frames)
```

## Admission and idempotency

Unchanged from rev 3 (codex-hardened): `activity_class='active'` sessions only (implies complete coverage; ~3% of volume; anonymous included; `light_touch` excluded), reservation-row idempotency (`session_narratives.status='pending'` inserted in the facts transaction — `replaceSessionFacts`/`upsertSessionAnalysis` gain an optional client param — job execution gated on claiming the pending row), daily cap `NARRATIVE_DAILY_CAP=2000/project` (a runaway-spend circuit breaker, not a sampling budget — AMFJ peaks near 400 active sessions/day, so normal traffic never trips it; decision 2026-08-31) counting distinct sessions via `narrative_call_budget` reservations, monthly spend brake (approximate, both stages), lease-fenced terminal writes, tolerant-then-strict output validation, prompt-injection data fencing. Job types `session_narrate` and `session_verify_frames` join `JobType`/claim-allowlist/dispatcher with their own concurrency lanes (`NARRATIVE_MAX_CONCURRENT=2`, `FRAMES_MAX_CONCURRENT=1`).

## The narrative prompt (v2 shape, spike-validated)

Line-numbered timeline in, JSON out. Friction observations only — "working well" reporting is cut from v1 (decision 2026-08-31: the product focus is bugs and friction; the digest headline may still characterize overall activity from counts, not from model-written praise):

```json
{
  "user_goal": "...",
  "narrative": "2-4 sentences",
  "observations": [
    {"category": "<closed enum>", "what": "one sentence",
     "evidence_lines": ["L57","L60"], "severity": "low|medium|high"}
  ],
  "notable": true
}
```

Closed category enum (definitions live in the prompt): `unclickable_affordance`, `no_feedback_after_action`, `dead_end_state`, `validation_confusion`, `slow_response`, `repetitive_workflow`, `discoverability_gap`, `hard_blocker`, `other`. `other` is stored and appears in the digest's below-threshold line but never promotes; recurring `other` clusters tell us which category to add next. Citation validation is exact line-id membership (24h spike: 0 invalid citations in 60 observations).

## The fingerprint (spike-validated)

```
fingerprint = sha256( category | anchor | normalizePageUrl(route) )
```

- **The model never writes the anchor.** Anchors are extracted deterministically from the cited lines' metadata (the renderer's line map): the model cites `L57`, the map says which selector and route that line carries. Only `category` is model-authored, and it's a closed enum — spike showed strong consistency (every session that saw the phantom-validation bug called it `validation_confusion`).
- **Per-category anchor policy** (added after the fingerprint spike showed avoidable splits): element-anchored categories — `unclickable_affordance`, `no_feedback_after_action`, `discoverability_gap` — use `canonicalizeSelector(cited selector)`; all others anchor on route alone. This keeps element-specific problems element-deduped while page-level problems (validation races, dead ends, slowness, repetition) don't split on which button the model happened to cite.
- Reuses the existing `canonicalizeSelector` and `normalizePageUrl` unchanged; the bucket tuple keeps its shape with `prompt_version` in the `rule_version` position.
- Known, accepted split: the route axis divides one product defect across embed surfaces (project-page vs global-page vs `/assets/...`) — exact parity with today's cards.

24h dry run: 60 observations → 49 buckets; the real multi-session defects collided correctly (11-session validation bug, 11-session bulk-actions theme, 4-session dead-end search).

## Promotion

Gate: **≥3 distinct sessions OR ≥2 identified users** in the rolling 7-day window. **Every promoted incident is investigated** (decision 2026-09-01, superseding the high-severity-only gate): diagnosis costs ~$2/issue at ~12 issues/day decaying with the backlog. The investigation's verdict then gates the fix pipeline — a **deterministic code cause** (the classify verdict cites concrete files and a mechanism) proceeds to the automated fix PR; a verdict needing human or product judgment terminates as an actionable diagnosis ("needs review — diagnosed", root cause attached) with **no** auto-fix; fixes for those are triggered on demand. The digest needs no special lane: investigated incidents enter the existing actionable freeze with their diagnosis (replaces 5-identified-users, which structurally excluded the 94% anonymous traffic). Same bucket/evidence-window machinery; re-adjudication growth logic retires with adjudication itself — narrative + frames verification *is* the judgment, so promotion is purely a counting gate. Observation rows write into `friction_signals` as a new generation (mechanical signal production stops; existing mechanical rows and open incidents remain as legacy until they resolve or age out — no destructive migration).

Two consequences of routing product-judgment diagnoses to `awaiting_approval` (decision 2026-09-01) are accepted deliberately:

- **"Generate fix" is offered on a non-code-cause diagnosis.** That is the fix-on-demand path, not a leak: a human reads the diagnosis and chooses. The autonomy ladder still refuses to start one automatically.
- **Product-judgment diagnoses recur in the digest until they are resolved or snoozed.** The terminal-FYI `insight` status was a one-time notice; an actionable diagnosis keeps asking. Acknowledging one uses the existing resolve/snooze machinery on actionable incidents — no new transition. The `insight` status itself is unchanged and legacy rows keep their meaning.

## Frames verification

As rev 4 (codex-hardened), minus the flag: durable `verification_state` machine on `session_narratives`, same-transaction enqueue, sweeper for stuck rows, version-fenced writes, before/after frame pairs (max 3 moments) because stills can't prove causality, network-egress-disabled Chromium (SSRF; historical fidelity) served a loopback harness, frames under `sessions/<project>/<session>/frames/v<prompt_version>/`, base64 images to the vision call, grades `confirmed|corrected|refuted|inconclusive` with mandatory replacement text on `corrected`. Mechanical enforcement downstream: `refuted` observations are excluded from signal emission (they never become friction_signals); `corrected` replacement text is what the signal carries. Worker gains `playwright-core` + pinned rrweb + Chromium in the image — stated dependency change.

## Digest

The digest's friction section **is** the new pipeline's output — the "Session intelligence" format validated in the 24h dry run replaces the old friction cards; error cards and the friction **fix-PR approval cards** ("a fix is written, needs your approval") are untouched (confirmed 2026-08-31 — the approval card is the only Slack surface where a finished fix reaches the operator). The existing `investigate-friction` prompt needs a revision for narrative-born incidents (it was written for dead-click incidents; listed as implementation work). Card format:

```
*<Plain-language title naming the problem, not the category>*
<route> · N sessions (M identified) · severity
<2-3 sentences from the observations: what users hit, why, fix direction>
_Agent context: opslane_issue <incident id>_
```

Plus a headline paragraph and a below-threshold one-liner (max 4 items). The digest writer receives promoted buckets with their observations as prewritten structured input inside the existing digest-writer job (retry-idempotent: keyed by digest run, selection persisted before the model call — rev 3 mechanics). Counts must match input exactly; the writer never invents. The rev 3 `session_insights` table is dropped from the design — promoted incidents are the durable unit, and the digest payload gains the card fields (append-only payload evolution across the TS schema, Go validation, and renderer).

## Agent context (MCP)

The digest card's `opslane_issue <id>` is the handle a coding agent pulls:

- `opslane_issue` — as today, now carrying the observation text, category, anchor selector, route, session/identified counts.
- `opslane_session_timeline` — extended for narrative-backed incidents: cited timeline lines (real excerpts with selectors and UI text) instead of the current "friction issues carry no evidence" stub.
- `opslane_session_frames` — rev 4 as designed (presigned GET — new `PresignedGetObject` on the MinIO wrapper, `MCP_FRAME_URL_TTL=15m`, keys reconstructed and prefix-validated, never signed from stored jsonb; construction-time 8KB budgeting; `<untrusted>` fencing; audit log per issuance; graceful no-frames response). The 24h spike's payload measured 4.4KB with 5 frames. No gate flag (zero-switches decision); the audit log stays.

Cross-tenant reads: a request for another organization's session is refused at the org-membership layer with **403** (repo convention, verified in run 20260901-020035); an in-org request naming the wrong project returns **404**. Neither response leaks session data, and the same rule holds for the dashboard narrative endpoint.

Spike-proven agent flow: digest card → `opslane_issue` → timeline lines L57–L60 showing `FORM SUBMIT` → `UI TEXT APPEARED: "Fill in the required fields…"` 0.6s later → frames at those moments → the agent lands on the validator/toast race with the component (`atlas-button-group-wrapper` form) already named.

## Storage

`session_narratives` as rev 4 (status machine, verification columns, CHECKs, cascades, bounded `raw_response`) with `narrative` jsonb holding the v2 observation shape and per-observation stable ids. `friction_signals` gains the narrative generation's rows (category in the `signal_type` position — widen the CHECK constraint by migration; existing values remain valid). `narrative_call_budget` for both stages. No `session_insights`.

## Testing

Rev 3/4 test matrix carries over (renderer degradation, validation, queue contracts, fences, sweeper, MCP budgeting, presign scoping), plus: fingerprint unit tests pinning the anchor policy per category against fixture narratives; promotion gate tests for the 3-session/2-identified thresholds with anonymous mixes; signal-emission tests (refuted excluded, corrected text substituted); digest payload evolution tests (old payloads still valid); e2e — fixture session in, narrative → signal → bucket → promoted incident → digest card out, stubbed model. Live smoke per AGENTS.md before completion claims.

## Rollout

One deploy: migration + worker image (Chromium) + ingestion + dashboard. Old detectors stop emitting on deploy; legacy incidents keep their state — written fixes remain approvable — and drain naturally as their evidence windows expire (confirmed 2026-08-31). The dashboard shows mixed old/new-style issues for a week or two; accepted. Release notes state the new model spend for OSS operators with keys configured. Post-deploy watch: promotion counts, category distribution (especially `other`), verification correction rate, spend counters, digest card quality against the 24h dry-run baseline.

Ops step, not code: automatic fix PRs for deterministic code causes require `projects.friction_autonomy = 'auto_fix'` on the project. The default is `ask_first`, which parks even a code-cause verdict on `awaiting_approval` for approval; the decision ledger records both the same way. Set it for AMFJ when the fix loop is wanted end to end.

Migration 069 returns incidents the retired severity gate parked as `awaiting_approval` *without* an investigation to the queue with one investigation job each. Expect a one-off investigation burst sized to that backlog on the first boot after deploy.

## Alternatives considered

- **Parallel narrative layer beside the detectors** (revs 1–4): rejected during grilling — two systems describing the same friction, with the weaker one owning the fix loop. The fingerprint spike removed the reason to keep the split.
- **Keep mechanical detectors as a second signal source:** rejected; the flagship mechanical bucket was refuted by narratives watching the same sessions, and dual sources double-report every real issue.
- **LLM-authored fingerprint keys / embedding clustering:** rejected for a deterministic anchor from cited lines — the spike showed the closed enum + line-map extraction gets collision behavior at parity with today without new infrastructure.
- **Feature flags / staged enablement:** rejected by explicit product decision (single-operator posture); the codex-flagged OSS auto-spend consequence is accepted and documented instead of gated.
- Earlier alternatives (vision-first, frame URLs as image blocks, standalone synthesis job, new queue) as rev 4.
