# Session Analysis Facts Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One typed `session_analysis` facts row per session written by the analyzer, detector suppressions that fix the measured false-positive sources, evidence-window adjudication behind a flag, rule-version supersession repair, and read-path surfacing — per `docs/superpowers/specs/2026-08-07-session-tags-analysis-layer-design.md`.

**Architecture:** The worker's existing `session_analysis` job gains a pure fact-extraction pass (`facts.ts`) whose output is upserted into a new `session_analysis` table (analyzer is sole writer; attribution keyed to `session_started_at`). The friction detectors in `analyzer.ts` gain four suppressions, per-occurrence timestamps, and retire `form_abandon` at RULE_VERSION 2; `persist.ts` gains supersession of prior-version rows. Adjudication keeps its per-signal interface and gates but can receive a condensed ±15s evidence window per occurrence (off/shadow/on flag, daily call cap). Ingestion joins the facts into the session list/detail; the dashboard renders chips; a Go command backfills re-analysis.

**Tech Stack:** Go 1.24 + pgx (ingestion), Node 22 + TypeScript ESM + Vitest (worker), Vue 3 (dashboard), Postgres.

## Global Constraints

- ESM + strict TypeScript; `unknown` + narrowing, never `any` (root AGENTS.md).
- Vitest tests colocated in `__tests__` directories.
- Migrations re-run on every boot with no tracking table — every statement idempotent (`002_sessions.sql:4-6` pattern).
- Preserve terminal-status and lease contracts; `processSessionAnalysisJob`'s LeaseLostError/abort rethrow paths must not change shape (worker AGENTS.md).
- The `POST /api/v1/events` wire contract is untouched by this plan.
- Fence untrusted page content (selectors, URLs) in model prompts (worker AGENTS.md); the evidence window is untrusted page content.
- Server-side code is AGPL-3.0-only; nothing in this plan touches the MIT SDK boundary.
- Prod data must not enter the repo; test fixtures are synthetic.
- Worker verification: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`. Ingestion: `(cd packages/ingestion && go build ./... && go test ./...)`. DB-gated Go tests skip without `DATABASE_URL` — export it and read skip counts (root AGENTS.md).

---

### Task 1: Migration 038 — `session_analysis` table + `friction_signals.occurred_ats`

**Files:**
- Create: `packages/ingestion/db/migrations/038_session_analysis.sql`
- Test: `packages/ingestion/db/session_analysis_test.go`

**Interfaces:**
- Produces: table `session_analysis` (columns exactly as below — worker Task 3 upserts into it, ingestion Task 8/10 read it); column `friction_signals.occurred_ats JSONB` (worker Task 4/5 write it, Task 7 reads it).

- [ ] **Step 1: Write the failing DB test FIRST** (the migration does not exist yet, so the relation-missing failure is real)

The test content is in Step 2 below — write it now, before the migration file exists.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./db -run TestSessionAnalysisUpsertRoundTrip -v
```
Expected: FAIL — relation `session_analysis` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- 038_session_analysis.sql
-- Typed per-session facts written solely by the worker analyzer
-- (2026-08-07 session-analysis design). Idempotent: re-run on every boot.

CREATE TABLE IF NOT EXISTS session_analysis (
  session_id          TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  project_id          UUID NOT NULL,
  environment_id      UUID,
  session_started_at  TIMESTAMPTZ NOT NULL,
  coverage            TEXT NOT NULL CHECK (coverage IN ('complete','partial','no_replay')),
  activity_class      TEXT NOT NULL CHECK (activity_class IN
                        ('active','light_touch','zero_interaction','idle_tab','unknown')),
  entry_path          TEXT,
  click_count         INTEGER NOT NULL DEFAULT 0,
  input_event_count   INTEGER NOT NULL DEFAULT 0,
  page_event_count    INTEGER NOT NULL DEFAULT 0,
  failed_request_4xx_count          INTEGER NOT NULL DEFAULT 0,
  failed_request_5xx_count          INTEGER NOT NULL DEFAULT 0,
  unattributed_failed_request_count INTEGER NOT NULL DEFAULT 0,
  successful_write_count            INTEGER NOT NULL DEFAULT 0,
  failed_write_count                INTEGER NOT NULL DEFAULT 0,
  rule_version        INTEGER NOT NULL,
  analyzed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Digest/trend attribution key: session start, never analyzed_at, so
-- re-analysis and backfill cannot shift history (spec: "attribution").
CREATE INDEX IF NOT EXISTS idx_session_analysis_rollup
  ON session_analysis (project_id, session_started_at);

-- Per-occurrence timestamps (epoch ms array) so adjudication evidence
-- windows can center on each occurrence instead of the fold-min.
-- Semantics: one entry per PERSISTED occurrence unit — one per dead-click
-- occurrence, one per rage-click CLUSTER (the detector fires once per
-- cluster). Length tracks occurrence_count, not raw click count.
ALTER TABLE friction_signals
  ADD COLUMN IF NOT EXISTS occurred_ats JSONB;

-- Durable per-project daily adjudication budget. A unit is reserved
-- atomically BEFORE every outbound model call (including shadow calls and
-- calls that subsequently fail), so concurrent jobs cannot overspend.
CREATE TABLE IF NOT EXISTS adjudication_call_budget (
  project_id UUID NOT NULL,
  day        DATE NOT NULL,
  calls      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day)
);
```

- [ ] **Step 1 (content): The DB test**

Follow the existing db-test pattern in `packages/ingestion/db` (tests skip without `DATABASE_URL`; look at a neighboring `*_test.go` for the `testQueries(t)` helper the package uses and reuse it).

```go
package db

import (
	"context"
	"testing"
)

func TestSessionAnalysisUpsertRoundTrip(t *testing.T) {
	q := testQueries(t) // skips when DATABASE_URL is unset, runs migrations
	ctx := context.Background()

	seedProjectAndSession(t, q, "sa-proj", "sa-sess-1") // reuse/extend existing seed helper

	_, err := q.pool.Exec(ctx, `
		INSERT INTO session_analysis
		  (session_id, project_id, session_started_at, coverage, activity_class,
		   entry_path, click_count, rule_version)
		VALUES ($1, $2, now() - interval '1 day', 'complete', 'active', '/assets', 5, 2)
		ON CONFLICT (session_id) DO UPDATE SET
		  coverage = EXCLUDED.coverage, activity_class = EXCLUDED.activity_class,
		  click_count = EXCLUDED.click_count, rule_version = EXCLUDED.rule_version,
		  analyzed_at = now()`,
		"sa-sess-1", testProjectID)
	if err != nil {
		t.Fatalf("insert session_analysis: %v", err)
	}

	var coverage string
	var clicks int
	err = q.pool.QueryRow(ctx,
		`SELECT coverage, click_count FROM session_analysis WHERE session_id = $1`,
		"sa-sess-1").Scan(&coverage, &clicks)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if coverage != "complete" || clicks != 5 {
		t.Fatalf("got coverage=%q clicks=%d", coverage, clicks)
	}

	// CHECK constraint enforces the closed enums. Use a SECOND session so a
	// primary-key violation cannot masquerade as the CHECK failure, and
	// assert the specific Postgres error code (23514 = check_violation).
	seedProjectAndSession(t, q, "sa-proj", "sa-sess-2")
	_, err = q.pool.Exec(ctx, `
		INSERT INTO session_analysis
		  (session_id, project_id, session_started_at, coverage, activity_class, rule_version)
		VALUES ($1, $2, now(), 'bogus', 'active', 2)`,
		"sa-sess-2", testProjectID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("expected check_violation (23514) for coverage='bogus', got %v", err)
	}
}
```

If the package has no `seedProjectAndSession` helper, inline the two inserts (project row + minimal `sessions` row) the way the existing sessions tests do. Imports: `errors` and `github.com/jackc/pgx/v5/pgconn`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./db -run TestSessionAnalysisUpsertRoundTrip -v
```
Expected: PASS (the test harness runs migrations; confirm the runner picks up `038_*` — it globs the migrations dir). Run it twice against the same database to prove idempotence (the second run re-applies every migration).

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/migrations/038_session_analysis.sql packages/ingestion/db/session_analysis_test.go
git commit -m "feat(db): session_analysis facts table and per-occurrence signal timestamps"
```

---

### Task 2: `facts.ts` — pure fact extraction

**Files:**
- Create: `packages/worker/src/friction/facts.ts`
- Modify: `packages/worker/src/friction/fingerprint.ts` (add `normalizeEntryPath`)
- Test: `packages/worker/src/friction/__tests__/facts.test.ts`

**Interfaces:**
- Consumes: `SessionChunkEnvelope` from `@opslane/shared`; `extractTelemetryEvents` from `analyzer.ts` (import it — do not duplicate it).
- **`normalizeEntryPath(href: string): string | null`** — NEW export from `fingerprint.ts`, returns the normalized **pathname only** (no origin): strips query/hash, drops `_ctx_*` segments, templates numeric/uuid/hex segments to `:id`. This is deliberately separate from `normalizePageUrl`, which returns `origin+path` and is a fingerprint identity — Task 4 touches that one.
- Produces (Task 3 depends on these exact names):

```ts
export type Coverage = 'complete' | 'partial' | 'no_replay';
export type ActivityClass = 'active' | 'light_touch' | 'zero_interaction' | 'idle_tab' | 'unknown';
export interface SessionFacts {
  entryPath: string | null;
  clickCount: number;
  inputEventCount: number;
  pageEventCount: number;
  failedRequest4xxCount: number;
  failedRequest5xxCount: number;
  unattributedFailedRequestCount: number;
  successfulWriteCount: number;
  failedWriteCount: number;
  firstEventMs: number | null;
  lastEventMs: number | null;
}
export function extractSessionFacts(chunks: SessionChunkEnvelope[]): SessionFacts;
export function classifyActivity(facts: SessionFacts, coverage: Coverage): ActivityClass;
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/friction/__tests__/facts.test.ts
import { describe, expect, it } from 'vitest';
import { extractSessionFacts, classifyActivity } from '../facts.js';
import { normalizeEntryPath } from '../fingerprint.js';
import type { SessionChunkEnvelope } from '@opslane/shared';

const T0 = 1_754_000_000_000;

function telemetry(at: number, payload: Record<string, unknown>) {
  return { type: 5, timestamp: at, data: { tag: 'opslane.telemetry', payload: { at, ...payload } } };
}
function page(at: number, href: string) {
  return { type: 4, timestamp: at, data: { href, width: 1440, height: 900 } };
}
function input(at: number, id: number) {
  return { type: 3, timestamp: at, data: { source: 5, id } };
}
function envelope(events: unknown[]): SessionChunkEnvelope {
  return { events, meta: { sdk_version: 'test', has_full_snapshot: true, chunked_at: new Date(T0).toISOString() } } as SessionChunkEnvelope;
}

