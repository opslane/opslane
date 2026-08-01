<!-- /autoplan restore point: /Users/abhishekray/.gstack/projects/opslane-opslane-oss/abhishekray07-s2a-carry-debug-ids-from-vite-builds-into-error-autoplan-restore-20260730-065802.md -->

# S2a: carry debug IDs from Vite builds into error events

**Issue:** [#224](https://github.com/opslane/opslane-oss/issues/224) · **Blocked by:** #216 (frozen contracts, merged as `0c0dcfe`)
**Governing contracts:** [S0 appendix](../design/2026-07-29-keys-sourcemaps-s0-contracts.md) §5, §6, §12 · [design doc](../design/2026-07-29-keys-sourcemaps-onboarding.md) §5.2, §5.3
**Status:** reviewed by /autoplan (CEO, Eng, DX). Premise gate: implement S0 as frozen; strategic challenges filed separately.

## 1. What this slice does

Stamp every Vite-built chunk with a deterministic debug ID, carry that ID from the
browser into the stored error event, and prove the ID is identical in TypeScript
and Go.

In scope:

- The debug-ID algorithm in both languages, driven by one shared vector file.
- Vite plugin: compute the ID from the map, stamp the map, stamp the JS, register the
  ID at runtime, detect the commit SHA.
- Browser SDK: turn the runtime registry into `debug_meta.images` on the outgoing event.
- Ingestion: accept, validate, and persist `debug_meta` and `commit_sha`.
- New frozen wire fixtures `v2.1.0-minimal.json` / `v2.1.0-full.json`, plus the
  `docs/contracts/events.md` section that documents them.

Explicitly not in scope (later slices):

- Uploading or storing maps, the batch API, map custody, the encrypted spill path (S2b).
- Worker symbolication, per-event resolution status, source excerpt cache (S3).
- Issue banner, settings card (S4/S5).
- Onboarding wiring of the plugin (S7).
- Key scopes; `OPSLANE_SK` does not yet exist server-side (S1, in flight on
  `abhishekray07/s1-create-separate-public-and-source-map-keys`).

### NOT in scope — deferred with reasons

| Item | Why deferred | Where it lives |
|---|---|---|
| Measure minified-vs-resolved fix-rate uplift on the eval corpus, and set a kill criterion for S4-S7 | Both CEO voices agree the program's premise is unmeasured. The user chose to implement S0 as frozen and track this separately. Every `eval/cases/*/case.json` ships a pre-symbolicated dev-mode stack, so the corpus cannot currently measure the failure mode this program fixes. | New issue against the design |
| Generate maps in the worker's existing E2B sandbox instead of uploading them | Would delete the upload API, the `sk` key class, and the custody chapter. Real reframe, but it reopens #216. | New issue against the design |
| Make `sourcesContent` optional and read source from the repo checkout | Same: reopens S0 §6's accepted-map shape. It is the single requirement generating the 29.6 MB/build volume and the custody risk the design's own §10 calls the most dangerous open item. | New issue against the design |
| Post-symbolication regrouping | Grouping runs pre-symbolication, so one bug fragments across builds. Known and deferred in the design's risk table. | New issue against the design |
| Consume a pre-existing `//# debugId` stamped by `@sentry/vite-plugin` | Contract-incompatible: S0 §6 requires the claimed ID to equal the server's recomputed ID, so a random Sentry UUID always returns `409 debug_id_mismatch`. Attractive as a zero-build-change wedge, but it needs a contract change first. | TODOS.md |
| Store debug IDs as `BYTEA(16)` or `TEXT` instead of `uuid` | S0 §6.2 froze `uuid` and proved PostgreSQL 16.14 preserves the raw bits. Changing it now buys nothing this slice needs. | Rejected, recorded here |
| Bundlers other than Vite | Design §2 non-goal. But see the core-location decision in §3.1: the algorithm does not live inside the Vite adapter, so the second adapter is a new file, not a fork. | Design non-goal |

## 2. What already exists

| Sub-problem | Existing code | Verdict |
|---|---|---|
| Vite plugin skeleton, `sourcemap: 'hidden'`, map collection from `generateBundle` | `packages/sdk/vite-plugin/index.ts:18-104` | Rewrite the body. Keep the plugin name, `apply: 'build'`, `enforce: 'post'`, the `config()` hook, and the map-removal behavior at `:53` |
| Event payload construction | `packages/sdk/src/core.ts:62-95` (`buildPayload`) | Extend with two optional fields |
| Shared wire type | `shared/src/types.ts:39-72` (`ErrorEventPayload`) | Add `commit_sha?`, `debug_meta?` |
| Server event decode + validate | `packages/ingestion/handler/error_event.go:60-148` | Add two fields plus a validation pass |
| Stack-frame parsing (worker side) | `packages/worker/src/sourcemap.ts:29-48` (`parseStackFrames`) | **V8-only** (`at ...` forms). Do not reuse for the browser; the SDK needs Firefox/WebKit `fn@url` shapes too. Noted for S3 |
| Wire fixture enforcement, both directions | `wire-shape.test.ts`, `wire_compat_test.go`, `.github/workflows/wire-fixtures.yml` | Reuse unchanged; add a fixture pair |
| Real-browser capture harness | `packages/sdk/src/__tests__/browser-contract.test.ts` | Playwright, **chromium only** (`ci.yml:242`, `:321`). Extend to firefox + webkit |
| Fixture app to build | `test-fixtures/vue-app` (Vite 6, Vue 3) | Reuse. `vite.config.ts:8` passes the old options object, so it changes with the plugin |
| Ingest metrics counters | `packages/ingestion/handler/metrics.go` | Add discard + coverage counters |

Nothing in the repo canonicalizes JSON per RFC 8785 today, in either language.

## 3. Design

### 3.1 The debug-ID algorithm (R1)

Frozen by S0 §6:

```text
parse strict UTF-8 JSON -> require root object, reject BOM, invalid UTF-8,
duplicate keys, nesting > 64 -> delete root "debugId" -> RFC 8785 canonical JSON
-> SHA-256 -> bytes 0..15 as lowercase 8-4-4-4-12 -> keep the full 32 bytes as
content_sha256
```

No UUID version or variant bits are rewritten.

**Why canonicalize rather than digest raw bytes.** Reviewed and kept. The plugin writes
`debugId` into the map *after* computing the ID, and the server re-serializes the JSON
it receives. A raw-byte digest breaks under both. Removing one named member from a
canonical form is what makes the ID survive stamping and a JSON round trip. Poison
detection is a side benefit, not the reason.

**Core location.** `packages/sdk/src/build/debug-id.ts` (MIT), imported by
`vite-plugin/index.ts`. Design §2 calls the core bundler-neutral, so it does not live
inside the Vite adapter.

**Node builtins must not reach the browser bundle.** `packages/sdk/vite.config.ts:14-27`
builds `index`, `react`, and `vite-plugin` in one browser-targeted lib build whose only
externals are the framework packages, and `dts` includes `src/**/*.ts`. A `node:crypto`
import would be stubbed into something that throws inside the customer's build. Use
`crypto.subtle.digest` (a global in Node 18+ and every target browser), which makes the
hash async and therefore `generateBundle` async. Add a packaging assertion next to
`check:package` that `dist/index.js` contains no `node:` import.

#### Canonicalization is not "sort keys and stringify" — measured

The original draft budgeted "roughly 40 lines, no dependency." That is wrong, and two
independent reviews plus a direct check proved it:

```
node -e '...'  ->  JS own-key order for ["10","2","a","A"]  ==  ["2","10","a","A"]
                   sorted-then-stringify                     ==  {"2":..,"10":..,"A":..,"a":..}
                   JCS requires                              ==  {"10":..,"2":..,"A":..,"a":..}
```

JavaScript hoists integer-like keys ahead of string keys in own-property order, so
building a sorted object and calling `JSON.stringify` produces the wrong byte order. It
also mishandles `__proto__`. And `JSON.parse` cannot detect duplicate keys at all: per
ECMA-262 it builds the object with `CreateDataProperty` (last wins) and only then walks
surviving properties, so a reviver never sees the shadowed member. Escape-equivalent
duplicates (`"a"` vs `"\u0061"`) are invisible for the same reason.

The TypeScript side therefore needs:

- a lexical pre-pass over the **raw bytes**: fatal UTF-8 decode, BOM rejection,
  trailing-data rejection, duplicate-key detection after unescaping, depth counting;
- manual member emission after sorting keys by UTF-16 code unit, never relying on
  object property order;
- explicit rejection of lone surrogates and non-finite numbers (`1e400` parses to
  `Infinity` in JS and `JSON.stringify`s to `null`, while Go returns a range error).

Rejecting lone surrogates and non-finite numbers is defensible under S0 §6 step 2's
existing "reject invalid UTF-8" clause, and it is the only way the two languages can
agree. Both are written into the plan as explicit algorithm steps and into the vector
file as expected-reject cases.

**Go** (`packages/ingestion/debugid/`, AGPL-3.0-only): `github.com/gowebpki/jcs`
(Apache-2.0) for canonical output, with the same raw-byte pre-pass via `json.Decoder`
token streaming. Verify license and maintenance before adding.

#### The parity harness (R1)

`test-fixtures/debug-id/vectors.json` stores **raw input bytes as base64**, not JSON
objects. A JSON object literally cannot express a duplicate key, a BOM, or invalid
UTF-8, so an object-shaped fixture cannot encode the cases the algorithm must reject.

Each case is either:

- success: `canonical` (base64), `sha256`, `debug_id`;
- failure: one of `invalid_utf8 | bom | duplicate_key | invalid_unicode |
  depth_exceeded | non_finite_number | trailing_data`.

It carries the three S0 §6.1 vectors verbatim, the stamped-map rehash-stability case,
the poisoned-map mismatch case, and roughly 500 generated adversarial cases.

**The oracle is independent.** Expected canonical bytes come from a pinned third-party
JCS implementation validated against the official RFC 8785 test vectors, not from
either of our two implementations. Generating expectations from our own code makes one
suite tautological and hides the bug both would share.

**PostgreSQL bit-preservation:** an ingestion integration test inserts
`158399f3-1dad-1386-35b2-98c34317d52e` into a `uuid` column and compares the returned
text exactly, using a temporary table inside its transaction (S2a has no permanent
debug-ID column). S2b's migration test inherits the vector against the real columns.

### 3.2 Vite plugin (R2)

Every claim below was checked against Vite 6.4.3, 7.3.6, and 8.1.5 with a throwaway
probe. Results:

| Question | Answer |
|---|---|
| Does `chunk.code` mutated in `generateBundle` reach disk? | Yes, all three majors |
| Is the content hash recomputed after that mutation? | **No** |
| Does a prelude without a `mappings` shift still resolve? | **No — it silently resolves to the wrong source line** |
| Does prepending `;` to `mappings` restore correctness? | Yes |
| Does mutating `chunk.map` change the emitted `.map`? | **No — the `.map` asset's `source` string is authoritative** |
| Does the map carry a root `file`? | Yes: the content-hashed JS filename |

**The `.map` asset is the authoritative artifact.** `chunk.map.toString()` equals
`bundle[key + '.map'].source` on entry, but only the asset's `source` is written. Hash
`chunk.map` and ship the asset and the server's recomputed ID will not match. Every
step below operates on the asset.

**The registration snippet is a prelude, not a footer.** A footer never executes when
the module throws during evaluation, and a lazy chunk that throws on initialization is
exactly the case debug IDs exist for.

Per chunk that has a paired `.map` asset:

1. Parse `asset.source` (accept `string` and `Uint8Array`).
2. Insert the prelude **after any directive prologue or shebang**, not at byte 0.
   Prepending ahead of `'use strict';` demotes it to an ordinary expression and
   silently disables strict mode for the chunk.
3. Prepend one `;` to `mappings` **per inserted line** — shift by the number of lines
   actually inserted, never a hard-coded one.
4. Compute `debug_id` and `content_sha256` from that corrected map object.
5. Substitute the real ID for the 36-character placeholder. Identical length, so the
   JS byte count does not move and the map stays correct.
6. Set root `debugId` on the map (excluded from the hash) and serialize back to
   `asset.source`.
7. Append `//# debugId=<id>` at the end of the chunk. Appending shifts nothing.

**Output format decides the prelude, and getting it wrong ships a dead app.**
`import.meta` is a syntax error in `iife`, `umd`, `cjs`, and `system` — precisely what
`@vitejs/plugin-legacy` and `build.lib` emit. "The plugin never fails the build" does
not save this: the build succeeds and the app is dead on load. Branch on
`outputOptions.format`:

| Format | Prelude key |
|---|---|
| `es` | `import.meta.url` |
| `iife`, `umd`, `cjs`, `system` | `document.currentScript && document.currentScript.src` |
| neither resolvable | skip the chunk, count it, no prelude |

**The prelude ships verbatim.** esbuild transpiles in `renderChunk`, which runs before
`generateBundle`, so nothing downstream lowers the prelude. Pin it to ES5 syntax
(`var g=...;g.X=g.X||{};`), never `||=` or arrow functions, and assert in T6 that the
emitted prelude parses under the lowest supported `build.target`.

**Content hashing: why the prelude is safe and the commit SHA is not.** The hash is not
recomputed, so the filename covers the pre-mutation bytes. That is harmless only while
the mutation is a pure function of the chunk: same source produces the same map, the
same ID, the same prelude, and therefore the same final bytes, so
`filename <-> bytes` still holds. A commit SHA is **not** a function of the source, so
the same code on a new commit would keep its filename and change its bytes, and a CDN
would serve a mixture. The SHA is therefore injected through a hash-participating
`define`-style constant the SDK reads, evaluated in `transform` before hashing.

Two consequences to state plainly rather than discover later: any SRI or integrity
manifest computed before `generateBundle` will not match the emitted bytes (verify
whether the project or its consumers emit one), and because root `file` carries the
hashed filename and participates in the hash, an unrelated filename change moves the
debug ID even when `mappings` are identical.

**Source maps in S2a: deleted from the bundle, not written anywhere.** The plugin keeps
today's behavior (`vite-plugin/index.ts:53`) and removes `.map` assets from the output.
It does **not** write them to a temp directory. An earlier draft did, and it was wrong:
S0 §7.4 freezes spill files as AES-256-GCM ciphertext under a per-build in-memory key,
deleted on receipt, unreadable after the process exits. A plaintext temp file
containing full `sourcesContent`, with its path logged, is customer source code sitting
in a CI log or a Docker image layer. Implementing the encrypted spill correctly is
S2b's job, and half-implementing custody is worse than not starting.

This also dissolves the "never fail the build / never publish maps / never lose maps"
trilemma: with nothing written, there is no temp-write failure policy to get wrong, and
the design already states the next build regenerates maps rather than trusting a
cross-process cache.

The determinism test (R2) needs the map, so it passes an explicit
`__unsafeRetainMapsForTest` option. Not documented, not part of the public surface.

**Respecting an explicit `build.sourcemap`.** Removing `.map` assets unconditionally
breaks a customer who set `sourcemap: true`, because their chunks still carry
`//# sourceMappingURL=` pointing at a now-missing file:

| `build.sourcemap` | Behavior |
|---|---|
| unset | set `'hidden'`, stamp, remove `.map` assets |
| `'hidden'` | stamp, remove `.map` assets |
| `true` | stamp, **leave assets alone**, log once that Opslane did not remove them |
| `'inline'` | stamp the inline map, shift its mappings, log that inline maps ship to the CDN |
| `false` | no maps exist: no stamping, log once, exit 0 |

Also detect a peer debug-ID plugin (`@sentry/vite-plugin`) and log that two plugins will
stamp the same chunk.

**Commit SHA ladder:** `GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`,
`CI_COMMIT_SHA`, `COMMIT_REF`, then `.git/HEAD` and the referenced ref off disk. No
`git` binary. Omitted unless it resolves to 40 or 64 lowercase hex.

**Memory.** Canonicalizing means parse, sort, emit, per chunk, in Node, on maps the
design measures at 29.6 MB per build with a 12.13 MB largest single map. Peak resident
is a multiple of that. Process chunks sequentially, release references between them,
and skip-and-count any map above a guard well under S0's 100 MiB ceiling.

**Call signature.** `opslane()` takes zero arguments. `opslaneSourceMapPlugin(options)`
keeps its name **and its current upload behavior**, unchanged, so `2.1.0` is not a
silent breaking minor. Keeping the name while removing the upload would be a breaking
change wearing a compatible signature.

The plugin never fails the build.

### 3.3 Runtime discovery and SDK attachment (R3, R5)

**The registry is keyed by module URL, not by a stack string.** Vite emits ES modules,
so `import.meta.url` gives the chunk's own URL exactly, from the engine's own module
record: no parsing, and no dependence on `Error.stackTraceLimit`, an
`Error.prepareStackTrace` override, or engine stack truncation. Non-ESM formats fall
back to `document.currentScript.src` per the table in §3.2.

At capture time the SDK reads the registry and matches its keys against URLs in the
captured stack. Engine shapes still need parsing to get URLs *out of the error's stack*,
so the matrix stands, but it no longer decides whether registration works at all:

| Shape | Example frame |
|---|---|
| V8 / Chrome, Edge | `    at https://host/assets/index-BpTz.js:1:234` |
| V8 named | `    at fn (https://host/assets/index-BpTz.js:1:234)` |
| Firefox | `fn@https://host/assets/index-BpTz.js:1:234` |
| Firefox anonymous | `@https://host/assets/index-BpTz.js:1:234` |
| WebKit / Safari | `fn@https://...`, `global code@https://...` |
| eval-wrapped | `at eval (eval at fn (https://host/x.js:1:2))` -> innermost real URL |
| Unparseable | no URL found -> frame skipped, never guessed |

Note `packages/worker/src/sourcemap.ts:29-48` parses V8 forms only. It is not reusable
here, and S3 will need the same widening.

**Two SDK-side hazards found in the existing capture path:**

- `core.ts:145-152` appends `--- synthetic caller stack ---` frames from a fresh
  `new Error()` whenever the real stack has no user frames. Those URLs point at the
  Opslane SDK chunk, so naive extraction attaches an image for our own bundle and burns
  an image slot on a chunk that can never resolve to customer code. Exclude the
  synthetic section from URL extraction.
- `buildPayload` runs before `scrubEvent` (`transport.ts:61`), and `scrub.ts:73` runs
  `scrubText` over `error.stack`. A frame URL rewritten by a secret pattern no longer
  exactly matches the `code_file` the worker joins on in S3. Assemble images after
  scrubbing, or assert in T10 that scrubbing never rewrites a matched `code_file`.

**Workers are scoped honestly, and narrower than the last draft claimed.** A worker has
its own `globalThis`, so the page SDK can never read a worker chunk's registry. Worse,
`core.ts:178` installs handlers with `window.addEventListener`, which does not exist in
a worker, so there is no automatic capture inside a worker at all today. The contract
for this slice:

- inside a worker, only an explicit `captureException` call attaches images, from that
  worker's own registry;
- a worker-origin frame captured by the *page* SDK yields **no image** — tested,
  counted, documented. Never a guessed one;
- automatic worker handlers are out of scope and named as such.

**Attachment rules, with the order fixed** (S0 §5 lists them but does not order them,
and order is observable): validate each entry's shape -> collapse exact
`(code_file, debug_id)` duplicates -> discard every entry for any `code_file` claiming
two different IDs, computed over the **whole** list -> take the first 64 in captured
stack order. Truncating first would let a conflicting entry at index 65 slip past the
ambiguity check, making stored metadata depend on submission order.

**Byte budget, not just an entry count.** `transport.ts:43` caps the unload payload at
60 KiB and `:207` always sends at least one event regardless of size. 64 images at
S0's 4096-byte `code_file` ceiling is 256 KiB, which the browser's keepalive quota
rejects, losing the event at the moment it matters most. Cap serialized `debug_meta`
size SDK-side and drop images past the budget.

**The one distinction that makes the mechanism-failure metric possible.** The SDK sends:

- `debug_meta` **omitted** when the registry was empty (no instrumented build);
- `debug_meta: {"images": []}` when the registry had entries but none matched the
  captured stack.

S0 §5 says omission and an empty array are semantically equivalent, so this stays inside
the frozen contract, while letting the server tell "not instrumented" from "instrumented
and the join is broken." Without it both cases look identical on the wire and the
counter in §3.4 cannot be computed at all.

**Cross-origin assets get their own test.** A CDN serving `assets/*` from a different
host than the document is the common production topology and the likeliest place the
registry key and the stack-frame URL disagree.

### 3.4 Server accept, validate, persist (R4)

**Decode both fields as `json.RawMessage`.** `error_event.go:60-81` decodes the whole
body with one `json.Unmarshal` into a typed struct and returns `400` on any error. Add
`CommitSHA string` or a typed `DebugMeta` and a payload carrying `"commit_sha": 123` or
`"debug_meta": []` fails the top-level unmarshal and **rejects the error event**,
violating S0 §5's "malformed optional metadata never rejects the error event." Use the
`json.RawMessage` pattern already applied to `Breadcrumbs`, `Context`, and `Runtime` at
`error_event.go:67-70`, then decode container and entries independently.

Migration `028_event_debug_meta.sql`, guarded. `scripts/run-migrations.sh:11-14` replays
every `.sql` on every boot under `ON_ERROR_STOP=1`, and
`db/migrations_test.go:170` (`TestMigrations_AreIdempotent`) enforces it. Unguarded
`ADD COLUMN` fails on the second run and aborts every later migration:

```sql
SET lock_timeout = '3s';

ALTER TABLE error_events
  ADD COLUMN IF NOT EXISTS debug_meta JSONB NOT NULL DEFAULT '{"images":[]}'::jsonb;
ALTER TABLE error_events
  ADD COLUMN IF NOT EXISTS commit_sha TEXT;

ALTER TABLE error_events
  DROP CONSTRAINT IF EXISTS error_events_debug_meta_object;
ALTER TABLE error_events
  ADD CONSTRAINT error_events_debug_meta_object
  CHECK (jsonb_typeof(debug_meta) = 'object') NOT VALID;
ALTER TABLE error_events
  DROP CONSTRAINT IF EXISTS error_events_commit_sha_hex;
ALTER TABLE error_events
  ADD CONSTRAINT error_events_commit_sha_hex
  CHECK (commit_sha IS NULL OR commit_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') NOT VALID;

ALTER TABLE error_events VALIDATE CONSTRAINT error_events_debug_meta_object;
ALTER TABLE error_events VALIDATE CONSTRAINT error_events_commit_sha_hex;
```

`lock_timeout` matters more than scan cost: `ADD COLUMN` holds ACCESS EXCLUSIVE only
briefly, but a queued AEL parks every subsequent read on `error_events` behind one long
transaction. Named constraints plus `DROP ... IF EXISTS` keep every statement
restart-safe. Rollout is migration first, then binary.

**Discard reasons, fixed and exhaustive**, with counting precedence in this order so a
malformed container is never miscounted as a bad ID:
`malformed_container | malformed_images | non_object_image | bad_type | bad_code_file |
bad_debug_id | ambiguous_code_file | over_limit`, plus `commit_sha_discarded`.

**Coverage metric.** `metrics.go:15-37` has only an unlabeled `eventsIngestedTotal`, so
`events_javascript_total` does not exist. Add a platform-labeled counter, then:

- coverage = `events_with_debug_images_total / events_javascript_total`;
- `debug_meta_registry_present_zero_matched_total` increments when `debug_meta` is
  present with an empty `images` array — the distinction §3.3 creates.

**Masking.** `error_event.go:208-209` runs the masking pass over breadcrumbs and context
before persistence precisely because client URLs carry tokens. `code_file` is a URL and
can carry a query string. Decide explicitly and test it: either strip query and fragment
on both sides (the SDK must strip identically, since the worker joins on exact match),
or store verbatim and document parity with `stack_trace_raw`. Recommendation: store
verbatim, matching `stack_trace_raw`, because a divergent strip silently breaks the join.

### 3.5 Developer-facing surface, release, and docs

Reviewed separately (Phase 3.5) because the first draft of this section was four
paragraphs against forty decisions of mechanism, and every DX finding lived in that gap.

#### Plugin API

`opslane(options?)`, every field optional, so the design's frozen zero-argument snippet
is unchanged and S2b is additive rather than a signature change on a minor:

| Option | Default | Why it exists |
|---|---|---|
| `commitSha?: string` | auto-detect | The ladder cannot cover every CI. An explicit override is the escape hatch; detection is a convenience over it, never a replacement |
| `stamp?: boolean` | `true` | The only way out of the SRI collision below without deleting the plugin |
| `logLevel?: 'silent' \| 'warn' \| 'debug'` | `warn` | Deliberate-configuration notices must be silenceable or they become nagware and train developers to ignore real errors |
| `sourcemaps?: 'remove' \| 'keep'` | `remove` | Replaces the `__unsafeRetainMapsForTest` back door the earlier draft invented for its own tests |

Exported as `opslaneVitePlugin`, matching `opslaneVuePlugin` and
`opslaneSourceMapPlugin`, with `export { opslaneVitePlugin as opslane }` so the frozen
snippet still reads `opslane()`. The legacy export keeps its name, its options, and its
upload behavior, and gains a TSDoc `@deprecated` naming its replacement.

**Subresource Integrity is a site-outage risk and needs a real escape hatch.** Rollup
does not recompute the content hash after `generateBundle` (measured), which is
harmless for the filename because the prelude is content-derived. It is *not* harmless
for anything that precomputed an integrity value: with `vite-plugin-sri`,
`rollup-plugin-sri`, or any framework emitting `integrity=`, every stamped chunk fails
its SRI check and the browser refuses to execute it. The site is blank, the plugin
never fails the build, and no error reaches Opslane because the page never runs. So:
detect known SRI plugins in `configResolved` and skip stamping with a loud log, honor
`stamp: false`, and document it under a "Known incompatibilities" heading.

#### Build output — the only thing a developer can see this slice

Every message the first draft specified fired on a problem, so a fully working build
was byte-identical in the console to one where the plugin never loaded. One summary
line at `closeBundle`, always, at `warn` level:

```text
[opslane] Stamped 248/251 chunks with debug IDs (3 skipped: 2 no map, 1 map over 32 MB).
[opslane] Commit 4f2a9c1 detected from GITHUB_SHA. Source maps: hidden, removed from output.
```

Every failure condition in the error registry gets a stable code
(`OPSLANE_VITE_MAP_TOO_LARGE`, `OPSLANE_VITE_NO_COMMIT_SHA`, `OPSLANE_VITE_SRI_DETECTED`,
...) so CI logs are searchable, plus a message carrying problem, one-clause cause,
imperative fix, and a stable docs anchor. The bar is the message being replaced
(`vite-plugin/index.ts:65-71`), which already does problem + consequence + two fixes.

The commit ladder gets an explicit `OPSLANE_COMMIT_SHA` rung first, then `GITHUB_SHA`,
`VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`, `CI_COMMIT_SHA`, `RENDER_GIT_COMMIT`,
`BITBUCKET_COMMIT`, `GIT_COMMIT` (Jenkins), `BUILD_SOURCEVERSION` (Azure), then `.git`
off disk. `COMMIT_REF` is dropped: several platforms use "ref" for a branch name, which
silently fails the hex check. Which rung won is always logged; "no log on failure" was
the wrong call for the single likeliest misconfiguration in the slice, especially for
Docker builds that copy source without `.git`.

`opslane doctor` gains a "Debug IDs" check that globs the build output, counts chunks
containing `//# debugId=`, and returns the existing `CheckResult` shape with a
remediation string. Ten lines against machinery that already exists, and it is the only
way a developer confirms this slice did anything.

#### Release: keep 2.0.1, and do not hand-bump

The earlier plan bumped `package.json` to `2.1.0` and added no changeset, believing that
holds the publish. **It does not.** Verified in the pinned implementation at
`node_modules/.pnpm/@changesets+cli@2.31.1/.../changesets-cli.cjs.js:1113`:

```js
if (!publishedVersions.includes(localVersion)) {
  packagesToPublish.push(pkgInfo);
  logger.info(`${name} is being published because our local version (${localVersion}) has not been published on npm`);
```

`release-npm.yml:74` runs `pnpm changeset publish`, which publishes any public local
version missing from npm regardless of how it got there. The hand-bump would have
shipped a stamp-only SDK to `latest`, with no Version Packages PR and no changelog
entry, and S2b's changeset would then have bumped from 2.1.0 and left the debug-ID
feature permanently unrecorded.

Instead: `package.json` stays at **2.0.1** for this slice. `wire-shape.test.ts:15-21`
keys fixture filenames off the package version, so that coupling is cut — the test
reads a `WIRE_FIXTURE_VERSION` constant. The `v2.1.0-*.json` pair is authored now
(R4 requires it), and S2b adds one real changeset so the Version Packages PR produces
2.1.0, its changelog, and the publish atomically.

`scripts/check-packed-packages.mjs:28` only probes the root `@opslane/sdk` entry, so it
would not catch a broken `@opslane/sdk/vite-plugin` export. Extend it to install Vite in
the clean consumer and run one minimal production build through both plugin exports.

#### Docs: eight stale surfaces, not one

S2a is deliberately dark, so it must **not** publish a setup snippet for an export that
`@opslane/sdk@2.0.1` does not have — that is a copy-paste example which installs fine
and then fails at import. `docs/guides/source-maps.md` gets a "what works today" table
(`opslaneSourceMapPlugin` uploads maps and stacks resolve; `opslane()` stamps and
resolution arrives later) and keeps recommending the legacy plugin until S2b.

T16 covers all of these, every one verified stale by the review:

| Surface | Why it goes stale |
|---|---|
| `packages/sdk/README.md:62-79` | Ships to npm; shows the old options snippet |
| `docs/install.md:21-35` | Still instructs `VITE_OPSLANE_RELEASE`, which design §5.3 says never needs to exist |
| `docs/guides/react.md`, `vue.md`, `vanilla.md` | All declare `covers: packages/sdk/vite-plugin/**`, so the docs-sync bot flags them the moment T5 lands |
| `docs/reference/sdk-options.md:9,22` | Does not distinguish `release` from auto-detected `commit_sha` |
| `docs/reference/environment-variables.md` | Omits the build-time detection ladder |
| `docs/guides/source-maps.md` | Documents the release contract this slice replaces |
| `scripts/docs-map.mjs:41-51` | `MANUAL_DOC_COVERS` for `docs/contracts/events.md` does not cover `debug-images.ts`, so the frozen wire contract is never flagged when image assembly changes |

A normative migration matrix goes in the guide and gets tests: legacy only, new only,
and both together (does running both double-stamp a chunk?), plus required ordering
relative to `@sentry/vite-plugin`.

Client-side image drops from the byte budget are logged under the SDK's existing
`debug: true` option, so a customer with long CDN URLs can see why coverage is partial.
The `registry_present_zero_matched` counter and the coverage ratio are operator-only in
this slice; the plan names the S4 settings surface that must route them to the customer,
so S4 inherits a defined requirement rather than an unrouted counter.

## 4. Architecture

```
  BUILD TIME (customer CI)                      RUNTIME (browser)
  ------------------------                      -----------------
  vite build
    |
    +- transform: define OPSLANE_COMMIT ----+       page loads chunk
    |    (participates in content hash)     |            |
    |                                       |            v
    +- renderChunk: esbuild target lower    |    prelude runs FIRST
    |    (prelude is NOT lowered here)      |    __OPSLANE_DEBUG_IDS__
    |                                       |      [import.meta.url] = id
    +- generateBundle (enforce: post)       |            |
         |                                  |            v
         +- pair chunk <-> .map ASSET       |     error thrown
         |    (asset.source authoritative)  |            |
         +- insert prelude after prologue   |            v
         +- shift mappings by N lines       |   buildPayload()
         +- hash corrected map -> debug_id  |     read registry
         +- substitute 36-char placeholder  |     parse stack URLs
         +- stamp map.debugId, reserialize  |     match exact code_file
         +- append //# debugId=             |     order/dedupe/ambiguity/64
         +- delete .map asset               |     byte budget
              (nothing written to disk)     |            |
                                            |            v
                                            +----> POST /api/v1/events
                                                        |
  packages/sdk/src/build/debug-id.ts   <----shared----+  |
         ^                                   vectors.json|
         |                                       |       v
  packages/ingestion/debugid/  <-----------------+   ingestErrorEvent
    (same vectors, independent oracle)               json.RawMessage
                                                     validateDebugMeta
                                                     -> error_events
                                                        .debug_meta JSONB
                                                        .commit_sha TEXT
```

Coupling notes: the only cross-language coupling is the vector file, which is why the
oracle must be a third implementation. The plugin depends on Rollup's `generateBundle`
mutation contract, which is unspecified public API — pinned by V0 across three majors
and re-asserted in T7 so a Vite upgrade cannot break it silently.

## 5. Task list

| # | Task | Files |
|---|---|---|
| V0 | **Blocking architecture proof**, not a spot check. Across Vite 6/7/8: the emitted map recomputes to the JS-embedded ID; the resolved position is correct at first, middle, and last generated positions; no SRI/manifest consumer disagrees with the emitted bytes; the root `file` coupling is understood and documented. Written decision criterion before running: if any major fails map-recomputes-to-ID, switch to `renderChunk` + magic-string and re-run the same proof. | scratch |
| T1 | Base64 raw-byte vector file with success and rejection outcomes, ~500 adversarial cases, generated against a pinned independent JCS oracle | `test-fixtures/debug-id/vectors.json`, generator script |
| T2 | TS raw-byte pre-pass (UTF-8, BOM, trailing data, duplicate keys post-unescape, depth), manual UTF-16-sorted member emission, `crypto.subtle` hashing | `packages/sdk/src/build/debug-id.ts` + tests |
| T3 | Go equivalent over the same vectors | `packages/ingestion/debugid/`, `go.mod` |
| T4 | PostgreSQL `uuid` bit-preservation integration test | `packages/ingestion/db/…_test.go` |
| T5 | Plugin rewrite: asset-source pipeline, format-branched prelude, prologue-safe insertion, N-line mappings shift, placeholder substitution, map stamp, `//# debugId`, asset deletion, `build.sourcemap` table, ES5 prelude, per-map memory guard, commit ladder + `define`, peer-plugin detection, legacy export preserved with its upload intact | `packages/sdk/vite-plugin/index.ts` |
| T6 | Plugin unit tests: one case per `build.sourcemap` value, one per output format (incl. the `import.meta` syntax guard), prologue/shebang preservation, ES5 parse under lowest target, never-throw, no `.map` in output, oversized-map skip | `packages/sdk/src/__tests__/vite-plugin.test.ts` |
| T7 | Determinism + integrity: build the fixture twice **from different working directories**, byte-diff, per-chunk ID equality, assert no `sources` entry is absolute or contains the build cwd, assert filename-vs-bytes identity, reopen the retained map and resolve first/middle/last positions | `packages/sdk/src/__tests__/…` |
| T8 | Shared types | `shared/src/types.ts` |
| T9 | SDK registry reader, URL extraction, image assembly, ordering rules, byte budget, synthetic-frame exclusion, empty-array-vs-omitted distinction. **Lands in the same commit as its `core.ts` import** | `packages/sdk/src/debug-images.ts`, `core.ts` |
| T10 | Engine-shape matrix, eval-wrapped, unparseable, max-length `code_file` budget case, scrub-parity assertion | `packages/sdk/src/__tests__/debug-images.test.ts` |
| T11 | **New** production-build browser harness (`build()` + `preview()`, not the existing dev-server harness), chromium + firefox + webkit, lazy chunk throwing during module init, worker own-realm `captureException`, page-captured worker frame yields no image, second CORS-enabled asset origin, third-party frame. Assert the browsers actually ran rather than silently skipping | `browser-contract.test.ts` (new file), `test-fixtures/vue-app`, `ci.yml` |
| T12 | Guarded migration 028 + reapplication test + lock-contention measurement against an open long transaction | `packages/ingestion/db/migrations/028_event_debug_meta.sql` |
| T13 | Server: `json.RawMessage` decode, `validateDebugMeta` with fixed ordering and exhaustive reasons, platform-labeled counter, persistence | `error_event.go`, `metrics.go`, `db/queries.go` |
| T14 | Server tests through the **HTTP handler**, not by calling the validator: wrong-typed fields, `null`, `images` as object, scalar entries, conflict at index 65, permuted-order equivalence, every discard reason | `packages/ingestion/handler/…_test.go` |
| T15 | Extend `wireFixture` and its DB assertions; cut `wire-shape.test.ts` off `package.json` version onto a `WIRE_FIXTURE_VERSION` constant; seed registry + commit constant; author the pair with a `code_file` present in `FIXTURE_STACK`. **`package.json` stays at 2.0.1, no changeset, no hand-bump** | wire fixtures, harnesses |
| T16 | All eight stale doc surfaces from §3.5, the "what works today" table, the migration matrix, Known incompatibilities, and `MANUAL_DOC_COVERS` | `docs/contracts/events.md`, `docs/guides/source-maps.md`, `packages/sdk/README.md`, `docs/install.md`, `docs/guides/{react,vue,vanilla}.md`, `docs/reference/{sdk-options,environment-variables}.md`, `scripts/docs-map.mjs` |
| T17 | Live pipeline smoke | migrations, seed, real event POST, DB read-back |
| T18 | File the four deferred design challenges as issues | GitHub |
| T19 | Plugin options bag, SRI detection + `stamp:false`, always-on build summary, stable error codes with problem/cause/fix/anchor, extended commit ladder with explicit override, `logLevel` | `packages/sdk/vite-plugin/index.ts` |
| T20 | `opslane doctor` "Debug IDs" check; extend `check-packed-packages.mjs` to build through both plugin exports; SDK `debug:true` log for dropped images | `cli/src/doctor.ts`, `scripts/check-packed-packages.mjs`, `packages/sdk/src/debug-images.ts` |

## 6. Verification

V0 gates everything and can change §3.2. Then the full gate from `AGENTS.md`:

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

| Req | Evidence |
|---|---|
| R1 | TS and Go suites over the base64 vector file, success and rejection cases, independent oracle; PostgreSQL `uuid` round trip |
| R2 | Two builds from different cwds, byte diff, per-chunk ID equality, ID unchanged by stamping, positions resolved through the retained map |
| R3 | Playwright against production-built assets: throw from a built chunk, assert `debug_meta` and a byte-identical raw stack |
| R4 | Every old fixture still `202` **and** its stored columns asserted; new pair added; table tests for every S0 §5 rule, limit, and ordering case, driven through the HTTP handler |
| R5 | chromium/firefox/webkit x {eager, lazy-throwing-during-init, worker own-realm, page-captured worker frame, cross-origin asset host, third-party frame, unparseable frame} |

### Test coverage diagram

```
CODE PATHS                                        USER / FIELD FLOWS
[+] src/build/debug-id.ts                         [+] Instrumented build -> resolved frame
  |- canonicalize()                                 |- [GAP][->E2E] lazy chunk throws during init
  |   |- [GAP] duplicate key (post-unescape)        |- [GAP][->E2E] cross-origin asset host
  |   |- [GAP] BOM / trailing data / bad UTF-8      |- [GAP][->E2E] worker own-realm capture
  |   |- [GAP] depth 64 boundary (63/64/65)         '- [GAP]        page sees worker frame -> no image
  |   |- [GAP] lone surrogate -> reject
  |   |- [GAP] non-finite number -> reject         [+] Un-instrumented build
  |   '- [GAP] integer-like key ordering            '- [GAP] debug_meta omitted entirely
  '- debugId()  [GAP] 16-byte slice + format
                                                  [+] Broken join (the silent failure)
[+] vite-plugin/index.ts                            '- [GAP] registry non-empty, 0 matched
  |- [GAP] format es / iife / umd / cjs / system            -> empty images array -> counter
  |- [GAP] build.sourcemap unset/hidden/true/inline/false
  |- [GAP] directive prologue + shebang preserved  [+] Server tolerance
  |- [GAP] mappings shift == lines inserted          |- [GAP] commit_sha: 123 -> still 202
  |- [GAP] placeholder length invariance             |- [GAP] debug_meta: [] / null / "x" -> 202
  |- [GAP] oversized map skipped + counted           |- [GAP] images: {} -> 202
  |- [GAP] plugin throws -> build still exits 0      |- [GAP] scalar image entry -> 202
  '- [GAP] legacy export still uploads               '- [GAP] conflict at index 65 kills index 3

[+] debug-images.ts                               [+] Deployment
  |- [GAP] each engine shape + eval + unparseable    |- [GAP] migration reapplied twice
  |- [GAP] synthetic-frame section excluded          '- [GAP] AEL queued behind long txn
  |- [GAP] ordering: dedupe -> ambiguity -> 64
  |- [GAP] byte budget with 4096-byte code_file
  '- [GAP] scrubbing never rewrites a match

[+] error_event.go
  |- [GAP] RawMessage decode never 400s on the new fields
  '- [GAP] every discard reason + precedence

COVERAGE: 0/38 paths tested (0%) — greenfield slice, every path is new
GAPS: 38 (4 E2E, 0 eval)
```

Every gap is assigned to a task in §5. There is no eval scope: this slice touches no
prompt, system instruction, or tool definition.

### Parallelization

| Lane | Steps | Modules | Depends on |
|---|---|---|---|
| A | V0 -> T5 -> T6 -> T7 | `packages/sdk/vite-plugin/`, `test-fixtures/vue-app` | T1, T2 |
| B | T1 -> T2 / T3 | `test-fixtures/debug-id/`, `packages/sdk/src/build/`, `packages/ingestion/debugid/` | — |
| C | T12 -> T13 -> T14 | `packages/ingestion/` | T1 (reason names only) |
| D | T8 -> T9 -> T10 | `shared/`, `packages/sdk/src/` | — |
| E | T11 | `packages/sdk/src/__tests__/`, `ci.yml` | A, D |
| F | T15 -> T16 -> T17 -> T18 | wire fixtures, docs | C, D, E |

Launch B, C, and D in parallel. A starts once T2 lands. E waits on A and D. F is last.
Conflict flag: A and D both touch `packages/sdk/` — different subdirectories, but
`package.json` and `vite.config.ts` are shared; coordinate those two files.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Rollup's `generateBundle` mutation contract is unspecified public API | V0 proves it across Vite 6/7/8; T7 re-asserts it so an upgrade cannot break it silently |
| Prelude without a mappings shift resolves to the wrong line **silently** | Measured, not assumed. Shift by lines inserted; T7 resolves real positions through the retained map |
| Hashing `chunk.map` while shipping the `.map` asset | Measured: the asset's `source` is authoritative. Every step operates on it |
| `import.meta` in a non-ESM chunk kills the customer's app at load | Format-branched prelude, one T6 case per format |
| Prelude ships un-transpiled and un-minified | Pinned to ES5; T6 parses it under the lowest `build.target` |
| Content hash not recomputed | Safe only because the mutation is content-derived; the commit SHA is therefore injected via a hash-participating `define`. SRI/manifest consumers checked in V0 |
| TS and Go disagree on canonical bytes | Base64 raw-byte vectors including rejection cases, plus a third-party oracle so neither implementation grades itself |
| Duplicate keys / BOM / bad UTF-8 unrepresentable in the fixture | Vectors store raw bytes, not JSON objects |
| Malformed metadata rejects a real error event | `json.RawMessage` decode; T14 drives the HTTP handler, not the validator |
| Migration breaks every boot after the first | `IF NOT EXISTS`, named constraints, `NOT VALID` + `VALIDATE`, `lock_timeout`; enforced by `TestMigrations_AreIdempotent` |
| Plaintext customer source in a temp dir or CI log | Nothing is written to disk in S2a; encrypted spill is S2b's job |
| Silent CI skip hides firefox/webkit | T11 asserts the browsers actually ran |
| Broken URL join invisible until S3 | Empty-array-vs-omitted distinction plus the zero-matched counter, both in this slice |
| Machine-dependent IDs from absolute `sources` paths | T7 builds from two different working directories and asserts no absolute path |
| Memory blowup canonicalizing 29.6 MB of maps | Sequential processing, released references, per-map size guard |

## CEO REVIEW (Phase 1, /autoplan)

Mode: SELECTIVE EXPANSION. Premise gate answered by the user: implement S0 as frozen,
file the strategic challenges separately.

### Dream state delta

```
  CURRENT STATE                    THIS PLAN                      12-MONTH IDEAL
  Every production stack is        Chunks carry stable IDs;       Any error, any bundler,
  scrambled. release is never      events carry them; both        resolves to a real file
  set, so the worker's map         languages agree on the ID.     and line with zero
  fetch never runs. The fix        Nothing resolves yet.          customer configuration,
  agent reads minified             Coverage is measurable.        and the agent never sees
  identifiers and nobody knows.                                   a minified identifier.
```

This plan moves toward the ideal on the join key and on measurability. It does not move
the user-visible needle at all; S2b and S3 do that.

### Implementation alternatives considered

| | Approach | Effort (human / CC) | Risk | Verdict |
|---|---|---|---|---|
| A | Minimal: plugin stamps, SDK attaches, server stores. No Go implementation, no parity suite. | ~2 d / ~20 min | Med | Rejected — fails R1, and cross-language drift then surfaces in S2b where it is expensive |
| B | Frozen vectors only, both languages | ~4 d / ~45 min | Med | Rejected — three hand-picked vectors cannot catch a number-formatting divergence |
| C | Frozen vectors **plus** a 500-case generated corpus, bundler-neutral core | ~5 d / ~60 min | Low | **Chosen.** P1 completeness: the corpus is what actually proves R1 |

### Error and rescue registry

| Failure | Named error / signal | Who catches it | What the user sees | Tested |
|---|---|---|---|---|
| Map missing for a chunk | no map on `chunk` | plugin, skip chunk | nothing; chunk gets no ID | T6 |
| Map JSON unparseable | `SyntaxError` from strict parse | plugin, skip chunk, log once | error-level log naming the chunk | T6 |
| Duplicate JSON key in map | explicit reject before canonicalization | plugin and server | plugin logs; server `409` in S2b | T2, T3 |
| Nesting past 64 | explicit depth reject | plugin and server | as above | T2, T3 |
| Commit SHA unresolvable | ladder returns undefined | plugin | field omitted, no log | T6 |
| Registry empty at capture | no images attached | SDK | event stored without `debug_meta` | T10 |
| Registry present, nothing matched | `debug_meta_registry_present_zero_matched_total` | server counter | metric fires | T14 |
| `code_file` claims two IDs | `ambiguous_code_file` discard | server | all entries for that file dropped, counted | T14 |
| More than 64 images | `over_limit` discard | server | first 64 kept, rest counted | T14 |
| Bad `debug_id` shape | `bad_debug_id` discard | server | entry dropped, event still `202` | T14 |
| Bad `code_file` (NUL, control, >4096 B) | `bad_code_file` discard | server | entry dropped, event still `202` | T14 |
| Invalid `commit_sha` | `commit_sha_discarded` | server | field dropped, event still `202` | T14 |
| Plugin throws for any reason | top-level catch | plugin | build succeeds, error-level log | T6 |

### Failure modes registry

| Mode | Visible? | Gap |
|---|---|---|
| Prelude never runs (module-init throw) | Yes, via zero-matched counter | Closed by prelude + init-throw test |
| Content hash no longer matches chunk bytes | **No** — silent CDN staleness | Closed by V0 + no per-chunk commit SHA |
| Maps published to customer CDN | **No** | Closed by writing maps outside `outDir` |
| TS/Go ID divergence | Yes, CI red | Closed by corpus |
| Worker frame gets wrong ID | Would be silent | Closed by yielding no image, by design |
| Program ships and never improves a fix | **No** | **Open in this slice.** Coverage counters land here; the uplift experiment is a separate issue |

### CEO completion summary

| Section | Result |
|---|---|
| 0A premises | Challenged; user gated to "implement S0 as frozen" |
| 0B existing code | 8 sub-problems mapped; plugin body rewritten, everything else extended |
| 0C dream state | Delta stated above; plan is directionally right, user-invisible |
| 0C-bis alternatives | 3 approaches; C chosen |
| 0D selective expansion | 11 corrections accepted, 3 rejected with reasons, 4 deferred to issues |
| 0E temporal | V0 pulled to the front because it can change the design |
| Dual voices | Codex 11 concerns, Claude subagent 12 findings, 6/6 consensus |
| Error/rescue registry | 13 rows |
| Failure modes | 6 rows, 1 open by decision |

<!-- AUTONOMOUS DECISION LOG -->
### CEO 11-section deep review

Sections 1, 2, 5, 6, and 7 are covered above and in the Eng phase (architecture diagram
§4, error/rescue registry, code-quality decisions 24-27 and 30-31, test diagram §6,
performance decisions 40 and 42). The five sections below had no separate coverage.

**Section 3 — Security and threat model.** `debug_meta` is a new attacker-controlled
input on a public, unauthenticated-by-design ingest endpoint. Threats evaluated:

| Threat | Likelihood | Impact | Mitigated |
|---|---|---|---|
| Storage amplification: 64 images x 4096 B on every event | High | Med | Yes — S0 caps, plus the 1 MiB `MaxBytesReader` already at `error_event.go:21` |
| Nested-JSON parser abuse via `debug_meta` | Med | Med | Yes — `json.RawMessage` decode plus per-entry decode, no recursion into unknown members |
| `code_file` carrying a credential in a query string, then persisted and rendered | Med | High | **Decided:** stored verbatim, at parity with `stack_trace_raw`, because a divergent strip breaks the S3 join. Rendering escapes it like any untrusted text |
| Forged `debug_id` pointing at another project's map | Low | High | Out of scope here; S0 keys uniqueness by `(project_id, debug_id)` and S2b enforces it. Named so S2b does not assume S2a validated it |
| Prompt injection via `code_file` reaching the agent | Med | High | **Not solved**, consistent with design §8. `debug_meta` adds one more untrusted string to the same existing surface |
| Malformed metadata used to force a 400 and suppress a real error | Low | High | Yes — decision 28, the whole reason for `json.RawMessage` |

No new secret, no new endpoint, no new authorization boundary. One new dependency
(`gowebpki/jcs`, Apache-2.0) with a license and maintenance check as a gate.

**Section 4 — Data flow shadow paths.**

```
  REGISTRY ──▶ URL EXTRACT ──▶ MATCH ──▶ VALIDATE ──▶ PERSIST
      │             │            │           │           │
      ▼             ▼            ▼           ▼           ▼
  [absent]     [unparseable] [0 matched] [bad shape] [column absent]
  [empty]      [synthetic]   [ambiguous] [>64]       [CHECK reject]
  [worker      [scrubbed]    [cross-     [non-object]
   realm]                     origin]
```

| Shadow path | Behavior | Tested by |
|---|---|---|
| Registry absent (no instrumented build) | `debug_meta` omitted entirely | T10 |
| Registry present, zero matched | `{"images":[]}` sent, counter fires | T10, T14 |
| Frame URL unparseable | frame skipped, never guessed | T10 |
| Synthetic SDK frames | excluded before extraction | T10, decision 39 |
| Scrubber rewrote the URL | asserted not to happen for a matched `code_file` | T10 |
| Worker realm | no image from the page SDK, by design | T11 |
| Ambiguous `code_file` | every entry for that file discarded | T14 |
| Over 64 | first 64 after ambiguity resolution | T14 |
| Column absent (old binary, new payload) | field ignored, event still 202 | T14 |

There are no user-visible interactions in this slice, so the interaction edge-case table
is not applicable. The build-time equivalent is covered by the `build.sourcemap` and
output-format tables in §3.2.

**Section 8 — Observability.** Before the DX phase this was the plan's weakest area:
server counters only, nothing at build time. Now: an always-on build summary line
(decision 47), stable `OPSLANE_VITE_*` codes (48), the commit rung always logged (49),
`opslane doctor` (54), and client-side drop logging under `debug: true` (58). Server
side: per-reason discard counters, a platform-labeled denominator, and the
mechanism-failure counter. The one metric that answers "is this working" is
coverage = events with images over JavaScript events; the one that answers "is it
broken" is `registry_present_zero_matched`. Day-1 dashboard panels: those two. Alert:
zero-matched ratio above a threshold once real traffic exists. No runbook needed yet
because nothing pages — S2a has no runtime service change.

**Section 9 — Deployment and rollout.** Order is migration first, then binary
(decision 29). The migration is additive with a default, guarded by `IF NOT EXISTS`,
named constraints, `NOT VALID` plus a separate `VALIDATE`, and `lock_timeout`. The
deploy-time risk window is benign in both directions: an old binary with the new column
ignores it, and a new binary against a pre-migration database fails on insert, which is
why migration goes first. Rollback: `git revert` the binary; the columns stay, since
dropping a column with data is the riskier operation and an unused nullable column costs
nothing. No feature flag is needed because nothing user-visible activates. Post-deploy
verification: replay the frozen fixtures, confirm 202s and stored columns, then watch
the two counters. The plugin side has no deploy at all this slice — the package is not
published (decision 50).

**Section 10 — Long-term trajectory.** Reversibility **4/5**: the wire fields are
append-only and permanent once a fixture is frozen, which is the one-way part; every
other piece (plugin internals, prelude shape, canonicalizer) is freely changeable.
Debt introduced: two canonicalizer implementations that must stay in lockstep forever,
mitigated by the shared vectors and an independent oracle, but genuinely permanent.
Path dependency: choosing a content-derived ID forecloses cheap interop with
Sentry-style random IDs (recorded in TODOS.md). Knowledge concentration: the
`generateBundle` mutation contract is unspecified Rollup behavior that only this plan's
probe documents, so T7's assertions are the institutional memory — if they are ever
deleted, a Vite upgrade breaks stamping silently. Ecosystem fit: debug IDs are Sentry's
proposed convention and the direction the ecosystem is moving, so this is not a bet
against the grain. The 1-year question: a new engineer reading §3.2's numbered steps
plus the measured-results table can reconstruct why each step exists, which the first
draft could not support.

## ENG REVIEW (Phase 3, /autoplan)

Scope challenge: the complexity check triggers (>8 files, 2 new modules). Autoplan
override P2 applies — scope held, not reduced.

```
ENG DUAL VOICES — CONSENSUS TABLE:
=======================================================================
  Dimension                              Claude   Codex   Consensus
  ------------------------------------   ------   -----   ----------
  1. Architecture sound?                   NO       NO     CONFIRMED
  2. Test coverage sufficient?             NO       NO     CONFIRMED
  3. Performance risks addressed?          NO       n/a    Claude only, flagged
  4. Security threats covered?             NO       NO     CONFIRMED
  5. Error paths handled?                  NO       NO     CONFIRMED
  6. Deployment risk manageable?           NO       NO     CONFIRMED
=======================================================================
5/6 CONFIRMED, 1 single-voice (flagged regardless), 1 DISAGREE (below).
```

Claude subagent: 4 critical, 8 high, 9 medium. Codex: 6 blocking, 10 high-risk gaps.

**CROSS-MODEL TENSION — content hashing.** Codex called it release-blocking that the
prelude and `//# debugId` footer "break content-addressed filenames just as surely as a
commit-SHA injection would." That overstates it. The probe confirms hashes are not
recomputed, but the prelude is a pure function of the chunk (source -> map -> ID ->
prelude), so identical source still yields identical final bytes and
`filename <-> bytes` holds. A commit SHA is not a function of the source, which is
precisely why it alone is excluded. Two real sub-points inside Codex's finding were
kept: SRI/integrity manifests computed pre-mutation, and root `file` participating in
the hash so a filename change moves the ID. Both are now V0 exit criteria.

### Empirical results (probe, Vite 6.4.3 / 7.3.6 / 8.1.5)

| Claim | Result |
|---|---|
| `chunk.code` mutation in `generateBundle` reaches disk | true, all three majors |
| content hash recomputed after mutation | **false** |
| prelude without mappings shift still resolves correctly | **false — resolves to the wrong source line, silently** |
| `;`-prepended mappings restores correctness | true |
| mutating `chunk.map` changes the emitted `.map` | **false — `.map` asset `source` is authoritative** |
| emitted map carries root `file` | true, the content-hashed JS filename |
| sort-keys + `JSON.stringify` equals RFC 8785 | **false — JS emits `["2","10","a","A"]`** |

### Failure modes registry (post-review)

| Mode | Visible? | Status |
|---|---|---|
| Prelude never runs (module-init throw) | via zero-matched counter | Closed: prelude + init-throw E2E |
| Prelude resolves to the wrong line | **No — silently wrong** | Closed: measured, mappings shifted by lines inserted, positions asserted |
| Hashed map differs from shipped map | **No — 409 only in S2b** | Closed: asset `source` is the single artifact |
| `import.meta` in non-ESM chunk | build green, app dead on load | Closed: format branch + per-format test |
| Prelude not lowered to `build.target` | app dead on old browsers | Closed: ES5 prelude, parse assertion |
| Migration reapplied on boot | loud, but breaks every later migration | Closed: guarded, enforced by an existing test |
| Malformed metadata rejects a real event | **No — event silently lost** | Closed: `json.RawMessage` decode |
| Customer source in a temp file or CI log | **No** | Closed: nothing written in S2a |
| Broken URL join | **No** | Closed: empty-array distinction + counter |
| Machine-dependent IDs (absolute `sources`) | **No — surfaces as 409 in S2b** | Closed: two-cwd determinism test |
| Event dropped at unload from oversized debug_meta | **No** | Closed: SDK byte budget |
| Vite upgrade breaks the mutation contract | CI red | Closed: T7 re-asserts |

Critical gaps remaining: **0**. Every silent failure mode above has a test and a named
owner task.

### Eng completion summary

| Item | Result |
|---|---|
| Step 0 scope challenge | Scope held (P2), complexity accepted |
| Architecture review | 6 issues (asset authority, format branch, node builtins, prologue, SRI, `file` coupling) |
| Code quality review | 5 issues (canonicalizer correctness, ordering, discard reasons, legacy export semantics, memory) |
| Test review | Diagram produced, 38 gaps, all assigned |
| Performance review | 3 issues (per-map memory, keepalive byte budget, migration lock queue) |
| NOT in scope | Written (§1) |
| What already exists | Written (§2) |
| Failure modes | 12 modes, 0 critical gaps |
| Dual voices | Codex + Claude subagent, 5/6 consensus, 1 tension resolved |
| Parallelization | 6 lanes, 3 parallel at start |
| Lake score | 19/19 recommendations chose the complete option |

## DX REVIEW (Phase 3.5, /autoplan)

Mode: DX POLISH. Product type: developer-installed SDK plus Vite build plugin, MIT,
published to npm. Persona: a frontend engineer who already ships a Vite app to
production and is evaluating Opslane against Sentry, PostHog, and Bugsnag.

```
DX DUAL VOICES — CONSENSUS TABLE:
=======================================================================
  Dimension                              Claude   Codex   Consensus
  ------------------------------------   ------   -----   ----------
  1. Getting started < 5 min?              NO       NO     CONFIRMED
  2. API/CLI naming guessable?             NO       NO     CONFIRMED
  3. Error messages actionable?            NO       NO     CONFIRMED
  4. Docs findable & complete?             NO       NO     CONFIRMED
  5. Upgrade path safe?                    NO       NO     CONFIRMED
  6. Dev environment friction-free?        NO       NO     CONFIRMED
=======================================================================
6/6 CONFIRMED, 0 DISAGREE.
```

### Developer journey

| Stage | Before review | After |
|---|---|---|
| Discover | Guide exists and is linked from three framework guides | Unchanged |
| Evaluate | Guide describes a flow that resolves stacks; S2a's does not | "What works today" table; guide keeps recommending the legacy plugin |
| Install | Not installable — publish believed held (it was not) | Stays 2.0.1, genuinely not installable, on purpose |
| Configure | Zero-arg `opslane()`, no overrides at all | `opslane(options?)`: `commitSha`, `stamp`, `logLevel`, `sourcemaps` |
| Hello world | No path. Nothing observable anywhere | Build summary line + `opslane doctor` check + documented local dogfood |
| Debug | Six log conditions, all failures, no strings specified | Stable codes, problem + cause + fix + docs anchor, always-on summary |
| Upgrade | Hand-bump to 2.1.0, believed safe | 2.0.1 held; fixture key decoupled; S2b ships one real changeset |
| Scale | SRI users get a blank site, no opt-out | SRI detection + `stamp: false` |
| Migrate | Two sibling exports, no relationship documented | Canonical name, `@deprecated` TSDoc, normative migration matrix with tests |

### Developer empathy narrative

I add `opslane()` to my Vite config because the docs told me to. `vite build` prints
nothing. `dist/` looks the same. I open the app: it still works, or on my SRI-enabled
build it is a blank page with a console error naming a hash I have never seen. There is
no `opslane doctor` output about this, no dashboard row, no log line saying whether it
found my commit SHA. I cannot tell the difference between "working" and "did not run."
So I remove the plugin, because the one thing I can verify is that the site loads again.

That narrative is the argument for the build summary line and the doctor check: in a
slice with no server-side result to show, the build output *is* the product.

### DX scorecard

| Dimension | Before | After | What moved it |
|---|---|---|---|
| Getting started | 2/10 | 6/10 | Documented dogfood path and a doctor check; capped because the package stays unpublished by design |
| API/CLI ergonomics | 4/10 | 8/10 | Options bag, convention-matching name, deprecation marker on the sibling export |
| Error messages | 3/10 | 8/10 | Stable codes plus problem/cause/fix/anchor on every condition |
| Documentation | 3/10 | 8/10 | Eight surfaces enumerated, "what works today" table, migration matrix, docs-map coverage |
| Escape hatches | 2/10 | 8/10 | `stamp`, `logLevel`, `sourcemaps`, explicit `commitSha`; the `__unsafe` back door is gone |
| Upgrade path | 4/10 | 9/10 | The accidental-publish path was found and closed against the changesets source |
| Observability / feedback | 4/10 | 7/10 | Build summary, doctor check, client-side drop logging; customer-facing metric routing is named but lands in S4 |
| Overall coherence | 5/10 | 8/10 | The product surface now has the same specificity as the mechanism |

**TTHW:** undefined before (nothing observable, nothing installable). After, for the
internal dogfood path this slice actually supports: **~3 minutes** — add the plugin,
`pnpm build`, read the summary line, `opslane doctor`. External TTHW stays undefined
until S2b publishes, which is the intended state.

### DX implementation checklist

- [ ] `opslane(options?)` with all four optional fields, `opslaneVitePlugin` canonical
- [ ] SRI plugin detection, `stamp: false`, Known incompatibilities docs section
- [ ] Always-on `closeBundle` summary: stamped/skipped counts, reasons, sourcemap mode, commit rung
- [ ] Stable `OPSLANE_VITE_*` codes with problem + cause + fix + docs anchor
- [ ] Commit ladder: explicit override first, four more CI rungs, `COMMIT_REF` dropped, winner always logged
- [ ] `opslane doctor` "Debug IDs" check with remediation
- [ ] `package.json` stays 2.0.1; `WIRE_FIXTURE_VERSION` constant replaces the version coupling
- [ ] `check-packed-packages.mjs` builds through both plugin exports
- [ ] Eight doc surfaces + `MANUAL_DOC_COVERS`
- [ ] Migration matrix with legacy-only / new-only / both tests
- [ ] `debug: true` log for client-side image drops
- [ ] Name the S4 surface that routes the coverage metric to the customer

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected alternative |
|---|-------|----------|----------------|-----------|-----------|----------------------|
| 1 | CEO | Mode = SELECTIVE EXPANSION | Mechanical | P6 | Iteration on an existing system against a frozen contract | EXPANSION, REDUCTION |
| 2 | CEO | Approach C (vectors + 500-case corpus, bundler-neutral core) | Taste | P1 | Three hand-picked vectors cannot catch number/escape divergence; the corpus is what proves R1 | A (no Go), B (vectors only) |
| 3 | CEO | Registry snippet is a prelude with a 36-char placeholder + `;`-shifted mappings, not a footer | Mechanical | P1 | A footer never runs when the module throws during init, which is the case debug IDs exist for | Footer-only (Codex 3) |
| 4 | CEO | Registry keyed by `import.meta.url`; stack-parse demoted to fallback | Taste | P5 | Exact URL from the engine's own module record; removes dependence on stackTraceLimit and prepareStackTrace | Stack-string key as primary (design §5.2 sketch) |
| 5 | CEO | Commit SHA injected via a hash-participating `define`, never appended per chunk | Mechanical | P1 | Per-chunk injection either breaks filename-to-bytes identity or busts the customer's whole CDN every deploy | Per-chunk global (original draft) |
| 6 | CEO | Maps removed from the bundle and written outside `outDir` and the repo | Mechanical | P1 | Leaving them in `outDir` is a source-disclosure regression published to npm; deleting them loses them | Leave in `outDir`; delete outright |
| 7 | CEO | Worker support scoped to own-realm attach; page-captured worker frames yield no image | Mechanical | P1 | A worker has its own `globalThis`; the page SDK cannot read it, and no stack parsing changes that | Claiming worker support (original draft) |
| 8 | CEO | Debug-ID core at `packages/sdk/src/build/`, not under `vite-plugin/` | Mechanical | P2 | Design §2 calls the core bundler-neutral; a copied hash algorithm is a parity bug waiting to happen | Inside the Vite adapter |
| 9 | CEO | Add coverage + `registry_present_zero_matched` counters | Mechanical | P1 | Discard counters measure malformed input, not whether the mechanism works | Discard counters only |
| 10 | CEO | Keep `opslaneSourceMapPlugin` and its options object working alongside `opslane()` | Mechanical | P3 | ~5 lines is cheaper than proving nobody hand-wired it | Rename outright on a minor |
| 11 | CEO | Do not silently override `build.sourcemap`; detect and log conflicts and peer debug-ID plugins | Mechanical | P1 | "Already using Sentry" is the likeliest state of a qualified prospect | Unconditional override |
| 12 | CEO | Measure migration 028's lock profile on realistic row counts | Mechanical | P1 | `error_events` is the hottest table; the seed fixture cannot surface it | Assume PG 11+ fast path |
| 13 | CEO | Pull the Rollup mutation probe to V0, before any implementation | Mechanical | P1 | It can change §3.2's whole shape; discovering that at T5 wastes T5 | Probe during T5 |
| 14 | CEO | Keep RFC 8785 canonicalization | Mechanical | P1 | Its job is surviving the post-hash `debugId` stamp and the server's JSON round trip, not poison detection. Also frozen in S0 §6 | Raw-byte SHA-256 (Claude F7) |
| 15 | CEO | Reject consuming Sentry-injected debug IDs | Mechanical | P4 | S0 §6 requires claimed == recomputed, so a random UUID always 409s. Filed to TODOS.md as a wedge idea | Dual-ID join (Claude F9) |
| 16 | CEO | Reject `BYTEA(16)`/`TEXT` for debug IDs | Mechanical | P6 | S0 §6.2 froze `uuid` and proved PG 16.14 preserves the bits | Storage change (Claude F12a) |
| 17 | CEO | Defer the 4 design-level challenges to their own issues | Mechanical | P6 | User's premise-gate answer; AGENTS.md guardrail keeps the change inside the issue | Reopening #216 now |
| 18 | Eng | `.map` asset `source` is the authoritative artifact, not `chunk.map` | Mechanical | P1 | Measured: mutating `chunk.map` leaves the emitted map unchanged; hashing it would guarantee a server ID mismatch | Hash `chunk.map` |
| 19 | Eng | Shift `mappings` by the number of lines actually inserted | Mechanical | P1 | Measured: no shift resolves to the wrong source line silently | Hard-coded single `;` |
| 20 | Eng | Branch the prelude on output format; skip when neither key is available | Mechanical | P1 | `import.meta` is a syntax error in iife/umd/cjs/system — build green, app dead | Unconditional `import.meta.url` |
| 21 | Eng | Insert the prelude after any directive prologue or shebang | Mechanical | P1 | Prepending ahead of `'use strict';` silently disables strict mode | Insert at byte 0 |
| 22 | Eng | Pin the prelude to ES5 syntax and assert it parses under the lowest target | Mechanical | P1 | esbuild lowers in `renderChunk`, before `generateBundle`, so the prelude ships verbatim | Modern syntax |
| 23 | Eng | Use `crypto.subtle`, not `node:crypto`; assert no `node:` import in `dist/` | Mechanical | P1 | One browser-targeted lib build covers the plugin entry; a Node import becomes a throwing stub | `node:crypto` |
| 24 | Eng | Replace sort-keys+stringify with a raw-byte pre-pass and manual member emission | Mechanical | P1 | Measured: JS hoists integer-like keys, so the output is not RFC 8785; `JSON.parse` cannot see duplicate keys at all | "40 lines, no dependency" |
| 25 | Eng | Vectors store raw input bytes as base64, with rejection outcomes | Mechanical | P1 | A JSON object cannot express a duplicate key, a BOM, or invalid UTF-8 | JSON-object corpus |
| 26 | Eng | Expected values come from a pinned third-party JCS oracle | Mechanical | P1 | Generating expectations from our own code makes one suite tautological | Self-generated corpus |
| 27 | Eng | Reject lone surrogates and non-finite numbers at strict parse | Mechanical | P1 | They diverge structurally between Go and JS; no hash agreement is possible | Hash cases in the corpus |
| 28 | Eng | Decode `debug_meta`/`commit_sha` as `json.RawMessage` | Mechanical | P1 | A typed field makes `"commit_sha":123` reject the whole event, violating S0 §5 | Typed struct members |
| 29 | Eng | Guarded migration: `IF NOT EXISTS`, named constraints, `NOT VALID`+`VALIDATE`, `lock_timeout` | Mechanical | P1 | `TestMigrations_AreIdempotent` enforces it and boot replays every file | Verbatim S0 SQL |
| 30 | Eng | Fix validation order: shape, dedupe, ambiguity over the whole list, then first 64 | Mechanical | P1 | Truncating first lets a conflict at index 65 escape, making storage order-dependent | Unspecified order |
| 31 | Eng | Exhaustive discard reasons with counting precedence | Mechanical | P1 | The original four cannot represent a malformed container or a scalar image | Four reasons |
| 32 | Eng | SDK sends `{"images":[]}` on zero-match, omits on empty registry | Taste | P1 | The only in-contract way to make the mechanism-failure counter computable | Freeze `registry_present` (Codex); drop the metric |
| 33 | Eng | Nothing written to disk in S2a; encrypted spill is S2b | Mechanical | P1 | S0 §7.4 freezes ciphertext spill; a plaintext temp file with a logged path is customer source in CI logs. **Supersedes decision 6** | Plaintext temp dir |
| 34 | Eng | Hold the npm publish; bump the version, add no changeset | Taste | P6 | The fixture test is version-keyed so the bump is required, but shipping a stamp-only plugin starts a support surface | Publish 2.1.0 |
| 35 | Eng | Legacy export keeps its name **and** its upload behavior | Mechanical | P3 | Keeping the signature while removing the behavior is a breaking minor in disguise | Alias to the new plugin |
| 36 | Eng | Per-`build.sourcemap`-value behavior table | Mechanical | P1 | Unconditional removal 404s the `sourceMappingURL` of a customer who set `true` | Always remove |
| 37 | Eng | T11 is a new production-build harness, not an extension | Mechanical | P1 | The existing harness drives a Vite dev server; an `apply:'build'` plugin never runs there | Extend in place |
| 38 | Eng | Extend `wireFixture` and its DB assertions; seed registry+commit in the shape test | Mechanical | P1 | Otherwise new fixtures prove only that unknown fields still return 202 | Author fixtures only |
| 39 | Eng | Exclude synthetic frames; settle scrub-vs-match parity | Mechanical | P1 | Synthetic frames point at the SDK's own chunk and burn image slots | Extract from the whole stack |
| 40 | Eng | SDK byte budget for serialized `debug_meta` | Mechanical | P1 | 64 x 4096B exceeds the keepalive quota and loses the event at unload | Entry count only |
| 41 | Eng | Two-cwd determinism build + absolute-path assertion | Mechanical | P1 | Same-machine double builds cannot see machine-dependent IDs | Same-cwd double build |
| 42 | Eng | Per-map size guard and sequential processing | Mechanical | P1 | 29.6 MB of maps per build, canonicalized in Node, several multiples resident | Unbounded |
| 43 | Eng | Reject Codex's "prelude breaks content hashing" as blocking | Taste | P5 | The mutation is content-derived so `filename <-> bytes` holds; only the commit SHA breaks it. Kept the SRI and `file`-coupling sub-points as V0 criteria | Treat as blocking |
| 44 | Eng | V0 becomes a blocking architecture proof with a written decision criterion | Mechanical | P1 | A probe with no pass/fail rule is a formality | Spot check |
| 45 | DX | Ship `opslane(options?)` with `commitSha`, `stamp`, `logLevel`, `sourcemaps` | Mechanical | P1 | The plan already needed an options bag for its own tests and called it `__unsafeRetainMapsForTest`; S2b would force a signature change on a minor anyway | Zero-arg only |
| 46 | DX | Detect SRI plugins, skip stamping, honor `stamp: false` | Mechanical | P1 | Post-hash mutation plus a precomputed integrity value is a blank page with no Opslane error, because the page never runs | No opt-out |
| 47 | DX | Always-on build summary line | Mechanical | P1 | Every specified log fired on failure, so a working build looked identical to a plugin that never loaded | Failure logs only |
| 48 | DX | Stable `OPSLANE_VITE_*` codes with problem + cause + fix + docs anchor | Mechanical | P1 | 13 named conditions had zero specified strings — a regression from the one message being replaced | Condition taxonomy only |
| 49 | DX | Commit ladder: explicit `OPSLANE_COMMIT_SHA` first, 4 more CI rungs, drop `COMMIT_REF`, always log the winner | Mechanical | P1 | Docker builds without `.git` are the likeliest misconfiguration and the draft specified no log; `COMMIT_REF` is a branch name on several platforms | 5 rungs, silent |
| 50 | DX | **Keep `package.json` at 2.0.1**; decouple the fixture key onto `WIRE_FIXTURE_VERSION` | Mechanical | P1 | Verified in the pinned changesets source: `publish` ships any local version absent from npm, changeset or not. **Reverses decision 34** | Hand-bump with no changeset |
| 51 | DX | Do not publish a setup snippet for an export npm does not have | Mechanical | P1 | A copy-paste example that installs fine and fails at import | Document `opslane()` now |
| 52 | DX | Enumerate all 8 stale doc surfaces + `MANUAL_DOC_COVERS` | Mechanical | P1 | Three framework guides already declare `covers: vite-plugin/**`, so the docs-sync bot flags them mid-slice | Two files |
| 53 | DX | Normative migration matrix with legacy-only / new-only / both tests | Mechanical | P1 | Two sibling exports on one specifier with no stated composition rule | Prose only |
| 54 | DX | `opslane doctor` "Debug IDs" check | Taste | P1 | Ten lines against existing `CheckResult` machinery; the only way a developer confirms the slice did anything | No CLI surface |
| 55 | DX | `opslaneVitePlugin` canonical, `opslane` alias, `@deprecated` on the legacy export | Mechanical | P5 | Matches `opslaneVuePlugin`; a bare vendor name next to `vue()` says nothing about what it does | `opslane` only |
| 56 | DX | `logLevel` so deliberate-config notices are silenceable | Mechanical | P3 | A permanent per-build warning for a correct configuration trains users to ignore all plugin output | Always warn |
| 57 | DX | `'inline'` maps: skip stamping, message names the remedy | Mechanical | P1 | Refusing a plaintext temp file while stamping the one config that publishes source to the CDN is incoherent | Stamp and warn |
| 58 | DX | Log client-side image drops under the existing `debug: true` | Mechanical | P1 | Server drops all get counters; client drops had no signal on either side | Silent |
| 59 | DX | Extend `check-packed-packages.mjs` through both plugin exports | Mechanical | P1 | It probes only the root entry, so a broken `/vite-plugin` export ships | Root entry only |
| 60 | DX | Name the S4 surface that routes coverage to the customer | Mechanical | P6 | Otherwise S4 inherits a counter nobody routed | Leave unrouted |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | 11 proposals, 11 accepted, 4 deferred |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 3 phases, all folded |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 52 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | skipped, no UI scope |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | clean | score 5/10 → 8/10, TTHW undefined → ~3 min |

- **CODEX:** three passes (CEO, Eng, DX). Two Codex findings were rejected with reasons
  (prelude-breaks-content-hashing, `debug_meta.registry_present`); the rest folded in.
  Its DX blocking finding on the changesets publish path was verified against the pinned
  library source and reversed a prior auto-decision.
- **CROSS-MODEL:** 18/18 consensus dimensions confirmed across three phases, all negative
  on first pass. One genuine disagreement, resolved against Codex on the content-hashing
  question with its two valid sub-points retained as V0 exit criteria.
- **VERDICT:** CEO + ENG + DX CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
