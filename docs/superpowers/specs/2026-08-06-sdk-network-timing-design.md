# Browser SDK network timing capture

Date: 2026-08-06
Status: approved, not implemented

## Problem

The SDK reports what threw, never how long anything took. For timeout-class errors
that leaves the investigation agent with no way to reach a root cause.

[PR #1297 on `conelike/asset-management-jira`][pr] is the worked example. A
`TimeoutError: signal timed out` from an `AbortSignal.timeout(FETCH_TIMEOUT)`
produced a fix that raised the constant from 10s to 30s in three files. The PR was
closed unmerged.

The agent had a minified stack, breadcrumbs, and nothing else. The PR body records
`Visual replay analysis not available` and `Signals not available`. Nothing in the
payload distinguished:

- the server replied, just past the deadline;
- the server received the request and never replied;
- the request never left the browser.

Those have different fixes and only one of them is a timeout constant. Raising the
constant was the only action the available evidence supported.

[pr]: https://github.com/conelike/asset-management-jira/pull/1297

## What exists today

`packages/sdk/src/network.ts` already brackets every fetch and XHR. On rejection it
writes a breadcrumb carrying method, URL, and the error message — but no elapsed
time (`network.ts:96-107`).

`request_start` / `request_end` telemetry with timestamps does exist
(`telemetry.ts:7-8`), but it rides inside the rrweb replay stream
(`shared/src/types.ts:353-357`) and reaches the agent only when replay analysis
succeeds. On PR #1297 it did not.

So the timing was arguably collected and still could not be read. Storing it
somewhere the error event does not reach is equivalent to not storing it.

## Prior art

| | Capture | Where it lands |
| --- | --- | --- |
| Sentry | Patches fetch/XHR into `http.client` spans; `enableHTTPTimings` merges Resource Timing | Performance product. Error breadcrumbs carry only method/url/status |
| PostHog | Wraps fetch/XHR plus `PerformanceObserver` | Session replay blobs; their docs state it is not queryable |
| Highlight | OpenTelemetry browser auto-instrumentation | Traces product, linked to sessions |

All three separate timing from the error, because their consumer is a human who can
open the error and click across to the performance view. Opslane's consumer is an
agent with one prompt and no ability to pivot. That difference is the whole reason
this design puts timing on the error event.

Worth copying: Sentry's explicit origin allowlist for trace headers, and its
documented requirement that the customer's server send
`Access-Control-Allow-Headers` or the request breaks.

## Decisions

**Capture is error-attached, not continuous.** A bounded in-memory buffer that
leaves the browser only as part of an error event. No new always-on upload path, no
new ingest volume. The wire shape is designed so aggregate rollups can be added
later without a contract break.

**No `traceparent` propagation in v1.** Adding a header to a cross-origin request
forces a CORS preflight, so an SDK upgrade could start failing requests that worked
the day before — the worst available failure mode for an error monitor. It also
requires the customer to have backend tracing before it returns anything. Its value
is real but it lands on a subset of customers and carries the largest blast radius
in the SDK. Separate slice, separately justified.

**Network timing only.** No longtask observer, no JS self-profiling. One capture
mechanism, at patch points that already exist.

**Patch-point wall clock is the spine; Resource Timing is not used in v1.** For
cross-origin requests without `Timing-Allow-Origin`, `PerformanceResourceTiming`
zeroes `domainLookupStart`, `connectStart`, `secureConnectionStart`, `requestStart`,
and `responseStart` ([MDN][mdn]). Those are precisely the fields that would
otherwise separate "slow server" from "never connected", and precisely the requests
Opslane cares about are cross-origin. The phase breakdown Sentry advertises is
mostly zeros for B2B SaaS traffic. Merging it stays available as a later seam.

The discriminator that does survive cross-origin is **concurrency**: sibling
requests to the same origin completing in ~200ms while one sits at 10,002ms
identifies a single slow endpoint without any header cooperation. That signal is
free, and it is what the buffer is shaped to produce.

[mdn]: https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming

## Scope

In scope:

- `packages/sdk/src/network.ts` — timing capture and rolling buffer
- `packages/sdk/src/core.ts` — attach buffer snapshot to the payload
- `shared/src/types.ts` — `NetworkTiming` type, optional payload field
- `packages/ingestion` — migration, sanitization, storage
- `docs/contracts/events.md`, frozen fixture pair

Out of scope, deferred to a follow-up PR:

- `packages/worker/src/db.ts` event select
- `packages/worker/src/pipeline.ts` threading
- Prompt sections in `investigate.ts` and `agent-fix.ts`
- Any triage behavior change

**This PR changes no diagnosis behavior.** The column is written and read by
nothing until the follow-up lands. The migration carries a comment saying so, and
the PR description must say so, or it will be misread as a fix for the PR #1297
class of error.

## SDK capture

A module-local buffer in `network.ts`, hard-capped at 20 entries, **with no age
eviction**. This differs deliberately from breadcrumbs, whose 30s window
(`breadcrumbs.ts:5`) would discard a 30s timeout's own start record.

```ts
export interface NetworkTiming {
  method: string;
  url: string;
  start: number;
  duration_ms: number;
  outcome: 'ok' | 'http_error' | 'timeout' | 'abort' | 'network_error' | 'in_flight';
  status?: number;
}
```

`url` is passed through the existing `scrubUrl` (`scrub.ts:6`), which already strips
query strings, userinfo, and token-bearing fragments. Requests to the SDK's own
endpoint are excluded by the existing `isSdkEndpoint` check.

`outcome` is classified at the patch point from the rejection's `name`
(`TimeoutError` / `AbortError`), never inferred from duration. This is the field
that would have flipped PR #1297.

`in_flight` entries are snapshotted when the error fires, with `duration_ms` set to
elapsed-so-far. Without them the buffer records only completions, and the
concurrency signal — the main discriminator available cross-origin — is lost.

`start` is `Date.now()`, an absolute timestamp correlatable with breadcrumbs.
`duration_ms` is computed from `performance.now()` deltas, because `Date.now()` can
jump backwards on NTP correction or on a laptop waking from sleep, producing
negative or inflated durations on exactly the long-running requests that matter.
Existing telemetry uses `Date.now()` for both; that is not changed here, only not
copied.

No request headers and no bodies. PostHog captures both and needs a header
deny-list plus payload redaction to do it safely. Capturing neither means this
slice adds no new privacy surface beyond URLs, which are already captured and
already scrubbed.

`buildPayload` (`core.ts:65`) takes a copy of the buffer at error time. The buffer
is **not** cleared afterwards, so a second error in the same session still carries
the preceding request history; the count cap alone bounds it.

Every buffer write is wrapped in `try {} catch {}`, matching every sibling in
`network.ts`. The SDK must never throw into a customer's app.

## Wire and storage

New optional top-level field on `ErrorEventPayload`:

```ts
network_timings?: NetworkTiming[];
```

Append-only per `docs/contracts/events.md`: optional server-side, existing fixtures
unaffected, decoding stays tolerant of unknown fields.

The SDK sends the scrubbed raw URL, not a templated route. `/api/assets/12345`
aggregates badly, but baking templating rules into a released SDK makes them
unfixable — customers upgrade on their own schedule. Server-side templating can be
corrected on any deploy. The cost is that grouping for the future aggregate slice is
deferred work rather than free.

Migration `033_event_network_timings.sql` follows `028_event_debug_meta.sql`: a
JSONB column defaulting to `'[]'::jsonb`, with a `NOT VALID` type check validated in
a second statement.

Sanitization in `handler/error_event.go` mirrors `sanitizeDebugMeta`
(`error_event.go:304`):

- a non-array container becomes `[]`;
- non-object entries are dropped;
- at most 20 entries retained, in first-seen order;
- `url` must be 1–2048 bytes and free of control characters;
- `start` and `duration_ms` must be finite and non-negative, and `duration_ms` at
  most 600000 (ten minutes), above which the entry is dropped rather than clamped;
- `status`, when present, must be an integer in 100–599;
- `outcome` must be one of the six known values;
- discards increment a counter with a reason label, as `RecordDebugMetaDiscard` does.

Malformed timing data never fails an event. This is the same guarantee that already
governs `debug_meta`, and it matters more here because the data is advisory.

## Testing

SDK unit tests: duration is recorded on success and failure; a `TimeoutError`
classifies as `timeout`; in-flight requests are snapshotted with elapsed time; the
buffer caps at 20 and drops oldest; `scrubUrl` is applied; the SDK's own endpoint is
excluded.

Real-browser contract test covering capture, confirmed to **execute rather than
skip** per `packages/sdk/AGENTS.md`.

Wire contract: add `test-fixtures/wire/events/v4.1.0-minimal.json` (field omitted)
and `v4.1.0-full.json` (field populated), and bump `WIRE_FIXTURE_VERSION` at
`packages/sdk/src/__tests__/wire-shape.test.ts:20` from `3.0.0` to `4.1.0`. That
constant tracks wire-shape changes rather than releases, which is why it currently
lags the package version. Bump `packages/sdk/package.json` from `4.0.0` to `4.1.0`.
`wire_compat_test.go` replays every fixture including the new pair. No existing
fixture is edited or deleted.

Go sanitizer tests for each malformed shape above.

Live smoke per root `AGENTS.md`: apply migrations, seed, rebuild ingestion, drive a
browser fixture that issues a request which times out, POST the event to
`$INGESTION_URL/api/v1/events`, and assert the stored `network_timings` contains the
timed-out entry with a plausible duration and `outcome: "timeout"`. Export the
worktree port block as a unit, and confirm `go test ./...` reports **zero** skips —
a storage misconfiguration reports `ok` while ~30 tests never run.

## What this does not deliver

No improvement in diagnosis quality. That arrives only when the follow-up PR reads
the column into the agent prompt. The likely payoff there is narrower than better
fixes: given sibling requests returning in 200ms while one hangs at 10s, the correct
triage verdict for the PR #1297 class is `unfixable_infra` — an incident naming the
slow endpoint, rather than a PR raising a constant. The reason code already exists
and already carries a remediation string.

Also not delivered: backend correlation, aggregate latency history, main-thread
blocking, and page load timing.
