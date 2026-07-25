# Origin Allowlist: Server-Side SDK Exemption — Implementation Plan

> **Superseded for replay chunk routes:** the upload-url, commit, and inline endpoints were replaced by the single-call ingestion upload in `2026-07-24-replay-chunk-upload-r2.md`. This document remains a historical implementation record.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop the browser origin allowlist from silently dropping every backend SDK event, so one project can hold both browser and server-side errors — which is what our one-project-many-platforms model requires.

**Architecture:** `EnforceOrigin` treats "no `Origin`" as "not on the allowlist" and returns 403. Server-side SDKs send neither `Origin` nor `Referer`, so an allowlisted project rejects every Python event. Rather than relax the middleware everywhere, add a second entry point used by **`POST /api/v1/events` only** — the one route a server-side SDK touches (`packages/sdk-python/opslane/transport.py:84` builds exactly that URL and no other). The other seven routes it guards are browser-only (replay init/complete/fail, session init, chunk upload-url/commit/inline) and keep today's strict behavior. Within the relaxed path, the exemption keys on header **presence**, not emptiness.

**Tech Stack:** Go 1.24 (chi) in `packages/ingestion`; Vitest + `pg` + Playwright in `test-e2e`.

**Tracker:** issue #104. Rationale and the Sentry citation live in the issue comment.

---

## Ground rules for the executor

- **Branch:** `abhishekray07/origin-allowlist-server-exemption` off up-to-date `origin/main`:
  ```bash
  git fetch origin && git checkout -b abhishekray07/origin-allowlist-server-exemption origin/main
  ```
- **DB-backed Go tests** skip without `DATABASE_URL`. Use a disposable Postgres, never the shared 5434 instance (another worktree uses it):
  ```bash
  docker run -d --rm --name origin-pg -e POSTGRES_USER=opslane -e POSTGRES_PASSWORD=opslane \
    -e POSTGRES_DB=opslane -p 5497:5432 postgres:16-alpine
  # pg_isready can report OK mid-init; gate on a real query instead
  for i in $(seq 1 60); do docker exec origin-pg psql -U opslane -d opslane -tAc "select 1" >/dev/null 2>&1 && break; sleep 1; done
  for f in packages/ingestion/db/migrations/*.sql; do
    docker exec -i origin-pg psql -q -U opslane -d opslane -v ON_ERROR_STOP=1 < "$f"; done
  export DATABASE_URL="postgres://opslane:opslane@localhost:5497/opslane"
  ```
  Tear down with `docker stop origin-pg`.
- **This is a deliberate contract change.** An existing test asserts the old behavior (Task 1). Per AGENTS.md, documented contracts may change — explicitly. The commit message must say so.
- Commit after every task with the message given. No Claude attribution, no co-author lines.

## Threat model (read before writing the comment in Task 1)

State this accurately; the current doc comment does not.

- The allowlist is **a browser-origin control only.** `Origin` is trustworthy because browsers set it and page JavaScript cannot forge it. Any non-browser caller can send whatever `Origin` it likes, so the allowlist never constrained scripts and does not become weaker by admitting header-less ones.
- **Do not claim rate limits bound a stolen key's blast radius.** `eventsLimiter` is an in-memory, per-process fixed-window counter (`newRateLimiter`, `auth_handlers.go:35`): every replica gets its own allowance and a restart resets it. It sheds sustained floods per pod; it is not a distributed quota and does not bound storage or worker-job cost.
- **Assumption worth naming:** a proxy in front of ingestion that strips `Origin` would make browser traffic look header-less on `/events` and silently skip the check. Task 1 logs each exemption at `Debug`, but `main.go:24` builds the logger at the default `Info` level and there is no `LOG_LEVEL` knob, so that line is a hook for investigation, not live detection. Closing this properly needs a counter, which is out of scope here.
- **Why scoping to `/events` matters:** browsers always send `Origin` on POST (Fetch spec: `Origin` is included for every request whose method is not GET/HEAD, same-origin included), so a real browser hitting `/events` is never exempted. Task 4 verifies that in real Chromium instead of trusting the spec.

---

### Task 1: Presence-based exemption behind a separate entry point

