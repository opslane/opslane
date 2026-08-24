---
description: Every browser SDK init option with its type and default.
---
# SDK options

All options accepted by `init()` from `@opslane/sdk`, mirrored from `SdkInitOptions` and the defaults object in `packages/sdk/src/config.ts`. The [drift check](../../scripts/check-docs-drift.mjs) fails the repository test gate (`pnpm test`, which CI runs) if the type and this page disagree.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | *(required)* | Project-scoped public ingest key. It must start with `opslane_pk_`; `init` refuses to start without it. |
| `endpoint` | `string` | `https://api.opslane.com` | Your Opslane instance; validated as an http(s) URL. |
| `release` | `string` | `''` | Optional immutable deployment identifier; source maps match by debug ID. |
| `environment` | `string` | `''` | Optional deployment name sent with events and session initialization. The server uses it only when payload overrides are enabled for the project; existing session environment assignment takes precedence. |
| `maxBreadcrumbs` | `number` | `50` | Ring-buffer size for breadcrumbs attached to each event. |
| `breadcrumbMaxAge` | `number` | `30000` | Milliseconds before a breadcrumb is considered stale and dropped. |
| `flushInterval` | `number` | `5000` | Milliseconds between transport flushes. |
| `maxBatchSize` | `number` | `10` | Maximum events per flush. |
| `debug` | `boolean` | `false` | Log SDK-internal problems to the console. |
| `reporting` | `{ enabled?: boolean }` | `{ enabled: true }` | Lightweight session registration. Independent of the session-recording setting; set `enabled: false` to suppress `/api/v1/sessions/init`, which also prevents recording from starting. Error-event delivery is unaffected. |
| `replay` | `{ enabled?: boolean }` | `{ enabled: true }` | Session recording. **On by default.** Set `enabled: false` to opt out; a project-wide recording switch also exists on the server. Needs `CompressionStream` support. |
| `sampleRate` | `number` | `1` | Fraction of events sent; clamped to `[0, 1]`. |
| `errorThrottleMs` | `number` | `1000` | Minimum interval between reports of the same error. |
| `beforeSend` | `(event) => event \| null` | `undefined` | Final hook: mutate the outgoing payload or return `null` to drop it. |

Opslane calls the identifier embedded in a built file and its source map a debug ID. It uses the debug ID to match the two.

Metadata for matching source maps is assembled from the final redacted stack immediately
before `beforeSend`, so the hook can inspect, alter, or remove `debug_meta` and
`commit_sha` like any other event field.


## Vite build options

The Vite debug-ID and source-map upload plugin accepts:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| **commitSha** | `string` | detected | Explicit build commit; must be lowercase 40- or 64-character hex. |
| **stamp** | `boolean` | `true` | Adds the same build identifier to each built file and source map, then records it in the browser. |
| **logLevel** | `'silent' \| 'warn'` | `'warn'` | Controls plugin warnings and the build summary. |
| **sourcemaps** | `'remove' \| 'keep'` | `'remove'` | Keeps or removes map assets with build identifiers from the output. |
| **maxMapBytes** | `number` | `33554432` | Raw source-map size limit. Oversized maps and chunks are left unchanged. |

Uploads require one private build-time variable, `OPSLANE_SOURCEMAP_KEY`: the
key carries the Opslane server origin it was created for, so it configures both the
credential and the destination. See the [source-map guide](../guides/source-maps.md).

Related exports: `captureException(err)`, `setUser({ id })`, `clearUser()`, `destroy()`, `opslaneVuePlugin`, and (from `@opslane/sdk/react`) `OpslaneErrorBoundary` / `captureReactError`. The `@opslane/sdk/vite-plugin` export adds build identifiers to source maps and uploads them during production builds. See the [SDK README](../../packages/sdk/README.md).
