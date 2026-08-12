<!-- PLACEHOLDER: hero banner image (dark/light variants). Suggested: logo + tagline "Watches your users, fixes your app." -->

# Opslane

Error trackers see stack traces. Opslane knows your product.

It learns where users get stuck from errors and session recordings. You get a daily digest of what matters, and pull requests with tested fixes. When it can't fix something, it says why.

## See it work

### Error to pull request

<!-- PLACEHOLDER: full product tour — video or GIF. One uninterrupted path: error → grouped issue → investigation evidence → pull request. -->

### A merged production fix

<!-- PLACEHOLDER: screenshot of a real merged Opslane PR (e.g. #1232) — title, root-cause explanation, evidence section, diff. Scrub anything private; link the PR here. -->

In two weeks on one production app (July to August 2026), Opslane captured 7,415 events, suppressed the 78% that were noise, and opened one pull request: a fix for a crash users had hit 614 times. A human reviewed and merged it.

## What it does

- **Know what's broken without reading 7,000 alerts.** Errors group into causes, noise is suppressed, and issues are ranked by how many users they hit. One Slack digest a day.
- **Get bugs fixed without losing the afternoon.** Opslane investigates in your repo and sends the fix as a pull request that built and passed your tests. You review and merge.
- **See what the user saw.** Every error links to the session replay behind it: the clicks, pages, and requests that led up to it.
- **Catch failures that never throw.** Dead buttons and abandoned forms surface from session recordings, even when the console is clean.
- **Stay in control.** It never merges its own PRs, it says why whenever it stops, and the whole thing self-hosts on your infrastructure.

## How it works

1. **Capture.** The SDK sends errors and session recordings to the ingestion server. Two lines of code to install.
2. **Group.** The same bug hitting 500 users becomes one issue, not 500 alerts. Errors that come from browser extensions, cross-origin scripts, or known-harmless browser warnings get dropped.
3. **Investigate.** The worker clones the repository and reads the code until it finds the cause. The cause has to name the exact files involved; guesses get thrown out.
4. **Verify.** The fix is applied in an isolated sandbox, where the build and tests run. Whatever passed before has to pass after.
5. **Deliver.** A verified fix opens as a pull request on the repository, ready for review. A fix that could not be verified opens as a draft, marked as such, and only if the project allows drafts. When there is no fix, the issue shows the reason instead.
6. **Digest.** Once a day, Slack gets the summary: what broke, what got fixed, what needs a human.

The pipeline calls three outside services: Anthropic to investigate, E2B to run the sandbox, and GitHub for clones and pull requests. Everything else runs on the self-hosted stack, on Postgres. There is no Redis or queue service to operate. JavaScript apps are supported end to end today; a Python SDK (alpha) captures and triages server-side errors, with its fix pipeline off by default.

```mermaid
flowchart LR
    A[SDK] -->|errors + session recordings| B[Ingestion and grouping]
    B --> C[(Postgres job queue)]
    C --> D[Worker: investigate]
    D -->|candidate fix| E[Fix + sandbox verification]
    D -->|analysis only| I[investigated: analysis for a human]
    D -->|blocked| H[needs_human: reason + next action]
    E -->|ready gate passes| F[Ready GitHub PR]
    E -->|draft gate passes + project opt-in| G[Draft GitHub PR]
    E -->|neither gate passes| H
```

| Component | What it does | Where |
| --- | --- | --- |
| Browser SDK | Captures errors and session recordings, with input masking on by default | [`packages/sdk`](packages/sdk) |
| Ingestion API | Go service that receives events, groups errors, and serves the dashboard | [`packages/ingestion`](packages/ingestion) |
| Worker | Investigates issues and proposes changes; for candidate fixes, runs the build and tests in an [E2B](https://e2b.dev) sandbox, records the results, and opens the PR | [`packages/worker`](packages/worker) |
| Dashboard | Vue app for issues, replays, and project settings | [`packages/dashboard`](packages/dashboard) |
| CLI | Lists and inspects projects and issues from the command line | [`cli`](cli) |
| Python SDK (alpha) | Captures server-side Python errors, with a Flask integration | [`packages/sdk-python`](packages/sdk-python) |

The exact evidence gates, their limits, and what they do not guarantee: [precision](docs/architecture/precision.md).

## Run it locally

Prerequisites: Docker with Compose. No accounts or API keys needed for this first run.

```bash
git clone https://github.com/opslane/opslane-oss.git
cd opslane-oss
docker compose up -d --wait
curl http://localhost:8082/health
```

This starts Postgres, MinIO, the ingestion API (which serves the dashboard at <http://localhost:8082>), and the worker. Migrations run automatically.

Seed a test project and send it an error:

```bash
docker compose exec -T postgres psql -U opslane -d opslane < scripts/seed-e2e.sql
curl -X POST http://localhost:8082/api/v1/events \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq' \
  -d '{"timestamp":"2026-01-01T00:00:00Z","error":{"type":"ReferenceError","message":"demo is not defined","stack":"ReferenceError: demo is not defined\n  at app.js:1:1"},"breadcrumbs":[],"context":{"url":"https://example.com","user_agent":"smoke test"},"sdk_version":"0.0.1"}'
```

The `opslane_pk_...` value is the test project's seeded public ingest key; real deployments mint their own. Give the worker a few seconds, then check the result (re-run if the row hasn't appeared yet):

```bash
docker compose exec -T postgres psql -U opslane -d opslane \
  -c "SELECT status, reason_code, reason_message FROM error_groups ORDER BY created_at DESC LIMIT 1;"
```

```text
   status    |   reason_code   |                  reason_message
-------------+-----------------+---------------------------------------------------
 needs_human | missing_llm_key | ANTHROPIC_API_KEY environment variable is not set
```

The worker stopped because it has no AI credentials, and it said so. To go further:

- **Dashboard sign-in:** a GitHub App, or WorkOS for cloud deployments.
- **Investigation:** `ANTHROPIC_API_KEY`.
- **Sandbox verification:** `E2B_API_KEY`.
- **Pull requests:** GitHub credentials with access to the target repository.

Exact permissions and environment variables are in the [self-host quickstart](docs/quickstart/self-host.md). SDK setup is in the [install guide](docs/install.md); replay privacy defaults in [replay privacy and masking](docs/guides/replay-privacy.md).

## What Opslane is not

- **Not an APM or metrics backend.** Opslane ingests application errors and the session context around them: breadcrumbs, network timing, and optional replays. It does not do latency percentiles, distributed tracing, or infrastructure monitoring.
- **Not autopilot.** Opslane opens pull requests but never merges them. Review and merge stay with the repository owner.
- **Not a dashboard to babysit.** Conclusions ship as PRs and issues; the dashboard exists for replays and settings, not triage duty.
- **Pre-1.0.** The [`POST /api/v1/events` wire contract](docs/contracts/events.md) is append-only and backward-compatible. Other interfaces may still change before 1.0.

## What leaves your host

With no external integrations configured, no captured data (errors, replays, or repository source) leaves your deployment. Each integration you enable adds its own destination:

- **GitHub:** authentication, repository access, clones, pull requests.
- **Anthropic:** investigation context and selected source.
- **E2B:** repository contents and commands for sandbox verification.
- **WorkOS** (optional): cloud authentication.
- **Slack** (optional): notifications.
- **Langfuse** (optional): traces.

The full data-flow and trust model, including what each destination receives: [trust and security](docs/architecture/trust.md).

## Documentation

- [Self-host quickstart](docs/quickstart/self-host.md): the local run and the full error-to-PR path, in detail
- [Install guide](docs/install.md): add the SDK to your app
- [Guides](docs/guides): React, Vue, vanilla JS, source maps, GitHub App, Slack notifications, replay privacy
- [Architecture](docs/architecture/overview.md): components, trust boundaries, life of an error
- [Reference](docs/reference): SDK options, HTTP routes, environment variables, reason codes, checked against source by [`scripts/check-docs-drift.mjs`](scripts/check-docs-drift.mjs) in CI

## Repository layout

```text
packages/
  ingestion/    Go ingestion API, grouping, storage, dashboard server
  worker/       Investigation, verification, and PR pipeline
  agent-core/   Provider-neutral agent loop
  dashboard/    Vue dashboard
  sdk/          Browser SDK, framework integrations, Vite source-map plugin
  sdk-python/   Python SDK (alpha)
shared/         Shared TypeScript contracts
cli/            Opslane CLI
docs/           Documentation (published by docs-site/)
```

## Licensing

| Code | License |
| --- | --- |
| Server, worker, agent core ([`packages/agent-core`](packages/agent-core)), dashboard, CLI ([`cli`](cli/LICENSE)), docs site, and tests | [AGPL-3.0-only](LICENSE) |
| Browser SDK ([`packages/sdk`](packages/sdk/LICENSE)), Python SDK ([`packages/sdk-python`](packages/sdk-python/LICENSE)), and shared types ([`shared`](shared/LICENSE)) | MIT |

In short: the SDKs and shared contracts are MIT; the ingestion service, worker, agent core, dashboard, CLI, docs site, and tests are AGPL-3.0-only.

## Contributing

Bug reports and feature requests are welcome on the [issue tracker](https://github.com/opslane/opslane-oss/issues). For development setup, codebase conventions, and the verification bar for changes, see [AGENTS.md](AGENTS.md).
