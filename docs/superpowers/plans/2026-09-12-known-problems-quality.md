# Known-Problems Digest Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daily digest carry only defects with a code cause, keep insights unfixable, investigate insights only once five people have hit them, drop the redundant steps line from cards, stop losing the ledger row for empty recordings, and let a compose worker keep up with a day of traffic.

**Architecture:** Seven small changes on the branch `abhishekray07/improve-context`, each with its own test. Go: digest candidate selection, ticket incident readiness and fix admission, Slack rendering. Worker TypeScript: one shared "may this ticket be investigated" predicate and one shared "queue an investigation once" helper used by activation, the batch finalizer and the fix path; the narration finalizer queues the ledger job for empty narratives; the writer prompt. Plus compose defaults and docs. No schema change. Nothing here alters the confirmation bar or the publish gate, which the production replay of 2026-09-12 showed working.

**Tech Stack:** Go 1.24 (`packages/ingestion`, pgx, database tests behind `DATABASE_URL`), Node 22 TypeScript (`packages/worker`, Vitest, database-gated integration suites), Postgres 16 with pgvector via Docker Compose.

**Spec:** `docs/design/2026-09-11-known-problems-pipeline.md` (rev 5) and `docs/design/2026-09-11-known-problems-lifecycle.md` (rev 5), amended by the decisions below. Task 7 writes those amendments into both documents. Codex reviewed rev 1 (session `01a0974f-3336-7251-9931-3b152cad6145`) and rev 2 (session `01a0975b-83da-7961-ba50-b870efad3ce1`); their findings are folded in and marked "(Codex r1)" / "(Codex r2)".

## Decisions this plan implements (grilling of 2026-09-12, after the production replay)

Replaying 200 AMFJ production recordings (10 September, 33 users) through the pipeline with real models produced 9 published problems and 8 digest cards for $19.82. Six of the nine were `ux_insight` (per-field submit cycles, no bulk selection, a date picker that needs many clicks); two cards rested on two users, one of whom accounted for 13 sessions; two cards repeated the confirmer's note as both copy and steps. The user decided:

| # | Decision | Task |
| --- | --- | --- |
| Q1 | Digest cards for `defect` tickets only. Insights stay on the dashboard list with no card and no fix button, and no fix can be started for them by any path (Codex r1). | 1, 2 |
| Q2, Q3 | Insights are investigated automatically only once they have at least 5 confirmed identified users (`FRICTION_INSIGHT_INVESTIGATE_USERS`, default 5). Defects are investigated on publication as today. The same rule applies to every path that queues an investigation, including reinvestigation (Codex r1). | 3 |
| Q4 | Publish bar unchanged (3 confirmed, 2 identified users, 40 %). | none |
| Q5 | Duplicate handling stays: retrieval floor 0.75 plus the gate audit (already in commit 82055f2). The rulebook still says 0.80 and is corrected in Task 7. | 7 |
| Q6 | The card has no steps line. Title, copy, Why, counts, replay, button only. | 4 |
| Q7 | A card still requires a finished investigation; pending means no card (as today). | none |
| Q8 | Nothing to hide: `projects.default_branch` is a cache the worker writes from the repository's real default branch (`cacheProjectDefaultBranch`), not a user setting. Task 7 records that in the spec. | 7 |
| Q9 | Compose worker default `WORKER_CONCURRENCY` becomes 4. Production's ECS task definition (`~/deploy/terraform/ecs.tf`) sets no value and therefore runs one loop; that is a deploy-repo change outside this plan and is called out in Task 6. | 6 |
| Q10 | The duplicate `session_analysis` jobs seen in the verify run were a harness artefact: the seed closed sessions before the chunk scrubber ran, and `MarkChunkScrubbed` re-queues analysis for a chunk scrubbed after close. The production replay showed one job per recording. No change. | none |
| Q11 | A narrative with zero observations must still be recorded as processed. Today the narration job skips frame verification for it and never queues `friction_match`, so the ledger row is only written by the cutover backfill. | 5 |
| Q12 | Daily confirmation cap unchanged. | none |

## Global Constraints

- Customer copy never carries pipeline vocabulary or evidence provenance (`packages/ingestion/digest/validate.go` `internalVocabulary` and `provenanceVocabulary` reject it).
- "The customer never sees the word 'confirmed' or the defect/insight kind." (spec §6). The API therefore never exposes `kind`; readiness and fix admission are computed server-side.
- "Nothing reaches a customer unless it was seen in several recordings and checked by something other than the thing that found it." (spec Principle)
- Ticket definitions are immutable; `kind` is set at creation and never edited.
- Shipped migrations are immutable. No migration is touched by this plan.
- No manual reinvestigation trigger exists (commit eb7d509 removed the route); Task 3 removes the last worker-side one.
- Every commit ends with `Claude-Session: https://claude.ai/code/session_0185iiTiYJF3urta8kzMp2L8`.
- Database-gated suites need `DATABASE_URL` pointing at a migrated pgvector Postgres. The recipe used for every check below:

```bash
docker run -d --name plan-pg -e POSTGRES_USER=opslane -e POSTGRES_PASSWORD=opslane_dev -e POSTGRES_DB=opslane -p 127.0.0.1:5699:5432 pgvector/pgvector:pg16
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5699/opslane?sslmode=disable"
for f in $(ls packages/ingestion/db/migrations/*.sql | sort); do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -f "$f" >/dev/null; done
```

Remove it with `docker rm -f plan-pg` when done.

---

## File map

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/ingestion/digest/actionable.go` | SQL that loads digest candidates; gains the `kind='defect'` condition for ticket-backed groups | 1 |
| `packages/ingestion/digest/validate_actionable_test.go` | Database test that the loader skips insight tickets | 1 |
| `packages/ingestion/digest/known_problems_integration_test.go` | End-to-end freeze test: defect fixture keeps its card; the same ticket as an insight produces no candidate the next day | 1 |
| `packages/ingestion/db/ticket_fix.go` | `TicketIncidentState` learns the ticket kind; `requestTicketFix` refuses insights | 2 |
| `packages/ingestion/handler/incident_present.go` | Readiness is `ineligible` for insights, so the dashboard shows no fix button | 2 |
| `packages/ingestion/handler/ticket_api_test.go` | Insight incident: fix returns 409, readiness ineligible | 2 |
| `packages/worker/src/friction/fix-attempts.ts` | `requestFix` refuses insights (covers the automatic path); the human-path investigation enqueue goes | 2 |
| `packages/worker/src/friction/tickets-db.ts` | `insightInvestigateUsers()`, `investigationAllowed()`, `enqueueTicketInvestigation()`; `activateGeneration` uses them | 3 |
| `packages/worker/src/friction/confirm-job.ts` | Finalizer uses the shared predicate and helper for reinvestigation and for an insight's first investigation | 3 |
| `packages/worker/src/friction/__tests__/confirm-job.integration.test.ts` | Insight below threshold, crossing it, generation 2, failed-insight reinvestigation below threshold, insight fix refusal | 2, 3 |
| `packages/worker/src/friction/__tests__/tickets-db.test.ts` | Threshold parser unit cases | 3 |
| `packages/ingestion/notify/slack_digest_v5.go`, `slack_digest_v5_test.go` | Card renders no steps line | 4 |
| `packages/worker/src/digest-writer/job.ts`, `__tests__/grounding.test.ts` | Writer prompt no longer asks for steps | 4 |
| `packages/worker/src/db.ts` | `finishNarrative` queues `friction_match` in the same transaction when there is nothing to verify | 5 |
| `packages/worker/src/bin/__tests__/backfill-tickets.integration.test.ts` | Finalized empty narrative → queued match → ledger row → backfill queues nothing | 5 |
| `docker-compose.yml`, `docs/reference/environment-variables.md` | `WORKER_CONCURRENCY` compose default 4; `FRICTION_INSIGHT_INVESTIGATE_USERS` documented | 3, 6 |
| `docs/design/2026-09-11-known-problems-pipeline.md`, `docs/design/2026-09-11-known-problems-lifecycle.md` | Spec and rulebook rev 6 | 7 |

---

### Task 1: Digest cards for defects only

**Files:**
- Modify: `packages/ingestion/digest/actionable.go:213` (the `WHERE` clause of `loadActionableCandidates`)
- Modify: `packages/ingestion/digest/known_problems_integration_test.go:82` and the end of that test
- Test: `packages/ingestion/digest/validate_actionable_test.go` (new test appended)

**Interfaces:**
- Consumes: `loadActionableCandidates(ctx, tx, projectID, statusSQL, evaluatedAt ...time.Time) ([]actionableCandidate, error)` at `actionable.go:163`, called from `freeze.go:166` (with `onCardStatusSQL`) and `validate.go:146` (validation reload, receipts, cached-card reuse), so one SQL change covers every customer-facing path (Codex r1 confirmed). `seedDigestFixture(t, pool, now)` from `build_test.go:130` returns `ProjectID` and `EnvID`; `testPool(t)` from `build_test.go:18`; `cleanupActionableDiagnoses` from `validate_actionable_test.go`.
- Produces: ticket-backed groups whose ticket is `ux_insight` are never candidates. Dashboard incident lists are unaffected (they read `error_groups` directly).

- [x] **Step 1: Write the failing loader test**

Append to `packages/ingestion/digest/validate_actionable_test.go`:

```go
// The digest is for defects a fix can close. An insight ticket is tracked,
// investigated once enough people hit it, and shown on the dashboard, but it
// never becomes a card (grilling decision Q1, 2026-09-12).
func TestLoadActionableCandidatesSkipsInsightTickets(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	fixture := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, fixture.ProjectID)

	groupFor := func(kind string) string {
		t.Helper()
		var ticketID, groupID string
		if err := pool.QueryRow(ctx, `INSERT INTO friction_tickets
			(project_id,environment_id,name,control,what_happened,kind,status,live_generation,evidence_version)
			VALUES ($1,$2,$3,'Save','Nothing happened',$4,'published',1,1) RETURNING id::text`,
			fixture.ProjectID, fixture.EnvID, "ticket-"+kind+"-"+uuid.NewString(), kind).Scan(&ticketID); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
			 ticket_id,publication_generation,fix_substate,investigation_status,root_cause,actionable_since)
			VALUES ($1,$2,$3,'candidate','friction','awaiting_approval',$4,$4,$5,1,'none','done','The handler returns early.',$4)
			RETURNING id::text`,
			fixture.ProjectID, fixture.EnvID, "ticket-"+uuid.NewString(), now, ticketID).Scan(&groupID); err != nil {
			t.Fatal(err)
		}
		return groupID
	}
	defectGroup := groupFor("defect")
	insightGroup := groupFor("ux_insight")

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	candidates, err := loadActionableCandidates(ctx, tx, fixture.ProjectID, onCardStatusSQL, now)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, candidate := range candidates {
		seen[candidate.GroupID] = true
	}
	if !seen[defectGroup] {
		t.Fatalf("defect ticket group %s missing from candidates", defectGroup)
	}
	if seen[insightGroup] {
		t.Fatalf("insight ticket group %s must not be a digest candidate", insightGroup)
	}
}
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/ingestion && go test ./digest/ -run TestLoadActionableCandidatesSkipsInsightTickets -count=1`
Expected: FAIL with `insight ticket group ... must not be a digest candidate`

