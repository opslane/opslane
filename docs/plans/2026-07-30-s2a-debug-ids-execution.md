# S2a Debug IDs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stamp a deterministic fingerprint into every Vite-built chunk and its source map, and carry that fingerprint into the stored error event, so the worker can later pair a crash frame to the exact map that explains it without anyone maintaining a version string.

**Architecture:** A pure hashing core, implemented once in TypeScript and once in Go, driven by a single shared vector file so the two can never silently diverge. A Vite plugin computes the fingerprint from the emitted `.map` asset, stamps it into both the JS and the map, and registers it at runtime. The browser SDK reads that registry at crash time and attaches `debug_meta.images` to the outgoing event. Ingestion validates and persists it without ever rejecting a real error event.

**Tech Stack:** TypeScript (browser SDK + Vite plugin, MIT), Go 1.25 (ingestion, AGPL-3.0-only), PostgreSQL, Vitest, Playwright, `@jridgewell/trace-mapping`, `github.com/gowebpki/jcs`.

**Governing contract:** `docs/design/2026-07-29-keys-sourcemaps-s0-contracts.md` §5, §6, §12. That document is frozen. Implement it; do not redesign it.

**Design rationale:** `docs/design/2026-07-30-s2a-debug-ids.md`. Read it before Task 5.

---

## Before you start

Read these three things. They will save you a day each.

1. **`docs/design/2026-07-30-s2a-debug-ids.md` §5.2.** It contains six measured facts about how Vite behaves. Three of them contradicted the first draft of this design. If you skip it you will rediscover them the hard way.

2. **The build tool is not one engine.** Vite 6 and 7 use Rollup. Vite 8 uses Rolldown. The plugin must work on all three; they are peer-supported in `packages/sdk/package.json`.

3. **Two things about JavaScript that break the obvious implementation:**
   - `JSON.stringify` on a key-sorted object does **not** produce RFC 8785 output. JavaScript puts integer-like keys first, so `{"10":1,"2":1}` serializes as `{"2":1,"10":1}`. You must emit members by hand.
   - `JSON.parse` cannot detect duplicate keys. It builds the object with last-write-wins and only then walks it, so a reviver never sees the shadowed member. You need your own scan over the raw bytes.

### Repo setup

```bash
cd /path/to/worktree
pnpm install --frozen-lockfile
pnpm --filter @opslane/shared build
pnpm --filter @opslane/agent-core build   # or worker tests fail to resolve it
```

Verify a clean baseline before writing code:

```bash
pnpm --filter @opslane/worker test    # Test Files 50 passed | 6 skipped (56)
pnpm --filter @opslane/worker build   # passes; there is no pre-existing tsc failure
```

### Two rules that apply to every task

**Never use `git commit -am`.** Always stage explicit paths. Several tasks touch the
same packages, and a blanket `-a` absorbs another task's in-flight edits into the wrong
commit. Every commit block below names its files.

**Run the tasks in order.** The parallelisation table at the end is a dependency map for
planning, not permission to run lanes concurrently in one worktree: they share a git
index, `packages/sdk/package.json`, and `pnpm-lock.yaml`. Parallel execution needs
separate worktrees.

**`docs-sync` pushes commits.** `.github/workflows/docs-sync.yml` does not merely flag
stale docs; it can generate and push a commit onto your branch, which cancels in-flight
CI. Expect it after any task that touches a path listed in a doc's `covers:` block.

---

## Task 1: The shared vector file

The single artifact that keeps TypeScript and Go honest. It stores **raw input bytes as base64**, not JSON objects, because half the cases are inputs that are malformed on purpose and a JSON object cannot express a duplicate key, a byte-order mark, or invalid UTF-8.

**Files:**
- Create: `test-fixtures/debug-id/vectors.json`
- Create: `test-fixtures/debug-id/README.md`

**Step 1: Write the three frozen vectors from S0 §6.1**

Each entry is `{ name, input_b64, outcome, canonical_b64?, sha256?, debug_id?, reject_reason? }`.

Use this script to generate the file so the base64 is correct. Create `test-fixtures/debug-id/build-vectors.mjs`:

```js
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// The three S0 §6.1 vectors, written as exact source text so escapes are visible.
const V1 = '{"debugId":"ffffffff-ffff-ffff-ffff-ffffffffffff","version":3,"sources":["src/a.ts"],"names":[],"mappings":"AAAA","sourcesContent":["export const x = 1;\\n"]}';
const V1_CANON = '{"mappings":"AAAA","names":[],"sources":["src/a.ts"],"sourcesContent":["export const x = 1;\\n"],"version":3}';

const cases = [
  {
    name: 'basic-debugid-excluded',
    input_b64: b64(V1),
    outcome: 'ok',
    canonical_b64: b64(V1_CANON),
    sha256: '158399f31dad138635b298c34317d52e058db2d329438e3161b0c04bcd82b9df',
    debug_id: '158399f3-1dad-1386-35b2-98c34317d52e',
  },
];
writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify({ version: 1, cases }, null, 2) + '\n');
console.log('wrote', cases.length, 'cases');
```

**Step 2: Verify the frozen vector reproduces**

```bash
node -e '
const {createHash}=require("crypto");
const c=`{"mappings":"AAAA","names":[],"sources":["src/a.ts"],"sourcesContent":["export const x = 1;\\n"],"version":3}`;
const h=createHash("sha256").update(Buffer.from(c,"utf8")).digest("hex");
console.log(h);
console.log(h===("158399f31dad138635b298c34317d52e058db2d329438e3161b0c04bcd82b9df")?"MATCH":"MISMATCH");
'
```

Expected: `MATCH`.

**If it mismatches, stop.** Either the canonical string above has a typo or your understanding of the encoding is wrong. Do not proceed by adjusting the expected hash — that value is frozen in a merged contract.

**Step 3: Add the other two frozen vectors and the rejection cases**

Add to `cases`, following S0 §6.1 for the two remaining `ok` vectors (Unicode/nested extensions with sha256 `34dcf2e1…`, and escapes/control characters with sha256 `197a3f87…`).

Then add one rejection case per class. These are the ones that need raw bytes:

Build each from **exact bytes**, not prose. Ellipses in a fixture are how two
implementations end up testing different things. Append to the generator:

```js
const MIN = '{"version":3,"sources":[],"names":[],"mappings":"","sourcesContent":[]}';
const raw = (bytes) => Buffer.from(bytes).toString('base64');

const rejects = [
  // BOM: EF BB BF then the minimal valid map.
  ['reject-bom', 'bom', raw([0xEF,0xBB,0xBF, ...Buffer.from(MIN,'utf8')])],
  // Duplicate root key, after unescaping: "version" and "\u0076ersion".
  ['reject-duplicate-key', 'duplicate_key',
   b64('{"version":3,"\\u0076ersion":3,"sources":[],"names":[],"mappings":"","sourcesContent":[]}')],
  // 0xFF is never valid UTF-8; place it inside a string value.
  ['reject-invalid-utf8', 'invalid_utf8',
   raw([...Buffer.from('{"version":3,"mappings":"','utf8'), 0xFF, ...Buffer.from('"}','utf8')])],
  ['reject-trailing-data', 'trailing_data', b64(MIN + '{}')],
  // Depth counts the root value as depth 1, so 65 opening brackets exceeds 64.
  ['reject-depth', 'depth_exceeded', b64('['.repeat(65) + ']'.repeat(65))],
  ['reject-lone-surrogate', 'invalid_unicode',
   b64('{"version":3,"names":["\\ud800"],"sources":[],"mappings":"","sourcesContent":[]}')],
  ['reject-non-finite', 'non_finite_number',
   b64('{"version":3,"x":1e400,"sources":[],"names":[],"mappings":"","sourcesContent":[]}')],
];
for (const [name, reject_reason, input_b64] of rejects) {
  cases.push({ name, input_b64, outcome: 'reject', reject_reason });
}
```

**Depth origin is defined here:** the root value is depth 1. A 64-deep document is
accepted; 65 is rejected. Both implementations must use this origin or the boundary
case disagrees.

**Also add the accepted-map shape rejections from S0 §6.** The fingerprint is only half
the contract; a map is valid only when the root is an object, `version` is exactly `3`,
`sections` is absent, `sources`/`names`/`mappings` carry their ECMA-426 types, and
`sourcesContent` is an array of strings the same length as `sources`. One rejection case
each, reasons `bad_version`, `indexed_map`, `bad_field_type`, `sources_content_mismatch`.

**Step 4: Add the stamped-map stability case**

Take vector 1, add back `"debugId":"158399f3-1dad-1386-35b2-98c34317d52e"` at the root, and assert the same `debug_id`. This is the property the whole design rests on: stamping must not move the fingerprint.

**Step 5: Write the README**

`test-fixtures/debug-id/README.md` must say: the file is append-only in the same sense as `test-fixtures/wire/`, expected values come from a third-party implementation and never from our own code, and adding a case on one side fails the other until both agree.

**Step 6: Commit**

```bash
git add test-fixtures/debug-id/
git commit -m "test(debug-id): add frozen cross-language hash vectors"
```

---

## Task 2: The TypeScript hashing core

**Files:**
- Create: `packages/sdk/src/build/debug-id.ts`
- Create: `packages/sdk/src/__tests__/debug-id.test.ts`

Location matters: `src/build/`, not `vite-plugin/`. The core is bundler-neutral and a second adapter must import it rather than copy it.

**Step 1: Write the failing test**

```ts
// packages/sdk/src/__tests__/debug-id.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDebugId, DebugIdError } from '../build/debug-id.js';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(here, '../../../../test-fixtures/debug-id/vectors.json'), 'utf8'),
) as { cases: Array<{ name: string; input_b64: string; outcome: string; sha256?: string; debug_id?: string; reject_reason?: string }> };

describe('computeDebugId', () => {
  for (const c of vectors.cases.filter((x) => x.outcome === 'ok')) {
    it(`${c.name}: matches the frozen fingerprint`, async () => {
      const bytes = Buffer.from(c.input_b64, 'base64');
      const result = await computeDebugId(new Uint8Array(bytes));
      expect(result.contentSha256).toBe(c.sha256);
      expect(result.debugId).toBe(c.debug_id);
    });
  }

  for (const c of vectors.cases.filter((x) => x.outcome === 'reject')) {
    it(`${c.name}: rejects with ${c.reject_reason}`, async () => {
      const bytes = Buffer.from(c.input_b64, 'base64');
      await expect(computeDebugId(new Uint8Array(bytes))).rejects.toThrow(
        expect.objectContaining({ reason: c.reject_reason }),
      );
    });
  }
});
```

**Step 2: Run it and watch it fail**

```bash
pnpm --filter @opslane/sdk exec vitest run src/__tests__/debug-id.test.ts
```

Expected: fails to resolve `../build/debug-id.js`.

**Step 3: Implement the core**

`packages/sdk/src/build/debug-id.ts`. Four parts, in order:

1. **Check the BOM on the raw bytes, before decoding.** `TextDecoder` with
   `ignoreBOM: false` silently *strips* a leading `EF BB BF`; it does not throw.
   Verified:

   ```
   new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode([EF,BB,BF,7B,7D])
     -> did NOT throw, length 2, first char "{"
   ```

   So: if `bytes[0..2]` is `EF BB BF`, throw `DebugIdError('bom')` yourself. Then decode
   with `{ fatal: true, ignoreBOM: true }`, which throws on invalid UTF-8 and leaves any
   other U+FEFF in place as ordinary content.

2. **Scan** the decoded text with a hand-written tokenizer that tracks depth and, for each object, the set of member names **after unescaping**. Duplicate name → `duplicate_key`. Depth over 64 → `depth_exceeded`. Content after the top-level value → `trailing_data`. A lone surrogate in any string → `invalid_unicode`. A numeric literal that parses to a non-finite double → `non_finite_number`.

3. **Canonicalize.** Recursively emit:
   - objects: sort member names by UTF-16 code unit (`a < b ? -1 : a > b ? 1 : 0` on the raw JS string), emit `{"k":v,...}` by hand, never via a rebuilt object;
   - arrays: preserve order;
   - strings: `JSON.stringify(s)` is correct here, it matches the standard's escaping;
   - numbers: `JSON.stringify(n)`, which is ECMAScript number-to-string and is what the standard requires;
   - remove **only** the root-level `debugId` member, before sorting.

4. **Hash.** `crypto.subtle.digest('SHA-256', canonicalBytes)`, take bytes 0..15, format lowercase `8-4-4-4-12`. **Do not** rewrite version or variant bits.

Use `crypto.subtle`, never `node:crypto`. `packages/sdk/vite.config.ts:14-27` declares
three entries (`index`, `react`, `vite-plugin`) and this file is not one of them: it is
pulled in as a dependency of the `vite-plugin` entry, which is built for the browser
target alongside the others. A `node:` import there becomes a stub that throws inside the
customer's build. `crypto.subtle.digest` is a global in Node 18+ and every target
browser. This makes the function async; Task 5 accounts for it.

**Step 4: Run the tests**

```bash
pnpm --filter @opslane/sdk exec vitest run src/__tests__/debug-id.test.ts
```

Expected: all vector cases pass.

**Step 5: Add the packaging guard**

The failure this prevents is silent and only appears in a customer's build.

**Do not grep for the bare string `node:`.** The bundled rrweb chunk contains 18
occurrences of ordinary object shorthand like `{ node: E, visitors`, so that guard fails
on the first run against an untouched build. Match actual import specifiers instead:

```js
// packages/sdk/scripts/check-package.mjs
const NODE_BUILTIN_IMPORT = /(?:from\s*["']|require\(\s*["']|import\(\s*["'])node:[a-z_]+["']/;
```

Verified: that pattern currently matches zero times across `dist/`, while a bare
`node:` search matches 18.

