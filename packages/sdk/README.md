# @opslane/sdk

Browser error-monitoring SDK for [Opslane](https://github.com/opslane/opslane-oss) — an AI-powered production error-resolution engine. The SDK captures unhandled errors, console/network breadcrumbs, and (optionally) session replays, and ships them to your Opslane instance, which investigates each error and opens a verified fix PR or files an actionable incident.

The SDK is MIT licensed. It never throws into your application code: every hook is wrapped so an SDK failure cannot break your app.

## Install

```bash
npm install @opslane/sdk
```

## Initialize

Call `init` once, as early as possible in your browser entry point:

```ts
import { init } from '@opslane/sdk';

init({
  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,
  endpoint: 'https://your-opslane-instance.example.com', // omit for hosted Opslane
  release: import.meta.env.VITE_OPSLANE_RELEASE,          // e.g. your git SHA
});
```

`VITE_OPSLANE_API_KEY` is the project-scoped public ingest key created by onboarding and
must start with `opslane_pk_`. Never put an `opslane_sk_` source-map key in browser code.

`init` installs global `error`/`unhandledrejection` handlers and instruments `console`, `fetch`, and `XMLHttpRequest` for breadcrumbs. Calling it twice is a no-op. `destroy()` reverses everything.

`release` is optional deployment metadata. Source maps match by debug ID, not release.

## Framework integrations

### Vue 3

The Vue plugin hooks `app.config.errorHandler` (preserving any existing handler) and tags events with the failing component name:

```ts
import { createApp } from 'vue';
import { init, opslaneVuePlugin } from '@opslane/sdk';

init({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY });
createApp(App).use(opslaneVuePlugin).mount('#app');
```

### React 18/19

An error boundary that reports render errors, from the `/react` entry:

```tsx
import { init } from '@opslane/sdk';
import { OpslaneErrorBoundary } from '@opslane/sdk/react';

init({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY });

<OpslaneErrorBoundary fallback={<p>Something went wrong</p>}>
  <App />
</OpslaneErrorBoundary>
```

React and Vue are optional peer dependencies — installing the SDK pulls in neither.

### Vite source maps

The Vite plugin stamps and uploads production source maps when the two private
build variables `OPSLANE_ENDPOINT` and `OPSLANE_SOURCEMAP_KEY` are set:

```ts
import { opslane } from '@opslane/sdk/vite-plugin';

export default {
  plugins: [opslane()],
  worker: { plugins: () => [opslane()] },
};
```

Never use a `VITE_` prefix for the secret `opslane_sk_` key. The plugin also
reads gitignored Vite env files such as `.env.local`. Upload errors are reported
without failing the build, and generated maps are removed from output by
default. See the [source-map guide](../../docs/guides/source-maps.md).

Build options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `commitSha` | `string` | CI environment or `.git/HEAD` | Lowercase 40- or 64-character build commit. |
| `stamp` | `boolean` | `true` | Set `false` to leave chunks and maps unchanged. |
| `logLevel` | `'silent' \| 'warn'` | `'warn'` | Build diagnostics and summary verbosity. |
| `sourcemaps` | `'remove' \| 'keep'` | `'remove'` | Whether emitted map assets remain in the build output. |
| `maxMapBytes` | `number` | `33554432` | Maximum raw map size eligible for stamping. |

## Configuration

All `init` options, from the SDK's `SdkInitOptions` type:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | *(required)* | Project ingest key. `init` is a no-op without it. |
| `endpoint` | `string` | `https://api.opslane.com` | Your Opslane instance. Must be a valid http(s) URL. |
| `release` | `string` | `''` | Immutable build identifier; must match uploaded source maps. |
| `maxBreadcrumbs` | `number` | `50` | Maximum breadcrumbs kept in the ring buffer. |
| `breadcrumbMaxAge` | `number` | `30000` | Milliseconds a breadcrumb stays relevant before being dropped. |
| `flushInterval` | `number` | `5000` | Milliseconds between batched event flushes. |
| `maxBatchSize` | `number` | `10` | Maximum events per flush batch. |
| `debug` | `boolean` | `false` | Log SDK-internal problems to the console. |
| `reporting.enabled` | `boolean` | `true` | Send lightweight SDK/session metadata on initialization. Disable to suppress session reporting; this also prevents replay startup but does not disable error events. |
| `replay.enabled` | `boolean` | `true` | Capture session replays around errors. **On by default.** |
| `sampleRate` | `number` | `1` | Fraction of events sent, clamped to `[0, 1]`. |
| `errorThrottleMs` | `number` | `1000` | Minimum milliseconds between reports of the same error. |
| `beforeSend` | `(event) => event \| null` | — | Inspect/modify every event before sending; return `null` to drop it. |

## Manual capture and user context

```ts
import { captureException, setUser, clearUser } from '@opslane/sdk';

captureException(new Error('caught but worth reporting'));
setUser({ id: 'user-123' });
clearUser();
```

## Privacy defaults

- **Session recording is on by default since 1.0.0** (`replay.enabled` defaults to `true`); opt out with `replay: { enabled: false }`.
- Session initialization metadata is reported independently of replay; opt out with `reporting: { enabled: false }`. This also prevents replay startup but does not disable error-event delivery.
- Replay masks **all input values** (`maskAllInputs: true`) and any element matching the `.opslane-mask` selector; `.opslane-block` excludes a subtree entirely.
- Captured URLs are scrubbed of query strings, userinfo, and token-bearing hashes; captured text is scrubbed of JWTs, `Bearer` tokens, and `password`/`secret`/`api_key`-style key-value pairs before leaving the browser.
- Use `beforeSend` to drop or redact anything scrubbing doesn't cover.

See [replay privacy and masking](https://github.com/opslane/opslane-oss/blob/main/docs/guides/replay-privacy.md) for what replay data may contain.

## License

MIT — see [LICENSE](./LICENSE). The Opslane server components are licensed separately (AGPL-3.0-only).
