# Ticket Replay Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Known-problem (ticket) digest cards and receipts link their replay to the moment the confirmed check cited, not `?t=0`.

**Architecture:** `db.LoadTicketDigestFacts` already picks the representative verified session. It gains one extra, single-row query for that session: the finalized check attempt's `evidence_lines`, the session's `ok` narrative timeline, and the earliest occurred_at of the attempt's verified signals. A pure helper turns the cited `L<n>` IDs into an absolute epoch-ms anchor. The digest freeze stamps it onto `Candidate.ReplayAnchorMs`, and every ticket `BuildSessionURL(..., 0)` call uses it.

**Tech Stack:** Go 1.24, pgx v5, PostgreSQL 16 + pgvector (tests).

**Spec:** GitHub issue opslane/opslane#497 ("Known-problem digest cards link to the start of the recording, not the moment the problem happens").

## Global Constraints

- Anchor is absolute client-clock epoch milliseconds. The dashboard (`packages/dashboard/src/composables/useSessionPlayback.ts`) compares `?t=` directly against rrweb event timestamps and clamps it to the recording.
- Anchor order of preference, per issue #497: (1) chronologically earliest resolvable timeline line cited by the representative session's confirmed check; (2) earliest `occurred_at` among that attempt's verified signals; (3) `0` (today's behavior).
- A cited line resolves only if it matches `^L(\d+)$`, indexes an existing `timeline.lines` entry (1-based), is not `k:"idle"`, and has a numeric `a` in `(0, 2^53]`. This mirrors the worker's confirm frame selection in `packages/worker/src/friction/confirm-job.ts` (`loadRecording`). A timeline without a numeric `startTs` in `(0, 2^53]` is malformed and yields no anchor (fall back). A resolved `a` below `timeline.startTs` is raised to `startTs`.
- "First cited line" means the chronologically earliest resolvable cited line, not the first array entry. The minimum is at or before the first cited line under either reading of the issue, which is what AC 1 asks for; the model's citation order carries no meaning.
- No upper bound check. The timeline is built from the session's own chunks, and the dashboard already picks the nearest segment (`segmentForTime`) and clamps the seek to the loaded events (`clampSeek` in `packages/dashboard/src/components/session-replay.ts`).
- Legacy (non-ticket) candidates keep their current anchor behavior. Do not touch `watchableSessionAnySpell`, `ingestiondb.WatchableSessionForGroupOn`, or the `candidate.TicketID == ""` branch in `freeze.go`.
- `ReplayAnchorMs` stays out of `candidateFingerprint`: it is link decoration and must not retire cached card copy.
- No migration. No worker change. Ticket state gate (`candidateStillUnified`) is unchanged.
- Every new query stays project-scoped (`packages/ingestion/AGENTS.md`).
- A malformed or missing timeline is not an error: fall back. A SQL error is an error, the same as the existing evidence queries in `LoadTicketDigestFacts`.

## Test database

DB tests need a pgvector Postgres (migration 078 runs `CREATE EXTENSION vector`). From the worktree root:

```bash
export OPSLANE_POSTGRES_HOST_PORT=5497
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:$OPSLANE_POSTGRES_HOST_PORT/opslane?sslmode=disable"
docker compose -p kpanchor up -d postgres
until docker compose -p kpanchor exec -T postgres pg_isready -U opslane; do sleep 1; done
```

If port 5497 is taken, pick another free port and re-export both variables together. A Go DB test that prints `--- SKIP` did not run; treat a skip as a failure.

## File Structure

- Modify `packages/ingestion/db/ticket_evidence.go`: new `RepresentativeAnchorMs` field, attempt/signal capture per row, `representativeReplayAnchor` query, pure `timelineAnchorMs` helper.
- Create `packages/ingestion/db/ticket_replay_anchor_test.go` (internal `package db`): table test for `timelineAnchorMs`.
- Modify `packages/ingestion/db/ticket_evidence_test.go`: DB assertions for the anchor and both fallbacks.
- Modify `packages/ingestion/digest/freeze_friction.go`: stamp `ReplayAnchorMs` on ticket candidates.
- Modify `packages/ingestion/digest/validate.go`: three ticket `BuildSessionURL(..., 0)` calls use the anchor.
- Modify `packages/ingestion/digest/known_problems_integration_test.go`: freeze and published-link assertions.