```bash
pnpm --filter @opslane/sdk build && pnpm --filter @opslane/sdk check:package
```

Expected: passes.

**Step 6: Commit**

```bash
git add packages/sdk/src/build/debug-id.ts packages/sdk/src/__tests__/debug-id.test.ts packages/sdk/scripts/check-package.mjs
git commit -m "feat(sdk): add RFC 8785 debug-ID core with frozen vector coverage"
```

---

## Task 3: The Go hashing core

**Files:**
- Create: `packages/ingestion/debugid/debugid.go`
- Create: `packages/ingestion/debugid/debugid_test.go`
- Modify: `packages/ingestion/go.mod`

**Step 1: Write the failing test**

Read the same `test-fixtures/debug-id/vectors.json` (path from this package: `../../../test-fixtures/debug-id/vectors.json`). Table-drive over `cases`, asserting `ContentSHA256` and `DebugID` on `ok`, and the exact reason string on `reject`.

**Step 2: Run it and watch it fail**

```bash
cd packages/ingestion && go test ./debugid/...
```

Expected: build failure, no such package.

**Step 3: Add the dependency**

```bash
cd packages/ingestion && go get github.com/gowebpki/jcs
```

Check the licence before committing. It must be Apache-2.0 or compatible with this package's AGPL-3.0-only. Record what you found in the commit message.

**Step 4: Implement**

Same parts as Task 2, plus the accepted-map shape checks.

**Removing the root `debugId` is a separate step and easy to get wrong.**
`jcs.Transform` canonicalizes whatever bytes you hand it, so transforming the original
input hashes the member the contract says to exclude. Order:

1. raw-byte scan (BOM, UTF-8, depth, duplicate keys after unescaping, trailing data);
2. `json.Decoder` with `UseNumber()` into `map[string]json.RawMessage`;
3. `delete(root, "debugId")` — root level only, never nested;
4. `json.Marshal` the reduced map;
5. `jcs.Transform` those bytes;
6. `sha256.Sum256`.

Step 4 is safe because step 5 re-canonicalizes; Go's map ordering does not survive into
the digest.

The two rejections that exist only because the languages disagree — lone surrogates and non-finite numbers — must be explicit checks here too. Go's decoder silently substitutes U+FFFD for a lone surrogate; JavaScript re-emits it. Neither is wrong, they just differ, so both sides reject.

**Step 5: Run the tests**

```bash
cd packages/ingestion && go test ./debugid/... -v
```

Expected: every vector case passes, same names as the TypeScript run.

**Step 6: Commit**

```bash
git add packages/ingestion/debugid packages/ingestion/go.mod packages/ingestion/go.sum
git commit -m "feat(ingestion): add Go debug-ID core matching the TypeScript vectors"
```

---

## Task 4: Prove PostgreSQL keeps all 128 bits

Debug IDs deliberately do not carry RFC UUID version or variant bits. This test exists so a future PostgreSQL upgrade that starts normalizing them fails loudly here rather than silently in production.

**Files:**
- Create: `packages/ingestion/db/debugid_storage_test.go`

**Step 1: Write the test**

Insert `158399f3-1dad-1386-35b2-98c34317d52e` into a `uuid` column in a temporary table created inside the test transaction, read it back as text, and compare exactly.

**Step 2: Run against a disposable database**

Do **not** point this at a shared local database; other worktrees use port 5434.

```bash
docker run -d --rm --name s2a-pg -e POSTGRES_PASSWORD=opslane \
  -e POSTGRES_USER=opslane -e POSTGRES_DB=opslane -p 55432:5432 postgres:16
until docker exec s2a-pg pg_isready -U opslane >/dev/null 2>&1; do sleep 1; done

cd packages/ingestion && \
  DATABASE_URL='postgres://opslane:opslane@localhost:55432/opslane?sslmode=disable' \
  go test ./db/... -run TestDebugIDStorage -v

docker stop s2a-pg
```

Expected: PASS.

**The test must not silently skip.** The existing db helpers skip when PostgreSQL is
unavailable, and `.github/workflows/ci.yml:167-171` runs
`scripts/check-go-skips.mjs` over the test log and **fails the build on an unexpected
skip**. So either register this test in that script's allowlist or make it fail, not
skip, when `DATABASE_URL` is unset.

**Step 3: Commit**

```bash
git commit -am "test(ingestion): prove PostgreSQL preserves raw debug-ID bits"
```

---

## Task 4b: Plugin API and the contracts both sides share

Do this **before** Task 5. Tasks 5, 6, 7, 9 and 11 all reference the plugin factory, its
options, and the runtime registry. If those are defined in a later task, the earlier ones
cannot compile, and two engineers working from prose will build a producer and a consumer
that do not agree.

**Files:**
- Modify: `packages/sdk/vite-plugin/index.ts`
- Create: `packages/sdk/src/build/registry-contract.ts`
- Modify: `packages/sdk/package.json`, `pnpm-lock.yaml`

**Step 1: Add the build-time dependencies**

`@jridgewell/trace-mapping` is currently declared only by the worker
(`packages/worker/package.json:21`), so Tasks 5 and 7 fail to resolve it from the SDK.
`magic-string` is transitive only, and Task 5's fallback path needs it directly.

```bash
pnpm --filter @opslane/sdk add -D @jridgewell/trace-mapping magic-string
```

Both are devDependencies: they are used by the plugin at build time and by tests, and
must not enter the published browser bundle. Re-run the licence gate, which is real and
runs in CI (`.github/workflows/ci.yml:245`, `scripts/check-licenses.mjs`):

```bash
node scripts/check-licenses.mjs
```

**Step 2: Name the plugin factory**

```ts
export interface OpslaneViteOptions {
  commitSha?: string;                              // explicit override; detection is a convenience over it
  stamp?: boolean;                                 // default true; the escape hatch for integrity-checked builds
  logLevel?: 'silent' | 'warn' | 'debug';          // default 'warn'
  sourcemaps?: 'remove' | 'keep';                  // default 'remove'
  maxMapBytes?: number;                            // default 32 * 1024 * 1024, measured on the RAW asset bytes
}

export function opslaneVitePlugin(options?: OpslaneViteOptions): Plugin { /* Task 5 */ }
export { opslaneVitePlugin as opslane };
```

`opslaneSourceMapPlugin` keeps its name, its options **and its existing upload
behaviour**, and gains `@deprecated`. Keeping the signature while changing the behaviour
is a breaking change wearing a compatible version number.

**Step 3: Freeze the runtime registry contract**

This is the seam between the plugin (producer) and the SDK (consumer). Write it down
once, here, and have both import the constants.

