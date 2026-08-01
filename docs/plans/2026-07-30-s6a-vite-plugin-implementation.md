# S6a Vite Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `opslane sourcemaps install-plugin`, a command that adds two lines to a customer's Vite config, proves the plugin is really registered, and restores the file exactly on any failure.

**Architecture:** A pure function turns config text into edited text or a typed refusal, so most tests are string comparisons with no project on disk. A separate module owns byte-level save and restore. A forked child process resolves the edited config using the customer's own Vite, so we can kill it and control its environment.

**Tech Stack:** TypeScript, the `typescript` compiler API (already a CLI dependency), Vitest, Commander.

**Design:** `docs/design/2026-07-30-s6a-vite-plugin-onboarding.md`. Read section 6 (finding the spot) and 7 (checking our work) before Task 3.

**Task order.** 0 → 1 → 2 → 3 → 4a/4b → 5 → 6a/6b → 7 (measure) → 8a/8b (messages) → 9a/9b1/9b2/9b3/9c (command) → 10 (docs) → 11 (live run).

**Commit points inside the larger tasks.** Four tasks bundle work that should be
reviewable separately. Each has a marked split; commit at each one rather than at
the end of the task.

| Task | Split at |
| --- | --- |
| 4 | 4a structural refusals (spread, computed key, no default export). 4b conflict policy (already-wired, legacy, competing plugin, the contract gate) |
| 6 | 6a the child's own logic as an importable `resolveInChild`. 6b the parent's fork, timeout and kill lifecycle |
| 8 | 8a rendering the messages. 8b the suggestion outcome and relocating it |
| 9b | 9b1 the happy path through steps 1 to 7. 9b2 rollback and fault injection. 9b3 the repository-delta check |
The measurement gates the command, not the other way round: the design makes it an
M3 blocker, so it runs before anything user-facing is built. Messages come before
the command because the command routes through them.

**Ground rules**
- Run every command from `cli/`.
- `pnpm test` is `vitest run`. `pnpm build` is `tsc`.
- Never add `vite` or `@opslane/sdk` to `cli/package.json`. Task 6 explains why.
- Commit after every task.

---

## Task 0: Two decision records

Blocks Task 6. The code in Task 6 runs a customer's config, which executes their code. This repo deliberately has no such capability, so that reversal gets written down before it lands.

**Files:**
- Create: `docs/decisions/vite-config-execution.md`
- Create: `docs/decisions/s6a-design-divergence.md`

**Step 1: Read the precedent**

Read `docs/decisions/onboard-deviation.md` and `docs/decisions/agent-runs-commands.md`. Match their shape.

**Step 2: Write the execution decision**

`vite-config-execution.md` records: the onboarding agent is denied a shell at `cli/src/onboard/policy.ts:82`; this command instead runs the customer's config in a forked child with our credentials removed; a fork is not a sandbox and the child keeps filesystem and network access; accepted because a developer is running a tool on their own repository.

**Step 3: Write the divergence decision**

`s6a-design-divergence.md` records the two reversals against `docs/design/2026-07-29-keys-sourcemaps-onboarding.md` §5.8: the host writes the edit rather than a model (64 of 70 configs against 18), and verification resolves the config rather than running a production build (§5.4 forbids the plugin from failing a build, so a green build proves nothing).

**Step 4: Commit**

```bash
git add docs/decisions/
git commit -m "docs: record S6a decisions on config execution and design divergence"
```

---

## Task 1: The frozen contract with #224

**Files:**
- Create: `cli/src/codemods/vite-contract.ts`
- Test: `cli/src/__tests__/contract-drift.test.ts` (modify)

**Step 1: Write the contract module**

```ts
// cli/src/codemods/vite-contract.ts

/**
 * The exact text this tool inserts, and the exact shape verification accepts.
 * #224 owns the plugin. When it renames the export or the subpath, it must
 * change this file, and the drift test below fails until it does.
 */
export const OPSLANE_VITE_PLUGIN = {
  specifier: '@opslane/sdk/vite-plugin',
  exportName: 'opslane',
  /** Asserted in the resolved plugin list, see Task 7. */
  pluginName: 'opslane-source-map',
  importLine: "import { opslane } from '@opslane/sdk/vite-plugin';",
  callText: 'opslane()',
} as const;

/**
 * Distinct from OPSLANE_IDENTITY_MIN_VERSION in cli/src/onboard/verify.ts:43,
 * which is the floor for SDK identity on /sessions/init. A lockfile pinned to
 * 2.0.1 satisfies that floor and still has no opslane().
 * Set this when #224 publishes.
 */
export const OPSLANE_VITE_PLUGIN_MIN_VERSION: string | null = null;
```

**Step 2: Write the failing drift test**

Add to `cli/src/__tests__/contract-drift.test.ts`. Do not import the SDK: `packages/sdk/dist` is empty in a fresh checkout and `pnpm --filter @opslane/cli test` does not build it, so an import-based test fails for the wrong reason forever. Read the source with the compiler the CLI already has.

