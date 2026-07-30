---
covers:
  - packages/sdk/vite-plugin/**
  - packages/worker/src/source-map.ts
---
# Source maps

> Source-map upload is unavailable in this release. Remove `opslaneSourceMapPlugin()` from your Vite configuration until batch upload ships in [#218](https://github.com/opslane/opslane-oss/issues/218); leaving it enabled now fails the build deliberately.

Without source maps, production stack traces point at minified bundles and investigations can end in `sourcemap_unresolved` or `unfixable_no_sourcemap`. Batch upload is tracked in [#218](https://github.com/opslane/opslane-oss/issues/218).

## The Vite plugin

Do not add `opslaneSourceMapPlugin()` to Vite yet. In this release the plugin fails
production builds immediately with a clear error, because the old single-map upload route
has been removed and the replacement batch API is not available. It does not collect,
delete, or upload map assets.

## The release contract

You may continue sending an immutable `release` value with SDK events. Once batch upload
ships, the value used for uploaded maps must be byte-identical to the value passed to
`init({ release })`; a git SHA is a reliable choice.

## In CI

Keep generating and retaining source maps according to your deployment policy, but do not
send them to Opslane in this release. Do not put an `opslane_sk_` source-map key or any
other secret in a `VITE_`, `NEXT_PUBLIC_`, or browser-bundled environment variable.

## Verifying

There is no upload to verify until #218 ships. If `opslaneSourceMapPlugin()` remains in a
Vite configuration, `vite build` must fail rather than silently deleting maps or reporting
a successful upload.

## Other bundlers

No other bundler has a supported upload path in this release.
