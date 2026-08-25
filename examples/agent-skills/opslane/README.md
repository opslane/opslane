# Opslane skill for coding agents

`SKILL.md` teaches a coding agent to work an Opslane digest item: fix a diagnosed error on its own, and for a friction issue, ask you which behavior you want before writing code.

Install it in your repo:

```bash
mkdir -p .claude/skills/opslane
curl -fsSL https://raw.githubusercontent.com/opslane/opslane/main/examples/agent-skills/opslane/SKILL.md \
  -o .claude/skills/opslane/SKILL.md
```

It uses the Opslane MCP tools. Connect the MCP first: see [docs/guides/mcp.md](../../../docs/guides/mcp.md).
