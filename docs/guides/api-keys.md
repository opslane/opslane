---
covers:
  - packages/ingestion/db/project_keys.go
  - packages/ingestion/cmd/mint-key/main.go
  - packages/ingestion/handler/api_keys.go
description: The project key scopes, how to create them, and how to rotate them.
---

# API keys

A project has three kinds of keys. The server enforces what each can do.

| | Ingest key | Source-map key | MCP key |
| --- | --- | --- | --- |
| Looks like | `opslane_pk_...` | `opslane_sk_...` | `opslane_ak_...` |
| What it can do | Send events and session recordings | Upload source maps | Read issues and link pull requests through the MCP tools |
| Where it lives | Inside your browser bundle | In CI | In a coding agent's MCP config |
| If it leaks | It is already public in your bundle; rotate it only if it is being abused | Revoke it and create a new one | Revoke it and create a new one |

The ingest and source-map keys cannot read your data. The MCP key can read a project's issues and link pull requests, which is why it is a secret you keep out of client code.

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

## The MCP key

An MCP key lets a coding agent read the project's latest daily summary, open an issue with its evidence, and link a pull request. Keep it out of browser and client code. The key selects one project.

Create it from **Project settings → API keys** in the dashboard. The secret is shown once. You can set an expiry or revoke it at any time. The [coding agent guide](mcp.md) shows how to connect it without putting the secret in a file.

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

`mint-key` creates ingest and source-map keys. Create MCP keys from **Project settings → API keys** in the dashboard.

## Rotating a key

Creating a key never revokes an old one, so the old and new keys can overlap. Create the new key, deploy it, then revoke the old one with the SQL `mint-key` printed. Revoking one key never touches the others.

## When a key is rejected

- `401`: the key doesn't parse, was revoked, or expired. Copy the full value; a truncated key can't parse.
- `403 insufficient_scope`: a valid key with the wrong scope, usually a source-map key sent with events, or a non-MCP key used against the MCP server.
