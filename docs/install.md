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

## Let your agent do it

Paste this into your coding agent:

```text
Set up https://docs.opslane.com/INSTALL.md
```

Your agent installs the SDK, verifies an error from your app, and configures source-map uploads. You approve the project in your browser and choose whether to connect GitHub, Slack, CI secrets, and MCP.

For manual setup, follow the steps below.

Before you start, you need an ingest key for your project. The SDK accepts only keys beginning with `opslane_pk_`. See [API keys](guides/api-keys.md).

The onboarding wizard puts this key directly in its setup snippet so you can send a test event immediately. The key ships in your bundle; move it to an environment variable before committing.

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
  apiKey: 'opslane_pk_...',
  environment: 'development',
  endpoint: 'https://your-opslane-instance.example.com', // https://app.opslane.com for hosted Opslane
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
  apiKey: 'opslane_pk_...',
  environment: 'development',
  endpoint: 'https://your-opslane-instance.example.com', // https://app.opslane.com for hosted Opslane
});

setUser({ id: currentUser.id, email: currentUser.email });

createApp(App).use(opslaneVuePlugin).mount('#app');
```

The plugin hooks `app.config.errorHandler`, keeping any handler you already registered, and tags each error with the failing component's name and lifecycle hook.

### Next.js

Initialize Opslane in a client component after hydration. Route SDK requests through your app so a Content-Security-Policy allowing `connect-src 'self'` covers them and ad blockers are less likely to drop them. Add this rewrite to `next.config.*`, preserving any existing rewrites:

```ts
async rewrites() {
  return [{
    source: '/opslane/:path*',
    destination: 'https://app.opslane.com/:path*',
  }];
}
```

For a self-hosted deployment, replace the destination origin with your Opslane address. SDK requests omit browser credentials. If you have middleware, ensure it does not add `Authorization` or `Cookie` headers to `/opslane/*`.

Set `NEXT_PUBLIC_OPSLANE_API_KEY` in your gitignored `.env.local`, then create `app/opslane-provider.tsx`:

```tsx
'use client';
import { useEffect } from 'react';
import { init } from '@opslane/sdk';

export function OpslaneProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_OPSLANE_API_KEY;
    if (!apiKey) throw new Error('NEXT_PUBLIC_OPSLANE_API_KEY is not set: add it to .env.local and restart the dev server');
    init({
      apiKey,
      endpoint: '/opslane',
      environment: process.env.NEXT_PUBLIC_OPSLANE_ENVIRONMENT ?? 'development',
    });
  }, []);
  return <>{children}</>;
}
```

Then wrap `{children}` with `<OpslaneProvider>` in `app/layout.tsx`.
Call `setUser` from a client component after sign-in, as you would in React or Vue. If your app already has a client-side authentication provider, you can initialize Opslane there instead of adding a separate provider.

### Vanilla JavaScript

```ts
import { init, setUser } from '@opslane/sdk';

init({
  apiKey: 'opslane_pk_...',
  environment: 'development',
  endpoint: 'https://your-opslane-instance.example.com', // https://app.opslane.com for hosted Opslane
});

setUser({ id: 'user-123' });
```

## Always call setUser

Every independently built bundle that calls `init()` must also call `setUser()` after authentication: the main app, embeds, iframe apps, and portal or extension panels each need their own call.

A bundle that skips `setUser` reports every user as anonymous. Anonymous sessions can still contribute to error impact, but Opslane cannot connect repeat activity to the same person or account, and anonymous activity cannot start a standalone session-recording issue. The dashboard flags this with **No user identification**. When it names one bundle or application, check its entry point.

## Content-Security-Policy

If your app sends directly to hosted Opslane, include its origin in your existing policy:

```text
connect-src 'self' https://app.opslane.com;
```

Preserve other origins your app needs. For self-hosting, use your own Opslane origin. The Next.js tunnel above only needs `'self'`. Replay uploads also need the storage origin returned by your deployment; a blocked request appears in the browser console.

## Set the environment

`environment` labels where the SDK data came from. Without it, everything lands in the project's default environment, which starts as `production`, so staging traffic reads as production. See [environments](guides/environments.md).

Set the variables at build time. For Vite:

```bash
VITE_OPSLANE_API_KEY=opslane_pk_...
VITE_OPSLANE_ENVIRONMENT=staging
```

For Next.js, use `NEXT_PUBLIC_OPSLANE_API_KEY` and `NEXT_PUBLIC_OPSLANE_ENVIRONMENT` and read them from `process.env`.

Keep the ingest key in your deploy platform or CI secret store rather than the repository. Browsers can read the key from the built bundle, but a committed key is slow to rotate.

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

Production stacks point at minified bundles until you upload source maps. For Vite, add the `opslane()` plugin and set `OPSLANE_SOURCEMAP_KEY`; see [source maps](guides/source-maps.md). For Next.js and other bundlers, run `opslane-sourcemaps` after the production build, as described in the same guide.

## Serve cross-origin scripts correctly

If your bundle is served from a different origin than your page, add `crossorigin` to the script tag. Without it, browsers report `Script error.` with no stack, and Opslane drops those events as noise.

```html
<script type="module" crossorigin src="https://cdn.example.com/app.js"></script>
```

## Verify

Temporarily render a button that throws `new Error('opslane-test')`, then click it. Use `onClick={() => { throw new Error('opslane-test'); }}` in React or Next.js, `@click="() => { throw new Error('opslane-test') }"` in Vue, or `onclick="throw new Error('opslane-test')"` in HTML.

The error should appear as an issue within a few seconds. Delete the test button after Opslane receives it. If nothing arrives, check the key prefix, the `endpoint` value on self-hosted installs, and the browser console for SDK warnings (set `debug: true` to see them).

Every `init` option, with types and defaults: [SDK options](reference/sdk-options.md).

## Optional operator usage notifications

Self-hosted operators can set `USAGE_EVENTS_SLACK_WEBHOOK` on both server-side services to send best-effort notifications to a Slack incoming webhook. When unset, usage notifications are fully disabled.

The notifications cover user signup and login, an environment's first SDK event, issue admission, fix PR creation, needs-human outcomes, delivered digests, and successful MCP tool calls. Delivery is fire-and-forget and is not an audit log.

> **Privacy:** These messages can contain customer email addresses and error titles. Send them only to a private channel whose membership matches your production-data access policy, and store the webhook as a deployment secret.
