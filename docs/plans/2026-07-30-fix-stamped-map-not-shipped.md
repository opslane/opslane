# Fix: the stamped source map does not reach disk

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the debug ID embedded in every shipped chunk recompute exactly from the source map shipped beside it, so the server's upload check passes instead of returning `409` for three chunks out of four.

**Architecture:** The plugin already computes the right fingerprint. The defect is that its write to `mapAsset.source` is discarded for most chunks, so the map on disk is not the map that was hashed. The fix keeps the authoritative write in `generateBundle` (the only hook that can still influence what is written) and additionally updates `chunk.map`, which is what the dropping paths serialise from. It then adds a self-check that reads the emitted file back off disk, so the plugin can never again ship a fingerprint that disagrees with its own map.

**Tech Stack:** TypeScript, Vite 6/7/8 (Rollup and Rolldown), Vitest, Go (the server-side verifier).

---

## The evidence this fixes

Measured on a real production build of `test-fixtures/vue-app`, verified three independent ways: the server's own `debugid.Compute`, a from-spec Python implementation, and the presence of the root `debugId` the plugin writes.

| chunk | map has root `debugId` | `mappings` shifted | ID recomputes |
|---|---|---|---|
| `debug-id-lazy` | **yes** | yes | ✅ |
| `debug-id-worker` | **absent** | no | ✗ `409` |
| `index` | **absent** | yes | ✗ `409` |
| `rrweb` | **absent** | no | ✗ `409` |

The plugin sets `mapAsset.source` at `packages/sdk/vite-plugin/index.ts:229` with a map that always contains a root `debugId`. Three of the four shipped maps do not contain it, which proves that write was thrown away. The one chunk whose write survived is the one chunk that verifies.

**Do not "fix" this by changing what is hashed.** The fingerprint is correct; both the Go and Python implementations agree with it. The bug is that the wrong bytes reach disk.

---

## Task 1: A failing test that reproduces it from a real build

Write this first. It is the regression test whose absence let the bug ship: every existing test reads the same 15 hand-written maps and none of them ever built anything.

**Files:**
- Create: `packages/sdk/src/__tests__/debug-id-shipped-map.test.ts`

**Step 1: Write the test**