**Files:**
- Modify: `packages/ingestion/handler/ingest_limits.go:51-90`
- Test: `packages/ingestion/handler/ingest_limits_test.go`

**Step 1: Change the existing assertion that encodes the old behavior**

In `TestEnforceOrigin_RejectsNonAllowlistedOrigin` (`ingest_limits_test.go:69`), the final block asserts an Origin-less request is rejected. That behavior is **retained** for `EnforceOrigin` (browser-only routes), so this test stays as-is. Confirm it still passes unchanged at the end of this task — if it fails, the exemption leaked into the strict path.

**Step 2: Write the failing tests for the new entry point**

```go
func TestEnforceOriginAllowingServerSDK_HeaderlessRequestPasses(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOriginAllowingServerSDK(next)

	// Exactly what packages/sdk-python sends: no Origin, no Referer.
	req := httptest.NewRequest("POST", "/api/v1/events", nil)
	req = req.WithContext(handler.WithAllowedOriginsForTest(
		context.Background(), []string{"https://app.example.com"}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("server-side SDK must reach an allowlisted project, got %d", rec.Code)
	}
}

// http.Header.Get returns "" for BOTH an absent header and a present-but-empty
// one, so an emptiness check would let `Origin:` bypass the allowlist. The
// exemption must key on presence.
func TestEnforceOriginAllowingServerSDK_EmptyValuedHeadersAreNotHeaderless(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOriginAllowingServerSDK(next)
	allowed := []string{"https://app.example.com"}

	for _, header := range []string{"Origin", "Referer"} {
		req := httptest.NewRequest("POST", "/api/v1/events", nil)
		req.Header.Set(header, "") // present, empty
		req = req.WithContext(handler.WithAllowedOriginsForTest(context.Background(), allowed))

		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("empty-valued %s must not be treated as header-less, got %d", header, rec.Code)
		}
	}
}

func TestEnforceOriginAllowingServerSDK_BrowserRequestsStillEnforced(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOriginAllowingServerSDK(next)
	allowed := []string{"https://app.example.com"}

	mk := func(key, value string) *http.Request {
		req := httptest.NewRequest("POST", "/api/v1/events", nil)
		req.Header.Set(key, value)
		return req.WithContext(handler.WithAllowedOriginsForTest(context.Background(), allowed))
	}

	cases := []struct {
		name string
		req  *http.Request
		want int
	}{
		{"allowlisted origin", mk("Origin", "https://app.example.com"), http.StatusOK},
		{"foreign origin", mk("Origin", "https://evil.com"), http.StatusForbidden},
		{"allowlisted referer", mk("Referer", "https://app.example.com/checkout"), http.StatusOK},
		{"foreign referer", mk("Referer", "https://evil.com/x"), http.StatusForbidden},
		// A present-but-unparseable Referer is still browser context: fail closed.
		{"malformed referer", mk("Referer", "::not a url::"), http.StatusForbidden},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, tc.req)
		if rec.Code != tc.want {
			t.Errorf("%s: got %d, want %d", tc.name, rec.Code, tc.want)
		}
	}
}

// The strict middleware must NOT gain the exemption: replay and session routes
// are browser-only, so a header-less caller has no business there.
func TestEnforceOrigin_HeaderlessStillRejected(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOrigin(next)

	req := httptest.NewRequest("POST", "/api/v1/sessions/init", nil)
	req = req.WithContext(handler.WithAllowedOriginsForTest(
		context.Background(), []string{"https://app.example.com"}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("browser-only routes must still reject header-less callers, got %d", rec.Code)
	}
}
```

**Step 3: Run to verify they fail**

Run: `cd packages/ingestion && go test ./handler -run TestEnforceOrigin -count=1`
Expected: the three `AllowingServerSDK` tests FAIL to compile (`undefined: EnforceOriginAllowingServerSDK`). `TestEnforceOrigin_HeaderlessStillRejected` should PASS once it compiles — it describes today's behavior, which we are keeping. Comment the new tests out one at a time if you want to see that independently.

**Step 4: Implement**

Replace `EnforceOrigin` (`ingest_limits.go:51-77`) with the split below. Keep `originAllowed` and `originFromReferer` unchanged.

