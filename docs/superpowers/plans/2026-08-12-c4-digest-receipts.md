# C4: Digest Receipts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every digest card is a receipt — a fix PR link, a reviewable failed attempt (with or without its diff), or a report-ready investigation — gated exclusively on `digest_readiness` (eligible-only), ranked by `priority_score`, capped at 10, with a triage header line, a held-back footer, quiet days stated rather than silent, and old outbox payloads still rendering via `SchemaVersion` branching.

**Architecture:** The builder (`digest/build.go`) gains a `buildReceiptItems` query over the readiness projection (state-change window = `digest_readiness.updated_at` in the 24h digest window), fills the C0-frozen `ReceiptItems` payload, stamps `SchemaVersion = 2`, and sanitizes excerpts at build time so outbox rows never store full untrusted text. A new neutral `narrative` package owns every copy template (story line, receipt lines, triage line, footers) plus the excerpt sanitizer — `digest` imports `notify`, so templates shared with C5's issue page cannot live in either. The Slack formatter branches on `SchemaVersion >= 2`: cards + triage + footers for v2, the untouched legacy layout for captured v1 payloads. The four open-incident legacy section queries flip from C1's interim `NOT ineligible/pending` predicate to eligible-only (safe because C3's migration 047 gave every open incident a readiness row); `PRsMerged` is deliberately scoped out of the flip.

**Tech Stack:** Go 1.24 (`packages/ingestion`: `digest`, `notify`, new `narrative`; plain `testing`, DB-gated per package convention), Postgres (no new migration — 044 froze every column C4 reads), TypeScript (shared payload mirror, e2e expectations).

**Parent:** `docs/superpowers/plans/2026-08-10-unified-actionable-program-plan.md` §C4. Authority: `docs/design/2026-08-10-unified-actionable-program.md` (decisions 1, 3, and the copy rule). Carried-forward detail: `docs/superpowers/plans/2026-08-10-actionable-receipts-v1.md` Tasks C1/C2 and `docs/design/2026-08-10-actionable-receipts.md` §5d, amended below where the program or the working tree overrides them (see "Deviations from carried-forward text").

## Dependencies on C0–C3 (hard prerequisites; consumed, never edited)

- **C0 / migration 044 + payload freeze:** `DigestPayload.SchemaVersion int` / `ReceiptItems []ReceiptItem` (`notify/event.go:55-56`) and the full `ReceiptItem` field set (`event.go:59-75`: `Kind`, `IncidentID`, `Title`, `OccurrenceCount`, `ImpactClass`, `ImpactVisits`, `ImpactRecovered`, `ReceiptState`, `PRURL`, `SessionURL`, `RootCauseExcerpt`, `MitigationExcerpt`, `HasSavedDiff`, `ClusterIncidentIDs`); the TS mirror (`shared/src/types.ts:20-42`); the byte-stability contract (`notify/receipts_contract_test.go` + `notify/testdata/digest_payload_v1.json` — **this golden is AC4.4's captured v1 payload**); `digest_readiness` DDL (`044:80-90`); `diagnosis_decisions.policy_eligible/policy_basis` and the outcome CHECK admitting `'incomplete'`.
- **C1:** the interim digest predicate at `digest/build.go:108-111` and 4 siblings (the comment at `:107` promises exactly this plan's flip); readiness written by the worker on investigation outcomes (reasons `'validated_cause'`, validation-failure reasons, `'reinvestigating'`, `'quarantined_degenerate'`); the incident DTO honest state (`read_api.go:125-129`) and brief-served-only-when-eligible (`read_api.go:315`) — the issue-page link on a report-ready card lands on a page that already renders the receipt's substance.
- **C2 (merged, #347):** readiness written for fix outcomes — `'fix_pr_opened'` (`worker/src/index.ts:1399/:1413`), `'fix_attempt_failed_with_diff'`/`'fix_attempt_failed_no_diff'` (`index.ts:1223/:1429-1434`), `'no_usable_diagnosis'` (`index.ts:689`) — so no receipt state is orphaned from the projection.
- **C3 (must be fully merged before Task 3):** migration `047_readiness_backfill.sql` — the eligible-only flip is unsafe until every open incident has a readiness row (headline invariant: zero open incidents absent from the projection); the impact columns stamped by the sweeper (`impact_class/impact_visits/impact_visits_recovered`); `WatchableSessionForGroup(ctx, errorGroupID, projectID) (sessionID string, anchorMs int64, ok bool, err error)` and `sessionURLAt(sessionID string, anchorMs int64) *string` (C3 Tasks 6–7) — receipt cards' `SessionURL` reuses both, so a watch link on a card is coverage-proven. Tasks 1, 2, and 5 need only C0–C2.
- **C3's recorded constraint, honored here:** the gate keys on `dr.status` alone — never on eligible-side reason strings, because 047 made eligible reasons heterogeneous (`'validated_cause'`, `'fix_pr_opened'`, `'backfill_receipt_state'`, `'backfill_validated_cause'`, …).
- Line numbers are anchors into the working tree, verified 2026-08-12 (pre-C3-merge for unmodified files). Where a symbol has moved, locate it by name (`grep -n`); the named function is the contract, not the line.

## Global Constraints

- Postgres queue only; wire contract append-only (`test-fixtures/wire/` untouched — the digest payload is outbox JSON, not the events wire contract, but the diff check runs anyway); lease and terminal-status contracts preserved; human-trigger bypass untouched.
- **Copy rule (program, precise):** every rendered sentence is a template over stored fields — `narrative` holds all of them; no model prose in templated copy. `root_cause` and the brief are model-authored technical reports: the card's cause excerpt renders **only** under an "Investigation:" label, **only** for items whose readiness is eligible with a usable diagnosis, never interpolated into story/receipt/triage lines.
- No judgment-based impact labels: the story line renders stored impact numbers or the exact phrase "recording impact unavailable". Digest cards always carry an action; a replay link is never a card's only action (structurally: every card carries the issue-page link, and `publishable` demands the state's own artifact).
- **One gate:** eligibility is `digest_readiness.status = 'eligible'`, decided nowhere else. The v1 plan's diagnosis join (strengthened to `has_validated_diagnosis`, Deviation 1) and placeholder regex survive as belt-and-suspenders inside `publishable` (a gate failure there is counted held-back and logged — it means a writer bug), not as the gate.
- Frozen contracts, named here: `receiptCap = 10`; `excerptMax = 300` (runes, matching `digestDetailMax = 300`); receipt-state strings `'pr_open'` (already in the C0 fixture `c0-receipts.fixture.ts`), `'attempt_failed_with_diff'`, `'attempt_failed_no_diff'`, `'report_ready'`; surfaced receipt statuses `('pr_created','pr_draft','needs_human','investigated','insight','awaiting_approval')`; held-back statuses `('needs_human','investigated','insight')`; ordering `COALESCE(priority_score,0) DESC, last_seen DESC, id DESC` (the `queries.go:848` precedent, index-compatible).
- Payload changes are append-only optional fields with `omitempty`; the C0 byte-stability golden (`TestDigestPayloadByteIdenticalWhenReceiptFieldsUnset`) must pass unmodified. No new migration; no schema change.
- Mixed-replica safety during rolling deploy: legacy collections stay populated in v2 payloads (an old-formatter replica renders them, ignoring unknown JSON fields); the new formatter renders captured v1 outbox rows via the version branch. Neither direction errors.
- Go tests may not skip beyond the `check-go-skips.mjs` allowlist; DB-gated tests follow their host package's convention.
- **Outward-facing gate:** AC4.7's owner sign-off is recorded in the cutover PR (PR2) **before** that PR deploys to any environment whose Slack destination customers read. The deploy itself is the formatter cutover — there is no separate flag flip for rendering (`DIGEST_SWEEP_ENABLED` and per-destination `event_types` govern *whether* digests send, not *how* they render).

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/ingestion/narrative/narrative.go` (create) | All digest/receipt copy templates + `SanitizeExcerpt`; imports only `masking` + stdlib |
| `packages/ingestion/narrative/narrative_test.go` (create) | Template matrix + sanitizer tests |
| `packages/ingestion/notify/event.go` (modify) | `DigestPayload` gains `TriageCounts *DigestTriageCounts`, `HeldBackCount int`, `ReceiptOverflow int` (all `omitempty`) |
| `packages/ingestion/notify/receipts_contract_test.go` (extend) | Round-trip + omitempty coverage for the new fields |
| `shared/src/types.ts` (modify) | `DigestReceiptFields` mirror gains `triage_counts?`, `held_back_count?`, `receipt_overflow?` |
| `packages/worker/src/__tests__/contracts/c0-receipts.fixture.ts` (extend) | Construction covers the new optional fields |
| `packages/ingestion/digest/build.go` (modify) | `buildReceiptItems` + triage/held-back queries; eligible-only flip on 4 sections; `SchemaVersion = 2` |
| `packages/ingestion/digest/build_test.go` (extend) | Receipt-item matrix: gate, window, cap/overflow, rank shape, excerpt sanitation |
| `packages/ingestion/notify/slack_digest.go` (modify) | `SchemaVersion >= 2` branch: cards, triage line, overflow + held-back footers, quiet day; `cleanProse` delegates to `narrative.SanitizeExcerpt` |
| `packages/ingestion/notify/slack_digest_test.go` (extend) | Golden per receipt state; AC4.4 four-payload matrix; AC4.6 copy assertions |
| `test-e2e/digest-contract.test.ts` (modify) | Delivery assertions updated to v2 copy (enumerated in Task 4) |
| `scripts/c4-backfill-restamp.sql` (create, Task 4) | Optional one-shot owner-invoked restamp (Deviation 2) |
| `scripts/loss-ledger.sql` (create) | The W4.M measurement query, deterministic output |
| `docs/research/loss-ledger.md` (create) | Dated entries with raw runner output attached verbatim |

**PR train** (each PR = consecutive tasks, merged in order): PR1 = Tasks 1–2 (narrative + payload contract + readiness clock; needs only C0–C2) · PR2 = Tasks 3–4 (builder + formatter — **the cutover PR**; needs C3 merged; carries the AC4.7 sign-off and does not merge without it) · PR3 = Task 5 (loss ledger; independent) · CP4 = Task 6 (its prod ledger entry lands as PR4).

## Deviations from carried-forward text (each deliberate, source-verified)

1. **The gate moved to the projection.** Receipts-v1 C1 defined `publishable` as `has_usable_diagnosis AND placeholder-regex AND ≥1 action`. The program (decision 1) moved eligibility to `digest_readiness` exclusively. The old conjuncts survive demoted to belt-and-suspenders — and the diagnosis join is **strengthened** to `has_validated_diagnosis` (the 047 structural citation-shape predicate), because it now guards something sharper than visibility: whether model-authored `root_cause` prose may render at all. An eligible item failing the belt is held back and `slog.Warn`ed (writer bug signal), but eligibility itself is `dr.status = 'eligible'`, full stop.
2. **One state-change clock: `digest_readiness.updated_at`.** V1 listed per-event timestamps (PR opened, attempt failed, investigation completed). Every one of those transitions flows through a readiness upsert (C1/C2 write sites), so `dr.updated_at` in the digest window is the single mechanical "receipt state changed" predicate — no per-status timestamp union, and "investigation completed" (which has no status timestamp column) is covered. Two clock defects fixed for this to hold:
   - **The writer bumps `updated_at` unconditionally today** (`upsertDigestReadiness`, `worker/src/db.ts:109-124`: `DO UPDATE SET … updated_at = now()`), so an idempotent rewrite (a crash-retry re-running a terminal write, C2's adoption path) would re-announce an unchanged receipt. Task 2 changes the upsert to keep `updated_at` when `(status, reason)` is unchanged. Recorded consequence, deliberately accepted: **state-change means `(status, reason)` transition, not artifact update.** A re-investigation landing the identical `('eligible','validated_cause')` row, or a second fix attempt terminating in the same failed state, does not re-announce — that is v1's own "the same open receipt does not reappear daily" rule; the fresh artifact is on the issue page, and any attempt that *changes* the state (a PR opens, a diff appears where none was) transitions the pair and announces. Requeues transition through `('pending','reinvestigating')` first, so a full re-run announces on completion either way.
   - **The 047 backfill's eligible rows surface only if a digest window covers their `updated_at`.** If C4 deploys more than 24h after 047 ran, the legacy book's receipts are silently never announced. That gap is closed operationally, not structurally: the cutover runbook (Task 4 Step 6) includes an optional restamp, **one-shot by the same marker discipline as every data migration** (a plain UPDATE would re-announce the book on every accidental re-run, and could race a digest mid-rolling-deploy — run it only after the deploy completes, before the next 9:00 local send):

```sql
-- scripts/c4-backfill-restamp.sql — optional, owner-invoked, one-shot.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM applied_data_migrations WHERE name = 'c4_backfill_restamp') THEN
    UPDATE digest_readiness SET updated_at = now()
     WHERE status = 'eligible' AND reason LIKE 'backfill_%';
    INSERT INTO applied_data_migrations (name) VALUES ('c4_backfill_restamp');
  END IF;
END
$$;
```

     Skipping it is a valid owner choice; the plan does not pretend the announcement happens by construction.
3. **`PRsMerged` is scoped out of the eligible-only flip** (C3's recorded landmine): closed groups are deliberately absent from the projection (047 classifies open incidents only), so an eligible-only `PRsMerged` would go permanently empty. It keeps C1's interim predicate. It is transition-only surface (v2 rendering ignores it) and merged groups render no analysis prose there.
4. **V2 rendering drops the legacy sections.** The v2 layout is: date header · triage line · receipt cards · overflow line · held-back footer · watching context. Insights/TopNew/PRsOpened/NeedsHuman/Outcomes sections are not rendered at `SchemaVersion >= 2` — cards subsume them (a new issue enters the digest when its investigation produces a receipt, which is the program's "receipts, not requests"). Two recorded losses, both deliberate: merged-PR celebration lines disappear from the daily digest (the PR itself notified at open; revisit post-program if missed), and uninvestigated brand-new issues appear only once investigated (~minutes after first event).
5. **Excerpts sanitize at build time** (outbox rows must not store full untrusted text — receipts §5d) via `narrative.SanitizeExcerpt`, which also strips URL origins (`https?://host` → path) because AC4.6 forbids origin-full URLs in copy; the formatter still runs its own clean pass (defense in depth for captured payloads and titles). The legacy sections' 220-rune `rootCauseExcerpt` (`digest/digest.go:50-63`) is untouched — transition-only code keeps transition behavior.
6. **Payload fields beyond the W0.2 freeze:** `TriageCounts`/`HeldBackCount`/`ReceiptOverflow` were specified by receipts-v1 C1 but not frozen in C0. They are added now as optional `omitempty` fields (`TriageCounts` as a pointer so unset serializes as absent); the C0 golden stays byte-identical.
7. **In-flight statuses are excluded from receipt items.** An eligible group in `queued/analyzing/fixing/candidate/new` (e.g. validated cause, fix attempt running) renders no card this digest; its terminal transition writes readiness again and the card appears with the terminal receipt. In-flight work is neither a receipt nor "pending internal review" — the same principle v1 applied to held-back.
8. **`needs_decision` counts parked investigations via the projection**, not a fresh diagnosis join: `status='needs_human' OR (status IN ('investigated','awaiting_approval') AND dr.status='eligible')`. One gate decides what a "decision-ready" investigation is; duplicating the diagnosis-usability join here would be a second decider. `awaiting_approval` is a plan addition over the v1 text (a literally parked human decision — the friction ask-first rung), gated on eligible like `investigated` so a quarantined/pending incident never inflates the triage line; `needs_human` counts ungated because it is a terminal state that needs a human regardless of what the investigation produced.
9. **Receipt items are kind-agnostic; friction *emission* stays Stream B's.** The query reads the projection with no `g.kind` filter — the program's "one digest contract, one gate" (decision 1: friction incidents become receipt items once the investigator fix lands, and C1 landed). What stays out of scope is friction-lane *pipeline* work (cluster detection, friction receipt production improvements — Stream B). A friction incident that already reaches eligible readiness with an in-window state change renders a card with the friction noun pair; Task 3 tests exactly one such case.
10. **Saved-diff and report cards act through the issue page, by design.** `ReceiptItem` carries no diff content or diff URL; the card's action for both failed-attempt states is the issue-page link, where C2's AC2.10 already made the terminal diff readable (`candidate_diff` is in the incident API, `read_api.go:46`) and C1 serves the brief when eligible (`read_api.go:315`). C5 improves that page's presentation; C4 does not wait for it. CP4 Step 2 clicks all four cards' pages to witness this, not just the report-ready one.
11. **AC4.6's "no CSS selectors / no internal reasoning" clauses, scoped honestly.** For Opslane-authored copy (story, receipt, triage, footers) both hold by construction — templates over stored numbers. For the labeled `Investigation:` excerpt, the mechanical enforcement is field selection (only `title`/`root_cause`/`suggested_mitigation` are ever selected into copy; no forensic selector field exists in the payload) plus the sanitizer; a selector-looking token *inside* a technical root cause is legitimate content, and no regex can tell it from leakage. The arbiter for excerpt content is the AC4.7 owner read on prod-shaped data (Task 4 Step 6) and CP4 Step 6's recorded manual read — if either finds excerpt content reading as leaked forensics or internal reasoning, that is a C1-investigator prompt bug to file, not a sanitizer patch to bolt on here.

---

### Task 1: The `narrative` package — every sentence the digest can say

**Files:**
- Create: `packages/ingestion/narrative/narrative.go`
- Create: `packages/ingestion/narrative/narrative_test.go`
- Modify: `packages/ingestion/notify/slack_digest.go` (`cleanProse` at `:271-289` delegates its pre-escape stages to `narrative.SanitizeExcerpt`; `proseEmailPattern` at `:22` moves into `narrative`)

**Interfaces:**
- Consumes: `packages/ingestion/masking` (`RedactBody`, `RedactURL`).
- Produces (consumed by Tasks 3–4 and by C5's issue-page `story`):

```go
package narrative

// Impact carries the C3 columns; nil pointers mean the columns are NULL.
type Impact struct {
	Class     string // 'blocked' | 'degraded' | 'invisible' | ""
	Visits    *int64
	Recovered *int64
}

// Story renders the plain-language line: templates over stored numbers only.
// The noun pair is passed explicitly ("crash"/"crashes" for kind=error,
// "friction signal"/"friction signals" for kind=friction) — pluralizing by
// suffix-trimming is a bug factory, so the caller supplies both forms.
func Story(nounSingular, nounPlural string, occurrences int64, imp Impact) string

// ReceiptLine returns the receipt sentence for a frozen state; ok=false for
// unknown states (forward-compat: a cluster item has no line by design).
// No URL parameter on purpose: copy fields never carry URLs (AC4.6).
func ReceiptLine(state string) (line string, ok bool)

// TriageLine renders the digest header line from point-in-time counts.
func TriageLine(prsAwaitingReview, needsDecision int, quiet bool) string

func HeldBackLine(heldBack int) string
func OverflowLine(overflow int) string

// SanitizeExcerpt is the build-time sanitizer for stored prose entering the
// outbox: redact secrets/URL creds (masking), mask emails, strip URL origins
// (scheme+host dropped, path kept), strip markdown control chars (` * _ ~),
// collapse every control char (incl \n\r\t) to a space, trim, and truncate so
// the RESULT is at most max runes — the trailing ellipsis fits inside the
// budget (max-1 runes + "…"), never appended beyond it. No Slack escaping
// here — that is the formatter's job at render time. Deliberate non-feature:
// no CSS-selector stripping — selectors in a technical root cause are
// legitimate content; AC4.6's "no CSS selectors" is enforced by field
// selection (no forensic selector-bearing field is ever selected into copy),
// not by regex surgery on prose.
func SanitizeExcerpt(value string, max int) string
```

- Frozen copy (the acceptance strings — tests pin them verbatim):
  - Story: `"12 crashes across 3 visits, no visit recovered"` (Recovered==0) · `"…, 1 of 3 visits recovered"` (0<K<M) · `"…, all 3 visits recovered"` (K==M) · `"12 crashes; recording impact unavailable"` (any of Class/Visits/Recovered NULL). Singular forms mechanical on each count: `"1 crash across 1 visit"`. **Fail-closed invariant guard:** any impact value outside the C3 contract — Class not one of the three enum strings, `*Recovered > *Visits`, or a negative count — renders the unavailable phrase, never authoritative-looking numbers from corrupt data.
  - ReceiptLine: `'pr_open'` → `"Fix PR ready for review."` · `'attempt_failed_with_diff'` → `"Fix attempt failed its checks; saved diff and report on the issue page."` · `'attempt_failed_no_diff'` → `"Fix attempt failed before producing a change; investigation report on the issue page."` · `'report_ready'` → `"Investigation report ready."` Two deliberate departures from the v1 spec's lines: the PR URL is **not** interpolated into the sentence (AC4.6 forbids origin-full URLs in copy fields; the URL lives only in the "Review fix PR" link, which is a button URL and exempt), so `ReceiptLine(state string)` takes no URL; and "attached" became "on the issue page" because that is where the artifact provably is (C2's AC2.10 diff exposure, C1's eligible-served brief) — copy asserts only what a stored field or shipped surface backs.
  - TriageLine: `"2 fix PRs awaiting review, 3 issues need a decision."`; with `quiet`: `"…, nothing else needs you today."`; zero-forms `"No fix PRs awaiting review"` / `"no issues need a decision"` (never bare `0`).
  - HeldBackLine: `"Held back: 3 items without a verified receipt yet."` (singular `item`). Deliberately neutral — the count mixes not-yet-eligible incidents with belt-caught writer bugs, and "low-signal … pending internal review" (v1's line) would mislabel the latter; this line claims only what the count mechanically is.
  - OverflowLine: `"4 more receipts ranked below these — open the dashboard for the full list."`

- [ ] **Step 1: Write the failing tests** (`narrative_test.go`, table-driven — no DB):

```go
func TestStory(t *testing.T) {
	i := func(v int64) *int64 { return &v }
	cases := []struct {
		name string
		occ  int64
		imp  narrative.Impact
		want string
	}{
		{"blocked", 12, narrative.Impact{Class: "blocked", Visits: i(3), Recovered: i(0)}, "12 crashes across 3 visits, no visit recovered"},
		{"degraded", 12, narrative.Impact{Class: "degraded", Visits: i(3), Recovered: i(1)}, "12 crashes across 3 visits, 1 of 3 visits recovered"},
		{"invisible", 12, narrative.Impact{Class: "invisible", Visits: i(3), Recovered: i(3)}, "12 crashes across 3 visits, all 3 visits recovered"},
		{"null impact", 12, narrative.Impact{}, "12 crashes; recording impact unavailable"},
		{"singular", 1, narrative.Impact{Class: "blocked", Visits: i(1), Recovered: i(0)}, "1 crash across 1 visit, no visit recovered"},
	}
	for _, c := range cases {
		got := narrative.Story("crash", "crashes", c.occ, c.imp)
		if got != c.want { t.Fatalf("%s: %q != %q", c.name, got, c.want) }
	}
}
```

  Plus invalid-impact rows in the same table (`Class: "bogus"`, `Recovered: i(5), Visits: i(3)`, `Visits: i(-1)` → each renders the unavailable phrase), `TestReceiptLine` (four states verbatim; unknown state → `ok == false`; no state's line contains `://`), `TestTriageLine` (plural/singular/zero/quiet matrix), `TestHeldBackAndOverflowLines`, and `TestSanitizeExcerpt`:

```go
// SanitizeExcerpt matrix:
// {"see https://app.customer.com/checkout?step=2 for", "see /checkout?step=2 for"}  // origin stripped, path kept
// {"key sk_live_abc123... leaked", "<redacted>"-bearing output}                     // masking.RedactBody ran
// {"mail bob@x.co", masked email}
// {"a\nb\tc", "a b c"}                                                              // control chars collapsed
// {"`code` *bold* _i_ ~s~", "code bold i s"}                                        // markdown stripped
// {strings.Repeat("é", 400), 299 runes + "…"}   // result ≤ 300 runes TOTAL (ellipsis inside the budget), rune-counted not bytes
// {"", ""}
```

- [ ] **Step 2: Run → FAIL** (`go test ./narrative/` — package absent).
- [ ] **Step 3: Implement.** Pure functions, `fmt.Sprintf` + a tiny `plural(n, singular, plural)` helper. `SanitizeExcerpt` order: `masking.RedactBody` → `masking.RedactURL` → email mask (the moved `proseEmailPattern`) → origin strip (`regexp.MustCompile(`+"`"+`https?://[^/\s]+`+"`"+`)` → `""`) → markdown-char strip → control-char collapse → `strings.TrimSpace` → rune truncate. Then refactor `notify.cleanProse` to `truncate(slackEscape(narrative.SanitizeExcerpt(value, budget)), budget)` and delete the duplicated stages.
- [ ] **Step 4: Run → PASS**: `go test ./narrative/ ./notify/` — every existing `notify` test (including `TestFormatSlackDigestNeutralizesInjectedLines` and `…BudgetsAndMasking`) must pass unmodified; if one fails, `SanitizeExcerpt` diverged from `cleanProse`'s stages — fix the sanitizer, not the test.
- [ ] **Step 5: Commit.** `feat(ingestion): narrative package — digest copy templates and the excerpt sanitizer (C4)`

### Task 2: Payload contract — triage counts, held-back, overflow — and the state-change clock

**Files:**
- Modify: `packages/ingestion/notify/event.go` (after `ReceiptItems` at `:56`)
- Extend: `packages/ingestion/notify/receipts_contract_test.go`
- Modify: `shared/src/types.ts` (`DigestReceiptFields` at `:38-42`)
- Extend: `packages/worker/src/__tests__/contracts/c0-receipts.fixture.ts`
- Modify: `packages/worker/src/db.ts` (`upsertDigestReadiness` at `:109-124`)
- Extend: `packages/worker/src/__tests__/db.test.ts` (DB-gated)

**Interfaces:**
- Produces (consumed by Tasks 3–4):

```go
// DigestTriageCounts are point-in-time counts rendered in the digest header.
type DigestTriageCounts struct {
	PRsAwaitingReview int `json:"prs_awaiting_review"`
	NeedsDecision     int `json:"needs_decision"`
}
```

  On `DigestPayload`: `TriageCounts *DigestTriageCounts \`json:"triage_counts,omitempty"\``, `HeldBackCount int \`json:"held_back_count,omitempty"\``, `ReceiptOverflow int \`json:"receipt_overflow,omitempty"\``.
  TS mirror on `DigestReceiptFields`: `triage_counts?: { prs_awaiting_review: number; needs_decision: number }`, `held_back_count?: number`, `receipt_overflow?: number`.
  And the clock discipline (Deviation 2): `upsertDigestReadiness`'s conflict branch becomes

```sql
ON CONFLICT (incident_id) DO UPDATE
SET status = EXCLUDED.status,
    reason = EXCLUDED.reason,
    updated_at = CASE
      WHEN digest_readiness.status IS DISTINCT FROM EXCLUDED.status
        OR digest_readiness.reason IS DISTINCT FROM EXCLUDED.reason
      THEN now()
      ELSE digest_readiness.updated_at
    END
```

  so an idempotent rewrite (crash-retry, C2 adoption) does not re-announce a receipt. Single-writer discipline holds: this edits the one writer, it does not add another.

- [ ] **Step 1: Write the failing tests.** Extend `TestReceiptItemRoundTrips` (or a sibling) to marshal a `DigestPayload` with all three fields set and assert the JSON keys round-trip; extend `TestReceiptFieldsOmitEmptyValuesButKeepPointerZeros` to assert a **zero-count but non-nil** `TriageCounts` still serializes (`"triage_counts":{"prs_awaiting_review":0,"needs_decision":0}` — a quiet day with zero counts must not vanish from the payload, which is why it is a pointer, not a struct with omitempty ints). In the worker: extend `c0-receipts.fixture.ts` with `digestReceiptFieldsV2: DigestReceiptFields = { schema_version: 2, receipt_items: [receiptItem], triage_counts: { prs_awaiting_review: 0, needs_decision: 0 }, held_back_count: 2, receipt_overflow: 4 }` (construction test — no type escapes). And the clock test in `db.test.ts` (DB-gated), made flake-proof by seeding an old clock rather than racing wall time: upsert `('eligible','validated_cause')`, then `UPDATE digest_readiness SET updated_at = now() - interval '1 hour' WHERE incident_id = $1`; re-upsert the same pair → `updated_at` still one hour old; upsert `('eligible','fix_pr_opened')` → `updated_at` within seconds of `now()`.
- [ ] **Step 2: Run → FAIL** (`go test ./notify/ -run TestReceipt`; `pnpm --filter @opslane/worker test -- c0-contracts`; the clock test fails on today's unconditional bump).
- [ ] **Step 3: Implement** the three Go fields + TS mirror + the upsert CASE.
- [ ] **Step 4: Run → PASS**, including `TestDigestPayloadByteIdenticalWhenReceiptFieldsUnset` **unmodified** — do not regenerate the golden; if it fails, an added field is serializing when unset. Full worker suite too (`pnpm --filter @opslane/worker test`, with and without `DATABASE_URL`) — every existing readiness-consuming test must pass unmodified.
- [ ] **Step 5: Commit.** `feat(notify): digest payload carries triage counts, held-back, and overflow; readiness clock only moves on state change (C4)`

### Task 3: The builder — receipt items, the eligible-only flip, `SchemaVersion = 2`

**Files:**
- Modify: `packages/ingestion/digest/build.go` (new `buildReceiptItems`, `buildTriageAndHeldBack`; predicate flip in `buildInsights :108-111`, `buildTopNewIssues :210-213`, `buildPRsOpened :259-262`, `buildNeedsHuman :324-327`; `Build :16` wires the new fields)
- Modify: `packages/ingestion/digest/digest.go` (constants `receiptCap = 10`, `excerptMax = 300` beside `listCap :23`)
- Extend: `packages/ingestion/digest/build_test.go`

**Interfaces:**
- Consumes: Task 1 (`narrative.SanitizeExcerpt`), Task 2 (payload fields), C3's `WatchableSessionForGroup` + `sessionURLAt`, the readiness projection.
- Produces: `Build` returns payloads with `SchemaVersion: 2`, `ReceiptItems` (≤10), `ReceiptOverflow`, `TriageCounts` (always non-nil), `HeldBackCount`; legacy collections still populated, eligible-only.

The receipt query (constants interpolated via `fmt.Sprintf` at package init, the Task-2-of-C3 pattern — one source per number):

```sql
SELECT g.id, g.kind,
       g.title,                                  -- reuse the exact title expression buildTopNewIssues selects today (read build.go:200-206 and copy it verbatim; the stored technical title, no invention)
       g.occurrence_count::bigint,
       g.impact_class, g.impact_visits, g.impact_visits_recovered,
       g.status::text,
       COALESCE(g.pr_url, '')            AS pr_url,
       COALESCE(g.root_cause, '')        AS root_cause,
       COALESCE(g.suggested_mitigation, '') AS suggested_mitigation,
       NULLIF(btrim(g.candidate_diff), '') IS NOT NULL AS has_saved_diff,
       d.has_validated_diagnosis,
       pub.publishable,
       count(*) OVER ()                                        AS total,
       (count(*) FILTER (WHERE NOT pub.publishable) OVER ())   AS belt_failed
  FROM error_groups g
  JOIN digest_readiness dr
    ON dr.incident_id = g.id AND dr.project_id = g.project_id
  CROSS JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1 FROM (
        SELECT dd.outcome, dd.diagnosis
          FROM diagnosis_decisions dd
         WHERE dd.error_group_id = g.id AND dd.project_id = g.project_id
         ORDER BY dd.decided_at DESC, dd.id DESC
         LIMIT 1
      ) latest
      WHERE latest.outcome IN ('code_fix','not_actionable')
        AND (CASE WHEN jsonb_typeof(latest.diagnosis->'evidence') = 'array'
                  THEN jsonb_array_length(latest.diagnosis->'evidence') >= 1
                   AND NOT EXISTS (
                     SELECT 1 FROM jsonb_array_elements(latest.diagnosis->'evidence') e
                      WHERE btrim(coalesce(e->>'path',''))        = ''
                         OR btrim(coalesce(e->>'detail',''))      = ''
                         OR btrim(coalesce(e->>'symptomLink','')) = ''
                   )
                  ELSE false END)
        AND (latest.outcome <> 'code_fix'
             OR (NULLIF(btrim(latest.diagnosis->>'agentTaskBrief'), '') IS NOT NULL
                 AND latest.diagnosis->>'agentTaskBrief' !~* '^\s*(placeholder|tbd|to be determined)\M'))
    ) AS has_validated_diagnosis
  ) d
  CROSS JOIN LATERAL (
    SELECT (COALESCE(g.root_cause, '') !~* '^\s*(placeholder|tbd|to be determined)\M')
           AND CASE
             WHEN g.status IN ('pr_created','pr_draft') THEN COALESCE(g.pr_url, '') <> ''
             WHEN g.status = 'needs_human'
               THEN NULLIF(btrim(g.candidate_diff), '') IS NOT NULL OR d.has_validated_diagnosis
             ELSE d.has_validated_diagnosis
           END AS publishable
  ) pub
 WHERE g.project_id = $1
   AND dr.status = 'eligible'
   AND dr.updated_at >= $2   -- window start (digestWindow) — same >= from AND < to
   AND dr.updated_at <  $3   -- convention as every existing section query (build.go:211,:269,:334)
   AND g.status IN ('pr_created','pr_draft','needs_human','investigated','insight','awaiting_approval')
 ORDER BY COALESCE(g.priority_score, 0) DESC, g.last_seen DESC, g.id DESC
 LIMIT 20   -- 2 × receiptCap: fetch headroom; the window counts above are computed over the FULL qualifying set, before LIMIT
```

(`has_validated_diagnosis` is the 047 backfill's **full** `validated_cause` predicate — ≥1 evidence element, every element carrying non-empty `path`/`detail`/`symptomLink`, and for `code_fix` a non-filler `agentTaskBrief` — reused verbatim from C3 Task 8's LATERAL. An outcome-only join would let a `backfill_receipt_state`-eligible group render legacy unvalidated `root_cause` prose. Recorded honestly: for legacy data this is a structural proxy, not re-verified citations — the exact trade C3's backfill made and recorded ("mechanical re-verification is a checkpoint activity, not a boot-time migration"); post-C1 rows need no proxy because C1 NULLs `root_cause` on invalid verdicts. `publishable` moved into SQL so the two window counts are exact over the full qualifying set, not just fetched rows; the Go `publishable` below re-checks kept rows as a defense against drift between the two spellings.)

Go mapping, after `rows.Close()` (the builders' own pool-safety rule, `build.go:137-140`):

```go
func receiptState(status string, hasSavedDiff bool) string {
	switch status {
	case "pr_created", "pr_draft":
		return "pr_open"
	case "needs_human":
		if hasSavedDiff {
			return "attempt_failed_with_diff"
		}
		return "attempt_failed_no_diff"
	default: // investigated, insight, awaiting_approval — validated cause, no attempt outcome
		return "report_ready"
	}
}

var fillerExcerpt = regexp.MustCompile(`(?i)^\s*(placeholder|tbd|to be determined)\b`)

// publishable is belt-and-suspenders under the projection gate: an eligible row
// failing it indicates a readiness-writer bug — count it held back and warn.
func publishable(item notify.ReceiptItem, hasValidatedDiagnosis bool) bool {
	if item.RootCauseExcerpt != "" && fillerExcerpt.MatchString(item.RootCauseExcerpt) {
		return false
	}
	switch item.ReceiptState {
	case "pr_open":
		return item.PRURL != ""
	case "attempt_failed_with_diff":
		return item.HasSavedDiff
	case "attempt_failed_no_diff", "report_ready":
		return hasValidatedDiagnosis
	}
	return false
}
```

Assembly rules:
- Walk the ≤20 fetched rows in order; keep the first `receiptCap` rows that are SQL-`publishable` **and** pass the Go re-check. `RootCauseExcerpt = narrative.SanitizeExcerpt(rootCause, excerptMax)` **only when** `has_validated_diagnosis` (the copy rule: model prose renders only when its verdict validated); `MitigationExcerpt` likewise, and only when non-empty. `Title` passes `narrative.SanitizeExcerpt(title, excerptMax)` too — outbox rows store customer-copy-safe text, and the formatter still escapes at render.
- `SessionURL`: for each **kept** item (≤10), call `WatchableSessionForGroup(ctx, groupID, projectID)`; when `ok`, `SessionURL = s.sessionURLAt(sessionID, anchorMs)`. Bounded at 10 lookups, issued after the cursor closes.
- Fetched rows failing `publishable` are dropped and `slog.Warn`ed with group id + state (writer-bug telemetry) — they are never rendered and never counted as overflow.
- The counts come from the SQL window functions, exact over the full qualifying set: `HeldBackCount += belt_failed` (read off any row) and `ReceiptOverflow = total − belt_failed − len(items)` — overflow means "publishable but ranked below the cap", held-back means "failed the belt", at any window size. Pathological case, recorded: >10 belt failures in one window under-fills the card list below 10 (only 20 rows fetched); that is a warned writer-bug regime, not worth a second query.

Triage and held-back (one query, point-in-time):

```sql
SELECT
  count(*) FILTER (WHERE g.status IN ('pr_created','pr_draft'))                                   AS prs_awaiting_review,
  count(*) FILTER (WHERE g.status = 'needs_human'
                      OR (g.status IN ('investigated','awaiting_approval') AND dr.status = 'eligible')) AS needs_decision,
  count(*) FILTER (WHERE g.status IN ('needs_human','investigated','insight')
                     AND (dr.status IS DISTINCT FROM 'eligible'))                                 AS held_back
  FROM error_groups g
  LEFT JOIN digest_readiness dr ON dr.incident_id = g.id AND dr.project_id = g.project_id
 WHERE g.project_id = $1
   AND g.status NOT IN ('resolved','merged','archived')
```

(`IS DISTINCT FROM` makes an absent row held-back — fail-closed; after 047 open incidents always have rows, so a hit means the invariant broke. `HeldBackCount` = this count **plus** any `publishable` failures from the item pass.)

The flip, in each of the four open-incident sections: replace

```sql
AND NOT EXISTS (SELECT 1 FROM digest_readiness dr
                 WHERE dr.incident_id = g.id AND dr.status IN ('ineligible','pending'))
```

with

```sql
AND EXISTS (SELECT 1 FROM digest_readiness dr
             WHERE dr.incident_id = g.id AND dr.status = 'eligible')
```

and delete the C1 comment block at `build.go:107` (its promise is discharged). `buildPRsMerged` (`:294-297`) keeps the interim predicate with a replacement comment naming Deviation 3's rationale.

- [ ] **Step 1: Write the failing tests** (`build_test.go`, DB-gated like its siblings; extend `seedDigestFixture` with a `seedReadiness(t, pool, groupID, projectID, status, reason string, updatedAt time.Time)` helper):

```go
// TestBuildReceiptItems_StatesAndGate (AC4.1 build half, AC4.2 build half):
//   ("valid decision" below = outcome 'code_fix' with diagnosis
//    {"evidence":[{"path":"a.ts","detail":"d","symptomLink":"s"}]} — the shape
//    has_validated_diagnosis requires; seed via the insertDiagnosisDecision
//    column list, respecting 034's immutability trigger)
//   Seed four eligible groups with in-window readiness:
//     pr_draft + pr_url                            → item state 'pr_open', PRURL set
//     needs_human + candidate_diff='diff --git…' + valid decision → 'attempt_failed_with_diff', HasSavedDiff
//     needs_human + candidate_diff=''  + valid decision → 'attempt_failed_no_diff'
//     investigated + valid decision                → 'report_ready', RootCauseExcerpt non-empty
//   Seed two gate-failers: readiness ('ineligible','filler_verdict…') and
//     ('ineligible','no_usable_diagnosis') on needs_human groups
//   → payload.SchemaVersion == 2; exactly 4 ReceiptItems; HeldBackCount == 2;
//     TriageCounts non-nil; the ineligible groups appear in no legacy section either.
//   Legacy-prose guard: an eligible needs_human group WITH a saved diff whose latest
//     decision is legacy code_fix lacking 'evidence' (no key) → card renders via the
//     diff artifact ('attempt_failed_with_diff'), but RootCauseExcerpt is EMPTY
//     (outcome alone never unlocks model prose). The same group without a diff is
//     belt-held instead (no artifact, no validated report) — assert both.
// TestBuildReceiptItems_FrictionKind (Deviation 9): eligible friction incident
//   (kind='friction', status='insight', valid decision, in-window readiness)
//   → one item with Kind 'friction'; formatter-side story uses the friction noun
//   (render half asserted in Task 4's golden).
// TestBuildReceiptItems_PriorityRankShape (AC4.3):
//   Group A: priority_score 40, affected_users*occurrences small.
//   Group B: priority_score NULL, affected_users_count=100, occurrence_count=500 (the old formula's leader).
//   Both eligible in-window → ReceiptItems[0] is A (COALESCE(NULL,0) loses).
// TestBuildReceiptItems_WindowAndCap (AC4.5 build half):
//   14 eligible groups, readiness updated_at = T-30m; Build(ctx, p, T) → 10 items,
//   ReceiptOverflow == 4, order matches COALESCE(priority_score,0) DESC, last_seen DESC, id DESC.
//   Build(ctx, p, T.Add(25*time.Hour)) → 0 items, ReceiptOverflow == 0 (window passed, no repetition);
//   TriageCounts still populated.
// TestBuildReceiptItems_BeltFailureBackfillsNotOverflow: 12 eligible in-window,
//   rank-3 has pr_open state but empty pr_url (seeded writer bug) → 10 items
//   (ranks 1-2, 4-12 backfill the cap), HeldBackCount includes the failure,
//   ReceiptOverflow == 1 (12 - 1 failed - 10 rendered).
// TestBuildReceiptItems_ClockIdempotence (Deviation 2 witness at the query):
//   eligible group with updated_at just outside the window; re-upsert the SAME
//   (status, reason) via SQL mirroring the Task 2 CASE → still no item.
// TestBuildReceiptItems_InFlightAndClosedExcluded (Deviation 7):
//   eligible+fixing group in-window → no item; eligible+resolved → no item;
//   eligible readiness updated_at outside window → no item.
// TestBuildReceiptItems_ExcerptSanitizedAtBuild (AC4.6 build half):
//   root_cause = "The `checkout` handler broke at https://app.cust.com/pay\nsecret sk_live_x…"
//   → item.RootCauseExcerpt has no origin (path only), no backticks, no newline, no key; ≤300 runes.
//   (No selector-stripping assertion — selectors in technical prose are legitimate; AC4.6's
//   selector clause is enforced by never selecting forensic selector fields into the payload.)
//   A needs_human group with NO decision rows but eligible readiness (seeded writer bug)
//   → held back (publishable belt), not rendered.
// TestBuildReceiptItems_SessionURLIsCoverageProven:
//   eligible item whose session has C3's three stitched covering chunks → SessionURL "…/sessions/{id}?t={ms}";
//   sibling with a 1ms chunk → SessionURL nil; item still publishable (replay is supplementary).
// TestBuildDigestSectionsEligibleOnly (flip regression):
//   rewrite TestBuildDigestExcludesIneligibleAndPendingAcrossEverySection:
//   absent-row OPEN group now excluded from insights/top-new/prs-opened/needs-human
//   (was: rendered), still INCLUDED in prs-merged when merged+absent (Deviation 3);
//   pending and ineligible excluded everywhere as before.
//   Existing fixtures in TestBuildDigestSections gain eligible readiness rows so the
//   sections they assert stay populated — enumerate every touched expectation in the PR.
```

- [ ] **Step 2: Run → FAIL** (`DATABASE_URL=… go test ./digest/ -run TestBuildReceipt`).
- [ ] **Step 3: Implement** (query consts + `buildReceiptItems` + `buildTriageAndHeldBack` + the flip + `Build` wiring). `Build` sets `SchemaVersion = 2` unconditionally.
- [ ] **Step 4: Run → PASS**: `go test ./digest/` — including the updated section tests and the untouched `digest_test.go` sweep tests; `git diff -- test-fixtures/wire/` empty.
- [ ] **Step 5: Commit.** `feat(digest): receipt items over the readiness projection — eligible-only, priority-ranked, capped (C4)`

### Task 4: The formatter — cards, triage, footers, quiet day, and the v1 fallback

**Files:**
- Modify: `packages/ingestion/notify/slack_digest.go` (`formatSlackDigest :24` branches; new `formatSlackDigestV2`, `digestReceiptCardBlocks`)
- Extend: `packages/ingestion/notify/slack_digest_test.go`
- Modify: `test-e2e/digest-contract.test.ts`

**Interfaces:**
- Consumes: `narrative` (Task 1), payload fields (Tasks 2–3).
- Produces: `formatSlackDigest` dispatches on `payload.Digest.SchemaVersion >= 2`. The v2 renderer **first** partitions items into renderable cards and skipped items — renderable = `Kind` is `"error"` or `"friction"` **and** `ReceiptLine(ReceiptState)` returns `ok` — skipping the rest (`cluster` by design, unknown kinds and unknown states defensively) with a `slog.Warn` each and no error (AC4.4). `quiet := len(renderable) == 0` — a cluster-only or malformed-only payload IS a quiet day; quietness is computed from what actually renders, never from `len(items)`. V2 block layout, in order:
  1. Date header (existing).
  2. Triage section: `narrative.TriageLine(counts.PRsAwaitingReview, counts.NeedsDecision, quiet)` — nil `TriageCounts` (malformed v2) renders as zero counts, never panics.
  3. Per renderable card: one section block —
     `*{cleanProse(Title, digestTitleMax)}*\n{narrative.Story(noun pair from Kind, OccurrenceCount, Impact{...})}\n{receipt line}` where the noun pair is `("crash","crashes")` for `error` and `("friction signal","friction signals")` for `friction`; when `RootCauseExcerpt != ""`, append `\nInvestigation: {cleanProse(RootCauseExcerpt, digestDetailMax)}` — the labeled model-report line, never interpolated elsewhere. The assembled card text passes through `digestSectionBlock` (`slack_digest.go:218`), whose `sectionMax` truncation is the last-resort bound; arithmetic headroom: 200 (title) + ~60 (story) + ~70 (receipt) + 300 (excerpt) + labels ≈ 650 ≪ 2900.
     Then one context block of links: `slackDigestLink(prURL, "Review fix PR")` (pr_open only) · `slackDigestLink(*SessionURL, "Watch recording")` (when set) · `slackDigestLink(issueURL, "Issue page")` (**always**), where `issueURL` is built from `payload.DashboardURL` (`event.go:11` — every digest payload carries it) + `IncidentID` using the **same path construction the existing digest/issue formatter code uses** — locate it by grepping `notify`/`digest` for the incident link helper and reuse it; do not invent a second route spelling.
  4. `narrative.OverflowLine(ReceiptOverflow)` context block when `ReceiptOverflow > 0`.
  5. `narrative.HeldBackLine(HeldBackCount)` context block when `HeldBackCount > 0` — this **replaces** `digestBacklogBlocks` in v2.
  6. Watching context block (existing, kept).
  Quiet day (v2): `quiet` → blocks 1, 2 (quiet form), 5 (when >0), 6. Legacy path (`SchemaVersion < 2`): byte-for-byte today's layout including `digestBacklogBlocks` — captured v1 outbox rows render exactly as before.
  Block budget: 10 cards × 2 blocks + ≤5 fixed blocks ≤ 25, under Slack's 50-block limit; each card section passes `sectionMax` via `cleanProse` budgets.

- [ ] **Step 1: Write the failing tests** (`slack_digest_test.go`, inline payloads like the existing goldens):

```go
// TestFormatSlackDigestV2Golden (AC4.1 render half): payload with 4 items (one per state,
//   one with SessionURL + RootCauseExcerpt, one with Kind 'friction') → per card: title
//   present, story line verbatim ("12 crashes across 3 visits, no visit recovered";
//   friction card says "friction signals"), receipt line verbatim (and contains no "://"),
//   "Issue page" link in every card, "Review fix PR" only on pr_open, "Watch recording"
//   only where SessionURL set, "Investigation: " prefix only where excerpt set; every
//   card's section text length ≤ sectionMax.
// TestFormatSlackDigestV2QuietDay (AC4.4): SchemaVersion 2, zero items, TriageCounts{2,3},
//   HeldBackCount 1 → "2 fix PRs awaiting review, 3 issues need a decision, nothing else
//   needs you today." + "Held back: 1 item without a verified receipt yet." + watching;
//   no card blocks, no legacy sections, no backlog line.
// TestFormatSlackDigestV2ClusterTolerated (AC4.4): items = [cluster item from the C0 golden
//   shape, one pr_open item] → no error, exactly one card, no cluster text anywhere.
// TestFormatSlackDigestV2ClusterOnlyIsQuiet: items = [one cluster item], TriageCounts{1,0}
//   → quiet-form triage line ("nothing else needs you today"), zero cards, no error.
//   Same for an item with an unknown Kind ("widget") and an unknown ReceiptState.
// TestFormatSlackDigestV1PayloadStillRenders (AC4.4): unmarshal
//   testdata/digest_payload_v1.json into EventPayload, FormatSlack → the legacy golden
//   assertions (reuse TestFormatSlackDigestGolden's) still hold; backlog line present.
// TestFormatSlackDigestV2Overflow (AC4.5 render half): 10 items + ReceiptOverflow 4 →
//   "4 more receipts ranked below these — open the dashboard for the full list."
// TestFormatSlackDigestV2CopyIsClean (AC4.6): item fields seeded with markdown, a full URL,
//   an email, and >300-rune text (simulating a pre-sanitizer payload) → rendered copy has
//   no `https://` origin, no raw email, excerpt ≤300 chars + budget truncation, and the
//   injected-line neutralization from the existing test still holds on v2 cards.
// TestFormatSlackDigestV2NilTriage: SchemaVersion 2, TriageCounts nil → renders zero-form
//   triage line, no panic.
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `formatSlackDigestV2` + the dispatch. Keep the v1 path untouched.
- [ ] **Step 4: Run → PASS**: `go test ./notify/`; then update `test-e2e/digest-contract.test.ts` — its delivery assertions currently pin v1 copy. The v2 assertions need v2-visible state, so the test's seed must also produce one receipt item: extend its existing project seed with (read the test's current seed first and extend, don't replace) a group in a receipt status, a `digest_readiness` row `('eligible', <a C2 reason>)` with `updated_at` inside the trailing 24h, and a decision row whose `diagnosis` JSON passes `has_validated_diagnosis`. Assert the v2 triage line, that card's receipt line, and the absence of the legacy backlog line; **enumerate every changed expectation in the PR description**. Run the e2e digest lane against the compose stack.
- [ ] **Step 5: Commit.** `feat(notify): receipt cards — SchemaVersion-branched Slack digest with triage, overflow, and held-back (C4)`
- [ ] **Step 6: The cutover gate, in this PR, on the final SHA (AC4.7).** After the last code commit of PR2: build **that SHA**, render one full digest from prod-shaped data (restore a prod copy locally, or the debug-ro runner pattern) via the destination-test endpoint to a **private** sink — never a customer destination. The owner (Abhishek) reads it; the sign-off (name + date + **the reviewed commit SHA** + a line on what was reviewed) is recorded in **PR2's description**, and PR2 does not merge without it. Any code change pushed after the sign-off invalidates it — re-render and re-sign on the new SHA. PR2's description also carries the deploy runbook: (a) old outbox rows re-render via the v1 branch during rolling deploy; an old-formatter replica renders a v2 payload's legacy sections — content differs, nothing errors (also the rollback behavior, recorded: rolling the formatter back silently degrades v2 rows to the legacy layout); (b) the one-shot restamp script from Deviation 2 (`scripts/c4-backfill-restamp.sql`, committed in this PR) — run after the deploy completes, before the next 9:00 local send, **only** if the owner wants the legacy book's receipts announced once; the sign-off states the choice either way.

### Task 5: W4.M — the loss ledger

**Files:**
- Create: `scripts/loss-ledger.sql`
- Create: `docs/research/loss-ledger.md`

**Interfaces:**
- Produces: the program's success metric, re-runnable. The script is read-only, deterministic (every output ordered), and runs via the debug-ro runner (`~/deploy/scripts/prod-sql.sh`) or any psql:

```sql
-- scripts/loss-ledger.sql — W4.M. Read-only. Run against prod via the debug-ro
-- runner: psql -X -f scripts/loss-ledger.sql; paste raw output verbatim into
-- docs/research/loss-ledger.md. The \pset lines below pin the output format so
-- every entry shares one parsable grammar regardless of the caller's psqlrc.
\pset format aligned
\pset footer off
\pset null ''
-- "Receipt" is mechanical: digest_readiness.status = 'eligible' (the one gate).
-- Row grammar: ord | section | k1 | k2 | n_groups | n_users | pct
--   ord 1 'totals_error'  — the HEADLINE, error-kind only (comparable to the
--                           2026-08-10 baseline, which measured error groups)
--   ord 2 'totals_all'    — both kinds, the program-wide view
--   ord 3 'by_readiness'  — k1=readiness status (or 'absent'), k2=reason
--   ord 4 'by_status'     — k1=group status
WITH open_groups AS (
  SELECT g.id, g.kind, g.status,
         COALESCE(g.affected_users_count, 0) AS affected_users,
         dr.status AS readiness, dr.reason
    FROM error_groups g
    LEFT JOIN digest_readiness dr ON dr.incident_id = g.id
   WHERE g.status NOT IN ('resolved','merged','archived')
)
SELECT 1 AS ord, 'totals_error' AS section,
       'receipt_groups:' || count(*) FILTER (WHERE readiness = 'eligible') AS k1,
       'receipt_users:'  || COALESCE(sum(affected_users) FILTER (WHERE readiness = 'eligible'), 0) AS k2,
       count(*)::text AS n_groups,
       COALESCE(sum(affected_users), 0)::text AS n_users,
       round(100.0 * COALESCE(sum(affected_users) FILTER (WHERE readiness = 'eligible'), 0)
             / GREATEST(COALESCE(sum(affected_users), 0), 1), 1)::text AS pct
  FROM open_groups WHERE kind = 'error'
UNION ALL
SELECT 2, 'totals_all',
       'receipt_groups:' || count(*) FILTER (WHERE readiness = 'eligible'),
       'receipt_users:'  || COALESCE(sum(affected_users) FILTER (WHERE readiness = 'eligible'), 0),
       count(*)::text, COALESCE(sum(affected_users), 0)::text,
       round(100.0 * COALESCE(sum(affected_users) FILTER (WHERE readiness = 'eligible'), 0)
             / GREATEST(COALESCE(sum(affected_users), 0), 1), 1)::text
  FROM open_groups
UNION ALL
SELECT 3, 'by_readiness', COALESCE(readiness, 'absent'), COALESCE(reason, ''),
       count(*)::text, COALESCE(sum(affected_users), 0)::text, ''
  FROM open_groups GROUP BY readiness, reason
UNION ALL
SELECT 4, 'by_status', status::text, '', count(*)::text, COALESCE(sum(affected_users), 0)::text, ''
  FROM open_groups GROUP BY status
 ORDER BY 1, 3, 4;
-- status::text is required: bare status is the error_group_status enum, and a
-- UNION arm must not rely on enum→text coercion against the text k1 arms.
```

  (Deterministic by construction: explicit `ord` puts the headline first, every aggregate is `COALESCE`d, every value cast to text, full ordering on `ord, k1, k2`. The headline `totals_error` is the baseline-comparable number; `totals_all` exists because the projection is kind-agnostic and friction receipts will join it.)

- `docs/research/loss-ledger.md` format — one `##` entry per run, newest last:

````markdown
# Loss ledger (W4.M)

The program's success metric: user-impact conversion — the share of affected
users on open incidents whose incident carries a receipt. Each entry appends
the date, the runner used, and the runner's raw output verbatim (not
summarized). Produced by `scripts/loss-ledger.sql`.

## 2026-08-10 — baseline (pre-program)

Source: the receipts design measurement (docs/design/2026-08-10-actionable-receipts.md §1),
taken before `digest_readiness` existed, so it predates the script above.
163 open error groups, ~118 affected users; 9 groups reached a PR touching 2
users. (The design doc's prose says "~7% conversion by issue count"; 9/163 is
5.5% — the raw counts in the row below govern, the prose rounding does not.)
By user impact: **~2%** (2/118 = 1.7%).

Raw record (RECONSTRUCTED into the script's row grammar from the design-doc
measurement — the script postdates the baseline, so this is a labeled
reconstruction, not runner output; the numbers are the design doc's):

```
ord | section      | k1               | k2              | n_groups | n_users | pct
1   | totals_error | receipt_groups:9 | receipt_users:2 | 163      | 118     | 1.7
```
````

  (The reconstruction keeps the CP criterion honest: "the attached output parses" means every entry — including the baseline — is machine-readable in the same grammar. If the original 2026-08-10 spike output is recoverable from the session artifacts, attach it *additionally*, verbatim; never in place of the parsable row.)

- [ ] **Step 1:** Write both files. Verify the SQL parses and runs against the local dev database (`psql "$DATABASE_URL" -f scripts/loss-ledger.sql`) — zero rows in sections is fine; a syntax error is not.
- [ ] **Step 2:** Check the baseline entry's numbers against the design doc §1 (they are quoted, not recomputed).
- [ ] **Step 3: Commit.** `feat(scripts): loss-ledger measurement ritual — script and baseline entry (C4/W4.M)`

### Task 6: CP4 verification run

No new production code. Prove AC4.1–AC4.7, the W4.M checkpoint, and the program-level gate the program schedules "after C4". Use the worktree port block from root `AGENTS.md` if defaults are taken; export the full env block as a unit.

- [ ] **Step 1: Full gate.** `pnpm install --frozen-lockfile && pnpm -r build && pnpm test` with `DATABASE_URL` exported (read skip counts, not pass counts); `(cd packages/ingestion && go build ./... && go test ./...)` → **zero skips**; `docker compose config --quiet`.
- [ ] **Step 2: AC4.1 drivable — pipeline-produced, not seeded.** On the dev stack with the C1 `anthropic-stub.mjs` scripted-verdict rig and C2's fixture repos, **in one fresh project** (the digest is project-scoped; a clean project makes every count exact): drive (a) the AC2.1 chain to an open draft PR (`fix_pr_opened`), (b) a fixture failing after edits (saved diff, `fix_attempt_failed_with_diff`), (c) a clone-failure fixture (`fix_attempt_failed_no_diff`), (d) a valid investigation below the impact bar (parked `investigated`, `validated_cause`). Then deliver a digest to the e2e sink via the destination-test endpoint — `POST /api/v1/notifications/destinations/{id}/test` with `{"event_type":"digest.daily"}` (verify the exact route in `handler/notifications.go`; the handler at `:334-344` resolves the project from the destination row and calls `DigestBuilder.Build(ctx, projectID, time.Now().UTC())`, so the window is the trailing 24h — the just-driven state changes land inside it) → four cards, correct receipt line each, ≥1 working action each — **open all four cards' issue pages**: the pr_open card's "Review fix PR" reaches the draft PR; the with-diff card's page shows the saved diff; the no-diff card's page shows the investigation report; the report-ready card's page renders the brief under the investigation-output label — plus sanitized title + story line. Record payload JSON + rendered blocks.
- [ ] **Step 3: AC4.2 drivable.** Same fresh project: drive a forced-filler verdict (C1's rig) and a no-usable-diagnosis investigation through the pipeline; build the digest → no cards for either; `held_back_count` counts **exactly** both — exactness holds because the project is fresh (the count is project-scoped point-in-time; a shared project would leak unrelated pending/ineligible incidents into it). Assert the two incident ids via `SELECT incident_id, status, reason FROM digest_readiness …` — reasons are the pipeline's, not seeded.
- [ ] **Step 4: AC4.3 + AC4.5.** These run as Task 3's DB-gated tests against the live stack's database (`go test ./digest/ -run 'PriorityRankShape|WindowAndCap' `) with both `now` values pinned; record output. The overflow line's render half is Task 4's `TestFormatSlackDigestV2Overflow`.
- [ ] **Step 5: AC4.4.** `go test ./notify/ -run 'FormatSlackDigestV2|V1Payload'` — the four-payload matrix (captured v1 → legacy layout; v2 items → cards; v2 zero → quiet day; v2 cluster → tolerated, unrendered). Record output.
- [ ] **Step 6: AC4.6.** Two halves, honestly split. Mechanical: Task 1/3/4's sanitizer, build, and render tests (origins, emails, secrets, control chars, ≤300 runes, URL-free receipt lines). Human: a manual read of Step 2's rendered digest for the two clauses no regex can decide — "no CSS selectors" (enforced structurally by never selecting forensic selector fields into the payload; the read confirms none leaked through title/root-cause prose) and "no internal reasoning" (templates make it true by construction for Opslane copy; the read checks the labeled investigation excerpts). Button URLs are exempt (they are `slackDigestLink`-masked URLs, not copy). Record the read's verdict alongside the Step 2 artifacts.
- [ ] **Step 7: AC4.7 — verify the record.** The human gate itself ran inside PR2 (Task 4 Step 6). Here: confirm PR2's description carries the sign-off (with the reviewed SHA equal to PR2's merged head) and the runbook (including the backfill-restamp decision), and that the merge/deploy postdates the sign-off timestamp.
- [ ] **Step 8: W4.M second entry.** Run `scripts/loss-ledger.sql` against prod via the debug-ro runner; append the dated entry with raw output verbatim; confirm both entries exist and the attached output parses (the CP criterion). **Commit the appended entry** — `docs: loss-ledger CP4 entry (W4.M)` — in its own small PR (PR4); a checkpoint artifact that lives only in a working tree does not satisfy "each run appends a dated entry".
- [ ] **Step 9: Program-level gate (after C4).** Re-run the AC2.1 chain (done in Step 2a), re-eyeball one digest (the Task 4 Step 6 render), and compare the loss-ledger entry against the baseline in PR4's description. Stated precisely so this cannot pass by construction: CP4 **records** the comparison (both numbers side by side, direction named); it does not gate on direction — judging whether the number moved enough is the program-end gate's job, and a regression is escalated to the owner in PR4, not silently recorded.
- [ ] **Step 10:** Run `/opslane-verify:verify` with AC4.1–AC4.6 as the pre-drafted half, per the program's verification method.

## CP4 criteria → task map

| AC | Covered by |
|---|---|
| AC4.1 (four states, one card each, actions, sanitized copy) | Tasks 3–4 tests; Task 6 Step 2 (pipeline-driven) |
| AC4.2 (pipeline-written ineligible → no cards, footer counts both) | Task 3 gate tests; Task 6 Step 3 |
| AC4.3 (priority-score leader first, rank-divergence shape) | Task 3 `PriorityRankShape`; Task 6 Step 4 |
| AC4.4 (v1 / v2-items / v2-zero / cluster matrix) | Task 4; Task 6 Step 5 |
| AC4.5 (14 changes → 10 cards + overflow; +25h → quiet day) | Task 3 `WindowAndCap` + Task 4 overflow/quiet; Task 6 Step 4 |
| AC4.6 (copy fields clean, excerpts ≤300) | Task 1 sanitizer + Task 3 build-half + Task 4 render-half; Task 6 Step 6 |
| AC4.7 (owner sign-off in the cutover PR) | Task 4 Step 6 (the gate, on the final SHA); Task 6 Step 7 (record verified) |
| W4.M (script + two ledger entries, raw output attached) | Task 5; Task 6 Step 8 |

## Execution notes

- Tasks 1–2 and 5 need only C0–C2 and can start while C3 finishes; Tasks 3–4 hard-require C3 merged (047 + `WatchableSessionForGroup` + `sessionURLAt`). Do not cherry-pick around that order: flipping to eligible-only before 047 blanks the digest for the legacy book.
- Deploy note (customer-visible, deliberate): whether the first post-deploy digest announces the backfilled legacy receipts is the **owner's runbook choice** (Deviation 2): it happens only if a digest window covers the backfill rows' `updated_at` — naturally when C4 deploys within 24h of 047, or via the one-shot restamp script otherwise; skipping both means the legacy book is never announced. When it happens: top 10 by priority, overflow line naming the rest. The AC4.7 prod-shaped render is where the owner sees exactly that digest before customers do.
- Deliberate non-goals: no cluster-card renderer or producer (frozen serialization only; convergence work owns it); no friction-lane pipeline work (Stream B — though friction incidents that already reach eligible readiness flow through the kind-agnostic gate, Deviation 9); no issue-page/PR-body reorder (C5 — the cards' issue-page action relies only on what C1/C2 already shipped there, Deviation 10); no re-evaluation of parked below-bar incidents; no change to digest scheduling, dedup, or destination plumbing; no plain-language titles.
- The `narrative` package is AGPL server code (`packages/ingestion`), imported by `digest`, `notify`, and later `handler` (C5) — it must never import `notify` or `digest` (cycle), only `masking` and stdlib.

## Revision log

**v2 after Codex round 1 (24 findings: 16 P1, 7 P2, 1 P3; Codex's sandbox could not read repo files — same bwrap bootstrap failure as the C1/C3 round-1 reviews — so findings are plan-internal; source-dependent ones were verified by direct grep before folding).** Accepted: the 047-flood honesty fix (backfilled receipts surface only if a window covers their `updated_at`; the cutover runbook gains an optional owner-decided restamp, and the plan stops claiming announcement-by-construction); the readiness clock discipline (`upsertDigestReadiness` bumps `updated_at` unconditionally today — source-confirmed at `db.ts:109-124`; Task 2 adds the `IS DISTINCT FROM` CASE plus a worker clock test, keeping the single writer); belt failures backfill the cap instead of shrinking the card list (fetch `2×receiptCap`, keep first 10 publishable; `ReceiptOverflow = total − beltFailed − rendered`, with the >10-failures pathology recorded as a warned writer-bug regime); `has_usable_diagnosis` strengthened to `has_validated_diagnosis` (047's structural citation-shape LATERAL reused verbatim — an outcome-only join would let `backfill_receipt_state` rows render unvalidated legacy prose) plus a legacy-prose guard test; the PR receipt line de-URLed (`ReceiptLine(state)` takes no URL; copy fields never carry URLs, satisfying AC4.6's letter) and "attached" reworded to "on the issue page" (assert only what a shipped surface backs); excerpt truncation keeps the ellipsis inside the 300-rune budget; `Story` gains fail-closed invariant guards (unknown class, recovered>visits, negatives → unavailable phrase, with test rows); window boundary aligned to the in-file `>= from AND < to` convention (source-confirmed at `build.go:211/:269/:334`); `needs_decision` gains `awaiting_approval` (a parked human decision); the friction-scope contradiction resolved by Deviation 9 (kind-agnostic gate per program decision 1; Stream B owns pipeline work, not card rendering) with a friction card test both halves; AC4.2's exactness pinned to a fresh project with incident-id assertions; the destination-test endpoint contract pinned (destination-scoped, `Build(ctx, projectID, now)` — source-confirmed at `notifications.go:334-344`); AC4.7 moved into PR2 as a merge gate (Task 4 Step 5) with the deploy/rollback runbook (v2 outbox rows silently degrade to the legacy layout under a formatter rollback — recorded); the CP4 ledger entry gets an owning commit (PR4); the baseline entry reconstructed into the script's parsable row grammar (labeled reconstruction, never fabricated runner output); the ledger headline split into baseline-comparable `totals_error` plus `totals_all`, with explicit section ordinals, `COALESCE`d aggregates, and full ordering; card section length bounded by arithmetic plus a `sectionMax` assertion in the golden; AC4.6's two undecidable clauses honestly split into structural enforcement plus the human read. Rejected, with rationale: (R1#2) failed-attempt cards are not action-less until C5 — C2's AC2.10 made the terminal diff readable from the incident page (`candidate_diff` in the incident API, `read_api.go:46`) and C1 serves the brief when eligible (`read_api.go:315`); C5 improves presentation, and Deviation 10 records this; (R1#8's stripping half) no CSS-selector regex surgery on prose — selectors inside a technical root cause are legitimate content; AC4.6's selector clause is enforced by field selection (no forensic selector-bearing field is ever selected into the payload), the test seed was reworded to stop implying otherwise, and the accepted human-read half covers leakage.

**v3 after Codex round 2 (21 findings: 11 P1, 10 P2; load-bearing sources inlined into the prompt this round — Codex confirmed the round-1 resolutions except where listed).** Accepted: `publishable` moved into SQL with two window counts (`total`, `belt_failed`) computed over the **full** qualifying set before `LIMIT` — round 1's fetched-rows-only `beltFailed` miscounted failures ranked past 20 as overflow; Go's `publishable` demoted to a drift re-check on kept rows; the validated-diagnosis LATERAL extended with 047's `code_fix` brief arm (round 1's claim that the excerpt regex covered it was wrong — that regex reads `root_cause`, not `agentTaskBrief`); the legacy-prose-guard test corrected (a no-diff group with an invalid legacy decision is belt-held, not rendered-with-empty-excerpt — the with-diff sibling is the case that renders; both asserted); quiet-day computed from **renderable** cards, not `len(items)` (a cluster-only or unknown-kind-only v2 payload is a quiet day; unknown kinds and unknown states skip-and-warn like cluster; new test); the restamp made one-shot via the `applied_data_migrations` guard as a checked-in script (`scripts/c4-backfill-restamp.sql`) with run-after-deploy-completes timing (a bare UPDATE would re-announce the book on any re-run and could race a mid-deploy digest); the execution-notes flood sentence rewritten to match Deviation 2 (announcement is the owner's runbook choice, not promised); AC4.7 resequenced to sign the **final SHA** (commit first, then render-and-sign; any post-sign-off push invalidates the sign-off); the ledger `by_status` arm cast `status::text` (enum vs text UNION arms); `\pset format aligned/footer off/null ''` pinned in the script (`-X` alone does not fix caller formatting); the clock test seeds an hour-old `updated_at` instead of racing wall clocks; `awaiting_approval` gated on `eligible` in `needs_decision` (matching `investigated`; `needs_human` stays ungated as a terminal state, rationale in Deviation 8); the issue-page URL pinned to `payload.DashboardURL` + the existing incident-link construction (grep-located, never a second route spelling); CP4 Step 2 opens **all four** cards' issue pages; the e2e update names its seed extension (receipt-status group + eligible readiness in-window + shape-valid decision JSON); `HeldBackLine` copy neutralized to `"N items without a verified receipt yet"` (the count mixes not-yet-eligible with belt-caught writer bugs; "low-signal pending internal review" mislabeled the latter); the baseline's 9/163 vs "~7%" discrepancy labeled (raw counts govern, design prose rounding does not); Step 9 states CP4 records the metric comparison without gating on direction (regressions escalate to the owner; the program-end gate judges movement). Accepted-by-documentation: (R2#1) the `(status, reason)` transition semantics deliberately do not re-announce a second same-state attempt — v1's "the same open receipt does not reappear daily," extended in Deviation 2 with the requeue path that does re-announce. Rejected, with rationale: (R2#4's stronger demand — suppress excerpts for backfilled receipt-state rows or require checkout-verified provenance) the full structural predicate is the program-accepted legacy proxy: C3's backfill classifies `backfill_validated_cause` as eligible on exactly this shape with the recorded rationale that mechanical re-verification is checkpoint activity, and post-C1 rows need no proxy because C1 NULLs `root_cause` on invalid verdicts — C4 inherits that decision rather than relitigating it; (R2#6) AC4.6's selector clause on excerpts — resolved as Deviation 11's scoping (templates by construction for Opslane copy; field selection + sanitizer + the two human reads for labeled excerpts; excerpt leakage is a C1 prompt bug to file, not a C4 regex), recorded as an interpretation the AC4.7 owner read ratifies.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found → addressed | R1: 16 P1 / 7 P2 / 1 P3; R2: 11 P1 / 10 P2; 40 accepted (3 partial), 4 rejected with recorded rationale |
| Eng Review | `/plan-eng-review` | Architecture & tests | 0 | not run | — |

**CODEX:** Two consult-mode iterations (session `019fee8c`, resumed from the program's C0–C3 reviews; sandboxed from source both rounds — bwrap bootstrap failure — so load-bearing sources were grep-verified before folding round 1 and inlined into the round-2 prompt). Round 1: the 047-flood window gap, the unconditional readiness clock, belt-vs-overflow miscounting, outcome-only diagnosis join unlocking legacy prose, URL-bearing receipt copy, the friction-scope contradiction, AC4.2 isolation, AC4.7 sequencing, and the ledger's comparability/determinism gaps. Round 2: confirmed the resolutions, then caught the fetched-rows-only belt count, the missing brief arm, the contradictory legacy-prose test, cluster-only quiet-day, the non-idempotent restamp, sign-off-before-final-SHA, and the enum/text UNION arm. All P1/P2s folded into v2/v3 except the four rejections recorded in the revision log.

**VERDICT:** CODEX CLEARED after two iterations — eng review not yet run (recommended before execution, matching the program plan's and C3 plan's review posture).

NO UNRESOLVED DECISIONS
