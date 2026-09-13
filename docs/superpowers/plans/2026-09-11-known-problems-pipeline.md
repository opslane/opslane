# Known-Problems Pipeline Implementation Plan (rev 9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace category+route friction buckets with a persistent, per-environment list of known problems ("tickets"), matched per recording by a cheap model, created by a strong model on first sight, verified by strong-model re-reads with screenshots, and published to one digest list only when verified.

**Architecture:** The narrator and frame verification are unchanged except for their output shape and a stricter grade policy. Every observation becomes one immutable atomic evidence row. A session-scoped job matches each observation to a ticket or drafts one; decisions are recorded in a ledger keyed by the immutable observation, so retries and concurrent jobs cannot create two tickets from one observation. Tickets accumulate matches with monotonic arrival numbers. A ticket-scoped batch job stages checks and a fenced finalizer promotes them and applies exactly one lifecycle transition from the rulebook. Publication calls `activateGeneration`, which creates an `error_groups` projection with a generation-specific fingerprint and generation-specific evidence membership; investigation, fix, PR, and digest code is fenced by generation and fix-attempt id. The customer sees one list, one card, one button, with users/sessions/accounts derived only from finalized confirmed checks.

**Tech Stack:** TypeScript worker (Node 22, Vitest, fast-check for invariants), Go ingestion (chi, pgx), Postgres 16 + pgvector (`pgvector/pgvector:pg16` in Compose; `CREATE EXTENSION vector` on RDS PG16), Anthropic (Haiku 4.5 cheap, Sonnet 5 strong), OpenAI `text-embedding-3-small`.

**Spec:** `docs/design/2026-09-11-known-problems-pipeline.md` (rev 5). **Rulebook:** `docs/design/2026-09-11-known-problems-lifecycle.md` (rev 4). Task 9 implements the rulebook cell by cell; every other rulebook event is assigned in the event map below.

## Scope for the first cutover

In: Tasks 1–13. Automatic PR initiation follows the existing `projects.friction_autonomy` setting (`004_friction.sql:96`), reduced to `ask_first` (default) and `auto_fix` (`auto_fix_ux` removed in Task 1 by widening rows to `auto_fix` and narrowing the CHECK); `auto_fix` applies to every verified ticket regardless of kind; a cap of 5 open fix PRs per project (`FRICTION_MAX_OPEN_FIX_PRS`, counted from attempts in `pr_open`) pauses auto-fix. Folding at the publish gate is in, with the rulebook's "matches only" rule and its test. Out: sweep, proposals, revisions, extrapolated counts, dashboard ticket UI, frames-first narration, cross-environment fix dedupe.

## Global Constraints

- Migrations replay on every boot with no ledger (`scripts/run-migrations.sh`); every statement is idempotent; editing a shipped migration in place is accepted (precedent 065). Next file is `074`. `error_groups` has `UNIQUE(project_id, fingerprint)` (`001_baseline.sql:95`); `sessions.id` is `TEXT`; the queue is `error_group_jobs` with `session_id TEXT` and `available_at` (claim at `db.ts:657`).
- No model calls inside a database transaction or while holding an advisory lock.
- New job types: `JobType` (`shared/src/types.ts:554`), `claimJob` allow-list and caps (`db.ts:659-678`), `ClaimedJob` mapping + `RETURNING` (add `ticket_id`, `batch_id`, `publication_generation`, `fix_attempt_id`), dispatch (`index.ts:345-487`). Rescheduling uses `available_at` and `throw new JobRescheduledError(job.id)` (`db.ts:778`, `poller.ts:210`).
- Every model call is metered via `PhaseMeter` under a phase unique per batch (`friction_confirm:<batch_id>`), because the usage ledger dedupes on (job, execution, phase, model). New model ids go in both price maps (`investigate.ts:57`, `harness/agent-loop.ts:9`).
- Customer-facing numbers: users, sessions, accounts over **finalized confirmed** checks of the live generation's cohort, 7-day window on the recording's `occurred_at`. Nothing else renders.
- Held-back tickets are internal only.
- Tests colocated in `__tests__`; DB tests `*.integration.test.ts` under `describeDb`; run with `DATABASE_URL`, zero skips.

## Event map (rulebook event → handler → task)

| Rulebook event | Handler | Task |
| --- | --- | --- |
| New recording matches | `friction_match` job → `recordMatch` | 8 |
| Batch selected / check staged / batch finalizes | `friction_confirm` job → `selectBatch`, `stageCheck`, `finalizeBatch` | 9 |
| Duplicate check + fold | finalizer → `judgeOneFix` (outside lock), `foldInto` (inside) | 9 |
| activate_generation (publish, republish, regression) | `activateGeneration` | 9 |
| Investigation finishes | `processFrictionInvestigateJob` → `recordInvestigation` | 10 |
| Fix request / attempt start / fail | `requestFix` (API + autonomy) → fix job → `attemptFailed` | 10 |
| PR opened / closed / merged | `ProcessPRWebhook` (Go) → `friction_pr_event` job → `applyPrEvent` | 10 |
| Recording deleted | Go purge path → `friction_reconcile_after_delete()` SQL function | 11 |
| Recording identity changed | identify path → `friction_reconcile` job | 11 |
| Reconcile tick | `friction_reconcile` job → `reconcileTicket` | 11 |
| Person archives | `ArchiveErrorGroup` (Go, `queries.go:2768`) → `archiveTicket` | 11 |
| Digest render | Go freeze/validate/notify + worker writer | 12 |
| Cutover retirement + backfill | `scripts/retire-friction-buckets.sql`, `backfill-tickets` | 13 |

---

### Task 1: Migration 074 and in-place edits to 068 and 069

