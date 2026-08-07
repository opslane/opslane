# Browser SDK network timing capture

Date: 2026-08-06
Status: approved, not implemented

## Problem

The SDK reports what threw, never how long anything took. For timeout-class errors
that leaves the investigation agent unable to say anything about the request that
failed beyond its existence.

[PR #1297 on `conelike/asset-management-jira`][pr] is the worked example. A
`TimeoutError: signal timed out` from an `AbortSignal.timeout(FETCH_TIMEOUT)`
produced a fix that raised the constant from 10s to 30s in three files. The PR was
closed unmerged.

The agent had a minified stack, breadcrumbs, and nothing else. The PR body records
`Visual replay analysis not available` and `Signals not available`. The fetch
breadcrumb carries method, URL, and the error message, but no elapsed time
(`network.ts:96-107`), so nothing in the payload established even that the request
ran to the full deadline. Raising the constant was the only action the available
evidence supported.

[pr]: https://github.com/conelike/asset-management-jira/pull/1297

## What this can and cannot establish

**Can:** which request failed, how long it actually ran, whether response headers
were ever received, and what else was in flight alongside it.

**Cannot:** whether the server received the request. Patch-point instrumentation
observes only what the browser observes, and once a timeout aborts a request the
browser cannot see a later response. Sibling requests completing quickly is
circumstantial evidence for a single slow endpoint, not proof — service workers,
cache hits, CORS preflights, client-side cancellation, connection-pool contention,
and per-request payload size all remain live alternatives.

The payoff is therefore bounded and worth stating as such: it supplies the failing
URL, its observed duration, whether headers arrived, and overlapping request
context — enough to rule out unsupported timeout-constant changes and to raise a
more precise `needs_human` incident. Any downstream `unfixable_infra` verdict is a
confidence-weighted inference from that evidence, not a verdict the data proves.

## What exists today

`packages/sdk/src/network.ts` already brackets every fetch and XHR, but records no
timing on the error path.

`request_start` / `request_end` telemetry with timestamps does exist
(`telemetry.ts:7-8`), but it rides inside the rrweb replay stream
(`shared/src/types.ts:353-357`) and reaches the agent only when replay analysis
succeeds. On PR #1297 it did not. Timing stored somewhere the error event does not
reach is equivalent to timing not stored.

## Prior art

| | Capture | Where it lands |
| --- | --- | --- |
| Sentry | Patches fetch/XHR into `http.client` spans; `enableHTTPTimings` merges Resource Timing | Performance product. Error breadcrumbs carry only method/url/status |
| PostHog | Wraps fetch/XHR plus `PerformanceObserver` | Session replay blobs; their docs state it is not queryable |
| Highlight | OpenTelemetry browser auto-instrumentation | Traces product, linked to sessions |

All three separate timing from the error, because their consumer is a human who can
open the error and click across to the performance view. Opslane's consumer is an
agent with one prompt and no ability to pivot. That difference is the reason this
design puts timing on the error event.

## Decisions

**Capture is error-attached, not continuous.** A bounded in-memory buffer that
leaves the browser only as part of an error event. No new always-on upload path, no
new ingest volume. The wire shape is designed so aggregate rollups can be added
later without a contract break.

**No `traceparent` propagation in v1.** Adding a header to a cross-origin request
forces a CORS preflight, so an SDK upgrade could start failing requests that worked
the day before — the worst available failure mode for an error monitor. It also
requires the customer to have backend tracing before it returns anything. Separate
slice, separately justified.

**Network timing only.** No longtask observer, no JS self-profiling.

**Patch-point wall clock is the spine; Resource Timing is not used in v1.** For
cross-origin requests without `Timing-Allow-Origin`, `PerformanceResourceTiming`
zeroes `domainLookupStart`, `connectStart`, `secureConnectionStart`, `requestStart`,
and `responseStart` ([MDN][mdn]) — precisely the fields that would otherwise
separate a slow server from a connection that never established, and precisely the
requests Opslane sees are cross-origin. Merging it stays available as a later seam.

[mdn]: https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming

## Scope

In scope: `packages/sdk/src/network.ts` capture and retention, `core.ts` payload
attachment, `index.ts` teardown, `shared/src/types.ts`, ingestion migration and
sanitization, `packages/ingestion/masking`, `docs/contracts/events.md`, fixtures.

Out of scope, deferred to a follow-up PR: `worker/src/db.ts` event select,
`pipeline.ts` threading, prompt sections in `investigate.ts` and `agent-fix.ts`, and
any triage behavior change.

**This PR changes no diagnosis behavior.** The column is written and read by nothing
until the follow-up lands. The migration carries a comment saying so, and the PR
description must say so, or it will be misread as a fix for the PR #1297 class.

## Wire shape

```ts
export interface NetworkTiming {
  transport: 'fetch' | 'xhr';
  method: string;
  url: string;
  started_at_ms: number;
  duration_ms: number;
  ttfb_ms?: number;
  outcome: 'ok' | 'http_error' | 'timeout' | 'abort' | 'network_error' | 'in_flight';
  status?: number;
}
```

New optional top-level field on `ErrorEventPayload`:

```ts
network_timings?: NetworkTiming[];
```

`buildPayload` **omits the field entirely when the buffer is empty**, rather than
emitting `[]`. The minimal fixture encodes that.

The SDK sends the scrubbed raw URL, not a templated route. `/api/assets/12345`
aggregates badly, but baking templating rules into a released SDK makes them
unfixable — customers upgrade on their own schedule, while server-side templating
can be corrected on any deploy. Grouping for a future aggregate slice is therefore
deferred work rather than free.

### Timing milestones

`fetch()` resolves when response **headers** arrive; XHR `loadend` fires after the
transfer completes or fails. Recording one number from both would compare unlike
things, and the concurrency comparison is the main signal this feature produces.

So two milestones are recorded, and only one of them is comparable:

- **`ttfb_ms` — time to response headers. This is the cross-transport comparable
  field.** For fetch, the moment the promise resolves. For XHR, a `readystatechange`
  listener firing at `readyState === 2` (`HEADERS_RECEIVED`). Absent when the
  request terminated before any headers arrived.
- **`duration_ms` — start to terminal event.** For fetch, promise settle. For XHR,
  the first of `load`/`timeout`/`abort`/`error`. Transport-dependent by
  construction, which is why `transport` is on the wire.

Both elapsed values are clamped in the SDK to the same 600000 ms ceiling ingestion
enforces, so the SDK never emits a value the server will drop. A stored 600000
therefore means "at least ten minutes", not "exactly ten minutes".

`ttfb_ms` absent on a `timeout` means no headers ever arrived. `ttfb_ms` present on
a `timeout` means the server responded and the body stalled. That distinction is the
one piece of phase information that survives cross-origin without
`Timing-Allow-Origin`.

**Known limitation:** for fetch, `duration_ms` never includes the body phase.
A response whose headers arrive in 200ms and whose body hangs for 10s records as
`ok` with `duration_ms: 200`, and a later `response.json()` abort is invisible to
this patch. Instrumenting it means wrapping `response.body`, which risks altering
stream semantics in customer code. Out of scope for v1 and documented as such.

`started_at_ms` is `Date.now()`, an absolute timestamp correlatable with
breadcrumbs. All elapsed values are computed from `performance.now()` deltas,
because `Date.now()` can jump backwards on NTP correction or on a laptop waking
from sleep, producing negative or inflated durations on exactly the long-running
requests that matter. Existing telemetry uses `Date.now()` for both; that is not
changed here, only not copied.

### Outcome matrix

Fetch:

| Condition | `outcome` | `status` |
| --- | --- | --- |
| resolves, `response.type` is `opaque` or `opaqueredirect` | `ok` | omitted |
| resolves, `status >= 400` | `http_error` | recorded |
| resolves otherwise | `ok` | recorded |
| rejects, `err.name === 'TimeoutError'` | `timeout` | omitted |
| rejects, `err.name === 'AbortError'` | `abort` | omitted |
| rejects otherwise | `network_error` | omitted |

The opaque row matters: a successfully-resolved opaque response reports `status: 0`
and `response.ok === false`, so classifying on `ok` alone would report a working
cross-origin request as an HTTP error, and storing `0` would fail the status
validation below.

XHR, which has mutually exclusive terminal events that `loadend` alone does not
distinguish:

| Event | `outcome` | `status` |
| --- | --- | --- |
| `load`, `status >= 400` | `http_error` | recorded |
| `load` otherwise | `ok` | recorded |
| `timeout` | `timeout` | omitted |
| `abort` | `abort` | omitted |
| `error` | `network_error` | omitted |

`loadend` fires after every one of those, so finalization is guarded to **run at
most once per request**; the first terminal event wins. A `loadend` listener is
still registered as a fallback classifying `network_error`, so a request reaching
`loadend` with no terminal event is recorded rather than leaking as permanently
in-flight; in the normal case it is a no-op. A synchronous throw from `send()`
removes the in-flight record entirely and rethrows unchanged.

A successful non-HTTP XHR (`file://`, some extension schemes) reports `status 0`,
which falls outside the storable range, so `status` is omitted rather than sent and
discarded.

`in_flight` is not produced by either matrix. It is assigned at snapshot time to
records that have not finalized, with `duration_ms` set to elapsed-so-far. Without
those entries the buffer records only completions and the concurrency signal is
lost.

## Retention

A single FIFO buffer would evict the record this feature exists to capture: a
request open for 30s becomes the oldest entry while shorter requests start and
finish around it, so twenty subsequent requests drop it before its timeout ever
fires.

Two internal collections instead, behind one exported `snapshotNetworkTimings()`:

- an **active registry** of in-flight requests, keyed per request;
- a **ring of the 20 most recent completions**.

Snapshot policy, capped at 20 entries total:

1. Take active requests first, **longest-running first** (ascending
   `started_at_ms`). The request open for 10s is the one being diagnosed; newest-first
   would discard it.
2. Fill the remaining allowance with the newest completions.

If more than 20 requests are concurrently active, step 1 consumes the whole
allowance and no completions are included. That is the correct trade for this
feature, and the resulting snapshot is still ordered longest-running first.

The active registry is bounded by the same cap, and at capacity it **refuses the
new request** rather than evicting an existing one. Evicting the newest and then
inserting an even newer record would keep the arrival that just displaced its
predecessor — the exact inversion of the policy. Refusing keeps the oldest 20,
which are the long-running requests being diagnosed. Entries are removed from the
registry on finalization.

`buildPayload` (`core.ts:65`) takes a snapshot; neither collection is cleared
afterwards, so a second error in the same session still carries preceding request
history.

Request handles are never reissued, including across `clearNetworkTimings()`.
`unpatchFetch`/`unpatchXHR` cannot cancel a request that is already awaiting
(`network.ts:70`) or detach listeners already registered, so a callback from before
`destroy()` can fire after re-init. Were handles to restart at zero, that stale
callback would finalize an unrelated new request holding the reused handle.

`destroy()` (`index.ts:53`) clears both collections via a `safeCall`, alongside the
existing `clearBreadcrumbs`. Without it, request history survives across
reinitialization and can leak requests captured under one project configuration into
an event sent under another.

## SDK safety

`url` is passed through the existing `scrubUrl` (`scrub.ts:6`), which strips query
strings, userinfo, and token-bearing fragments. Requests to the SDK's own endpoint
are excluded by the existing `isSdkEndpoint` check.

The SDK applies the same caps as ingestion — `url` truncated to 2048 bytes, `method`
to 16 — because ingestion reads the body under a 1 MiB `MaxBytesReader`
(`error_event.go:51`). An oversized value would push the event past that limit and
be rejected before the sanitizer ever ran, contradicting the guarantee that
malformed timing data never fails an event.

No request headers and no bodies. PostHog captures both and needs a header deny-list
plus payload redaction to do it safely. Capturing neither means this slice adds no
new privacy surface beyond URLs, which are already captured and already scrubbed.

Every buffer write is wrapped in `try {} catch {}`, matching every sibling in
`network.ts`. The SDK must never throw into a customer's app.

## Ingestion

Migration `033_event_network_timings.sql` follows `028_event_debug_meta.sql`: a
JSONB column defaulting to `'[]'::jsonb`, with a `NOT VALID` type check validated in
a second statement.

Sanitization in `handler/error_event.go` mirrors `sanitizeDebugMeta`
(`error_event.go:304`):

- a non-array container becomes `[]`;
- non-object entries are dropped;
- at most 20 entries retained, in first-seen order;
- `transport` must be `fetch` or `xhr`;
- `method` must match `^[A-Z0-9._-]{1,16}$` after upper-casing — punctuation is
  permitted because real methods carry it and because a 16-byte SDK truncation can
  clip one mid-token;
- `url` must be 1–2048 bytes and free of control characters;
- `started_at_ms`, `duration_ms`, and `ttfb_ms` must be finite and non-negative,
  with elapsed values at most 600000 (ten minutes), above which the entry is
  dropped rather than clamped;
- `status`, when present, must be an integer in 100–599;
- `outcome` must be one of the six known values;
- discards increment a counter with a reason label, as `RecordDebugMetaDiscard`
  does.

Malformed timing data never fails an event — the guarantee that already governs
`debug_meta`.

**Server-side redaction is independent of the SDK.** The official SDK scrubs URLs,
but ingestion accepts payloads from arbitrary and older clients, so shape validation
alone would persist unsanitized URLs. `masking.RedactURL` (`masking.go:100`) exists
but deliberately preserves non-sensitive query parameters, leaving it weaker than
the SDK's `scrubUrl`. Add a stricter `masking.RedactRequestURL` in that package: drop
userinfo, drop the query string entirely, drop token-bearing fragments, and fall
back to `RedactURL` when the value does not parse. Applied to every retained entry.

## Testing

SDK unit tests:

- duration and `ttfb_ms` recorded on fetch success;
- `TimeoutError` classifies `timeout` with `ttfb_ms` absent;
- `AbortError` classifies `abort`; other rejections classify `network_error`;
- opaque fetch response classifies `ok` with `status` omitted, not `http_error`;
- every XHR terminal event maps per the matrix, and `loadend` after each does not
  double-finalize;
- XHR `ttfb_ms` recorded from `readyState === 2`;
- a synchronous `send()` throw removes the record and rethrows unchanged;
- in-flight requests snapshot with elapsed time;
- **one long-running active request survives 20 subsequent completions**, the
  regression the retention design exists to prevent;
- more than 20 concurrently-active requests fill the snapshot with actives, ordered
  longest-running first;
- `scrubUrl` applied; URL and method truncated at the caps; SDK endpoint excluded;
- `destroy()` clears history, and a re-`init()` event carries none of it;
- the field is omitted, not `[]`, when the buffer is empty.

Real-browser contract test covering capture, confirmed to **execute rather than
skip** per `packages/sdk/AGENTS.md`.

Wire contract: add `test-fixtures/wire/events/v4.1.0-minimal.json` (field omitted)
and `v4.1.0-full.json` (field populated), bump `packages/sdk/package.json` from
`4.0.0` to `4.1.0`, and bump `WIRE_FIXTURE_VERSION` at
`packages/sdk/src/__tests__/wire-shape.test.ts:20` to `4.1.0`.
`wire_compat_test.go` replays every fixture including the new pair. No existing
fixture is edited or deleted.

That constant currently reads `3.0.0` against a `4.0.0` package. `docs/contracts/
events.md:17` requires a fixture pair for **every** released SDK version, so that
gap is pre-existing repository debt, not an intended invariant — this spec adds the
`4.1.0` pair it introduces and does not attempt to backfill `4.0.0`.

Go tests: sanitizer rejection for each malformed shape above, and
`RedactRequestURL` stripping userinfo, query strings, and token fragments from
URLs an unofficial client could send.

Live smoke per root `AGENTS.md`: apply migrations, seed, rebuild ingestion, drive a
browser fixture that issues a request which times out, POST the event to
`$INGESTION_URL/api/v1/events`, and assert the stored `network_timings` contains the
timed-out entry with a plausible duration, `outcome: "timeout"`, and `ttfb_ms`
absent. Export the worktree port block as a unit, and confirm `go test ./...`
reports **zero** skips — a storage misconfiguration reports `ok` while ~30 tests
never run.

## What this does not deliver

No improvement in diagnosis quality; that arrives only when the follow-up PR reads
the column into the agent prompt, and even then as better-evidenced inference rather
than proof.

Also not delivered: whether the server received a request, fetch body-phase timing,
backend correlation, aggregate latency history, main-thread blocking, and page load
timing.