```ts
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { OPSLANE_VITE_PLUGIN } from '../codemods/vite-contract.js';

// cli/package.json is "type": "module", so __dirname does not exist here.
function sdkExportsZeroArgFactory(name: string): boolean {
  const url = new URL('../../../packages/sdk/vite-plugin/index.ts', import.meta.url);
  const file = url.pathname;
  const src = readFileSync(url, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  // Accept either shape #224 might ship: a function declaration, or an exported
  // const holding an arrow. Matching only the declaration form would reject a
  // perfectly valid `export const opslane = () => ...`.
  return sf.statements.some((st) => {
    const exported = ts.canHaveModifiers(st)
      && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return false;
    if (ts.isFunctionDeclaration(st)) {
      return st.name?.text === name && st.parameters.length === 0;
    }
    if (ts.isVariableStatement(st)) {
      return st.declarationList.declarations.some(
        (d) => ts.isIdentifier(d.name) && d.name.text === name
          && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
          && d.initializer.parameters.length === 0,
      );
    }
    return false;
  });
}

it('SDK exports the zero-argument plugin factory this CLI inserts', () => {
  expect(sdkExportsZeroArgFactory(OPSLANE_VITE_PLUGIN.exportName)).toBe(true);
});
```

**Step 3: Run it and confirm it fails for the RIGHT reason**

Run: `pnpm test -- contract-drift`
Expected: FAIL, `expected false to be true`. Not a module-resolution error. If you see `ERR_MODULE_NOT_FOUND` or `ENOENT`, the test is wrong, not the SDK.

**Step 4: Mark it expected-failing until #224 lands**

Split the assertion first, or `it.fails` will happily pass on the wrong failure:
a later `ENOENT` or parser exception would keep it green forever. Add a normal
test asserting the file loads and parses without throwing, and reserve
`it.fails` for the boolean assertion alone. Also require `st.body` on the
function-declaration branch, so a bodyless overload signature does not count.

Then change `it(` to `it.fails(`. Add above it:

```ts
// EXPECTED TO FAIL until #224 ships opslane(). When #224 lands this flips to a
// hard failure and someone must set OPSLANE_VITE_PLUGIN_MIN_VERSION. Do not
// convert this to it.skip: a skip is invisible in CI output and never flips.
```

**Step 5: Run and commit**

Run: `pnpm test -- contract-drift`
Expected: PASS (the expected failure occurred).

```bash
git add cli/src/codemods/vite-contract.ts cli/src/__tests__/contract-drift.test.ts
git commit -m "feat(cli): freeze the Vite plugin contract with a drift test"
```

---

## Task 2: Find the config object

First half of the pure function. Locating only; no editing yet.

**Files:**
- Create: `cli/src/codemods/vite-sourcemaps.ts`
- Test: `cli/src/__tests__/vite-sourcemaps.test.ts`

**Step 1: Write the failing tests**

```ts
import { findPluginList } from '../codemods/vite-sourcemaps.js';

const cases: Array<[string, string, boolean]> = [
  ['plain object', `export default { plugins: [a()] }`, true],
  ['defineConfig', `import {defineConfig} from 'vite'
export default defineConfig({ plugins: [a()] })`, true],
  ['arrow returning object', `import {defineConfig} from 'vite'
export default defineConfig(() => ({ plugins: [a()] }))`, true],
  ['arrow with a body', `import {defineConfig} from 'vite'
export default defineConfig((e) => { return { plugins: [a()] } })`, true],
  ['aliased defineConfig', `import {defineConfig as dc} from 'vite'
export default dc({ plugins: [a()] })`, true],
  ['variable config', `const c = { plugins: [a()] }
export default c`, true],
  ['no default export', `export const c = { plugins: [] }`, false],
  ['plugins from a call', `export default { plugins: getPlugins() }`, false],
  ['spread in the config', `export default { ...base, plugins: [a()] }`, true],
];

it.each(cases)('%s', (_name, src, shouldFind) => {
  expect(findPluginList(src, 'vite.config.ts').found !== 'none').toBe(shouldFind);
});
```

**Step 2: Run to verify it fails**

Run: `pnpm test -- vite-sourcemaps`
Expected: FAIL, `findPluginList is not a function`.

**Step 3: Implement**

Walk `export default` to the config object, unwrapping `as`, `satisfies`, parentheses and non-null assertions at every step. Resolve `defineConfig` by following its import to `vite` or `vitest/config` rather than matching the name, so an alias works and a user's own local `defineConfig` does not get unwrapped. For a variable, follow it to its declaration in the same file.

**Return a structured result, not `array | null`.** Task 4 has to tell apart "a
valid config object that has no plugin list" from "no config object at all",
because the first case can have a list appended and the second cannot.

```ts
export type PluginListLookup =
  | { found: 'list'; sourceFile: ts.SourceFile; config: ts.ObjectLiteralExpression; list: ts.ArrayLiteralExpression }
  | { found: 'config-only'; sourceFile: ts.SourceFile; config: ts.ObjectLiteralExpression }
  | { found: 'none'; reason: ViteUnsupportedReason };
```