```ts
// packages/sdk/src/build/registry-contract.ts
/** Global the plugin writes and the SDK reads. Frozen: changing it breaks old builds. */
export const REGISTRY_GLOBAL = '__OPSLANE_DEBUG_IDS__';
/** Compile-time constant the plugin defines and the SDK reads for build provenance. */
export const COMMIT_SHA_GLOBAL = '__OPSLANE_COMMIT_SHA__';
/** Exact sentinel the plugin emits and then substitutes. 36 chars, matches a debug ID. */
export const DEBUG_ID_PLACEHOLDER = '0PSLANE-P14C3-H01D-3R00-000000000000';

/** module URL -> every distinct debug ID registered for that URL. */
export type DebugIdRegistry = Record<string, string[]>;
```

Nine decisions, each of which two engineers would otherwise settle differently:

**Value shape is an array, not a string.** An earlier draft said "last write wins, and
the SDK's ambiguity rule discards that file." That is self-contradictory: if the write
overwrites, the SDK never sees two IDs and the ambiguity rule can never fire. The
registry maps a URL to the distinct IDs registered for it. One entry is the normal case;
two means two builds are live on one page, and the SDK discards that file rather than
guessing.

**Created with `Object.create(null)`.** The keys are URLs from an untrusted page. A
`{}` literal inherits `__proto__`, which has setter behaviour rather than being an
ordinary key.

**URL identity is exact string equality** on whatever the engine reports, with no
normalization: no query stripping, no fragment stripping, no percent-decoding, no
relative-to-absolute resolution. The worker joins on exact `code_file` in S3, so any
normalization here has to be mirrored there or the join silently breaks. If a URL differs
between registration and the stack frame, the correct outcome is no match, which the
zero-matched counter surfaces.

**Existing-global validation.** A truthiness check accepts a string, an array, or a
hostile object. Verify it is a non-null object before use, and replace it if not.

**`document.currentScript` may be null**, notably under SystemJS and for asynchronously
executed chunks, where it can also point at the loader rather than the chunk. When it is
null or has no `src`, skip registration and register nothing. Never fall back to a
guess.

**Test seam:** tests assign `globalThis[REGISTRY_GLOBAL]` directly. There is no
registration API.

**`COMMIT_SHA_GLOBAL` is a string**, injected as a compile-time identifier replacement
via Vite `define`, so it participates in the content hash. When no commit is detected the
plugin defines nothing and the identifier is absent; the SDK must feature-test rather
than compare against a sentinel.

**Step 4: Freeze the prelude text**

Two forms. The **script form must be ES5**; the ESM form cannot be, because
`import.meta.url` is ESM syntax by definition. Assert accordingly in Task 6: parse the
script prelude with `ecmaVersion: 5`, and the ESM prelude with
`ecmaVersion: 2020, sourceType: 'module'`. Neither uses arrow functions, `let`, `const`,
optional chaining or `||=`, because esbuild lowers code in `renderChunk`, before
`generateBundle`, so whatever is written here ships verbatim.

```js
// ESM chunks (outputOptions.format === 'es'):
;(function(){try{var g=typeof globalThis!=="undefined"?globalThis:self;var r=g.__OPSLANE_DEBUG_IDS__;if(!r||typeof r!=="object"){r=g.__OPSLANE_DEBUG_IDS__=Object.create(null)}var k=import.meta.url;if(k){var a=r[k];if(!a){a=r[k]=[]}if(a.indexOf("0PSLANE-P14C3-H01D-3R00-000000000000")<0){a.push("0PSLANE-P14C3-H01D-3R00-000000000000")}}}catch(e){}})();

// Script chunks (iife | umd | cjs | system):
;(function(){try{var g=typeof globalThis!=="undefined"?globalThis:self;var r=g.__OPSLANE_DEBUG_IDS__;if(!r||typeof r!=="object"){r=g.__OPSLANE_DEBUG_IDS__=Object.create(null)}var d=typeof document!=="undefined"&&document.currentScript;var k=d&&d.src;if(k){var a=r[k];if(!a){a=r[k]=[]}if(a.indexOf("0PSLANE-P14C3-H01D-3R00-000000000000")<0){a.push("0PSLANE-P14C3-H01D-3R00-000000000000")}}}catch(e){}})();
```

Both are one line, so the `mappings` shift in Task 5 is exactly one `;`.

Substitution is a plain replace of `DEBUG_ID_PLACEHOLDER` with the computed ID, which is
also 36 characters, so the byte length is unchanged and the shift stays correct. The
sentinel is deliberately not valid hex, so a build that ships with it unsubstituted is
obvious in the output and fails the Task 6 assertion rather than looking like a real ID.

A CJS bundle under Node takes the `typeof document !== "undefined"` branch, registers
nothing, and throws nothing.

**Step 5: Commit**

```bash
git add packages/sdk/vite-plugin/index.ts packages/sdk/src/build/registry-contract.ts \
        packages/sdk/package.json pnpm-lock.yaml
git commit -m "feat(sdk): freeze the plugin API and runtime registry contract"
```

---

## Task 5: Prove the build-tool contract, then write the plugin

**This task gates everything after it and may change the design.** Do the probe before writing plugin code.

**Files:**
- Create (throwaway): a scratch probe script, not committed
- Modify: `packages/sdk/vite-plugin/index.ts`

**Step 1: Write the probe**

Two things the probe must handle or it will not run at all.

**Loading three Vite versions.** They live in pnpm's store under peer-suffixed
directories, so a plain `import 'vite'` gets you one of them. Resolve by glob:

```js
const viteFor = (v) => {
  const [dir] = globSync(`node_modules/.pnpm/vite@${v}_*/node_modules/vite`, { cwd: repoRoot });
  return import(path.join(repoRoot, dir, 'dist/node/index.js'));
};
// 6.4.3 and 7.3.6 are Rollup; 8.1.5 is Rolldown.
```

**Bypassing the fixture's own config.** `test-fixtures/vue-app/vite.config.ts:3-12`
already loads `opslaneSourceMapPlugin`, which deletes `.map` assets. Pass
`configFile: false` and supply the plugin list yourself, or the probe measures the legacy
plugin's behaviour instead of yours.

In a plugin with `enforce: 'post'`, in `generateBundle`:

1. Insert a one-line prelude at the top of a chunk.
2. Prepend one `;` to the `mappings` of the sibling `.map` **asset** (`bundle[key + '.map'].source`), not `chunk.map`.
3. Compute the fingerprint from that corrected map.
4. After the build, resolve the first, middle and last mapped positions with `originalPositionFor` and check each lands on the right original line.
5. Recompute the fingerprint from the map **as written to disk** and check it equals the one embedded in the JS.

**Step 2: Write down the pass criterion before you run it**

Pass: the on-disk map recomputes to the embedded ID, and all three positions resolve correctly, on all three versions.

Fail: switch to `renderChunk` returning `{ code, map }` with a magic-string-generated mapping adjustment, and re-run the same probe. Budget a day for that branch; it discards the seven-step sequence below.

**Step 3: Run it**

Expected, based on the measurements in the design doc §5.2:

| Question | Expected |
|---|---|
| Does the `chunk.code` edit reach disk? | yes, all three |
| Is the filename hash recomputed after? | **no** |
| Prelude without the `mappings` shift? | **resolves to the wrong line, silently** |
| Does the `;` prepend fix it? | yes |
| Does editing `chunk.map` change the emitted `.map`? | **no** |

