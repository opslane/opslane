# AGENTS.md

Opslane is an AI-powered production error-resolution engine. It ingests browser errors, investigates root causes, and either opens a verified fix PR or creates an actionable `needs_human` incident.

## Areas

| Path | Runtime and responsibility |
| --- | --- |
| `packages/ingestion` | Go 1.24, chi, pgx; API, grouping, migrations, and storage |
| `packages/worker` | Node 22, TypeScript; investigation, fix verification, and PR creation |
| `packages/agent-core` | Node 22, TypeScript; provider-neutral agent loop and shell-free local tools |
| `packages/dashboard` | Vue 3, Vite, Tailwind CSS; ingestion-served UI |
| `packages/sdk` | Browser TypeScript SDK, React/Vue integrations, Vite source maps |
| `shared` | Runtime-free shared TypeScript contracts |
| `cli` | Node 22, Commander, Inquirer, Chalk |
| `test-e2e`, `test-fixtures` | End-to-end contracts and browser fixtures |

Server, worker, agent-core, dashboard, CLI, and test code is AGPL-3.0-only. The browser and Python SDKs and shared types are MIT licensed.

## Verification

Verify the smallest relevant surface while iterating, then every check needed to prove the final claim. Focused package checks live in each package's `AGENTS.md`.

Full repository gate:

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Two ways that gate reports success without having run:

- `pnpm test` marks database-gated suites *skipped*, not failed, when `DATABASE_URL` is unset. Export it (Compose's Postgres) before treating a green suite as proof, and read the skip count rather than the pass count.
- `dist/` is gitignored but survives between runs, so a local build proves nothing about a clean checkout. After adding a workspace dependency, rebuild with the dists removed.

- Shared types or workspace metadata: run `pnpm -r build` and affected tests.
- CLI: run `pnpm --filter @opslane/cli build` and `pnpm --filter @opslane/cli test`.
- Compose or health checks: validate config, start services, and inspect health. Build any affected Compose image after Dockerfile changes.
- Pipeline changes require a live smoke: apply migrations, run `scripts/seed-e2e.sql`, rebuild ingestion and worker, send an event to `$INGESTION_URL/api/v1/events`, and confirm the job reaches its expected terminal state. Use `test-fixtures/vue-app` or `test-fixtures/react-app` for browser fixtures.

  From a git worktree, another stack may already hold the default host ports. Pick a free triple once and export the derived URLs together — host-side tests read the URLs, not the ports:

  ```bash
  export INGESTION_PORT=8092
  export OPSLANE_POSTGRES_HOST_PORT=5444
  export OPSLANE_MINIO_HOST_PORT=9022
  export INGESTION_URL="http://localhost:$INGESTION_PORT"
  export DATABASE_URL="postgres://opslane:opslane_dev@localhost:$OPSLANE_POSTGRES_HOST_PORT/opslane?sslmode=disable"
  export MINIO_ENDPOINT="http://localhost:$OPSLANE_MINIO_HOST_PORT"
  export REPLAY_STORE_ENDPOINT="$MINIO_ENDPOINT"
  export REPLAY_STORE_PUBLIC_ENDPOINT="$MINIO_ENDPOINT"
  # Storage credentials do not vary per stack, but host-side lanes skip or fail
  # without them: Go storage tests `t.Skip`, and the friction e2e lane throws
  # `ChunkReadError: MinIO not configured`.
  export MINIO_ACCESS_KEY=minio MINIO_SECRET_KEY=minio12345 MINIO_BUCKET=opslane-replays
  export REPLAY_STORE_ACCESS_KEY=minio REPLAY_STORE_SECRET_KEY=minio12345 REPLAY_STORE_BUCKET=opslane-replays
  ```

  Re-run the block as a unit when you change a port; the URLs do not follow on their own. Unset ports keep 8082/5434/9012. Setting a port without its URL is the silent failure: Go DB tests fall back to the hardcoded `localhost:5434` DSN and `t.Skip` instead of failing. After a worktree smoke, confirm `go test ./...` reported **zero** skips — a storage misconfiguration reports `ok` while ~30 tests never run.

## Cross-cutting conventions

- Use ESM and strict TypeScript. Use `unknown` plus narrowing instead of `any`.
- Keep Vitest tests colocated in `__tests__`.
- Use the `@opslane/` package scope and the `opslane` CLI name.
- Local Postgres user/database names are `opslane`; Compose services are `ingestion`, `worker`, `postgres`, and `minio`.
- New server-side packages default to `AGPL-3.0-only`. Put code in the MIT SDKs/shared boundary only when that distribution choice is intentional.

## Guardrails

- Do not introduce Redis, BullMQ, or another queue without an architectural decision; use the existing Postgres job queue.
- Do not persist production credentials in plaintext; use deployment environment variables or GitHub App credentials until encrypted storage is implemented.
- Do not add legacy shims by default; preserve documented public contracts or change them explicitly.
- The `POST /api/v1/events` wire contract is append-only and backward-compatible. Add optional fields only; never edit or delete a frozen fixture under `test-fixtures/wire/`. See `docs/contracts/events.md`.
- Keep the change inside the current issue instead of expanding the product scope.
- Reuse existing utilities before adding a dependency, and review any new dependency's license.
- Preserve terminal-status and lease contracts; fix the implementation or test setup instead of weakening them.
- Do not run destructive database commands on retained data. Use a disposable database when clean-state verification is required.

## Agent workflow

- Work directly when the task is clear; ask only for destructive, externally side-effectful, or materially ambiguous decisions.
- Preserve unrelated worktree changes and keep diffs small and reviewable.
- Prefer deletion and existing patterns over new abstractions.
- Read current code and tests before changing behavior; verify before reporting completion.
- Run `gh` from the repository root so it infers the current remote.

## References

- Package specifics: `packages/<name>/AGENTS.md` (loads when working in that package)
- Issue operations and triage: `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`
- Domain and ADR discovery: `docs/agents/domain.md`
- Installation and replay privacy: `docs/install.md`, `docs/guides/replay-privacy.md`
- Public contracts: `docs/contracts/`