**Write the import-binding resolver here; do not reuse `source.ts` for it.**
`lastImportStatement` returns matched source text and `sdkImportLocalName` only
recognises named imports from `@opslane/sdk`. Neither resolves an aliased
`defineConfig` from `vite`. `lastImportStatement` is still the right tool for
Task 3's insertion anchor, and that is the only place to use it.

**Step 4: Run to verify it passes**

Run: `pnpm test -- vite-sourcemaps`
Expected: PASS, 9 tests.

**Step 5: Commit**

```bash
git add cli/src/codemods/vite-sourcemaps.ts cli/src/__tests__/vite-sourcemaps.test.ts
git commit -m "feat(cli): locate the plugin list in a Vite config"
```

---

## Task 3: Insert the two lines

**Files:**
- Modify: `cli/src/codemods/vite-sourcemaps.ts`
- Test: `cli/src/__tests__/vite-sourcemaps.test.ts`

**Step 1: Write the failing test for the case that matters most**

59% of real configs write the list on one line. This is the case the old approach could not do at all.

```ts
import { addOpslanePlugin } from '../codemods/vite-sourcemaps.js';

it('inserts into a single-line plugin list', () => {
  const before = `import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
})
`;
  const r = addOpslanePlugin(before, 'vite.config.ts');
  expect(r.outcome).toBe('edited');
  expect(r.outcome === 'edited' && r.text).toBe(`import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import { opslane } from '@opslane/sdk/vite-plugin';
export default defineConfig({
  plugins: [react(),
    opslane()],
})
`);
});
```

**Step 2: Run to verify it fails**

Run: `pnpm test -- vite-sourcemaps`
Expected: FAIL.

**Step 3: Implement the insertion**

Two character offsets, applied later-first so the earlier one stays valid.

The plugin offset is `array.elements.end`. Use that, not `lastElement.getEnd()`. `getEnd()` stops **before** a trailing comma, so inserting there splits `}),` into `})` plus your line plus `,`. During the spike that bug corrupted 18 of 70 configs. `array.elements.hasTrailingComma` tells you whether a comma is already present.

The import offset is the end of the last top-level import, advanced past any trailing comment on that line with `ts.getTrailingCommentRanges`, or `import x from 'y'; // note` reassigns the comment to your new import.

Positions are UTF-16 code units. Slice the exact string you parsed and write with `writeFileSync(path, text, 'utf8')`. Never splice a `Buffer`.

Line ending comes from the source. Indentation has three cases and each needs
its own test, because "preserve the last element's indentation" is undefined for
the shape that matters most:

| Shape | Indent for the inserted line |
| --- | --- |
| Multi-line list | copy the last element's own indent |
| Single-line list | the indent of the line holding `plugins:`, plus two spaces. In the step 1 example `plugins:` is indented two, so the inserted line is indented four |
| Empty list | same as single-line |

**Step 4: Run to verify it passes**

Run: `pnpm test -- vite-sourcemaps`

**Step 5: Add the shape matrix**

One case each: `.ts .js .mjs .cjs .mts .cts`, multi-line list, empty list, trailing comma and none, `\r\n`, a byte-order mark (assert on bytes, not the decoded string), `plugins: [...].filter(Boolean)`, shorthand `plugins`, `plugins: someVariable`, `as PluginOption[]`, `satisfies PluginOption[]`. Every `edited` case asserts exact output text.

**Step 6: Assert running twice changes nothing**

For every `edited` case, feed the output back in. Expect `already_wired` and identical bytes. This is R3.

**Step 7: Run and commit**

Run: `pnpm test -- vite-sourcemaps`

```bash
git add cli/src/codemods/vite-sourcemaps.ts cli/src/__tests__/vite-sourcemaps.test.ts
git commit -m "feat(cli): insert the Opslane plugin at exact offsets"
```

---

## Task 4: Refuse safely

The refusal path is roughly one run in five, so it is a main path, not an error path.

**Files:**
- Modify: `cli/src/codemods/vite-sourcemaps.ts`
- Test: `cli/src/__tests__/vite-sourcemaps.test.ts`

**Step 1: Write the failing test for the silent no-op**

This is the only failure mode in the design with no detection anywhere else. If the config spreads another object in, a `plugins` key we add gets overwritten, every later check still passes, and the plugin is simply absent.

```ts
it('refuses to add a plugin list when the config spreads another object', () => {
  const r = addOpslanePlugin(`export default defineConfig({ ...base })`, 'vite.config.ts');
  expect(r.outcome).toBe('unsupported');
  expect(r.outcome === 'unsupported' && r.reason).toBe('plugins_would_be_overwritten');
});

it('does not add a second plugins key when one is written as a string', () => {
  const r = addOpslanePlugin(`export default defineConfig({ ['plugins']: [a()] })`, 'vite.config.ts');
  expect(r.outcome).toBe('edited');
});
```

**Step 2: Run to verify it fails**

**Step 3: Implement the three guards**