```go
// EnforceOrigin rejects SDK ingest from origins not on the project's allowlist.
//
// Scope: this is a BROWSER-ORIGIN control, and only that. `Origin` is
// meaningful because browsers set it and page JavaScript cannot forge it; any
// non-browser caller can send whatever it likes. It stops another site from
// reusing a public SDK key, not a script. Opt-in: an empty allowlist allows
// all origins.
//
// Used by the browser-only routes (replays, sessions, chunks). A caller with
// no browser context has no legitimate business on those, so header-less
// requests stay rejected here. See EnforceOriginAllowingServerSDK for /events.
func (d *Dependencies) EnforceOrigin(next http.Handler) http.Handler {
	return d.enforceOrigin(next, false)
}

// EnforceOriginAllowingServerSDK is EnforceOrigin for POST /api/v1/events, the
// only route a server-side SDK touches (packages/sdk-python/opslane/transport.py
// builds that URL and no other).
//
// A request carrying neither Origin nor Referer has no browser context, so the
// browser-origin allowlist does not apply to it (#104). Denying it bought
// nothing — the same caller can forge an Origin — while breaking every
// legitimate backend SDK and forcing customers into a second project.
//
// Browsers always send Origin on POST (Fetch spec: included for any method
// other than GET/HEAD, same-origin included), so real browser traffic is never
// exempted here. If a proxy in front of ingestion strips Origin, browser
// traffic would look header-less; the debug log below makes that greppable.
func (d *Dependencies) EnforceOriginAllowingServerSDK(next http.Handler) http.Handler {
	return d.enforceOrigin(next, true)
}

func (d *Dependencies) enforceOrigin(next http.Handler, allowServerSDK bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowed := AllowedOriginsFromCtx(r.Context())
		if len(allowed) == 0 {
			next.ServeHTTP(w, r)
			return
		}

		// Presence, not emptiness: Header.Get returns "" for an absent header
		// AND for a present-but-empty one, so `Origin:` would otherwise slip
		// through as "no browser context".
		hasBrowserContext := len(r.Header.Values("Origin")) > 0 ||
			len(r.Header.Values("Referer")) > 0
		if allowServerSDK && !hasBrowserContext {
			slog.Debug("ingest allowed: no browser context (server-side SDK)",
				"project_id", ProjectIDFromCtx(r.Context()), "path", r.URL.Path)
			next.ServeHTTP(w, r)
			return
		}

		origin := r.Header.Get("Origin")
		if origin == "" {
			origin = originFromReferer(r.Header.Get("Referer"))
		}
		if !originAllowed(origin, allowed) {
			slog.Warn("ingest rejected: origin not allowlisted",
				"project_id", ProjectIDFromCtx(r.Context()), "origin", origin)
			writeJSONError(w, http.StatusForbidden, "origin not allowed")
			return
		}

		next.ServeHTTP(w, r)
	})
}
```

Note on the log level: `Debug`, not `Info` — `/events` runs at up to 600 req/min/project, and a per-request `Info` line would be noise. A counter would be better than a log for detecting proxy stripping, but this file has no metrics surface and inventing one belongs with the metrics work, not here.

**Step 5: Run to verify they pass**

Run: `cd packages/ingestion && go test ./handler -run TestEnforceOrigin -count=1 -v`
Expected: all `TestEnforceOrigin*` tests PASS, including the untouched `TestEnforceOrigin_EmptyAllowlistAllowsAll`, `TestEnforceOrigin_RejectsNonAllowlistedOrigin`, and `TestEnforceOrigin_MatchIsCaseInsensitive`.

Then: `go build ./... && go vet ./...`

**Step 6: Commit**

```bash
git add packages/ingestion/handler/ingest_limits.go packages/ingestion/handler/ingest_limits_test.go
git commit -m "fix(ingestion): exempt server-side SDKs from the origin allowlist on /events

EnforceOrigin treated a missing Origin as 'not allowlisted' and returned
403. Server-side SDKs send neither Origin nor Referer, so a project with an
allowlist configured dropped every backend event and the Python SDK README
had to tell people to use a second project.

The allowlist is a browser-origin control and only that: Origin is
meaningful because browsers set it and page script cannot forge it, while
any non-browser caller can send whatever it likes. Denying the header-less
case bought nothing against an attacker and broke legitimate SDKs.

Scoped deliberately. EnforceOriginAllowingServerSDK is used by /events
alone, the only route a server-side SDK touches; the seven browser-only
routes keep the strict middleware unchanged. The exemption keys on header
presence rather than Header.Get emptiness, so a present-but-empty Origin
cannot slip through as 'no browser context'.

This intentionally changes behavior on /events; the strict path's existing
assertions are unchanged and still pass."
```