**Files:** Create `packages/ingestion/db/migrations/074_friction_tickets.sql`, `packages/ingestion/db/migration_074_test.go`. Modify `068_session_narratives.sql:46-53` (add `'narrative'` to the CHECK), `069_verdict_gated_investigation.sql` (first statement `ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS ticket_id UUID;` then `AND ticket_id IS NULL` on its UPDATE and INSERT WHERE), `docker-compose.yml:36,186` (`pgvector/pgvector:pg16`).

- [ ] **Step 1: Failing test** — run every migration on an EMPTY database (fresh-install path, not only after `migratedPool`); assert all new tables exist; insert a `narrative` signal plus a populated ticket, batch, attempt, check, and fix attempt, then replay every migration again and assert all rows survive; 069 leaves a ticket-backed group alone; two `error_groups` rows for one ticket with generations 1 (archived) and 2 (live) coexist with distinct fingerprints and a second live row is rejected; `error_groups_ticket_id_fkey` exists after a fresh install (069 ran before 074).
- [ ] **Step 2: Run** `cd packages/ingestion && go test ./db -run 'TestMigration074|TestMigrations' -v` → FAIL.
- [ ] **Step 3: Migration**

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('074_friction_tickets'));
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS friction_tickets (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id         UUID NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,           -- immutable
  control                TEXT NOT NULL,           -- immutable
  what_happened          TEXT NOT NULL,           -- immutable
  steps                  TEXT,                    -- presentation, regenerated
  kind                   TEXT NOT NULL CHECK (kind IN ('defect','ux_insight')),  -- internal only
  screens_confirmed      TEXT[] NOT NULL DEFAULT '{}',
  screens_proposed       TEXT[] NOT NULL DEFAULT '{}',
  status                 TEXT NOT NULL DEFAULT 'tracking' CHECK (status IN ('tracking','published','unpublished','merged','archived')),
  embedding              vector(1536),
  embedding_model        TEXT,
  matched_count          INT NOT NULL DEFAULT 0,
  next_arrival_number    BIGINT NOT NULL DEFAULT 0,
  arrival_boundary       BIGINT NOT NULL DEFAULT 0,
  evidence_version       INT NOT NULL DEFAULT 0,
  live_generation        INT NOT NULL DEFAULT 0,
  fold_retries           INT NOT NULL DEFAULT 0,
  fixed_at               TIMESTAMPTZ,
  cohort_cutoff          TIMESTAMPTZ,            -- recordings at or before this never count; set to fixed_at on merge, kept on regression
  reconcile_needed       BOOLEAN NOT NULL DEFAULT false,
  reinvestigate_needed   BOOLEAN NOT NULL DEFAULT false,
  merged_into            UUID REFERENCES friction_tickets(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_friction_tickets_env_status ON friction_tickets (project_id, environment_id, status);
CREATE INDEX IF NOT EXISTS idx_friction_tickets_screens ON friction_tickets USING GIN (screens_confirmed);

-- Atomic evidence: one row per narrator observation, immutable once written.
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS observation_id TEXT;
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS evidence_lines JSONB;
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS narrative_id TEXT;  -- derived, never null for atomic rows (Task 2)
CREATE UNIQUE INDEX IF NOT EXISTS idx_friction_signals_atomic ON friction_signals (session_id, narrative_id, observation_id) WHERE observation_id IS NOT NULL;

-- Source-decision ledger: exactly one decision per atomic observation. Serializes ticket creation.
CREATE TABLE IF NOT EXISTS friction_observation_decisions (
  signal_id      UUID PRIMARY KEY REFERENCES friction_signals(id) ON DELETE CASCADE,
  project_id     UUID NOT NULL,
  environment_id UUID NOT NULL,
  session_id     TEXT NOT NULL,
  decision       TEXT NOT NULL CHECK (decision IN ('reserved','matched','created','not_a_problem')),
  ticket_id      UUID REFERENCES friction_tickets(id),
  CONSTRAINT friction_decision_ticket_required CHECK (decision NOT IN ('matched','created') OR ticket_id IS NOT NULL),
  decided_by     TEXT NOT NULL CHECK (decided_by IN ('cheap','strong','fold')),
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS friction_ticket_matches (          -- counting unit
  ticket_id      UUID NOT NULL REFERENCES friction_tickets(id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id     UUID NOT NULL,
  environment_id UUID NOT NULL,
  end_user_id    UUID,
  arrival_number BIGINT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('cheap','strong','backfill','fold')),
  occurred_at    TIMESTAMPTZ NOT NULL,
  matched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, session_id),
  UNIQUE (ticket_id, arrival_number)
);
CREATE TABLE IF NOT EXISTS friction_ticket_match_observations ( -- evidence unit
  ticket_id      UUID NOT NULL,
  session_id     TEXT NOT NULL,
  signal_id      UUID NOT NULL REFERENCES friction_signals(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, session_id, signal_id),
  FOREIGN KEY (ticket_id, session_id) REFERENCES friction_ticket_matches(ticket_id, session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS friction_session_processed (
  project_id   UUID NOT NULL,
  session_id   TEXT NOT NULL,
  narrative_id TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, session_id, narrative_id)
);

CREATE TABLE IF NOT EXISTS friction_confirm_batches (          -- immutable batch identity
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id                  UUID NOT NULL REFERENCES friction_tickets(id) ON DELETE CASCADE,
  job_id                     UUID NOT NULL,
  manifest                   JSONB NOT NULL,
  arrival_boundary_at_select BIGINT NOT NULL,
  live_generation_at_select  INT NOT NULL,
  status_at_select           TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','finalized','discarded')),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at               TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS friction_check_attempts (           -- staging and forensic history
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       UUID NOT NULL REFERENCES friction_confirm_batches(id) ON DELETE CASCADE,
  ticket_id      UUID NOT NULL,
  session_id     TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('confirmed','refuted','inconclusive','unavailable')),
  evidence_lines JSONB NOT NULL DEFAULT '[]',
  signal_ids     JSONB NOT NULL DEFAULT '[]',
  note           TEXT NOT NULL DEFAULT '',
  cost_to_user   TEXT CHECK (cost_to_user IN ('none','annoyance','lost_time','abandoned_task')),
  frames_ok      BOOLEAN NOT NULL DEFAULT false,
  frame_manifest JSONB NOT NULL DEFAULT '[]',
  model          TEXT NOT NULL,
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, session_id),
  FOREIGN KEY (ticket_id, session_id) REFERENCES friction_ticket_matches(ticket_id, session_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS friction_checks (                    -- authoritative, finalized; at most one per (ticket, session)
  ticket_id      UUID NOT NULL,
  session_id     TEXT NOT NULL,
  attempt_id     UUID NOT NULL REFERENCES friction_check_attempts(id),
  outcome        TEXT NOT NULL CHECK (outcome IN ('confirmed','refuted','inconclusive')),
  finalized_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, session_id),
  FOREIGN KEY (ticket_id, session_id) REFERENCES friction_ticket_matches(ticket_id, session_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS friction_unavailable_retries (       -- retry state, separate from evidence
  ticket_id      UUID NOT NULL,
  session_id     TEXT NOT NULL,
  attempts       INT NOT NULL DEFAULT 0,
  retry_at       TIMESTAMPTZ,
  permanent      BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (ticket_id, session_id),
  FOREIGN KEY (ticket_id, session_id) REFERENCES friction_ticket_matches(ticket_id, session_id) ON DELETE CASCADE
);

-- Generation-specific incident evidence membership; history preserved across generations.
CREATE TABLE IF NOT EXISTS friction_incident_evidence (
  error_group_id UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  ticket_id      UUID NOT NULL,
  generation     INT NOT NULL,
  signal_id      UUID NOT NULL REFERENCES friction_signals(id) ON DELETE CASCADE,
  PRIMARY KEY (error_group_id, signal_id)
);
CREATE TABLE IF NOT EXISTS friction_fix_attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      UUID NOT NULL REFERENCES friction_tickets(id) ON DELETE CASCADE,
  error_group_id UUID NOT NULL REFERENCES error_groups(id),
  generation     INT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active','pr_open','failed','merged','closed','superseded')),
  pr_url         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fix_attempts_outstanding ON friction_fix_attempts (ticket_id, generation) WHERE status IN ('active','pr_open');

ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS ticket_id UUID;   -- 069 may have created it without the FK
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'error_groups_ticket_id_fkey') THEN
    ALTER TABLE error_groups ADD CONSTRAINT error_groups_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES friction_tickets(id);
  END IF;
END $$;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS publication_generation INT;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS fix_substate TEXT CHECK (fix_substate IN ('none','fixing','pr_open','resolved'));
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS investigation_status TEXT CHECK (investigation_status IN ('pending','done','failed'));
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS evidence_version_used INT;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS explained_signal_ids JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS idx_error_groups_ticket_generation ON error_groups (ticket_id, publication_generation) WHERE ticket_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_error_groups_live_ticket ON error_groups (ticket_id) WHERE ticket_id IS NOT NULL AND status <> 'archived';

ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS ticket_id UUID REFERENCES friction_tickets(id) ON DELETE CASCADE;
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS batch_id UUID;
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS publication_generation INT;
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS fix_attempt_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_friction_confirm_pending ON error_group_jobs (ticket_id) WHERE job_type = 'friction_confirm' AND status IN ('pending','claimed');
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_friction_match_pending ON error_group_jobs (session_id) WHERE job_type = 'friction_match' AND status IN ('pending','claimed');
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_friction_reconcile_pending ON error_group_jobs (ticket_id) WHERE job_type = 'friction_reconcile' AND status IN ('pending','claimed');

-- Same-transaction reconcile after a recording is purged (rulebook: Recording deleted; invariant 9).
-- Callers MUST invoke this AFTER the session delete has executed in the same transaction, so the counts below exclude the purged recording.
CREATE OR REPLACE FUNCTION friction_reconcile_after_delete(p_ticket UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t friction_tickets%ROWTYPE; g error_groups%ROWTYPE; confirmed INT; counted INT; users INT; identity BOOLEAN;
BEGIN
  SELECT * INTO t FROM friction_tickets WHERE id = p_ticket FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE friction_tickets SET matched_count = (SELECT count(*) FROM friction_ticket_matches WHERE ticket_id = p_ticket), evidence_version = evidence_version + 1, reconcile_needed = true, updated_at = now() WHERE id = p_ticket;
  IF t.status <> 'published' THEN RETURN; END IF;
  SELECT * INTO g FROM error_groups WHERE ticket_id = p_ticket AND status <> 'archived';
  IF NOT FOUND OR g.fix_substate = 'resolved' THEN RETURN; END IF;
  SELECT count(*) FILTER (WHERE c.outcome = 'confirmed'), count(*),
         count(DISTINCT m.end_user_id) FILTER (WHERE c.outcome = 'confirmed' AND m.end_user_id IS NOT NULL),
         bool_or(c.outcome = 'confirmed' AND m.end_user_id IS NOT NULL)
    INTO confirmed, counted, users, identity
    FROM friction_checks c JOIN friction_ticket_matches m USING (ticket_id, session_id)
   WHERE c.ticket_id = p_ticket AND (t.cohort_cutoff IS NULL OR m.occurred_at > t.cohort_cutoff);
  IF confirmed < 3 OR (identity AND users < 2) OR (counted >= 10 AND confirmed::float / counted < 0.25) THEN
    UPDATE error_groups SET status_before_archive = status, status = 'archived', archived_at = now(), updated_at = now() WHERE id = g.id;
    UPDATE friction_tickets SET status = 'unpublished', updated_at = now() WHERE id = p_ticket;
    UPDATE error_group_jobs SET status = 'failed', last_error = 'unpublished' WHERE error_group_id = g.id AND status IN ('pending','claimed') AND job_type IN ('investigate','fix');
    UPDATE friction_fix_attempts SET status = 'superseded', updated_at = now() WHERE error_group_id = g.id AND status IN ('active','pr_open');
    UPDATE digest_card_copy SET invalidated_at = now() WHERE error_group_id = g.id AND invalidated_at IS NULL;
  ELSE
    UPDATE digest_card_copy SET invalidated_at = now() WHERE error_group_id = g.id AND invalidated_at IS NULL;
  END IF;
END $$;
COMMIT;
```

Projection fingerprint: `sha256('ticket|' + ticket.id + '|' + generation)`, so `UNIQUE(project_id, fingerprint)` holds across generations.

- [ ] **Step 4: Run** the tests, `scripts/check-migration-reapply.sh`, `docker compose config --quiet` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(db): friction tickets, atomic evidence, decision ledger, batches, checks, fix attempts; keep 068/069 replay-safe"`

---

### Task 2: Observation shape v3 and atomic evidence rows

**Files:** `shared/src/types.ts:346-352`; `packages/worker/src/narrative/{prompt,validate,emit}.ts`; `packages/worker/src/friction/persist.ts`; tests `narrative/__tests__/{validate,emit}.test.ts`, `friction/__tests__/persist.integration.test.ts`.

**Interfaces:** `NarrativeObservation { id; what; evidenceLines; category?; severity? }`; `NARRATIVE_PROMPT_VERSION = 3` (schema `{"what","evidence_lines"}`; nine definitions kept as "kinds of difficulty to look for"; "say what the screen showed; do not claim something did not happen unless consecutive lines make it clear"); `id = ${index}-${sha256(what).slice(0,4)}`; `buildSignalRows(timeline, observations, sessionId, narrativeId)` → one row per observation (`signalType 'narrative'`, `fingerprint sha256(sessionId|narrativeId|observation.id).slice(0,32)`, `observationId`, `narrativeId`, `evidenceLines`, `occurrenceCount 1`); `writeObservationSignals` inserts `ON CONFLICT (session_id, narrative_id, observation_id) WHERE observation_id IS NOT NULL DO NOTHING` (the predicate must match the partial index) and returns `{ signalId, observationId }[]` including pre-existing rows. `narrativeId` is `sha256(session_id || '|' || NARRATIVE_PROMPT_VERSION || '|' || narrative_created_at)` stored as UUID-shaped text: `session_narratives` is keyed by session (text) and has no row id, so the narrative identity is derived deterministically from the session, the prompt version, and the row's `created_at`, and is never null.

- [ ] Tests: validate accepts `what` + `evidence_lines` only; emit gives two rows for two observations citing the same line with distinct fingerprints; persist is idempotent and returns ids. FAIL → implement → PASS → `pnpm -r build` → commit `feat(narrative): prompt v3, atomic evidence rows`.

---

### Task 3: Frame policy and moment selection without severity

**Files:** create `friction/absence.ts`; modify `narrative/verify.ts:104-125` (`selectMoments` by evidence-line count desc, then first line), `:156-280` (`gradedObservations(narrative, grades, { framesOk })`); tests.

**Rules:** keep `confirmed`; keep `corrected` with replaced `what` unless `claimsAbsence(replacement)`; drop `refuted` and `inconclusive`; when `framesOk` is false (capture threw, assets missing, malformed output, budget), drop observations that `claimsAbsence(what)` and keep the rest as unverified.

- [ ] Tests → implement → commit `feat(narrative): drop inconclusive grades; absence claims require frame confirmation`.

---

### Task 4: Embedding client

**Files:** `packages/worker/src/embeddings.ts`; `__tests__/embeddings.test.ts`; both price maps.

**Interfaces:** `EMBEDDING_MODEL`, `EMBEDDING_DIMS = 1536`, `class EmbeddingsUnavailable`, `embedTexts(texts, meter?) → { vectors, model }` (batches of 100, 20 s timeout, two retries on 429/5xx, dims validated, throws `EmbeddingsUnavailable` when `OPENAI_API_KEY` is unset or after retries), `ticketText(t)`.

- [ ] Tests → implement with `fetch` → commit.

---

### Task 5: Ticket store

**Files:** `friction/tickets-db.ts`; `friction/__tests__/tickets-db.integration.test.ts`.

**Interfaces (scoped by `{ projectId, environmentId }`; functions marked *tx* run inside a transaction holding `SELECT ... FOR UPDATE` on the ticket row):**
```ts
export interface TicketRow { id; project_id; environment_id; name; control; what_happened; steps; kind; screens_confirmed; screens_proposed; status; matched_count; arrival_boundary; next_arrival_number; evidence_version; live_generation; fold_retries; fixed_at; reconcile_needed; reinvestigate_needed }
export interface CohortStats { counted; confirmed; refuted; inconclusive; confirmedUsers; identityKnown }
export async function createTicket(db /*tx*/, t, embedding?): Promise<TicketRow>
export async function shortlistTickets(db, scope, screensVisited, observationEmbedding|null, k=10): Promise<TicketRow[]>   // screens_confirmed overlap (≤20) ∪ top 10 by finalized confirmed checks ∪ k nearest; excludes merged/archived; deterministic order
export async function nearestTickets(db, scope, embedding, k=10, statuses): Promise<Array<TicketRow & { similarity }>>  // embedding_model = $model
export async function reserveDecision(db /*tx*/, signalId, scope): Promise<{ reserved: boolean; existing?: DecisionRow }>  // INSERT (signal_id, decision='reserved', ticket_id NULL) ON CONFLICT DO NOTHING RETURNING; a row with decision='reserved' older than the job lease is treated as abandoned and may be taken over
export async function commitDecision(db /*tx*/, signalId, d: { decision: 'matched'|'created'|'not_a_problem'; ticketId?; decidedBy }): Promise<void>  // UPDATE the reservation; CHECK constraint: decision IN ('matched','created') ⇒ ticket_id IS NOT NULL
export async function recordMatch(db /*tx*/, m: { ticket; sessionId; endUserId; source; occurredAt; screen; signalIds }): Promise<{ newRecording: boolean }>  // arrival_number = next_arrival_number++ under the row lock; ON CONFLICT DO NOTHING; match_observations per signal; screens_proposed; sessions.retain_until += 90 d (from promotion.ts:88-95)
export async function selectBatch(db /*tx*/, ticket, jobId): Promise<{ batchId; sessionIds } | null>  // selectable = matched AND no friction_checks row AND (no retry row OR (retry_at <= now() AND NOT permanent)); n = arrival_boundary===0 && matched_count>50 ? 30 : 10; round-robin by end_user_id, oldest arrival first; inserts friction_confirm_batches with *_at_select; sets arrival_boundary = max arrival_number; null when nothing selectable
export async function stageCheck(db, batchId, r): Promise<void>            // friction_check_attempts insert (UNIQUE batch/session); 'unavailable' upserts friction_unavailable_retries (attempts+1; retry_at +1h/+6h/+24h; permanent after 3)
export async function finalizeBatch(db /*tx*/, ticket, batchId): Promise<{ stats: CohortStats; evidenceVersion }>  // batch → finalized; non-unavailable attempts → friction_checks ON CONFLICT DO NOTHING; retry rows for confirmed/refuted/inconclusive deleted; evidence_version+1
export async function discardBatch(db /*tx*/, batchId): Promise<void>       // batch → discarded; attempts kept; no friction_checks; reconcile_needed = true
export async function cohortStats(db, ticket): Promise<CohortStats>         // over friction_checks joined to matches WHERE occurred_at > cohort_cutoff (NULL = all)
export function evaluateBar(s: CohortStats, ctx: { status; fixSubstate }): 'passes'|'fails'|'undecided'   // rulebook: The bar
export async function activateGeneration(db /*tx*/, ticket, cohort, steps): Promise<{ errorGroupId; generation }>  // rulebook: One activation transition; archives previous live incident; fingerprint includes generation; friction_incident_evidence for confirmed signals; friction_signals.incident_id repointed (pointer only); actionable_since = now(); investigate job stamped with generation; status → published; live_generation+1; fixed_at NULL; cohort_cutoff unchanged (regression keeps excluding pre-fix evidence)
export async function unpublish(db /*tx*/, ticket): Promise<void>           // mirrors friction_reconcile_after_delete's unpublish branch
export async function foldInto(db /*tx*/, source, target): Promise<void>    // rulebook: Duplicate check; matches + observation refs copied with fresh target arrival numbers (ON CONFLICT DO NOTHING per recording); no checks copied; decisions repointed decided_by 'fold'; source → merged; source's pending confirm job cancelled; target arrival trigger evaluated
export async function verifiedEvidence(db, ticket, window?): Promise<{ users; sessions; accounts; sessionIds; signalIds; representative }>  // the ONE canonical query for customer-facing numbers, investigator input, and the representative (median cost_to_user)
```

- [ ] **Integration test:** ledger rejects a second decision for the same signal; same session twice → one match, `matched_count` 1, arrival numbers strictly increasing; `selectBatch` never returns a checked session, returns a due retry, returns null when nothing selectable, sets `arrival_boundary`; `finalizeBatch` promotes exactly the batch's attempts; `discardBatch` leaves the session selectable and attempts intact; `cohortStats` ignores staged attempts and pre-`fixed_at` checks; `activateGeneration` twice → two `error_groups` rows, one archived, distinct fingerprints, generation-1 evidence rows intact; `foldInto` copies matches not checks; `verifiedEvidence` excludes staged and out-of-window rows.
- [ ] FAIL → implement → PASS (zero skips) → commit `feat(friction): ticket store`.

---

### Task 6: Cheap pass

**Files:** `friction/match.ts`; `friction/__tests__/match.test.ts`. `matchObservations(client, { projectName, screens, timelineText, observations, candidates }, meter) → { decisions } | { invalid }`; strict validation (each observation exactly once; ticket ids within candidates); enumerate-first prompt.

- [ ] Tests → implement → commit.

---

### Task 7: First careful look

**Files:** `friction/first-look.ts`; test. `firstLook(client, { projectName, screens, timelineText, drafts, nearestPerDraft }, meter) → { decisions } | { invalid }`; `same_as` must be within that draft's nearest list; `create` requires all fields; softened reviewer prompt (reject only normal use, idle, visible success; laborious-but-working is `ux_insight`).

- [ ] Tests → implement → commit.

---

### Task 8: `friction_match` job and the narrative seam

**Files:** `shared/src/types.ts:554` (`friction_match | friction_confirm | friction_reconcile | friction_pr_event`); `db.ts` (claim allow-list; caps `FRICTION_MATCH_MAX_CONCURRENT=2`, `FRICTION_CONFIRM_MAX_CONCURRENT=1`; `RETURNING` + `ClaimedJob` fields; `enqueueJobTx(client, type, projectId, { sessionId?, ticketId?, batchId?, publicationGeneration?, fixAttemptId?, availableAt? })`); finishers `db.ts:3899-3902,4052-4055` call `enqueueJobTx(client, 'friction_match', …)` inside the transaction and no longer call `runPromotionCheck`; `index.ts` dispatch; create `friction/match-job.ts`; tests.

**Flow:** load narrative, timeline, verification, `framesOk` → `gradedObservations` → `writeObservationSignals` (idempotent; this is also how backfill converts stored narratives to atomic rows) → drop observations that already have a ledger decision → screens visited → embed each sentence (or null) → `shortlistTickets` → one `matchObservations` call → drafts: `nearestTickets` → `firstLook` → **transaction**: for each decision: `reserveDecision`; if it returns an `existing` committed row, use its `ticket_id` (or skip when `not_a_problem`); otherwise lock the target ticket, `createTicket` if the decision is `create`, then `commitDecision` with the ticket id, then `recordMatch`; reserve → create → commit → match are one transaction, so a retry never sees a ticketless committed decision; evaluate the arrival trigger for touched tickets and `enqueueJobTx('friction_confirm')`. Invalid model output → retry once → job fails with `last_error`, nothing written. Meter phases `friction_match`, `friction_first_look`, `embeddings`.

- [ ] Unit: match + create; `existing` path prevents duplicate create; invalid twice → no writes. Integration: two problems in one recording → two tickets, one observation each; two concurrent match jobs proposing the same new problem from different sessions → no crash, ledger consistent (the fold handles the rest); finisher rollback → no job row.
- [ ] FAIL → implement → PASS → commit.

---

### Task 9: `friction_confirm` — the rulebook

**Files:** modify `narrative/frames/capture.ts:103` (`opts.maxOffsets`); create `friction/confirm.ts`, `friction/confirm-job.ts`, `friction/one-fix.ts`; tests `friction/__tests__/{confirm.test.ts, confirm-job.integration.test.ts, lifecycle.property.test.ts}`.

**Interfaces:** `confirmRead(client, { ticket, timelineText, frames, framesOk, signals }, meter) → { outcome; evidenceLines; signalIds; note; costToUser } | { invalid }` (text-only reads never `confirmed` when `claimsAbsence(ticket.what_happened)`; missing assets or empty frame set ⇒ `unavailable`); `judgeOneFix(client, a, b, meter) → { oneFix; reason } | { invalid }`.

**Job flow:**
1. Claim. Short transaction: `SELECT ticket FOR UPDATE`; terminal → complete, exit. If the job carries a `batch_id` (retry), reuse it; else `selectBatch` (null → complete, exit; successors come from whoever changes state next). Record `batch_id` on the job.
2. Per manifest session without an attempt in this batch: load timeline and chunks, `captureFrames` (4 moments, `maxOffsets 4`), `confirmRead`, `stageCheck` under the lease. Budget exhausted before a session → no attempt recorded; `throw new JobRescheduledError` after setting `available_at` to the next budget window (same `batch_id`).
3. Pre-finalize classification, no locks: cohort = finalized checks plus this batch's staged non-unavailable attempts; if it would pass from `tracking`/`unpublished`, snapshot published non-resolved neighbours ≥ 0.80 by similarity desc then id and run `judgeOneFix` until the first yes.
4. Finalizer, one transaction: `pg_advisory_xact_lock(hashtext('friction_publish|' || environment_id))`; `SELECT ticket FOR UPDATE`; if `status` or `live_generation` differ from `*_at_select` → `discardBatch`, complete job, exit. `finalizeBatch` → `cohortStats` → `evaluateBar` → exactly one transition:
   - `tracking`/`unpublished` + passes: fold target chosen and still published → `foldInto`; target changed → complete this job, set `reconcile_needed`, `fold_retries+1` (reconcile retries the decision; at 3, publish without folding); else `activateGeneration` (steps generated before this transaction from the confirmed notes).
   - `published` non-resolved + passes/undecided: link newly verified signals into `friction_incident_evidence`; regenerate steps if no card authored since; if `reinvestigate_needed && evidence_version > evidence_version_used` → enqueue investigation (generation stamped), clear flag.
   - `published` non-resolved + fails: `unpublish`.
   - `published` + resolved: bar over post-`fixed_at` cohort; passes → `activateGeneration` with regression copy.
   Successor in the same transaction: mark the current job completed in this transaction and `throw new JobCompletedInTransaction(job.id)` (new error class handled in `poller.ts:210` alongside `JobRescheduledError`) so the poller skips its own completion write; if selectable work remains → `enqueueJobTx('friction_confirm')`; else if retries pending → same with `available_at = min(retry_at)`; else none.

- [ ] **Pure tests:** `evaluateBar` table from the rulebook including published+(16 counted, 4 confirmed) → undecided (exactly 25%) then after one deletion (15,3) → fails, `resolved` never fails; batch sizing; round-robin. **Property test** (fast-check): random event sequences over an in-memory store model satisfy all 11 rulebook invariants.
- [ ] **Integration:** 4 matches, fake client confirms 3 → one live incident generation 1, exactly 3 evidence rows, `investigate` job stamped with generation; 1 of 3 → no incident; capture throws → `unavailable` + retry row, selectable after `retry_at`; state changed mid-batch → discarded, attempts kept, `reconcile_needed`; successor only when selectable work exists; fold at cosine 0.9 → merged, target counts unchanged until the target's own batch confirms; republish → generation 2 with generation-1 evidence intact; regression → generation +1 over post-fix evidence only; budget exhaustion → same batch resumes, no attempt lost.
- [ ] FAIL → implement → PASS → commit `feat(friction): confirmation batches, fenced finalizer, activateGeneration, publish-gate fold`.

---

### Task 10: Investigation lifecycle, fix attempts, PR events

**Files:** `index.ts:956-1172`, `friction/investigate-friction.ts:81-101,151-160`, create `friction/fix-attempts.ts`, `friction/pr-events-job.ts`; Go `handler/webhook.go:112` + `queries.go:2467` (`ProcessPRWebhook` also enqueues `friction_pr_event` for ticket-backed groups); API `POST /projects/{id}/incidents/{gid}/fix` (`queries.go:2094` arm) → `requestFix`; tests.

**Rules:** investigation input = `verifiedEvidence(ticket).signalIds` only; verdict tool returns `explains[]` and `does_not_explain[]` of signal ids, validated disjoint, unique, and jointly equal to the confirmed set; stored as `explained_signal_ids` + `evidence_version_used`; coverage recomputed against the current cohort at render and at fix authorization. Stale generation → fact only. `investigation_status: pending → done|failed`; never touches `fix_substate`. Coverage < 50% sets `reinvestigate_needed`. `requestFix` (manual from a card, or automatic when `friction_autonomy = 'auto_fix'`): only callable when `investigation_status = 'done'` and current coverage ≥ 50% (the API returns 409 otherwise); automatic requests are admitted only while fewer than `FRICTION_MAX_OPEN_FIX_PRS` (default 5) attempts are in `pr_open` for the project, checked under the project row lock; investigation results carry an execution id and a result older than the stored one is ignored; then insert a fix attempt (`active`; the outstanding unique index rejects a second) and enqueue the fix job with `fix_attempt_id` + generation. Fix job re-reads live generation and attempt before opening a PR; PR created but check fails after → orphan fact, attempt `superseded`. `applyPrEvent`: opened → attempt `pr_open`, substate `pr_open`; closed unmerged → `closed`, substate `none`; merged → `merged`, substate `resolved`, `fixed_at` and `cohort_cutoff = fixed_at`; mismatched attempt/generation → fact only. `ux_insight` tickets use the same path as defects; `auto_fix` applies to both.

- [ ] Tests: overlap → incomplete; missing id → incomplete; 2 of 4 → 0.5; stale generation ignored; manual request on `failed` investigates first; concurrent second request rejected; merged with stale attempt → fact only; merged current → `resolved` + `fixed_at`.
- [ ] FAIL → implement → PASS → commit.

---

### Task 11: Reconcile, deletion, identity, archive

**Files:** create `friction/reconcile-job.ts`; Go purge path (`db/sessions.go`, callers of `SessionsReadyForPurge`) collects the ticket ids the session matches, locks them in id order, performs the delete (cascade), and only then calls `SELECT friction_reconcile_after_delete(ticket_id)` for each, all inside the purge transaction; end-user identify and consolidation paths update `friction_ticket_matches.end_user_id` for the affected sessions and call `friction_reconcile_after_delete(ticket_id)` (the same function: it re-evaluates the bar over current rows) for every matched published ticket, inside the identify transaction; `ArchiveErrorGroup` (`queries.go:2768`) extended for ticket-backed groups (ticket → `archived`, pending jobs failed, outstanding attempts `superseded`); `UnarchiveErrorGroup` (`:2796`) refuses ticket-backed groups.

**`reconcileTicket`** (job, also run by a scheduler tick every 15 min for any ticket with `reconcile_needed`): under the ticket row lock and the environment publication lock, recompute `matched_count` and `cohortStats`, then dispatch the SAME transition table as the batch finalizer over finalized evidence (activate from tracking/unpublished when passes, including the duplicate check whose model call runs before the lock; unpublish when fails; regression when resolved and post-fix passes); then schedule selectable work if any; clear `reconcile_needed`. The finalizer's fold-target-changed path sets `reconcile_needed` instead of enqueuing another batch, so a fully checked ticket still gets its publication decision retried.

- [ ] Tests: delete one confirmed of 3 on a published ticket → archived incident in the purge transaction; of 5 → still published, card copy invalidated; identity change dropping users < 2 → unpublished; discarded batch → reconcile evaluates finalized cohort; archive via API → ticket archived, jobs failed, attempt superseded, excluded from shortlist and nearest; unarchive refused.
- [ ] FAIL → implement → PASS → commit.

---

### Task 12: Digest — one list, one card, one button

**Files:** Go `digest/actionable.go` (`:94-107`: ticket-backed on-card = `status <> 'archived' AND fix_substate <> 'resolved' AND investigation_status = 'done' AND coverage >= 0.5` (coverage recomputed from `explained_signal_ids` against the current verified set at freeze); plus a "Merged this week" footer listing ticket-backed and error-lane incidents whose attempt/PR merged in the last 7 days, rendered as one line each with the PR link, no card; `:54-72` `digestAction` ticket-backed: `pr_open` → review PR, `fixing` → fix in progress, else create fix PR; `:118-243` candidate fields `TicketID, Generation, EvidenceVersion, Steps, VerifiedUsers, VerifiedSessions, Accounts, RepresentativeSessionID, RepresentativeNote, Why, Coverage` from SQL equivalent to `verifiedEvidence`, 7-day window on `occurred_at`); `freeze_friction.go:31-38` (`actionable_since` set by `activateGeneration`, so the gate holds), `:92-98`; `fingerprint.go` (add `TicketID, Generation, EvidenceVersion, Steps`; `digestPromptVersion = 7`); `validate.go:406` (ticket-backed rows are validated by the new contract only: `status <> 'archived'`, `fix_substate <> 'resolved'`, generation and evidence version unchanged since freeze; the legacy status list is not consulted for them, so `fixing` renders); `notify/slack_digest.go` (single list; per card title, copy, steps, "N users · M sessions this week · accounts", "Why" when `Coverage ≥ 0.5`, one button, replay + issue links; no section headers, no "Needs you", no visits/recovered; error-lane cards use the same template with their existing counts); worker `digest-writer/{job,schema}.ts` (`DIGEST_PROMPT_VERSION = 7`; writer never emits `action`; `why` only when `Coverage ≥ 0.5`; users/sessions/accounts rendered mechanically by Go, never by the model; other digits in copy/steps must appear in the supplied confirmed notes or steps).

- [ ] Tests: counts from finalized confirmed only (staged excluded); no card without `done` + coverage ≥ 0.5; `resolved` excluded and listed under "Merged this week" for 7 days; validation rejects moved evidence version; Slack render without lane headers/"Needs you"/"visits"; writer cannot emit `action`; digit check accepts "six month clicks" from a supplied note and rejects a novel user count.
- [ ] FAIL → implement → PASS → commit.

---

### Task 13: Cutover retirement and backfill

**Files:** create `scripts/retire-friction-buckets.sql`; `packages/worker/src/bin/backfill-tickets.ts` (+ package script); docs (`docs/design/2026-08-31-session-narratives.md` supersession note, `docs/agents/domain.md`, `packages/worker/AGENTS.md` env vars, `docs/install.md` pgvector image and RDS extension).

**Retirement (one transaction, after every old worker is stopped):** archive `kind='friction' AND ticket_id IS NULL AND status IN ('candidate','queued','analyzing','awaiting_approval','insight','needs_human','investigated')` with `status_before_archive`; fail their `investigate|fix` jobs in `pending|claimed`; invalidate their undelivered `digest_card_copy`; leave `pr_created|pr_draft|fixing` groups untouched (they finish under the old lifecycle).

**Deploy order (PR body):** ingestion with 074 first (additive) → stop old workers → retirement script → start new workers → `backfill-tickets --project … --environment … --since 14d --rate 60` → `friction_confirm` drains → next digest. Rollback of ingestion below 074 is unsupported once new workers ran (new signal rows fail the older 068 replay). The rollback story is fix-forward: setting `FRICTION_MATCH_MAX_CONCURRENT=0` and `FRICTION_CONFIRM_MAX_CONCURRENT=0` stops matching and verification while leaving data in place; nothing new publishes until they are raised again.

**Backfill:** enqueues one `friction_match` job per `session_narratives` row (`status='ok'`, `created_at >= since`) whose atomic rows lack a ledger decision (or that has no atomic rows yet), at `--rate` jobs/minute, then exits. The match job's idempotent atomic write converts stored v2 narratives; `occurred_at` from the recording. Completion is the ledger, including `not_a_problem`; a narrative with zero surviving observations writes a `friction_session_processed(project_id, session_id, narrative_id)` row (added to Task 1) so it is never re-enqueued; re-runs skip finished sessions and resume partial ones.

- [ ] Tests: retirement on a seeded mix; backfill enqueue idempotent and resumes a session with 1 of 2 decisions.
- [ ] **Smoke (AGENTS.md):** worktree stack on `pgvector/pgvector:pg16`; three real recordings through `session_narrate` → `session_verify_frames` → `friction_match` with a fake model reporting one shared problem → one ticket, 3 matches, one `friction_confirm`; fake confirming model → live incident generation 1, 3 evidence rows, `investigate` job; investigate with a fake verdict explaining 2 of 3 → `done`, coverage 0.67; digest freeze picks it up (and does not before the verdict); Slack card: one list, "N users · M sessions", no "visits", button "Create fix PR"; a fourth recording with a different problem → second ticket, absent from `/projects/{id}/incidents`; purge one confirmed recording → incident archived in the purge transaction.
- [ ] Full gate with `DATABASE_URL`, zero skips; commit `docs: known-problems cutover`.

---

## Self-review

Every rulebook event has a handler in the event map and a task. Customer numbers come from one query (`verifiedEvidence`, and its SQL twin in Go) used by digest, investigator, and representatives; staged attempts never reach it. Generations have distinct fingerprints and preserved evidence history. Jobs use `available_at` and `JobRescheduledError`; batches are immutable rows; usage phases include the batch id. Ticket creation is serialized by the decision ledger. Backfill runs through the same job and ledger. Deletion reconciles in the purge transaction. Retirement fails claimed jobs and invalidates undelivered cards.

Deferred: dashboard rendering of ticket steps; human-driven folds; cross-environment fix dedupe; frames-first narration.


Rev 8 note (2026-09-11): applied Codex round-6 mechanical fixes (deletion reconciles after the cascade; ON CONFLICT predicate and derived narrative id; reserve→create→commit ledger; reconcile dispatches the full transition table and retries folds; cohort_cutoff independent of fixed_at; identity reconciles in-transaction; ticket-backed validation contract; guarded FK after 069; coalesced fix requests with investigation execution ids; empty-narrative completion row; corrected bar test; in-transaction job completion). Codex verdict on rev 7 was still 'no' for cutover; rev 8 has not been re-reviewed.


Rev 9 note (2026-09-11, second grilling on the final plan): a card requires a found cause with ≥ 50% coverage; the 24 h deadline and `digest_eligible_at` are removed; `friction_autonomy` reduced to `ask_first|auto_fix` applying to all kinds; daily cap replaced by an open-PR cap of 5 per project; "Merged this week" footer added to the digest.

Third grilling (2026-09-11, final plan): auto_fix_ux removed and auto_fix applies to all kinds; open-PR cap of 5 replaces the daily cap; cards require a found cause (no deadline fallback); "Merged this week" footer; fold-only-into-published accepted with manual archive as the remedy for a wrong "no"; frames on every read accepted with the per-project cap and a separate verification worker before the next AMFJ-sized customer; one-way deploy accepted with the zero-cap kill switch as rollback; archived issue pages accepted without a forward pointer (follow-up).
