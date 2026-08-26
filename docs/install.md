---
covers:
  - packages/sdk/src/index.ts
  - packages/sdk/src/config.ts
  - packages/sdk/src/react.tsx
  - packages/sdk/src/vue.ts
description: Install the browser SDK in React, Vue, or vanilla JavaScript, identify users, and label environments.
---

# Install the SDK

The SDK sends your app's errors and session recordings to Opslane. Setup is one install command, one `init` call, and one `setUser` call.

Before you start, you need an ingest key for your project. The SDK accepts only keys beginning with `opslane_pk_`. See [API keys](guides/api-keys.md).

> **Privacy:** session recording is on by default. Review [replay privacy and masking](guides/replay-privacy.md) before you deploy.

## Install

```bash
npm install @opslane/sdk
```

React and Vue are optional peer dependencies, so you install whichever one your app already uses.

## Initialize

Call `init` once, as early as possible in your browser entry point. Then call `setUser` after sign-in.

`init` installs handlers for uncaught errors and unhandled promise rejections, instruments `console`, `fetch`, and `XMLHttpRequest`, records click and submit interactions, and starts session recording. Calling it twice is a no-op, and the SDK never throws into your code.

### React

```tsx
import { createRoot } from 'react-dom/client';
import { init, setUser } from '@opslane/sdk';
import { OpslaneErrorBoundary } from '@opslane/sdk/react';
import App from './App';

init({
  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,
  environment: import.meta.env.VITE_OPSLANE_ENVIRONMENT ?? 'development',
  endpoint: 'https://your-opslane-instance.example.com', // omit for hosted Opslane
});

// After sign-in.
setUser({ id: currentUser.id, email: currentUser.email });

createRoot(document.getElementById('root')!).render(
  <OpslaneErrorBoundary fallback={<p>Something went wrong.</p>}>
    <App />
  </OpslaneErrorBoundary>
);
```

The error boundary catches render errors, which React does not surface to `window.onerror`. Everything else, including event handlers, `setTimeout`, and promise rejections, goes to the global handlers `init` installs.

### Vue 3

```ts
import { createApp } from 'vue';
import { init, setUser, opslaneVuePlugin } from '@opslane/sdk';
import App from './App.vue';

init({
  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,
  environment: import.meta.env.VITE_OPSLANE_ENVIRONMENT ?? 'development',
  endpoint: 'https://your-opslane-instance.example.com', // omit for hosted Opslane
});

setUser({ id: currentUser.id, email: currentUser.email });

createApp(App).use(opslaneVuePlugin).mount('#app');
```

The plugin hooks `app.config.errorHandler`, keeping any handler you already registered, and tags each error with the failing component's name and lifecycle hook.

### Next.js

Initialize Opslane in a client component so the browser-only error handlers are installed after hydration. Create `app/opslane-provider.tsx`:

```tsx
'use client';
import { useEffect } from 'react';
import { init } from '@opslane/sdk';

export function OpslaneProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    init({
      apiKey: 'opslane_pk_...',
      environment: 'development',
      endpoint: 'https://your-opslane-instance.example.com', // omit for hosted Opslane
    });
  }, []);
  return <>{children}</>;
}
```

Then wrap `{children}` with `<OpslaneProvider>` in `app/layout.tsx`.

### Vanilla JavaScript

```ts
import { init, setUser } from '@opslane/sdk';

init({
  apiKey: 'opslane_pk_...',
  environment: 'production',
  endpoint: 'https://your-opslane-instance.example.com', // omit for hosted Opslane
});

setUser({ id: 'user-123' });
```

## Always call setUser

Every independently built bundle that calls `init()` must also call `setUser()` after authentication: the main app, embeds, iframe apps, and portal or extension panels each need their own call.

A bundle that skips `setUser` reports every user as anonymous. Anonymous sessions can still contribute to error impact, but Opslane cannot connect repeat activity to the same person or account, and anonymous activity cannot start a standalone session-recording issue. The dashboard flags this with **No user identification**. When it names one bundle or application, check its entry point.

## Set the environment

`environment` labels where the SDK data came from. Without it, everything lands in the project's default environment, which starts as `production`, so staging traffic reads as production. See [environments](guides/environments.md).

Set the variables at build time. For Vite:

```bash
VITE_OPSLANE_API_KEY=opslane_pk_...
VITE_OPSLANE_ENVIRONMENT=staging
```

For Next.js, use `NEXT_PUBLIC_OPSLANE_API_KEY` and `NEXT_PUBLIC_OPSLANE_ENVIRONMENT` and read them from `process.env`.

Keep the ingest key in your deploy platform or CI secret store rather than the repository. The key ships in your bundle and is safe to expose, but a committed key is slow to rotate.

## Capture errors yourself

```ts
import { captureException, clearUser } from '@opslane/sdk';

try {
  riskyThing();
} catch (err) {
  captureException(err instanceof Error ? err : new Error(String(err)));
  showFallbackUI();
}

clearUser(); // on logout
```

Throw real `Error` objects rather than strings. A string throw arrives with no stack frames, and Opslane classifies it as `unfixable_no_app_frames` ([reason codes](reference/reason-codes.md)).

## Upload source maps

Production stacks point at minified bundles until you upload source maps. For Vite, add the `opslane()` plugin and set `OPSLANE_SOURCEMAP_KEY`; see [source maps](guides/source-maps.md). Only Vite has a first-party upload integration today.

## Serve cross-origin scripts correctly

If your bundle is served from a different origin than your page, add `crossorigin` to the script tag. Without it, browsers report `Script error.` with no stack, and Opslane drops those events as noise.

```html
<script type="module" crossorigin src="https://cdn.example.com/app.js"></script>
```

## Verify

Trigger an error in your app, then open the dashboard. It should appear as an issue within a few seconds. If nothing arrives, check the key prefix, the `endpoint` value on self-hosted installs, and the browser console for SDK warnings (set `debug: true` to see them).

Every `init` option, with types and defaults: [SDK options](reference/sdk-options.md).