---

### Task 1: Representative replay anchor in ticket digest facts

**Files:**
- Modify: `packages/ingestion/db/ticket_evidence.go`
- Create: `packages/ingestion/db/ticket_replay_anchor_test.go`
- Test: `packages/ingestion/db/ticket_evidence_test.go`

**Interfaces:**
- Consumes: nothing new.
- Produces: `db.TicketDigestFacts.RepresentativeAnchorMs int64` (absolute epoch ms, `0` when unknown), populated by `db.LoadTicketDigestFacts` whenever `RepresentativeSessionID != ""`. Unexported `timelineAnchorMs(evidenceLines []string, timeline []byte) (int64, bool)`.

- [ ] **Step 1: Write the failing pure-helper test**

Create `packages/ingestion/db/ticket_replay_anchor_test.go`:

```go
package db

import "testing"

func TestTimelineAnchorMs(t *testing.T) {
	const timeline = `{"startTs":1000000,"lines":[
		{"t":"open","s":null,"r":"/view","a":1001000},
		{"t":"idle 30s","s":null,"r":"/view","a":1002000,"k":"idle"},
		{"t":"no time","s":null,"r":"/view","a":null},
		{"t":"click Apply","s":"#apply","r":"/view","a":1871000},
		{"t":"nothing happens","s":null,"r":"/view","a":1875000},
		{"t":"clock skew","s":null,"r":"/view","a":999000}
	]}`
	cases := []struct {
		name  string
		lines []string
		body  string
		want  int64
		ok    bool
	}{
		{"earliest cited line wins regardless of citation order", []string{"L5", "L4"}, timeline, 1871000, true},
		{"idle lines are skipped", []string{"L2", "L4"}, timeline, 1871000, true},
		{"lines without a timestamp are skipped", []string{"L3", "L5"}, timeline, 1875000, true},
		{"out-of-range and malformed ids are skipped", []string{"L0", "L99", "4", "L4x", "l4"}, timeline, 0, false},
		{"a line before startTs is raised to startTs", []string{"L6"}, timeline, 1000000, true},
		{"no citations", nil, timeline, 0, false},
		{"missing timeline", []string{"L4"}, "", 0, false},
		{"malformed timeline", []string{"L4"}, `{"lines":"nope"}`, 0, false},
		{"timeline without startTs", []string{"L1"}, `{"lines":[{"t":"x","s":null,"r":"/","a":1001000}]}`, 0, false},
		{"timeline with null startTs", []string{"L1"}, `{"startTs":null,"lines":[{"t":"x","s":null,"r":"/","a":1001000}]}`, 0, false},
		{"non-positive timestamps are skipped", []string{"L1", "L2"}, `{"startTs":1000000,"lines":[{"t":"x","s":null,"r":"/","a":-5},{"t":"y","s":null,"r":"/","a":0}]}`, 0, false},
		{"timestamps beyond 2^53 are skipped", []string{"L1", "L2"}, `{"startTs":1000000,"lines":[{"t":"x","s":null,"r":"/","a":1e300},{"t":"y","s":null,"r":"/","a":1002000}]}`, 1002000, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := timelineAnchorMs(tc.lines, []byte(tc.body))
			if got != tc.want || ok != tc.ok {
				t.Fatalf("timelineAnchorMs(%v)=(%d,%v) want (%d,%v)", tc.lines, got, ok, tc.want, tc.ok)
			}
		})
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/ingestion && go test ./db -run TestTimelineAnchorMs -count=1`
Expected: FAIL to compile with `undefined: timelineAnchorMs`.

- [ ] **Step 3: Implement the helper**

In `packages/ingestion/db/ticket_evidence.go`, replace the import block with:

```go
import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)
```

Append to the file:

