# Friction delivery fix (design doc M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the delivered daily digest carry the top five actionable incidents (friction and error), plus an overflow count, in every digest until a human acts, and record a per-candidate decision ledger so "why wasn't X in the digest" is one query. (Honest contract per review: five cards + count, not "every incident individually"; fifth-slot rotation for a permanently-parked oldest item is a noted follow-up.)

**Architecture:** The digest that actually reaches Slack is the v4 pipeline: `digest.NewScheduler` (started at `main.go:201`) → `freeze.go` (creates the `digest_runs` row, status `frozen`, and frozen episode candidates) → worker digest-writer → `validate.go` `RenderAndDeliver`-equivalent (assembles `notify.EventPayload`, writes `issue_publications`, outbox rows, and sets status `delivered`, all in one transaction). The legacy `Sweeper.Build` receipts lane in `build.go` **never delivers in prod** (the Sweeper is only the preview `DigestBuilder` at `handler/notifications.go:364`); do not put delivery behavior there. This plan adds an "actionable receipts" section to the v4 payload inside `validate.go`'s existing transaction: one snapshot query selects candidates, one code path selects/caps them, writes the ledger, sets `DigestPayload.ReceiptItems` (the Slack renderer at `notify/slack_digest.go:338` already renders that field), and reconciles — all atomically with the `delivered` flip. A DB trigger maintains `actionable_since`/snooze lifecycle.

**Tech Stack:** Go 1.24, chi, pgx, PostgreSQL. Tests: `cd packages/ingestion && go test ./db ./digest ./filter ./handler ./notify` (DB-gated tests need `DATABASE_URL`; a green run with skips proves nothing — read the skip count).

**Spec:** `docs/design/2026-08-26-friction-detection-and-delivery.md` (Fix 1, O1–O3, honest filter reasons). Deviation from the spec's prose, agreed here: the change lands in the v4 lane (`freeze.go`/`validate.go`), not `build.go`'s receipts lane, because only the v4 lane delivers.

## Global Constraints

- Migrations are append-only starting at `062`, reapply-safe (`IF NOT EXISTS` guards) — `packages/ingestion/AGENTS.md`.
- Actionable statuses are exactly `awaiting_approval` and `needs_human`. Everything else is FYI or terminal.
- `digest_runs.status` values in code today: `frozen` (freeze.go:73), `delivered`, `failed` (validate.go). Do not invent others; verify at implementation time before relying on them.
- Never alter `element_selector` or any evidence column; never weaken the frozen-candidate lane's validation.
- All ledger/payload/publication writes happen inside validate.go's existing transaction; a retried run must be idempotent (`ON CONFLICT ... DO UPDATE`).
- Old binaries must run safely against the new schema (columns/table are additive; trigger only touches new columns). State this in each migration commit message.
- Run `go build ./... && go test ./...` from `packages/ingestion` before claiming any task done.

---

### Task 1: Migration 064 — actionable/snooze lifecycle trigger + decision ledger

**Files:**
- Create: `packages/ingestion/db/migrations/064_actionable_delivery.sql`
- Test: `packages/ingestion/db/migration_064_test.go`

**Interfaces:**
- Produces: `error_groups.actionable_since timestamptz`, `error_groups.snoozed_until timestamptz`; trigger `error_groups_actionable_lifecycle` (INSERT and UPDATE); table `digest_run_candidate_evaluations` with PK `(digest_run_id, error_group_id)` and FK to both parents.

- [ ] **Step 1: Write the failing test.** Mirror the harness of `migration_045_test.go`/`migration_047_test.go` (reuse their pool/seed helpers verbatim). Assert:

```go
// 1. Columns and ledger table + PK exist (information_schema, as in 047's test).
// 2. INSERT directly into an actionable status stamps actionable_since.
// 3. Entering actionable via UPDATE stamps it AND clears a stale snoozed_until.
// 4. actionable -> actionable transition preserves both timestamp and snooze.
// 5. Leaving actionable clears actionable_since AND snoozed_until.
// 6. Re-entering later restamps; no snooze inherited.
// 7. Ledger FK: inserting a ledger row with a bogus error_group_id fails.
```

- [ ] **Step 2: Run to verify failure.** `go test ./db -run TestMigration062 -v` → FAIL.

- [ ] **Step 3: Write the migration.**