describe('extractSessionFacts', () => {
  it('counts same-origin request failures by class and excludes cross-origin', () => {
    const facts = extractSessionFacts([envelope([
      page(T0, 'https://app.example.com/assets'),
      telemetry(T0 + 1000, { kind: 'request_start', requestId: 'r1', clickId: null, method: 'GET', url: 'https://app.example.com/api/things' }),
      telemetry(T0 + 1200, { kind: 'request_end', requestId: 'r1', status: 404 }),
      telemetry(T0 + 2000, { kind: 'request_start', requestId: 'r2', clickId: null, method: 'POST', url: 'https://dead-sdk.example.net/api/v1/events' }),
      telemetry(T0 + 2200, { kind: 'request_end', requestId: 'r2', status: 400 }),
      telemetry(T0 + 3000, { kind: 'request_start', requestId: 'r3', clickId: null, method: 'GET', url: '/api/relative' }),
      telemetry(T0 + 3200, { kind: 'request_end', requestId: 'r3', status: 500 }),
    ])]);
    expect(facts.failedRequest4xxCount).toBe(1);   // cross-origin 400 excluded
    expect(facts.failedRequest5xxCount).toBe(1);   // relative URL is same-origin
    expect(facts.unattributedFailedRequestCount).toBe(0);
  });

  it('counts an end with no recorded start as unattributed', () => {
    const facts = extractSessionFacts([envelope([
      page(T0, 'https://app.example.com/panel'),
      telemetry(T0 + 500, { kind: 'request_end', requestId: 'ghost', status: 401 }),
    ])]);
    expect(facts.unattributedFailedRequestCount).toBe(1);
    expect(facts.failedRequest4xxCount).toBe(0);
  });

  it('counts same-origin writes by result', () => {
    const facts = extractSessionFacts([envelope([
      page(T0, 'https://app.example.com/form'),
      telemetry(T0 + 1000, { kind: 'request_start', requestId: 'w1', clickId: null, method: 'POST', url: 'https://app.example.com/api/save' }),
      telemetry(T0 + 1200, { kind: 'request_end', requestId: 'w1', status: 201 }),
      telemetry(T0 + 2000, { kind: 'request_start', requestId: 'w2', clickId: null, method: 'PUT', url: 'https://app.example.com/api/save' }),
      telemetry(T0 + 2200, { kind: 'request_end', requestId: 'w2', status: 422 }),
      telemetry(T0 + 3000, { kind: 'request_start', requestId: 'w3', clickId: null, method: 'GET', url: 'https://app.example.com/api/read' }),
      telemetry(T0 + 3100, { kind: 'request_end', requestId: 'w3', status: 200 }),
    ])]);
    expect(facts.successfulWriteCount).toBe(1);  // GET 200 is not a write
    expect(facts.failedWriteCount).toBe(1);
  });

  it('extracts normalized entry path (pathname only) from the EARLIEST page event', () => {
    // chunks deliberately out of order: the later page appears first in the array
    const facts = extractSessionFacts([envelope([
      page(T0 + 1000, 'https://app.example.com/other'),
      page(T0, 'https://app.example.com/assets/12345/edit?tab=1#x'),
    ])]);
    expect(facts.entryPath).toBe('/assets/:id/edit');   // no origin, earliest by timestamp
    expect(facts.pageEventCount).toBe(2);
  });

  it('normalizeEntryPath strips _ctx blobs and templates uuid segments', () => {
    expect(normalizeEntryPath('https://x.test/a1b2c3d4-1111-2222-3333-444455556666/global-page/_ctx_H4sIAAAA/'))
      .toBe('/:id/global-page');
    expect(normalizeEntryPath('not a url')).toBeNull();
  });

  it('treats only 500-599 as 5xx', () => {
    const facts = extractSessionFacts([envelope([
      page(T0, 'https://app.example.com/x'),
      telemetry(T0 + 1000, { kind: 'request_start', requestId: 'q1', clickId: null, method: 'GET', url: '/api/a' }),
      telemetry(T0 + 1100, { kind: 'request_end', requestId: 'q1', status: 599 }),
      telemetry(T0 + 2000, { kind: 'request_start', requestId: 'q2', clickId: null, method: 'GET', url: '/api/b' }),
      telemetry(T0 + 2100, { kind: 'request_end', requestId: 'q2', status: 600 }),  // nonstandard: not counted
    ])]);
    expect(facts.failedRequest5xxCount).toBe(1);
  });

  it('returns null entry path and zero counts for no chunks', () => {
    const facts = extractSessionFacts([]);
    expect(facts.entryPath).toBeNull();
    expect(facts.clickCount).toBe(0);
    expect(facts.firstEventMs).toBeNull();
  });
});

