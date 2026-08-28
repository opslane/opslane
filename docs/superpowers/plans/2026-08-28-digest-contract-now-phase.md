# Digest contract fixes (audit "Now" phase) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the nine live defects from the payload-contract audit and add the shared digest accessor + cross-channel parity tests that close the "same digest, different answers" incident class.

**Architecture:** One version-aware accessor in `notify` becomes the single interpretation of a stored digest payload; MCP, the read API, and digest-eval consume it (additively — no existing response field changes). The remaining defects are small independent fixes with their own tests. Two items are decision-gated and ship only after a product call.

**Tech Stack:** Go 1.24 (ingestion), TypeScript/Node 22 (worker), Vitest + Go tests, Postgres.

**Spec:** `docs/audits/2026-08-27-payload-contract-audit.md` (defect numbers below refer to its "Live defects" table). The audit's "Next" (cross-language fixtures) and "Later" (dedup definitions) phases are separate plans.

## Global Constraints

- Ingestion rules: handlers in `handler/`, DB in `db/`; run `go build ./... && go test ./...` from `packages/ingestion` (repo `AGENTS.md`). DB-gated tests need `DATABASE_URL` with migrations applied; verify skips with `go test ./... -json | jq -rs '[.[] | select(.Action=="skip" and .Test != null) | .Test] | unique'` — storage-suite names only when storage env is unset.
- The `GET /digest/latest` response change is **additive**: `run_date` and `cards` keep their exact current shape and semantics.
- Slack's v1–v3 renderers are compatibility surface for stored undelivered events; do not touch them.
- Worker tests: `pnpm --filter @opslane/worker test` (Vitest, colocated `__tests__`).
- Never edit migration 047 or any applied migration; corrections are new migrations.
- Preserve terminal-status and lease contracts.

---

### Task 1: The digest accessor — one interpretation of a stored digest

**Files:**
- Create: `packages/ingestion/notify/digest_view.go`
- Test: `packages/ingestion/notify/digest_view_test.go`

**Interfaces:**
- Consumes: `DigestPayload`, `GeneratedDigestCard`, `ReceiptItem` (`notify/event.go`).
- Produces: `notify.DigestView` and `notify.BuildDigestView(digest *DigestPayload) DigestView` — every later task calls exactly this.

- [ ] **Step 1: Write the failing test**

```go
package notify

import "testing"

func TestBuildDigestViewV4SplitsCardsAndReceipts(t *testing.T) {
	digest := &DigestPayload{
		SchemaVersion: 4,
		Date:          "2026-08-27",
		GeneratedCards: []GeneratedDigestCard{
			{IncidentID: "i-new", Label: "new", Outcome: "needs_human", Title: "New issue"},
		},
		ReceiptItems: []ReceiptItem{
			{IncidentID: "i-wait", Kind: "error", Title: "Old issue", ReceiptState: "awaiting_approval"},
		},
		ReceiptOverflow: 2,
		DeliveryAlert:   "actionable lane degraded",
	}
	view := BuildDigestView(digest)
	if view.Legacy {
		t.Fatal("v4 must not be legacy")
	}
	if len(view.Cards) != 1 || view.Cards[0].IncidentID != "i-new" {
		t.Fatalf("cards = %+v", view.Cards)
	}
	if len(view.Receipts) != 1 || view.Receipts[0].IncidentID != "i-wait" {
		t.Fatalf("receipts = %+v", view.Receipts)
	}
	if view.ReceiptOverflow != 2 || view.DeliveryAlert != "actionable lane degraded" {
		t.Fatalf("counts/alert lost: %+v", view)
	}
	if view.Empty() {
		t.Fatal("view with items must not be Empty")
	}

	if !BuildDigestView(&DigestPayload{SchemaVersion: 4, Date: "2026-08-27"}).Empty() {
		t.Fatal("no cards, no receipts, no alert => Empty")
	}
	v2 := BuildDigestView(&DigestPayload{SchemaVersion: 2, Date: "2026-08-20", DeliveryAlert: "v2 alert",
		ReceiptItems: []ReceiptItem{{IncidentID: "i-v2", Kind: "error", ReceiptState: "awaiting_approval"}}})
	if len(v2.Receipts) != 1 || v2.Receipts[0].IncidentID != "i-v2" || v2.Legacy || v2.DeliveryAlert != "v2 alert" {
		t.Fatalf("v2 must map receipts and delivery alert, not flag legacy: %+v", v2)
	}
	v3 := BuildDigestView(&DigestPayload{SchemaVersion: 3, Date: "2026-08-22",
		GeneratedCards: []GeneratedDigestCard{{IncidentID: "i-v3", Label: "new"}}})
	if len(v3.Cards) != 1 || v3.Cards[0].IncidentID != "i-v3" || v3.Legacy {
		t.Fatalf("v3 must map cards, not flag legacy: %+v", v3)
	}
	v1 := BuildDigestView(&DigestPayload{Date: "2026-08-01"}) // schema_version 0 = v1
	if !v1.Legacy {
		t.Fatal("v1 (no schema_version) must report Legacy")
	}
	if BuildDigestView(nil).Date != "" {
		t.Fatal("nil digest must return zero view")
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./notify -run TestBuildDigestView -count=1` (from `packages/ingestion`)
Expected: FAIL, `undefined: BuildDigestView`.