When there is no `plugins` key you may add one, but only if all three hold: the config object contains no spread; property names resolve through `Identifier`, `StringLiteral`, `NoSubstitutionTemplateLiteral` and literal computed names before you conclude the key is absent; and the new key is appended last, not first.

**Step 4: Add the conflict outcomes**

`already_wired` when a binding imported from the frozen specifier as `opslane` is called with no arguments inside the list. Detect by resolving the binding, never by matching text: `import { opslane as p }` then `p()` defeats text matching and would produce a second registration.

`legacy_opslane_plugin` when any other import comes from `@opslane/sdk/vite-plugin`. Its own outcome, not a conflict: reporting our own plugin as a conflicting plugin reads as a bug.

**There is no third conflict outcome, and adding one would be a mistake.** An
earlier draft refused any project that already ran a named source-map plugin:
Sentry's, Datadog's, PostHog's, Bugsnag's. Do not build that.

Design section 6a settles it. The three build phases run in a fixed order, so a
plugin that reads its maps in memory and cleans up at the end never takes
anything away from a plugin that reads off disk in between. That argument is not
about Sentry. It holds for any uploader working from the output folder.

A vendor list is also the wrong shape of answer. It refuses projects we have
never tried, on the guess that they might break, and it silently grows stale as
those tools change. If a specific tool does break, fix the plugin. Do not filter
on the vendor's name.

So `addOpslanePlugin(text, filename)` needs no manifest and no installed
version. Its only policy input is the plugin contract.

Known list: `@sentry/vite-plugin`, `vite-plugin-sentry`, `unplugin-sentry`, `@datadog/vite-plugin`, plus specifiers containing `posthog` or `bugsnag`. Do **not** add `rollup-plugin-sourcemaps`: it only reads existing maps and neither strips nor forces anything, so listing it would refuse configs that work. The list is a claim about behaviour, not a name match.

**Step 5: One test per refusal reason**

Each asserts the reason and that the returned text is undefined.

**Step 6: Run and commit**

```bash
git add cli/src/codemods/vite-sourcemaps.ts cli/src/__tests__/vite-sourcemaps.test.ts
git commit -m "feat(cli): typed refusals for configs we cannot safely edit"
```

---

## Task 5: Extract save and restore

`snapshotRegularFile` and `restoreSnapshot` already exist and already reject symlinks, hard links and oversized files, and the restore path already rechecks that the parent directory resolves inside the root. They are module-private, so this task moves them without changing behaviour.

**Files:**
- Create: `cli/src/onboard/snapshot.ts`
- Modify: `cli/src/onboard/engine.ts:375` (`FileSnapshot`), `:411`, `:436`
- Test: `cli/src/__tests__/snapshot.test.ts`

**Step 1: Move, do not rewrite**

Cut `FileSnapshot`, `snapshotRegularFile` and `restoreSnapshot` into `snapshot.ts`, export them, and import them back into `engine.ts`. No logic changes.

**Step 2: Prove nothing broke**

Run: `pnpm test -- engine verify tools`
Expected: PASS, unchanged.

That criterion is weaker than it looks, since a test can pass while asserting nothing. Step 3 is the real cover.

**Step 3: Add a byte-for-byte restore test**

Write a file, snapshot it, overwrite it, restore, then assert `Buffer.equals` on the contents and equality on `lstatSync().mode`.

**Step 4: Fix a real bug in restore before relying on it**

R2 promises permissions are restored. The current code does not do that. When the
file already exists it opens with `O_TRUNC` and no `O_CREAT`, and the mode
argument to `openSync` is ignored without `O_CREAT`. So mode is preserved only
because the file was never replaced.

That matters now, because step 5 replaces the file by rename, which creates a new
inode. Add an explicit `fchmodSync(descriptor, snapshot.mode)` after the write,
and test restore after a rename-based replacement with a deliberately different
mode. Without that change the test in step 3 passes vacuously.

**Step 5: Extend the atomic write we already have, do not write a second one**

`cli/src/fsutil.ts:14` already exports `writeFileAtomic` with temp cleanup and
fsync. It forces mode `0o600` at line 21, which would silently tighten a
customer's config file permissions. Add an optional mode parameter defaulting to
the current behaviour, and pass the snapshot's mode from this path.

Passing a mode to `open()` is not enough: the process umask filters creation
mode, so the temp file can still end up more restrictive than the original. Call
`handle.chmod(mode)` after writing and before the rename. Existing two-argument
callers keep `0o600` through the default, so they are unaffected.

Test: temp file cleaned up on success and on failure, target untouched when the
temp write throws, and original permissions preserved through a replacement.

**Step 5: Run and commit**

```bash
git add cli/src/onboard/snapshot.ts cli/src/onboard/engine.ts cli/src/__tests__/snapshot.test.ts
git commit -m "refactor(cli): extract snapshot helpers and add an atomic write"
```

---

## Task 6: Resolve the config in a forked child

Blocked by Task 0.

