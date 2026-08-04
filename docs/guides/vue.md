---
covers:
  - packages/sdk/src/vue.ts
  - packages/sdk/vite-plugin/**
---
# Vue 3 setup

Wire the Opslane SDK into a Vue 3 app so component errors are captured with the failing component's name attached.

## Install

```bash
npm install @opslane/sdk
```

## Initialize

In your entry point, before creating the app — this is the exact pattern the repository's own test fixture uses (`test-fixtures/vue-app/src/main.ts`):

```ts
import { createApp } from 'vue';
import App from './App.vue';
import { init, opslaneVuePlugin } from '@opslane/sdk';

init({
  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,
  endpoint: 'https://your-opslane-instance.example.com', // omit for hosted Opslane
  release: import.meta.env.VITE_OPSLANE_RELEASE,
});

const app = createApp(App);
app.use(opslaneVuePlugin);
app.mount('#app');
```

> **Privacy:** Session recording is on by default since SDK 1.0.0; review [replay privacy and masking](replay-privacy.md) before deploying.

Set the environment variables at build time:

```bash
VITE_OPSLANE_API_KEY=<your ingest key>
VITE_OPSLANE_RELEASE=<your git SHA>
```

## What the plugin does

`opslaneVuePlugin` wraps `app.config.errorHandler`. Errors thrown in components are reported with a `vue.error` breadcrumb carrying the failing component's name and the lifecycle hook it failed in, then passed on to any error handler you had already registered — the plugin chains, it does not replace.

Errors outside Vue's render cycle (event handlers that escape, async code, plain JS) are caught by the SDK's global handlers, which `init` installs regardless of the plugin.

## Verify it works

Throw a test error from a component and watch it arrive:

```ts
onMounted(() => { throw new Error('opslane vue smoke test'); });
```

The event should appear in your dashboard (or via the incidents API) within seconds, grouped under a `needs_human`/`investigated`/fix flow per the [life of an error](../architecture/life-of-an-error.md).

## Next

- [Upload source maps](source-maps.md) so stacks resolve to your `.vue`
  sources. The plugin uploads them when OPSLANE_SOURCEMAP_KEY and
  OPSLANE_ENDPOINT are set.
- All init options: [SDK options reference](../reference/sdk-options.md)