- [ ] **Step 3: Implement**

```go
package notify

// DigestView is the one shared interpretation of a stored digest payload.
// Every non-Slack consumer (MCP, read API, digest-eval) builds its rendering
// from this view instead of plucking fields, so the channels cannot disagree
// about what a digest contains. Slack's per-version renderers are a delivery
// compatibility surface and stay independent; the parity test in
// digest_parity_test.go holds them to the same item set for v4.
type DigestView struct {
	Date            string
	Cards           []GeneratedDigestCard
	Receipts        []ReceiptItem
	ReceiptOverflow int
	OverflowCount   int
	DeliveryAlert   string
	SchemaVersion   int
	// Legacy is true only for v1 payloads (schema_version absent), which
	// carry neither cards nor receipts. v2 and v3 map their lane into the
	// view so stored pre-v4 digests keep rendering everywhere.
	Legacy bool
}

// Empty reports whether the digest contained nothing to act on: no new
// cards, no standing receipts, and no delivery alert.
func (v DigestView) Empty() bool {
	return len(v.Cards) == 0 && len(v.Receipts) == 0 && v.DeliveryAlert == ""
}

func BuildDigestView(digest *DigestPayload) DigestView {
	if digest == nil {
		return DigestView{}
	}
	view := DigestView{Date: digest.Date, SchemaVersion: digest.SchemaVersion}
	// Version mapping mirrors the Slack renderer switch (slack_digest.go):
	// v4 carries cards + receipts; v3 carried cards; v2 carried receipts;
	// v1 (schema_version 0/1) has neither and is reported as Legacy.
	switch {
	case digest.SchemaVersion >= 4:
		view.Cards = digest.GeneratedCards
		view.Receipts = digest.ReceiptItems
		view.ReceiptOverflow = digest.ReceiptOverflow
		view.OverflowCount = digest.OverflowCount
		view.DeliveryAlert = digest.DeliveryAlert
	case digest.SchemaVersion == 3:
		view.Cards = digest.GeneratedCards
		view.OverflowCount = digest.OverflowCount
	case digest.SchemaVersion == 2:
		view.Receipts = digest.ReceiptItems
		view.ReceiptOverflow = digest.ReceiptOverflow
		view.DeliveryAlert = digest.DeliveryAlert // the v2 renderer shows it too
	default:
		view.Legacy = true
	}
	return view
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `go test ./notify -run TestBuildDigestView -count=1` — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/notify/digest_view.go packages/ingestion/notify/digest_view_test.go
git commit -m "feat(notify): DigestView, the shared interpretation of a stored digest"
```

### Task 2: MCP `opslane_digest` reads the whole digest (defect 1, MCP leg)

**Files:**
- Modify: `packages/ingestion/db/queries.go:76-95` (`LatestDeliveredDigest`)
- Modify: `packages/ingestion/handler/mcp.go:100-127` (digest tool)
- Modify: `packages/ingestion/mcp/format.go` (`DigestInput`, `FormatDigest`; delete the local `DigestCard` duplicate at `format.go:10-25`)
- Test: `packages/ingestion/handler/mcp_digest_test.go`, `packages/ingestion/mcp/format_test.go`

**Interfaces:**
- Consumes: `notify.BuildDigestView` (Task 1).
- Produces: `Queries.LatestDeliveredDigestPayload(ctx, projectID) (runDate string, payload []byte, err error)` — returns the **whole** `rendered_payload`; `("", nil, nil)` when no delivered run exists. `mcp.FormatDigest(input mcp.DigestInput)` where `DigestInput` now carries `RunDate *string`, `View notify.DigestView`, `ProjectLabel string`. Task 4 (read API) and Task 5 (parity) reuse both.

- [ ] **Step 1: Write the failing handler test** (replace the cards-only seed in `mcp_digest_test.go` with three fixtures)