**Files:**
- Create: `cli/src/codemods/vite-resolve.ts`
- Create: `cli/src/codemods/vite-resolve-child.ts`
- Test: `cli/src/__tests__/vite-resolve.test.ts`

**Step 1: Understand why this is not one function**

Resolving a config runs the config file and every module it imports. Our process holds the customer's API key and OAuth tokens (`cli/src/auth.ts`, `cli/src/agent-credentials.ts`). So the resolve runs in a child we can kill, with our credentials removed.

Be precise about what that buys: a fork is not a sandbox. The child keeps filesystem and network access. What it gives is a killable process and a controlled environment. `resolveConfig` takes no abort signal, so racing it in-process would leave the customer's code running while the parent restores the same file.

**Step 2: Use the app's Vite, never ours**

`import('vite')` from `cli/` fails with `ERR_MODULE_NOT_FOUND`, and it should stay that way. Adding Vite would pull in esbuild and rollup for one subcommand, and would be the wrong version: we would bundle v8 while the customer runs v5.

```ts
const req = createRequire(join(appDir, 'package.json'));
const mod = await import(pathToFileURL(req.resolve('vite')).href);
// Vite 5 resolves to index.cjs, where the named exports arrive under `default`.
const resolveConfig = mod.resolveConfig ?? mod.default?.resolveConfig;
if (typeof resolveConfig !== 'function') return { ok: false, reason: 'vite_not_usable' };
```

No installed Vite gives a typed refusal, not a crash.

**Declare a floor and check it before importing.** The SDK's peer range is
`^6 || ^7 || ^8`. Read the app's installed Vite version first and refuse below 6
with `vite_version_unsupported`, rather than importing an old one and discovering
the shape differs. The `?? default` fallback above is belt and braces for the
case where a v5 slips through a workspace link.

**Step 3: Use `resolveConfig`, not `loadConfigFromFile`**

Measured against Vite 6.4.3 with a plugin that throws on startup: the cheaper call reports success, `resolveConfig` fails and says why. Choosing the cheaper one would make the rollback test in Task 8 pass while proving nothing.

`resolveConfig` also applies the plugin's own `apply: 'build'` filter, so asserting the plugin survives into `resolved.plugins` under `command: 'build'` is stronger than reading the raw config.

**Step 4: Strip environment credentials, and be honest about what that does not cover**

The child inherits the environment minus a denylist: `OPSLANE_*`, `ANTHROPIC_*`, `GITHUB_*`, `AWS_*`, `NPM_TOKEN`, and the CLI's own token path.

Do not describe this as removing our credentials. It removes credentials **in the
environment**. Ours are on disk: `cli/src/auth.ts:29` reads
`~/.opslane/credentials.json` and `cli/src/agent-credentials.ts:26` reads
`~/.opslane/agent-credentials.json`. The child keeps filesystem access and can
read both. Closing that needs a real sandbox this CLI does not have. Say so in
the decision record from Task 0 rather than implying the child is contained.

Do not empty the environment. Real configs read settings from it, and a config that then fails would be reported as "already broken" when we broke it. That would also corrupt the measurement in Task 10. Unit-test the denylist.

**Step 5: Define what crosses the boundary**

`resolved.plugins` holds functions and cannot be cloned across processes. The child returns `{ ok, pluginNames: string[], error?: string }`. The parent asserts on `pluginNames`.

**Step 6: Bound it, and actually stop it**

60 seconds, then `SIGTERM`, then `SIGKILL` after a short grace period, and await
the child's exit before reporting the timeout. `SIGTERM` alone can be trapped or
ignored by the customer's config, which would leave their code running while the
parent restores the same file. Treat the child's output as untrusted: strip ANSI, cap length, never put it in a model prompt.

**Step 7: Make it testable from source**

Two traps. Vitest runs TypeScript directly, but `fork()` needs a compiled
`.js` child, which does not exist after a fresh `pnpm test`. And a 60 second
timeout makes the timeout test take 60 seconds.

So: take the child entry path and the timeout as injected options, defaulting to
the real ones. Tests pass a small JavaScript fixture child and a 200ms timeout.

That only exercises the parent's IPC and timeout handling. The child's own logic,
missing Vite, the version floor, the `default.resolveConfig` fallback, a plugin
that throws, needs its own cover. Put that logic in an exported
`resolveInChild(options)` that the child entry merely calls, unit-test it
directly, and keep one end-to-end test through a real forked child.

```ts
export interface ResolveOptions {
  appDir: string;
  configPath: string;    // REQUIRED: without it Vite auto-discovers and may load
                         // a different file than Task 9a selected
  childEntry?: string;   // default: the compiled child next to this module
  timeoutMs?: number;    // default: 60_000
}
```

The child calls `resolveConfig({ root: appDir, configFile: configPath }, 'build')`.

**Step 8: Test**

A fixture that resolves cleanly; one whose plugin throws on startup; one with no
Vite installed; one below the version floor; one that exceeds a 200ms timeout;
and a unit test that the credential denylist removes what it should and keeps
everything else.

**Step 9: Commit**