**Step 3b: Decide the failure policy before writing code**

Two rules, because Task 6 tests them and neither is derivable from "never fail the
build":

- **Per-chunk catch, not per-bundle.** One unparseable map skips that chunk and counts
  it; the other 247 still get stamped. A bundle-level catch loses the whole build's
  fingerprints to one bad file.
- **A chunk is stamped atomically or not at all.** Compute everything first, then write
  `chunk.code` and `asset.source` together. Never leave a chunk carrying a prelude whose
  placeholder was never substituted.

The size guard is `maxMapBytes`, default `32 * 1024 * 1024`, measured on the **raw
`.map` asset bytes before parsing**, not on canonical output. Over the limit: skip the
chunk, count it, name it in the summary line.

**Step 4: Write the plugin, in this order per chunk**

```
1. parse asset.source            (accept string and Uint8Array)
2. insert prelude AFTER any directive prologue or shebang
3. prepend one ';' to mappings PER LINE INSERTED
4. compute debug_id + content_sha256 from the corrected map
5. substitute the real ID for the fixed-width placeholder
6. set root debugId on the map, reserialize to asset.source
7. append `//# debugId=<id>` to the chunk
```

Step 2 matters: prepending ahead of `'use strict';` demotes it to an ordinary expression and silently turns strict mode off for the chunk.

Step 5 uses a fixed 36-character placeholder so the prelude stays exactly one line whatever the ID turns out to be, which keeps the shift computed in step 3 correct.

**Step 5: Branch the prelude on output format**

`import.meta` is a **syntax error** in `iife`, `umd`, `cjs`, and `system`, which is what `@vitejs/plugin-legacy` and `build.lib` emit. The build stays green and the customer's site is blank.

| `outputOptions.format` | Prelude key |
|---|---|
| `es` | `import.meta.url` |
| `iife`, `umd`, `cjs`, `system` | `document.currentScript && document.currentScript.src` |
| anything else | skip the chunk, count it |

Pin the prelude to ES5 syntax. esbuild lowers code in `renderChunk`, which runs *before* `generateBundle`, so whatever you write ships verbatim. No `||=`, no arrow functions.

**Step 6: Honour an explicit `build.sourcemap`**

| Value | Behaviour |
|---|---|
| unset (Vite default `false`) | request `'hidden'`, stamp, drop the `.map` assets |
| `'hidden'` | stamp, drop the `.map` assets |
| `true` | stamp, **leave assets alone**, log once |
| `'inline'` | skip stamping, log that inline maps publish source to the CDN, name `'hidden'` as the fix |
| `false`, explicitly set | no map exists; log once and exit |

**Step 7: Commit**

```bash
git add packages/sdk/vite-plugin/index.ts
git commit -m "feat(sdk): stamp deterministic debug IDs into chunks and maps"
```

---

## Task 6: Plugin unit tests

**Files:**
- Modify: `packages/sdk/src/__tests__/vite-plugin.test.ts`

One test each, all of which correspond to a way the plugin can silently ruin a customer's build:

1. One case per `build.sourcemap` value in the Task 5 table.
2. One case per output format, including an assertion that a non-ESM chunk contains **no** `import.meta`.
3. A chunk whose first line is `'use strict';` keeps it as the first statement.
4. A chunk with a `#!` shebang keeps it on line 1.
5. The emitted prelude parses under the lowest supported `build.target`.
6. A map above the size guard is skipped and counted, build still exits 0.
7. The plugin throws internally, the build still exits 0.
8. No `.map` file in the output for the default configuration.

```bash
pnpm --filter @opslane/sdk exec vitest run src/__tests__/vite-plugin.test.ts
git commit -am "test(sdk): cover plugin behaviour per sourcemap value and output format"
```

---

## Task 7: Determinism and integrity

**Files:**
- Create: `packages/sdk/src/__tests__/debug-id-determinism.test.ts`

**Step 1: Build the fixture twice from two different working directories**

Not the same directory twice. If a map's `sources` carry absolute paths, the fingerprint
becomes a function of the build machine, and two machines produce one filename over two
different byte strings. A same-directory double build cannot see that.

**Keep workspace resolution working in both copies.** `test-fixtures/vue-app` depends on
`@opslane/sdk` via `workspace:*`, which breaks the moment you copy the directory outside
the workspace. Copy only the sources into each temp directory and point the build at them
with an explicit `root`, resolving `vue` and the plugin from the repo's own
`node_modules` (the same technique the Task 5 probe uses). Do not run `pnpm install` in
the copies.

**Step 2: Assert**

- every emitted file is byte-identical across the two builds;
- every chunk's debug ID is identical;
- no `sources` entry is absolute or contains either build directory;
- reopening the retained map and resolving the first, middle and last positions gives the right original lines.

Use the `sourcemaps: 'keep'` option from Task 5 so the test can read the map it just hashed.

```bash
pnpm --filter @opslane/sdk exec vitest run src/__tests__/debug-id-determinism.test.ts
git commit -am "test(sdk): prove debug IDs are stable across build directories"
```

---

## Task 8: Shared wire types

**Files:**
- Modify: `shared/src/types.ts`

Add to `ErrorEventPayload`, exactly as frozen in S0 §5:

```ts
export interface DebugImage {
  type: 'sourcemap';
  code_file: string;
  debug_id: string;
}

export interface DebugMeta {
  images?: DebugImage[];
}
```

and on `ErrorEventPayload`: `commit_sha?: string;` and `debug_meta?: DebugMeta;`.

```bash
pnpm --filter @opslane/shared build && pnpm -r build
git commit -am "feat(shared): add debug_meta and commit_sha to the event payload"
```

---

## Task 9: SDK image assembly

**Files:**
- Create: `packages/sdk/src/debug-images.ts`
- Create: `packages/sdk/src/__tests__/debug-images.test.ts` (the Task 10 list; written here, first)
- Modify: `packages/sdk/src/core.ts` (attach `debug_meta` and `commit_sha` to the payload)
- Modify: `packages/sdk/src/transport.ts` (assembly runs after scrubbing; see step 3)

**Land these in one commit.** A static import of a file that does not exist yet fails at
`tsc`, not at runtime, so a split commit breaks the build. The test file is part of this
commit too: the plan says write it first, so it cannot be deferred to Task 10's commit.
Task 10 then only extends it.

**`commit_sha` is wired here, and nowhere else.** Task 4b froze `COMMIT_SHA_GLOBAL`; the
plugin defines it at build time; `buildPayload` in `core.ts` reads it and sets
`commit_sha` when it is 40 or 64 lowercase hex, omitting the field otherwise. Without
this step nothing ever emits the field and Task 15's `v2.1.0-full.json` cannot be
produced.

**Step 1: Write the failing tests first** (Task 10 has the list).

**Step 2: Implement, with the ordering fixed**

