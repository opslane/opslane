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
| What it can do | Send events and session recordings | Upload source maps | Read incidents and link pull requests through the MCP tools |
| Where it lives | Inside your browser bundle | In CI | In a coding agent's MCP config |
| If it leaks | Nothing to do; it is public by construction | Revoke it and create a new one | Revoke it and create a new one |

The ingest and source-map keys cannot read your data. The MCP key can read a project's incidents and link pull requests, which is why it is a secret you keep out of client code.

## The ingest key

You get an ingest key when the project is created; it is shown once and can't be retrieved later. The SDK refuses any key that doesn't start with `opslane_pk_`.

```bash
VITE_OPSLANE_API_KEY=opslane_pk_...
```

The key ships inside the browser bundle, so a new key takes effect on your next app deploy, not when it is minted.

## The source-map key

The source-map key is a secret for CI. It carries its upload destination, so there is nothing else to configure.

```bash
OPSLANE_SOURCEMAP_KEY=opslane_sk_...
```

Never give it a `VITE_`-style public prefix; that bundles the secret into the browser. The [source maps guide](source-maps.md) covers the Vite plugin that uses it.

## The MCP key

The MCP key lets a coding agent (Claude Code or Codex) work a project's digest through Opslane's remote MCP server. Unlike the other keys it can read incident detail and link a pull request, so it is a secret: keep it out of browser and client code. It is scoped to one project, so the key itself selects the project.

Create an MCP key from the dashboard (project settings, API keys). The secret is shown once. It supports an optional expiry and can be revoked at any time; revoking it stops that key immediately without touching the others. Configure it in your agent as a bearer token, ideally from an environment variable: `Authorization: Bearer opslane_ak_...`.

## Minting keys on a self-host

The `mint-key` tool ships in the ingestion container:

```bash
docker compose exec ingestion mint-key -project <project-uuid> -scope ingest
docker compose exec ingestion mint-key -project <project-uuid> -scope sourcemaps
```

It prints the key once, plus the key ID and the SQL to revoke it. Source-map keys take their upload destination from the server's `OPSLANE_PUBLIC_INGEST_URL`; pass `-endpoint` to override. To find a project's UUID:

```bash
docker compose exec -T postgres psql -U opslane -d opslane -c "SELECT id, name FROM projects;"
```

`mint-key` covers the ingest and source-map scopes. MCP keys are created from the dashboard (project settings, API keys).

## Rotating a key

Minting never revokes, so old and new keys can overlap. Mint the new key, deploy it, then revoke the old one with the SQL `mint-key` printed. Revoking one key never touches the others.

## When a key is rejected

- `401`: the key doesn't parse or was revoked. Copy the full value; a truncated key can't parse.
- `403 insufficient_scope`: a valid key with the wrong scope, usually a source-map key sent with events, or a non-MCP key used against the MCP server.