```bash
git add cli/src/codemods/vite-resolve.ts cli/src/codemods/vite-resolve-child.ts cli/src/__tests__/vite-resolve.test.ts
git commit -m "feat(cli): resolve a Vite config in a forked child process"
```

---

## Task 7: Measure what gates the coverage claim

Runs before anything user-facing, because the design makes it an M3 blocker.

**Files:**
- Create: `cli/scripts/measure-config-coverage.mts`
- Modify: `docs/design/2026-07-30-s6a-vite-plugin-onboarding.md` section 13

**Step 1: Why this exists**

Every measurement so far checked whether a config could be *edited*. None ever
ran one. Real configs fail on evaluation often: a missing environment variable, a
call out to git, a dependency nobody installed. Each is a refusal counted in none
of the published numbers.

**Step 2: Define the input properly**

"A directory of configs" is not runnable. Task 6 needs an app root, an installed
Vite and a package manifest per config. So the input is a manifest:

```jsonc
// corpus.json
[ { "appDir": "/abs/path/to/app", "configPath": "vite.config.ts" } ]
```

Build it by scanning for `vite.config.*` files that sit beside an `index.html`
and have a `node_modules` with Vite in it. Configs whose dependencies are not
installed are reported separately as `not_installed`, not counted as failures,
because we cannot tell whether they would have loaded.

**Step 3: Output a schema, not prose**

```jsonc
{ "total": 0, "loaded": 0, "failedToLoad": 0, "notInstalled": 0,
  "failures": [ { "appDir": "...", "reason": "..." } ] }
```

Run each config through Task 6's resolver, unedited, with the same credential
denylist. Isolate: a fresh temp `HOME` per run so a config reading a developer's
own dotfiles does not skew it.

**Step 4: Run it and write the number into design section 13**

**Step 5: Apply the decision rule**

Fixed in advance so it cannot be argued about afterwards. If fewer than 60 in 100
survive, the `opslane build` wrapper in design section 12 is the better approach
and this one should be reconsidered rather than patched. Between 60 and 77, ship
it.

**Step 6: Commit**

```bash
git add cli/scripts/measure-config-coverage.mts docs/design/2026-07-30-s6a-vite-plugin-onboarding.md
git commit -m "test(cli): measure how many real configs fail to load before we touch them"
```

---

## Task 8: Messages, and the suggestion the command routes through

Before the command, because the command calls into this.

**Files:**
- Create: `cli/src/codemods/vite-messages.ts`
- Modify: `cli/src/codemods/vite-sourcemaps.ts`
- Test: `cli/src/__tests__/vite-messages.test.ts`

**Step 1: Add the suggestion outcome to the codemod**

Asking rather than refusing needs a typed result the command can act on, not just
a string. Add to `ViteEditResult`:

```ts
| { outcome: 'suggested'; text: string; insertOffset: number; line: number; preview: string[] }
```

`suggested` is returned where a plugin list was found but the insertion point was
not provably safe. `insertOffset` is what the command re-uses if the developer
confirms, and what it replaces if they move it.

**Step 2: Render the suggestion**

```
apps/web/vite.config.ts

  12 |   plugins: [
  13 |     react(),
> 14 |     opslane(),          <- we would add it here
  15 |   ].filter(Boolean),

Add it there?  [Y]es  [m]ove it  [n]o, show me the two lines
```

Moving asks for a line number, recomputes the offset from that line, and re-runs
the same structural check before writing. A confirmed or moved suggestion then
goes through the same write, re-read and resolve as the automatic path, so it is
exactly as verified.

**Step 3: Static templates, host-populated fields**

Sentences are constants. File, line and the matched identifier are filled in. A
rule banning interpolation would make it impossible to say "line 14", which is
most of a message's value.

**Step 4: Every refusal ends with a way to finish**

The two lines, then `opslane sourcemaps install-plugin --check`. Someone who
edits by hand gets the same proof as someone who did not.

**Step 5: Except the legacy plugin**

`legacy_opslane_plugin` must **not** end with the paste block. Pasting is the
thing being refused: a second registration of our own plugin. Explain the
mechanism instead, then the options: follow the migration guide, remove the old
plugin and re-run; migrate by hand and watch the first build; or skip source
maps, because Opslane still catches and groups errors and only the file and line
numbers stay unreadable.

That third option matters. Someone refused here needs to know the product still
works.

**Step 6: Test**

Every message names the file. Conflict messages do not contain the paste block.
A moved suggestion produces a different offset and still passes the structural
check. Assert on rendered strings, not booleans.

**Step 7: Commit**

```bash
git add cli/src/codemods/vite-messages.ts cli/src/codemods/vite-sourcemaps.ts cli/src/__tests__/vite-messages.test.ts
git commit -m "feat(cli): refusal messages and a confirmable suggestion"
```

---

## Task 9a: Find the config, and check what is installed

Split out of the command because it is separately testable and has its own
statuses. Nothing here writes.

