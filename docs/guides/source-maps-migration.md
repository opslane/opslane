---
covers:
  - cli/src/codemods/vite-messages.ts
  - cli/src/codemods/vite-sourcemaps.ts
  - packages/sdk/vite-plugin/**
---
# Migrating the legacy Vite source-map plugin

The legacy API was `opslaneSourceMapPlugin({ endpoint, apiKey, release })`.
It was removed in `@opslane/sdk` 3.0.0: the zero-argument `opslane()` plugin
replaces it, uploading maps itself when `OPSLANE_SOURCEMAP_KEY` and
`OPSLANE_ENDPOINT` are set in the build environment. A config that still
imports the legacy name fails at build time with a missing-export error.

`opslane sourcemaps install-plugin` intentionally refuses to add a second
registration when it finds the legacy import. A double registration can change
which uploader sees or removes a map.

To migrate after installing the 3.x SDK:

1. Remove the legacy import and `opslaneSourceMapPlugin(...)` call.
2. Run `opslane sourcemaps install-plugin`.
3. Set `OPSLANE_SOURCEMAP_KEY` and `OPSLANE_ENDPOINT` where the production
   build runs, then watch the first build log for `Uploaded N/N source maps`.
4. Run `opslane sourcemaps install-plugin --check` to verify the resolved Vite
   config contains the new plugin.

Skipping source maps does not disable Opslane error capture or grouping. Stack
frames will remain minified, so original file and line numbers may be
unavailable.