```sql
-- 064_actionable_delivery.sql
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS actionable_since timestamptz;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;

CREATE OR REPLACE FUNCTION error_groups_actionable_lifecycle() RETURNS trigger AS $$
DECLARE
  was_actionable boolean := false;
  is_actionable boolean;
BEGIN
  -- Never reference OLD in the DECLARE block: it is unassigned on INSERT.
  IF TG_OP = 'UPDATE' THEN
    was_actionable := OLD.status IN ('awaiting_approval','needs_human');
  END IF;
  is_actionable := NEW.status IN ('awaiting_approval','needs_human');
  IF is_actionable AND NOT was_actionable THEN
    -- Entering (or being inserted) actionable: fresh age, no inherited snooze.
    NEW.actionable_since := now();
    NEW.snoozed_until := NULL;
  ELSIF is_actionable AND was_actionable THEN
    -- actionable -> actionable keeps age and snooze; repair a nulled stamp.
    IF NEW.actionable_since IS NULL THEN
      NEW.actionable_since := COALESCE(OLD.actionable_since, now());
    END IF;
  ELSIF NOT is_actionable THEN
    NEW.actionable_since := NULL;
    NEW.snoozed_until := NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS error_groups_actionable_lifecycle_ins ON error_groups;
CREATE TRIGGER error_groups_actionable_lifecycle_ins
  BEFORE INSERT ON error_groups
  FOR EACH ROW EXECUTE FUNCTION error_groups_actionable_lifecycle();
DROP TRIGGER IF EXISTS error_groups_actionable_lifecycle_upd ON error_groups;
CREATE TRIGGER error_groups_actionable_lifecycle_upd
  BEFORE UPDATE OF status, actionable_since, snoozed_until ON error_groups
  FOR EACH ROW EXECUTE FUNCTION error_groups_actionable_lifecycle();
-- Two triggers, not one unconditional one: occurrence_count bumps on this hot
-- table must not invoke PL/pgSQL on every write.

-- Backfill rows already actionable, status-appropriately.
UPDATE error_groups
   SET actionable_since = CASE
         WHEN status = 'needs_human' THEN COALESCE(needs_human_at, updated_at)
         ELSE updated_at  -- awaiting_approval has no dedicated timestamp column
       END
 WHERE status IN ('awaiting_approval','needs_human') AND actionable_since IS NULL;

-- No denormalized project_id: an audit ledger must not carry an unaudited
-- identifier. Project scope is derived through digest_runs.
CREATE TABLE IF NOT EXISTS digest_run_candidate_evaluations (
  digest_run_id  uuid NOT NULL REFERENCES digest_runs(id) ON DELETE CASCADE,
  error_group_id uuid NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  outcome        text NOT NULL CHECK (outcome IN ('included','excluded')),
  primary_reason_code text NOT NULL,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (digest_run_id, error_group_id)
);
CREATE INDEX IF NOT EXISTS idx_drce_group
  ON digest_run_candidate_evaluations (error_group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_groups_actionable
  ON error_groups (project_id, actionable_since)
  WHERE status IN ('awaiting_approval','needs_human');
```

The UPDATE trigger is scoped to the three governed columns, so occurrence-count churn never pays the trigger cost, while snooze writes and stamp repairs still pass through it. A caveat the snooze task depends on: the actionable→actionable branch preserves `NEW.snoozed_until`, so the snooze endpoint's plain UPDATE works unchanged.

- [ ] **Step 4: Green + idempotency.** `go test ./db -run TestMigration062 -v` → PASS; `go test ./db -run TestMigrations -v` (reapplication) → PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(digest): actionable/snooze lifecycle + candidate ledger (migration 064; additive, old-binary safe)"`

---

### Task 2: Actionable receipts in the v4 delivery transaction (selection + ledger + reconciliation, one snapshot)

This is the load-bearing task. Everything happens inside `validate.go`'s existing delivery transaction, with the actionable section wrapped in a **savepoint** so a bug in the new code can never take down frozen-card delivery:

```text
frozen section succeeds (unchanged)
SAVEPOINT actionable
  load -> evaluate -> map -> ledger
  on failure: ROLLBACK TO SAVEPOINT actionable; ReceiptItems=nil; Overflow=0;
              DeliveryAlert="Actionable findings could not be evaluated for this digest.";
              slog.Error with the concrete cause; continue
core: payload -> frozen publications -> outbox -> delivered
COMMIT
```