Seed `digest_runs` rows (`status='delivered'`) with:
1. cards-only v4 payload (keep the existing fixture, add `"schema_version":4`),
2. **receipts-only v4** — the shape prod produces daily: `{"event_type":"digest.daily","digest":{"schema_version":4,"date":"2026-08-27","receipt_items":[{"kind":"error","incident_id":"i-wait","title":"Dead clicks on /assets","receipt_state":"awaiting_approval","occurrence_count":198,"pr_url":"https://github.com/o/r/pull/9"}],"receipt_overflow":1}}`,
3. no row at all (fresh project).

Assert the tool text:
- receipts-only: contains the run date, `i-wait`, "waiting", and does **not** contain "No digest has been delivered";
- cards-only: unchanged card rendering;
- no row: still "No digest has been delivered for <label> yet";
- v2 row (`"schema_version":2` with `receipt_items`): renders the receipts (they map into the view);
- v1 row (no `schema_version`, no cards/receipts): names the date and says the digest used an older format, no invented items.

- [ ] **Step 2: Run to verify failure**

Run: `DATABASE_URL=... go test ./handler -run TestMCPDigest -count=1`
Expected: FAIL — receipts-only currently renders "No digest has been delivered".

- [ ] **Step 3: Implement the query change**

Replace `LatestDeliveredDigest` with:

```go
// LatestDeliveredDigestPayload returns the run date and the full stored
// notification payload of the most recent delivered digest, or ("", nil, nil)
// when none exists. Callers interpret the payload through
// notify.BuildDigestView — never by plucking JSON paths — so every consumer
// shares one definition of what the digest contains.
func (q *Queries) LatestDeliveredDigestPayload(ctx context.Context, projectID string) (string, []byte, error) {
	var runDate string
	var payload []byte
	err := q.pool.QueryRow(ctx,
		`SELECT run_date::text, rendered_payload
		   FROM digest_runs
		  WHERE project_id = $1
		    AND status = 'delivered'
		    AND rendered_payload IS NOT NULL
		  ORDER BY run_date DESC
		  LIMIT 1`, projectID,
	).Scan(&runDate, &payload)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, nil
	}
	return runDate, payload, err
}
```

Keep the old `LatestDeliveredDigest` for now — `handler/read_api.go` still calls it, so deleting it here breaks `go build ./...` mid-plan. Task 3 switches that caller and deletes the old function. (digest-eval is not a caller; it runs its own SQL.)

- [ ] **Step 4: Implement the tool + formatter**

In `handler/mcp.go`, the `opslane_digest` tool body becomes: fetch payload; if `runDate == ""` render the no-digest message; else `var event notify.EventPayload; json.Unmarshal(payload, &event)` (unmarshal error → tool error; `event.Digest == nil` → explicit tool error "stored digest payload is malformed", never rendered as an empty digest), `view := notify.BuildDigestView(event.Digest)`, pass `mcp.DigestInput{RunDate: &runDate, View: view, ProjectLabel: projectID}`.

In `mcp/format.go`: delete the local `DigestCard`/`Cards` field; `FormatDigest` renders:
- `RunDate == nil` → "No digest has been delivered for %s yet. The daily run produces it." (unchanged text).
- `View.Legacy` → "The digest for %s, %s was delivered in an older format this tool cannot itemize. The next daily run will be readable here."
- `View.Empty()` → "Opslane digest for %s, %s: nothing new and no decisions waiting."
- Otherwise: the existing card block (fields unchanged, sourced from `View.Cards`), then a receipts section:

```go
if len(input.View.Receipts) > 0 {
	lines = append(lines, "", fmt.Sprintf("Waiting on a decision (%d):", len(input.View.Receipts)+input.View.ReceiptOverflow))
	for _, item := range input.View.Receipts {
		lines = append(lines, fmt.Sprintf("- %s  %s  state: %s", item.IncidentID, Fence(Truncate(item.Title, TitleLimit)), item.ReceiptState))
		detail := fmt.Sprintf("  %d occurrences", item.OccurrenceCount)
		if item.PRURL != "" {
			detail += "  PR: " + item.PRURL
		}
		if item.SessionURL != "" {
			detail += "  replay: " + item.SessionURL
		}
		lines = append(lines, detail)
	}
	if input.View.ReceiptOverflow > 0 {
		lines = append(lines, fmt.Sprintf("  …and %d more on the dashboard.", input.View.ReceiptOverflow))
	}
}
if input.View.DeliveryAlert != "" {
	lines = append(lines, "", "Delivery alert: "+Fence(Truncate(input.View.DeliveryAlert, TitleLimit)))
}
```

Update `format_test.go` for the new input shape and the four states.

- [ ] **Step 5: Run tests, then commit**

Run: `go build ./... && DATABASE_URL=... go test ./handler ./mcp ./notify -count=1` — PASS.

