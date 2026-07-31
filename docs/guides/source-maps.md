---
covers:
  - packages/sdk/vite-plugin/**
  - packages/worker/src/source-map.ts
---
# Source maps

> Source-map upload is unavailable in this release. Remove `opslaneSourceMapPlugin()` from your Vite configuration until batch upload ships in [#218](https://github.com/opslane/opslane-oss/issues/218); leaving it enabled now fails the build deliberately.

Without source maps, production stack traces point at minified bundles and investigations can end in `sourcemap_unresolved` or `unfixable_no_sourcemap`. Batch upload is tracked in [#218](https://github.com/opslane/opslane-oss/issues/218).
Without source maps, production stack traces point at minified bundles and
investigations end in `sourcemap_unresolved` or `unfixable_no_sourcemap`. With
them, the worker sees your original source.

## What works today

| Capability | Published `@opslane/sdk@2.0.1` | This repository |
| --- | --- | --- |
| Upload maps by release | `opslaneSourceMapPlugin` | Supported |
| Stamp chunks and maps with deterministic debug IDs | Not published | Implemented by the next `opslaneVitePlugin` export |
| Send matching debug images with browser events | Not published | Implemented |
| Resolve stored maps by debug ID | Not yet | Follow-up upload/symbolication slice |

Keep using `opslaneSourceMapPlugin` in installable setup instructions until a
package containing the new export is published. Do not copy an
`opslaneVitePlugin` import into an application pinned to 2.0.1.

## Current Vite setup

Do not add `opslaneSourceMapPlugin()` to Vite yet. In this release the plugin fails
production builds immediately with a clear error, because the old single-map upload route
has been removed and the replacement batch API is not available. It does not collect,
delete, or upload map assets.
```ts
// vite.config.ts
import { opslane } from '@opslane/sdk/vite-plugin';

export default {
  plugins: [opslane()],
  // A web worker is a separate build pass and needs the plugin too, or its
  // chunks ship unstamped.
  worker: { plugins: () => [opslane()] },
};
```

`opslaneSourceMapPlugin()` is gone from that list on purpose. The single-map
route it posted to has been removed, and the batch replacement is not shipped
yet ([#218](https://github.com/opslane/opslane-oss/issues/218)), so the plugin
now fails the build rather than deleting your maps and uploading nothing.
`release` no longer participates in matching at all: the debug ID replaces it.

## Debug-ID stamping behavior

The plugin computes a deterministic ID from each source map, writes
the same ID to the map's root `debugId` field and the chunk's
`//# debugId=<id>` footer, and registers the exact runtime chunk URL. The SDK
matches stack-frame URLs against that registry and sends only exact matches in
`debug_meta.images`.

You may continue sending an immutable `release` value with SDK events. Once batch upload
ships, the value used for uploaded maps must be byte-identical to the value passed to
`init({ release })`; a git SHA is a reliable choice.
By default it requests hidden source maps and removes map assets after stamping.
It respects an explicit Vite `build.sourcemap` setting:

<a id="sourcemap-mode"></a>

| Vite setting | Result |
| --- | --- |
| unset | Uses `hidden`; stamps chunks; removes maps by default |
| `true` or `'hidden'` | Stamps; maps are removed unless `sourcemaps: 'keep'` |
| `false` | Leaves chunks unchanged and reports `OPSLANE_VITE_SOURCEMAP_DISABLED` |
| `'inline'` | Leaves chunks unchanged and reports `OPSLANE_VITE_INLINE_MAP` |

<a id="web-workers"></a>

### Web workers

Vite builds a web worker as a separate pass with its own plugin list, then copies
the result into the main bundle. A plugin listed only under `plugins` never runs
for that pass, so worker chunks come out with no debug ID and errors thrown
inside a worker cannot be symbolicated. Nothing else in the build fails, which is
why it is easy to miss. Register the plugin in both places:

```ts
export default {
  plugins: [opslane()],
  worker: { plugins: () => [opslane()] },
};
```

`worker.plugins` must be a function. Vite calls it once per worker build; passing
a shared array reuses one plugin instance across builds and its per-build
counters go wrong.

When the plugin finds worker JavaScript that no pass stamped, it reports
`OPSLANE_VITE_NESTED_BUILD_UNSTAMPED` and counts the file under
`nested build not stamped` in the build summary. The worker's map is still
removed from the output under the default `sourcemaps: 'remove'`, so an
unregistered worker costs you symbolication, not privacy.

The build options are `commitSha`, `stamp` (default `true`), `logLevel`
(`silent`, `warn`, or `debug`), `sourcemaps` (`remove` or `keep`), and
`maxMapBytes` (default 32 MiB). Each diagnostic has a stable
`OPSLANE_VITE_*` code, and every build prints a stamped/skipped summary unless
logging is silent.

Keep generating and retaining source maps according to your deployment policy, but do not
send them to Opslane in this release. Do not put an `opslane_sk_` source-map key or any
other secret in a `VITE_`, `NEXT_PUBLIC_`, or browser-bundled environment variable.
Run `opslane doctor --dist <build-output>` after a production build. The Debug
IDs check reports how many JavaScript chunks contain the footer. Without
`--dist`, doctor uses Vite's resolved `build.outDir`, then falls back to
`dist/`. A missing directory means “not built yet”; a non-empty output with no
stamps is a failure.

### Output formats

ES modules and script-like Rollup outputs (`iife`, `umd`, `cjs`, and `system`)
receive a safe registry prelude. Other formats are left unchanged with
`OPSLANE_VITE_FORMAT_UNSUPPORTED`.

### Map size limit

There is no upload to verify until #218 ships. If `opslaneSourceMapPlugin()` remains in a
Vite configuration, `vite build` must fail rather than silently deleting maps or reporting
a successful upload.

## Other bundlers

No other bundler has a supported upload path in this release.
Maps larger than `maxMapBytes` are left unchanged so a pathological asset cannot
stall the build. Raise the limit only when the map is expected and the build
machine has sufficient memory.

### Plugin order

The debug-ID plugin must see each chunk and its sibling `.map` asset. Place it
before any plugin that removes or renames maps. A missing sibling produces
`OPSLANE_VITE_MAP_MISSING`.

The plugin fingerprints in a `generateBundle` hook declared `order: 'post'`.
That is deliberate: Vite's own `vite:build-import-analysis` rewrites chunk code
during `generateBundle` and re-serialises the sibling map from `chunk.map`,
discarding anything an earlier hook wrote. Fingerprinting last is the only way
the map that reaches disk is the map that was hashed. A plugin that removes maps
should therefore also declare `order: 'post'` (the deprecated
`opslaneSourceMapPlugin` does) so that "place Opslane first" still holds.

### Verification

After the files are written, the plugin reads each shipped `.map` back off disk
and recomputes its fingerprint. A map that no longer matches the ID stamped into
its JavaScript would be rejected on upload, so it is reported at error level with
the stable code `OPSLANE_VITE_MAP_VERIFY_FAILED`, listed by file name, and
counted in the build summary. The build still exits `0`: a broken fingerprint is
an Opslane defect to fix, not a reason to block a deploy. Maps that another
plugin deliberately removed from the bundle are not verified.

### Subresource integrity

Stamping changes chunk bytes. Known SRI plugins that calculate integrity first
would make browsers reject the result, so detection disables stamping and emits
`OPSLANE_VITE_SRI_DETECTED`. Do not combine the plugins until integrity is
calculated after the final stamped bytes; use `stamp: false` when integrity is
required.

## Migration matrix

The repository's plugin tests cover all four configurations:

| Configuration | Plugin order | Result |
| --- | --- | --- |
| Legacy only | `opslaneSourceMapPlugin()` | Existing release-keyed upload remains unchanged |
| New only | forthcoming debug-ID plugin | Chunks/maps are stamped; maps are kept or removed by its option |
| Both | debug-ID plugin, then legacy upload plugin | Stamped maps remain available to the legacy uploader; the new plugin retains them for coexistence |
| Sentry | Opslane debug-ID plugin before `sentryVitePlugin()` | Sentry receives final Opslane-stamped maps; keep Opslane before Sentry and do not add an earlier SRI pass |

The “both” configuration is the migration path after the new export ships:
retain release uploads while debug-ID storage and symbolication roll out. Remove
the legacy plugin only after that server-side path is available.

## Build provenance

The plugin embeds a commit SHA when it can prove one. Resolution is explicit
`commitSha`, then `OPSLANE_COMMIT_SHA`, `GITHUB_SHA`,
`VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`, `CI_COMMIT_SHA`,
`RENDER_GIT_COMMIT`, `BITBUCKET_COMMIT`, `GIT_COMMIT`,
`BUILD_SOURCEVERSION`, and finally `.git/HEAD`. Only lowercase 40- or
64-character hexadecimal values are accepted. The build log names the rung that
won; no `git` executable is invoked.

## Verify the current upload path

Each accepted legacy upload returns HTTP `201` with its storage key:

```json
{"status": "uploaded", "object_key": "sourcemaps/<project>/<release>/index-abc123.js.map"}
```

Self-hosters can inspect `source_maps`:

```sql
SELECT release, filename FROM source_maps ORDER BY uploaded_at DESC LIMIT 5;
```

Then trigger an error from the built app. The absence of
`sourcemap_unresolved` / `unfixable_no_sourcemap`, plus a root-cause write-up
that names real source files, is the observable success signal.

## Other bundlers

Only Vite has a first-party plugin today. Other builds can upload maps through
the existing release endpoint:

```bash
curl -X POST "$OPSLANE_ENDPOINT/api/v1/sourcemaps" \
  -H "X-API-Key: $OPSLANE_API_KEY" \
  -F "release=$GIT_SHA" \
  -F "file=@dist/assets/index-abc123.js.map"
```