**Files:**
- Create: `cli/src/codemods/vite-discovery.ts`
- Test: `cli/src/__tests__/vite-discovery.test.ts`

**Step 1: Candidate filenames**

Vite's own list is exactly six: `.js .mjs .ts .cjs .mts .cts`. There is no
`.tsx` config. Search the app directory only, not recursively, unless `--config`
names one.

**Step 2: Containment**

Resolve `--config` and `--app-dir` through `containedRepoRelative` from
`cli/src/onboard/paths.ts` so neither can point outside the repository, and
refuse a symlink or a hard-linked config the same way
`snapshotRegularFile` does.

**Step 3: The statuses this owns**

`config_not_found` names where it looked and the six filenames, then gives the
`--config` invocation. `multiple_configs` lists what it found and marks which
have an `index.html` beside them, then refuses to guess.

**Step 4: Package checks**

Read the app's installed Vite version and `@opslane/sdk` version. Return
`vite_not_installed`, `vite_version_unsupported`, `sdk_not_installed`, or
`plugin_not_available_yet` when `OPSLANE_VITE_PLUGIN_MIN_VERSION` is still
`null`. Never semver-compare against `null`.

**Step 5: Test and commit**

One test per status, plus containment refusals.

```bash
git add cli/src/codemods/vite-discovery.ts cli/src/__tests__/vite-discovery.test.ts
git commit -m "feat(cli): find the Vite config and check what is installed"
```

---

## Task 9b: The transaction

The only part that writes.

**Files:**
- Create: `cli/src/codemods/vite-transaction.ts`
- Test: `cli/src/__tests__/vite-transaction.test.ts`

**Step 1: Order the steps so nothing is written before it must be**

1. Discovery and package checks (Task 9a). Nothing written.
2. Resolve the config as it is now. Already failing stops with
   `vite_config_broken_before_edit`, nothing written.
3. Run the codemod. Anything other than `edited` or `suggested` stops here.
4. Consent, including a confirmed suggestion. Declining stops here.
5. Write, atomically, preserving mode.
6. Re-read from disk and check the structure. Never trust what you think you wrote.
7. Resolve again and assert the plugin name is in the resolved plugin list.
8. Any failure at 5 to 7 restores and reports the typed reason.

Step 2 exists so a config that was already broken is not charged to us.

**Step 2: Make it testable before #224 exists**

`OPSLANE_VITE_PLUGIN_MIN_VERSION` is deliberately `null`, so the real flow stops
at `plugin_not_available_yet` and never reaches steps 5 to 8. The success and
rollback paths would be untestable.

Take the contract as an injected parameter defaulting to the real one. Tests pass
a fixture contract pointing at a local stub plugin. Do not add an environment
variable or flag that could enable this in production.

**One object, threaded everywhere.** Injecting only the transaction's contract is
not enough: discovery reads the real nullable minimum and stops at
`plugin_not_available_yet`, Task 4's conflict gate reads the installed SDK
version, and the post-resolve assertion checks the real plugin name. Define a
single `PluginContractDeps` and pass it through discovery, the codemod's policy
inputs, the resolver assertion, the transaction and the command tests.

**Step 3: Verify nothing else changed**

R7. "Exactly one entry" is wrong, because the command explicitly allows a dirty
repository after warning. Compare instead: capture `git status --porcelain`
before the first resolve, capture it again afterwards, and require every
pre-existing entry to be unchanged with at most the selected config differing.
After a restore, the two captures must match exactly.

Note in the code that this cannot see ignored paths.

**Step 4: Test every failure, not one**

One test per row of the failure table: parse failure, structure wrong on re-read,
plugin absent from the resolved list, resolve throws, resolve times out. Each
asserts `Buffer.equals` on the file plus `lstatSync().mode`, and that no temp
file is left behind.

`restore itself fails` gets different assertions, because by definition the file
cannot be back to its original bytes. Assert instead: the failure is reported
loudly with `restoreFailures` populated, the on-disk state is exactly what the
injected failure point left, and the message tells the user where their original
content is.

**Step 5: Commit**

```bash
git add cli/src/codemods/vite-transaction.ts cli/src/__tests__/vite-transaction.test.ts
git commit -m "feat(cli): transactional Vite config edit with verified rollback"
```

---

## Task 9c: Wire up the command

**Files:**
- Create: `cli/src/sourcemaps.ts`
- Modify: `cli/src/index.ts` (register after the `doctor` block at `:60`)
- Modify: `cli/src/contract.ts:37` (`AGENT_STATUSES`)
- Modify: `docs/reference/cli-agent-contract.md`
- Test: `cli/src/__tests__/sourcemaps.test.ts`

**Step 1: Flags and output modes**

`--config <path>`, `--app-dir <path>`, `--yes`, `--json`, `--check`.

| Invocation | Behaviour |
| --- | --- |
| Terminal, no flags | interactive consent |
| No terminal, no `--yes` | print the plan as JSON with `outcome`, `file`, `diff`, `disclosure`; status `consent_required`; exit 1; write nothing |
| `--yes` | apply, one JSON document out |
| `--check` | verify only, never write. Exit 0 if the plugin is registered, 1 if not |