```bash
git add packages/ingestion/db/queries.go packages/ingestion/handler/mcp.go packages/ingestion/mcp/ packages/ingestion/handler/mcp_digest_test.go
git commit -m "fix(mcp): digest tool reads the whole digest via DigestView"
```

### Task 3: `GET /digest/latest` gains receipts additively (defect 1, API leg)

**Files:**
- Modify: `packages/ingestion/handler/read_api.go:217-241`
- Test: `packages/ingestion/handler/read_api_digest_latest_test.go`

**Interfaces:**
- Consumes: `LatestDeliveredDigestPayload`, `notify.BuildDigestView`.
- Produces: existing fields unchanged; adds `receipts` (raw `ReceiptItem` array), `receipt_overflow`, `delivery_alert`, `schema_version`, `empty` (bool), `legacy` (bool).

- [ ] **Step 1: Failing test** — seed the same three fixtures as Task 2; assert: cards-only response byte-compatible on `run_date`/`cards`; receipts-only returns `run_date` set, `cards: []`, `receipts` with `i-wait`, `empty: false`; fresh project returns the current `{"run_date":null,"cards":[]}` plus `receipts: []`.
- [ ] **Step 2: Run to verify the receipts assertions fail.**
- [ ] **Step 3: Implement**

```go
type latestDigestJSON struct {
	RunDate         *string              `json:"run_date"`
	Cards           json.RawMessage      `json:"cards"` // raw passthrough, byte-compatible with today
	Receipts        []notify.ReceiptItem `json:"receipts"`
	ReceiptOverflow int                  `json:"receipt_overflow,omitempty"`
	DeliveryAlert   string               `json:"delivery_alert,omitempty"`
	SchemaVersion   int                  `json:"schema_version,omitempty"`
	Empty           bool                 `json:"empty"`
	Legacy          bool                 `json:"legacy,omitempty"`
}
```

Handler: fetch payload once; a decoded event with `event.Digest == nil` returns 500 "stored digest payload is malformed" (never an empty digest). Decode it twice — `notify.EventPayload` for the view, and a raw extractor so `cards` stays byte-identical (re-encoding typed cards would drop unknown future fields):

```go
var raw struct {
	Digest struct {
		GeneratedCards json.RawMessage `json:"generated_cards"`
	} `json:"digest"`
}
_ = json.Unmarshal(payload, &raw)
cards := raw.Digest.GeneratedCards
if len(cards) == 0 {
	cards = json.RawMessage("[]")
}
```

`Receipts: view.Receipts` (nil-safe to `[]`), rest from the view. No-run case: `run_date: null, cards: [], receipts: [], empty: true`. Switch this handler to `LatestDeliveredDigestPayload` and delete the now-unreferenced `LatestDeliveredDigest` in this task.

- [ ] **Step 4: Run** `DATABASE_URL=... go test ./handler -run TestGetLatestDigest -count=1` — PASS. **Commit** `fix(api): digest/latest returns receipts additively`.

### Task 4: digest-eval prints the same view (defect 1, eval leg)

**Files:**
- Modify: `packages/ingestion/cmd/digest-eval/main.go:43-71`

- [ ] **Step 1:** Its query already selects `rendered_payload` and unmarshals `notify.EventPayload` — only the rendering changes: `view := notify.BuildDigestView(event.Digest)`. Zero cards but receipts → print the receipts (id, title, state) instead of "Nothing needs your attention today."; `view.Empty()` → keep the nothing line; `view.Legacy` → print "legacy format run".
- [ ] **Step 2:** `go build ./cmd/digest-eval` and run it against a dev DB with the receipts-only fixture; confirm output lists `i-wait`. **Commit** `fix(digest-eval): render receipts via DigestView`.

### Task 5: Cross-channel parity test (the regression guard)

**Files:**
- Create: `packages/ingestion/notify/digest_parity_test.go` with **`package notify_test`** — after Task 2, `mcp` imports `notify`, so an internal `notify` test importing `mcp` would cycle; the external test package breaks the cycle. No new export needed: the existing exported `notify.FormatSlack` (`slack.go:29`) already routes `digest.daily` payloads to the digest formatter.

**Interfaces:**
- Consumes: `notify.BuildDigestView`, `notify.FormatSlack`, `mcp.FormatDigest`. Fixture payloads must set a valid non-loopback `DashboardURL` (e.g. `https://app.example.com`) — without it the Slack blocks drop links and the incident-ID assertions have nothing to match.

- [ ] **Step 1: Write the test.** Table of four stored payloads: cards-only, receipts-only, mixed, degraded (`DeliveryAlert` set, no receipts). For each:

