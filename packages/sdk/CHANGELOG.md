# @opslane/sdk changelog

## 4.1.1

### Patch Changes

- d717dbf: The default `endpoint` now points at `https://app.opslane.com`, the host that
  actually serves the hosted Opslane API. The previous default,
  `https://api.opslane.com`, was never wired to an origin and answered every
  request with a Cloudflare 403 block page, so any `init()` that omitted
  `endpoint` on hosted Opslane failed CORS preflight and sent nothing.
  Integrations that pass `endpoint` explicitly are unaffected.

## 4.0.0

### Major Changes

- 2ce817b: The Vite plugin now reads its upload destination out of the source-map key
  itself. `OPSLANE_SOURCEMAP_KEY` must be an endpoint-bearing key
  (`opslane_sk_<key id>_<secret>_<payload>`) minted by an Opslane server at or
  above this release; a key minted before the format change is refused with
  `OPSLANE_VITE_KEY_INVALID (legacy_format)` and nothing is uploaded. The
  `OPSLANE_ENDPOINT` variable is removed: a stale value is reported via
  `OPSLANE_VITE_ENDPOINT_REMOVED` and never obeyed. Re-mint your key with
  `mint-key -scope sourcemaps` and delete the endpoint variable from CI.

## 3.0.0

### Major Changes

- cf37de5: Remove the legacy `opslaneSourceMapPlugin` export. It had been a hard-fail stub since the key split; `opslane()` now uploads source maps itself when `OPSLANE_SOURCEMAP_KEY` and `OPSLANE_ENDPOINT` are set. Configs importing the old name fail at build time with a missing-export error; run `opslane sourcemaps install-plugin` to migrate.
- 69a60c2: Separate public ingest keys from secret source-map keys.

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

- b00600f: The Vite plugin uploads stamped source maps to Opslane when OPSLANE_SOURCEMAP_KEY and OPSLANE_ENDPOINT are set. Maps without sourcesContent are now accepted by debug-ID fingerprinting.

### Minor Changes

- de59ecd: Stamp Vite builds with deterministic debug IDs and carry them into error events.

  `opslaneVitePlugin()` (exported as `opslane`) computes an ID from each source
  map, writes it to the map's `debugId` field and the chunk's `//# debugId=`
  footer, and registers the runtime chunk URL. The SDK matches stack-frame URLs
  against that registry and attaches exact matches as `debug_meta.images`. The
  raw stack is always preserved.

  The plugin name is exported as `OPSLANE_VITE_PLUGIN_NAME` so tooling can detect
  the plugin without copying the string.

  By default the plugin requests hidden source maps and removes them from the
  build output. Set `sourcemaps: 'keep'` to retain them.

  Verified against Vite 5, 6, 7, and 8.

## 2.0.1

### Patch Changes

- 18b877b: Accept Vite 8 as a peer. The range was `^6 || ^7`, so installing the SDK into a Vite 8 project failed with `ERESOLVE` before anything else could run.

## 2.0.0

### Major Changes

- 2bc04ea: Replay chunks now upload in a single authenticated request to ingestion instead of a presigned-URL handshake with object storage.

  **Breaking:** the SDK no longer calls `POST /api/v1/sessions/{id}/chunks/upload-url` or `POST /api/v1/sessions/{id}/chunks/{seq}/commit`. It posts the gzipped chunk directly to `POST /api/v1/sessions/{id}/chunks/{seq}`. Upgrade ingestion before, or at the same time as, the SDK.

  This fixes replay recording on Cloudflare R2, which does not implement the S3 POST Object API and rejected every chunk upload with `501 NotImplemented` (#194). It also cuts chunk uploads from three network round trips to one.

### Patch Changes

- 778b280: Add the agent-first onboarding protocol: non-blocking setup and authenticated relink flows, origin-and-repository-scoped credentials, safe poll-token persistence, structural SDK codemods, and a machine-readable CLI contract. Correct the SDK replay documentation and make the Vue plugin type compatible with Vue's plugin API.
- c0a6eac: Publish readiness. SDK type declarations are now bundled into flat per-entry files, inlining types from the private `@opslane/shared` package — previously the published tarball's types were unresolvable for npm consumers. CLI tarball now ships only `dist` and carries repository metadata required for npm provenance.

## 1.0.0

### BREAKING: session recording is now on by default

`replay.enabled` previously defaulted to `false`. It now defaults to `true`.
Upgrading to 1.0.0 starts recording every session unless you opt out:

```js
init({ apiKey: "...", replay: { enabled: false } });
```

This is a deliberate major version so the default changes only when you choose
to upgrade. A project-level kill switch can also stop new and in-flight
recording without redeploying.

Before upgrading, read [the replay privacy guide](../../docs/guides/replay-privacy.md):

- Check masking. Inputs are masked by default; rendered text is not. Use
  `.opslane-mask` for sensitive text and `.opslane-block` to exclude a subtree.
- Tell users that every session, rather than only error moments, is recorded.
- Check retention. The default is 30 days and the hard maximum is 90 days.

Other changes:

- Sessions survive page loads in `sessionStorage`, rotate after 30 minutes idle,
  and rotate on login/logout so one session maps to one end user.
- Recording uploads as gzipped, independently playable chunks at roughly
  30-second intervals.
- Chunks are redacted server-side before downstream reads.
- Recording requires `CompressionStream` (Chrome/Edge 80+, Safari 16.4+,
  Firefox 113+). Error reporting remains available on older browsers.
- `setUser()` and `clearUser()` now rotate the recording session.

### Fixed

- Replay upload failures can now be reported to the server instead of leaving
  replay rows pending indefinitely.
