# @opslane/sdk changelog

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
