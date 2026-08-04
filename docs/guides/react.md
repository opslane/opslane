---
covers:
  - packages/sdk/src/react.tsx
  - packages/sdk/vite-plugin/**
---
# React setup

Wire the Opslane SDK into a React 18/19 app so render errors are captured through an error boundary.

## Install

```bash
npm install @opslane/sdk
```

React is an optional peer dependency of the SDK — installing `@opslane/sdk` does not pull React in.

## Initialize and wrap

```tsx
import { createRoot } from 'react-dom/client';
import { init } from '@opslane/sdk';
import { OpslaneErrorBoundary } from '@opslane/sdk/react';
import App from './App';

init({
  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,
  endpoint: 'https://your-opslane-instance.example.com', // omit for hosted Opslane
  release: import.meta.env.VITE_OPSLANE_RELEASE,
});

createRoot(document.getElementById('root')!).render(
  <OpslaneErrorBoundary fallback={<p>Something went wrong.</p>}>
    <App />
  </OpslaneErrorBoundary>
);
```

This example uses Vite. In Next.js, read `process.env.NEXT_PUBLIC_OPSLANE_API_KEY` and `process.env.NEXT_PUBLIC_OPSLANE_RELEASE` instead.

> **Privacy:** Session recording is on by default since SDK 1.0.0; review [replay privacy and masking](replay-privacy.md) before deploying.

## What gets caught where

- **Render errors** (thrown during render, in lifecycle, or in hooks' render phase) are caught by `OpslaneErrorBoundary`, reported, and replaced with your `fallback` UI.
- **Everything else** — event handlers, `setTimeout`, promise rejections — bypasses React error boundaries by design; the SDK's global handlers (installed by `init`) catch those.
- To report an error you caught yourself inside a boundary of your own, use `captureReactError(error)` from `@opslane/sdk/react` (or the framework-agnostic `captureException`).

Place boundaries as granularly as you like — a boundary per route keeps one broken page from blanking the whole app, and every boundary still reports.

## Verify it works

```tsx
function Crash() { throw new Error('opslane react smoke test'); }
// render <Crash /> inside the boundary once, then remove it
```

The event should appear in your dashboard (or via the incidents API) within seconds.

## Next

- [Upload source maps](source-maps.md) so stacks resolve to your JSX/TSX
  sources.
- All init options: [SDK options reference](../reference/sdk-options.md)