```go
var evidenceLineID = regexp.MustCompile(`^L(\d+)$`)

// timelineAnchorMs resolves a confirmed check's cited timeline line IDs to the
// absolute client-clock time of the earliest one, the way the worker's confirm
// step picks its frames: 1-based L<n> IDs, idle and untimed lines skipped.
func timelineAnchorMs(evidenceLines []string, timeline []byte) (int64, bool) {
	if len(timeline) == 0 {
		return 0, false
	}
	var parsed struct {
		StartTs *float64 `json:"startTs"`
		Lines   []struct {
			A *float64 `json:"a"`
			K string   `json:"k"`
		} `json:"lines"`
	}
	if err := json.Unmarshal(timeline, &parsed); err != nil || !validEpochMs(parsed.StartTs) {
		return 0, false
	}
	start := int64(math.Round(*parsed.StartTs))
	var best int64
	found := false
	for _, id := range evidenceLines {
		match := evidenceLineID.FindStringSubmatch(id)
		if match == nil {
			continue
		}
		n, err := strconv.Atoi(match[1])
		if err != nil || n < 1 || n > len(parsed.Lines) {
			continue
		}
		line := parsed.Lines[n-1]
		if line.K == "idle" || !validEpochMs(line.A) {
			continue
		}
		ms := int64(math.Round(*line.A))
		if !found || ms < best {
			best, found = ms, true
		}
	}
	if found && best < start {
		best = start
	}
	return best, found
}

// validEpochMs accepts a positive millisecond timestamp that converts to int64
// exactly; JSON numbers outside that range are malformed timeline data.
func validEpochMs(value *float64) bool {
	return value != nil && *value > 0 && *value <= 1<<53
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd packages/ingestion && go test ./db -run TestTimelineAnchorMs -count=1 -v`
Expected: PASS, 12 subtests.

- [ ] **Step 5: Write the failing DB test**

Append a new test to `packages/ingestion/db/ticket_evidence_test.go`. It uses its own fixture so the extra signals do not disturb the coverage assertions in `TestTicketDigestFactsUsesFinalizedCurrentEvidence`. The fixture's representative session is `f.ticket+"-1"` (median of four; all `cost_to_user` NULL, so arrival order decides).

