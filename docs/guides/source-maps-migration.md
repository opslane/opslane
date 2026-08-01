---
covers:
  - cli/src/codemods/vite-messages.ts
  - cli/src/codemods/vite-sourcemaps.ts
  - packages/sdk/vite-plugin/**
---
# Migrating the legacy Vite source-map plugin

The legacy API uses `opslaneSourceMapPlugin({ endpoint, apiKey, release })`.
The zero-argument `opslane()` plugin tracked in
[#224](https://github.com/opslane/opslane-oss/issues/224) replaces it.

`opslane sourcemaps install-plugin` intentionally refuses to add a second
registration when it finds the legacy import. A double registration can change
which uploader sees or removes a map.

Until #224 is published, leave the legacy setup in place or skip source maps.
After the new SDK version is installed:

1. Remove the legacy import and `opslaneSourceMapPlugin(...)` call.
2. Run `opslane sourcemaps install-plugin`.
3. Watch the first production build and confirm the new uploader reports a
   completed batch.
4. Run `opslane sourcemaps install-plugin --check` to verify the resolved Vite
   config contains the new plugin.

Skipping source maps does not disable Opslane error capture or grouping. Stack
frames will remain minified, so original file and line numbers may be
unavailable.