```
validate each entry's shape
  -> collapse exact (code_file, debug_id) duplicates
  -> discard EVERY entry for any code_file claiming two different IDs,
     computed over the WHOLE list
  -> take the first 64 in captured stack order
  -> drop from the tail until the serialized size fits the byte budget
```

The order is observable, not cosmetic. Truncating to 64 first lets a conflicting entry at position 65 escape the ambiguity check, which makes what we store depend on the order things arrived.

The byte budget is last for the same reason: it is a second truncation. 64 images at
S0's 4096-byte `code_file` ceiling is 256 KiB against the 60 KiB unload cap at
`packages/sdk/src/transport.ts:43`, and `:207` always sends at least one event regardless
of size, so an oversized event is lost exactly when it matters.

**The budget is measured on the serialized `debug_meta` object alone**, not the whole
event and not the post-`beforeSend` payload. Cap it at 16 KiB. Rationale: `debug_meta` is
the only field this slice can bound, the rest of the event was already within budget
before it existed, and measuring the whole event would make the cap depend on breadcrumb
volume, which is not this slice's to control.

**Step 3: Two hazards in the existing capture path**

- `core.ts:145-152` appends a synthetic stack after a `--- synthetic caller stack ---` marker. Those frames point at the Opslane SDK's own chunk. Stop URL extraction at that marker.
- Scrubbing happens in `packages/sdk/src/transport.ts:48-75`, after `buildPayload` has
  already run. `scrub.ts:73` rewrites `error.stack`, so a URL that matched at capture
  time may no longer match the stack the worker later joins against.

  **Decision: assemble images inside the transport path, after `scrubEvent`.** That is
  why `transport.ts` is in this task's file list. The alternative (assert scrubbing never
  touches a matched `code_file`) leaves a silent break the first time someone adds a
  pattern that matches a CDN URL.

**Step 4: The distinction that makes field failure visible**

- registry empty → omit `debug_meta` entirely;
- registry non-empty but nothing matched → send `debug_meta: { images: [] }`.

S0 §5 treats omission and an empty array as equivalent, so this is inside the contract. It is the only way the server can tell "never instrumented" from "instrumented and the matching is broken."

```bash
git add packages/sdk/src/debug-images.ts packages/sdk/src/core.ts
git commit -m "feat(sdk): attach debug_meta.images at capture time"
```

---

## Task 10: Engine shape matrix

**Files:**
- Modify: `packages/sdk/src/__tests__/debug-images.test.ts` (created in Task 9)

One case per row, using captured real stacks, not invented ones:

| Shape | Example frame |
|---|---|
| V8 anonymous | `    at https://h/assets/i.js:1:2` |
| V8 named | `    at fn (https://h/assets/i.js:1:2)` |
| Firefox | `fn@https://h/assets/i.js:1:2` |
| Firefox anonymous | `@https://h/assets/i.js:1:2` |
| WebKit | `fn@https://…`, `global code@https://…` |
| eval-wrapped | `at eval (eval at fn (https://h/x.js:1:2))` → innermost real URL |
| Unparseable | no URL → frame skipped, never guessed |

Plus: synthetic frames excluded, ordering rules including a conflict at position 65, a maximal 4096-byte `code_file`, and the empty-array-versus-omitted distinction.

Note `packages/worker/src/source-map.ts:29-48` parses V8 forms only and is **not**
reusable here. (The file is `source-map.ts`, hyphenated.)

```bash
pnpm --filter @opslane/sdk exec vitest run src/__tests__/debug-images.test.ts
git commit -am "test(sdk): cover every engine stack shape and ordering rule"
```

---

## Task 11: Real-browser harness

**Files:**
- Create: `packages/sdk/src/__tests__/debug-id-browser.test.ts`
- Modify: `test-fixtures/vue-app/src/` (add a lazy chunk and a worker), `.github/workflows/ci.yml`

**This is a new harness, not an extension.** The existing
`browser-contract.test.ts` creates a Vite **dev** server at `:84-87`, and the plugin is
`apply: 'build'`, so it never runs there. You need `build()` then `preview()`.

Per-case assertions, so two engineers write the same test:

| Case | Assertion |
|---|---|
| Eager chunk throws | one image; `code_file` equals the chunk URL the browser reports; `error.stack` byte-identical to what the page produced |
| Lazy chunk throws **during module init** | one image; proves the prelude ran before the module body |
| Worker, explicit `captureException` | image comes from the worker's own registry |
| Worker-origin frame seen from the page | **no image**, and the zero-matched counter path is exercised |
| Assets on a second origin | still matches; this is the CDN topology |
| Third-party frame | no image, no crash |
| Unparseable frame | frame skipped, never guessed |

Seed nothing: the registry must be populated by the real build output. That is the point
of the harness.

**On the skip guard.** `describe.skipIf(!playwrightAvailable)` is at `:46`, and
`playwrightAvailable` only checks that Playwright *exports* `chromium`. A missing browser
binary therefore fails at `chromium.launch()` rather than skipping silently, so the
existing risk is a hard failure, not a false pass. Still add firefox and webkit to
`ci.yml:242` (chromium-only today) and assert inside the suite that all three engines
actually ran, so a future refactor of that guard cannot quietly reduce coverage.

```bash
git commit -am "test(sdk): production-build browser matrix across three engines"
```

---

## Task 12: The migration

**Files:**
- Create: `packages/ingestion/db/migrations/028_event_debug_meta.sql`

`scripts/run-migrations.sh:11-14` replays every `.sql` on every boot under `ON_ERROR_STOP=1`, and `db/migrations_test.go:171` (`TestMigrations_AreIdempotent`) enforces it. An unguarded `ADD COLUMN` succeeds once, fails on the next boot, and blocks every later migration behind it.

```sql
SET lock_timeout = '3s';

ALTER TABLE error_events
  ADD COLUMN IF NOT EXISTS debug_meta JSONB NOT NULL DEFAULT '{"images":[]}'::jsonb;
ALTER TABLE error_events
  ADD COLUMN IF NOT EXISTS commit_sha TEXT;

ALTER TABLE error_events DROP CONSTRAINT IF EXISTS error_events_debug_meta_object;
ALTER TABLE error_events ADD CONSTRAINT error_events_debug_meta_object
  CHECK (jsonb_typeof(debug_meta) = 'object') NOT VALID;
ALTER TABLE error_events DROP CONSTRAINT IF EXISTS error_events_commit_sha_hex;
ALTER TABLE error_events ADD CONSTRAINT error_events_commit_sha_hex
  CHECK (commit_sha IS NULL OR commit_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') NOT VALID;

ALTER TABLE error_events VALIDATE CONSTRAINT error_events_debug_meta_object;
ALTER TABLE error_events VALIDATE CONSTRAINT error_events_commit_sha_hex;
```

`lock_timeout` matters more than scan speed. `ADD COLUMN` holds its lock briefly, but a queued lock parks every read on `error_events` behind one long transaction. When the timeout fires the boot fails loudly and retries cleanly, which is the intended trade.