```ts
// packages/sdk/src/__tests__/debug-id-shipped-map.test.ts
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDebugId } from '../build/debug-id.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '../../../../test-fixtures/vue-app');
let assets: string;

describe('every shipped chunk recomputes to its embedded debug ID', () => {
  beforeAll(async () => {
    const { build } = await import('vite');
    const vue = (await import('@vitejs/plugin-vue')).default;
    const { opslaneVitePlugin } = await import('../../vite-plugin/index.js');
    const out = mkdtempSync(join(tmpdir(), 'shipped-map-'));
    await build({
      root: FIXTURE,
      configFile: false,
      logLevel: 'error',
      // Exercise the worker pass too: it is one of the paths that drops the write.
      worker: { format: 'es', plugins: () => [opslaneVitePlugin({ sourcemaps: 'keep' })] },
      plugins: [vue(), opslaneVitePlugin({ sourcemaps: 'keep' })],
      build: { outDir: out, emptyOutDir: true, sourcemap: 'hidden' },
    });
    assets = join(out, 'assets');
  }, 120_000);

  it('ships a map whose fingerprint equals the ID stamped in the JS', async () => {
    const chunks = readdirSync(assets).filter((f) => f.endsWith('.js'));
    expect(chunks.length).toBeGreaterThan(1);

    const failures: string[] = [];
    let checked = 0;

    for (const name of chunks) {
      const code = readFileSync(join(assets, name), 'utf8');
      const embedded = /\/\/# debugId=([0-9a-f-]{36})/.exec(code)?.[1];
      let mapBytes: Buffer;
      try {
        mapBytes = readFileSync(join(assets, `${name}.map`));
      } catch {
        continue; // no sibling map: nothing to verify for this chunk
      }
      if (!embedded) {
        failures.push(`${name}: has a map but no //# debugId= comment`);
        continue;
      }
      checked++;

      // The map on disk must carry the root debugId the plugin stamps.
      const parsed = JSON.parse(mapBytes.toString('utf8')) as { debugId?: string };
      if (parsed.debugId !== embedded) {
        failures.push(`${name}: shipped map debugId=${parsed.debugId ?? '<absent>'} but JS says ${embedded}`);
      }

      // And it must recompute, which is exactly what the server does on upload.
      const { debugId } = await computeDebugId(new Uint8Array(mapBytes));
      if (debugId !== embedded) {
        failures.push(`${name}: recomputed ${debugId} but JS says ${embedded}`);
      }
    }

    expect(checked).toBeGreaterThan(1);
    expect(failures).toEqual([]);
  }, 120_000);
});
```

**Step 2: Run it and watch it fail**

```bash
pnpm --filter @opslane/sdk exec vitest run src/__tests__/debug-id-shipped-map.test.ts
```

Expected: FAIL, listing three chunks with `shipped map debugId=<absent>`. If it passes, stop: either the build did not run the plugin, or `sourcemaps: 'keep'` did not retain maps, and you are testing nothing.

**Step 3: Commit the failing test**

```bash
git add packages/sdk/src/__tests__/debug-id-shipped-map.test.ts
git commit -m "test(sdk): reproduce stamped maps not reaching disk"
```

---

## Task 2: Find where the write is lost

Do not guess. Instrument, then choose the fix.

**Files:**
- Modify (temporarily, not committed): `packages/sdk/vite-plugin/index.ts`

**Step 1: Log what the plugin writes versus what lands**

In `generateBundle`, right after `mapAsset.source = stampedMapSource` (`index.ts:229`), log the chunk name and the first 80 characters of `mapAsset.source`. Add a `writeBundle(_options, bundle)` hook that logs, for the same keys, whether the asset it sees still contains `"debugId"`.

**Step 2: Run the fixture build and read the two logs**

```bash
cd test-fixtures/vue-app && pnpm build 2>&1 | grep -E "STAMPED|LANDED"
```

Three outcomes, each pointing at a different fix. Record which one you observe before continuing:

| Observation | Meaning | What Task 3 does about it |
|---|---|---|
| `writeBundle` still shows `debugId` but the file on disk lacks it | Vite re-serialises from `chunk.map` when writing | Step 1 covers it: update `chunk.map` as well |
| `writeBundle` no longer shows `debugId` | a later plugin replaced the asset | Step 3 fallback: a second `generateBundle` with `{ order: 'post' }` |
| The map asset key is absent in `writeBundle` | the asset was removed and re-added | Same fallback, plus treat it as a verification failure in Task 4 |

Expected, based on the evidence table above: the first row for the three failing chunks.

**Step 3: Remove the instrumentation**

Do not commit it. The permanent version is the self-check in Task 4.

---

## Task 3: Make the write survive, in `generateBundle`

Reviewed and revised: an earlier draft reasserted the map in `writeBundle`. **That does
not work.** `writeBundle` runs *after* Rollup has written the files, so mutating
`bundle[fileName].source` there changes an in-memory object nobody reads again. It would
have looked correct and shipped the same bug.

So the authoritative write stays in `generateBundle`, and the only question is which
field Vite serialises from.

**Files:**
- Modify: `packages/sdk/vite-plugin/index.ts`

**Step 1: Set both fields, defensively**

Set the asset source as today, and also update `chunk.map`, because the paths that drop
the asset write serialise from there instead.

`chunk.map` is a Rollup `SourceMap` instance, not a plain object. It may be frozen, may
expose accessors, and its `toString()` can depend on internal state that plain property
assignment does not update. So attempt it, guard it, and never let it corrupt a chunk
that was already stamped:

```ts
// after chunk.code and mapAsset.source have been set
try {
  const asObject = JSON.parse(stampedMapSource) as Record<string, unknown>;
  if (chunk.map && typeof chunk.map === 'object' && !Object.isFrozen(chunk.map)) {
    for (const key of ['mappings', 'sources', 'sourcesContent', 'names', 'debugId']) {
      if (key in asObject) {
        try { (chunk.map as Record<string, unknown>)[key] = asObject[key]; } catch { /* accessor-only */ }
      }
    }
  }
} catch {
  // chunk.map is unwritable on this engine. The asset write and the Task 4
  // verification still apply; this chunk is not left half-stamped because
  // chunk.code and mapAsset.source were already committed above.
}
```

Assign named fields rather than `Object.assign` of the whole parsed object: a blanket
assign can clobber internal keys and is more likely to throw part-way through.

**Step 2: Per-build state, not module state**

Keep `stampedMaps` and `stampedIds` inside the factory closure and **clear them at
`buildStart`**. Module-level or plugin-instance maps survive watch rebuilds and multiple
outputs, which produces stale entries and false verification results.

**Step 3: Re-run the Task 1 test**

```bash
pnpm --filter @opslane/sdk exec vitest run src/__tests__/debug-id-shipped-map.test.ts
```

Expected: PASS on every chunk, including the worker pass and the vendor chunk.

**If some still fail**, the map is being replaced by a later plugin rather than
re-serialised. In that case add a second `generateBundle` hook with
`{ order: 'post' }` on the hook descriptor (not just `enforce: 'post'` on the plugin,
which only orders this plugin against others that declare an order, and does not
guarantee it runs last). Verify that descriptor is honoured on Vite 6, 7 and 8 before
relying on it.

---

## Task 4: Verify against the bytes on disk

The whole design rests on two numbers being equal, and nothing checks it. That is why a
broken build went green.

**Files:**
- Modify: `packages/sdk/vite-plugin/index.ts`
- Modify: `packages/sdk/src/__tests__/vite-plugin.test.ts`

**Step 1: Read the emitted file, not the in-memory asset**

Verification belongs in `writeBundle` precisely *because* it runs after the write, and it
must read what was written. Checking `bundle[...].source` there verifies an object that
may differ from disk, which is the same mistake as Task 3's earlier draft.

```ts
async writeBundle(outputOptions, _bundle) {
  const dir = outputOptions.dir;
  if (!dir) return;                       // no-filesystem output; nothing to verify
  for (const [fileName, expectedId] of stampedIds) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(join(dir, fileName));
    } catch {
      stats.verifyFailed.push(`${fileName} (map missing on disk)`);
      continue;
    }
    try {
      const { debugId } = await computeDebugId(bytes);
      if (debugId !== expectedId) stats.verifyFailed.push(fileName);
    } catch {
      stats.verifyFailed.push(`${fileName} (map unreadable)`);
    }
  }
},
```

The hook is declared `async`; Rollup awaits the returned promise. A missing or unreadable
map is a **failure**, not a skip: a stamped chunk whose map is gone will be rejected on
upload exactly like a mismatched one.

Skip verification entirely when `sourcemaps: 'remove'` deleted the maps on purpose, or
every build reports failures for maps that were never meant to ship.

**Step 2: Report loudly, but do not fail the build**

```
[opslane] OPSLANE_VITE_MAP_VERIFY_FAILED: 3 chunks shipped a map that does not match
  the debug ID stamped into the JavaScript. Those chunks will be rejected on upload.
  Affected: index-C7g7MDKA.js.map, debug-id-worker-CvT_dscM.js.map, rrweb-...js.map
  See docs/guides/source-maps.md#verification.
