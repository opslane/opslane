---
covers:
  - packages/ingestion/db/project_keys.go
  - packages/ingestion/cmd/mint-key/main.go
---
# API keys

A project has two kinds of keys. Each has one permitted action, enforced by the server.

| | Ingest key | Source-map key |
| --- | --- | --- |
| Looks like | `opslane_pk_...` | `opslane_sk_...` |
| What it can do | Send events and session recordings | Upload source maps |
| Where it lives | Inside your browser bundle | In CI |
| If it leaks | Nothing to do; it is public by construction | Revoke it and mint a new one |

Neither key can read anything. Reading data takes a signed-in user; no key of any scope has read access.

## The ingest key

You get an ingest key when the project is created; it is shown once and can't be retrieved later. The SDK refuses any key that doesn't start with `opslane_pk_`.

```bash
VITE_OPSLANE_API_KEY=opslane_pk_...
```

The key ships inside the browser bundle, so a new key takes effect on your next app deploy, not when it is minted.

## The source-map key

The source-map key is a secret for CI. It carries its own upload destination inside the key, so this one variable is the whole configuration; there is no endpoint variable.

```bash
OPSLANE_SOURCEMAP_KEY=opslane_sk_...
```

Never give it a `VITE_` prefix or your framework's equivalent: that would bundle the secret into the browser. The [source maps guide](source-maps.md) covers the Vite plugin that uses it.

## Minting keys on a self-host

The `mint-key` tool ships in the ingestion container:

```bash
docker compose exec ingestion mint-key -project <project-uuid> -scope ingest
docker compose exec ingestion mint-key -project <project-uuid> -scope sourcemaps
```

It prints the key once, plus the key ID and the exact SQL to revoke it. For source-map keys, the upload destination is sealed into the key at mint time from the server's `OPSLANE_PUBLIC_INGEST_URL`; pass `-endpoint` to seal a different one. To find a project's UUID:

```bash
docker compose exec -T postgres psql -U opslane -d opslane -c "SELECT id, name FROM projects;"
```

## Rotating a key

Minting never revokes, and a project can hold any number of active keys per scope. Rotate by overlap: mint the new key, deploy it, then revoke the old one with the SQL that `mint-key` printed. Revocation is always exact; revoking one key never touches the others.

## When a key is rejected

- `401`: the key doesn't parse or was revoked. Copy the full value; a truncated key can't parse.
- `403 insufficient_scope`: a valid key with the wrong scope, usually a source-map key sent with events.
