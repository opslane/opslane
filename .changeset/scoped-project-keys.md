---
'@opslane/sdk': major
---

Separate public ingest keys from secret source-map keys.

**Breaking:** `init()` now refuses any `apiKey` that does not start with `opslane_pk_`.
It logs an error unconditionally (not only under `debug`) and does not initialize. A key
starting with `opslane_sk_` is a secret and must never ship in a browser bundle. Keys
minted before this release (`def_…`) are no longer accepted by the server either — re-run
`opslane onboard` and redeploy.

**Breaking:** `@opslane/sdk/vite-plugin` no longer uploads source maps. The single-map
upload route it posted to has been removed, and the replacement batch API is not available
yet (opslane/opslane-oss#218). `opslaneSourceMapPlugin()` now fails the build with an
explanatory error rather than silently stripping maps from the output and uploading
nothing. Remove it from your Vite plugins until batch upload ships.