```go
view := notify.BuildDigestView(payload.Digest)
expected := make(map[string]bool)
for _, c := range view.Cards { expected[c.IncidentID] = true }
for _, r := range view.Receipts { expected[r.IncidentID] = true }

slackBody, _, err := notify.FormatSlack(payload)          // must mention every expected id
mcpText := mcp.FormatDigest(mcp.DigestInput{RunDate: &date, View: view, ProjectLabel: "p"})
```

Assert: every expected incident ID appears in the Slack body AND in the MCP text; and neither channel mentions an incident ID absent from the view (scan with a regexp over the known test IDs). Channel-specific layering: cap cases (10 cards) assert Slack renders `DigestV4CardCap` plus the overflow line while the view keeps all 10 — the assertion is "channel ⊆ view + declared cap", not raw equality.

- [ ] **Step 2: Verify it fails against the pre-Task-2 formatter** (temporarily easy: it passes now only because Tasks 1–2 landed; instead prove the guard has teeth by asserting the receipts-only case — with Tasks 1–4 unmerged this test cannot compile, so teeth-proof is: mutate `FormatDigest` to drop receipts locally, watch it fail, revert).
- [ ] **Step 3: Run** `go test ./notify -run TestDigestChannelParity -count=1` — PASS. **Commit** `test(notify): cross-channel digest parity`.

### Task 6: `digest_delivered` usage props for v4 (defect 2 — decision-gated: metric definition)

Proposed definition (ship once approved, else park this task): `new_issues` = count of `view.Cards` with `Label == "new"`; `needs_human_backlog` = `len(view.Receipts) + view.ReceiptOverflow`.

**Files:**
- Modify: `packages/ingestion/notify/dispatcher.go:431-445`
- Test: `packages/ingestion/notify/dispatcher_usage_event_test.go`

- [ ] **Step 1:** Update the test's payload to a v4 shape (one `new` card, one `returned` card, two receipts, overflow 1) and assert `new_issues=1`, `needs_human_backlog=3`.
- [ ] **Step 2:** Run — FAIL (props read v1 fields).
- [ ] **Step 3:** Implement via the view:

```go
if payload.Digest != nil {
	view := BuildDigestView(payload.Digest) // dispatcher.go is package notify — no qualifier
	props["date"] = view.Date
	if view.SchemaVersion >= 4 {
		newCount := 0
		for _, card := range view.Cards {
			if card.Label == "new" {
				newCount++
			}
		}
		props["new_issues"] = strconv.Itoa(newCount)
		props["needs_human_backlog"] = strconv.Itoa(len(view.Receipts) + view.ReceiptOverflow)
	} else {
		// Stored pre-v4 events can still be delivered after a deploy; keep
		// their original metric fields rather than reporting zeros.
		props["new_issues"] = strconv.Itoa(len(payload.Digest.TopNewIssues))
		props["needs_human_backlog"] = strconv.Itoa(payload.Digest.NeedsHumanBacklog)
	}
}
```

Add a second test case: a v1-shaped payload (TopNewIssues populated, no schema_version) still reports its legacy counts.

- [ ] **Step 4:** Run notify tests — PASS. Document the definitions in a comment at the emission site. **Commit** `fix(notify): digest_delivered props read the v4 view`.

### Task 7: Admin job-type lists (defect 3)

**Files:**
- Modify: `packages/ingestion/handler/admin.go:15` — add `"digest_write": {}`.
- Modify: `packages/ingestion/db/admin.go:98` — add `"issue_inquiry": 0, "digest_write": 0, "stack_resolve": 0` to the `ByType` map.
- Test: extend the existing admin handler test with a `job_type=digest_write` filter request asserting 200, and assert `AdminOverviewData` returns all 11 types as keys.

- [ ] **Steps:** failing test → run → one-line fixes → run → commit `fix(admin): recognize digest_write, issue_inquiry, stack_resolve job types`. Also add a comment above each list pointing at `shared/src/types.ts` `JobType` as the reference list (the registry mechanism is the "Later" plan).

### Task 8: Delete the dead diagnosis `summary` read (defect 4)

**Files:**
- Modify: `packages/ingestion/digest/freeze.go:146` — `COALESCE(NULLIF(btrim(d.diagnosis->>'summary'),''), d.decision_reason)` becomes `d.decision_reason`.
- Test: add a regression case to `freeze_test.go`: seed a candidate whose `diagnosis` contains `{"summary":"WRONG"}` and whose `decision_reason` is `"RIGHT"`; assert the frozen candidate's summary field is `"RIGHT"` (pins that `decision_reason` is authoritative and `summary` is dead).

- [ ] **Steps:** failing test (fails today: summary wins when present) → edit the SQL → `DATABASE_URL=... go test ./digest -count=1` — PASS → commit `fix(digest): decision_reason is authoritative; drop dead diagnosis summary read`.

