---
covers:
  - packages/ingestion/handler/mcp.go
  - packages/ingestion/mcp/format.go
  - packages/dashboard/src/views/Settings.vue
description: Connect Claude Code or Codex to Opslane and work on issues from your editor.
---

# Connect a coding agent

Opslane has a remote Model Context Protocol (MCP) server. It lets a coding agent read your latest daily summary, open an issue with its evidence, and link the pull request that fixes it.

The server accepts `POST /mcp` at your Opslane address. For hosted Opslane, that is `https://app.opslane.com/mcp`. It provides four tools:

| Tool | What it does |
| --- | --- |
| `opslane_digest` | Get the latest daily summary for the project |
| `opslane_issue` | Get one issue and its evidence from an id or URL |
| `opslane_link_pr` | Link a GitHub pull request to an issue |
| `opslane_session_timeline` | Get the browser activity timeline for one issue |

## 1. Create an MCP key

In the dashboard, open **Project settings → API keys** and create an MCP key. It starts with `opslane_ak_` and is shown once. The key selects one project and can read that project's issues and link pull requests.

This key can read private data. Keep it in an environment variable, never in a committed file. The [API keys guide](api-keys.md) explains expiry and revocation.

```bash
export OPSLANE_API_KEY=opslane_ak_...
```

## 2. Connect your coding agent

For Claude Code, add the server from the terminal:

```bash
claude mcp add --transport http opslane https://app.opslane.com/mcp \
  --header "Authorization: Bearer ${OPSLANE_API_KEY}"
```

To share the server address with your team, commit this `.mcp.json`. Each person still supplies their own key through the environment:

```json
{
  "mcpServers": {
    "opslane": {
      "type": "http",
      "url": "https://app.opslane.com/mcp",
      "headers": { "Authorization": "Bearer ${OPSLANE_API_KEY}" }
    }
  }
}
```

For Codex, add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.opslane]
url = "https://app.opslane.com/mcp"
bearer_token_env_var = "OPSLANE_API_KEY"
```

For a self-host, replace `https://app.opslane.com` with your own address.

Ask the agent to call `opslane_digest` to test the connection. A missing, invalid, expired, or revoked key returns `401`. An ingest or source-map key returns `403 insufficient_scope`.

## Work an issue with the Opslane skill

<!-- voice-ok: friction is the issue kind shown by MCP and used by the skill -->
Opslane ships a Claude Code skill so the agent works a digest item the way you would. It fixes a diagnosed error on its own. For a friction issue, where the right fix is a product call, it stops and asks you which behavior you want before it writes any code.

The skill lives at `examples/agent-skills/opslane/SKILL.md`. Download it into your repo:

```bash
mkdir -p .claude/skills/opslane
curl -fsSL https://raw.githubusercontent.com/opslane/opslane/main/examples/agent-skills/opslane/SKILL.md \
  -o .claude/skills/opslane/SKILL.md
```

If you already have an Opslane checkout, copy `examples/agent-skills/opslane/SKILL.md` from it instead.

Then ask the agent what is broken in production, and it will read the digest, open an issue, and either fix it or ask you the product question first.

## What the agent sees

Tool output is plain text. Values from a browser session, such as an error message or URL, appear between `<untrusted>` tags. These tags tell the agent to treat the text as data, not instructions. Opslane also limits how often each project can call the server.