---

### Task 2: Point `/events` at the new middleware

**Files:**
- Modify: `packages/ingestion/handler/routes.go:81-91`
- Test: `packages/ingestion/handler/ingest_limits_test.go` (router-level)

**Step 1: Write the failing router test**

A middleware unit test cannot catch the routes table being wired to the wrong entry point. This one goes through `handler.NewRouter`, so it needs `DATABASE_URL` and the existing `testDeps`/`seedTenant` helpers in `error_event_test.go`.

```go
func TestRouter_OriginExemptionIsScopedToEvents(t *testing.T) {
	deps, pool := testDeps(t)
	_, projectID, _, rawKey := seedTenant(t, deps.Queries)
	if _, err := pool.Exec(context.Background(),
		`UPDATE projects SET allowed_origins = $2 WHERE id = $1`,
		projectID, []string{"https://app.example.com"}); err != nil {
		t.Fatalf("set allowlist: %v", err)
	}
	router := handler.NewRouter(deps)

	post := func(path, body string) int {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", rawKey)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec.Code
	}

	// /events: header-less server SDK is admitted (not 403).
	if code := post("/api/v1/events", `{"timestamp":"2026-07-20T00:00:00Z","platform":"python","error":{"type":"ValueError","message":"scoped","stack":"Traceback (most recent call last):\nValueError: scoped"},"breadcrumbs":[],"context":{}}`); code == http.StatusForbidden {
		t.Fatalf("/events must not 403 a header-less server SDK, got %d", code)
	}

	// A browser-only route must still reject the same header-less caller.
	if code := post("/api/v1/sessions/init", `{}`); code != http.StatusForbidden {
		t.Fatalf("/sessions/init must still 403 a header-less caller, got %d", code)
	}
}
```

**Step 2: Run to verify it fails**

Run: `cd packages/ingestion && go test ./handler -run TestRouter_OriginExemptionIsScopedToEvents -count=1` (needs `DATABASE_URL`)
Expected: FAIL — `/events` returns 403, because the route still uses the strict middleware.

**Step 3: Implement**

In `routes.go`, change only the `/events` line and update the comment above the block:

```go
		// SDK endpoints (authenticated by API key, rate-limited per project).
		// Browser endpoints (replays, sessions, chunks) are origin-gated
		// strictly. /events also accepts server-side SDKs, which send no
		// Origin or Referer (#104). Sourcemaps are uploaded at build time from
		// Node (no Origin header), so EnforceOrigin is not applied there.
		r.With(deps.AuthenticateSDK, deps.EnforceOriginAllowingServerSDK, rateLimitByProject(eventsLimiter)).Post("/events", deps.IngestEvent)
```

Leave the seven other `deps.EnforceOrigin` lines untouched.

**Step 4: Run to verify it passes**

Run: `go test ./handler -count=1` (needs `DATABASE_URL`). All pass.

**Step 5: Commit**

```bash
git add packages/ingestion/handler/routes.go packages/ingestion/handler/ingest_limits_test.go
git commit -m "fix(ingestion): route /events through the server-SDK origin middleware

Router-level test pins the scope: /events admits a header-less server SDK
while /sessions/init still rejects one, so the exemption cannot silently
spread to the browser-only routes."
```

---

### Task 3: End-to-end proof against a real allowlisted project

**Files:**
- Test: `test-e2e/origin-allowlist.test.ts` (create)

**Step 1: Write the test**