```bash
cd packages/ingestion && go test ./db/... -run TestMigrations_AreIdempotent -v
git commit -am "feat(ingestion): add debug_meta and commit_sha columns"
```

---

## Task 13: Server validation and persistence

**Files:**
- Modify: `packages/ingestion/handler/error_event.go`, `metrics.go`, `db/queries.go`

**Decode both fields as `json.RawMessage`.** `error_event.go:60-81` decodes the whole body in one `json.Unmarshal` and returns `400` on any error. A typed `CommitSHA string` means a payload carrying `"commit_sha": 123` **rejects a real error event**, violating S0 §5's rule that malformed optional metadata never rejects. Follow the pattern already used for `Breadcrumbs`, `Context` and `Runtime` at `:67-70`, then decode container and entries separately.

Discard reasons, fixed and exhaustive, counted in this precedence so a malformed container is never miscounted as a bad ID:

```
malformed_container | malformed_images | non_object_image | bad_type
  | bad_code_file | bad_debug_id | ambiguous_code_file | over_limit
```

plus `commit_sha_discarded`.

**Counting granularity, decided:** discard counters increment **once per discarded
entry**, except `malformed_container` and `commit_sha_discarded`, which are **per
event** because there is only one container and one field. Without this rule the same
payload produces different metric totals depending on who implemented it.

**Exact metric names**, since they become a dashboard contract:

```
opslane_debug_meta_images_discarded_total{reason="..."}
opslane_commit_sha_discarded_total
opslane_events_with_debug_images_total
opslane_events_ingested_total{platform="..."}          # new label on the existing counter
opslane_debug_meta_registry_present_zero_matched_total
```

Metrics. `metrics.go:15-37` has only an unlabeled `eventsIngestedTotal`, so the coverage denominator does not exist yet. Add a platform-labeled counter, then:

- coverage = `events_with_debug_images_total` / `events_javascript_total`
- `debug_meta_registry_present_zero_matched_total`, incremented when `debug_meta` is present with an empty `images` array

The second one is the whole point. It is the only signal that says the mechanism is broken in the field, and without Task 9's empty-array distinction it cannot be computed at all.

`code_file` is stored verbatim, at parity with `stack_trace_raw`. Do not strip query strings: the worker joins on exact match in S3, and a divergent strip silently breaks the join.

```bash
cd packages/ingestion && go build ./... && go test ./handler/...
git commit -am "feat(ingestion): validate and persist debug_meta and commit_sha"
```

---

## Task 14: Server tests through the HTTP handler

**Files:**
- Modify: `packages/ingestion/handler/error_event_test.go`

Drive these through the real handler, not by calling the validator directly. The bug being guarded against lives in the decode step, which a direct validator call skips entirely.

Each case asserts three things, not one: the response is `202`, the **stored** column
holds the expected sanitized value, and the expected discard counter incremented by the
expected amount. Asserting only the status code passes even if the field is silently
dropped.

Every one of these must still return `202`:

`"commit_sha": 123` · `"debug_meta": []` · `"debug_meta": null` · `"debug_meta": "x"` · `{"images": {}}` · `{"images": [1,2]}` · a 65-image list whose 65th conflicts with the 3rd (both discarded) · the same list permuted (identical stored result) · a 4096-byte `code_file` · an uppercase `commit_sha` (dropped, counted).

```bash
cd packages/ingestion && go test ./handler/... -run TestDebugMeta -v
git commit -am "test(ingestion): drive every debug_meta rule through the HTTP handler"
```

---

## Task 15: Wire fixtures and release posture

**Files:**
- Create: `test-fixtures/wire/events/v2.1.0-minimal.json`, `v2.1.0-full.json`
- Modify: `packages/ingestion/handler/wire_compat_test.go`, `packages/sdk/src/__tests__/wire-shape.test.ts`

**Do not bump `packages/sdk/package.json`.** It stays at `2.0.1`.

An earlier plan bumped it to `2.1.0` with no changeset, believing that holds the release. It does not. Verified in the pinned implementation at `@changesets/cli@2.31.1/dist/changesets-cli.cjs.js:1113`:

```js
if (!publishedVersions.includes(localVersion)) {
  packagesToPublish.push(pkgInfo);
```

`release-npm.yml:77` runs `pnpm changeset publish`, which ships any public local version missing from npm regardless of how it got there. A hand-bump pushes a stamp-only SDK to `latest` with no changelog entry.

So: cut the coupling instead. `wire-shape.test.ts:15-21` picks its fixture filename from the package version. Replace that with a `WIRE_FIXTURE_VERSION` constant.

Both harnesses need extending, not just new files. `wire_compat_test.go:22-43` has no `debug_meta` or `commit_sha` fields and its DB assertions at `:176` do not read them, so a new fixture alone proves only that unknown fields still return `202` — which was already true.

And the authored `v2.1.0-full.json` must use a `code_file` that appears in the test's `FIXTURE_STACK` (`:25-26`), otherwise the "only images whose `code_file` appears in the captured stack" rule filters it straight back out.

```bash
pnpm --filter @opslane/sdk test && (cd packages/ingestion && go test ./handler/... -run TestWireCompat)
git commit -am "test(wire): freeze the v2.1.0 debug_meta fixture pair"
```

---

## Task 16: Developer-facing surface

**Files:**
- Modify: `packages/sdk/vite-plugin/index.ts`, `cli/src/doctor.ts`, `scripts/check-packed-packages.mjs`

The options bag and the plugin name were defined in Task 4b. This task implements the
behaviour behind them.

**Subresource Integrity is a site-outage risk.** Our edit lands after the filename hash is computed. That is harmless for the filename, because the edit is derived from the file itself. It is not harmless for anything that precomputed an integrity value: with an SRI plugin, every stamped chunk fails its check, the browser refuses to run it, the page is blank, and no error reaches us because nothing runs. Detect these by plugin name in `configResolved` — `vite-plugin-sri`,
`rollup-plugin-sri`, `@small-tech/vite-plugin-sri`, `vite-plugin-manifest-sri` — skip
stamping, log at error level with code `OPSLANE_VITE_SRI_DETECTED`, and honour
`stamp: false` for anything not on that list. The list is a best effort and the docs must
say so; `stamp: false` is the guarantee.

**A build summary at `closeBundle`.** Two lines, not one:

```text
[opslane] Stamped 248/251 chunks with debug IDs (3 skipped: 2 no map, 1 map over 32 MiB).
[opslane] Commit 4f2a9c1 detected from GITHUB_SHA. Source maps: hidden, removed from output.
```

It prints at `warn` and above, so `logLevel: 'silent'` suppresses it. "Always-on" means
it is not conditional on something having gone wrong, which was the actual defect: every
message in the first draft fired only on failure, so a working build looked identical to
one where the plugin never loaded.

Every message the first draft specified fired on a problem, so a fully working build looked identical to one where the plugin never loaded. Give every failure a stable code (`OPSLANE_VITE_MAP_TOO_LARGE`, `OPSLANE_VITE_SRI_DETECTED`, …) plus problem, cause, fix, and a docs anchor.

