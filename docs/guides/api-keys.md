---
covers:
  - packages/ingestion/db/project_keys.go
  - packages/ingestion/cmd/mint-key/main.go
description: The two project key scopes, how to create them, and how to rotate them.
---

# API keys

A project has two kinds of keys. The server enforces what each can do.

| | Ingest key | Source-map key |
| --- | --- | --- |
| Looks like | `opslane_pk_...` | `opslane_sk_...` |
| What it can do | Send events and session recordings | Upload source maps |
| Where it lives | Inside your browser bundle | In CI |
| If it leaks | It is already public in your bundle; rotate it only if it is being abused | Revoke it and create a new one |

No key can read data. Reading requires a signed-in user.

## The ingest key

You get an ingest key when the project is created; it is shown once and can't be retrieved later. The SDK refuses any key that doesn't start with `opslane_pk_`.

```bash
VITE_OPSLANE_API_KEY=opslane_pk_...
```

The key ships inside the browser bundle, so a new key takes effect on your next app deploy, not the moment you create it.

## The source-map key

The source-map key is a secret for CI. It carries its upload destination, so there is nothing else to configure.

```bash
OPSLANE_SOURCEMAP_KEY=opslane_sk_...
```

Never give it a `VITE_`-style public prefix; that bundles the secret into the browser. The [source maps guide](source-maps.md) covers the Vite plugin that uses it.

## Create keys on a self-host

The key-creation tool (`mint-key`) ships in the Opslane server container:

```bash
docker compose exec ingestion mint-key -project <project-uuid> -scope ingest
docker compose exec ingestion mint-key -project <project-uuid> -scope sourcemaps
```

It prints the key once, plus the key ID and the SQL to revoke it. Source-map keys take their upload destination from the server's `OPSLANE_PUBLIC_INGEST_URL`; pass `-endpoint` to override. To find a project's UUID:

```bash
docker compose exec -T postgres psql -U opslane -d opslane -c "SELECT id, name FROM projects;"
```

## Rotating a key

Creating a key never revokes an old one, so the two can overlap. Create the new key, deploy it, then revoke the old one with the SQL `mint-key` printed. Revoking one key never touches the others.

## When a key is rejected

- `401`: the key doesn't parse or was revoked. Copy the full value; a truncated key can't parse.
- `403 insufficient_scope`: a valid key with the wrong scope, usually a source-map key sent with events.