### Task 9: `policy_basis` test asserts the writer's real shape (coverage gap)

**Files:**
- Modify: `packages/ingestion/db/migration_044_test.go:110-140`

- [ ] **Step 1:** Replace the hand-inserted `{"basis":"eligible"}` with the shape the TS writer emits (`worker/src/db.ts:238-250`): `{"v":1,"identified_users":3,"recent_anon_sessions":0}`, and assert round-trip of those keys. Add a comment: `// Shape mirrors worker/src/db.ts buildPolicyBasis; the cross-language fixture that pins it mechanically is planned in the audit's Next phase.`
- [ ] **Step 2:** `DATABASE_URL=... go test ./db -run TestMigration044 -count=1` — PASS. **Commit** `test(db): policy_basis test mirrors the real writer shape`.

### Task 10: v4 receipts carry impact class and session URL (defect 8)

**Files:**
- Modify: `packages/ingestion/digest/actionable.go` (`actionableCandidate`, its SELECT, `toReceiptItems`)
- Test: `packages/ingestion/digest/` actionable tests (extend the existing candidate fixtures)

- [ ] **Step 1 (discovery, read-only):** Two different sources. Impact fields come straight from `error_groups` (`digest/build.go:89`: `g.impact_class, g.impact_visits, g.impact_visits_recovered`). The session URL does **not** come from candidate columns: the legacy lane resolves it after the candidate cursor closes, via `WatchableSessionForGroup` + `notify.BuildSessionURL` (`digest/digest.go:55` area), coverage-gated and best-effort. Read both call sites and record the exact snippets in this task before coding; the v4 implementation must reproduce the same coverage gating and best-effort behavior (a session lookup failure degrades to no link inside the existing savepoint semantics, never fails the run).
- [ ] **Step 2: Failing test** — extend the actionable candidate fixture with `impact_class='blocked'` (the CHECK in `044_actionable_receipts_contracts.sql:42` allows only `blocked|degraded|invisible`; keep `impact_visits`/`impact_visits_recovered` arithmetically consistent with it) and a watchable session for the group; assert the produced `ReceiptItem` carries `ImpactClass: "blocked"`, `ImpactRecovered`, and a non-empty `SessionURL` matching the legacy lane's URL shape.
- [ ] **Step 3:** Impact fields: add `ImpactClass string`, `ImpactRecovered *int64` to `actionableCandidate` and extend the SELECT with the `error_groups` expressions the legacy lane uses (`build.go:89`). Session URL: **not** from the SELECT — after the candidate cursor closes, resolve per included candidate via `WatchableSessionForGroup` + `notify.BuildSessionURL` exactly as the legacy lane does, best-effort (lookup failure degrades to no link inside the existing savepoint semantics, never fails the run), and set it in `toReceiptItems`' caller.
- [ ] **Step 4:** `DATABASE_URL=... go test ./digest -count=1` — PASS, plus a Slack render spot-check: `slack_digest_test.go` receipt case with `SessionURL` set shows "Watch recording". **Commit** `fix(digest): v4 receipts carry impact class and session URL`.

### Task 11: Replay-signals honest empty state (defect 9)

**Files:**
- Modify: `packages/worker/src/index.ts:102-120` (`mapDbSignals`)
- Test: `packages/worker/src/__tests__/` (signals mapping + pr rendering)

The wrong boundary would be `pr.ts`: it already renders `'Signals not available.'` for null (`pr.ts:273-275`). The bug is upstream — `mapDbSignals` returns a **zero-filled object for any non-null object input** (every field defaults via `?? 0` / `?? []`), so an empty or unrecognized `replay_signals` blob renders as genuine zeros.

- [ ] **Step 1:** Export the function (`export function mapDbSignals(...)`) so it is directly testable — it is module-local today.
- [ ] **Step 2: Failing test** — `mapDbSignals({})` and `mapDbSignals({unrelated: 1})` must return `null`; `mapDbSignals({console: {error_count: 0}})` and `mapDbSignals({consoleErrorCount: 0})` must still return objects (a measured zero is real data, in either the SDK nested shape or the legacy flat camelCase shape).
- [ ] **Step 3:** Return `null` unless at least one known signal key is present — nested (`event_type_counts`, `console`, `network`, `last_user_actions`) **or** flat legacy (`eventTypeCounts`, `consoleErrorCount`, `consoleWarningCount`, `consoleErrorMessages`, `consoleWarningMessages`, `networkAnomalyCount`, `networkAnomalies`, `lastUserActions`) — so genuine legacy rows stay renderable.
- [ ] **Step 4:** PR-body test: with signals mapped to null the body contains `Signals not available.` and no `0 console errors` line.
- [ ] **Step 5:** `pnpm --filter @opslane/worker test` — PASS. **Commit** `fix(worker): empty replay signals render as unavailable, not zeros`.