Degrade (savepoint rollback + alert): candidate query failure, receipt mapping failure, ledger insert failure, reconciliation accounting failure. Abort the whole run (existing behavior): context cancellation, frozen-lane validation failure, outbox/publication/status/commit failure, savepoint-rollback failure. If the ledger cannot be written, receipts are omitted — never publish receipts without their publication record.

Retry contract: `ON CONFLICT DO UPDATE` on the ledger exists for retries of a run that never reached a terminal status. A run already `delivered` must not be re-validated: keep/verify the existing terminal guard (test it; do not invent recovery for `failed` runs). Single clock: capture `actionableEvaluatedAt` once via `SELECT transaction_timestamp()` on the tx and use it for snooze comparison, age math, selection, and the ledger `details` — never mix `now()`, `time.Now()`, and `WindowTo` in one decision. `WindowTo` remains the data-window boundary only.

**Files:**
- Create: `packages/ingestion/digest/actionable.go`
- Modify: `packages/ingestion/digest/validate.go` (payload assembly, ~line 277)
- Modify: `packages/ingestion/notify/event.go` (`ReceiptItem` gains `ActionableSince *time.Time \`json:"actionable_since,omitempty"\``; `DigestPayload` gains `DeliveryAlert string \`json:"delivery_alert,omitempty"\``)
- Test: `packages/ingestion/digest/actionable_test.go` (pure-function tests), `packages/ingestion/digest/validate_actionable_test.go` (DB-gated, mirroring existing validate tests' harness)

**Interfaces:**
- Consumes: Task 1's columns/table; validate.go's `tx pgx.Tx`, `runID`, `run.ProjectID`, and the run's clock (`run.WindowTo` — use it, not `time.Now()`, for age math).
- Produces:

```go
type actionableCandidate struct {
	GroupID         string
	Kind            string     // 'error' | 'friction'
	Status          string     // awaiting_approval | needs_human
	Title           string
	OccurrenceCount int64
	ImpactVisits    *int64
	PRURL, RootCause, Mitigation string
	HasSavedDiff    bool
	HasValidatedDiagnosis bool
	ActionableSince *time.Time
	SnoozedUntil    *time.Time
	ErrorLaneEligible bool     // pipelineEligibleSQL result, error-kind only
}

// loadActionableCandidates: ONE query, no LIMIT, deterministic ORDER BY
// (actionable_since NULLS LAST, id), run on tx (snapshot).
func loadActionableCandidates(ctx context.Context, tx pgx.Tx, projectID string) ([]actionableCandidate, error)

// evaluate splits candidates into included / excluded-with-reason. Pure.
type evaluation struct {
	Included []actionableCandidate
	Excluded map[string]string // groupID -> reason code
	Overflow int
}
func evaluateActionable(cands []actionableCandidate, frozenIncidentIDs map[string]bool, now time.Time) evaluation

// reason codes (exhaustive): snoozed, error_lane_ineligible, not_publishable,
// frozen_lane_owns, capped_overflow, included.
```

- [ ] **Step 1: Write the failing pure-function tests** for `evaluateActionable`:

```go
// a. Friction candidate, validated diagnosis, not snoozed -> included.
// b. Snoozed (future) -> excluded 'snoozed'; snoozed in past -> included.
// c. Error-kind with ErrorLaneEligible=false -> excluded 'error_lane_ineligible'.
// d. Not publishable (belt reproduced from build.go's publishable rules via
//    receiptState) -> excluded 'not_publishable'.
// e. Group whose IncidentID is in frozenIncidentIDs -> excluded
//    'frozen_lane_owns' (cross-lane dedup: the frozen card wins).
// f. Selection with 7 eligible: 4 highest-impact + oldest-not-already-picked;
//    ALWAYS 5 when >=5 eligible; other 2 -> 'capped_overflow', Overflow=2.
//    Impact order: ImpactVisits desc (documented proxy; identified-user counts
//    are not materialized on groups), then OccurrenceCount desc, then GroupID
//    asc for stable ties. Oldest = min ActionableSince, GroupID tiebreak.
// g. Determinism: same input twice -> identical output; output sorted
//    deterministically even when len(eligible) <= 5 (SQL row order is not
//    a contract; ledger and receipt ordering must never come from map
//    iteration).
// h. IncidentID identity: frozen GeneratedCard.IncidentID is the canonical
//    error_groups.id (freeze.go:147 selects g.id as the candidate IssueID),
//    so frozen_lane_owns matches on real group ids — the integration test
//    must use a real frozen card, not a hand-built id string.
```

Write the selection helper the tests pin down:

```go
func selectActionable(eligible []actionableCandidate) (picked []actionableCandidate, overflow int) {
	if len(eligible) <= 5 {
		return eligible, 0
	}
	byImpact := append([]actionableCandidate(nil), eligible...)
	sort.SliceStable(byImpact, func(i, j int) bool { /* impact desc, occ desc, id asc */ })
	picked = byImpact[:4]
	inPicked := map[string]bool{picked[0].GroupID: true, picked[1].GroupID: true, picked[2].GroupID: true, picked[3].GroupID: true}
	var oldest *actionableCandidate
	for i := range eligible {
		c := &eligible[i]
		if inPicked[c.GroupID] || c.ActionableSince == nil {
			continue
		}
		if oldest == nil || c.ActionableSince.Before(*oldest.ActionableSince) ||
			(c.ActionableSince.Equal(*oldest.ActionableSince) && c.GroupID < oldest.GroupID) {
			oldest = c
		}
	}
	if oldest != nil {
		picked = append(picked, *oldest)
	} else if len(byImpact) > 4 { // nobody outside top-4 has a stamp: take 5th by impact
		picked = append(picked, byImpact[4])
	}
	return picked, len(eligible) - len(picked)
}
```

- [ ] **Step 2: Run to verify failure.** `go test ./digest -run Actionable -v` → FAIL.

- [ ] **Step 3: Implement the query and wiring.**

`loadActionableCandidates` (no LIMIT — the whole point is discovering old low-impact items; the partial index from Task 1 keeps it cheap):

```sql
SELECT g.id::text, g.kind, g.status::text, g.title, g.occurrence_count::bigint,
       g.impact_visits, COALESCE(g.pr_url,''), COALESCE(g.root_cause,''),
       COALESCE(g.suggested_mitigation,''),
       NULLIF(btrim(g.candidate_diff),'') IS NOT NULL,
       d.has_validated_diagnosis,
       g.actionable_since, g.snoozed_until,
       (g.kind = 'error' AND <pipelineEligibleSQL("g")>) AS error_lane_eligible
  FROM error_groups g
 LEFT JOIN LATERAL ( <the existing has_validated_diagnosis lateral from build.go, extracted into a shared Go const so build.go and this query use one copy> ) d ON true
 WHERE g.project_id = $1
   AND g.status IN ('awaiting_approval','needs_human')
 ORDER BY g.actionable_since NULLS LAST, g.id
```

LEFT JOIN, not CROSS JOIN: a candidate with zero diagnosis rows must still appear (as `not_publishable`), or the ledger lies by omission. Wrap the eligibility expression as `COALESCE(g.kind = 'error' AND (...), false)` and `COALESCE(d.has_validated_diagnosis, false)`. Add tests: actionable group with no diagnosis -> ledger `not_publishable`; error group with no episode -> `error_lane_ineligible`; multiple diagnosis rows -> exactly one candidate row.

Extract the diagnosis-validation lateral and `pipelineEligibleSQL` into shared package-level constants used by both `build.go` and `actionable.go` — one copy, no drift (Codex plan-review P1.1). The snooze check, publishable belt, and cross-lane dedup are evaluated in Go from the scanned row (single snapshot; no second query).

In `validate.go`, after `generated` is finalized and before `eventPayload` is built:

```go
frozen := map[string]bool{}
for _, card := range generated { frozen[card.IncidentID] = true }
cands, err := loadActionableCandidates(ctx, tx, run.ProjectID, run.WindowTo)
// evaluate, then:
eval := evaluateActionable(cands, frozen, run.WindowTo)
receipts := toReceiptItems(eval.Included)         // maps candidates via receiptState()
digestPayload.ReceiptItems = receipts
digestPayload.ReceiptOverflow = eval.Overflow
writeLedger(ctx, tx, runID, run.ProjectID, eval)   // one INSERT ... ON CONFLICT DO UPDATE
alert := reconcile(eval)                           // pure: counts from eval itself
digestPayload.DeliveryAlert = alert
```

`writeLedger` inserts one row per candidate in a single statement (`unnest` arrays), `ON CONFLICT (digest_run_id, error_group_id) DO UPDATE SET outcome=EXCLUDED.outcome, primary_reason_code=EXCLUDED.primary_reason_code, details=EXCLUDED.details` — retried runs overwrite their own rows. Publication semantics, stated in a code comment: **ledger `included` + run `delivered` (same transaction) is the publication record for receipts**; the episode-keyed `issue_publications` writes remain frozen-lane-only and untouched.

`reconcile` is pure over `eval` (no re-query, no live-state race): invariant `len(Included) + Overflow + count(not_publishable) + count(error_lane_ineligible) + count(snoozed) + count(frozen_lane_owns) == len(cands)`, and the alert condition is: any candidate neither included nor carrying an explicit exclusion reason. On violation: `slog.Error("digest reconciliation failed", ...)` + `DeliveryAlert = fmt.Sprintf("%d items are pending but could not be rendered", n)`.

- [ ] **Step 4: DB-gated integration test** (`validate_actionable_test.go`, reusing the existing validate test harness that drives a full run):

```go
// R4/R1: friction group, watch episode, validated diagnosis, awaiting_approval,
//   actionable_since 12 days before window -> ReceiptItems contains it. Run a
//   second digest run (next run_date) -> included again (repeat behavior).
// R2: flip it to 'resolved', third run -> absent, ledger has no row (status
//   gate removed it from the universe).
// Snooze: snoozed_until future -> excluded row reason 'snoozed'.
// Cross-lane: an error group present as a frozen GeneratedCard AND actionable
//   -> exactly one appearance (the card), ledger reason 'frozen_lane_owns'.
// Retry: run validate twice for the same run -> ledger rows overwritten, no PK error.
```

- [ ] **Step 5: Run.** `go test ./digest -v` → PASS (existing frozen-lane tests untouched and green).

- [ ] **Step 6: Commit.** `git commit -m "feat(digest): actionable receipts in v4 delivery with decision ledger and reconciliation"`

---

### Task 3: Rendering — age line and delivery-alert line

**Files:**
- Modify: `packages/ingestion/notify/slack_digest.go` (receipt block ~line 338; digest header/footer for the alert)
- Test: `packages/ingestion/notify/slack_digest_test.go`

**Interfaces:**
- Consumes: `ReceiptItem.ActionableSince`, `DigestPayload.DeliveryAlert`, and `DigestPayload.Window.To` as the clock (never `time.Now()` — render output must be a pure function of the payload).

- [ ] **Step 1: Failing tests.**

```go
// Age: ActionableSince = Window.To - 12d -> context line "waiting on you since Aug 13 (12 days)".
// Singular: 1 day -> "(1 day)". Same-day -> "(today)". Future/nil -> no line.
// Alert: DeliveryAlert set -> a warning context block containing the text.
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** in the receipt rendering loop:

```go
if item.ActionableSince != nil && !item.ActionableSince.After(clock) {
	days := int(clock.Sub(*item.ActionableSince).Hours() / 24)
	label := fmt.Sprintf("%d days", days)
	if days == 1 { label = "1 day" }
	if days == 0 { label = "today" }
	ageLine = fmt.Sprintf("waiting on you since %s (%s)", item.ActionableSince.Format("Jan 2"), label)
}
```

where `clock := digest.Window.To` (parse per the payload's existing window types). Render `DeliveryAlert` as a context block after the receipts section. Follow the existing block idioms; the receipts contract tests (`receipts_contract_test.go`) are append-only — new optional fields are fine, regenerate snapshots per that file's documented procedure if it has one.

- [ ] **Step 4: Run.** `go test ./notify -v` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(digest): waiting-age and delivery-alert rendering"`

---

### Task 4: Snooze endpoint

**Files:**
- Modify: `packages/ingestion/handler/read_api.go` (next to `ArchiveIncident`, ~line 1358)
- Modify: `packages/ingestion/handler/routes.go` (~line 166)
- Test: handler test file mirroring the resolve/archive tests.

**Interfaces:**
- Produces: `POST /api/v1/projects/{projectID}/incidents/{incidentID}/snooze`, body `{"until": "<RFC3339>"}` or `{"until": null}`. Rules: 404 for wrong project (same scoping as Archive); 409 when the group is not in an actionable status; 400 when `until` > now+30d; `null` clears; a past `until` also clears (documented as unsnooze). Uses `json.RawMessage` to distinguish omitted (400) from explicit null (clear).

- [ ] **Step 1: Failing tests** covering all six rules above, copying the auth/scoping assertions from the Archive tests (auth middleware plus membership authorization — assert a non-member gets the same rejection Archive gives, not just "authenticated").
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**

```go
func (d *Dependencies) SnoozeIncident(w http.ResponseWriter, r *http.Request) {
	var body struct{ Until json.RawMessage `json:"until"` }
	// decode; if body.Until == nil -> 400 "until is required (RFC3339 or null)"
	// if string(body.Until)=="null" -> until = nil
	// else parse RFC3339; if until.After(now.Add(30*24*time.Hour)) -> 400
	// UPDATE error_groups SET snoozed_until=$1, updated_at=now()
	//  WHERE id=$2 AND project_id=$3 AND status IN ('awaiting_approval','needs_human')
	// zero rows: distinguish 404 (no such group in project) from 409
	// (exists but not actionable) with a follow-up existence check.
}
```

Route: `r.With(deps.AuthenticateUserSession).Post("/projects/{projectID}/incidents/{incidentID}/snooze", deps.SnoozeIncident)`. The lifecycle trigger preserves the snooze across actionable→actionable transitions and clears it on any exit — the handler never manages lifecycle.

- [ ] **Step 4: Run.** `go test ./handler -v` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(api): incident snooze endpoint"`

---

### Task 5: Filter stops evaluating friction episodes; honest reason wording

Separable: Tasks 5 and 6 can ship as a second PR after Tasks 1-4 land (Codex review 2 recommended cutting them from the first slice; they touch other pipelines and nothing in Tasks 1-4 depends on them). Runs after delivery so friction's digest path exists before its filter noise stops.

**Files:**
- Modify: `packages/ingestion/filter/dispatch.go` (`inquiryCandidates` ~line 166; `staleEpisodes` ~line 119 — see caution below)
- Modify: `packages/ingestion/filter/evaluate.go:84`
- Test: `packages/ingestion/filter/dispatch_test.go`, `evaluate_test.go`

- [ ] **Step 1: Read before changing.** `staleEpisodes` feeds evaluation; `closeResolvedEpisodes` (dispatch.go:106) handles terminal lifecycle separately and already closes episodes of resolved/merged/archived groups **regardless of kind — leave it untouched**. Confirm nothing else terminalizes episodes via the evaluation path; if the liveness flip (`inactive`) is the only lifecycle the evaluator owns, friction episodes may simply stop being evaluated (their decisions freeze at their current value, which is inert since Task 2 made delivery independent of them).
- [ ] **Step 2: Failing test.** Seed friction-kind and error-kind episodes with no decisions; run the sweep; assert the friction episode gets no `issue_decisions` row and no inquiry job, while the error one proceeds. Also assert `closeResolvedEpisodes` still closes a resolved friction group's episode.
- [ ] **Step 3: Implement.** Add `JOIN error_groups g ON g.project_id=ep.project_id AND g.id=ep.canonical_issue_id AND g.kind='error'` to `staleEpisodes` and `inquiryCandidates` only. Change the `evaluate.go:84` reason to `"no error events linked to this episode yet"`.
- [ ] **Step 4: Run.** `go test ./filter -v` → PASS (update any test pinned to the old reason string).
- [ ] **Step 5: Commit.** `git commit -m "fix(filter): friction episodes exit the error-lane filter; honest zero-evidence reason"`

---

### Task 6: Delivery-SLA diagnostics (three separate failure classes)

**Files:**
- Create: `packages/ingestion/digest/sla.go`
- Modify: `packages/ingestion/digest/scheduler.go` (call after each tick)
- Test: `packages/ingestion/digest/sla_test.go` (DB-gated)

**Interfaces:**
- Produces: `CheckDeliverySLA(ctx, pool, projectID string, now time.Time) (SLAReport, error)` with five classes: `StuckRuns` (non-terminal past 6h), `FailedRuns` (recent `failed`), `MissingRuns` (no run created for an expected schedule slot), `OmittedActionable`, `ReconciliationFailures`. **Diagnostics, not alerts**: this task produces structured error logs only; nothing pages anyone until a metric filter/alarm or Slack routing is added in a follow-up — say so in the code comment.

- [ ] **Step 1: Failing tests**, one per class:

```go
// Class 1 — run stuck: digest_runs row not 'delivered'/'failed' for > 6h
//   after creation -> reported. (Catches full-outage: no EXISTS-delivered
//   precondition anywhere in this class.)
// Class 2 — delivered-but-omitted: group actionable+unsnoozed since BEFORE the
//   LATEST delivered run's window_to, with no ledger row (any outcome) in that
//   latest run -> reported. Checks the most recent digest, not "ever included",
//   because repeat-while-actionable promises presence in EVERY digest.
// Class 3 — reconciliation: the latest delivered run's stored payload has a
//   non-empty delivery_alert (read digest_runs.rendered_payload), OR a ledger
//   row carries a reason outside the closed set -> reported.
// Class 4 — failed run: a digest_runs row reached 'failed' within 48h -> reported.
// Class 5 — missing run: a project with an enabled digest destination has no
//   digest_runs row for the last expected run_date -> reported.
// Happy path: all five empty.
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the three queries exactly as the tests describe; wire `CheckDeliverySLA` into the scheduler tick after run processing, logging each finding with group/run ids and the diagnostic query name.
- [ ] **Step 4: Run.** `go test ./digest -v` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(digest): delivery SLA diagnostics (stuck runs, omissions, reconciliation)"`

---

### Task 7: Full gate, live smoke, rollback notes

**Files:** none (verification), plus `docs/design/2026-08-26-friction-detection-and-delivery.md` (mark Fix 1 shipped with deviations).

- [ ] **Step 1: Full gate.** `cd packages/ingestion && go build ./... && go test ./...` with `DATABASE_URL` exported; zero skips in db/storage suites.
- [ ] **Step 2: Live smoke** on the worktree stack (root `AGENTS.md` port block; apply migrations; `scripts/seed-e2e.sql`). Seed by SQL: friction group (`kind='friction'`, `status='awaiting_approval'`, validated diagnosis row, `actionable_since` 12 days back via direct UPDATE — the trigger's repair branch preserves it), plus its watch episode. Drive one full v4 run (freeze → forced writer payload → validate; use the digest-v4 rig technique: in-network sink, forced-payload). Assert: `rendered_payload` contains the friction receipt with `actionable_since`; the Slack-rendered blocks contain the age line. Advance `run_date` and drive a second run: item present again. Snooze via Task 4's endpoint; third run: absent, ledger row reason `snoozed`. Spot-check `SELECT outcome, primary_reason_code, count(*) FROM digest_run_candidate_evaluations GROUP BY 1,2` reconciles.
- [ ] **Step 3: Rollback notes in the design doc.** Old binaries ignore the new columns/table (additive); binary rollback silently stops repeat-delivery and snooze enforcement (columns persist, harmless); the trigger stays active and is safe under old binaries (touches only new columns); the filter change rolling back resumes friction `watch` decisions (noise, not breakage); ledger rows are forward-only history. Migration deploys before binaries (standard ordering).
- [ ] **Step 4: Commit.** `git commit -m "docs(design): fix 1 shipped; deviations and rollback notes"`

---

## Self-review notes

- Spec coverage: eligibility contract → Task 2 (kind branch + belt + shared SQL fragments); repeat-while-actionable → Task 2 (status-only universe, no window/liveness) + R1/R2 integration tests; dedup key → ledger PK with stated publication semantics; snooze → Tasks 1 (lifecycle) + 4 (API) + 2 (gate); 4+1 cap → Task 2 selection with always-5 guarantee; age line → Task 3; O1 → Task 2 ledger; O2 → Task 2 reconcile (pure, snapshot-consistent); O3 → Task 6 (three classes, no delivered-run precondition on class 1); honest reasons + filter exit → Task 5; cross-lane dedup → Task 2 (`frozen_lane_owns` + test). Provisional-hold work correctly absent (M3-contingent).
- Deviation from the design doc recorded in the header: v4 lane, not `build.go`. `build.go` keeps serving the preview endpoint unchanged; the shared SQL constants prevent the two from drifting.
- Types consistent: `actionableCandidate` defined once (Task 2) and consumed by Tasks 3/6 only through `ReceiptItem`/ledger rows; reason codes listed once and reused in Task 6's class-3 test.
- Codex review 2 P1s folded: savepoint isolation with an explicit degrade/abort split; terminal-run retry guard tested; trigger OLD-reference fixed and scoped to three columns via two triggers; single `transaction_timestamp()` clock; LEFT JOIN lateral with COALESCE so diagnosis-less candidates reach the ledger; deterministic ordering everywhere; ledger drops the unaudited project_id; goal restated as top-5+overflow; SLA grew failed-run and missing-run classes and is labeled diagnostics-not-alerts. Not adopted: removing the superpowers execution header (that tooling is installed and standard in this environment; Codex lacks that context).
