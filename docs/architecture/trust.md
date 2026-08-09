---
covers:
  - packages/sdk/**
  - packages/ingestion/handler/**
  - packages/worker/src/**
---
# Trust and security model

What Opslane can touch, what leaves your infrastructure, how credentials are handled, and what the current honest gaps are. Everything on this page describes the code as it is today — gaps are stated, not papered over.

## GitHub permissions

The worker needs to **read repository contents** (clone, source maps context), **write pull requests**, and **read checks and commit statuses** when observing CI on a draft. Two credential modes:

- **Personal access token** (`GITHUB_TOKEN`): a classic token with `repo`, or a fine-grained PAT with `contents` and `pull_requests` write plus checks/status read access on the repositories you connect.
- **GitHub App**: the worker mints short-lived installation tokens from `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`. The App requires Contents read/write, Pull requests read/write, and Checks read. Installation tokens expire on the order of an hour and are scoped to the repositories the App is installed on. The App powers webhooks (HMAC-verified). Dashboard sign-in uses OAuth with a configured identity provider; social providers such as GitHub and Google may be enabled.

The worker pushes only to a reserved Opslane fix branch (`opslane/fix-<group-id>`, no force flags anywhere in the pipeline), then opens a PR from it. The branch name and delivery operation key are stable for one error group. Before a retry writes to GitHub, it reconciles the reservation, remote branch, and existing open PR so a crash cannot create a second delivery. It never pushes to a customer's pre-existing branch; merging is always yours.

## Data flow: what leaves your host

| Destination | What is sent | When |
| --- | --- | --- |
| Anthropic API | Error details, stack traces, relevant source file contents, test output, session context (activity class, entry path, request counts, coverage indicator), evidence windows (±15s event timelines around friction signals when enabled); route patterns and relevant source file contents (route classification) | Only during investigation, friction adjudication, fix, and route classification, only with `ANTHROPIC_API_KEY` set |
| E2B sandbox | A clone of the connected repository, the candidate fix, dependency installs, test runs | Only during fix verification, only with `E2B_API_KEY` set |
| Langfuse (tracing backend) | Telemetry spans (operation traces, Anthropic API prompts and responses), scores (diagnosis outcome and confidence, PR outcome) | When `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` are set |
| GitHub (worker) | The fix branch (pushed **before** PR creation — if the PR call then fails, the pushed branch remains and the incident ends `needs_human`), then the PR body (root cause, diff, verification evidence). The setup-PR flow likewise pushes an `opslane/setup` branch and opens a PR. | During fix delivery and setup-PR |
| Configured identity provider | OAuth code exchange and user/email lookup (sign-in); email verification codes when the OAuth provider requires verification | During dashboard sign-in and OAuth email verification |
| GitHub (ingestion) | Installation and repository listing (App setup) | During GitHub App setup |
| Configured webhooks | Issue events (issue ID, title, first-seen timestamp; environment) and digest events (date, session and user counts); both include project ID and name | When enabled notification destinations are triggered by subscribed events |
| WorkOS (ingestion) | Email addresses, passwords, verification codes, reset tokens | Only when password authentication is enabled; during sign-in, signup, email verification, and password reset |

With no credentials configured, **nothing leaves your host** — the stack ingests, groups, and files `needs_human` incidents entirely locally.

Secrets hygiene in the sandbox: before the agent loop runs, well-known secret variables (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, storage and app secrets) are scrubbed from the environment the agent can observe (`packages/worker/src/repo-clone.ts`).

## Browser data and masking

Defense in two layers, both on by default — with an honest note on their scope:

**In the browser (SDK):** since SDK 1.0.0, session recording is **on by
default** (`replay.enabled` defaults to `true`). Earlier versions defaulted to
off; the default changed only across a major version, so it never flips under an
existing integration. Opt out with `replay: { enabled: false }`, or disable
recording for a whole project through the server-side `recording_enabled`
setting without redeploying. A dashboard control is not included in Batch 1.

Every session is recorded, not only error moments. All input values are masked
(`maskAllInputs: true`), as is anything matching `.opslane-mask`;
`.opslane-block` skips a subtree entirely. **Rendered page text is captured as
displayed unless you mask it** — this has not changed, but it now applies to
every session rather than only sessions that hit an error. If you have not
reviewed your masking, do that before upgrading.

For **chunked session recordings**, the browser sends each gzipped ~30s chunk
to ingestion in one API-key-authenticated request. Ingestion buffers at most
5MiB, enforces that ceiling before writing anything, and stores the chunk with
server-side object-storage credentials. Raw replay bytes therefore transit
ingestion and may exist in its process memory before scrubbing. A server-side
scrubber inflates each stored chunk under a hard ceiling, redacts it, and
re-stores it. A chunk is **unreadable until that completes**: `scrubbed_at` is
the only thing that makes it visible to any reader, and a chunk that cannot be
scrubbed stays unreadable permanently rather than being served raw.

The older error-triggered one-shot replay path still redacts by rewriting the
object at completion, so an upload interrupted before completion leaves the raw
recording in storage. That path is retired once error replays resolve to chunk
pointers.

For error events, ingestion redacts breadcrumbs, context (sensitive headers, API-key prefixes, URL-embedded credentials), and network timings (query strings, URL-embedded credentials) before persistence. Events matching known-noise patterns (browser-internal errors like ResizeObserver loop warnings) are suppressed before persistence. Error messages and stack traces are stored verbatim to preserve grouping fingerprints, then redacted when served.

See [replay privacy and masking](../guides/replay-privacy.md) for what replay data may contain.

## Credential storage

- **Ingest API keys** are stored as SHA-256 hashes; the raw key is shown once at creation.
- **User sessions** are JWTs signed with `JWT_SECRET`, mated with rotating refresh-token families (token hashes only in the database).
- **Passwords** (when password authentication is enabled) are not stored locally — registration, authentication, and reset are handled by the configured identity provider (WorkOS).
- **GitHub App private key**, **Langfuse credentials** (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`), and other worker credentials are environment variables — supplied by your deployment, never written to the database.
- **Notification webhook URLs** are encrypted at rest in the database; the encryption key is supplied as an environment variable.
- **Agent onboarding sessions** store poll tokens as hashes and API keys sealed with ephemeral agent public keys (24-hour expiry); raw values are shown once at provisioning. Provisioning requires admin role.
- **Pending OAuth verification tokens** from identity providers are sealed and stored temporarily (10-minute TTL) during email verification flows; the encryption key is supplied as an environment variable.

## Honest gaps (current state)

These are known, tracked, and stated here so you can make an informed deployment decision:

- **Replay and session retention.** Chunked session recordings are deleted on a per-project clock (default 30 days, `projects.session_retention_days`), removing both the database rows and the entire stored-object prefix. Sessions pinned as incident evidence survive the normal window but are hard-capped at 90 days. Deleted session ids are tombstoned and their prefixes are re-swept continuously, so an ingestion-owned storage write already in flight during deletion cannot permanently recreate the data.
- **The older one-shot replay path still has no retention.** `session_replays` rows from the error-triggered path have no expiry or cleanup job and persist until you delete them. See [#29](https://github.com/opslane/opslane-oss/issues/29).
- **`github_token_encrypted` is unused.** The schema has an encrypted-token column, but no code path writes or reads it; GitHub credentials come from the environment (PAT or App key). Envelope-encrypted at-rest token storage is not implemented yet.
- **The bundled Compose file is a development deployment.** Development credentials, no backups, no upgrade/rollback procedure. A production operations guide is tracked separately and blocked on that work.

## Why the prompts are public

The investigation and fix prompts live in this repository (`packages/worker/src`), not behind an API. That is intentional: you can read exactly what instructions the agent operates under, what it is told never to do, and how untrusted error text is fenced (`<untrusted_user_data>` delimiters in the fix loop) before you let it near your code.