### Task 12: Test-send labels its legacy format (defect 6, minimal honest fix)

**Files:**
- Modify: `packages/ingestion/handler/notifications.go:360-376`
- Test: extend the test-send handler test.

The handler only builds an `EventPayload`; blocks are produced later by the formatter, and no preview field exists today. So the label needs an additive payload field plus renderer support:

- [ ] **Step 1:** Add `PreviewNote string \`json:"preview_note,omitempty"\`` to `notify.EventPayload` (additive, omitempty — absent from all stored payloads).
- [ ] **Step 2: Failing test** — a digest payload with `PreviewNote` set renders a leading context block with that text for **every** schema version; without it, output is byte-identical to today (run the existing golden tests unchanged).
- [ ] **Step 3:** Test-send handler (`notifications.go:360-376`) sets `PreviewNote: "Sample digest (legacy format — the scheduled daily digest uses the current format)"` on the payload it builds. Render it once, centrally, in `formatSlackDigest` (`slack_digest.go:23`) before the version switch — `cleanProse`-sanitized and truncated like other context text — so every version renderer inherits it without per-version edits.
- [ ] **Step 4:** `go test ./notify ./handler -count=1` + the e2e digest-contract lane — PASS. **Commit** `fix(notifications): label test-send digest as legacy-format sample`.

### Task 13: Shared TS digest types reach v4 (defect 7)

**Files:**
- Modify: `shared/src/types.ts` (digest receipt/card fields)
- Test: `packages/worker/src/__tests__/c0-contracts.test.ts`

- [ ] **Step 1:** Diff `shared`'s digest types against `notify/event.go:66-138`; add every missing v4 field (`generated_cards` card shape incl. `outcome`/`occurrence_count`/`pr_number`, receipt `has_validated_diagnosis`, `cluster_incident_ids`, `actionable_since`, digest `receipt_overflow`, `overflow_count`, `delivery_alert`, `timezone`) as optional fields, snake_case, with doc comments naming the Go source struct.
- [ ] **Step 2:** Add a v4 example object to `c0-contracts.test.ts` type-checked against the updated types (keep the v2 example — both versions exist in stored data).
- [ ] **Step 3:** `pnpm -r build && pnpm --filter @opslane/worker test -- c0` — PASS. **Commit** `feat(shared): digest types cover schema v4`.

### Task 14: Notification-config AAD exact binding (pre-expansion risk)

**Files:**
- Modify: `packages/ingestion/handler/notifications.go:180,252` (write path)
- Test: `packages/ingestion/notify/` or handler config round-trip test.

This is **preventive cleanup**, not a red-green defect fix: AEAD already rejects mismatched AAD, so the cipher test below pins existing behavior while the handler change removes the future trap. Constraints found in review: the create/update requests carry no type (endpoints are Slack-only) and the DB CHECK is `type IN ('slack')` (`018_notifications.sql:7`), so a webhook row cannot be seeded through the stack.

