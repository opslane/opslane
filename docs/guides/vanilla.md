---
covers:
  - packages/sdk/src/core.ts
  - packages/sdk/src/index.ts
  - packages/sdk/src/config.ts
---
# Vanilla JavaScript setup

Use the Opslane SDK in any browser app — no framework required.

## Install

```bash
npm install @opslane/sdk
```

## Initialize

As early as possible in your entry module:

```ts
import { init } from '@opslane/sdk';

init({
  apiKey: 'your-opslane-ingest-key',
  endpoint: 'https://your-opslane-instance.example.com', // omit for hosted Opslane
  release: 'your-git-sha',
});
```

A namespace form is also exported if you prefer a single global-style object:

```ts
import { Opslane } from '@opslane/sdk';
Opslane.init({ apiKey: '...' });
```

`init` installs handlers for uncaught errors and unhandled promise rejections, and instruments `console`, `fetch`, and `XMLHttpRequest` as breadcrumb sources. It is idempotent — a second call is a no-op — and the SDK never throws into your code.

> **Privacy:** Session recording is on by default since SDK 1.0.0; review [replay privacy and masking](replay-privacy.md) before deploying.

## Manual capture and user context

```ts
import { captureException, setUser, clearUser } from '@opslane/sdk';

try {
  riskyThing();
} catch (err) {
  captureException(err instanceof Error ? err : new Error(String(err)));
  showFallbackUI();
}

setUser({ id: 'user-123' });  // attach an identity to subsequent events
clearUser();                  // e.g. on logout
```

Throw real `Error` objects, not strings — string throws arrive without stack frames and are triaged as `unfixable_no_app_frames` ([reason codes](../reference/reason-codes.md)).

## Cross-origin scripts

If your bundle is served from a CDN on another origin, add `crossorigin` to the script tag (and CORS headers on the CDN) — otherwise the browser gives error handlers only `"Script error."` with no frames, and there is nothing to investigate.

```html
<script src="https://cdn.example.com/app.js" crossorigin="anonymous"></script>
```

## Verify it works

Run `throw new Error('opslane vanilla smoke test')` from your app (not the devtools console — extensions and console context can muddy origins). The event should appear in your dashboard within seconds.

## Next

- [Upload source maps](source-maps.md) so minified stacks resolve. The guide
  distinguishes the currently published Vite upload plugin from the forthcoming
  debug-ID export.
- All init options: [SDK options reference](../reference/sdk-options.md)
