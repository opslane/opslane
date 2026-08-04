# Stack-first grouping: where the real prod errors land

> **READ THIS FIRST:** everything above the `LOCKED PLAN` section is superseded
> exploration kept for context. Where it contradicts the locked plan (it groups
> `Script error.` instead of suppressing it; it proposes pure-message fallback plus
> engine canonicalization; it claims parsing alone fixes #258), the locked plan wins.
> Under the locked ladder, #258 stays split until resolved-frame grouping (rung 2) ships.

Working notes for issues [#258](https://github.com/opslane/opslane-oss/issues/258) and
[#256](https://github.com/opslane/opslane-oss/issues/256), using prod evidence from 2026-08-03.
Companion artifact: https://claude.ai/code/artifact/01b4c084-5a6c-452b-bf9e-729ef9f6ac5b

## Today: one bug, five groups, three verdicts

Current fingerprint = `sha256(platform | type | normalized_message | raw stack lines)`
(`packages/ingestion/grouping/fingerprint.go`). The message **and** the raw stack are both
engine-worded, so each browser hashes differently. Fingerprints below are real outputs of
`grouping.Fingerprint()` for these messages.

| Engine | Prod message (verbatim) | Fingerprint today | Events | Outcome |
|---|---|---|---|---|
| Chrome (V8) | `Cannot read properties of null (reading 'includes')` | `9b1cf43b…` | 382 | pr_created → PR #1232 |
| Firefox (SpiderMonkey) | `can't access property "includes", e.request_types is null` | `f6cbabf6…` | 15 | needs_human, low_confidence_fix |
| Firefox (short form) | `e.request_types is null` | `f769862e…` | ×2 groups | investigated, low |
| Safari (JavaScriptCore) | `null is not an object (evaluating 'e.request_types')` | `6a65003c…` | 5 | investigated, low |

Note V8 also embeds the message as the first line of `err.stack`, so the message leaks into
the frames component of the hash even if it were removed from the message component.

## Proposed pipeline

```
browser event                 stage 1                  stage 2                stage 3
message + raw stack   ──▶   parse stack into   ──▶   symbolicate via   ──▶   grouping
+ debug ID                  structured frames        debug ID / source        ladder
                            (engine-agnostic)        map → original
                                                     file:function
```

- **Stage 1 — parse.** Turn V8's `at fn (url:1:2)` and Gecko/JSC's `fn@url:1:2` into
  identical `{function, file, line, col}` frames. Drop Chrome's embedded message line.
- **Stage 2 — symbolicate.** Debug IDs already flow from Vite builds into events
  (commit `de59ecd`); sourcemap refs are stored at ingest. Resolving frames gives original
  `file:function` identities — identical across every browser — and drops minified
  line/col noise that shifts every deploy.
- **Stage 3 — grouping ladder.** First rung with usable input wins; lower rungs never
  contribute to the hash:
  1. **Custom fingerprint** — SDK or server-side rule set an explicit group key → use verbatim.
  2. **Type + symbolicated in-app frames** — the normal path:
     `sha256(platform | type | app frames)`. Message excluded entirely.
  3. **Type + parameterized message** — only when no usable frames. Values scrubbed,
     engine phrasing canonicalized.

## Example A (rung 2): the #258 null-deref converges to one group

Raw events — same bug, three shapes:

```
Chrome (V8)
  TypeError: Cannot read properties of null (reading 'includes')
      at checkTypes (…/index-Bd9xK2a1.js:1:52310)
      at validateForm (…/index-Bd9xK2a1.js:1:51877)

Firefox (SpiderMonkey)
  can't access property "includes", e.request_types is null
  checkTypes@…/index-Bd9xK2a1.js:1:52310
  validateForm@…/index-Bd9xK2a1.js:1:51877

Safari (JavaScriptCore)
  null is not an object (evaluating 'e.request_types')
  checkTypes@…/index-Bd9xK2a1.js:1:52310
  validateForm@…/index-Bd9xK2a1.js:1:51877
```

After stages 1 + 2, all three produce the same frames (paths illustrative):

```
{ function: "checkTypes",   file: "src/composables/useRequestFilters.ts", line: 42 }
{ function: "validateForm", file: "src/composables/useRequestFilters.ts", line: 87 }
```

Rung 2 hash input — no message anywhere:

```
javascript|TypeError|app:src/composables/useRequestFilters.ts:checkTypes|app:src/composables/useRequestFilters.ts:validateForm
→ group 777ee678…
```

**Result:** one group, 402+ events across Chrome, Firefox, and Safari. One investigation
with the full cross-browser event volume behind it; PR #1232 resolves every variant.
No per-error-type canonicalization regexes needed — engine wording never enters the hash.

## Example B (rung 3): the #256 stale-chunk family

Failed dynamic imports surface from module-loading machinery, not app code — no in-app
frames after parsing, so the ladder falls through to the message rung. Parameterization
scrubs the per-deploy hash:

```
deploy N:    Failed to fetch dynamically imported module: https://…/assets/chunk-BdA9x2Lq.js
deploy N+1:  Failed to fetch dynamically imported module: https://…/assets/chunk-Cq7wM8pZ.js

rung 3 hash input (both deploys):
javascript|TypeError|msg:failed to fetch dynamically imported module: /assets/chunk-<hash>.js
→ group a083cfb8…
```

The ~70 `unfixable_infra` incidents collapse into one family group. With the #256 rubric
change, triage proposes the standard mitigation instead of terminalizing:

```js
window.addEventListener('vite:preloadError', () => window.location.reload())
```

## Example C (rung 3): stackless cross-origin `Script error.`

Browsers redact message and stack for cross-origin scripts without CORS headers. Nothing to
parse or symbolicate — rung 3 groups on the bare message. This is *why* the message survives
as a fallback at all.

```
javascript|Error|msg:script error.
→ group 38434d69…
```

## Control (rung 2): a different null-deref does NOT merge

Null-deref on `'map'` in `renderList` — same error type, same coarse shape, different code
path. Frames keep it separate, which is exactly the discrimination the message used to
(over-)provide.

```
javascript|TypeError|app:src/components/RequestList.vue:renderList
→ group 9a167cbd…   (≠ 777ee678…)
```

## Classification summary

| Prod event | Ladder rung | Group | Groups today → new | Verdict under new architecture |
|---|---|---|---|---|
| `Cannot read properties of null (reading 'includes')` | 2 · frames | `777ee678…` | 5 → 1 | pr_created — PR #1232 covers all engines |
| `can't access property "includes", e.request_types is null` | 2 · frames | `777ee678…` | ↑ | ↑ |
| `e.request_types is null` | 2 · frames | `777ee678…` | ↑ | ↑ |
| `null is not an object (evaluating 'e.request_types')` | 2 · frames | `777ee678…` | ↑ | ↑ |
| `Failed to fetch dynamically imported module: chunk-*.js` | 3 · message | `a083cfb8…` | ~70 → 1 | fixable — reload-on-preloadError PR (with #256 rubric) |
| `Script error.` | 3 · message | `38434d69…` | 1 → 1 | grouped via message fallback |
| `Cannot read properties of null (reading 'map')` | 2 · frames | `9a167cbd…` | 1 → 1 | separate group — correctly not merged |

## Real vs. illustrative

- **Real:** error messages, event counts, verdicts, PR numbers, and today's fingerprints
  (computed by running the actual `grouping.Fingerprint()` code against the prod messages).
- **Illustrative:** symbolicated file paths (the customer's source maps aren't available
  here). New-architecture fingerprints are genuine SHA-256 truncations of the exact hash
  inputs shown, using the same truncate-to-128-bits scheme as production.

## What's missing to build this

Already in place: debug IDs from Vite builds (commit `de59ecd`), sourcemap references
stored at ingest. Missing:

1. A structured, engine-agnostic stack parser feeding the fingerprint.
2. Symbolication *before* fingerprinting — today `error_event.go:114` fingerprints
   synchronously at ingest and source maps resolve later, during investigation. Needs
   either symbolication in the ingest path (with caching) or a deferred re-group step.
3. The ladder itself in `grouping/fingerprint.go`, demoting the message to fallback-only.

Tracer-bullet slice: structured stack parsing + message-as-fallback (no symbolication yet).
That alone kills the #258 prod case — parsed frames are already identical across engines
because they point at the same minified bundle — and leaves source-map-aware grouping as
the documented next step.

---

## LOCKED PLAN (2026-08-03, supersedes everything above)

Decisions from the grill session. Guiding principle: simplest shippable option,
test and improve over time.

### Scope

The ladder applies to `platform == "javascript"` ONLY. Python (and any other
platform) keeps the existing algorithm in `fingerprint.go` byte-for-byte
unchanged — the current function owns Python traceback grouping too, and this
browser-focused change must not touch it.

**Runtime ownership:** rung-2 stack parsing and symbolication are implemented **in
Go, inside the ingestion service** — fingerprinting precedes the group upsert, so
the TypeScript resolver in `packages/worker/src/source-map.ts` cannot serve it.
The worker's resolver stays for investigation-time snippets; a shared parity
fixture corpus (same inputs, same expected resolved frames, consumed by both Go
and TS tests) keeps the two implementations from drifting. Go side uses an
existing source-map library (e.g. `go-sourcemap/sourcemap`; license review per
repo guardrails) rather than hand-rolling VLQ decoding.

**Key format:** every `group_keys.key` is `platform|algo|rung|` prefix in clear +
a 128-bit hex hash of the rung input (e.g. `js|v2|r2|9b1cf43b…`) — never raw
message or frame text, so the unique B-tree index stays bounded and keys from
different platforms, algorithm generations, or rungs can never collide.

### Ladder

- **Rung 0 — suppression.** Minimal list: ResizeObserver loop variants, stackless
  `Script error.`, and events with **at least one parsed frame where every parsed
  frame is an extension scheme** (the quantifier matters: an empty stack must not
  vacuously match the extension rule). Drop with a per-rule counter. No sampling,
  no pseudo-groups (deferred).
- **Rung 1 — family rule.** Message-pattern-only predicate over the four documented
  stale-deploy wordings (Chrome/Firefox/Safari dynamic import + CSS preload),
  case-insensitive, one constant fingerprint per project. No extra gates: a
  current-release bad import swept into the family carries a release not older
  than `resolved_in_release`, so the existing requeue machinery re-investigates it.
  Predicate lives in one function with a shared Go/TS fixture corpus.
- **Rung 2 — resolved frames.** `type + in-app resolved file:function`. No line
  numbers, no message. Gate: ≥1 frame actually resolved AND ≥1 in-app frame.
  In-app default: not node_modules, not an extension scheme.
  **Usable-frame contract:** v1 frame identity is **`file:originalLine`**.
  Not the source map's `name` field — per the source-map spec (ECMA-426), a
  mapping's `name` is an optional symbol name at that position (often a variable
  or property, NOT the enclosing function), so treating it as a function identity
  would be wrong, not just lossy. `pos.name` may be surfaced as a display hint
  only. Consequences accepted for v1: identity churns when the customer edits
  that source file above the throw site (bounded — only that file's groups, only
  on edits, unlike per-deploy minified churn), and two throw sites in the same
  function land in separate groups (split, not merge). Deriving a stable
  enclosing-function identity (context-line text, or parsing sourcesContent) is
  on the improve-over-time list. Separately: one-or-two-letter minified error
  *type* names (`rl`, `el` — minified Error subclasses, not function names) get
  a placeholder type so they stop splitting groups.
- **Rung 3 — fallback.** `type + parameterized message + normalized script URLs of
  top frames` (chosen over pure-message to fence app/vendor/extension collisions;
  accepts that same-bundle same-message distinct bugs merge while unmapped).
  Engine-phrasing canonicalization regexes are DEFERRED to v1.1, pending shadow-run
  evidence that rung-3 cross-browser splits still cost investigations.

### Mechanics

- **Key table (replaces the informal "alias table"):** `group_keys(project_id, key,
  rung, group_id)` with `UNIQUE(project_id, key)`. Every event computes its
  fine key (best rung that applies) AND its coarse rung-3 key. Lookup inside the
  ingest transaction, fine key first, then coarse:
  - fine hit → attach; insert the coarse key for this group if unclaimed
    (`ON CONFLICT DO NOTHING` — first group to claim a coarse key keeps it).
  - fine miss, coarse hit → attach to that group **only if** the group has no fine
    key from a different bug (no fine keys yet, or this event's fine key is
    already registered there). Otherwise create a new group under the fine key;
    the coarse key stays with its first owner. This is the collision policy: a
    coarse key can front exactly one fine bug; later distinct bugs sharing it
    split off cleanly instead of gluing.
  - both miss → create group + insert both keys in the same transaction. The
    unique constraint serializes concurrent creators; on conflict, retry the
    lookup once (the winner's group now exists). This closes the resolved-first
    race: a later unresolved event finds the coarse key the resolved event
    registered at creation.
  Rows are append-only, keys point at group ids (never other keys), group title
  refreshes from the newest resolved event.
  Three transaction details, so the invariants survive contact with Postgres:
  - **Rung-3-only events:** fine key == coarse key; insert once, not twice.
  - **Fine-miss/coarse-hit attach:** the event's fine key is inserted for that
    group in the same transaction as the attach, atomically.
  - **No aborted transactions:** all key inserts are `ON CONFLICT DO NOTHING`
    followed by a re-`SELECT`, so a lost race never raises a unique violation
    mid-transaction (which would abort it absent a savepoint). "Retry lookup
    once" means: re-select after the conflicting insert, inside the same
    transaction — not catch-and-continue on an aborted one.

- **`error_groups.fingerprint` contract:** after this change the column stores the
  group's creation-time fine key, written once, immutable, display/debug only.
  ALL lookup goes through `group_keys` — the direct
  `ON CONFLICT (project_id, fingerprint)` upsert at `queries.go:506` is retired
  for javascript-platform events, and any other caller resolving groups by
  fingerprint must migrate to `group_keys` in the same PR. The existing
  `UNIQUE(project_id, fingerprint)` constraint stays (harmless: creation-time
  fine keys are unique via `group_keys` anyway).
- **Cutover:** hard cutover, no dual-hash window, no algorithm_version column.
  Bulk-resolve closes old-scheme groups with
  `resolved_reason='superseded_by_regrouping'`, restricted to **`investigated` and
  `needs_human` only**. Already-terminal `merged`/`resolved` groups keep their
  real resolution provenance untouched (overwriting a genuine `resolved_reason`
  with a bookkeeping one destroys information for zero benefit), and groups in
  `queued`/`analyzing`/`fixing`/draft-PR states are left alone so their running
  jobs can write their terminal status without being overwritten (active states
  are deliberately outside recurrence handling — see `isRequeueEligible`,
  `db/queries.go:309` — this script respects the same boundary). Two-pass: pass 1
  runs immediately and records the **specific old-scheme active group IDs** it
  skipped; pass 2 re-checks exactly those IDs once their jobs reach a terminal
  state (never "wait for the global queue to drain" — new-scheme jobs keep it
  busy forever). Before mutating anything, the script writes an audit JSONL
  containing the **full pre-mutation row** of every group it will touch — that,
  not a partial tuple, is the rollback input — and prints the
  `pr_created`/`needs_human` rows for a human eyeball. Known accepted risk: an
  unmerged-PR bug still firing gets one duplicate investigation under the new scheme.
- **Family lifecycle precondition:** verify design-partner events populate
  `release`, scoped to what actually gates the family rule — the design-partner
  project, the stale-deploy family messages, a recent window, with a denominator:
  ```sql
  SELECT count(*) FILTER (WHERE release IS NULL OR release = '') AS missing,
         count(*) AS total
  FROM error_events
  WHERE project_id = $partner
    AND created_at > now() - interval '14 days'
    AND (error_message ILIKE 'failed to fetch dynamically imported module%'
      OR error_message ILIKE '%error loading dynamically imported module%'
      OR error_message ILIKE 'importing a module script failed%'
      OR error_message ILIKE 'unable to preload css%');
  ```
  Go/no-go: `missing/total` near 0 → flip the rule on; otherwise fixing SDK
  `release` config is part of the family-rule rollout — without it the release
  gate never engages and the family group reopens every deploy.

### Validation gates (unchanged)

- Committed fixture of minimal fingerprint inputs (platform/type/message/stack
  only — no full events, no PII), golden tests pinning real prod payloads.
  This corpus can only exercise rungs 0/1/3. **Rung 2 needs its own vector
  corpus:** a tiny synthetic build (reuse `test-fixtures/vue-app`) checked in
  with its emitted bundle, source map, and debug ID, plus expected resolved
  frames — the same vectors double as the Go/TS resolver parity fixtures.
  Corollary for the shadow gate: with prod map coverage at zero, the prod shadow
  run validates rungs 0/1/3 only; rung 2's gate runs on the synthetic corpus
  plus whatever partner maps exist by build-order step 3, and that limitation is
  stated in the gate report rather than papered over.
- Each rung flips on only after a shadow-compute over all 6,721+ stored events,
  with the predicted merge count written down BEFORE the run and a manual pass
  over the per-project merge list (count is a summary, the list is the gate).

### Build order

1. Suppression + family rule (no sourcemap dependency; kills most of the 145-group mess).
2. Go resolver + key table. The resolver is NEW GO CODE in ingestion (see Runtime
   ownership above) — upgrading `packages/worker/src/source-map.ts` does not
   enable ingest grouping, since fingerprinting happens in the Go service. The
   worker resolver's verified gaps still inform the parity fixtures: no in-app
   flag, and `parseStackFrames` only matches V8's `at fn (url:l:c)` format —
   Firefox/Safari `fn@url:l:c` frames don't parse at all, so those browsers would
   fail rung 2's gate even with perfect maps. The engine-agnostic parser (Go,
   with TS kept in parity via the shared vectors) is part of this item, not
   optional polish.
3. Ingest symbolication + rung 2. "Bounded, never blocks" concretely: symbolication
   runs synchronously before the group upsert (it must — the fingerprint depends
   on it) under a hard per-event deadline (~150ms), against an in-process LRU
   cache keyed by debug ID, with negative caching (TTL, so a known-missing map
   isn't re-fetched per event) and a circuit breaker on map-store outage.
   Deadline exceeded, cache miss + fetch fail, breaker open — all mean the event
   takes rung 3 *now*; a later event that resolves attaches the fine key via the
   key table. No retroactive regrouping of already-stored events, ever.
4. Fingerprint audit record — later, if ever.

### Deferred (improve-over-time list)

- Rung-3 engine-phrasing canonicalization (30-line follow-up if shadow data warrants).
- Suppression sentinel sampling (add if a drop counter ever spikes anomalously).
- Any versioning / dual-hash machinery (alias table covers the late-map case;
  cutover is hard by decision).
- Frame-churn hardening beyond rung 2 (fn-collapse etc.) — dead once maps work.
- Stable enclosing-function identity for rung 2 (context-line text or
  sourcesContent parsing) — replaces the v1 `file:originalLine` identity if
  line-churn on edited files shows up as re-split groups in practice.