- [ ] **Step 1: Pinning test (cipher layer)** — call the seal/open helper directly: seal with AAD `"webhook"`, open with AAD `"slack"` must fail; open with `"webhook"` succeeds (passes today; pins the property the refactor relies on). Then the handler round-trip: create a slack destination, decrypt via the dispatcher path, assert unchanged behavior.
- [ ] **Step 2:** Create path: the handler validates/stores type `slack` today — use that same variable (not a second literal) as AAD. Update path: fetch the existing destination row first and use its `type` column as AAD when re-sealing.
- [ ] **Step 3:** Document in current code (a comment at the handler's type validation and in `docs/contracts/notifications.md`) — **never by editing applied migration 018**: widening to a second type requires a new migration widening the CHECK plus type-specific config validation; existing slack rows are unaffected by this change (same AAD value flows). `go test ./handler ./notify -count=1` — PASS. **Commit** `fix(notifications): bind config encryption to the stored destination type`.

### Task 15: 047 readiness follow-up (defect 5 — decision-gated: intent)

**Files:**
- Create (only if decided wrong): `packages/ingestion/db/migrations/065_readiness_outcome_correction.sql`

- [ ] **Step 1 (investigation, ships regardless):** Produce the decision input: count prod rows whose readiness values still match 047's distinctive output and whose evidence contains only failed checks (read-only SQL via the prod runner), quote `047`'s test intent, and — decisive for Step 2 — determine whether an **exact** selector exists that provably excludes rows the live pipeline has rewritten since. If no exact selector exists, the recommendation defaults to leave-as-is and Step 2 does not ship. Deliver as a short note in the PR description of this task.
- [ ] **Step 2 (gated):** If the product call is "failed checks must not count": new migration `065`. There is **no per-row provenance** — `applied_data_migrations` is a single global marker — so the selector must be derived in Step 1 from value shape: target only rows whose readiness fields still hold exactly 047's output (its distinctive `eligible`/`backfill_receipt_state` values) **and** that steady-state code has not rewritten since (e.g. `updated_at` within the 047 application window, or fields byte-equal to what 047 would compute). Rows the live pipeline has since touched are excluded — overwriting current valid state is the failure mode to avoid. Reapply-safe per repo migration rules; verified against a disposable DB seeded with 047-shaped data, then a representative copy.
- [ ] **Step 3 (gated):** `go test ./db -count=1` + migration reapply check. **Commit** `fix(db): correct 047 readiness rows that counted failed checks`.

### Task 16: Receipts-only end-to-end day (the dominant prod shape)

**Files:**
- Create/extend: `test-e2e/digest-receipts-only.test.ts` (pattern: `test-e2e/digest-contract.test.ts`)

- [ ] **Step 1:** Seeding must satisfy the actionable lane's real admission gates, not just status: groups in `awaiting_approval`/`needs_human` **with** the episode decisions and publishable evidence/diff the lane requires (copy the seeding recipe from the existing digest-contract e2e and the actionable lane's eligibility SQL), plus an enabled `digest.daily` notification destination and deterministic timing. Discovery step first: read `test-e2e/digest-contract.test.ts` and `digest/scheduler.go` to find the existing trigger seam the e2e suite uses to force a digest run (endpoint, due-row insert, or scheduler tick); reuse that seam rather than inventing one, and if none exists for the v4 lane, add a test-only trigger the same way the existing e2e forced its run. Assert: the delivered Slack payload's "Needs a decision" section lists the receipt incident IDs; `GET /digest/latest` returns them in `receipts`; the MCP tool text names them (POST `/mcp` over HTTP from the e2e suite with a seeded api-scope key and the JSON-RPC initialize/tools-call bodies — there is no prebuilt TS MCP client in `test-e2e`; the request shapes are three curl-equivalent fetches).
- [ ] **Step 2:** Run the e2e lane against the compose stack per `test-e2e` conventions — PASS. **Commit** `test(e2e): receipts-only digest day across Slack, API, and MCP`.

---

## Task order and independence

Tasks 1→2→3→4→5 are a dependency chain (accessor → consumers → parity). Tasks 6–14 are independent of each other and only 6 depends on Task 1. Task 15 is decision-gated and can run any time. Task 16 lands last (needs 2+3). Suggested PR grouping: PR-A = 1–5 (the incident-class fix), PR-B = 6–9 (small fixes), PR-C = 10–13, PR-D = 14, PR-E = 15 (if approved), PR-F = 16.

## Codex review notes

Three iterations against the repository at `800da86` (Codex verified citations via source spot-checks).

**Iteration 1** — 7 P1 / 6 P2, all adopted: version mapping in `BuildDigestView` for stored v2/v3 payloads (blanket Legacy would have regressed them); no mid-plan deletion of `LatestDeliveredDigest` (build break); parity test moved to `package notify_test` (import cycle); replay-signals fix relocated from `pr.ts` to `mapDbSignals` (the actual defect site); test-send label became an additive `PreviewNote` payload field with renderer support; AAD task rebuilt around the Slack-only reality of the endpoints and DB CHECK; 047 correction requires an exact value-shape selector (no per-row provenance exists); raw-`cards` passthrough for byte-compatibility; legacy branch in usage props; freeze regression test; corrected session-URL discovery (WatchableSessionForGroup, not SELECT columns); e2e seeding gates spelled out.

**Iteration 2** — 5 P1 / 5 P2, all adopted: v2 `DeliveryAlert` mapped; qualified call in the external test package; `impact_class` fixture uses a CHECK-legal value; `mapDbSignals` exported with nested+flat key guards; migration 018 never edited (docs live in code/contracts); `awaiting_approval` as the fixture receipt state; explicit malformed-envelope errors for `Digest == nil`; parity via existing `notify.FormatSlack` + valid `DashboardURL`; `PreviewNote` rendered centrally for all versions, sanitized; Task 14 framed as preventive cleanup with a pinning test; Task 15 gated on an exact selector existing (default: leave-as-is); Task 16 discovers the e2e trigger seam before use.

**Iteration 3** — one P1 (a package-qualifier error this revision introduced in Task 6's dispatcher snippet), fixed. No other findings; plan judged ready.