```go
func TestTicketDigestFactsRepresentativeReplayAnchor(t *testing.T) {
	f := seedTicketFix(t)
	ctx := context.Background()
	pool := f.q.Pool()
	representative := f.ticket + "-1"
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	epochMs := func(sql string, args ...any) int64 {
		t.Helper()
		var ms int64
		if err := pool.QueryRow(ctx, sql, args...).Scan(&ms); err != nil {
			t.Fatal(err)
		}
		return ms
	}
	load := func() *db.TicketDigestFacts {
		t.Helper()
		facts, err := db.LoadTicketDigestFacts(ctx, pool, f.project, f.group, time.Now())
		if err != nil || facts == nil || facts.RepresentativeSessionID != representative {
			t.Fatalf("facts=%+v error=%v", facts, err)
		}
		return facts
	}
	// The recording started five hours ago so every seeded signal lies inside it.
	exec(`UPDATE sessions SET started_at=now()-interval '5 hours' WHERE id=$1`, representative)
	// The representative check verified two signals; the earlier one is cited
	// second. A third, even earlier signal was matched but not verified by the
	// check, and a fourth belongs to the session without being matched at all.
	var verifiedEarly, unverified, unmatched string
	for _, s := range []struct {
		dest   *string
		offset string
	}{{&verifiedEarly, "2 hours"}, {&unverified, "3 hours"}, {&unmatched, "4 hours"}} {
		if err := pool.QueryRow(ctx, `INSERT INTO friction_signals(session_id,project_id,environment_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,observation_id,narrative_id)
			SELECT id,project_id,environment_id,3,'other',id||$2::text,'/pay',now()-$2::text::interval,'o'||$2::text,'n' FROM sessions WHERE id=$1 RETURNING id`, representative, s.offset).Scan(s.dest); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO friction_ticket_match_observations(ticket_id,session_id,signal_id) VALUES($1,$2,$3),($1,$2,$4)`, f.ticket, representative, verifiedEarly, unverified)
	exec(`UPDATE friction_check_attempts SET signal_ids=jsonb_build_array($3::text,$4::text) WHERE ticket_id=$1 AND session_id=$2`, f.ticket, representative, f.signals[1], verifiedEarly)
	wantSignal := epochMs(`SELECT (extract(epoch FROM occurred_at)*1000)::bigint FROM friction_signals WHERE id=$1`, verifiedEarly)
	if facts := load(); facts.RepresentativeAnchorMs != wantSignal {
		t.Fatalf("signal fallback anchor=%d want earliest verified %d", facts.RepresentativeAnchorMs, wantSignal)
	}
	// With an ok narrative, the anchor is the earliest cited, timed, non-idle line.
	startMs := epochMs(`SELECT (extract(epoch FROM started_at)*1000)::bigint FROM sessions WHERE id=$1`, representative)
	moment := startMs + 871_000
	timeline := fmt.Sprintf(`{"startTs":%d,"lines":[{"t":"open","s":null,"r":"/pay","a":%d},{"t":"idle","s":null,"r":"/pay","a":%d,"k":"idle"},{"t":"click Pay","s":"#pay","r":"/pay","a":%d},{"t":"spinner","s":null,"r":"/pay","a":%d}]}`, startMs, startMs+1_000, startMs+2_000, moment, moment+4_000)
	exec(`INSERT INTO session_narratives(session_id,project_id,environment_id,status,narrative,timeline,prompt_version)
		SELECT id,project_id,environment_id,'ok','{}'::jsonb,$2::jsonb,1 FROM sessions WHERE id=$1`, representative, timeline)
	exec(`UPDATE friction_check_attempts SET evidence_lines='["L4","L2","L3"]' WHERE ticket_id=$1 AND session_id=$2`, f.ticket, representative)
	if facts := load(); facts.RepresentativeAnchorMs != moment || facts.RepresentativeAnchorMs < startMs {
		t.Fatalf("timeline anchor=%d want %d", facts.RepresentativeAnchorMs, moment)
	}
	// Citations that resolve to nothing fall back to the verified signal.
	exec(`UPDATE friction_check_attempts SET evidence_lines='["L2","L9"]' WHERE ticket_id=$1 AND session_id=$2`, f.ticket, representative)
	if facts := load(); facts.RepresentativeAnchorMs != wantSignal {
		t.Fatalf("unresolvable citation anchor=%d want %d", facts.RepresentativeAnchorMs, wantSignal)
	}
	// A non-ok narrative is not evidence either.
	exec(`UPDATE friction_check_attempts SET evidence_lines='["L3"]' WHERE ticket_id=$1 AND session_id=$2`, f.ticket, representative)
	exec(`UPDATE session_narratives SET status='failed',narrative=NULL WHERE session_id=$1`, representative)
	if facts := load(); facts.RepresentativeAnchorMs != wantSignal {
		t.Fatalf("failed narrative anchor=%d want %d", facts.RepresentativeAnchorMs, wantSignal)
	}
}
```

Add `"fmt"` to that file's imports:

```go
import (
	"context"
	"fmt"
	"github.com/opslane/opslane/packages/ingestion/db"
	"testing"
	"time"
)
```

- [ ] **Step 6: Run it to verify it fails**

Run (with the Test database env exported): `cd packages/ingestion && go test ./db -run TestTicketDigestFactsRepresentativeReplayAnchor -count=1 -v`
Expected: FAIL to compile with `facts.RepresentativeAnchorMs undefined`.

- [ ] **Step 7: Implement the field and query**

In `packages/ingestion/db/ticket_evidence.go`:

1. Add the field to `TicketDigestFacts`, directly after `RepresentativeSessionID, RepresentativeNote string`:

```go
	// RepresentativeAnchorMs is the absolute client-clock time the replay link
	// seeks to: the earliest timeline line the representative session's
	// confirmed check cited, else that check's earliest verified signal, else 0.
	RepresentativeAnchorMs int64
