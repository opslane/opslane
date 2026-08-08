---
covers:
  - packages/sdk/src/index.ts
  - packages/sdk/src/config.ts
---
# Install Opslane

If you use hosted Opslane, follow the web setup flow below. If you self-host, follow [Manual Fallback](#manual-fallback) and set the SDK's [`endpoint` init option](reference/sdk-options.md) to your ingestion URL.

> **Privacy:** Session recording is on by default since SDK 1.0.0; review [replay privacy and masking](guides/replay-privacy.md) before deploying.

## Web Setup

1. Sign in to Opslane.
2. Install the Opslane GitHub App.
3. Pick the repository you want Opslane to monitor.
4. Save the generated ingest key as a build or deploy secret.
5. Merge the setup PR Opslane opens for your repo.
6. Complete the user-identification (`identify()`) check: every independently built browser bundle that calls `init()` must also call the current SDK's `setUser()` after authentication. Check the main app, embeds, iframe apps, and portal or extension panels separately.
7. Deploy, trigger a test error, and wait for the dashboard to confirm the first event.

Do not infer that identity wiring in the main SPA covers another bundle. In the
AMFJ integration, the main app identified users while its customer-facing JSM
portal-panel bundle initialized Opslane without setting the same user. That left
the most important surface with anonymous-only reach. The dashboard's **No user
identification** hint is the runtime backstop: if it appears for a surface, check
that surface's entry point even when identification works elsewhere.

For Vite apps, set:

```bash
VITE_OPSLANE_API_KEY=<your Opslane ingest key>
VITE_OPSLANE_RELEASE=<your git SHA>
```

For Next.js apps, set:

```bash
NEXT_PUBLIC_OPSLANE_API_KEY=<your Opslane ingest key>
NEXT_PUBLIC_OPSLANE_RELEASE=<your git SHA>
```

`release` is optional deployment metadata; source maps match events by debug ID.

For Vite production builds, add `opslane()` from
`@opslane/sdk/vite-plugin`, set the private `OPSLANE_SOURCEMAP_KEY` build
variable — the key carries the ingestion origin it was minted for, so it is the
only upload setting — and verify the upload as described in the
[source-map guide](guides/source-maps.md). Never expose the secret key with a
`VITE_` or other browser-public prefix.

## Manual Fallback

If Opslane cannot open a setup PR for an unusual repository, install the SDK manually:

```bash
npm install @opslane/sdk
```

Then initialize it in your browser entry point:

```ts
import { init, setUser } from '@opslane/sdk';

init({
  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,
  release: import.meta.env.VITE_OPSLANE_RELEASE,
});

// Run after sign-in, in every bundle that calls init().
setUser({ id: currentUser.id, email: currentUser.email });
```

For Vue apps, also register the Vue plugin before mounting:

```ts
import { createApp } from 'vue';
import { init, opslaneVuePlugin } from '@opslane/sdk';
import App from './App.vue';

init({
  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,
  release: import.meta.env.VITE_OPSLANE_RELEASE,
});

createApp(App).use(opslaneVuePlugin).mount('#app');
```

Do not commit your ingest key to the repository. Keep it in your deploy platform or CI secret store.

## Upgrading large installations

The environments-first-class migration creates and backfills the
`error_group_environments` rollup used by filtered incident reads. The checked-in
migration uses ordinary `CREATE INDEX` statements so it remains transaction-safe
in the automatic migrator. On a large production database, operators should
schedule a maintenance window or create the equivalent indexes with
`CREATE INDEX CONCURRENTLY` before deploying, then let the guarded migration
confirm them.

The backfill is a locked, restartable recomputation from source events and active
friction signals. Do not bypass it: dashboard environment filters remain hidden
until `rollup_backfill_state` reports `complete`. Monitor ingest latency during
the rollout and use the supplied hot-path benchmark and `EXPLAIN (ANALYZE,
BUFFERS)` gate before enabling the feature for high-volume projects.
