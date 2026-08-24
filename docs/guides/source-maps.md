---
covers:
  - packages/ingestion/cmd/mint-key/**
  - packages/ingestion/handler/sourcemap_upload.go
  - packages/sdk/vite-plugin/**
  - packages/worker/src/resolve-stack.ts
description: Upload Vite source maps so production stack traces point at your source.
---

# Source maps

Opslane's Vite plugin stamps each production chunk with a deterministic debug
ID, uploads the matching source map with a secret project key, and removes the
map from the build output by default. Browser events carry the chunk URL and
debug ID; the worker uses that exact pair to resolve original source positions.

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

Set one server-side build variable in CI:

```bash
OPSLANE_SOURCEMAP_KEY=opslane_sk_...
```

That single value is the whole upload configuration. A source-map key is
`opslane_sk_<key id>_<secret>_<payload>`, where the payload is the ingestion
origin the key was minted for; the plugin reads the destination out of the key
and uploads there. There is no endpoint variable and no default: a key minted
against the wrong deployment uploads nowhere else.

The plugin reads `process.env` first, then Vite's `OPSLANE_` variables from the
project's env files. A gitignored `.env.local` therefore works for local
production builds:

```dotenv
OPSLANE_SOURCEMAP_KEY=opslane_sk_...
```

Do not prefix the variable with `VITE_`, `NEXT_PUBLIC_`, or another browser
environment prefix. The source-map key is a secret and must never enter the
JavaScript bundle or a tracked file. Browser initialization continues to use a
public `VITE_OPSLANE_API_KEY=opslane_pk_...` ingest key.

Uploads happen during `closeBundle`. Each final map is sent with
`PUT /api/v1/sourcemaps/{debugID}`; HTTP 200 and 201 are success. Rate-limited
uploads honor `Retry-After`, and upload failures are reported without failing the production build.

## Mint and revoke an upload key

Minting a source-map key requires the public origin uploads must reach,
because that origin is sealed into the key.

The ingestion image ships the `mint-key` binary, and the running container
already has `DATABASE_URL` and `OPSLANE_PUBLIC_INGEST_URL` in its
environment, so on a deployment it is one command:

```bash
docker exec <ingestion-container> mint-key \
  -project 00000000-0000-0000-0000-000000000000 \
  -scope sourcemaps \
  -label "production source maps"
```

From a repository checkout, the equivalent is:

```bash
cd packages/ingestion
DATABASE_URL=postgres://... \
OPSLANE_PUBLIC_INGEST_URL=https://your-opslane-instance.example.com \
go run ./cmd/mint-key \
  -project 00000000-0000-0000-0000-000000000000 \
  -scope sourcemaps \
  -label "production source maps"
```

`-endpoint <url>` supplies the same value per invocation; if both are set they
must canonicalize to the same origin. The origin must be an absolute
`https://` URL (`http://` is accepted only for `localhost`, `127.0.0.1`, and
`[::1]`) with no userinfo, path, query, or fragment. Minting fails before it
touches the database when the origin is missing or unusable.

The command prints the target project's name and repo, then the raw
`opslane_sk_` value once, then its key ID. Moving a deployment to a new origin
means minting new keys and revoking the old ones; the sealed origin cannot be
edited. To revoke exactly that key, run the statement it prints:

```sql
UPDATE project_api_keys SET revoked_at = now() WHERE key_id = '<key-id>';
```

Minting another key does not revoke existing keys. Revocation is always an
explicit, exact-key operation.

## Re-keying an app (ingest keys)

To mint a browser ingest key for an existing project (for example when
re-keying an app whose legacy key was removed by an upgrade):

```bash
# find the project UUID first
psql "$DATABASE_URL" -c "SELECT id, name, github_repo FROM projects;"

docker exec <ingestion-container> mint-key -project <uuid> -scope ingest
# or, from a checkout:
cd packages/ingestion
DATABASE_URL=postgres://... go run ./cmd/mint-key -project <uuid> -scope ingest
```

The tool prints the project's name and repo before the key. Read it and
confirm it is the project you meant. The printed `opslane_pk_` value goes
into the app's build environment (`VITE_OPSLANE_API_KEY` for Vite apps, or
your framework's equivalent public variable); it takes effect when the app
is rebuilt and redeployed, because the key ships inside the browser bundle.

Cutover order when an upgrade removes old keys: deploy the server first,
then mint per project, then update each app's environment and redeploy it.
Ingestion for an app stays down from the server deploy until that app's
redeploy, so budget the window accordingly.

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

- `OPSLANE_VITE_KEY_INVALID`: `OPSLANE_SOURCEMAP_KEY` is not a valid
  endpoint-bearing key, so no upload destination could be read from it. The
  warning names a stable reason (for example `legacy_format` for a key minted
  before the format change, or `bad_grammar` for a public `opslane_pk_` key)
  and never echoes key material. Re-mint the key.
- `OPSLANE_VITE_ENDPOINT_REMOVED`: the retired endpoint variable from the old
  two-variable setup is still set. The warning names it. It is reported, never
  obeyed; delete it.
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

Trigger an error from the built app and inspect its event. The event shows whether stack resolution succeeded, is still waiting, or fell back because a matching usable map was unavailable. Successful frames appear in the resolved stack. Opslane exposes no source-map download API.

Only Vite has a first-party upload integration today. Other bundlers may call
the single-map PUT route if they reproduce the same canonical debug-ID
algorithm and stamp the matching ID into runtime debug metadata.
