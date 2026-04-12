## Project
opslane/verify — automated acceptance criteria verification for Claude Code changes. Runs browser agents against a spec, judges pass/fail, and reports results before you push.

## Architecture
```
/verify-setup → init (port detection + 2 LLM agents → app.json)
/verify → spec interpreter → AC extractor → Playwright MCP verification → report
```
Config lives in `.verify/config.json`. App index lives in `.verify/app.json`. Env vars always override config.
`.verify/` is runtime output (gitignored) — config, plans, evidence, auth.

## Skill sync
The skills in `skills/` are the source of truth. A `PostToolUse` hook (`.claude/hooks/sync-skill.sh`) automatically copies them to `~/.claude/skills/` after every Write or Edit. Never edit `~/.claude/skills/verify/SKILL.md` directly — edit the project copy instead.

## Module-specific instructions
- For pipeline work, see `pipeline/CLAUDE.md`

## References
- Design docs and implementation plans: `docs/plans/`
- Prompt templates: `pipeline/src/prompts/`
