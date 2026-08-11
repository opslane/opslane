# C0 Interface Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four frozen contracts of the unified program (diagnosis fields, receipts payload, migration 044, worker ledger types) as stubs with no behavior, each proven by a consumer that fails to compile or errors on the base commit.

**Architecture:** Types and schema only; no producer or consumer behavior changes; existing outputs stay byte-identical. Four PRs, merged the same day. Parent: `docs/superpowers/plans/2026-08-10-unified-actionable-program-plan.md` §C0; authority: `docs/design/2026-08-10-unified-actionable-program.md`.

**Tech Stack:** TypeScript (shared + worker; Vitest exists in worker, **not** in shared — shared has no test script, so contract proof is tsc compilation of fixture modules), Go 1.25 (ingestion; plain `testing`), plain-SQL migrations executed by a **per-statement autocommit runner with no applied-migrations ledger: every file re-runs on every startup, so every statement must be individually idempotent**.

## Global Constraints

- All new TS fields optional; all new Go payload fields `omitempty`; an unset payload serializes byte-identically (AC0.3).
- No `suggested_direction` anywhere. No type escapes in contract fixtures (`as unknown as`, `as any`, `@ts-expect-error`).
- Wire fixtures under `test-fixtures/wire/` untouched (AC0.4).
- Because the runner re-executes migration files on startup, "idempotent" means: running 044 N times leaves the same state, and stopping after any statement and re-running recovers (AC0.2). Constraint replacements therefore use guarded `DO` blocks, not bare DROP/ADD pairs.
- Type-level red tests are proven by `tsc` (package build), not Vitest: Vitest erases types and would pass on base. Each contract fixture is a compiled module; the red run is the build failing on base.
- "Run on base" means: create a base worktree (`git worktree add`), overlay only the new fixture/test files into it, and run there — checking out base directly would delete the new files.

---

### Task 1: Diagnosis contract (PR 1)

**Files:**
- Modify: `shared/src/diagnosis.ts` (`Adjudication`, `Diagnosis`, `DiagnosisOutcome` at :91)
- Modify: `shared/src/types.ts` (re-export `EvidenceCitation` alongside the existing diagnosis re-exports at ~:418)
- Create: `packages/worker/src/__tests__/contracts/c0-diagnosis.fixture.ts` (compiled by the worker `tsc` build — the consumer proof; workers import the shared package root, which is why the fixture lives here)
- Create: `packages/worker/src/__tests__/c0-contracts.test.ts` (thin runtime assertions over the fixture, for the test-run record)

**Interfaces (consumed by C1's harness and C4's report rendering):**

```ts
export interface EvidenceCitation {
  /** Repository-relative path, undecorated (same rule as CauseLocation.path). */
  path: string;
  /** What was found at this path. */
  detail: string;
  /** How that finding links to the customer-visible symptom. */
  symptomLink: string;
}
```