**Commit ladder**, explicit override first: `OPSLANE_COMMIT_SHA`, `GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`, `CI_COMMIT_SHA`, `RENDER_GIT_COMMIT`, `BITBUCKET_COMMIT`, `GIT_COMMIT`, `BUILD_SOURCEVERSION`, then `.git/HEAD` off disk. No `git` binary. `COMMIT_REF` is deliberately absent: several platforms use "ref" for a branch name, which silently fails the hex check. Always log which rung won.

**`opslane doctor`** gains a "Debug IDs" check. It resolves the build output in this
order: an explicit `--dist <path>` flag, else `build.outDir` from the project's resolved
Vite config, else `dist/`. It globs `<outDir>/**/*.js`, counts files containing
`//# debugId=`, and returns the existing `CheckResult` shape. Zero stamped chunks with a
non-empty output directory is a failure with a remediation string; a missing output
directory is "not built yet", not a failure. Ten lines against machinery that exists, and the only way a developer confirms this slice did anything.

**`check-packed-packages.mjs:28`** probes only the root entry, so a broken `/vite-plugin` export ships. Extend it to install Vite in the clean consumer and build through both plugin exports.

```bash
git commit -am "feat(sdk,cli): plugin options, build summary, and a doctor check"
```

---

## Task 17: Documentation

**Files:** `docs/contracts/events.md`, `docs/guides/source-maps.md`, `packages/sdk/README.md`, `docs/install.md`, `docs/guides/{react,vue,vanilla}.md`, `docs/reference/{sdk-options,environment-variables}.md`, `scripts/docs-map.mjs`

Verified stale. Exactly three docs declare `covers: packages/sdk/vite-plugin/**` —
`docs/guides/react.md`, `docs/guides/vue.md`, and `docs/guides/source-maps.md`.
`docs/guides/vanilla.md` does **not**, so do not claim it does. Those three trigger
docs-sync the moment Task 5 lands, and docs-sync can push a commit to your branch.

**Do not publish a setup snippet for an export npm does not have.** `@opslane/sdk@2.0.1` has no `opslane()`. A copy-paste example that installs cleanly and then fails at import is worse than no documentation. `docs/guides/source-maps.md` gets a "what works today" table and keeps recommending the legacy plugin until the upload slice ships.

Add `packages/sdk/src/debug-images.ts` to `MANUAL_DOC_COVERS['docs/contracts/events.md']` in `scripts/docs-map.mjs:41-51`, or the frozen wire contract is never flagged when image assembly changes.

Include a migration matrix with tests: legacy only, new only, both together, and the ordering relative to `@sentry/vite-plugin`.

```bash
git commit -am "docs: document debug IDs across every affected surface"
```

---

## Task 18: Live smoke and the full gate

**Step 1: The repository gate**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

**Step 2: The live run**

`AGENTS.md` requires rebuilding **both** ingestion and worker and confirming the job
reaches its expected terminal state, not merely reading two columns back.

```bash
docker compose up -d postgres minio
./scripts/run-migrations.sh
psql "$DATABASE_URL" -f scripts/seed-e2e.sql
docker compose build ingestion worker && docker compose up -d ingestion worker

# build the fixture with the new plugin, then send a real event
pnpm --filter opslane-fixture-app build
curl -sS -X POST http://localhost:8082/api/v1/events \
  -H 'Content-Type: application/json' \
  -H "X-API-Key: $SEEDED_INGEST_KEY" \
  -d @/tmp/event-with-debug-meta.json

psql "$DATABASE_URL" -c \
  "SELECT debug_meta, commit_sha FROM error_events ORDER BY created_at DESC LIMIT 1;"
psql "$DATABASE_URL" -c \
  "SELECT status FROM error_groups ORDER BY last_seen DESC LIMIT 1;"
```

Take `SEEDED_INGEST_KEY` from `scripts/seed-e2e.sql`. The last query is the part
`AGENTS.md` actually asks for: the job must reach its expected terminal state.

Do not skip this. Every previous task proves a part in isolation; this is the only step that proves the parts agree.

**Step 3: File the deferred design challenges**

Four items from the review, as their own issues: measure whether symbolication improves
fixes; evaluate generating maps in the worker's existing sandbox; make `sourcesContent`
optional; post-symbolication regrouping.

```bash
gh issue create --title "..." --body "..."   # x4
```

No commit: filing issues changes no tracked file, and a `git commit` here fails with
"nothing to commit".

---

## Requirement traceability

| Req | Proven by |
|---|---|
| R1 | Tasks 2, 3, 4 |
| R2 | Tasks 5, 7 |
| R3 | Tasks 9, 11 |
| R4 | Tasks 12, 13, 14, 15 |
| R5 | Tasks 10, 11 |

## Execution order

Run these strictly in sequence in one worktree. The dependency table below explains
*why* the order is what it is; it is not permission to run lanes concurrently, because
they share a git index, `packages/sdk/package.json`, and `pnpm-lock.yaml`.

| Step | Task | Must come after | Because |
|---|---|---|---|
| 1 | 1 vectors | — | Everything grades against this file |
| 2 | 2 TS core | 1 | Reads the vectors |
| 3 | 3 Go core | 1 | Same vectors; independent of Task 2 |
| 4 | 4 Postgres bits | — | Independent |
| 5 | 4b plugin API | 2 | Declares deps and freezes the registry contract |
| 6 | 5 plugin | 4b, 2 | Uses the factory, options, prelude text and the core |
| 7 | 6 plugin tests | 5 | Tests the failure policy Task 5 defines |
| 8 | 7 determinism | 5, 4b | Needs `sourcemaps: 'keep'` from 4b |
| 9 | 8 shared types | — | Independent |
| 10 | 9 SDK assembly + its tests | 8, 4b | Reads `REGISTRY_GLOBAL`; emits `commit_sha` |
| 11 | 10 engine matrix | 9 | Extends the test file Task 9 created |
| 12 | 12 migration | — | Independent |
| 13 | 13 server | 12, 8 | Needs the columns and the shared types |
| 14 | 14 server tests | 13 | Asserts stored values and counters |
| 15 | 11 browser matrix | 5, 9 | Needs a stamping build and a reading SDK |
| 16 | 15 wire fixtures | 9, 13 | `v2.1.0-full.json` needs an emitted `commit_sha` |
| 17 | 16 DX surface | 5 | Implements behaviour behind the 4b API |
| 18 | 17 docs | 16 | Documents the finished surface |
| 19 | 18 smoke + issues | all | Proves the parts agree |

Four ordering errors in the previous draft, all now fixed: Task 7 used an option
introduced later; Tasks 5-7 and 11 referenced a plugin API introduced later; Task 9's
commit excluded the test it says to write first; and Task 15 expected a `commit_sha`
that no task emitted.

**If you do parallelise**, use separate `git worktree` checkouts, not lanes in one tree.
Steps 2/3/4/9/12 are the genuinely independent starting points.