```

Error level, stable code, non-zero count in the `closeBundle` summary. Still exit 0: this
is our defect to fix, not a reason to block a customer's deploy.

**Step 3: Unit-test that the self-check actually fires**

Register a downstream plugin that overwrites the map asset, and assert `verifyFailed` is
non-empty and the message carries the code.

Ordering matters or the test proves nothing: the overwriting plugin must run **after**
ours in `generateBundle` and must write to disk, not just mutate the bundle. Assert
inside the test that the on-disk map really was changed, so a no-op overwrite cannot
produce a passing test.

**Step 4: Run both suites**

```bash
pnpm --filter @opslane/sdk exec vitest run src/__tests__/vite-plugin.test.ts src/__tests__/debug-id-shipped-map.test.ts
```

**Step 5: Commit**

```bash
git add packages/sdk/vite-plugin/index.ts packages/sdk/src/__tests__/vite-plugin.test.ts \
        packages/sdk/src/__tests__/debug-id-shipped-map.test.ts
git commit -m "fix(sdk): ship the stamped source map and verify it against disk"
```

---

## Task 5: Confirm positions still resolve

The line-shift accounting is **correct** and needs no change. Verified: `ESM_PRELUDE` and
`SCRIPT_PRELUDE` (`index.ts:30-31`) both end in `\n`, and the shipped JS has the prelude
alone on line 1 with the original code starting on line 2. The chunk gains exactly one
line, and `insertMappingLine` splices exactly one empty segment. The unshifted `mappings`
seen on two chunks was a symptom of the wrong map shipping, not a second defect.

Add a resolution assertion anyway, because a fingerprint can match while the map is
useless.

**Files:**
- Modify: `packages/sdk/src/__tests__/debug-id-shipped-map.test.ts`

Pick a **deliberately mapped** segment rather than an arbitrary position: decode the
first mapping of a known source line from the map itself, then assert
`originalPositionFor` returns that exact source, line and column. An arbitrary middle
position is frequently unmapped and produces a flaky test.

---

## Task 6: Prove it end to end with the server's own code

Unit tests are not the proof. The server is.

**Step 1: Build the fixture and run the server-side verifier**

```bash
pnpm --filter @opslane/sdk build
cd test-fixtures/vue-app && pnpm build && cd -
cd packages/ingestion && go run ./qa-recompute ../../test-fixtures/vue-app/dist/assets
```

Expected: every chunk `OK`. Any `MISMATCH -> 409` means it is not fixed.

Note the fixture wires the legacy plugin too, which deletes maps. Either build with `sourcemaps: 'keep'` as the Task 1 test does, or verify against a build without the legacy plugin.

**Step 2: Run the full gate**

```bash
pnpm -r build && pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
```

**Step 3: Commit**

```bash
git add -- packages/sdk docs
git commit -m "test(sdk): verify shipped maps against the server verifier"
```

Stage explicit paths. Never `git commit -am` here: the worktree carries unrelated changes under `eval/`, `packages/worker/`, and `TODOS.md` that must not be absorbed.

---

## Definition of done

1. The Task 1 test passes on every chunk of a real fixture build, including the worker pass and a vendor chunk.
2. `go run ./qa-recompute` reports `OK` for every chunk.
3. The plugin logs a stable error code and a non-zero count if it ever ships a map that fails its own verification.
4. Positions still resolve to the correct original lines.
5. `pnpm test` and `go test ./...` pass.
6. No unrelated file is committed.