```ts
/**
 * E2E: a project with a browser origin allowlist must still accept
 * server-side SDK events, which carry neither Origin nor Referer (#104),
 * while browser-shaped requests stay gated and browser-only routes stay
 * strict.
 *
 * Required:
 *   DATABASE_URL   — Postgres connection string
 *   INGESTION_URL  — Base URL for ingestion API (default: http://localhost:8082)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  seedTenant, cleanupTenant, closePool, getPool, getConfig, postEvent,
  type TestTenant,
} from './helpers.js';

const ALLOWED_ORIGIN = 'https://app.allowlisted.example';

function errorPayload(message: string): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    platform: 'python',
    error: {
      type: 'ValueError',
      message,
      stack: `Traceback (most recent call last):\nValueError: ${message}`,
    },
    breadcrumbs: [],
    context: {},
  };
}

async function post(
  path: string,
  apiKey: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const { ingestionUrl } = getConfig();
  return fetch(`${ingestionUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, ...headers },
    body: JSON.stringify(body),
  });
}

describe('origin allowlist with a server-side SDK', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await seedTenant('e2e/origin-allowlist');
    await getPool().query(
      `UPDATE projects SET allowed_origins = $2 WHERE id = $1`,
      [tenant.projectId, [ALLOWED_ORIGIN]],
    );
  }, 30_000);

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('accepts a backend event that carries no Origin or Referer', async () => {
    const res = await postEvent(tenant.apiKey, errorPayload('backend accepted'));
    expect(res.status).toBe(202);
  });

  it('accepts a browser event from an allowlisted origin', async () => {
    const res = await post('/api/v1/events', tenant.apiKey, errorPayload('browser ok'),
      { Origin: ALLOWED_ORIGIN });
    expect(res.status).toBe(202);
  });

  it('rejects a browser event from an origin not on the list', async () => {
    const res = await post('/api/v1/events', tenant.apiKey, errorPayload('browser blocked'),
      { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('rejects a referer-only event from an origin not on the list', async () => {
    const res = await post('/api/v1/events', tenant.apiKey, errorPayload('referer blocked'),
      { Referer: 'https://evil.example/checkout' });
    expect(res.status).toBe(403);
  });

  it('keeps browser-only routes strict for header-less callers', async () => {
    const res = await post('/api/v1/sessions/init', tenant.apiKey, {});
    expect(res.status).toBe(403);
  });
});
```

**Step 2: Get a genuine red**

Task 1 and 2 are already committed, so a build of `HEAD` contains the fix. To see the test actually fail, build the ingestion image from `origin/main` in a scratch worktree — do not revert the branch in place:

```bash
git worktree add /tmp/origin-base origin/main
docker compose -f /tmp/origin-base/docker-compose.yml config \
  | sed -e 's/published: "5434"/published: "5461"/' -e 's/published: "9012"/published: "9061"/' \
        -e 's/published: "8082"/published: "8093"/' > /tmp/origin-compose.yml
docker compose -p origin-smoke -f /tmp/origin-compose.yml up -d postgres minio minio-setup
docker compose -p origin-smoke -f /tmp/origin-compose.yml run --rm migrate
docker compose -p origin-smoke -f /tmp/origin-compose.yml up -d --build --wait ingestion
cd test-e2e && DATABASE_URL="postgres://opslane:opslane_dev@localhost:5461/opslane" \
  INGESTION_URL="http://localhost:8093" npx vitest run origin-allowlist.test.ts
```
Expected: the first case FAILS with 403; the other four PASS.

**Step 3: Rebuild from the branch and re-run**

```bash
docker compose -p origin-smoke -f /tmp/origin-compose.yml down -v
git worktree remove /tmp/origin-base
# rebuild from this branch's tree
docker compose config | sed -e 's/published: "5434"/published: "5461"/' \
  -e 's/published: "9012"/published: "9061"/' -e 's/published: "8082"/published: "8093"/' > /tmp/origin-compose.yml
docker compose -p origin-smoke -f /tmp/origin-compose.yml up -d postgres minio minio-setup
docker compose -p origin-smoke -f /tmp/origin-compose.yml run --rm migrate
docker compose -p origin-smoke -f /tmp/origin-compose.yml up -d --build --wait ingestion
cd test-e2e && DATABASE_URL="postgres://opslane:opslane_dev@localhost:5461/opslane" \
  INGESTION_URL="http://localhost:8093" npx vitest run origin-allowlist.test.ts
```
Expected: 5 passed. Keep the stack up for Task 4.

**Step 4: Commit**

```bash
git add test-e2e/origin-allowlist.test.ts
git commit -m "test(e2e): server-side SDK reaches an allowlisted project

Real key, real allowed_origins row: header-less backend events are
accepted, allowlisted browser origins pass, foreign origins and foreign
referers are rejected, and /sessions/init stays strict."
```

---

### Task 4: Prove a real browser is never exempted

The exemption is only safe because browsers always send `Origin` on POST. That is a claim about browser behavior, and every other test here uses Node `fetch`, which is not a browser. Verify it in real Chromium using the existing Playwright setup in `test-e2e/browser-smoke.test.ts` (read it first for the launch and skip-guard pattern).

**Files:**
- Test: `test-e2e/origin-allowlist-browser.test.ts` (create)

**Step 1: Write the test**

Serve a trivial page from a local origin, have the page `fetch` the events endpoint, and assert the server rejects it — proving Chromium attached an `Origin` the allowlist did not contain, rather than being waved through as header-less.

```ts
// Mirror browser-smoke.test.ts: skip when Playwright is unavailable rather
// than failing the suite on a machine without browsers installed.
```

Assertions:
1. From a page origin **not** on the allowlist, the POST is rejected (403). If Chromium sent no `Origin`, this would be 202 — that is the regression this test exists to catch.
2. With that same page origin added to `allowed_origins`, the POST is accepted (202).

**Step 2: Run**

```bash
cd test-e2e && DATABASE_URL="postgres://opslane:opslane_dev@localhost:5461/opslane" \
  INGESTION_URL="http://localhost:8093" npx vitest run origin-allowlist-browser.test.ts
```
Expected: 2 passed. If Chromium is not installed: `pnpm --filter @opslane/test-e2e exec playwright install --with-deps chromium`.

Tear down: `docker compose -p origin-smoke -f /tmp/origin-compose.yml down -v`

**Step 3: Commit**

```bash
git add test-e2e/origin-allowlist-browser.test.ts
git commit -m "test(e2e): real Chromium always sends Origin to /events

The exemption is only safe because browsers attach Origin to POST. Every
other test uses Node fetch, which proves nothing about that. This drives a
real page and asserts a non-allowlisted page origin is still rejected."
```

---

### Task 5: Remove the documented workaround

**Files:**
- Modify: `packages/sdk-python/README.md:36-38`

**Step 1: Delete the limitation paragraph**

Remove:

```
If your Opslane project has a browser origin allowlist configured, backend
events are rejected: server-side requests carry no `Origin` header. Send
backend errors to a project with an empty allowlist (or a separate project).
```

Add nothing in its place.

**Step 2: Confirm nothing else documents it**

```bash
grep -rn "origin allowlist" docs/ packages/sdk-python/ cli/ --include="*.md"
```
Note the CLI lives at `cli/`, not `packages/cli/`. Expected: no hits outside `docs/plans/`.

**Step 3: Verify the docs gate**

Run: `node scripts/check-docs-drift.mjs`
Expected: no drift.

**Step 4: Commit**

```bash
git add packages/sdk-python/README.md
git commit -m "docs(sdk-python): drop the origin-allowlist workaround

Backend events now reach allowlisted projects, so the advice to use a
separate project no longer applies."
```

---

### Task 6: CI gates

**Files:**
- Modify: `.github/workflows/ci.yml` (the `Enforce zero unexpected skips` step)

**Step 1: Get the authoritative test count**

`scripts/check-e2e-results.mjs` reads `numTotalTests` from the JSON report, so derive the floor from the same artifact CI consumes — not from `vitest list`:

```bash
cd test-e2e && DATABASE_URL=... INGESTION_URL=... \
  npx vitest run --reporter=json --outputFile=/tmp/e2e.json
node -e "console.log(require('/tmp/e2e.json').numTotalTests)"
```
Set `E2E_MIN_TESTS` from that number, keeping the existing slack margin.

**Step 2: Pin each security case by full name**

A suite-prefix pattern lets three of five cases be deleted while the count is propped up by unrelated tests. Pin the ones that carry the security contract:

```
            ^origin allowlist with a server-side SDK > accepts a backend event that carries no Origin or Referer
            ^origin allowlist with a server-side SDK > rejects a browser event from an origin not on the list
            ^origin allowlist with a server-side SDK > rejects a referer-only event from an origin not on the list
            ^origin allowlist with a server-side SDK > keeps browser-only routes strict for header-less callers
```

Add the browser suite's names from Task 4 the same way.

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: pin the origin-allowlist security cases by name

Raise the collected-test floor from the JSON report CI actually reads, and
pin each accepted/rejected case so none can be dropped while the total
count stays propped up by unrelated tests."
```

---

### Task 7: Full gate

**Step 1: Repo gate**

```bash
pnpm install --frozen-lockfile && pnpm -r build && pnpm test
(cd packages/ingestion && go build ./... && go vet ./... && DATABASE_URL=... go test ./... -count=1)
docker compose config --quiet
```
All green, using the disposable-DB `DATABASE_URL` from the ground rules.

**Step 2: Open the PR**

Reference #104. State plainly that this changes behavior on `/events` only, that the seven browser-only routes are untouched, and that the threat model is "browser-origin control, not a script control".

---

## Acceptance criteria

- [ ] A project with a non-empty `allowed_origins` accepts `/events` requests carrying neither `Origin` nor `Referer` (Task 1, Task 3)
- [ ] The seven browser-only routes still reject header-less callers (Task 1 unit, Task 2 router, Task 3 e2e)
- [ ] A present-but-empty `Origin` or `Referer` is NOT treated as header-less (Task 1)
- [ ] Foreign `Origin` and foreign `Referer` are still 403 on `/events`; a malformed `Referer` still fails closed (Task 1, Task 3)
- [ ] Real Chromium is still gated on `/events`, proving browsers attach `Origin` (Task 4)
- [ ] The empty-allowlist path is unchanged (existing tests still pass untouched)
- [ ] The Python SDK README no longer tells people to use a second project (Task 5)
- [ ] `E2E_MIN_TESTS` derived from `numTotalTests`, and each security case pinned by full name (Task 6)

## Explicitly out of scope

- **Applying origin enforcement to `/sourcemaps`.** Unrelated route, unchanged behavior.
- **Per-key browser/server marking.** Considered on #104 and rejected as more machinery for the same outcome. Revisit only if a customer needs to *forbid* server-side keys.
- **A distributed or cost-aware rate limit.** Codex is right that `eventsLimiter` is per-process and does not bound storage or worker cost, but that is a pre-existing property of every SDK route and its own piece of work. This plan stops claiming otherwise; it does not fix it.
- **A metrics counter for the exemption path.** A debug log is the proportionate move here; a real counter belongs with the metrics work.
- **#102 (idempotency key).** Same neighborhood, unrelated problem.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | FAIL → addressed | 12 findings (5 P1, 7 P2), 12/12 addressed |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | n/a (no UI) | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | — |

**CODEX:** Gate failed on 5 P1s, every one verified against the source before acceptance. The load-bearing catch: `EnforceOrigin` guards **8 routes**, not just `/events` (`grep -c` confirms), so the original plan would have relaxed replay and session-chunk endpoints with no rationale or tests. The plan now splits the middleware and scopes the exemption to `/events`, the only route `packages/sdk-python` posts to. Also fixed: `Header.Get` cannot distinguish an absent header from a present-but-empty one (verified with a Go probe: `Values()` length 0 vs 1), so the exemption now keys on presence; the "rate limits bound a stolen key's blast radius" claim was false and is retracted (`newRateLimiter` at `auth_handlers.go:35` is an in-memory per-process counter); the red/green sequence in the e2e task was unachievable as written and now builds the base image from a scratch worktree; `E2E_MIN_TESTS` is derived from `numTotalTests` rather than `vitest list | wc -l`; required-pattern pins moved from suite prefix to per-case; and a `packages/cli/` path that does not exist became `cli/`. One finding was accepted in part: a metrics counter for the bypass path is out of scope, replaced with a debug log and an explicit note.

**VERDICT:** Codex review CLEAR after revision. Eng review not run — not required by the user for this scope, and the plan's own risk (a security-control relaxation) was the specific thing Codex was pointed at.

NO UNRESOLVED DECISIONS
