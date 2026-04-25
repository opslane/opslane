# Changelog

All notable changes to opslane/verify are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] — 2026-04-23

### Added
- Per-AC video + trace evidence on non-pass verdicts. Each failing AC's directory now contains a Playwright video and trace alongside screenshots, making it easy to diff what the agent saw vs. expected. (#12)
- Inline `/verify-setup` skill — auto-detects dev server port, indexes routes and selectors from your codebase, writes `.verify/config.json` and `.verify/app.json`. No `npm install` needed. (#11)
- Playwright MCP-based `/verify` skill — drives the browser via Playwright MCP directly from Claude Code, no CLI binary required. (#7)

### Changed
- `/verify` skill now uses Playwright MCP directly instead of an external browse binary, simplifying the install path to one `claude mcp add` command. (#7)
- Cookie-based auth replaces credential-based auth — log in once via your normal browser, `/verify-setup` reads the cookie. (#5)

### Removed
- Server directory and SaaS backend — opslane/verify is now a pure Claude Code plugin with no server dependency. Auth state lives in `.verify/auth.json` locally. (#10)
- Standalone CLI package (`@opslane/verify`) — replaced by inline Claude Code skills. (#11)
- Browse binary and v1 pipeline code — superseded by Playwright MCP. (#8)

### Fixed
- `/verify-setup` cookie import flow, `auth.json` export path, and browse-binary download fallback. (#9)

[Unreleased]: https://github.com/opslane/opslane-v3/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/opslane/opslane-v3/releases/tag/v1.1.0
