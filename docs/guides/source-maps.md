---
covers:
  - packages/ingestion/cmd/mint-key/**
  - packages/ingestion/handler/sourcemap_upload.go
  - packages/sdk/vite-plugin/**
  - packages/sdk/sourcemaps-cli/**
  - packages/sdk/src/build/**
  - packages/worker/src/resolve-stack.ts
description: Upload source maps from Vite, Next.js, and other bundlers so production stack traces point at your source.
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

Open **Settings → API keys**, choose the **sourcemaps** scope, and create a key. Copy its one-time value into your build environment as `OPSLANE_SOURCEMAP_KEY`. Keys are listed and revocable in Settings; creating a new key leaves existing keys active.

Self-hosted operators can also create one from the Opslane server container:

```bash
docker exec <ingestion-container> mint-key \
  -project <project-uuid> \
  -scope sourcemaps \
  -label "production source maps"
```

It prints the project's name and repo, so you can check it is the right one, then the key once. To revoke a key later, run the SQL the command prints. Creating a new key never revokes old ones.

## Next.js and other bundlers

For Next.js, enable browser source maps only when the upload key is present in the build environment:

```ts
// next.config.ts
export default {
  productionBrowserSourceMaps: Boolean(process.env.OPSLANE_SOURCEMAP_KEY),
};
```

Update your package's build script:

```json
{
  "scripts": {
    "build": "next build && opslane-sourcemaps .next/static"
  }
}
```

The command finds JavaScript files with adjacent `.map` files, stamps matching debug IDs into both, uploads the maps, and removes them after a successful upload. It accepts regular and indexed source maps, including Turbopack output. Run it before serving or deploying the build.

For another bundler, generate source maps when `OPSLANE_SOURCEMAP_KEY` is set, then run:

```bash
opslane-sourcemaps <build-dir> --format es
```

Use `--format es` for ES modules. The default is `iife`, suitable for Next.js browser chunks. `--keep-maps` retains maps after upload for local debugging; do not publish those files unless you intend to expose their source.

Without a key, both the Vite plugin and command skip uploads. The Next.js configuration above also skips map generation, so deferring the secret does not expose source files. Configure other bundlers the same way.

| Exit code | Meaning |
| --- | --- |
| `0` | Upload succeeded, or skipped because the key is absent |
| `1` | Invalid input, invalid key, or stamping failed |
| `2` | Upload failed; maps remain for retry |


## A note on privacy

Source maps include your original source. Uploading them lets Opslane read that source to investigate errors. They are stored privately and never served to the browser. See [source-map privacy](source-map-privacy.md) for the details.

## Check it worked

Trigger an error from your built app and open the event in Opslane. The stack trace should show the original file names and line numbers. If it still shows minified paths, the map did not upload: check that `OPSLANE_SOURCEMAP_KEY` is set in the build and that the build ran the plugin.
