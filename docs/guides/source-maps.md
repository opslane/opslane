---
covers:
  - packages/ingestion/cmd/mint-key/**
  - packages/ingestion/handler/sourcemap_upload.go
  - packages/sdk/vite-plugin/**
  - packages/worker/src/resolve-stack.ts
---
# Source maps

Opslane's Vite plugin stamps each production chunk with a deterministic debug
ID, uploads the matching source map with a secret project key, and removes the
map from the build output by default. Browser events carry the chunk URL and
debug ID; the worker uses that exact pair to resolve original source positions.
The SDK's `release` option is still useful deployment metadata, but it is not
part of source-map matching.

## Configure a Vite build

```ts
// vite.config.ts
import { opslane } from '@opslane/sdk/vite-plugin';

export default {
  plugins: [opslane()],
  // Workers are separate Vite build passes and need their own plugin instance.
  worker: { plugins: () => [opslane()] },
};
```

Set these server-side build variables in CI:

```bash
OPSLANE_ENDPOINT=https://your-opslane-instance.example.com
OPSLANE_SOURCEMAP_KEY=opslane_sk_...
```

The plugin reads `process.env` first, then Vite's `OPSLANE_` variables from the
project's env files. A gitignored `.env.local` therefore works for local
production builds:

```dotenv
OPSLANE_ENDPOINT=http://localhost:8082
OPSLANE_SOURCEMAP_KEY=opslane_sk_...
```

Do not prefix either variable with `VITE_`, `NEXT_PUBLIC_`, or another browser
environment prefix. The source-map key is a secret and must never enter the
JavaScript bundle or a tracked file. Browser initialization continues to use a
public `VITE_OPSLANE_API_KEY=opslane_pk_...` ingest key.

Uploads happen during `closeBundle`. Each final map is sent with
`PUT /api/v1/sourcemaps/{debugID}`; HTTP 200 and 201 are success. Rate-limited
uploads honor `Retry-After`, network errors get one retry, and upload failures
are reported without failing the production build.

## Mint and revoke an upload key

Self-hosted operators mint a key from the ingestion package:

```bash
cd packages/ingestion
DATABASE_URL=postgres://... go run ./cmd/mint-key \
  -project 00000000-0000-0000-0000-000000000000 \
  -label "production source maps"
```

The command prints the raw `opslane_sk_` value once and prints its key ID. To
revoke exactly that key, run the statement it prints:

```sql
UPDATE project_api_keys SET revoked_at = now() WHERE key_id = '<key-id>';
```

Minting another key does not revoke existing keys. Revocation is always an
explicit, exact-key operation.

## Map custody

The default `sourcemaps: 'remove'` mode asks Vite for hidden maps, stamps them,
uploads the final in-memory bytes, and removes the `.map` assets before deploy.
An explicitly configured Vite source-map setting belongs to the project and is
left in the output unless `sourcemaps: 'remove'` applies to maps the plugin
requested itself.

| Setting | Result |
| --- | --- |
| Vite `build.sourcemap` unset | Generates hidden maps, stamps and uploads them, then removes them |
| `build.sourcemap: 'hidden'` or `true` | Stamps and uploads disk-verified maps; keeps the project-owned files |
| `build.sourcemap: false` | No map is available; emits `OPSLANE_VITE_SOURCEMAP_DISABLED` |
| `build.sourcemap: 'inline'` | Leaves the chunk unchanged; emits `OPSLANE_VITE_INLINE_MAP` |

Set `opslane({ sourcemaps: 'keep' })` only when another trusted uploader needs
the files. Retained maps can expose original source if the build directory is
served publicly. Opslane re-reads and fingerprints every retained map at upload
time so a later plugin cannot make the uploaded bytes disagree with the chunk.

When a project is deleted, ingestion writes a `sourcemap_tombstones` row before
the project row disappears. Until the automatic sweeper ships, purge the
recorded prefix manually and then remove the tombstone:

```bash
mc rm -r --force <bucket>/sourcemaps/<projectID>/
```

```sql
DELETE FROM sourcemap_tombstones WHERE project_id = '<projectID>';
```

Only delete the tombstone after object removal succeeds.

## Diagnostics and limits

The server accepts at most 32 MiB of identity-encoded bytes per map. The plugin
uses the same default `maxMapBytes`; raising it allows stamping but not upload
of larger maps and emits `OPSLANE_VITE_MAP_OVER_SERVER_LIMIT`.

Important stable build codes include:

- `OPSLANE_VITE_UPLOAD_NO_ENDPOINT`: a key is set without an endpoint.
- `OPSLANE_VITE_UPLOAD_WRONG_KEY`: the value is not an `opslane_sk_` key.
- `OPSLANE_VITE_UPLOAD_FAILED`: one or more maps were rejected or unavailable.
- `OPSLANE_VITE_UPLOAD_STALE_MAP`: a retained map changed after verification.
- `OPSLANE_VITE_MAP_VERIFY_FAILED`: disk bytes no longer match the stamped ID.
- `OPSLANE_VITE_ASSET_UNSTAMPED`: a separate build pass, commonly a worker,
  emitted JavaScript without running the plugin.
- `OPSLANE_VITE_MAP_NOT_REMOVED`: another plugin restored a private map after
  Opslane removed it from the bundle.

The build options are `commitSha`, `stamp` (default `true`), `logLevel`
(`silent` or `warn`), `sourcemaps` (`remove` or `keep`), and `maxMapBytes`
(default 32 MiB).

### Plugin order

The plugin fingerprints in a post-ordered `generateBundle` hook so Vite has
finished rewriting chunks. Place it before plugins that remove or rename maps.
If another uploader needs maps, configure Vite to retain them and let that
uploader delete them after its own successful upload.

### Web workers

Vite builds workers separately. Register `opslane()` under both `plugins` and
`worker.plugins`; `worker.plugins` must be a function returning a fresh plugin
instance.

### Subresource integrity

Stamping changes chunk bytes. Known SRI plugins that calculate integrity too
early disable stamping and emit `OPSLANE_VITE_SRI_DETECTED`. Calculate SRI only
after the final stamped bytes, or use `stamp: false`.

## Verify resolution

After a production build, `sourcemap_files` should contain project-scoped rows:

```sql
SELECT debug_id, has_sources_content, size_bytes, created_at
FROM sourcemap_files
WHERE project_id = '<projectID>'
ORDER BY created_at DESC;
```

Trigger an error from the built app and inspect its event. `resolution_status`
is `resolved`, `partial`, `no_debug_ids`, `map_not_found`, `invalid_map`, or
`resolution_failed`; successful frames are stored in the versioned
`stack_trace_resolved` envelope. Opslane exposes no source-map download API.

Only Vite has a first-party upload integration today. Other bundlers may call
the single-map PUT route if they reproduce the same canonical debug-ID
algorithm and stamp the matching ID into runtime debug metadata.
