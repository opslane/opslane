---
covers:
  - packages/ingestion/cmd/mint-key/**
  - packages/ingestion/handler/sourcemap_upload.go
  - packages/sdk/vite-plugin/**
  - packages/worker/src/resolve-stack.ts
description: Upload Vite source maps so production stack traces point at your source.
---

# Source maps

Production stack traces point at minified bundles like `index.a1b2c3.js`. Upload your source maps and Opslane turns those back into real file names and line numbers, so it can read the code that actually caused an error.

## Set it up

Add the Opslane plugin to your Vite build:

```ts
// vite.config.ts
import { opslane } from '@opslane/sdk/vite-plugin';

export default {
  plugins: [opslane()],
  // Vite builds web workers separately, so give them the plugin too.
  worker: { plugins: () => [opslane()] },
};
```

Then set your source-map key in CI:

```bash
OPSLANE_SOURCEMAP_KEY=opslane_sk_...
```

That is the whole setup. On each production build, the plugin uploads your maps and removes them from the output, so they never ship to the browser. The key already knows which Opslane deployment to upload to, so there is nothing else to configure.

The key is a **secret**. Never prefix it with `VITE_` or `NEXT_PUBLIC_`, and never commit it. It is different from the public `opslane_pk_` ingest key you put in the browser.

## Get a source-map key

Create one from the Opslane server container. It can upload source maps and nothing else:

```bash
docker exec <ingestion-container> mint-key \
  -project <project-uuid> \
  -scope sourcemaps \
  -label "production source maps"
```

It prints the project's name and repo, so you can check it is the right one, then the key once. To revoke a key later, run the SQL the command prints. Creating a new key never revokes old ones.

Only Vite has a first-party integration today.

## A note on privacy

Source maps include your original source. Uploading them lets Opslane read that source to investigate errors. They are stored privately and never served to the browser. See [source-map privacy](source-map-privacy.md) for the details.

## Check it worked

Trigger an error from your built app and open the event in Opslane. The stack trace should show the original file names and line numbers. If it still shows minified paths, the map did not upload: check that `OPSLANE_SOURCEMAP_KEY` is set in the build and that the build ran the plugin.