Do not copy `onboard`'s blanket TTY gate at `cli/src/onboard/command.ts:22`. The
model was removed from this path precisely so a coding agent can run it.

Name it `install-plugin`, not `setup`: `opslane setup` at `cli/src/index.ts:71`
already means "provision credentials".

**Step 2: The two warnings the design asks for and nothing else covers**

Before consent: warn if the config already has uncommitted changes, the way the
onboarding screen does at `cli/src/onboard/tui.tsx:251`. And warn if the config
sets `build.sourcemap` itself, since the plugin overrides it. Both are lines on
the consent screen, both need a test.

**Step 3: Register every status**

`cli/src/__tests__/contract-drift.test.ts:57` walks every `.ts` under `cli/src`
for literal `exitWithStatus('…')` calls and fails on any not declared in
`AGENT_STATUSES`. `scripts/check-docs-drift.mjs` parses the doc. Add rows for
every status from Tasks 4, 9a and 9b, plus `consent_required`.

**Step 4: Exit codes**

By the contract's own rule, exit 1 means a terminal failure. So `unsupported`
and `legacy_opslane_plugin` exit 1. Write in the contract doc that S7 treats exit 1 from
this command as non-fatal, or a later slice will make a failed optional step fail
the whole onboarding run.

**Step 5: Lazy-load**

`cli/src/index.ts:96` dynamically imports `onboard` to keep React off the fast
path. Do the same here so `opslane status` does not pay for the TypeScript
compiler.

**Step 6: Test**

Non-TTY prints JSON and writes nothing. `--yes` applies. `--check` exits 1 when
absent. Both warnings appear when they should.

**Step 7: Commit**

```bash
git add cli/src/sourcemaps.ts cli/src/index.ts cli/src/contract.ts docs/reference/cli-agent-contract.md cli/src/__tests__/sourcemaps.test.ts
git commit -m "feat(cli): add opslane sourcemaps install-plugin"
```

---

## Task 10: The pages the messages point at

Two shipped messages currently point at documents that do not exist or are wrong.
That is a ship blocker.

**Files:**
- Create: `docs/guides/source-map-privacy.md`
- Create: `docs/guides/source-maps-migration.md`
- Modify: `docs/guides/source-maps.md`

**Step 1: Write the privacy page**

The consent screen has nowhere correct to link. `docs/guides/replay-privacy.md`
covers session replay and contains zero source-map mentions. Content comes from
`docs/design/2026-07-29-keys-sourcemaps-onboarding.md` §5.6.

**Step 2: Write the migration stub**

`legacy_opslane_plugin` points here. A stub plus the tracking issue is enough.

**Step 3: Fix the stale guide**

`docs/guides/source-maps.md:14` still teaches
`opslaneSourceMapPlugin({endpoint, apiKey, release})`, the API #224 replaces. Its
frontmatter has `covers: packages/sdk/vite-plugin/**`, so
`scripts/check-docs-scope.mjs` tracks it. Do not link a refused user here until
it is rewritten.

**Step 4: Commit**

```bash
git add docs/guides/
git commit -m "docs: source-map privacy and migration pages"
```

---

## Task 11: One real run

**Step 1: Prepare a scratch clone that can actually install**

`test-fixtures/react-app/package.json:14` declares `"@opslane/sdk": "workspace:*"`,
which cannot resolve once the folder leaves this workspace. So either pack the SDK
and point the copy at the tarball:

```bash
pnpm --filter @opslane/sdk pack        # produces a .tgz
# then in the scratch copy, replace workspace:* with file:/abs/path/to/that.tgz
pnpm install
```

or create the scratch project inside a disposable pnpm workspace that links it.

Then `git init && git add -A && git commit -m init` in the scratch copy, or
`git diff --stat` in step 3 has nothing to compare against and R7 cannot be shown.

**Step 2: Run it**

```bash
node cli/dist/index.js sourcemaps install-plugin --app-dir <scratch>
```

**Step 3: Check**

`git diff --stat` in the scratch clone shows exactly one changed file. `--check` exits 0. The two inserted lines are exactly the ones in the design.

**Step 4: Then break it on purpose**

Point the specifier at a plugin that throws on startup. Confirm the file comes back byte-identical.

---

## What this plan does not cover

- **Whether an upload lands in Sentry.** Needs an account. The files staged for upload already carry matching debug IDs, so the remaining risk is small.
- **Build shapes measured as rare:** configs with their own output plugins (0 of 70), builds with several outputs (0 of 70), separate worker builds (1 of 70). The cleanup that makes those shapes fail safe lives in the plugin (#224), not in
this plan. Its contract is that it sweeps the whole output directory rather than
removing remembered files, so an unfamiliar shape means a missed upload rather
than a source map left behind. Verify that behaviour is present in the published
plugin before allowing installation.
- **The plugin change itself**, which is #224. This command stops refusing projects that already run another source-map plugin only once the plugin reads its maps without removing them.