describe('classifyActivity', () => {
  const base = extractSessionFacts([]);
  it('is unknown whenever coverage is not complete', () => {
    expect(classifyActivity({ ...base, clickCount: 9 }, 'partial')).toBe('unknown');
    expect(classifyActivity(base, 'no_replay')).toBe('unknown');
  });
  it('classifies idle_tab: span >= 10min, zero interactions', () => {
    expect(classifyActivity(
      { ...base, firstEventMs: T0, lastEventMs: T0 + 11 * 60_000 }, 'complete',
    )).toBe('idle_tab');
  });
  it('classifies zero_interaction below the idle span', () => {
    expect(classifyActivity(
      { ...base, firstEventMs: T0, lastEventMs: T0 + 30_000 }, 'complete',
    )).toBe('zero_interaction');
  });
  it('classifies light_touch at 1-2 interactions and active at >=3', () => {
    expect(classifyActivity({ ...base, clickCount: 2 }, 'complete')).toBe('light_touch');
    expect(classifyActivity({ ...base, clickCount: 2, inputEventCount: 1 }, 'complete')).toBe('active');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @opslane/worker test -- facts
```
Expected: FAIL — `../facts.js` not found.

- [ ] **Step 3: Implement `normalizeEntryPath` in `fingerprint.ts`, then `facts.ts`**

Add to `fingerprint.ts` (alongside `normalizePageUrl`, which is NOT modified in this task):

```ts
/** Normalized pathname only (no origin) for session entry attribution:
 * strips query/hash, drops Forge `_ctx_*` blob segments, templates numeric
 * and uuid/hex-like segments to `:id`. Returns null for unparseable input. */
export function normalizeEntryPath(href: string): string | null {
  try {
    const url = new URL(href);
    const path = url.pathname
      .split('/')
      .filter((segment) => !segment.startsWith('_ctx_'))
      .map((segment) =>
        /^\d+$/.test(segment) || /^[0-9a-f-]{8,}$/i.test(segment) ? ':id' : segment,
      )
      .join('/');
    const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    return trimmed === '' ? '/' : trimmed;
  } catch {
    return null;
  }
}
```

```ts
// packages/worker/src/friction/facts.ts
import type { SessionChunkEnvelope } from '@opslane/shared';
import { extractTelemetryEvents } from './analyzer.js';
import { normalizeEntryPath } from './fingerprint.js';

export type Coverage = 'complete' | 'partial' | 'no_replay';
export type ActivityClass = 'active' | 'light_touch' | 'zero_interaction' | 'idle_tab' | 'unknown';

const IDLE_TAB_MIN_SPAN_MS = 10 * 60_000;
const ACTIVE_MIN_INTERACTIONS = 3;

export interface SessionFacts {
  entryPath: string | null;
  clickCount: number;
  inputEventCount: number;
  pageEventCount: number;
  failedRequest4xxCount: number;
  failedRequest5xxCount: number;
  unattributedFailedRequestCount: number;
  successfulWriteCount: number;
  failedWriteCount: number;
  firstEventMs: number | null;
  lastEventMs: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null; // relative URL — same-origin by definition
  }
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Pure and deterministic over scrubbed chunks, like analyzeSession. */
export function extractSessionFacts(chunks: SessionChunkEnvelope[]): SessionFacts {
  const facts: SessionFacts = {
    entryPath: null,
    clickCount: 0,
    inputEventCount: 0,
    pageEventCount: 0,
    failedRequest4xxCount: 0,
    failedRequest5xxCount: 0,
    unattributedFailedRequestCount: 0,
    successfulWriteCount: 0,
    failedWriteCount: 0,
    firstEventMs: null,
    lastEventMs: null,
  };

  // Page origins define same-origin; collected first so late requests
  // to an origin the user navigated to still count. Entry page is the
  // page event with the EARLIEST timestamp, not first in array order —
  // chunks can arrive out of chronological order.
  const pageOrigins = new Set<string>();
  let entryPageHref: string | null = null;
  let entryPageTs = Number.POSITIVE_INFINITY;
  for (const chunk of chunks) {
    if (!Array.isArray(chunk.events)) continue;
    for (const value of chunk.events) {
      if (!isRecord(value) || typeof value['timestamp'] !== 'number') continue;
      const ts = value['timestamp'];
      if (Number.isFinite(ts)) {
        facts.firstEventMs = facts.firstEventMs === null ? ts : Math.min(facts.firstEventMs, ts);
        facts.lastEventMs = facts.lastEventMs === null ? ts : Math.max(facts.lastEventMs, ts);
      }
      const data = value['data'];
      if (value['type'] === 4 && isRecord(data) && typeof data['href'] === 'string') {
        facts.pageEventCount += 1;
        const origin = originOf(data['href']);
        if (origin) pageOrigins.add(origin);
        if (ts < entryPageTs) { entryPageTs = ts; entryPageHref = data['href']; }
      }
      if (value['type'] === 3 && isRecord(data) && data['source'] === 5) {
        facts.inputEventCount += 1;
      }
    }
  }
  if (entryPageHref !== null) facts.entryPath = normalizeEntryPath(entryPageHref);

  const sameOrigin = (url: string): boolean => {
    const origin = originOf(url);
    return origin === null || pageOrigins.has(origin);
  };

  const startById = new Map<string, { method: string; url: string }>();
  for (const { event } of extractTelemetryEvents(chunks)) {
    if (event.kind === 'click') facts.clickCount += 1;
    if (event.kind === 'request_start') {
      startById.set(event.requestId, { method: event.method.toUpperCase(), url: event.url });
    }
    if (event.kind === 'request_end') {
      const start = startById.get(event.requestId);
      const status = event.status;
      if (!start) {
        if (status >= 400) facts.unattributedFailedRequestCount += 1;
        continue;
      }
      if (!sameOrigin(start.url)) continue;
      const isWrite = WRITE_METHODS.has(start.method);
      if (status >= 200 && status < 300 && isWrite) facts.successfulWriteCount += 1;
      if (status >= 400 && status < 600) {
        if (isWrite) facts.failedWriteCount += 1;
        if (status < 500) facts.failedRequest4xxCount += 1;
        else facts.failedRequest5xxCount += 1;
      }
    }
  }

  return facts;
}

export function classifyActivity(facts: SessionFacts, coverage: Coverage): ActivityClass {
  if (coverage !== 'complete') return 'unknown';
  const interactions = facts.clickCount + facts.inputEventCount;
  if (interactions >= ACTIVE_MIN_INTERACTIONS) return 'active';
  if (interactions >= 1) return 'light_touch';
  const span =
    facts.firstEventMs !== null && facts.lastEventMs !== null
      ? facts.lastEventMs - facts.firstEventMs
      : 0;
  return span >= IDLE_TAB_MIN_SPAN_MS ? 'idle_tab' : 'zero_interaction';
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @opslane/worker test -- facts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/friction/facts.ts packages/worker/src/friction/__tests__/facts.test.ts
git commit -m "feat(worker): pure session fact extraction with same-origin request accounting"
```

---

### Task 3: Analyzer writes the facts row — sole writer, coverage tri-state

**Files:**
- Modify: `packages/worker/src/db.ts` (near `getSessionForAnalysis`, `db.ts:1853`)
- Modify: `packages/worker/src/friction/chunk-reader.ts` (opt-in unreadable-chunk reporting)
- Modify: `packages/worker/src/friction/facts.ts` (add `deriveCoverage`)
- Modify: `packages/worker/src/index.ts:776-826` (`processSessionAnalysisJob`)
- Test: extend `packages/worker/src/friction/__tests__/facts.test.ts` (deriveCoverage) and `packages/worker/src/friction/__tests__/chunk-reader.test.ts` (skipUnreadable); create `packages/worker/src/__tests__/session-analysis-facts.integration.test.ts` (DB-gated)

**Interfaces:**
- Consumes: `extractSessionFacts`, `classifyActivity`, `Coverage` (Task 2); `getScrubbedChunksForSession` (`db.ts:1830`).
- `readChunksBounded(chunks, opts?: { skipUnreadable?: boolean })` — with the flag, a chunk that fails to gunzip/parse/validate is SKIPPED and counted in a new `unreadableCount` result field instead of throwing `ChunkReadError`. The result also gains `envelopeSeqs: number[]`, aligned with `envelopes` (`envelopeSeqs[i]` is the source chunk seq of `envelopes[i]`) so callers can map surviving envelopes back to chunks when some were skipped — Task 7's window loader depends on this. Default behavior (no flag) is byte-identical to today (`unreadableCount: 0`, `envelopeSeqs` fully populated) — the friction-evidence path and every existing caller keep their throw semantics. Systemic failures (MinIO unconfigured) still throw regardless of the flag.
- `deriveCoverage(input: { totalChunkCount: number; envelopeCount: number; truncated: boolean }): Coverage` — pure, exported from `facts.ts`. `totalChunkCount` is `sessions.chunk_count` — every COMMITTED chunk, not just scrubbed ones — so unscrubbed, scrub-failed, unreadable, and skipped chunks all surface as `envelopeCount < totalChunkCount`. Rules: zero readable envelopes → `'no_replay'`; `envelopeCount < totalChunkCount` or `truncated` → `'partial'`; otherwise `'complete'`. (A session with one readable and one unscrubbed chunk is `partial`, not `complete`.)
- Produces:

```ts
// db.ts additions
export interface SessionRow {            // extended — started_at added
  id: string; project_id: string; environment_id: string;
  end_user_id: string | null; status: string; started_at: string;
}
export interface SessionAnalysisUpsert {
  sessionId: string; projectId: string; environmentId: string | null;
  sessionStartedAt: string;              // ISO from sessions.started_at
  coverage: 'complete' | 'partial' | 'no_replay';
  activityClass: 'active' | 'light_touch' | 'zero_interaction' | 'idle_tab' | 'unknown';
  entryPath: string | null;
  clickCount: number; inputEventCount: number; pageEventCount: number;
  failedRequest4xxCount: number; failedRequest5xxCount: number;
  unattributedFailedRequestCount: number;
  successfulWriteCount: number; failedWriteCount: number;
  ruleVersion: number;
}
export async function upsertSessionAnalysis(row: SessionAnalysisUpsert): Promise<void>;
export async function getSessionAnalysis(sessionId: string, projectId: string): Promise<(SessionAnalysisUpsert & { analyzedAt: string }) | null>;
```

- [ ] **Step 1: Extend `getSessionForAnalysis` to select `started_at`**

In `db.ts:1859`, change the SELECT to `SELECT id, project_id, environment_id, end_user_id, status, started_at::text AS started_at, chunk_count` and add `started_at: string; chunk_count: number` to `SessionRow` (`db.ts:1845`). `chunk_count` is the committed-chunk total that coverage derivation compares against. Fix any compile fallout (`SessionRow` is imported by `persist.ts` and `promotion.ts`; they ignore the new fields).

- [ ] **Step 2: Implement `upsertSessionAnalysis` and `getSessionAnalysis` in `db.ts`**

```ts
export async function upsertSessionAnalysis(row: SessionAnalysisUpsert): Promise<void> {
  await getPool().query(
    `INSERT INTO session_analysis
       (session_id, project_id, environment_id, session_started_at, coverage,
        activity_class, entry_path, click_count, input_event_count, page_event_count,
        failed_request_4xx_count, failed_request_5xx_count,
        unattributed_failed_request_count, successful_write_count, failed_write_count,
        rule_version, analyzed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     ON CONFLICT (session_id) DO UPDATE SET
       coverage = EXCLUDED.coverage,
       activity_class = EXCLUDED.activity_class,
       entry_path = EXCLUDED.entry_path,
       click_count = EXCLUDED.click_count,
       input_event_count = EXCLUDED.input_event_count,
       page_event_count = EXCLUDED.page_event_count,
       failed_request_4xx_count = EXCLUDED.failed_request_4xx_count,
       failed_request_5xx_count = EXCLUDED.failed_request_5xx_count,
       unattributed_failed_request_count = EXCLUDED.unattributed_failed_request_count,
       successful_write_count = EXCLUDED.successful_write_count,
       failed_write_count = EXCLUDED.failed_write_count,
       rule_version = EXCLUDED.rule_version,
       analyzed_at = now()`,
    [row.sessionId, row.projectId, row.environmentId, row.sessionStartedAt, row.coverage,
     row.activityClass, row.entryPath, row.clickCount, row.inputEventCount, row.pageEventCount,
     row.failedRequest4xxCount, row.failedRequest5xxCount, row.unattributedFailedRequestCount,
     row.successfulWriteCount, row.failedWriteCount, row.ruleVersion],
  );
}
```

`getSessionAnalysis` is a straight SELECT of the same columns mapped back to the camelCase shape (used by Task 9 investigation context and this task's test).

- [ ] **Step 3: Implement `deriveCoverage` + the `skipUnreadable` reader option, with failing tests first**

Tests (extend `facts.test.ts` and `chunk-reader.test.ts`):

```ts
describe('deriveCoverage', () => {
  it('is no_replay when nothing readable exists, even if chunk rows exist', () => {
    expect(deriveCoverage({ totalChunkCount: 0, envelopeCount: 0, truncated: false })).toBe('no_replay');
    expect(deriveCoverage({ totalChunkCount: 3, envelopeCount: 0, truncated: false })).toBe('no_replay');
    expect(deriveCoverage({ totalChunkCount: 5, envelopeCount: 0, truncated: true })).toBe('no_replay');
  });
  it('is partial when something was read but evidence is incomplete', () => {
    expect(deriveCoverage({ totalChunkCount: 5, envelopeCount: 3, truncated: true })).toBe('partial');
    // one readable + one unscrubbed (or scrub-failed, or unreadable) chunk: NOT complete
    expect(deriveCoverage({ totalChunkCount: 2, envelopeCount: 1, truncated: false })).toBe('partial');
  });
  it('is complete only when every committed chunk was read', () => {
    expect(deriveCoverage({ totalChunkCount: 5, envelopeCount: 5, truncated: false })).toBe('complete');
  });
});

// chunk-reader.test.ts — reuse the suite's existing fixture helpers
it('skipUnreadable counts a corrupt chunk instead of throwing, without changing default behavior', async () => {
  const chunks = [validChunkRef(), corruptChunkRef(), validChunkRef()];
  await expect(readChunksBounded(chunks)).rejects.toThrow(ChunkReadError);          // default unchanged
  const read = await readChunksBounded(chunks, { skipUnreadable: true });
  expect(read.envelopes).toHaveLength(2);
  expect(read.unreadableCount).toBe(1);
});
```

Implementation: in `chunk-reader.ts`, the skippable boundary covers **every chunk-local failure**: the compressed-size policy check, unknown/oversized size, the object fetch (an object missing from storage after scrub is unreadable — a deleted object never comes back, so treating it as transient would wedge the session), gunzip, gunzip-over-cap, JSON parse, and envelope validation. Wrap that whole per-chunk section in a try/catch active only when `opts?.skipUnreadable` is set; on catch, increment `unreadableCount` and `continue`. ONLY the systemic MinIO-unconfigured guard (`chunk-reader.ts:24`) stays outside the flag — it throws either way, because it fails every chunk identically and retrying the job is correct. `unreadableCount: 0` and fully-populated `envelopeSeqs` in the default-path result keep the return type change additive. Add a test case per skippable failure class (oversized chunk, missing object, corrupt gzip) asserting skip-and-count under the flag and throw without it.

`deriveCoverage` in `facts.ts`:

```ts
export function deriveCoverage(input: {
  totalChunkCount: number;   // sessions.chunk_count — every committed chunk
  envelopeCount: number;     // chunks actually read into envelopes
  truncated: boolean;
}): Coverage {
  if (input.envelopeCount === 0) return 'no_replay';
  if (input.truncated || input.envelopeCount < input.totalChunkCount) return 'partial';
  return 'complete';
}
```

- [ ] **Step 4: Wire fact extraction into `processSessionAnalysisJob` — AFTER the lease assertion**

In `index.ts`, change the read call to `const read = await readChunksBounded(chunks, { skipUnreadable: true });` (`index.ts:786`). Then insert the facts write **after `await db.assertJobLease(job);` (`index.ts:789`) and before `writeFrictionSignals`** — a stale worker must discover it lost the lease before touching `session_analysis`:

```ts
    const facts = extractSessionFacts(read.envelopes);
    const coverage = deriveCoverage({
      totalChunkCount: session.chunk_count,
      envelopeCount: read.envelopes.length,
      truncated: read.truncated,
    });
    await db.upsertSessionAnalysis({
      sessionId: session.id,
      projectId: session.project_id,
      environmentId: session.environment_id,
      sessionStartedAt: session.started_at,
      coverage,
      activityClass: classifyActivity(facts, coverage),
      entryPath: facts.entryPath,
      clickCount: facts.clickCount,
      inputEventCount: facts.inputEventCount,
      pageEventCount: facts.pageEventCount,
      failedRequest4xxCount: facts.failedRequest4xxCount,
      failedRequest5xxCount: facts.failedRequest5xxCount,
      unattributedFailedRequestCount: facts.unattributedFailedRequestCount,
      successfulWriteCount: facts.successfulWriteCount,
      failedWriteCount: facts.failedWriteCount,
      ruleVersion: RULE_VERSION,
    });
```

with imports `import { extractSessionFacts, classifyActivity, deriveCoverage } from './friction/facts.js';`. The analyzer is the sole writer including empty sessions: zero chunks yields a `no_replay` row with `activity_class='unknown'`. Nothing else in the job changes — error paths, remaining lease assertions, and status transitions stay byte-identical.

**Honest test-scope note:** coverage logic is pinned by the pure `deriveCoverage` unit tests and the reader-flag test above; the DB test below pins upsert semantics. Full job-level behavior (analysis job → row) is asserted in the Task 13 live smoke — this repo has no in-process job-harness test utility, and inventing one is out of this plan's scope.

- [ ] **Step 5: Write the failing DB integration test**

Model it on the existing `promotion-db.integration.test.ts` setup (pool from `DATABASE_URL`, `describe.skipIf(!process.env.DATABASE_URL)`). Cases: (a) calling `upsertSessionAnalysis` twice with different counts leaves one row with the second counts and `session_started_at` unchanged; (b) a `no_replay`/`unknown` row round-trips.

```ts
// packages/worker/src/__tests__/session-analysis-facts.integration.test.ts
import { describe, expect, it } from 'vitest';
import { upsertSessionAnalysis, getSessionAnalysis, getPool } from '../db.js';

const hasDb = Boolean(process.env['DATABASE_URL']);

describe.skipIf(!hasDb)('session_analysis upsert', () => {
  it('is idempotent per session and keeps the attribution key stable', async () => {
    // seed project + session rows exactly as promotion-db.integration.test.ts does
    const base = {
      sessionId: 'facts-sess-1', projectId: seededProjectId, environmentId: null,
      sessionStartedAt: '2026-08-01T00:00:00Z',
      coverage: 'complete' as const, activityClass: 'active' as const,
      entryPath: '/assets', clickCount: 3, inputEventCount: 0, pageEventCount: 1,
      failedRequest4xxCount: 0, failedRequest5xxCount: 0,
      unattributedFailedRequestCount: 0, successfulWriteCount: 1, failedWriteCount: 0,
      ruleVersion: 2,
    };
    await upsertSessionAnalysis(base);
    await upsertSessionAnalysis({ ...base, clickCount: 9, coverage: 'partial', activityClass: 'unknown' });
    const row = await getSessionAnalysis('facts-sess-1', seededProjectId);
    expect(row?.clickCount).toBe(9);
    expect(row?.coverage).toBe('partial');
    expect(row?.sessionStartedAt).toContain('2026-08-01');
    const { rowCount } = await getPool().query(
      `SELECT 1 FROM session_analysis WHERE session_id = $1`, ['facts-sess-1']);
    expect(rowCount).toBe(1);
  });
});
```

- [ ] **Step 6: Run tests, then build**

```bash
DATABASE_URL="$DATABASE_URL" pnpm --filter @opslane/worker test -- "session-analysis-facts|facts|chunk-reader"
pnpm --filter @opslane/worker build
```
Expected: PASS (and the DB suite is *skipped*, not failed, without `DATABASE_URL` — verify by unsetting it once).

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/db.ts packages/worker/src/index.ts \
  packages/worker/src/friction/chunk-reader.ts packages/worker/src/friction/facts.ts \
  packages/worker/src/friction/__tests__/chunk-reader.test.ts packages/worker/src/friction/__tests__/facts.test.ts \
  packages/worker/src/__tests__/session-analysis-facts.integration.test.ts
git commit -m "feat(worker): analyzer writes typed session_analysis facts row with coverage tri-state"
```

---

### Task 4: Detector suppressions, per-occurrence timestamps, form_abandon retirement — RULE_VERSION 2

**Files:**
- Modify: `packages/worker/src/friction/analyzer.ts`
- Modify: `packages/worker/src/friction/fingerprint.ts`
- Test: extend `packages/worker/src/friction/__tests__/analyzer.test.ts` and `__tests__/fingerprint.test.ts` (or create the latter if absent)

**Interfaces:**
- Produces: `DetectedSignal` gains `occurredAts: number[]` — **one entry per persisted occurrence unit** (one per dead-click occurrence; one per rage-click CLUSTER, because the detector fires once per cluster on its last click). Length tracks `occurrenceCount`, NOT raw click count: a 4-click rage cluster yields `occurredAts.length === 1`. Ascending; `occurredAt` stays the minimum for compatibility. `RULE_VERSION = 2`. `normalizePageUrl` additionally strips `_ctx_*` path segments (uuid-ish segments are already templated by the existing `[0-9a-f-]{8,}` rule — do not re-add). Tasks 5 and 7 depend on `occurredAts`.

- [ ] **Step 1: Write the failing tests**

Add to the existing analyzer test file (reuse its event-builder helpers; they construct rrweb envelopes with telemetry payloads — match the `at`/`clickId`/`selector`/`cursor` shape from `isSessionTelemetryEvent`, `analyzer.ts:70-96`):

```ts
it('suppresses rage clicks on text-cursor targets (focus/select-all clicking)', () => {
  // 3 clicks < 1s apart on selector '.search-input' with cursor: 'text', unanswered
  const signals = analyzeSession([envelopeWithClicks('.search-input', 'text', 3)]);
  expect(signals).toHaveLength(0);
});

it('clusters only pointer clicks in a mixed pointer/text burst', () => {
  // 2 pointer clicks + 2 interleaved text-cursor clicks on one selector, < 1s apart, unanswered:
  // text clicks are filtered pre-clustering, so this is a 2-click cluster → dead clicks, not rage
  const signals = analyzeSession([envelopeWithMixedCursorBurst()]);
  expect(signals.every((s) => s.signalType === 'dead_click')).toBe(true);
});

it('suppresses a dead click answered by an option-select within 5s', () => {
  // click on '.field-container' (cursor: pointer, unanswered within 1s),
  // then a click on '#react-select-9-option-0' 3s later
  const signals = analyzeSession([envelopeWithAnsweredPicker()]);
  expect(signals).toHaveLength(0);
});

it('does NOT apply the option-select suppression to rage clusters', () => {
  // 3 pointer clicks < 1s apart, unanswered within 1s, option-select 3s after the last:
  // still a rage_click — slow-answered rage is the adjudicator's call, not the detector's
  const signals = analyzeSession([envelopeWithRageThenOption()]);
  expect(signals.map((s) => s.signalType)).toEqual(['rage_click']);
});

it('suppresses synthetic download-anchor clicks (body > a within 50ms of a real click)', () => {
  // click on '#export-button' at t, click on 'body > a' at t+5ms, both unanswered
  const signals = analyzeSession([envelopeWithDownloadAnchor()]);
  expect(signals.filter((s) => s.elementSelector === 'body > a')).toHaveLength(0);
});

it('fingerprints react-select indexed ids by their widget container', () => {
  const a = frictionFingerprint('dead_click', '#react-select-8-selected-value-3-remove', '/x');
  const b = frictionFingerprint('dead_click', '#react-select-8-selected-value-7-remove', '/x');
  expect(a).toBe(b);
});

it('no longer produces form_abandon', () => {
  // the existing form_abandon fixture from this suite
  const signals = analyzeSession([formAbandonFixture()]);
  expect(signals.filter((s) => s.signalType === 'form_abandon')).toHaveLength(0);
});

it('records one timestamp per persisted occurrence unit on a folded signal', () => {
  // two unanswered dead clicks on the same selector+page, 60s apart
  const signals = analyzeSession([envelopeWithTwoDeadClicks(60_000)]);
  expect(signals).toHaveLength(1);
  expect(signals[0]?.occurredAts).toHaveLength(2);
  expect(signals[0]?.occurredAt).toBe(Math.min(...(signals[0]?.occurredAts ?? [])));
});

it('records ONE timestamp for a rage cluster regardless of its click count', () => {
  // 4 unanswered pointer clicks < 1s apart on one selector → one rage signal
  const signals = analyzeSession([envelopeWithRageCluster(4)]);
  expect(signals).toHaveLength(1);
  expect(signals[0]?.signalType).toBe('rage_click');
  expect(signals[0]?.occurredAts).toHaveLength(1);
});

it('normalizePageUrl strips _ctx blobs (origin retained — it is a fingerprint identity)', () => {
  expect(normalizePageUrl('https://x.test/foo/_ctx_H4sIAAAA/bar'))
    .toBe('https://x.test/foo/bar');
});
```

Write the three `envelopeWith*` helpers concretely in the test file using the suite's existing builder style — each returns one `SessionChunkEnvelope` whose events array contains type-5 telemetry events with the documented payload shapes.

- [ ] **Step 2: Run tests to verify the new ones fail**

```bash
pnpm --filter @opslane/worker test -- analyzer
```
Expected: new tests FAIL; existing tests still describe v1 behavior — update the ones that assert `form_abandon` output or text-cursor rage clicks as part of Step 3 (they encode the bug being fixed, per the spec; note this in the commit message).

- [ ] **Step 3: Implement**

In `analyzer.ts`:

```ts
export const RULE_VERSION = 2;
const OPTION_ANSWER_WINDOW_MS = 5_000;
const SYNTHETIC_ANCHOR_WINDOW_MS = 50;
```

1. `DetectedSignal` gains `occurredAts: number[]`; `makeSignal` sets `occurredAts: [occurredAt]`; `foldSignal` merges with `current.occurredAts.push(signal.occurredAt); current.occurredAts.sort((a, b) => a - b);`.
2. Collect option-select click times once: `const optionClickTimes = telemetry.filter((t) => t.event.kind === 'click' && isOptionSelector(t.event.selector)).map((t) => t.event.at).sort((a, b) => a - b);` with `const isOptionSelector = (s: string): boolean => /#react-select-.*-option-/.test(s) || /\[role=["']?option/.test(s) || /\brole=option\b/.test(s);` — and exclude option-selector clicks themselves from dead/rage candidacy.
3. **Filter text-cursor clicks out BEFORE clustering** — in the `clicksBySelector` collection loop, skip clicks with `event.cursor === 'text'` entirely. They are focus/select-all gestures and must count toward neither rage clusters nor dead-click candidates; filtering pre-clustering means a mixed pointer/text burst clusters only its pointer clicks (a first-click check would mis-handle mixed clusters in both directions).
4. **Two answer predicates, not one.** Keep `answered` (`analyzer.ts:231`) EXACTLY as it is — the 1s mutation/request window — and keep using it for rage clusters. Add a dead-click-only predicate `deadClickAnswered(click) = answered(click) || hasTimestampInWindow(optionClickTimes, click.at, click.at + OPTION_ANSWER_WINDOW_MS)` used only in the dead-click branch. The option-select suppression is a dead-click rule (spec: "a dead-click candidate answered by an option-select"); folding it into the shared predicate would silently suppress rage clusters that a picker eventually answered, which is exactly the sluggish-UI signal the adjudicator should see.
5. Synthetic anchors: build `const allClickTimes = telemetry.filter((t) => t.event.kind === 'click').map((t) => t.event.at).sort((a, b) => a - b);` and skip any click whose `selector === 'body > a'` when another click exists within `SYNTHETIC_ANCHOR_WINDOW_MS` before it.
6. Delete the `form_abandon` block (`analyzer.ts:270-287`) and the two now-unused constants `FORM_MIN_FIELDS`, `FORM_MIN_ENGAGED_MS`. Keep the `form_submit` telemetry collection (Task 2's facts and the `answered` predicate do not use it, but `extractTelemetryEvents` still validates it).

In `fingerprint.ts`:

7. `normalizePageUrl`: in the existing segment `.map(...)` chain, add `.filter((segment) => !segment.startsWith('_ctx_'))` before the map. Uuid-ish segments are already covered by the existing `/^[0-9a-f-]{8,}$/i` rule — do NOT add a second uuid regex. The `${url.origin}${path}` return shape is unchanged (it is a fingerprint identity; `normalizeEntryPath` from Task 2 is the path-only variant).
8. `frictionFingerprint`: before hashing, canonicalize react-select indexed ids: `selector.replace(/#react-select-(\d+)-[\w-]+/g, '#react-select-$1')`.

- [ ] **Step 4: Run the full worker test suite**

```bash
pnpm --filter @opslane/worker test
```
Expected: PASS, including the updated legacy assertions.

- [ ] **Step 5: Run the analyzer bench gate**

```bash
pnpm --filter @opslane/worker exec tsx scripts/bench-analyzer.ts
```
Expected: p95 < 5,000ms (the option-time preindex keeps `answered` O(log n)). If `tsx` is not how this repo runs the bench, use the script line from `packages/worker/package.json`.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/friction/analyzer.ts packages/worker/src/friction/fingerprint.ts packages/worker/src/friction/__tests__/
git commit -m "feat!(worker): detector suppressions, per-occurrence timestamps, retire form_abandon (RULE_VERSION 2)"
```

---

### Task 5: Persistence — `occurred_ats` column write and prior-version supersession

**Files:**
- Modify: `packages/worker/src/friction/persist.ts`
- Test: extend the persistence cases in `packages/worker/src/__tests__/promotion-db.integration.test.ts` (or the suite where `writeFrictionSignals` is covered)

**Interfaces:**
- Consumes: `DetectedSignal.occurredAts` (Task 4), `friction_signals.occurred_ats` (Task 1).
- Produces: after `writeFrictionSignals(session, signals, N)`, every active (`retracted_at IS NULL AND superseded_by IS NULL`) row for the session has `rule_version = N` — the invariant Tasks 7/8 and all existing rollup queries rely on.

- [ ] **Step 1: Write the failing test**

```ts
it('supersedes prior-version signals on re-analysis', async () => {
  const session = seededSessionRow();
  // v1 writes TWO fingerprints: one that persists into v2, one that v2 no longer produces.
  const v1Kept = { ...deadClickSignal, ruleVersion: 1 };
  const v1Only = { ...deadClickSignal, fingerprint: 'v1-only-fp', elementSelector: '.gone', ruleVersion: 1 };
  await writeFrictionSignals(session, [v1Kept, v1Only], 1);

  const v2Signal = { ...deadClickSignal, ruleVersion: 2, occurredAts: [deadClickSignal.occurredAt] };
  await writeFrictionSignals(session, [v2Signal], 2);

  const { rows } = await getPool().query(
    `SELECT fingerprint, rule_version, superseded_by, retracted_at, occurred_ats
     FROM friction_signals WHERE session_id = $1 ORDER BY rule_version, fingerprint`,
    [session.id]);
  expect(rows).toHaveLength(3);
  const v1KeptRow = rows.find((r) => r.rule_version === 1 && r.fingerprint === deadClickSignal.fingerprint);
  const v1OnlyRow = rows.find((r) => r.fingerprint === 'v1-only-fp');
  const v2Row = rows.find((r) => r.rule_version === 2);
  expect(v1KeptRow?.superseded_by).not.toBeNull();     // same fingerprint → points at v2 row
  expect(v1OnlyRow?.superseded_by).toBeNull();
  expect(v1OnlyRow?.retracted_at).not.toBeNull();      // no successor → retracted
  expect(v2Row?.superseded_by).toBeNull();
  expect(v2Row?.occurred_ats).toEqual([deadClickSignal.occurredAt]);

  // Active-row invariant: exactly one active row for the whole session.
  const { rows: active } = await getPool().query(
    `SELECT count(*) AS n FROM friction_signals
     WHERE session_id = $1 AND retracted_at IS NULL AND superseded_by IS NULL`,
    [session.id]);
  expect(Number(active[0].n)).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
DATABASE_URL="$DATABASE_URL" pnpm --filter @opslane/worker test -- promotion-db
```
Expected: FAIL — `superseded_by` is null on the v1 row (the never-written bug this task fixes).

- [ ] **Step 3: Implement in `persist.ts`**

Inside the existing transaction, after the per-signal upsert loop (`persist.ts:37-62`) and before the same-version retraction (`persist.ts:64-70`):

```ts
    // Re-analysis supersession (2026-07-13 design §re-analysis): an older-
    // version active row with a same-fingerprint successor points at it;
    // an older-version active row with no successor is retracted.
    await client.query(
      `UPDATE friction_signals old SET superseded_by = new.id
       FROM friction_signals new
       WHERE old.session_id = $1 AND old.project_id = $2
         AND old.rule_version < $3
         AND old.retracted_at IS NULL AND old.superseded_by IS NULL
         AND new.session_id = old.session_id AND new.project_id = old.project_id
         AND new.fingerprint = old.fingerprint AND new.rule_version = $3`,
      [session.id, session.project_id, ruleVersion],
    );
    await client.query(
      `UPDATE friction_signals SET retracted_at = now()
       WHERE session_id = $1 AND project_id = $2
         AND rule_version < $3
         AND retracted_at IS NULL AND superseded_by IS NULL`,
      [session.id, session.project_id, ruleVersion],
    );
```

Also: add `occurred_ats` to the INSERT column list with value `JSON.stringify(signal.occurredAts)` and `occurred_ats = EXCLUDED.occurred_ats` to the upsert's DO UPDATE set. The `attached`-incident lock query at `persist.ts:17-24` must drop its `rule_version = $3` filter (prior-version rows being superseded may be attached to incidents whose impact needs the same recompute) — collect affected incidents across **all** versions for this session.

- [ ] **Step 4: Run tests to verify they pass**

```bash
DATABASE_URL="$DATABASE_URL" pnpm --filter @opslane/worker test -- promotion-db
pnpm --filter @opslane/worker test
```
Expected: PASS, including existing suites (bucket promotion, dead-letter) — they seed at one version and are unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/friction/persist.ts packages/worker/src/__tests__/
git commit -m "fix(worker): re-analysis supersedes prior-version friction signals; persist occurrence timestamps"
```

---

### Task 6: Evidence windows — builder + adjudicator input

**Files:**
- Create: `packages/worker/src/friction/evidence-window.ts`
- Modify: `packages/worker/src/friction/adjudicator.ts`
- Test: `packages/worker/src/friction/__tests__/evidence-window.test.ts`, extend `__tests__/adjudicator.test.ts`

**Interfaces:**
- Consumes: `SessionChunkEnvelope`, telemetry shapes from `analyzer.ts`.
- Produces (Task 7 depends on these exact names):

```ts
// evidence-window.ts
export const EVIDENCE_WINDOW_MS = 15_000;
export const EVIDENCE_WINDOW_MAX_EVENTS = 40;
export interface WindowEvent {
  t: number;
  kind: 'page' | 'click' | 'request_start' | 'request_end' | 'form_submit';
  selector?: string; cursor?: string; url?: string; method?: string;
  status?: number; requestId?: string;
}
export function buildEvidenceWindows(chunks: SessionChunkEnvelope[], occurredAts: number[]): WindowEvent[][];

// adjudicator.ts
export const ADJUDICATION_PROMPT_VERSION_WINDOWS = 2;   // v1 stays for selector-only
export interface AdjudicationInput { /* existing fields */ evidenceWindows?: WindowEvent[][]; }
export interface AdjudicationVerdict { accepted: boolean; reason: string; uncertain?: boolean; }
export type EvidenceWindowMode = 'off' | 'shadow' | 'on';
export function createAnthropicAdjudicator(apiKey: string, mode?: EvidenceWindowMode): Adjudicator;
```

- [ ] **Step 1: Write the failing window-builder tests**

```ts
// __tests__/evidence-window.test.ts
import { describe, expect, it } from 'vitest';
import { buildEvidenceWindows, EVIDENCE_WINDOW_MAX_EVENTS } from '../evidence-window.js';

// reuse the telemetry/page/envelope builders from facts.test.ts (extract them
// into __tests__/helpers.ts if duplication bothers you — small enough either way)

describe('buildEvidenceWindows', () => {
  it('centers the window on the occurrence and includes only ±15s', () => {
    const windows = buildEvidenceWindows([bigEnvelope()], [T0 + 60_000]);
    expect(windows).toHaveLength(1);
    for (const e of windows[0] ?? []) {
      expect(Math.abs(e.t - (T0 + 60_000))).toBeLessThanOrEqual(15_000);
    }
  });

  it('keeps clicks and form_submits when trimming to the event cap', () => {
    // envelope with 100 request events and 3 clicks inside one window
    const windows = buildEvidenceWindows([noisyEnvelope()], [T0]);
    const w = windows[0] ?? [];
    expect(w.length).toBeLessThanOrEqual(EVIDENCE_WINDOW_MAX_EVENTS);
    expect(w.filter((e) => e.kind === 'click')).toHaveLength(3);   // within the priority budget → all kept
    // trimmed remainder is the nearest-to-center requests, in chronological order
    expect([...w].sort((a, b) => a.t - b.t)).toEqual(w);
  });

  it('enforces the 40-event cap even when clicks alone exceed it', () => {
    // envelope with 60 clicks inside one window: total stays <= 40 and the
    // click nearest the occurrence is always retained
    const windows = buildEvidenceWindows([clickStormEnvelope(60)], [T0]);
    const w = windows[0] ?? [];
    expect(w.length).toBeLessThanOrEqual(EVIDENCE_WINDOW_MAX_EVENTS);
    expect(w.some((e) => e.kind === 'click' && e.t === T0)).toBe(true);
  });

  it('never orphans a request pair when trimming', () => {
    // noisyEnvelope: every request_start has a matching request_end
    const windows = buildEvidenceWindows([noisyEnvelope()], [T0]);
    const w = windows[0] ?? [];
    const startIds = new Set(w.filter((e) => e.kind === 'request_start').map((e) => e.requestId));
    const endIds = new Set(w.filter((e) => e.kind === 'request_end').map((e) => e.requestId));
    expect([...startIds].sort()).toEqual([...endIds].sort());   // pairs retained or dropped atomically
  });

  it('returns an empty window when no events fall in range', () => {
    expect(buildEvidenceWindows([bigEnvelope()], [T0 + 10 * 60_000])).toEqual([[]]);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement the builder**

```ts
// packages/worker/src/friction/evidence-window.ts
import type { SessionChunkEnvelope } from '@opslane/shared';
import { extractTelemetryEvents } from './analyzer.js';

export const EVIDENCE_WINDOW_MS = 15_000;
export const EVIDENCE_WINDOW_MAX_EVENTS = 40;

export interface WindowEvent {
  t: number;
  kind: 'page' | 'click' | 'request_start' | 'request_end' | 'form_submit';
  selector?: string; cursor?: string; url?: string; method?: string;
  status?: number; requestId?: string;
}

const MAX_URL_LEN = 160;
const MAX_SELECTOR_LEN = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One condensed ±15s window per occurrence. Clicks/submits are always kept;
 * remaining slots go to the events nearest the occurrence. Chronological. */
export function buildEvidenceWindows(
  chunks: SessionChunkEnvelope[],
  occurredAts: number[],
): WindowEvent[][] {
  const all: WindowEvent[] = [];
  for (const chunk of chunks) {
    if (!Array.isArray(chunk.events)) continue;
    for (const value of chunk.events) {
      if (!isRecord(value) || typeof value['timestamp'] !== 'number') continue;
      const data = value['data'];
      if (value['type'] === 4 && isRecord(data) && typeof data['href'] === 'string') {
        all.push({ t: value['timestamp'], kind: 'page', url: data['href'].slice(0, MAX_URL_LEN) });
      }
    }
  }
  for (const { event, timestamp } of extractTelemetryEvents(chunks)) {
    if (event.kind === 'click') {
      all.push({ t: event.at || timestamp, kind: 'click', selector: event.selector.slice(0, MAX_SELECTOR_LEN), cursor: event.cursor });
    } else if (event.kind === 'request_start') {
      all.push({ t: event.at, kind: 'request_start', requestId: event.requestId, method: event.method, url: event.url.slice(0, MAX_URL_LEN) });
    } else if (event.kind === 'request_end') {
      all.push({ t: event.at, kind: 'request_end', requestId: event.requestId, status: event.status });
    } else if (event.kind === 'form_submit') {
      all.push({ t: event.at, kind: 'form_submit', selector: event.selector.slice(0, MAX_SELECTOR_LEN) });
    }
  }
  all.sort((a, b) => a.t - b.t);

  return occurredAts.map((at) => {
    const inSpan = all.filter((e) => Math.abs(e.t - at) <= EVIDENCE_WINDOW_MS);
    // Priority events (clicks/submits) are themselves BOUNDED: telemetry is
    // browser-controlled, so an uncapped "always keep clicks" rule lets a
    // hostile or pathological session inflate prompts without limit. Keep the
    // nearest PRIORITY_BUDGET clicks/submits to the occurrence (the flagged
    // click is at distance ~0 and always survives), then fill the remainder
    // with request/page units.
    const PRIORITY_BUDGET = 24;
    const priority = inSpan
      .filter((e) => e.kind === 'click' || e.kind === 'form_submit')
      .sort((a, b) => Math.abs(a.t - at) - Math.abs(b.t - at))
      .slice(0, PRIORITY_BUDGET)
      .sort((a, b) => a.t - b.t);
    // Trim request events as PAIRS keyed by requestId, so a kept end always
    // has its start (spec: "request start/end pairs"). Unpaired events
    // (start or end alone in the span) travel as one-element units.
    const rest = inSpan.filter((e) => e.kind !== 'click' && e.kind !== 'form_submit');
    const units = new Map<string, WindowEvent[]>();
    for (const e of rest) {
      const key = e.requestId ? `req:${e.requestId}` : `solo:${e.t}:${e.kind}`;
      const unit = units.get(key) ?? [];
      unit.push(e);
      units.set(key, unit);
    }
    const unitDistance = (unit: WindowEvent[]): number =>
      Math.min(...unit.map((e) => Math.abs(e.t - at)));
    const kept: WindowEvent[] = [];
    let budget = Math.max(0, EVIDENCE_WINDOW_MAX_EVENTS - priority.length);
    for (const unit of [...units.values()].sort((a, b) => unitDistance(a) - unitDistance(b))) {
      if (unit.length > budget) continue;
      kept.push(...unit);
      budget -= unit.length;
    }
    return [...priority, ...kept].sort((a, b) => a.t - b.t);
  });
}
```

- [ ] **Step 3: Extend the adjudicator — failing tests first**

```ts
// additions to __tests__/adjudicator.test.ts
it('includes fenced evidence windows in the prompt when provided', () => {
  const prompt = buildAdjudicationPrompt({ ...baseInput, evidenceWindows: [[{ t: 1, kind: 'click', selector: '.x', cursor: 'pointer' }]] });
  expect(prompt).toContain('"evidence_windows"');
  expect(prompt).toContain('<untrusted-evidence>');   // windows live inside the fence
  expect(prompt).toContain('uncertain');              // verdict schema mentions it
});

it('parses an uncertain verdict as rejected-with-uncertain', () => {
  const v = parseVerdict('{"accepted": false, "uncertain": true, "reason": "window ends too soon"}');
  expect(v.accepted).toBe(false);
  expect(v.uncertain).toBe(true);
});

it('rejects accepted+uncertain as contradictory', () => {
  expect(() => parseVerdict('{"accepted": true, "uncertain": true, "reason": "x"}')).toThrow();
});
```

- [ ] **Step 4: Implement the adjudicator changes**

In `adjudicator.ts`:
1. `AdjudicationInput` gains `evidenceWindows?: WindowEvent[][]` (import the type).
2. `buildAdjudicationPrompt`: add `evidence_windows: input.evidenceWindows ?? null` into the fenced JSON blob; when windows are present, extend the instruction lines with: `'Each evidence window is the real event timeline (±15s) around one flagged click.'`, `'Judge from the events only. If the window lacks enough evidence to decide, return'`, `'{"accepted": false, "uncertain": true, "reason": ...} — do not guess.'` and require the reason to cite window events by time.
3. `AdjudicationVerdict` gains `uncertain?: boolean`; `parseVerdict` narrows it (`typeof obj['uncertain'] === 'boolean' || obj['uncertain'] === undefined`) and throws on `accepted && uncertain`.
4. `export const ADJUDICATION_PROMPT_VERSION_WINDOWS = 2;` and `createAnthropicAdjudicator(apiKey: string, mode: EvidenceWindowMode = 'off')` reports `promptVersion: mode === 'on' ? ADJUDICATION_PROMPT_VERSION_WINDOWS : ADJUDICATION_PROMPT_VERSION` — window-input verdicts open new generations, selector-only verdicts stay on v1, exactly the existing prompt-version discipline.
5. **Change the factory TYPE, not just the default factory.** The injectable seam is `setFrictionAdjudicatorFactory` (`index.ts:54-56`) with a one-arg `(apiKey) => Adjudicator` type. Change the type to `(apiKey: string, mode: EvidenceWindowMode) => Adjudicator`, update the default factory to `createAnthropicAdjudicator`, and update every call site and test stub (grep `frictionAdjudicatorFactory` and `setFrictionAdjudicatorFactory` across `src/` and `__tests__/`). Task 7's caller passes the mode — if this type change is skipped, `'on'` mode silently constructs an `'off'` adjudicator and persists window verdicts under prompt version 1, corrupting generation identity.
6. Add a prompt-version test: `expect(createAnthropicAdjudicator('k', 'on').promptVersion).toBe(2)` and `.toBe(1)` for `'off'` and `'shadow'` (shadow's deciding call is selector-only v1; the shadow window call is log-only and never persisted).

- [ ] **Step 5: Run tests and build**

```bash
pnpm --filter @opslane/worker test -- evidence-window adjudicator
pnpm --filter @opslane/worker build
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/friction/evidence-window.ts packages/worker/src/friction/adjudicator.ts packages/worker/src/friction/__tests__/
git commit -m "feat(worker): condensed evidence windows as adjudicator input (prompt v2, uncertain verdict)"
```

---

### Task 7: Promotion wiring — window mode, daily cap, occurrence loading

**Files:**
- Modify: `packages/worker/src/friction/promotion.ts`
- Modify: `packages/worker/src/friction/promotion-db.ts` (one new query helper)
- Modify: `packages/worker/src/db.ts` (chunk range query)
- Modify: `packages/worker/src/index.ts` (env knobs + wiring)
- Test: extend `packages/worker/src/__tests__/promotion-db.integration.test.ts`

**Interfaces:**
- Consumes: `buildEvidenceWindows` (Task 6), `friction_signals.occurred_ats` (Task 5), `getScrubbedChunksForSession` shape.
- Produces:

```ts
// db.ts — the return type is whatever row type getScrubbedChunksForSession
// already returns (open db.ts and use the SAME exported type name — do not
// invent a new one; readChunksBounded consumes it unchanged)
export async function getScrubbedChunksInRange(
  sessionId: string, projectId: string, fromMs: number, toMs: number,
): Promise<Awaited<ReturnType<typeof getScrubbedChunksForSession>>>;
// promotion-db.ts — atomic budget reservation against adjudication_call_budget
// (Task 1 migration). Reserve BEFORE every outbound model call, including
// shadow calls and calls that later fail. Returns false when the cap is spent.
export async function tryReserveAdjudicationCall(
  client: PoolClient, projectId: string, dailyCap: number,
): Promise<boolean>;
// db.ts — schedules the budget-exhaustion revisit: inserts a fresh
// session_analysis job with available_at at the next budget day, guarded by
// the NOT EXISTS pending/claimed idempotence clause (db/sessions.go:376-393).
export async function enqueueSessionAnalysisForBudgetRetry(
  sessionId: string, projectId: string,
): Promise<void>;
// promotion.ts — signature change
export interface AdjudicationRuntime {
  windowMode: 'off' | 'shadow' | 'on';
  dailyCap: number;                       // ADJUDICATION_DAILY_CAP, default 500
  loadWindows(signal: { session_id: string; project_id: string; occurred_ats: number[] | null }): Promise<WindowEvent[][]>;
}
export async function processFrictionOutcomes(
  session: SessionRow, jobId: string, adjudicator: Adjudicator, runtime: AdjudicationRuntime,
): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

```ts
it('reserves budget atomically and leaves signals pending when spent', async () => {
  // Exhaust the budget: 3 reservations at cap 3 succeed, the 4th fails.
  const client = await getPool().connect();
  try {
    expect(await tryReserveAdjudicationCall(client, projectId, 3)).toBe(true);
    expect(await tryReserveAdjudicationCall(client, projectId, 3)).toBe(true);
    expect(await tryReserveAdjudicationCall(client, projectId, 3)).toBe(true);
    expect(await tryReserveAdjudicationCall(client, projectId, 3)).toBe(false);
  } finally {
    client.release();
  }
  // With the budget spent, a pending fold-path signal stays pending AND a
  // revisit job is scheduled for the next budget day.
  await processFrictionOutcomes(session, jobId, stubAdjudicator, { windowMode: 'off', dailyCap: 3, loadWindows: async () => [] });
  const { rows } = await getPool().query(
    `SELECT adjudication_status FROM friction_signals WHERE id = $1`, [pendingId]);
  expect(rows[0].adjudication_status).toBe('pending');
  const { rows: jobs } = await getPool().query(
    `SELECT available_at FROM error_group_jobs
     WHERE session_id = $1 AND job_type = 'session_analysis' AND status = 'pending'`, [session.id]);
  expect(jobs).toHaveLength(1);
  expect(new Date(jobs[0].available_at).getTime()).toBeGreaterThan(Date.now());
  // Simulate the day rollover: clear the budget and re-run — now it adjudicates.
  await getPool().query(`DELETE FROM adjudication_call_budget WHERE project_id = $1`, [projectId]);
  await processFrictionOutcomes(session, 'job-2', stubAdjudicator, { windowMode: 'off', dailyCap: 3, loadWindows: async () => [] });
  const { rows: after } = await getPool().query(
    `SELECT adjudication_status FROM friction_signals WHERE id = $1`, [pendingId]);
  expect(after[0].adjudication_status).not.toBe('pending');
});

it('reserves a unit even when the model call fails', async () => {
  const throwingAdjudicator = { ...stubAdjudicator, adjudicate: async () => { throw new Error('model down'); } };
  await expect(processFrictionOutcomes(session, jobId, throwingAdjudicator, runtimeOff)).rejects.toThrow();
  const { rows } = await getPool().query(
    `SELECT calls FROM adjudication_call_budget WHERE project_id = $1 AND day = CURRENT_DATE`, [projectId]);
  expect(Number(rows[0].calls)).toBeGreaterThanOrEqual(1);   // failed call still spent budget
});

it('stores an uncertain verdict as rejected with adjudication_reason exactly "uncertain"', async () => {
  // Spec contract: adjudication_reason = 'uncertain', nothing more. The model's
  // explanatory text goes to the log line only.
  const uncertainAdjudicator = { ...stubAdjudicator, adjudicate: async () => ({ accepted: false, uncertain: true, reason: 'window ends too soon' }) };
  await processFrictionOutcomes(session, jobId, uncertainAdjudicator, runtimeOff);
  const { rows } = await getPool().query(
    `SELECT adjudication_status, adjudication_reason FROM friction_signals WHERE id = $1`, [foldSignalId]);
  expect(rows[0].adjudication_status).toBe('rejected');
  expect(rows[0].adjudication_reason).toBe('uncertain');
});
```

- [ ] **Step 2: Implement**

1. `db.ts` — `getScrubbedChunksInRange`: copy `getScrubbedChunksForSession`'s query and add `AND c.first_event_ms IS NOT NULL AND c.last_event_ms IS NOT NULL AND c.first_event_ms <= $4 AND c.last_event_ms >= $3` with `fromMs`/`toMs` params. Return the same exported row type `getScrubbedChunksForSession` uses (check `db.ts` for its name — do not invent one).
2. `promotion-db.ts` — atomic reservation against the Task 1 budget table:

```ts
/** Atomically reserve one model call from today's per-project budget.
 * Called BEFORE every outbound call — including shadow calls and calls that
 * subsequently fail — so concurrent jobs cannot overspend and failures are
 * still counted as spend. Returns false when the cap is exhausted. */
export async function tryReserveAdjudicationCall(
  client: PoolClient, projectId: string, dailyCap: number,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO adjudication_call_budget (project_id, day, calls)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (project_id, day)
     DO UPDATE SET calls = adjudication_call_budget.calls + 1
     WHERE adjudication_call_budget.calls < $2`,
    [projectId, dailyCap],
  );
  return (rowCount ?? 0) > 0;
}
```

3. `promotion.ts`:
   - `PendingSignalRow` gains `occurred_ats: number[] | null` (add `occurred_ats` to the SELECT at `promotion.ts:53`).
   - Budget checks live ONLY on paths that actually call the model — inheritance (`promotion.ts:125-137`), the anonymous skip, and below-threshold candidates proceed without touching the budget. **Reservation ORDER matters: reserve BEFORE claiming anything.** Fold path: reserve, and only then `claimSignalsForAdjudication` (`promotion.ts:80`). Bucket path: reserve, and only then `claimGeneration` (`promotion.ts:160`) — reserving after the claim would leak an `adjudicating` generation on exhaustion, wedging the partial unique index (`uq_friction_generation_inflight`) with no release path in the current source. Shadow calls reserve separately; an unreserved shadow is skipped without affecting the deciding call.
   - **Exhaustion must schedule a revisit — pending signals have no other producer.** On the first failed reservation for a deciding call: `await db.enqueueSessionAnalysisForBudgetRetry(session.id, session.project_id); logger.warn('Adjudication daily cap reached; re-enqueued for next budget day', { project_id: signal.project_id, job_id: jobId, cap: runtime.dailyCap }); break;` — break the signal loop (every later signal would fail the same reservation) and let the job complete normally. The helper (add in `db.ts`) inserts a fresh `session_analysis` job with `available_at = date_trunc('day', now()) + interval '1 day'`, mirroring the `error_group_jobs` insert columns from `CloseIdleSessions` (`db/sessions.go:599-616`) and guarded by the same `NOT EXISTS (… status IN ('pending','claimed'))` idempotence clause the late-chunk path uses (`db/sessions.go:376-393`) — re-running the whole analysis job is safe by construction (facts upsert is idempotent, signal writes are upserts, adjudication resumes from `pending`). Test: exhaust the budget, run `processFrictionOutcomes`, assert the signal stays `pending` AND a `session_analysis` job row exists for the session with `available_at > now()`; then delete the budget row (simulating the day rollover) and assert a second `processFrictionOutcomes` run adjudicates it.
   - Before each deciding `adjudicator.adjudicate(...)` call: when `runtime.windowMode !== 'off'`, `const windows = await runtime.loadWindows(signal);`. Mode `'on'`: pass `evidenceWindows: windows` in the input. Mode `'shadow'`: adjudicate with the selector-only input as today, then (budget permitting) fire the window call and log both verdicts without acting on the window one:

```ts
      if (runtime.windowMode === 'shadow') {
        try {
          const shadowVerdict = await adjudicator.adjudicate({ ...input, evidenceWindows: windows });
          logger.info('Adjudication shadow verdict', {
            project_id: signal.project_id, signal_id: signal.id, job_id: jobId,
            decided: verdict.accepted, shadow: shadowVerdict.accepted,
            shadow_uncertain: shadowVerdict.uncertain === true,
          });
        } catch (error) {
          logger.warn('Adjudication shadow call failed', { signal_id: signal.id, error: String(error) });
        }
      }
```

   - Verdict mapping before `applyFoldOutcome`/`applyBucketOutcome`: `const stored = verdict.uncertain === true ? { accepted: false, reason: 'uncertain' } : verdict;` and pass `stored` — the spec contract is `adjudication_reason = 'uncertain'` EXACTLY; the model's explanatory text goes into the log line only (`logger.info('...', { uncertain_detail: verdict.reason })`). (`applyFoldOutcome`/`applyBucketOutcome` signatures are unchanged — they already persist `accepted`/`reason` into status/`adjudication_reason`.)
4. `index.ts`:
   - Env knobs read once at startup: `const evidenceWindowMode = (process.env['ADJUDICATION_EVIDENCE_WINDOWS'] ?? 'off') as EvidenceWindowMode;` (validate against the three values, warn+`'off'` otherwise) and `const adjudicationDailyCap = Number(process.env['ADJUDICATION_DAILY_CAP'] ?? 500);`.
   - The factory now takes the mode (Task 6 item 5): `frictionAdjudicatorFactory(adjudicationKey, evidenceWindowMode)`.
   - `loadWindows` reads chunks **per occurrence** — a single min..max range through the 20 MiB session budget can truncate before later occurrences, silently emptying their windows. Cache chunk reads by `seq` so overlapping occurrence ranges don't re-fetch:

```ts
      await processFrictionOutcomes(session, job.id, frictionAdjudicatorFactory(adjudicationKey, evidenceWindowMode), {
        windowMode: evidenceWindowMode,
        dailyCap: adjudicationDailyCap,
        loadWindows: async (s) => {
          const ats = s.occurred_ats ?? [];
          if (ats.length === 0) return [];
          const envelopesBySeq = new Map<number, SessionChunkEnvelope>();
          for (const at of ats) {
            const rangeChunks = await db.getScrubbedChunksInRange(
              s.session_id, s.project_id, at - EVIDENCE_WINDOW_MS, at + EVIDENCE_WINDOW_MS);
            const unseen = rangeChunks.filter((c) => !envelopesBySeq.has(c.seq));
            if (unseen.length === 0) continue;
            const read = await readChunksBounded(unseen, { skipUnreadable: true });
            read.envelopes.forEach((env, i) => {
              const seq = read.envelopeSeqs[i];
              if (seq !== undefined) envelopesBySeq.set(seq, env);
            });
          }
          return buildEvidenceWindows([...envelopesBySeq.values()], ats);
        },
      });
```

     (`envelopeSeqs` is the alignment array Task 3 added to the reader result — with `skipUnreadable`, `envelopes` can be shorter than the input chunk list.)
   - Update every other `processFrictionOutcomes` caller/test stub to the four-arg signature (grep for it).

- [ ] **Step 3: Run tests**

```bash
DATABASE_URL="$DATABASE_URL" pnpm --filter @opslane/worker test
pnpm --filter @opslane/worker build
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/friction/promotion.ts packages/worker/src/friction/promotion-db.ts packages/worker/src/db.ts packages/worker/src/index.ts packages/worker/src/__tests__/
git commit -m "feat(worker): evidence-window adjudication behind off/shadow/on flag with daily call cap"
```

---

### Task 8: Ingestion read path + dashboard chips + unverified count

**Files:**
- Modify: `packages/ingestion/db/sessions_read.go` (`sessionSummarySelect`, `SessionSummary`, scans)
- Modify: `packages/ingestion/handler/session_read.go` (response JSON)
- Modify: `packages/dashboard/src/api.ts` (SessionSummary type)
- Modify: `packages/dashboard/src/components/sessions/SessionLedgerRow.vue`
- Test: extend `packages/ingestion/handler/session_read_test.go`

**Interfaces:**
- Consumes: `session_analysis` rows (Task 3), pending `friction_signals` (existing).
- Produces: session list/detail JSON gains `coverage`, `activity_class`, `failed_request_count` (4xx+5xx sum), `successful_write_count`, `unverified_signal_count` — names the dashboard consumes verbatim.

- [ ] **Step 1: Write the failing handler test**

In `session_read_test.go`, extend the existing list test: seed a `session_analysis` row (`coverage='complete'`, `activity_class='active'`, `failed_request_4xx_count=2`, `successful_write_count=1`) plus BOTH one `accepted` and one `pending` friction signal for the session; assert the JSON response contains `"coverage":"complete"`, `"activity_class":"active"`, `"failed_request_count":2`, `"successful_write_count":1`, and `"unverified_signal_count":1` **alongside the accepted count** (pending must not hide behind accepted). Also assert a session with no analysis row yields `"coverage":null` (pending analysis is distinct from `no_replay`).

- [ ] **Step 2: Run to verify failure**

```bash
cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./handler -run TestSessionList -v
```

- [ ] **Step 3: Implement**

1. `sessionSummarySelect` (`sessions_read.go:67`): add to the select list `sa.coverage, sa.activity_class, (sa.failed_request_4xx_count + sa.failed_request_5xx_count), sa.successful_write_count, f.pending` and add joins/lateral fields:
   - `LEFT JOIN session_analysis sa ON sa.session_id = s.id AND sa.project_id = $1`
   - in the existing friction lateral, add `COALESCE(sum(fs.occurrence_count) FILTER (WHERE fs.adjudication_status = 'pending'), 0) AS pending` — note the lateral currently filters `adjudication_status = 'accepted'` in its WHERE; move that predicate into the per-aggregate FILTERs so one lateral serves both accepted and pending sums:

```sql
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(fs.occurrence_count) FILTER (WHERE fs.adjudication_status = 'accepted' AND fs.signal_type = 'rage_click'), 0) AS rage,
           COALESCE(sum(fs.occurrence_count) FILTER (WHERE fs.adjudication_status = 'accepted' AND fs.signal_type = 'dead_click'), 0) AS dead,
           COALESCE(sum(fs.occurrence_count) FILTER (WHERE fs.adjudication_status = 'accepted' AND fs.signal_type = 'form_abandon'), 0) AS abandon,
           COALESCE(sum(fs.occurrence_count) FILTER (WHERE fs.adjudication_status = 'pending'), 0) AS pending
      FROM friction_signals fs
     WHERE fs.session_id = s.id AND fs.project_id = $1
       AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
  ) f ON true
```

2. `SessionSummary` struct: add `Coverage *string`, `ActivityClass *string`, `FailedRequestCount int`, `SuccessfulWriteCount int`, `UnverifiedSignalCount int` (nullable pointers for the two enums because the analysis row may not exist yet); extend every scan site (list + single-session getter at `sessions_read.go:60-64`) — use `COALESCE(sa.failed_request_4xx_count + sa.failed_request_5xx_count, 0)` in SQL so the ints scan clean.
3. `handler/session_read.go`: add the five JSON fields (snake_case, following the existing response struct pattern at `session_read.go:42-44`).
4. `packages/dashboard/src/api.ts`: extend the `SessionSummary` type with `coverage: string | null; activity_class: string | null; failed_request_count: number; successful_write_count: number; unverified_signal_count: number;`.
5. `SessionLedgerRow.vue`: render (a) an activity-class chip when `activity_class` is non-null (plain text chip, reuse the badge styling in the component), (b) a muted `no replay` chip when `coverage === 'no_replay'` and a `partial` chip when `'partial'`, (c) a `⚠ n failed requests` chip when `failed_request_count > 0`, (d) an `unverified` chip **whenever `unverified_signal_count > 0`** — a session with one accepted and one pending signal shows both the accepted badge and the unverified chip; hiding pending behind accepted re-creates the invisibility this feature removes.
6. If `SessionFilters` has a has-signals style filter (check `sessions_read.go` for the filter struct), extend its predicate to include `f.pending > 0` alongside accepted counts — otherwise keyless deployments' unverified-only sessions vanish under that filter. Add a handler test case for it (keyless: pending-only session appears under the filter).

- [ ] **Step 4: Run tests and build**

```bash
cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./... && go build ./...
pnpm --filter @opslane/dashboard build
```
Expected: PASS / clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/sessions_read.go packages/ingestion/handler/session_read.go packages/ingestion/handler/session_read_test.go packages/dashboard/src/api.ts packages/dashboard/src/components/sessions/SessionLedgerRow.vue
git commit -m "feat: surface session analysis facts and unverified signals in session list"
```

---

### Task 9: Investigation context

**Files:**
- Modify: `packages/worker/src/index.ts` (error investigation at `index.ts:879-962`, friction investigation entry at `index.ts:660`)
- Test: extend the investigation prompt-assembly test (find the suite covering `processInvestigateJob` context; if prompt assembly is untested, add a focused unit test for the new context formatter instead)

**Interfaces:**
- Consumes: `getSessionAnalysis` (Task 3).
- Produces, exported from `packages/worker/src/friction/facts.ts`:

```ts
export interface SessionContextInput {
  coverage: Coverage;
  activityClass: ActivityClass;
  entryPath: string | null;
  failedRequest4xxCount: number;
  failedRequest5xxCount: number;
  successfulWriteCount: number;
}
export function formatSessionContext(row: SessionContextInput): string;
```

One fenced line like `Session context: active session entering at /getting-started; 6 same-origin failed requests; 2 successful writes; coverage complete.` The dedicated input interface (not `SessionAnalysisUpsert` + a cast) keeps the test type-checked — an `as never` fixture would keep compiling after incompatible row changes.

- [ ] **Step 1: Write the failing test**

```ts
it('formats session context for prompts, omitting zero counts', () => {
  const input: SessionContextInput = {
    coverage: 'complete', activityClass: 'active', entryPath: '/getting-started',
    failedRequest4xxCount: 6, failedRequest5xxCount: 0, successfulWriteCount: 2,
  };
  expect(formatSessionContext(input)).toBe(
    'Session context: active session entering at /getting-started; 6 same-origin failed requests; 2 successful writes; coverage complete.',
  );
});
```

- [ ] **Step 2: Implement**

`formatSessionContext` in `facts.ts` builds the sentence from non-zero parts (failed = 4xx + 5xx summed). In `index.ts`, where the investigation resolves its session pointer (`getSessionPointerForGroup` path) and in `processFrictionInvestigateJob`, fetch `await db.getSessionAnalysis(sessionId, projectId)` and, when non-null, append `formatSessionContext(row)` to the evidence/context block that is already fenced as untrusted (entry paths are page content — keep them inside the fence).

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @opslane/worker test -- facts
pnpm --filter @opslane/worker build
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/friction/facts.ts packages/worker/src/index.ts packages/worker/src/friction/__tests__/facts.test.ts
git commit -m "feat(worker): session facts as investigation context"
```

---

### Task 10: Digest rollup query (data contract only)

**Files:**
- Modify: `packages/ingestion/db/sessions_read.go` (append the rollup query + types)
- Test: `packages/ingestion/db/session_analysis_test.go` (extend)

**Interfaces:**
- Produces (the digest feature consumes this later):

```go
type SessionAnalysisDailyRollup struct {
    Day                    time.Time
    TotalSessions          int
    NoReplaySessions       int
    PartialSessions        int
    ActiveSessions         int
    LightTouchSessions     int
    ZeroInteractionSessions int
    IdleTabSessions        int
    SuccessfulWrites       int
    SessionsWithFailures   int
}
func (q *Queries) SessionAnalysisDailyRollup(ctx context.Context, projectID string, day time.Time) (SessionAnalysisDailyRollup, error)
```

- [ ] **Step 1: Write the failing test**

Seed four `session_analysis` rows for one project across two `session_started_at` days: one `no_replay`, one `complete/active` with writes, one `complete/idle_tab` with a 4xx, and one **adversarial `partial` row with `activity_class='active'` and nonzero `successful_write_count` and `failed_request_4xx_count`** (the analyzer writes `unknown` for non-complete coverage, but the SQL must enforce the contract even against a buggy writer). Assert the rollup for day 1: counts only day-1 sessions; buckets by coverage; buckets activity classes, sums writes, and counts failure sessions **over `coverage = 'complete'` rows only** — none of the partial row's activity class, writes, or failures may leak into behavioral metrics (they are prefix facts, not whole-session facts). Assert a rollup for a day with no rows returns zeros, not an error.

- [ ] **Step 2: Implement**

```go
func (q *Queries) SessionAnalysisDailyRollup(ctx context.Context, projectID string, day time.Time) (SessionAnalysisDailyRollup, error) {
	var r SessionAnalysisDailyRollup
	r.Day = day
	err := q.pool.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE coverage = 'no_replay'),
		       count(*) FILTER (WHERE coverage = 'partial'),
		       count(*) FILTER (WHERE coverage = 'complete' AND activity_class = 'active'),
		       count(*) FILTER (WHERE coverage = 'complete' AND activity_class = 'light_touch'),
		       count(*) FILTER (WHERE coverage = 'complete' AND activity_class = 'zero_interaction'),
		       count(*) FILTER (WHERE coverage = 'complete' AND activity_class = 'idle_tab'),
		       COALESCE(sum(successful_write_count) FILTER (WHERE coverage = 'complete'), 0),
		       count(*) FILTER (WHERE coverage = 'complete'
		                          AND failed_request_4xx_count + failed_request_5xx_count > 0)
		  FROM session_analysis
		 WHERE project_id = $1
		   AND session_started_at >= $2::date
		   AND session_started_at < $2::date + interval '1 day'`,
		projectID, day).Scan(
		&r.TotalSessions, &r.NoReplaySessions, &r.PartialSessions,
		&r.ActiveSessions, &r.LightTouchSessions, &r.ZeroInteractionSessions,
		&r.IdleTabSessions, &r.SuccessfulWrites, &r.SessionsWithFailures)
	return r, err
}
```

- [ ] **Step 3: Run tests, commit**

```bash
cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./db -run TestSessionAnalysis -v
git add packages/ingestion/db/sessions_read.go packages/ingestion/db/session_analysis_test.go
git commit -m "feat(db): daily session-analysis rollup keyed to session_started_at"
```

---

### Task 11: Backfill command

**Files:**
- Create: `packages/ingestion/cmd/backfill-session-analysis/main.go`
- Test: `packages/ingestion/db/session_analysis_test.go` (extend with the enqueue-query test)

**Interfaces:**
- Consumes: `error_group_jobs` queue conventions (`job_type = 'session_analysis'`, the `NOT EXISTS (… status IN ('pending','claimed'))` idempotence guard from `MarkChunkScrubbed`, `db/sessions.go:376-393`).
- Produces: a manually-run command: `go run ./cmd/backfill-session-analysis -batch 100 -sleep 30s [-dry-run]`.

- [ ] **Step 1: Write the failing enqueue-query test**

Test the core query as a `Queries` method `EnqueueAnalysisBackfillBatch(ctx, ruleVersion, batch int) (int, error)`: seed one `analyzed` session missing a current-version `session_analysis` row, one already-current session, one with a pending `session_analysis` job, and one **older than 30 days** (`started_at = now() - interval '40 days'`). Assert only the first gets a new job row — the 30-day retention window bounds the backfill (spec: backfill re-analyzes retained sessions only).

- [ ] **Step 2: Implement the query and the command**

```go
// db method
func (q *Queries) EnqueueAnalysisBackfillBatch(ctx context.Context, ruleVersion, batch int) (int, error) {
	tag, err := q.pool.Exec(ctx, `
		INSERT INTO error_group_jobs (project_id, session_id, job_type, status)
		SELECT s.project_id, s.id, 'session_analysis', 'pending'
		  FROM sessions s
		 WHERE s.status IN ('closed', 'analyzed', 'analysis_failed')
		   AND s.started_at >= now() - interval '30 days'
		   AND NOT EXISTS (SELECT 1 FROM session_analysis sa
		                    WHERE sa.session_id = s.id AND sa.rule_version >= $1)
		   AND NOT EXISTS (SELECT 1 FROM error_group_jobs j
		                    WHERE j.session_id = s.id AND j.job_type = 'session_analysis'
		                      AND j.status IN ('pending', 'claimed'))
		 ORDER BY s.started_at DESC
		 LIMIT $2`, ruleVersion, batch)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}
```

Copy the exact `error_group_jobs` insert column list from the `CloseIdleSessions` CTE (`db/sessions.go:599-616`) — if that insert carries more columns (e.g. `available_at`, platform), mirror them. `main.go` is a flag-parsing loop: connect via `DATABASE_URL`, each tick call `EnqueueAnalysisBackfillBatch(ctx, currentRuleVersion, *batch)` (rule version passed as a `-rule-version` flag; document that it must match the worker's `RULE_VERSION`), log the count, sleep `-sleep`, exit when a tick enqueues zero. `-dry-run` runs the candidate count ONCE (`WITH candidates AS (...) SELECT count(*)`), prints it, and exits immediately — a dry-run loop would never terminate, since nothing it does changes the candidate count.

- [ ] **Step 3: Run tests and build**

```bash
cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./db -run TestEnqueueAnalysisBackfill -v && go build ./...
```

- [ ] **Step 4: Commit**

```bash
git add packages/ingestion/cmd/backfill-session-analysis/ packages/ingestion/db/
git commit -m "feat(ingestion): rate-limited session-analysis backfill command"
```

---

### Task 12: Bench, env-var docs

**Files:**
- Modify: `packages/worker/scripts/bench-analyzer.ts` (add `extractSessionFacts` to the benched pass)
- Modify: `docs/reference/environment-variables.md`

- [ ] **Step 1: Bench** — call `extractSessionFacts(chunks)` alongside `analyzeSession(chunks)` inside the timed section; keep the existing p95 < 5,000ms budget. Run it and record the number in the commit message.

- [ ] **Step 2: Docs** — add rows for `ADJUDICATION_EVIDENCE_WINDOWS` (`off` | `shadow` | `on`, default `off`; `shadow` doubles model calls for flagged signals while selector-only verdicts still decide) and `ADJUDICATION_DAILY_CAP` (default 500; per-project; overflow signals stay pending for the next day's budget), in the worker section, matching the file's table format.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/scripts/bench-analyzer.ts docs/reference/environment-variables.md
git commit -m "chore: bench facts extraction; document adjudication env knobs"
```

---

### Task 13: Full verification gate + live smoke

**Files:** none (verification only; fix-forward anything it surfaces)

- [ ] **Step 1: Full repository gate**

```bash
pnpm install --frozen-lockfile
pnpm -r build
DATABASE_URL="$DATABASE_URL" pnpm test
(cd packages/ingestion && go build ./... && DATABASE_URL="$DATABASE_URL" go test ./...)
docker compose config --quiet
```
Confirm the Go suite reports **zero skips** (storage misconfiguration reports `ok` while ~30 tests never run — root AGENTS.md).

- [ ] **Step 2: Live smoke (worktree ports per root AGENTS.md)**

Export the port triple + URL block from root AGENTS.md (pick free ports), `docker compose up -d --build`, apply `scripts/seed-e2e.sql`, then:

1. Register a session (`POST /api/v1/sessions/init`) and upload 3 gzipped chunks containing: a page event, 4 clicks with `cursor: 'pointer'` on one selector (unanswered), one same-origin `POST` with a 201 end, one cross-origin 400 end. No error event.
2. Wait for scrub + idle-close (set `SESSION_IDLE_CLOSE_MINUTES=1` and `RETENTION_SWEEP_INTERVAL_SECONDS=30` on the stack) and for the worker to process the analysis job.
3. Assert in Postgres: the `session_analysis` row has `coverage='complete'`, `activity_class='active'`, `successful_write_count=1`, `failed_request_4xx_count=0` (cross-origin excluded); `friction_signals` has one active `rage_click` at `rule_version=2` with `occurrence_count=1` and a **1-element** `occurred_ats` (one entry per cluster — the 4 clicks form one rage cluster, per the Task 4 contract).
4. Keyless assertion: with the worker's `ANTHROPIC_API_KEY` unset, `GET /api/v1/projects/{pid}/sessions` shows the session with `unverified_signal_count > 0`.
5. Backfill assertion: run `go run ./cmd/backfill-session-analysis -rule-version 2 -batch 10 -sleep 1s -dry-run` against the stack DB and confirm it reports zero candidates (the session is already analyzed at v2).

- [ ] **Step 3: Commit any fixes; report the smoke transcript in the PR/summary.**