- `Adjudication` gains **optional** `evidence?: EvidenceCitation[]` and `agent_task_brief?: string` (snake_case, matching this interface's wire-mirroring convention).
- `Diagnosis` gains **optional** `evidence?: EvidenceCitation[]` and `agentTaskBrief?: string` — optional, not required-nullable: every existing constructor, parser, and test literal must keep compiling unchanged (parent C0 rule; C1 starts producing them).
- `DiagnosisOutcome` widens to `'code_fix' | 'not_actionable' | 'needs_more_context' | 'incomplete'`.

- [ ] **Step 1: Write the fixture module** (complete literals — `Adjudication` requires `best_supported`, `evidence_check`, `candidates_considered`, `rejected`, `evidence_strength`, `cause_kind`, `cause_locations`, `reasoning`, `why_chain`, `reproduction_steps`; copy the full required set from the type when writing):

```ts
import type { Adjudication, DiagnosisOutcome, EvidenceCitation } from '@opslane/shared';

export const citation: EvidenceCitation = {
  path: 'src/components/AuthWrapper.vue',
  detail: 'v-if chain mixes sync and async components',
  symptomLink: 'page dies during sign-in when a status flag flips mid-resolve',
};

export const adjudicationWithEvidence: Adjudication = {
  best_supported: 'x', evidence_check: 'x',
  candidates_considered: [{ statement: 'x', kind: 'local_code' }],
  rejected: [], evidence_strength: 'suggestive', cause_kind: 'local_code',
  cause_locations: [{ path: 'src/a.ts' }], reasoning: 'x',
  why_chain: ['x'], reproduction_steps: ['x'],
  evidence: [citation],
  agent_task_brief: 'symptom, files, cause, change, verification',
};

export const incompleteOutcome: DiagnosisOutcome = 'incomplete';

// The Diagnosis half of the contract — construct a COMPLETE Diagnosis literal
// (copy every required field from the current type when writing this) with the
// two new optional fields set:
export const diagnosisWithEvidence: Diagnosis = {
  /* ...every existing required Diagnosis field with plausible values... */
  evidence: [citation],
  agentTaskBrief: 'symptom, files, cause, change, verification',
} /* no casts — fill the literal out fully */;
```

- [ ] **Step 2: Red run.** In a base worktree with only the fixture overlaid: `pnpm --filter @opslane/worker build` → FAILS (`evidence` unknown, `'incomplete'` unassignable). Record the error text in the PR.
- [ ] **Step 3: Edit `shared/src/diagnosis.ts`** (add `EvidenceCitation`, the optional fields, widen the union) and re-export `EvidenceCitation` from `shared/src/types.ts`.
- [ ] **Step 4: Green run + blast check.** `pnpm -r build && pnpm --filter @opslane/worker test`. Expected: no breakage — `classify.ts` routes with if-chains, not exhaustive switches, and `deriveOutcome` produces only the original three values. **If any exhaustive switch on `DiagnosisOutcome` does break the build, STOP: adding a routing case is behavior and C0 is types-only. Amend this plan to move that consumer file's change into C1 and re-review before proceeding.**
- [ ] **Step 5: Runtime test file asserts fixture values; commit** `feat(shared): freeze diagnosis contract (C0/W0.1)`.

### Task 2: Receipts payload (PR 2)

**Files:**
- Modify: `packages/ingestion/notify/event.go` (`DigestPayload`)
- Create: `packages/ingestion/notify/receipts_contract_test.go` (`package notify`, matching existing notify tests)
- Create: `packages/ingestion/notify/testdata/digest_payload_v1.json` (exact captured bytes, generated on main — step 1)
- Modify: `shared/src/types.ts` (**new** TS types — there is no existing TS digest payload type to extend; these are net-new mirrors for future TS consumers)
- Extend: `packages/worker/src/__tests__/contracts/c0-diagnosis.fixture.ts` sibling `c0-receipts.fixture.ts`

**Interfaces (frozen here; produced/consumed from C4 on):**

```go
// ReceiptItem is one digest card. Kind: "error" | "friction" | "cluster".
type ReceiptItem struct {
	Kind               string   `json:"kind"`
	IncidentID         string   `json:"incident_id"`
	Title              string   `json:"title"`
	OccurrenceCount    int64    `json:"occurrence_count"`
	ImpactClass        string   `json:"impact_class,omitempty"` // blocked|degraded|invisible|"" unknown
	ImpactVisits       *int64   `json:"impact_visits,omitempty"`
	ImpactRecovered    *int64   `json:"impact_visits_recovered,omitempty"`
	ReceiptState       string   `json:"receipt_state"` // pr_open|attempt_failed_diff|attempt_failed_no_diff|report_ready
	PRURL              string   `json:"pr_url,omitempty"`
	SessionURL         string   `json:"session_url,omitempty"`
	RootCauseExcerpt   string   `json:"root_cause_excerpt,omitempty"`
	MitigationExcerpt  string   `json:"mitigation_excerpt,omitempty"`
	HasSavedDiff       bool     `json:"has_saved_diff,omitempty"`
	ClusterIncidentIDs []string `json:"cluster_incident_ids,omitempty"` // kind=cluster only; no producer/renderer in this program
}
```

`DigestPayload` gains exactly two fields, appended last: `SchemaVersion int \`json:"schema_version,omitempty"\`` and `ReceiptItems []ReceiptItem \`json:"receipt_items,omitempty"\``. (`omitempty` semantics verified: zero int, nil/empty slice, and false bool are omitted; non-nil pointers to zero are kept — which is why the impact counters are pointers.)

TS: `shared/src/types.ts` gains `ReceiptItem` (snake_case fields matching the JSON tags, counts as `number`) and `DigestReceiptFields { schema_version?: number; receipt_items?: ReceiptItem[] }`.

- [ ] **Step 1: Capture the golden with a shared generator:** add `packages/ingestion/notify/testdata_gen.go` (or a `legacyPopulatedPayload()` helper in the test file) that deterministically constructs the fully-populated legacy `EventPayload{Digest: ...}`. Copy that one helper into a main worktree, run it there to write `testdata/digest_payload_v1.json` (raw `json.Marshal` bytes, no trailing newline), and commit both the helper and the golden on the branch — capture and assertion use the same construction, so the comparison is meaningful.
- [ ] **Step 2: Failing Go test** (red because `ReceiptItem` is undefined):

```go
func TestDigestPayloadByteIdenticalWhenReceiptFieldsUnset(t *testing.T) {
	p := legacyPopulatedPayload() // same construction as the golden generator
	b, err := json.Marshal(p)
	if err != nil { t.Fatal(err) }
	golden, err := os.ReadFile("testdata/digest_payload_v1.json")
	if err != nil { t.Fatal(err) }
	if !bytes.Equal(b, golden) { t.Fatalf("payload bytes changed:\n%s\nvs golden\n%s", b, golden) }
}

func TestReceiptItemRoundTrips(t *testing.T) {
	visits := int64(2)
	item := ReceiptItem{Kind: "error", IncidentID: "i", Title: "t", OccurrenceCount: 3,
		ImpactClass: "blocked", ImpactVisits: &visits, ReceiptState: "pr_open", PRURL: "https://github.com/x/1"}
	b, _ := json.Marshal(DigestPayload{Date: "d", SchemaVersion: 2, ReceiptItems: []ReceiptItem{item}})
	var back DigestPayload
	if err := json.Unmarshal(b, &back); err != nil { t.Fatal(err) }
	if back.SchemaVersion != 2 || len(back.ReceiptItems) != 1 || back.ReceiptItems[0].ImpactVisits == nil {
		t.Fatalf("round trip lost data: %+v", back)
	}
}
```

- [ ] **Step 3: Red run** (base worktree + overlaid test): compile FAIL. **Green run** after adding the types on the branch: both pass — byte-identity proven against the captured bytes, not a key set.
- [ ] **Step 4: TS fixture** `c0-receipts.fixture.ts` constructs a complete `ReceiptItem` literal **and a `DigestReceiptFields` literal** (`{ schema_version: 2, receipt_items: [item] }`); red via worker build on base overlay, green on branch. Note recorded here as the frozen decision: the cluster card is deliberately NOT a discriminated union — it is the flat `ReceiptItem` with `Kind: "cluster"` and `ClusterIncidentIDs` set; error-card fields are reused (title = cluster title, counts aggregated). C4 tolerates it unrendered; the convergence work later either lives with this shape or versions the payload again.
- [ ] **Step 5: Commit** `feat(notify): freeze receipts payload contract (C0/W0.2)`.

### Task 3: Migration 044 (PR 3)

**Files:**
- Create: `packages/ingestion/db/migrations/044_actionable_receipts_contracts.sql`
- Create: `packages/ingestion/db/migration_044_test.go` (`package db_test`, using the existing disposable-DB helpers, colocated with the other migration tests)

**Pre-step (names are load-bearing):** on a disposable DB with all migrations applied, run `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid IN ('diagnosis_decisions'::regclass,'error_group_jobs'::regclass) AND contype='c';` and substitute the real constraint names below.

**The migration** (every statement independently re-runnable; the runner is per-statement autocommit and re-executes this file on every startup):

```sql
-- 044_actionable_receipts_contracts.sql (C0). No writers exist yet.
-- The runner has no ledger and autocommits per statement: each statement is
-- guarded so any prefix of this file can re-run safely, forever.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'diagnosis_decisions'::regclass
      AND conname = 'diagnosis_decisions_outcome_check'
      AND convalidated
      AND pg_get_constraintdef(oid) =
        'CHECK ((outcome = ANY (ARRAY[''code_fix''::text, ''not_actionable''::text, ''needs_more_context''::text, ''incomplete''::text])))'
  ) THEN
    ALTER TABLE diagnosis_decisions DROP CONSTRAINT IF EXISTS diagnosis_decisions_outcome_check;
    ALTER TABLE diagnosis_decisions ADD CONSTRAINT diagnosis_decisions_outcome_check
      CHECK (outcome IN ('code_fix','not_actionable','needs_more_context','incomplete'));
  END IF;
END $$;
-- The guard compares the FULL normalized definition (capture the exact
-- pg_get_constraintdef output once after a manual apply and paste it here),
-- not a substring: a malformed constraint that merely mentions the value must
-- be replaced, not accepted.

ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS policy_eligible BOOLEAN;
ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS policy_basis JSONB;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'error_group_jobs'::regclass
      AND conname = 'error_group_jobs_triggered_by_check'
      AND convalidated
      AND pg_get_constraintdef(oid) =
        'CHECK ((triggered_by = ANY (ARRAY[''auto''::text, ''human''::text, ''reinvestigate_report_only''::text])))'
  ) THEN
    ALTER TABLE error_group_jobs DROP CONSTRAINT IF EXISTS error_group_jobs_triggered_by_check;
    ALTER TABLE error_group_jobs ADD CONSTRAINT error_group_jobs_triggered_by_check
      CHECK (triggered_by IN ('auto','human','reinvestigate_report_only'));
  END IF;
END $$;

ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS terminal_fix_job_id UUID
  REFERENCES error_group_jobs(id) ON DELETE SET NULL;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS impact_class TEXT
  CHECK (impact_class IN ('blocked','degraded','invisible'));
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS impact_visits BIGINT;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS impact_visits_recovered BIGINT;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS impact_computed_at TIMESTAMPTZ;

-- Tenant integrity: composite FKs need composite unique targets.
-- These are index builds on live tables during startup. At current scale
-- (thousands of rows) a blocking build is milliseconds; CONCURRENTLY is used
-- anyway so the pattern survives growth, with invalid-index recovery first
-- (a failed concurrent build leaves an INVALID index that IF NOT EXISTS would
-- silently trust). CONCURRENTLY is legal here because the runner autocommits
-- per statement (no wrapping transaction).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
             WHERE c.relname = 'ux_error_groups_id_project' AND NOT i.indisvalid) THEN
    DROP INDEX ux_error_groups_id_project;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
             WHERE c.relname = 'ux_error_group_jobs_id_project' AND NOT i.indisvalid) THEN
    DROP INDEX ux_error_group_jobs_id_project;
  END IF;
END $$;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_error_groups_id_project ON error_groups(id, project_id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_error_group_jobs_id_project ON error_group_jobs(id, project_id);

CREATE TABLE IF NOT EXISTS digest_readiness (
  incident_id UUID PRIMARY KEY,
  project_id  UUID NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('eligible','ineligible','pending')),
  reason      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (incident_id, project_id)
    REFERENCES error_groups(id, project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_digest_readiness_project ON digest_readiness(project_id, status);

CREATE TABLE IF NOT EXISTS fix_run_ledger (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  run_id        UUID NOT NULL,             -- groups one attempt's entries; retries get a fresh run_id
  entry_seq     INT  NOT NULL,
  command       TEXT NOT NULL,
  commit_sha    TEXT NOT NULL,
  workdir_dirty BOOLEAN NOT NULL,
  discovered    INT,
  passed        INT,
  failed        INT,
  skipped       INT,
  truncated     BOOLEAN NOT NULL DEFAULT false,
  timed_out     BOOLEAN NOT NULL DEFAULT false,
  not_run       JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(not_run) = 'array'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, entry_seq),
  FOREIGN KEY (job_id, project_id)
    REFERENCES error_group_jobs(id, project_id) ON DELETE RESTRICT
);
-- RESTRICT, not CASCADE: the ledger is the audit record of what verification
-- executed; deleting a job must not silently destroy it. A tenant-delete flow
-- that legitimately removes jobs must delete ledger rows first, explicitly.
CREATE INDEX IF NOT EXISTS idx_fix_run_ledger_job ON fix_run_ledger(job_id, created_at);
```

- [ ] **Step 1: DB-gated consumer test** (`package db_test`, full fixtures via the existing helpers — seed org/project/group/job so FK and NOT NULL columns are satisfied; `diagnosis_decisions` inserts include `decision_reason`, `model`, `prompt_version`). Red/green is per capability:
  - RED before migration (the test COMPILES and fails at runtime against the pre-044 schema — per-capability failure modes recorded): insert decision with `outcome='incomplete'` → constraint error (old check); select `policy_eligible`, impact columns, `terminal_fix_job_id` → undefined-column errors; select from `digest_readiness` / `fix_run_ledger` → undefined-table errors; insert job with `triggered_by='reinvestigate_report_only'` → constraint error.
  - GREEN after: all of the above succeed, plus: `policy_basis` JSONB round-trips a `{"v":1,...}` object; a `fix_run_ledger` insert duplicating `(run_id, entry_seq)` is rejected; `impact_class='bogus'` rejected; `terminal_fix_job_id` pointing at a nonexistent job rejected; deleting a job referenced by `terminal_fix_job_id` nulls the column (SET NULL asserted); deleting a job with ledger rows is rejected (RESTRICT asserted).
  - **Guard checks (pass both before and after, marked as such):** `outcome='bogus'` and `triggered_by='bogus'` rejected; `digest_readiness` insert with a mismatched `(incident_id, project_id)` pair rejected; `not_run` set to `'{}'::jsonb` rejected.
- [ ] **Step 2: Idempotency drill (AC0.2):** apply 044 fully three times → identical state. Then, on fresh DBs, apply each prefix and re-run the whole file → identical final state each time. **There is no statement splitter to reuse** (`run-migrations.sh` feeds whole files to `psql`), so the prefixes are materialized by hand as numbered files under `packages/ingestion/db/testdata/migration_044_prefixes/` (one per statement boundary; a `DO $$…$$` block is one prefix step), generated once from the final SQL and committed. "Identical state" is compared as a normalized schema snapshot (the mechanism the existing migration tests use — reuse it), not raw catalogs, since OIDs differ across databases.
- [ ] **Step 3: Commit** `feat(db): migration 044 — actionable program contracts (C0/W0.3)`.

### Task 4: Worker ledger and tier types (PR 4)

**Files:**
- Create: `packages/worker/src/verification-ledger.ts`
- Create: `packages/worker/src/__tests__/contracts/c0-ledger.fixture.ts` + runtime assertions in `c0-contracts.test.ts`

**Interfaces (consumed by C2's harness, judge, PR-body rendering). Named `VerificationTier` — shared already exports an unrelated `EvidenceTier = 'E0'|'E1'|'E2'` and this must not collide or shadow it; the relationship between the two is C2's to reconcile, recorded in that plan:**

```ts
export type VerificationTier = 'reproduced' | 'checked' | 'attempted';

/** One executed command, recorded by harness code only. Mirrors fix_run_ledger. */
export interface LedgerEntry {
  jobId: string;
  projectId: string;
  runId: string;
  entrySeq: number;
  command: string;
  commitSha: string;
  workdirDirty: boolean;
  discovered: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  truncated: boolean;
  timedOut: boolean;
  notRun: string[];
}

/** The mechanical grade of one fix attempt, derived from ledger entries. */
export interface TierRecord {
  tier: VerificationTier;
  /** The declared expected-failure contract, when tier is 'reproduced'. */
  declaredTest: { identifier: string; expectedAssertion: string } | null;
  /** Why reproduction was declared impossible, when tier is 'checked'. */
  reproductionImpossibleReason: string | null;
}
```

- [ ] Steps: fixture constructs complete literals of all three tier variants and a full `LedgerEntry` (red on base overlay via worker build; green on branch); runtime assertions; `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test` green; commit `feat(worker): freeze ledger and verification-tier types (C0/W0.4)`.

### Task 5: CP0 verification run

- [ ] **Step 1 (AC0.1):** base worktree + overlay of the three fixture files and two Go test files → worker build fails (types absent); the notify contract test fails to compile (`ReceiptItem` undefined); the migration test compiles and fails at runtime against the pre-044 schema (per-capability failures as listed in Task 3). On the branch → all green. Grep fixtures/tests for `as unknown as|as any|@ts-expect-error` → zero hits.
- [ ] **Step 2 (AC0.2):** attach the idempotency-drill output to PR 3.
- [ ] **Step 3 (AC0.3, drivable):** stack up with worktree ports; POST one browser event to `/api/v1/events` → accepted; the Task 2 byte-identity test is the digest half of this criterion, and one rendered digest from prod-shaped seed on branch vs main is diffed as the end-to-end confirmation.
- [ ] **Step 4 (AC0.4):** `git diff main -- test-fixtures/wire/` → empty.
- [ ] **Step 5:** `pnpm -r build && pnpm test` (DATABASE_URL exported; skip counts read), `(cd packages/ingestion && go build ./... && go test ./...)` → zero skips. Merge the four PRs in order 1→4.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found → addressed | R1: 11 P1 / 6 P2 / 2 P3; R2: 4 P1 / 10 P2 / 1 P3; all folded in |

**CODEX:** Two iterations against the live repo (session `019fed7c`). Round 1: shared has no test tooling (fixtures moved to worker tsc), Vitest type-erasure invalidated the red tests, Diagnosis fields had to be optional, the migration runner is ledgerless per-statement autocommit (constraint swaps became guarded DO blocks), missing FK/tenant integrity, EvidenceTier name collision. Round 2: confirmed all prior P1s resolved; added the nonexistent statement-splitter (prefix files materialized by hand), concurrent index builds with invalid-index recovery, the missing Diagnosis and DigestReceiptFields fixtures, exact-definition constraint guards, RESTRICT on the audit ledger, the shared golden generator, and normalized-schema-snapshot comparison. All folded in.

**VERDICT:** CODEX CLEARED after two iterations.

**UNRESOLVED DECISIONS:**
- The cluster card is frozen as a flat `ReceiptItem` variant (`Kind: "cluster"`), not a discriminated union — recorded as the deliberate contract; the post-program convergence work either lives with it or re-versions the payload.