- [x] **Step 3: Add the kind condition to the loader**

In `packages/ingestion/digest/actionable.go`, the `WHERE` clause currently reads:

```go
		 WHERE g.project_id=$1
		   AND ((g.ticket_id IS NULL AND g.status IN ` + string(statusSQL) + `) OR (g.ticket_id IS NOT NULL AND g.status <> 'archived'))
```

Change it to:

```go
		 WHERE g.project_id=$1
		   AND ((g.ticket_id IS NULL AND g.status IN ` + string(statusSQL) + `)
		     OR (g.ticket_id IS NOT NULL AND g.status <> 'archived'
		         -- Cards are for defects. Insight tickets stay on the dashboard
		         -- (grilling decision Q1, 2026-09-12); their kind is immutable.
		         AND EXISTS (SELECT 1 FROM friction_tickets t WHERE t.id=g.ticket_id AND t.kind='defect')))
```

- [x] **Step 4: Run the new test to verify it passes**

Run: `cd packages/ingestion && go test ./digest/ -run TestLoadActionableCandidatesSkipsInsightTickets -count=1`
Expected: PASS

- [x] **Step 5: Keep the end-to-end fixture as a defect and add the insight day**

`packages/ingestion/digest/known_problems_integration_test.go:82` inserts the fixture ticket with kind `'ux_insight'` and then expects a card. Change that literal to `'defect'`:

```go
	ticket := insert(`INSERT INTO friction_tickets(project_id,environment_id,name,control,what_happened,kind,status,live_generation,evidence_version,steps)VALUES($1,$2,'Six-month view stalls','View','Clicks ignored','defect','published',1,4,'Open the six-month view and click Apply.')RETURNING id`, p.ID, env)
```

Then add the insight day immediately after the first freeze's candidate assertions (the block ending `t.Fatalf("candidate=%+v", c)` after `runID, candidates, err := FreezeCandidates(ctx, pool, p.ID, at)`), before the validation transaction. It must run while the group is still eligible: the test later marks it resolved, where exclusion would be vacuous (Codex r2). The later resolved-ticket freeze uses `at.Add(24*time.Hour)`, so this one uses day plus two. Kind is immutable in the product; the test flips it only to reuse the full fixture, and flips it back:

```go
	// The same ticket as an insight: a later day's freeze has no candidate for
	// it while it is still published, investigated and unfixed.
	run(`UPDATE friction_tickets SET kind='ux_insight' WHERE id=$1`, ticket)
	_, insightCandidates, err := FreezeCandidates(ctx, pool, p.ID, at.Add(48*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	for _, ic := range insightCandidates {
		if ic.TicketID == ticket {
			t.Fatalf("insight ticket froze as a candidate: %+v", ic)
		}
	}
	run(`UPDATE friction_tickets SET kind='defect' WHERE id=$1`, ticket)
```

(`at`, `ticket`, `run`, `pool`, `ctx`, `p` are the variables the test already defines.)

- [x] **Step 6: Run the digest package**

Run: `cd packages/ingestion && go test ./digest/ -count=1`
Expected: `ok`

- [x] **Step 7: Commit**

```bash
git add packages/ingestion/digest/actionable.go packages/ingestion/digest/validate_actionable_test.go packages/ingestion/digest/known_problems_integration_test.go
git commit -m "feat(digest): cards for defect tickets only

Insight tickets stay tracked and visible on the dashboard but never become a
digest card. In the 2026-09-12 production replay six of nine published
problems were insights, two of them carried by a single heavy user.

Claude-Session: https://claude.ai/code/session_0185iiTiYJF3urta8kzMp2L8"
```

---

### Task 2: Insights are never fixable

Without this, an investigated insight still shows "Create fix PR" on the incident page (`IncidentDetail.vue:45` gates on readiness only) and the investigator's automatic path (`investigate-ticket.ts:256` → `requestFix(..., 'auto')`) would open a PR for it (Codex r1).

**Files:**
- Modify: `packages/ingestion/db/ticket_fix.go:14-27` (`TicketIncidentState`), `:34-40` (`ticketIncidentState` SELECT and Scan), `requestTicketFix` (the readiness check after `lockTicketIncident`)
- Modify: `packages/ingestion/handler/incident_present.go:43-55`
- Modify: `packages/ingestion/db/ticket_fix_test.go:54-55` (fixture kind), `packages/dashboard/src/types/api.ts:238` (readiness union)
- Modify: `packages/worker/src/friction/fix-attempts.ts:42-44` (`FixRequest`), `:58-63` (ticket check), `:108-122` (human-path enqueue), `:331-336` (`assertFixAttemptCurrent`)
- Modify: `packages/worker/src/friction/__tests__/tickets-db.integration.test.ts:317` and `:433` (fixtures that assumed insight fixes and human-path reinvestigation)
- Test: `packages/ingestion/handler/ticket_api_test.go` (new test), `packages/worker/src/friction/__tests__/confirm-job.integration.test.ts` (two new cases)

**Interfaces:**
- Consumes: `friction_tickets.kind` (`'defect' | 'ux_insight'`); `TicketIncidentState` is read by `GetTicketIncidentState` (incident API) and `lockTicketIncident` (fix admission); `requestFix(tx, projectId, ticketId, generation, requestedBy, guidance?)` returns `FixRequest`.
- Produces: `TicketIncidentState.Kind string`; `FixRequest` gains `{ status: 'not_fixable' }`; a new readiness value `cause_only` for an insight whose investigation found a cause (the cause is shown, no fix is offered; the kind itself is never sent); `POST /projects/{id}/incidents/{incidentId}/fix` on an insight returns 409; a queued fix job for an insight is rejected as stale before any provider write.

- [x] **Step 1: Write the failing Go test**

Append to `packages/ingestion/handler/ticket_api_test.go`:

```go
// An insight is never fixable: readiness stays ineligible even with a finished
// investigation, and a fix request is refused (grilling decision Q1).
func TestTicketInsightIsNeverFixable(t *testing.T) {
	router, q, pool := authTestRouter(t)
	org, project, environment, _ := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org) })
	ctx := context.Background()
	var ticket, group string
	if err := pool.QueryRow(ctx, `INSERT INTO friction_tickets(project_id,environment_id,name,control,what_happened,kind,status,live_generation)
		VALUES($1,$2,'Export needs many clicks','Export','Export needed repeated clicks','ux_insight','published',1) RETURNING id`, project, environment).Scan(&ticket); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups(project_id,fingerprint,title,first_seen,last_seen,kind,status,ticket_id,publication_generation,fix_substate,investigation_status,root_cause,occurrence_count,affected_users_count)
		VALUES($1,$2,'Export needs many clicks',now(),now(),'friction','awaiting_approval',$3,1,'none','done','The export button offers no bulk action.',5,5) RETURNING id`, project, "ticket|"+ticket, ticket).Scan(&group); err != nil {
		t.Fatal(err)
	}
	var job string
	if err := pool.QueryRow(ctx, `INSERT INTO error_group_jobs(project_id,error_group_id,job_type,status,ticket_id,publication_generation,source_id)
		VALUES($1,$2,'investigate','completed',$3,1,$2) RETURNING id`, project, group, ticket).Scan(&job); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO diagnosis_decisions(error_group_id,project_id,job_id,outcome,decision_reason,diagnosis,model,prompt_version,basis,confidence)
		VALUES($1,$2,$3,'code_fix','The export button offers no bulk action.','{"agentTaskBrief":"Add a bulk export action."}'::jsonb,'test','friction-ticket-v1','friction_classify','high')`, group, project, job); err != nil {
		t.Fatal(err)
	}
	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), "insight-user", org, "insight@example.test")
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/projects/" + project + "/incidents/" + group
	request := func(method, suffix string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path+suffix, strings.NewReader(`{}`))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	w := request(http.MethodGet, "")
	if w.Code != http.StatusOK {
		t.Fatalf("read=%d %s", w.Code, w.Body.String())
	}
	var incident struct {
		InvestigationReadiness *string `json:"investigation_readiness"`
		RootCause              *string `json:"root_cause"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &incident); err != nil {
		t.Fatal(err)
	}
	if incident.InvestigationReadiness == nil || *incident.InvestigationReadiness != "cause_only" || incident.RootCause == nil {
		t.Fatalf("insight shows its cause but is never fix-eligible: %+v", incident)
	}
	if w := request(http.MethodPost, "/fix"); w.Code != http.StatusConflict {
		t.Fatalf("insight fix=%d %s", w.Code, w.Body.String())
	}
	var jobs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM error_group_jobs WHERE error_group_id=$1 AND job_type IN ('fix','investigate')`, group).Scan(&jobs); err != nil || jobs != 0 {
		t.Fatalf("insight fix request queued %d jobs (err=%v)", jobs, err)
	}
}
```

`diagnosis_decisions.job_id` references `error_group_jobs.id`, hence the real job row (Codex r2). If the diagnosis insert fails on another column, copy the exact column list from the existing `INSERT INTO diagnosis_decisions` in `packages/worker/src/friction/investigate-ticket.ts:150`. The test needs `encoding/json`, `net/http`, `net/http/httptest`, `strings`, and the `auth` package, all already imported by this file.

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/ingestion && go test ./handler/ -run TestTicketInsightIsNeverFixable -count=1`
Expected: FAIL at `insight shows its cause but is never fix-eligible` (readiness is `eligible` today)

- [x] **Step 3: Load the kind into the ticket incident state**

In `packages/ingestion/db/ticket_fix.go`, add `Kind string` to `TicketIncidentState` (after `TicketID`), add `t.kind,` right after `t.id,` in the `SELECT` of `ticketIncidentState`, and add `&s.Kind,` right after `&s.TicketID,` in the matching `Scan`.

In `requestTicketFix`, immediately after `s, err := lockTicketIncident(ctx, tx, projectID, groupID)` succeeds, add:

```go
	// Fixes are for defects. An insight is investigated for its dashboard page
	// only and never becomes a PR (grilling decision Q1, 2026-09-12).
	if s.Kind != "defect" {
		return "", ErrNotInvestigated
	}