```

2. In the second query of `LoadTicketDigestFacts`, add the attempt ID as the first selected column. Change the start of the SQL from

```go
	rows, err := q.Query(ctx, `SELECT m.session_id,coalesce(m.end_user_id::text,''),coalesce(u.account_name,''),
```

to

```go
	rows, err := q.Query(ctx, `SELECT a.id::text,m.session_id,coalesce(m.end_user_id::text,''),coalesce(u.account_name,''),
```

3. Replace the scan loop header and scan with attempt/signal capture:

```go
	users, accounts, signals := map[string]bool{}, map[string]bool{}, map[string]bool{}
	sessions := []string{}
	attempts := []string{}
	sessionSignals := [][]string{}
	for rows.Next() {
		var attempt, session, user, account, note string
		var ids []string
		if err := rows.Scan(&attempt, &session, &user, &account, &ids, &note); err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
		attempts = append(attempts, attempt)
		sessionSignals = append(sessionSignals, ids)
```

(the rest of the loop body is unchanged).

4. Immediately after the `if err := rows.Err(); err != nil { return nil, err }` block, add `rows.Close()` so the follow-up query can run on the same transaction:

```go
	rows.Close()
```

5. Replace the final representative block with:

```go
	if len(sessions) > 0 {
		median := (len(sessions) - 1) / 2
		f.RepresentativeSessionID = sessions[median]
		f.RepresentativeNote = f.ConfirmedNotes[median]
		anchor, err := representativeReplayAnchor(ctx, q, projectID, attempts[median], sessionSignals[median])
		if err != nil {
			return nil, err
		}
		f.RepresentativeAnchorMs = anchor
	}
	return &f, nil
}

// representativeReplayAnchor loads one finalized check attempt's citations and
// its session's narrative timeline. The timeline is the one the check read: a
// narrative reaches status ok once and its timeline is never rewritten.
func representativeReplayAnchor(ctx context.Context, q TicketEvidenceQuerier, projectID, attemptID string, signalIDs []string) (int64, error) {
	if signalIDs == nil {
		signalIDs = []string{}
	}
	var evidenceLines []string
	var timeline []byte
	var signalMs *int64
	err := q.QueryRow(ctx, `SELECT ARRAY(SELECT jsonb_array_elements_text(coalesce(a.evidence_lines,'[]'))),n.timeline,
 (SELECT (extract(epoch FROM min(s.occurred_at))*1000)::bigint FROM friction_signals s
  WHERE s.id::text=ANY($3::text[]) AND s.session_id=a.session_id AND s.project_id=t.project_id)
 FROM friction_check_attempts a
 JOIN friction_tickets t ON t.id=a.ticket_id AND t.project_id=$2
 LEFT JOIN session_narratives n ON n.session_id=a.session_id AND n.project_id=t.project_id AND n.status='ok'
 WHERE a.id=$1`, attemptID, projectID, signalIDs).Scan(&evidenceLines, &timeline, &signalMs)
	if err != nil {
		return 0, fmt.Errorf("load ticket replay anchor: %w", err)
	}
	if anchor, ok := timelineAnchorMs(evidenceLines, timeline); ok {
		return anchor, nil
	}
	if signalMs != nil && *signalMs > 0 {
		return *signalMs, nil
	}
	return 0, nil
}
```

Note: `jsonb_array_elements_text` raises on a non-array. `evidence_lines` is `JSONB NOT NULL DEFAULT '[]'` and the worker always writes an array, so no extra guard.

- [ ] **Step 8: Run the db tests to verify they pass**

Run: `cd packages/ingestion && go test ./db -run 'TestTimelineAnchorMs|TestTicketDigestFacts|TestTicketFix' -count=1 -v 2>&1 | grep -E '^(=== RUN|--- (PASS|FAIL|SKIP)|PASS|FAIL|ok)'`
Expected: every test PASS, zero `--- SKIP`.

- [ ] **Step 9: Commit**

```bash
git add packages/ingestion/db/ticket_evidence.go packages/ingestion/db/ticket_evidence_test.go packages/ingestion/db/ticket_replay_anchor_test.go
git commit -m "fix(ingestion): resolve the representative ticket session's replay anchor

LoadTicketDigestFacts now resolves where the representative verified
session's confirmed check saw the problem: the earliest cited timeline
line, else the earliest verified signal, else 0.

Refs #497"
```

---

### Task 2: Ticket digest links seek to the anchor

**Files:**
- Modify: `packages/ingestion/digest/freeze_friction.go:105-107`
- Modify: `packages/ingestion/digest/validate.go` (three ticket `BuildSessionURL(..., 0)` calls, currently near lines 966, 1125, 1505)
- Test: `packages/ingestion/digest/known_problems_integration_test.go`

**Interfaces:**
- Consumes: `db.TicketDigestFacts.RepresentativeAnchorMs int64` from Task 1.
- Produces: frozen ticket `Candidate.ReplayAnchorMs` equals `RepresentativeAnchorMs`; `GeneratedDigestCard.ReplayURL` and ticket `ReceiptItem.SessionURL` carry `t=<anchor>`.

- [ ] **Step 1: Write the failing freeze assertion**

In `TestKnownProblemDigestFreezeValidateAndMergedFooter` (`packages/ingestion/digest/known_problems_integration_test.go`), the representative is `ticket+"-2"`. Insert this block immediately before `at := time.Now()`:

```go
	// The representative session's confirmed check cited the moment 14:31 in.
	var repStartMs int64
	if err := pool.QueryRow(ctx, `SELECT (extract(epoch FROM started_at)*1000)::bigint FROM sessions WHERE id=$1`, ticket+"-2").Scan(&repStartMs); err != nil {
		t.Fatal(err)
	}
	wantAnchor := repStartMs + 871_000
	repTimeline := fmt.Sprintf(`{"startTs":%d,"lines":[{"t":"open view","s":null,"r":"/view","a":%d},{"t":"click Apply","s":"#apply","r":"/view","a":%d},{"t":"nothing happens","s":null,"r":"/view","a":%d}]}`, repStartMs, repStartMs+1_000, wantAnchor, wantAnchor+3_000)
	run(`INSERT INTO session_narratives(session_id,project_id,environment_id,status,narrative,timeline,prompt_version)VALUES($1,$2,$3,'ok','{}'::jsonb,$4::jsonb,1)`, ticket+"-2", p.ID, env, repTimeline)
	run(`UPDATE friction_check_attempts SET evidence_lines='["L3","L2"]' WHERE ticket_id=$1 AND session_id=$2`, ticket, ticket+"-2")
```

Then extend the existing candidate check. Replace

```go
	if c.Coverage != .5 || c.VerifiedSessions != 4 || c.VerifiedUsers != 4 || strings.Join(c.Accounts, ",") != "Acme,Beta" || c.RepresentativeSessionID != ticket+"-2" || c.ValidAction != "Fix in progress" || c.EvidenceVersion != 4 {
		t.Fatalf("candidate=%+v", c)
	}
```

with

```go
	if c.Coverage != .5 || c.VerifiedSessions != 4 || c.VerifiedUsers != 4 || strings.Join(c.Accounts, ",") != "Acme,Beta" || c.RepresentativeSessionID != ticket+"-2" || c.ValidAction != "Fix in progress" || c.EvidenceVersion != 4 {
		t.Fatalf("candidate=%+v", c)
	}
	if c.ReplaySessionID != ticket+"-2" || c.ReplayAnchorMs != wantAnchor || c.ReplayAnchorMs < repStartMs {
		t.Fatalf("ticket replay=%s@%d want %s@%d", c.ReplaySessionID, c.ReplayAnchorMs, ticket+"-2", wantAnchor)
	}
```

Note: the existing `ValidateAndPublish(ctx, pool, runID)` call in this test runs without `DASHBOARD_URL`; do not assert its replay URL here. The published-link assertion lives in Step 2.

- [ ] **Step 2: Write the failing published-link assertions**

In `testTicketDigestActionAfterAuthoringCycle` (same file), the representative of three sessions is `ticket+"-1"`. Directly after the `for i := 0; i < 3; i++ { ... }` loop, add:

```go
	var repStartMs int64
	if err := pool.QueryRow(ctx, `SELECT (extract(epoch FROM started_at)*1000)::bigint FROM sessions WHERE id=$1`, ticket+"-1").Scan(&repStartMs); err != nil {
		t.Fatal(err)
	}
	wantAnchor := repStartMs + 871_000
	run(`INSERT INTO session_narratives(session_id,project_id,environment_id,status,narrative,timeline,prompt_version)VALUES($1,$2,$3,'ok','{}'::jsonb,$4::jsonb,1)`,
		ticket+"-1", project.ID, env, fmt.Sprintf(`{"startTs":%d,"lines":[{"t":"click Save","s":"#save","r":"/save","a":%d}]}`, repStartMs, wantAnchor))
	run(`UPDATE friction_check_attempts SET evidence_lines='["L1"]' WHERE ticket_id=$1 AND session_id=$2`, ticket, ticket+"-1")
	wantReplay := notify.BuildSessionURL("https://app.example", ticket+"-1", wantAnchor)
```

In the same function, in the `if deferred {` branch, replace

```go
				if receipt.RootCauseExcerpt != changedCause || receipt.Action != "Create fix PR" {
					t.Fatalf("stale receipt=%+v", receipt)
				}
```

with

```go
				if receipt.RootCauseExcerpt != changedCause || receipt.Action != "Create fix PR" {
					t.Fatalf("stale receipt=%+v", receipt)
				}
				if receipt.SessionURL != wantReplay {
					t.Fatalf("ticket receipt replay=%q want %q", receipt.SessionURL, wantReplay)
				}
```

and in the `} else {` branch, replace

```go
		if len(published.Digest.GeneratedCards) != 1 {
			t.Fatalf("authored card was lost: %+v", published.Digest)
		}
```

with

```go
		if len(published.Digest.GeneratedCards) != 1 {
			t.Fatalf("authored card was lost: %+v", published.Digest)
		}
		if published.Digest.GeneratedCards[0].ReplayURL != wantReplay {
			t.Fatalf("ticket card replay=%q want %q", published.Digest.GeneratedCards[0].ReplayURL, wantReplay)
		}
```

Also add, right after `frozen := candidateByGroup(t, candidates, group)`:

```go
	if frozen.ReplayAnchorMs != wantAnchor {
		t.Fatalf("frozen ticket anchor=%d want %d", frozen.ReplayAnchorMs, wantAnchor)
	}
```

Also assert the delivered Slack body carries the link. After the existing `body, _, err := notify.FormatSlack(published)` error check, add:

```go
	// slackDigestLink renders <url|Replay>; JSON encoding escapes the angle
	// brackets, so match the URL and its label.
	if !strings.Contains(string(body), wantReplay+"|Replay") {
		t.Fatalf("Slack body lost the anchored replay link %q: %s", wantReplay, body)
	}
```

If this fails only because `masking.RedactBody`/`RedactURL` in `slackDigestLink` rewrote the URL, stop and report it: that would be a real delivery defect, not a test problem.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/ingestion && go test ./digest -run 'TestKnownProblemDigestFreezeValidateAndMergedFooter|TestTicketDigestSignsLatestAttemptAfterAuthoringCycle|TestTicketDigestDeferredChangedCauseUsesLiveReceipt' -count=1 -v 2>&1 | grep -E '^(=== RUN|--- (PASS|FAIL|SKIP)|\s+known_problems|PASS|FAIL|ok)'`
Expected: all three FAIL (`ticket replay=...@0`, `frozen ticket anchor=0`), zero SKIP.

- [ ] **Step 4: Stamp the anchor at freeze**

In `packages/ingestion/digest/freeze_friction.go`, replace

```go
			candidate.ReplaySessionID = f.RepresentativeSessionID
```

with

```go
			candidate.ReplaySessionID = f.RepresentativeSessionID
			candidate.ReplayAnchorMs = f.RepresentativeAnchorMs
```

- [ ] **Step 5: Use the anchor in every ticket link**

In `packages/ingestion/digest/validate.go`, make these three replacements (each string is unique in the file):

```go
				candidate.SessionURL = notify.BuildSessionURL(dashboardURL, candidate.TicketFacts.RepresentativeSessionID, 0)
```
→
```go
				candidate.SessionURL = notify.BuildSessionURL(dashboardURL, candidate.TicketFacts.RepresentativeSessionID, candidate.TicketFacts.RepresentativeAnchorMs)
```

```go
					item.SessionURL = notify.BuildSessionURL(os.Getenv("DASHBOARD_URL"), live.TicketFacts.RepresentativeSessionID, 0)
```
→
```go
					item.SessionURL = notify.BuildSessionURL(os.Getenv("DASHBOARD_URL"), live.TicketFacts.RepresentativeSessionID, live.TicketFacts.RepresentativeAnchorMs)
```

```go
		item.SessionURL = notify.BuildSessionURL(os.Getenv("DASHBOARD_URL"), candidate.RepresentativeSessionID, 0)
```
→
```go
		item.SessionURL = notify.BuildSessionURL(os.Getenv("DASHBOARD_URL"), candidate.RepresentativeSessionID, candidate.ReplayAnchorMs)
```

Then confirm no ticket link still hard-codes zero:

Run: `grep -rn "BuildSessionURL(.*, 0)" packages/ingestion --include=*.go | grep -v _test.go`
Expected: no output.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/ingestion && go test ./digest -run 'TestKnownProblem|TestTicketDigest|TestFreeze' -count=1 -v 2>&1 | grep -E '^(--- (PASS|FAIL|SKIP)|PASS|FAIL|ok)'`
Expected: all PASS (includes the legacy anchor tests in `freeze_test.go`), zero SKIP.

- [ ] **Step 7: Run the ingestion build and the affected packages**

Run: `cd packages/ingestion && go build ./... && go vet ./db ./digest && go test ./digest ./notify -count=1 -timeout 30m 2>&1 | tail -5`
Expected: `ok` for both packages. Then run `go test ./db -count=1 -timeout 30m 2>&1 | tail -3` (about 15 minutes) and confirm `ok`.

- [ ] **Step 8: Commit**

```bash
git add packages/ingestion/digest/freeze_friction.go packages/ingestion/digest/validate.go packages/ingestion/digest/known_problems_integration_test.go
git commit -m "fix(digest): seek known-problem replay links to the confirmed moment

Ticket cards froze a replay session with no anchor, so every card and
receipt linked ?t=0. Freeze now stamps the representative session's
anchor, and live ticket receipts use the same value.

Fixes #497"
```

---

## Self-Review

- Issue AC 1 (non-zero anchor inside the session, at or before the first cited line): Task 1 Step 5 and Task 2 Step 1 assert the exact cited moment and `>= started_at`.
- Issue AC 2 (delivered Slack link seeks): Task 2 Step 2 asserts the generated card URL, the live receipt URL, and the formatted Slack body.
- Issue AC 3 (legacy unchanged): no legacy code touched; Task 2 Step 6 runs `TestFreeze*`, which includes the existing legacy anchor tests in `freeze_test.go`.
- Fallback to the matched signal's `occurred_at`: Task 1 Step 5 (no narrative, unresolvable citations, failed narrative; earliest verified signal, not an unverified or unmatched one).

## Review decisions

Codex round 1 (session `01a0a0f6-ee7e-7441-964a-18ab23e42297`):

- Accepted: reject malformed timelines (missing/null `startTs`, non-positive or >2^53 timestamps); prove the signal fallback picks the earliest *verified* signal with decoys; assert the exact Slack `url|Replay` link.
- Rejected, clamp to `session_chunks` bounds: the dashboard already chooses the nearest segment and clamps the seek to loaded events, and cited lines come from the session's own chunks.
- Rejected, first array entry instead of earliest cited line: the earliest line is at or before the first cited line under both readings of AC 1; citation order is model output with no meaning.
- Rejected, fold the anchor into the per-session evidence query: that detoasts every verified session's timeline JSON (up to ~65 KB each) to use one; a single-row follow-up query is cheaper.

Codex round 2 (session `01a0a0fc-739c-7d41-b880-418f1e8537a3`): no P1; fixtures, representative selection, call-site coverage, and `rows.Close()` before the follow-up query confirmed.

- Accepted, fixture: the signal-fallback test seeded signals before the session started. The test now moves the representative session's `started_at` back five hours.
- Rejected, clamp the signal fallback to session bounds in production: atomic signals take `occurred_at` from a cited timeline line or `startTs` (`packages/worker/src/narrative/emit.ts` `buildSignalRows`), the same client clock as the recording, and the dashboard clamps the seek regardless. `sessions.started_at` is not a trustworthy bound for client-clock times.

Pre-landing `/review` after implementation (specialists, Claude adversarial, two Codex passes), with the user's decisions:

- Degrade, do not fail: the anchor is decoration, so a representative attempt purged between statements (`pgx.ErrNoRows`) or a malformed `evidence_lines` value (non-array, null elements) falls back to the verified signal time or 0 instead of aborting the project's freeze, validation, or incident page. Real SQL errors still fail, like the evidence query.
- Load the anchor only where it is used: `LoadTicketDigestFacts` records `RepresentativeAttemptID` and `RepresentativeSignalMs` (the earliest verified signal, computed in its existing lateral, which also removes the `uuid::text` cast), and `db.LoadTicketReplayAnchor` runs only from digest `loadActionableCandidates` for on-card tickets. The incident list and detail pages and the validation gate no longer fetch timelines.
- Receipt fallback links take the session and anchor from the same frozen pair (`ReplaySessionID`, `ReplayAnchorMs`).
- Tests added for a decoy signal from another session, a staging attempt with different citations, null and non-array citations, a purged attempt, cross-project scope, and the final fallback to 0.