```

`ErrNotInvestigated` already maps to HTTP 409 in the fix handler.

- [x] **Step 4: Readiness `cause_only` for insights**

An insight's cause must stay visible on the incident page (Task 7 says "the cause on the dashboard only"), while `ineligible` would hide it: both `IncidentDetail.vue:41-43` and `components/incidents/IncidentConclusion.vue:19-22` hide the cause for `ineligible` and `pending`, on purpose, because legacy incidents carry stale `root_cause` text (Codex r2). So an insight with a found cause gets a third readiness value. In `packages/ingestion/handler/incident_present.go`, the block

```go
			if state.TicketStatus == "published" && state.GroupStatus != "archived" && state.Generation == state.LiveGeneration &&
				state.InvestigationStatus == "done" && state.CauseCoverage >= 0.5 && state.Cause != "" && state.Brief != "" {
				readiness = "eligible"
				incident.RootCause = &state.Cause
				incident.AgentTaskBrief = &state.Brief
			} else {
```

becomes

```go
			if state.TicketStatus == "published" && state.GroupStatus != "archived" && state.Generation == state.LiveGeneration &&
				state.InvestigationStatus == "done" && state.CauseCoverage >= 0.5 && state.Cause != "" && state.Brief != "" {
				// A found cause is shown for every kind. Only a defect may be
				// fixed; an insight's page says "cause_only" and offers no button.
				// The kind itself is never sent to the client.
				readiness = "eligible"
				if state.Kind != "defect" {
					readiness = "cause_only"
				}
				incident.RootCause = &state.Cause
				incident.AgentTaskBrief = &state.Brief
			} else {
```

In `packages/dashboard/src/types/api.ts:238`, widen the union: `investigation_readiness?: 'eligible' | 'cause_only' | 'ineligible' | 'pending';`. `fixAvailable` in `IncidentDetail.vue` already requires `'eligible'`, and the two `causeHidden` computeds hide only `'ineligible'` and `'pending'`, so the cause renders and no fix button appears without further dashboard changes. Add one case to `packages/dashboard/src/views/__tests__/incident-detail-honest-state.test.ts` next to the `'shows honest copy and no stored garbage when readiness is ineligible'` test:

```ts
  it('shows the cause without a fix button when readiness is cause_only', async () => {
    api.getIncident.mockResolvedValue({ ...base, kind: 'friction', status: 'awaiting_approval', ticket_id: 't1',
      fix_substate: 'none', investigation_status: 'done', cause_coverage: 1, investigation_readiness: 'cause_only',
      root_cause: 'The export button offers no bulk action.' });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('The export button offers no bulk action.');
    expect(wrapper.text()).not.toContain('Create fix PR');
    wrapper.unmount();
  });
```

Also change the Go fix fixture `packages/ingestion/db/ticket_fix_test.go:54-55` from `'ux_insight'` to `'defect'`: it is the shared fixture for every successful-fix test and the new admission rule would break them (Codex r2).

- [x] **Step 5: Run the Go tests and the dashboard test**

Run: `cd packages/ingestion && go test ./handler/ ./db/ -run 'TestTicket' -count=1 && cd ../dashboard && npx vitest run src/views/__tests__/incident-detail-honest-state.test.ts`
Expected: all `ok` / passed

- [x] **Step 6: Write the failing worker test**

In `packages/worker/src/friction/__tests__/confirm-job.integration.test.ts`, next to the existing `requestFix` tests (around line 870), add:

```ts
  it('refuses a fix for an insight even with a finished investigation, on every path', async () => {
    const t = await insightTicket();
    await identifiedMatches(t, 3);
    await expect(
      processFrictionConfirm(await claim(t), deps([]), new AbortController().signal),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    await pool.query(
      `UPDATE error_groups SET investigation_status='done', root_cause='The export button offers no bulk action.',
       explained_signal_ids=(SELECT jsonb_agg(signal_id) FROM friction_incident_evidence WHERE ticket_id=$1) WHERE ticket_id=$1`,
      [t.id],
    );
    for (const requestedBy of ['human', 'auto'] as const) {
      await expect(transaction((tx) => requestFix(tx, projectId, t.id, 1, requestedBy))).resolves.toEqual({ status: 'not_fixable' });
    }
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM error_group_jobs WHERE ticket_id=$1 AND job_type IN ('fix','investigate')`, [t.id])).rows[0].n,
    ).toBe(0);
  });
```

Then add a second case for a fix job that was queued before this rule shipped (Codex r2):

```ts
  it('rejects a queued fix job for an insight before any provider write', async () => {
    const t = await insightTicket();
    await identifiedMatches(t, 3);
    await expect(
      processFrictionConfirm(await claim(t), deps([]), new AbortController().signal),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    const group = (await pool.query(`SELECT id FROM error_groups WHERE ticket_id=$1`, [t.id])).rows[0].id as string;
    const attempt = (await pool.query(
      `INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status,requested_by) VALUES($1,$2,1,'active','auto') RETURNING id`,
      [t.id, group],
    )).rows[0].id as string;
    await pool.query(`UPDATE error_groups SET fix_substate='fixing' WHERE id=$1`, [group]);
    const jobId = (await pool.query(
      `INSERT INTO error_group_jobs(project_id,error_group_id,job_type,status,ticket_id,publication_generation,fix_attempt_id,source_id,worker_id,lease_generation,lease_expires_at)
       VALUES($1,$2,'fix','claimed',$3,1,$4,$2,'fix-test',1,now()+interval '5 minutes') RETURNING id`,
      [projectId, group, t.id, attempt],
    )).rows[0].id as string;
    await expect(
      assertFixAttemptCurrent({ id: jobId, projectId, ticketId: t.id, publicationGeneration: 1, errorGroupId: group, fixAttemptId: attempt, workerId: 'fix-test', leaseGeneration: '1', jobType: 'fix', attempts: 0 } as never),
    ).rejects.toThrow(/Stale ticket fix attempt/);
  });
```

Import `assertFixAttemptCurrent` from `'../fix-attempts.js'` next to the existing `requestFix` import. `insightTicket()` and `identifiedMatches()` are defined in Task 3 step 1; write them first if you implement this task before Task 3 (they are plain helpers with no dependency on Task 3's code). `transaction` and `requestFix` are already imported in this file (see line 880).

- [x] **Step 7: Run it to verify it fails**

Run: `cd packages/worker && npx vitest run src/friction/__tests__/confirm-job.integration.test.ts -t "refuses a fix for an insight"`
Expected: FAIL (`requestFix` returns `not_ready` or `created`, and the human path queues an investigation)

- [x] **Step 8: Refuse insights in the worker fix path and drop the human-path enqueue**

In `packages/worker/src/friction/fix-attempts.ts`:

1. Extend the union:

```ts
export type FixRequest =
  | { status: 'created'; attemptId: string; jobId: string }
  | { status: 'not_ready' | 'not_fixable' | 'stale' | 'outstanding' | 'cap' | 'disabled' };
```

2. Right after the block that returns `{ status: 'stale' }` for a missing, unpublished or wrong-generation ticket, add:

```ts
  // Fixes are for defects. An insight's investigation only feeds its dashboard
  // page; it never becomes a PR by click or by autonomy (grilling decision Q1).
  if (ticket.kind !== 'defect') return { status: 'not_fixable' };
```

3. In the not-ready branch (line 108 onwards), delete the `if (requestedBy === 'human') { await db.enqueueJobTx(tx, 'investigate', ...) }` block entirely, so a not-ready request returns `{ status: 'not_ready' }` without queueing anything. Reinvestigation follows new verified evidence only (commit eb7d509 made the same change on the Go side).

4. In `assertFixAttemptCurrent` (line 331), the stale check reads:

```ts
    if (
      !ticket ||
      ticket.status !== 'published' ||
      ticket.live_generation !== job.publicationGeneration ||
      a?.status !== 'active'
    )
      throw new Error('Stale ticket fix attempt');
```

Add `ticket.kind !== 'defect' ||` after `!ticket ||`, so a fix job queued for an insight before this rule shipped is refused before any provider write (Codex r2).

5. Update the two worker integration fixtures that assumed the old behaviour (Codex r2): in `packages/worker/src/friction/__tests__/tickets-db.integration.test.ts:317`, the test `'authorizes half-covered UX causes, caps automatic PRs, and resolves only the current attempt'` creates `ticket('ux_insight')`; change it to `ticket('defect')` and rename it `'authorizes half-covered causes, caps automatic PRs, and resolves only the current attempt'`. At `:433`, `'a failed investigation queues reinvestigation before refusing a manual fix'` expects a pending investigation after the refused human fix; change the expected pending count to `0` and rename it `'a failed investigation refuses a manual fix without queueing reinvestigation'`.

Search the worker for callers that switch on `FixRequest['status']` (`grep -rn "status === 'not_ready'\|case 'not_ready'" packages/worker/src`) and treat `'not_fixable'` like `'not_ready'` wherever a case list would otherwise be non-exhaustive.

- [x] **Step 9: Run the worker tests**

Run: `cd packages/worker && npx tsc --noEmit -p tsconfig.json && npx vitest run src/friction/__tests__/confirm-job.integration.test.ts src/friction/__tests__/tickets-db.integration.test.ts`
Expected: type check clean, both suites pass.

- [x] **Step 10: Commit**

```bash
git add packages/ingestion/db/ticket_fix.go packages/ingestion/db/ticket_fix_test.go packages/ingestion/handler/incident_present.go packages/ingestion/handler/ticket_api_test.go packages/dashboard/src/types/api.ts packages/dashboard/src/views/__tests__/incident-detail-honest-state.test.ts packages/worker/src/friction/fix-attempts.ts packages/worker/src/friction/__tests__/confirm-job.integration.test.ts packages/worker/src/friction/__tests__/tickets-db.integration.test.ts
git commit -m "feat(friction): insights are never fixable

An insight with a found cause reads cause_only: the incident page shows the
cause and offers no fix button. The fix route returns 409, the worker's
requestFix returns not_fixable on the human and automatic paths, a queued
fix job for an insight is refused as stale, and a not-ready fix request no
longer queues an investigation.

Claude-Session: https://claude.ai/code/session_0185iiTiYJF3urta8kzMp2L8"
```

---

### Task 3: Investigate insights only from five identified users

**Files:**
- Modify: `packages/worker/src/friction/tickets-db.ts` (new helpers next to `foldMinSimilarity()`; `activateGeneration` at `:712-727`)
- Modify: `packages/worker/src/friction/confirm-job.ts:229-246` (finalizer `refresh` branch)
- Modify: `docker-compose.yml:144`, `docs/reference/environment-variables.md:120`
- Test: `packages/worker/src/friction/__tests__/tickets-db.test.ts` (parser cases; create the file if it does not exist), `packages/worker/src/friction/__tests__/confirm-job.integration.test.ts`

**Interfaces:**
- Consumes: `activateGeneration(dbtx, ticket, ...)` computes `const evidence = summarizeEvidence(rows)` with `evidence.users` (distinct identified users among confirmed checks) and `evidence.sessions`; `TicketRow.kind`; in the finalizer's `refresh` branch `const evidence = await store.verifiedEvidence(tx, ticket, { days: null })` has the same fields and `incident` comes from `store.liveIncident`; `db.enqueueJobTx`.
- Produces, all exported from `tickets-db.ts`:
  - `insightInvestigateUsers(): number` (env `FRICTION_INSIGHT_INVESTIGATE_USERS`, default 5, positive integer or default)
  - `investigationAllowed(ticket: Pick<TicketRow, 'kind'>, confirmedIdentifiedUsers: number): boolean`
  - `enqueueTicketInvestigation(tx, ticket: TicketRow, errorGroupId: string): Promise<boolean>` — queues one `investigate` job for the live generation unless one is already pending or claimed for that incident and generation; returns whether it queued. Caller holds the ticket lock.

- [x] **Step 1: Write the failing integration tests**

In `packages/worker/src/friction/__tests__/confirm-job.integration.test.ts`, add before the test `'publishes three of four checks with exactly verified evidence and a generation-stamped investigation'`:

```ts
  async function insightTicket() {
    const tx = await pool.connect();
    try {
      return await store.createTicket(tx, {
        projectId,
        environmentId,
        name: 'Export needs many clicks',
        control: 'Export',
        what_happened: 'Export required repeated clicks',
        kind: 'ux_insight',
        steps: 'Unverified draft',
      });
    } finally {
      tx.release();
    }
  }
  /** Like matches(), but every recording belongs to its own identified user. */
  async function identifiedMatches(t: store.TicketRow, count: number) {
    const tx = await pool.connect();
    try {
      for (let i = 0; i < count; i++) {
        const sessionId = randomUUID();
        await tx.query('BEGIN');
        const endUserId = (
          await tx.query(
            `INSERT INTO end_users(project_id,external_user_id) VALUES($1,$2) RETURNING id`,
            [projectId, `user-${sessionId}`],
          )
        ).rows[0].id as string;
        await tx.query(
          `INSERT INTO sessions(id,project_id,environment_id,end_user_id,started_at) VALUES($1,$2,$3,$4,now())`,
          [sessionId, projectId, environmentId, endUserId],
        );
        const signalId = (
          await tx.query(
            `INSERT INTO friction_signals(session_id,project_id,environment_id,end_user_id,signal_type,fingerprint,page_url_normalized,occurred_at,rule_version) VALUES($1,$2,$3,$4,'narrative',$5,'/export',now(),1) RETURNING id`,
            [sessionId, projectId, environmentId, endUserId, randomUUID()],
          )
        ).rows[0].id as string;
        await store.recordMatch(tx, {
          ticket: t,
          sessionId,
          endUserId,
          signalIds: [signalId],
          source: 'cheap',
          occurredAt: new Date().toISOString(),
          screen: '/export',
        });
        await tx.query('COMMIT');
      }
    } finally {
      tx.release();
    }
  }
  const investigateJobs = async (t: store.TicketRow) =>
    (await pool.query<{ generation: number; status: string }>(
      `SELECT publication_generation AS generation, status FROM error_group_jobs WHERE ticket_id=$1 AND job_type='investigate' ORDER BY created_at`,
      [t.id],
    )).rows;

  describe('insight investigation threshold', () => {
    beforeEach(() => vi.stubEnv('FRICTION_INSIGHT_INVESTIGATE_USERS', '5'));
    afterEach(() => vi.unstubAllEnvs());

    it('publishes an insight without investigating it until five identified users confirm', async () => {
      const t = await insightTicket();
      await identifiedMatches(t, 3);
      await expect(
        processFrictionConfirm(await claim(t), deps([]), new AbortController().signal),
      ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
      expect((await store.getTicket(pool, projectId, t.id))!.status).toBe('published');
      expect(
        (await pool.query(`SELECT investigation_status FROM error_groups WHERE ticket_id=$1`, [t.id])).rows,
      ).toEqual([{ investigation_status: 'pending' }]);
      expect(await investigateJobs(t)).toEqual([]);

      // Ten more arrivals earn a second batch; the confirmed identified users
      // cross five and the finalizer queues the first investigation, once.
      await identifiedMatches(t, 10);
      await expect(
        processFrictionConfirm(await claim(t), deps([]), new AbortController().signal),
      ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
      expect((await store.verifiedEvidence(pool, t)).users).toBeGreaterThanOrEqual(5);
      expect(await investigateJobs(t)).toEqual([{ generation: 1, status: 'pending' }]);
    });

    it('does not requeue an insight below the threshold after a failed investigation', async () => {
      const t = await insightTicket();
      await identifiedMatches(t, 3);
      await expect(
        processFrictionConfirm(await claim(t), deps([]), new AbortController().signal),
      ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
      // A failed investigation sets reinvestigate_needed; evidence then grows
      // to four users, still under five: nothing may be queued.
      await pool.query(`UPDATE error_groups SET investigation_status='failed' WHERE ticket_id=$1`, [t.id]);
      await pool.query(`UPDATE friction_tickets SET reinvestigate_needed=true WHERE id=$1`, [t.id]);
      await identifiedMatches(t, 1);
      await pool.query(`UPDATE friction_tickets SET arrival_boundary=0 WHERE id=$1`, [t.id]);
      await expect(
        processFrictionConfirm(await claim(t), deps([]), new AbortController().signal),
      ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
      expect((await store.verifiedEvidence(pool, t)).users).toBe(4);
      expect(await investigateJobs(t)).toEqual([]);
    });

    it('carries the threshold into generation two', async () => {
      const t = await insightTicket();
      await identifiedMatches(t, 3);
      await expect(
        processFrictionConfirm(await claim(t), deps([]), new AbortController().signal),
      ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
      await transaction((tx) => store.unpublish(tx, t));
      await identifiedMatches(t, 10);
      await expect(
        processFrictionConfirm(await claim(t), deps([]), new AbortController().signal),
      ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
      expect((await store.getTicket(pool, projectId, t.id))!.live_generation).toBe(2);
      expect(await investigateJobs(t)).toEqual([{ generation: 2, status: 'pending' }]);
    });

    it('still investigates a defect on publication regardless of user count', async () => {
      const t = await ticket();
      await matches(t, 3);
      await expect(
        processFrictionConfirm(await claim(t), deps([]), new AbortController().signal),
      ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
      expect(await investigateJobs(t)).toEqual([{ generation: 1, status: 'pending' }]);
    });
  });
```

`randomUUID`, `transaction`, `describe`, `beforeEach`, `afterEach`, `vi` are already imported in this file (check the import line and add any that are missing). If `arrival_boundary=0` does not make the fourth match selectable in the second test (the arrival rule needs ten new arrivals or boundary 0), keep it; that is the documented reset and the existing test at line 1233 uses the same idea.

- [x] **Step 2: Run the tests to verify the insight cases fail**

Run: `cd packages/worker && npx vitest run src/friction/__tests__/confirm-job.integration.test.ts -t "insight investigation threshold"`
Expected: the three insight cases FAIL (an `investigate` job exists after the first publication); the defect case passes.

- [x] **Step 3: Add the shared predicate and enqueue helper**

In `packages/worker/src/friction/tickets-db.ts`, next to `foldMinSimilarity()`:

```ts
/** Insights (kind ux_insight) are investigated only once this many identified
 * users have confirmed recordings; defects are investigated on publication.
 * Grilling decision Q2/Q3, 2026-09-12. */
export function insightInvestigateUsers(): number {
  const raw = Number(process.env['FRICTION_INSIGHT_INVESTIGATE_USERS'] ?? '5');
  return Number.isInteger(raw) && raw > 0 ? raw : 5;
}
/** The one rule every investigation-queueing path asks. */
export function investigationAllowed(
  ticket: Pick<TicketRow, 'kind'>,
  confirmedIdentifiedUsers: number,
): boolean {
  return ticket.kind !== 'ux_insight' || confirmedIdentifiedUsers >= insightInvestigateUsers();
}
/** Queues one investigation for the live generation unless one is already
 * pending or claimed for that incident and generation. Caller holds the
 * ticket lock, which serializes this with activation and reconciliation. */
export async function enqueueTicketInvestigation(
  tx: pg.PoolClient,
  ticket: Pick<TicketRow, 'id' | 'project_id' | 'live_generation'>,
  errorGroupId: string,
): Promise<boolean> {
  const active = await tx.query(
    `SELECT 1 FROM error_group_jobs WHERE error_group_id=$1 AND job_type='investigate'
       AND publication_generation=$2 AND status IN ('pending','claimed') LIMIT 1`,
    [errorGroupId, ticket.live_generation],
  );
  if (active.rowCount) return false;
  await enqueueJobTx(tx, 'investigate', ticket.project_id, {
    errorGroupId,
    sourceId: errorGroupId,
    ticketId: ticket.id,
    publicationGeneration: ticket.live_generation,
  });
  return true;
}
```

`enqueueJobTx` and `pg` are already imported in this file.

- [x] **Step 4: Use them in `activateGeneration`**

Replace the enqueue at the end of `activateGeneration`:

```ts
  await enqueueJobTx(dbtx, 'investigate', t.project_id, {
    errorGroupId,
    sourceId: errorGroupId,
    ticketId: t.id,
    publicationGeneration: generation,
  });
  return { errorGroupId, generation };
```

with:

```ts
  if (investigationAllowed(t, evidence.users)) {
    await enqueueTicketInvestigation(dbtx, { ...t, live_generation: generation }, errorGroupId);
  }
  return { errorGroupId, generation };
```

(`t` is the locked ticket row and `evidence` the `summarizeEvidence(rows)` result computed earlier in the function; `generation` is the new generation number just written.)

- [x] **Step 5: Use them in the finalizer**

In `packages/worker/src/friction/confirm-job.ts`, in the `refresh` branch, replace the reinvestigation block:

```ts
    if (
      ticket.reinvestigate_needed &&
      ticket.evidence_version > (incident.evidence_version_used ?? -1)
    ) {
      await db.enqueueJobTx(tx, 'investigate', ticket.project_id, {
        ticketId: ticket.id,
        errorGroupId: incident.id,
        sourceId: incident.id,
        publicationGeneration: ticket.live_generation,
      });
      await tx.query(
        `UPDATE friction_tickets SET reinvestigate_needed=false WHERE id=$1`,
        [ticket.id],
      );
    }
```

with:

```ts
    const allowed = store.investigationAllowed(ticket, evidence.users);
    if (
      allowed &&
      ticket.reinvestigate_needed &&
      ticket.evidence_version > (incident.evidence_version_used ?? -1)
    ) {
      await store.enqueueTicketInvestigation(tx, ticket, incident.id);
      await tx.query(
        `UPDATE friction_tickets SET reinvestigate_needed=false WHERE id=$1`,
        [ticket.id],
      );
    }
    // An insight published below the user threshold has an incident that was
    // never investigated. Its first investigation starts from the batch that
    // carries it over the threshold; the helper makes this idempotent.
    if (allowed && ticket.kind === 'ux_insight' && incident.investigation_status === 'pending') {
      const everQueued = await tx.query(
        `SELECT 1 FROM error_group_jobs WHERE error_group_id=$1 AND job_type='investigate' LIMIT 1`,
        [incident.id],
      );
      if (!everQueued.rowCount) await store.enqueueTicketInvestigation(tx, ticket, incident.id);
    }
```

`LiveIncident` (tickets-db.ts, `interface LiveIncident`) does not carry `investigation_status` today: add `investigation_status: string;` to the interface and `g.investigation_status,` to the `SELECT` in `liveIncident`. The "ever queued" check is scoped to the live incident row, which is generation-specific, so a generation-2 incident starts clean (Codex r1); the pending/claimed check inside the helper prevents duplicates on concurrent finalizers because both hold the ticket lock.

- [x] **Step 6: Run the insight and defect cases**

Run: `cd packages/worker && npx vitest run src/friction/__tests__/confirm-job.integration.test.ts -t "insight investigation threshold"`
Expected: 4 passed

- [x] **Step 7: Unit-test the threshold parser**

Create or extend `packages/worker/src/friction/__tests__/tickets-db.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insightInvestigateUsers, investigationAllowed } from '../tickets-db.js';

describe('insightInvestigateUsers', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ['unset', undefined, 5],
    ['custom', '8', 8],
    ['zero', '0', 5],
    ['negative', '-3', 5],
    ['fractional', '2.5', 5],
    ['garbage', 'five', 5],
  ])('%s → %s', (_name, value, expected) => {
    if (value === undefined) vi.stubEnv('FRICTION_INSIGHT_INVESTIGATE_USERS', '');
    else vi.stubEnv('FRICTION_INSIGHT_INVESTIGATE_USERS', value);
    expect(insightInvestigateUsers()).toBe(expected);
  });
  it('gates insights only', () => {
    vi.stubEnv('FRICTION_INSIGHT_INVESTIGATE_USERS', '5');
    expect(investigationAllowed({ kind: 'defect' }, 0)).toBe(true);
    expect(investigationAllowed({ kind: 'ux_insight' }, 4)).toBe(false);
    expect(investigationAllowed({ kind: 'ux_insight' }, 5)).toBe(true);
  });
});
```

Note `Number('')` is `0`, so an empty variable falls back to 5; the parser treats that the same as unset.

Run: `cd packages/worker && npx vitest run src/friction/__tests__/tickets-db.test.ts`
Expected: all passed

- [x] **Step 8: Pass the variable through compose and document it**

In `docker-compose.yml`, after `      FRICTION_MAX_OPEN_FIX_PRS: ${FRICTION_MAX_OPEN_FIX_PRS:-5}` in the worker environment, add:

```yaml
      FRICTION_INSIGHT_INVESTIGATE_USERS: ${FRICTION_INSIGHT_INVESTIGATE_USERS:-5}
```

In `docs/reference/environment-variables.md`, after the `FRICTION_FOLD_MIN_SIMILARITY` row, add:

```markdown
| `FRICTION_INSIGHT_INVESTIGATE_USERS` | no (5) | Identified users whose confirmed recordings an insight (kind `ux_insight`) needs before it is investigated automatically. Defects are investigated on publication. Invalid values fall back to 5. |
```

Run: `docker compose -f docker-compose.yml config --quiet`
Expected: exit 0

- [x] **Step 9: Run the whole friction suite**

Run: `cd packages/worker && npx tsc --noEmit -p tsconfig.json && npx vitest run src/friction`
Expected: all passed

- [x] **Step 10: Commit**

```bash
git add packages/worker/src/friction/tickets-db.ts packages/worker/src/friction/confirm-job.ts packages/worker/src/friction/__tests__/confirm-job.integration.test.ts packages/worker/src/friction/__tests__/tickets-db.test.ts docker-compose.yml docs/reference/environment-variables.md
git commit -m "feat(friction): investigate insights only from five identified users

One predicate decides whether a ticket may be investigated and one helper
queues an investigation at most once per live incident and generation. Both
are used by activation, the finalizer's reinvestigation and the insight's
first investigation. Defects are investigated on publication as before; an
insight waits until FRICTION_INSIGHT_INVESTIGATE_USERS (default 5) confirmed
identified users. In the production replay this would have halved
investigation spend.

Claude-Session: https://claude.ai/code/session_0185iiTiYJF3urta8kzMp2L8"
```

---

### Task 4: No steps line on the card

**Files:**
- Modify: `packages/ingestion/notify/slack_digest_v5.go:47-49`
- Modify: `packages/ingestion/notify/slack_digest_v5_test.go:16-25`
- Modify: `packages/worker/src/digest-writer/job.ts` (`DIGEST_SYSTEM_PROMPT`, the "For ticket candidates" sentence)
- Test: `packages/worker/src/digest-writer/__tests__/grounding.test.ts` (the `writer prompt` describe block)

**Interfaces:**
- Consumes: `GeneratedDigestCard.Steps` (Go) and the writer's `steps` output field. Both stay in the schema and payload: the Go validator still bounds `steps` at 600 characters and older cached cards may carry it. Only the rendering and the prompt change.
- Produces: rendered card text is title, copy, Why, counts line, links, button.

- [x] **Step 1: Make the renderer test fail**

In `packages/ingestion/notify/slack_digest_v5_test.go`, remove `"Open payment and click Pay."` from the `expected` list on line 16 and add it to the `bad` list in the loop that follows, so the two loops read:

```go
	for _, expected := range []string{"2 users · 4 sessions this week", "Create fix PR", "Merged this week", "Why:"} {
```

```go
	for _, bad := range []string{"Needs you", "Needs a decision", "Session intelligence", "visits", "recovered", "Open payment and click Pay."} {
```

(The rendered body is the `body` variable returned by `formatSlackDigest(p)`; both loops already compare against `string(body)`.)

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/ingestion && go test ./notify/ -run TestSlackDigestV5 -count=1`
Expected: FAIL with `legacy "Open payment and click Pay."`

- [x] **Step 3: Drop the steps line from the renderer**

In `packages/ingestion/notify/slack_digest_v5.go`, delete these three lines:

```go
		if c.Steps != "" {
			text += "\n" + cleanProse(c.Steps, 600)
		}
```

- [x] **Step 4: Run the notify package**

Run: `cd packages/ingestion && go test ./notify/ -count=1`
Expected: `ok`

- [x] **Step 5: Stop asking the writer for steps**

In `packages/worker/src/digest-writer/job.ts`, `DIGEST_SYSTEM_PROMPT`, replace the sentence

```
For ticket candidates use only confirmedNotes and steps as evidence. Optional steps (under 600 characters) describe the verified interaction. The notes are evidence, not prose to copy: never repeat line ids such as L23 or L29-L38, and never mention timelines, screenshots, frames, recordings being checked, or that anything was confirmed or verified; the reader sees only what a user did and what the screen showed.
```

with

```
For ticket candidates use only confirmedNotes and steps as evidence. Do not write a steps field; the card shows a replay link instead. The notes are evidence, not prose to copy: never repeat line ids such as L23 or L29-L38, and never mention timelines, screenshots, frames, recordings being checked, or that anything was confirmed or verified; the reader sees only what a user did and what the screen showed.
```

- [x] **Step 6: Extend the prompt test**

In `packages/worker/src/digest-writer/__tests__/grounding.test.ts`, inside the `writer prompt` describe block's test, add:

```ts
    expect(DIGEST_SYSTEM_PROMPT).toMatch(/Do not write a steps field/);
```

Run: `cd packages/worker && npx vitest run src/digest-writer`
Expected: all passed

- [x] **Step 7: Commit**

```bash
git add packages/ingestion/notify/slack_digest_v5.go packages/ingestion/notify/slack_digest_v5_test.go packages/worker/src/digest-writer/job.ts packages/worker/src/digest-writer/__tests__/grounding.test.ts
git commit -m "feat(digest): cards carry no steps line

The replay link is the reproduction; the steps sentence duplicated the copy
on every replayed card and was the field evidence language leaked through.

Claude-Session: https://claude.ai/code/session_0185iiTiYJF3urta8kzMp2L8"
```

---

### Task 5: Empty narratives still reach the ledger

`db.enqueueJob` only accepts `session_narrate | session_verify_frames` (`db.ts:3733`), and a separate enqueue after `finishNarrative` would leave a crash window in which the narrative is final but never gets its ledger job (Codex r1). The enqueue therefore lives inside `finishNarrative`, in the same transaction as the terminal update.

**Files:**
- Modify: `packages/worker/src/db.ts:3852-3898` (`finishNarrative`)
- Test: `packages/worker/src/bin/__tests__/backfill-tickets.integration.test.ts` (new case in `describeDb('ticket backfill')`)
- Leave alone: `packages/worker/src/narrative/job.ts` and its unit test `job.test.ts:126-131` (the job still calls `enqueueJob` only for verification; that assertion stays true).

**Interfaces:**
- Consumes: `enqueueJobTx(client, 'friction_match', projectId, { sessionId })` (used the same way at `db.ts:4017`); the match job accepts a narrative with `verification_state='none'` and `observations=[]` (`match-job.ts:129`) and writes `friction_session_processed`; `backfillTickets` skips sessions with a ledger row (`backfill-tickets.ts:58`).
- Produces: every narrated recording gets exactly one `friction_match` job, so `friction_session_processed` is complete and the cutover backfill no longer re-queues empty recordings.

- [x] **Step 1: Write the failing integration test**

In `packages/worker/src/bin/__tests__/backfill-tickets.integration.test.ts`, inside `describeDb('ticket backfill', ...)`, add after the `'processes a real none-state empty backfill'` case:

```ts
  it('queues the match job for an empty narrative when narration finalizes, so the backfill has nothing to add', async () => {
    const sessionId = randomUUID();
    await pool.query('INSERT INTO sessions(id,project_id,environment_id,started_at) VALUES($1,$2,$3,now())', [sessionId, projectId, environmentId]);
    await pool.query(`INSERT INTO session_narratives(session_id,project_id,environment_id,status,prompt_version,created_at)
      VALUES($1,$2,$3,'narrating',2,$4)`, [sessionId, projectId, environmentId, createdAt]);
    const workerId = randomUUID();
    const jobId = (await pool.query(
      `INSERT INTO error_group_jobs(project_id,session_id,job_type,status,worker_id,lease_generation,lease_expires_at)
       VALUES($1,$2,'session_narrate','claimed',$3,1,now()+interval '5 minutes') RETURNING id`,
      [projectId, sessionId, workerId],
    )).rows[0].id as string;
    const job = { id: jobId, projectId, sessionId, workerId, leaseGeneration: '1', jobType: 'session_narrate', errorGroupId: null, payload: null, attempts: 0 } as unknown as db.ClaimedJob;
    const written = await db.finishNarrative(job, {
      sessionId, projectId, status: 'ok',
      narrative: { userGoal: 'browse', narrative: 'Nothing notable happened.', notable: false, observations: [] },
      timeline: { lines: [] } as never,
      verificationState: 'none',
    });
    expect(written).toEqual({ written: true });
    const queued = await pool.query(`SELECT status FROM error_group_jobs WHERE project_id=$1 AND session_id=$2 AND job_type='friction_match'`, [projectId, sessionId]);
    expect(queued.rows).toEqual([{ status: 'pending' }]);

    // Run that job through the production handler: it writes the ledger row
    // without a model call, and the backfill then has nothing to enqueue.
    const claimed = await pool.query(`UPDATE error_group_jobs SET status='claimed',worker_id=$2,lease_generation=1,lease_expires_at=now()+interval '5 minutes'
      WHERE project_id=$1 AND job_type='friction_match' RETURNING id,payload`, [projectId, workerId]);
    const model = { modelName: 'unused', complete: vi.fn() };
    await processFrictionMatch({ id: claimed.rows[0].id, payload: claimed.rows[0].payload, projectId, sessionId, workerId, leaseGeneration: '1', errorGroupId: null, jobType: 'friction_match', attempts: 0 } as never, { cheap: model, strong: model } as never, new AbortController().signal);
    await pool.query("UPDATE error_group_jobs SET status='completed' WHERE project_id=$1", [projectId]);
    expect(model.complete).not.toHaveBeenCalled();
    expect((await pool.query('SELECT count(*)::int AS n FROM friction_session_processed WHERE project_id=$1 AND session_id=$2', [projectId, sessionId])).rows[0].n).toBe(1);
    expect(await backfillTickets(pool, options)).toBe(0);
  });
```

Copy the exact `processFrictionMatch(...)` call shape from the neighbouring `'processes a real none-state empty backfill'` test (it already builds the job and deps objects; reuse its form verbatim rather than the sketch above if they differ). `db` is imported there as the module that exports `closePool`; `finishNarrative` is exported from the same module.

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/worker && npx vitest run src/bin/__tests__/backfill-tickets.integration.test.ts -t "queues the match job for an empty narrative"`
Expected: FAIL at `queued.rows` (no `friction_match` job)

- [x] **Step 3: Queue the match job inside `finishNarrative`**

In `packages/worker/src/db.ts`, `finishNarrative` currently runs one `getPool().query(UPDATE ...)` and returns `{ written: rowCount > 0 }`. Change it to run in a transaction and queue the match job when there is nothing to verify:

```ts
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE session_narratives ... (the existing statement, unchanged) ...`,
      [ ...the existing parameter list, unchanged... ],
    );
    const written = (result.rowCount ?? 0) > 0;
    // A narrative with nothing to verify still has to be recorded as
    // processed, and only the match job writes friction_session_processed.
    // Queue it here so a crash between finalization and enqueue cannot leave
    // a recording that the cutover backfill has to rediscover.
    if (written && args.status === 'ok' && args.verificationState === 'none') {
      await enqueueJobTx(client, 'friction_match', args.projectId, { sessionId: args.sessionId });
    }
    await client.query('COMMIT');
    return { written };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
```

Keep the SQL text and the parameter array exactly as they are today; only the executor and the enqueue change. `enqueueJobTx` is defined in the same file.

- [x] **Step 4: Run the narrative, bin and match suites**

Run: `cd packages/worker && npx tsc --noEmit -p tsconfig.json && npx vitest run src/narrative src/bin src/friction/__tests__/match-job.test.ts`
Expected: all passed, including the unchanged `job.test.ts` assertion that the narration job itself enqueues nothing for an empty set.

- [x] **Step 5: Commit**

```bash
git add packages/worker/src/db.ts packages/worker/src/bin/__tests__/backfill-tickets.integration.test.ts
git commit -m "fix(worker): queue the match job for empty narratives at finalization

A narrative with no observations skipped frame verification and never got a
match job, so the processed ledger lacked its row until the cutover backfill
re-queued it. The enqueue is in the finalization transaction.

Claude-Session: https://claude.ai/code/session_0185iiTiYJF3urta8kzMp2L8"
```

---

### Task 6: Compose worker runs four job loops

**Files:**
- Modify: `docker-compose.yml:172`
- Modify: `docs/reference/environment-variables.md:114`

**Interfaces:**
- Consumes: `WORKER_CONCURRENCY` read by `packages/worker/src/poller.ts:79-90` (`options.concurrency`; the process default and the invalid-value fallback stay 1; the range is 1 to 16).
- Produces: a compose stack keeps narration, frame checks, matching and confirmation overlapping. Only narration, frames, match and confirm have per-type caps (`db.ts:628-631`); the investigate and fix lanes are bounded by loop count times replicas, so four loops can run up to four investigations at once (Codex r1). Production runs on ECS with no value set (`~/deploy/terraform/ecs.tf`) and is on one loop today; adding `WORKER_CONCURRENCY=4` to the worker task definition is a deploy-repo change to do alongside this branch's rollout.

- [x] **Step 1: Change the compose default**

In `docker-compose.yml`, change

```yaml
      WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-1}
```

to

```yaml
      WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-4}
```

- [x] **Step 2: Document it precisely**

In `docs/reference/environment-variables.md:114`, the row begins `| \`WORKER_CONCURRENCY\` | no (1) | How many jobs one worker process runs at once (any job type, mixed). Accepted range 1-16; invalid or out-of-range values log a warning and fall back to 1, or clamp to 16.` Change the default cell to `no (process 1, Compose 4)` and append to the description: ` Narration, frame checks, matching and confirmation have their own caps; investigation and fix jobs do not, so they scale with this value times the replica count.`

- [x] **Step 3: Validate compose**

Run: `docker compose -f docker-compose.yml config --quiet && docker compose -f docker-compose.yml config | grep -n "WORKER_CONCURRENCY"`
Expected: exit 0 and the line shows `WORKER_CONCURRENCY: "4"`

- [x] **Step 4: Commit**

```bash
git add docker-compose.yml docs/reference/environment-variables.md
git commit -m "chore(compose): worker runs four job loops by default

One loop serialises every stage; in a 200-recording replay confirmation
batches waited behind the entire narration backlog. Production's task
definition sets no value and needs the same change in the deploy repo.

Claude-Session: https://claude.ai/code/session_0185iiTiYJF3urta8kzMp2L8"
```

---

### Task 7: Spec and rulebook rev 6

**Files:**
- Modify: `docs/design/2026-09-11-known-problems-pipeline.md` (§6 Digest, §7 Investigation, rev note)
- Modify: `docs/design/2026-09-11-known-problems-lifecycle.md` (status line, States table, Card eligibility, Duplicate check, Investigation finishes, Fix events)

Both files are untracked on the branch today. This commit adds exactly these two files and nothing else (Codex r1).

- [x] **Step 1: Amend the spec**

In `docs/design/2026-09-11-known-problems-pipeline.md`:

1. §6, the card contract sentence starting `Card contract: issue name; what users hit with steps to reproduce (rewritten at publication from verified sessions);` becomes:

```
Card contract: issue name; what users hit (rewritten at publication from verified sessions); "N users · M sessions this week" and the accounts, counted over verified sessions only; one replay link to a verified session (the one closest to the median cost, not the most dramatic); the cause line (always present, since a card requires one); one button: "Review PR" when a PR exists, "Fix in progress" when a fix attempt is running, otherwise "Create fix PR", which starts the fix immediately (the cause already exists). There is no steps line; the replay is the reproduction.
```

2. §6, the sentence `Every verified ticket is investigated automatically regardless of kind; the kind stays internal.` becomes:

```
Only tickets of kind defect get a card or a fix; insight tickets (kind ux_insight) are tracked, listed on the dashboard, never enter the digest, and never become a PR by click or by autonomy. Defects are investigated automatically on publication. Insights are investigated automatically only once at least 5 confirmed identified users have hit them (`FRICTION_INSIGHT_INVESTIGATE_USERS`), and that rule applies to reinvestigation too; the kind stays internal.
```

3. §7, `The existing investigator runs for every verified ticket, immediately on publication,` becomes `The existing investigator runs for every verified defect immediately on publication, and for a verified insight once its confirmed identified users reach the threshold above,`.

4. §8, `similarity ≥ 0.75 (`FRICTION_FOLD_MIN_SIMILARITY`, at most 10)` is already correct on this branch; leave it.

5. Header line 3: `Status: rev 5 (definitions immutable), agreed in the second grilling after two Codex review rounds` becomes `Status: rev 6 (defect-only cards and fixes, insight investigation threshold), amended after the 2026-09-12 production replay and two Codex plan rounds` (Codex r2).

6. §5, the sentence `Steps and quote are presentation and may be rewritten at publication.` becomes `The quote is presentation and may be rewritten at publication; the confirmer's note is customer prose that feeds the writer as evidence and is never shown as a steps line.`

7. §7, the last sentence `The fix pipeline is unchanged.` becomes `The fix pipeline is unchanged for defects; an insight never enters it (no button, no autonomy, a queued fix job for one is refused).`

8. Replace the whole `## Data` section (the six bullets) with the tables migration 074 actually creates (Codex r2):

```
## Data

Migration `074_friction_tickets.sql`, all additive:

- `friction_tickets`: definition (name, control, what_happened, kind, steps, screens_confirmed, screens_proposed), status (`tracking` | `published` | `unpublished` | `merged` | `archived`), embedding (1536) + embedding_model, matched_count, arrival_boundary, next_arrival_number, evidence_version, live_generation, fold_retries, fixed_at, cohort_cutoff, reconcile_needed, reinvestigate_needed, merged_into.
- `friction_observation_decisions`: one row per atomic observation (signal) with its decision (`reserved` | `matched` | `created` | `not_a_problem`) and ticket.
- `friction_ticket_matches` (ticket, session, end_user, arrival_number, source, occurred_at) and `friction_ticket_match_observations` (ticket, session, signal): the counting unit and the evidence unit.
- `friction_session_processed`: the ledger of narratives the match job has finished, keyed by narrative id.
- `friction_confirm_batches`, `friction_confirmation_budget`, `friction_check_attempts` (staged reads incl. `unavailable`), `friction_checks` (finalized reads), `friction_unavailable_retries`.
- `friction_incident_evidence`: the verified signals an incident generation links.
- `friction_fix_attempts`, `friction_investigation_results`, `friction_pr_events`, `friction_fix_failures`.
- `friction_gate_decisions`: every one-fix answer asked at the publish gate (candidate, similarity, answer, reason).
- `error_groups` gains `ticket_id`, `publication_generation`, `fix_substate`, `investigation_status`, `evidence_version_used`, `explained_signal_ids`, `investigation_execution`. A ticket's incident is an `error_groups` row of kind `friction` with `ticket_id` set; legacy route-bucket rows (no `ticket_id`) are archived at cutover.
- `friction_signals` gains `observation_id`, `evidence_lines`, `narrative_id`.
```

5. Append:

```
Rev 6 note (2026-09-12): after the 200-recording production replay: defect-only cards and fixes, insight investigation threshold, no steps line, retrieval floor 0.75 with the gate audit table `friction_gate_decisions`, unavailable reads consume no budget, aborted external assets are a degraded capture. `projects.default_branch` is a cache the worker writes from the repository's default branch, not a setting.
```

- [x] **Step 2: Amend the rulebook**

In `docs/design/2026-09-11-known-problems-lifecycle.md`:

1. Status line: `Status: rev 5 (...)` becomes `Status: rev 6 (defect-only cards and fixes, insight investigation threshold, floor 0.75; 2026-09-12)`.

2. States table, `published` row, "Customer sees" cell `a card once a cause is found (eligibility below), and an issue page` becomes `an issue page; a card once a cause is found (eligibility below) and only for kind defect`.

3. Card eligibility: `Card eligibility: state published, fix substate ≠ resolved, investigation status done with a cause whose coverage over the current verified observations is ≥ 50%.` becomes `Card eligibility: kind defect, state published, fix substate ≠ resolved, investigation status done with a cause whose coverage over the current verified observations is ≥ 50%. Fix eligibility (button, autonomy) has the same kind condition; an insight is never fixable.`

4. One activation transition: `enqueues investigation;` becomes `enqueues investigation for a defect, or for an insight whose confirmed identified users are at least FRICTION_INSIGHT_INVESTIGATE_USERS (default 5);`.

5. Duplicate check at publication: `similarity ≥ 0.80` becomes `similarity ≥ 0.75 (FRICTION_FOLD_MIN_SIMILARITY, at most 10 candidates; every answer is recorded in friction_gate_decisions)`.

6. Batch finalizes table, the `published, substate ≠ resolved` / `passes` cell: append `; reinvestigation and an insight's first investigation follow the same kind and user-count rule as activation`.

7. Investigation finishes, the `Cause explains ≥ 50%` bullet: `the card becomes eligible; if friction_autonomy = auto_fix ...` becomes `the card becomes eligible for a defect; for a defect, if friction_autonomy = auto_fix ...`, and the bullet ends with `Insights show the cause on the dashboard only; no button, no auto-fix.`

8. Fix and PR events, first bullet: `"Create fix PR" click or auto-PR: only reachable when a cause with ≥ 50% coverage exists;` becomes `"Create fix PR" click or auto-PR: only for a defect, and only reachable when a cause with ≥ 50% coverage exists (an insight returns not fixable);`.

- [x] **Step 3: Commit**

```bash
git add docs/design/2026-09-11-known-problems-pipeline.md docs/design/2026-09-11-known-problems-lifecycle.md
git commit -m "docs(friction): spec and rulebook rev 6 after the production replay

Claude-Session: https://claude.ai/code/session_0185iiTiYJF3urta8kzMp2L8"
```

---

## Final gate

Run the repository gate from `AGENTS.md` with the database up (recipe in Global Constraints) and storage variables exported so nothing is skipped:

```bash
export MINIO_ENDPOINT=http://localhost:9012 MINIO_ACCESS_KEY=minio MINIO_SECRET_KEY=minio12345 MINIO_BUCKET=opslane-replays
export REPLAY_STORE_ENDPOINT="$MINIO_ENDPOINT" REPLAY_STORE_PUBLIC_ENDPOINT="$MINIO_ENDPOINT" REPLAY_STORE_ACCESS_KEY=minio REPLAY_STORE_SECRET_KEY=minio12345 REPLAY_STORE_BUCKET=opslane-replays
docker compose -f docker-compose.yml up -d minio minio-setup   # storage tests need a live MinIO, variables alone are not enough (Codex r2)
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && set -o pipefail && go build ./... && go test -v ./... 2>&1 | tee /tmp/go-test.log)
docker compose config --quiet
```

- [x] `pnpm test` reports the worker friction, narrative, digest-writer and bin suites as run, not skipped (read the skip count, not the pass count).
- [x] `grep -c -- "--- SKIP" /tmp/go-test.log` is 0 (the `-v` flag is what makes skips visible; `pipefail` is what makes a failing `go test` fail the pipeline).
- [x] `docker compose -f docker-compose.yml down` if you started MinIO for this, and `docker rm -f plan-pg`.
- [x] `docker rm -f plan-pg`.
