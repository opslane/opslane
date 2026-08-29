---
description: Every environment variable each service reads.
---
# Environment variables

Every variable each service actually reads, from `os.Getenv` (Opslane server) and `process.env` (worker). The [drift check](../../scripts/check-docs-drift.mjs) fails the repository test gate (`pnpm test`, which CI runs) if code and this page disagree.

## Browser SDK build

These variables are read only by the Vite build process; none is shipped as a
secret to the browser.

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPSLANE_COMMIT_SHA` | no | First environment override for the commit recorded in source-map build metadata. |
| `GITHUB_SHA` | no | GitHub Actions commit fallback. |
| `VERCEL_GIT_COMMIT_SHA` | no | Vercel commit fallback. |
| `CF_PAGES_COMMIT_SHA` | no | Cloudflare Pages commit fallback. |
| `CI_COMMIT_SHA` | no | GitLab and compatible CI commit fallback. |
| `RENDER_GIT_COMMIT` | no | Render commit fallback. |
| `BITBUCKET_COMMIT` | no | Bitbucket commit fallback. |
| `GIT_COMMIT` | no | Generic CI commit fallback. |
| `BUILD_SOURCEVERSION` | no | Azure Pipelines commit fallback. |

The precedence is the plugin's explicit `commitSha`, then the variables in the
table order, then `.git/HEAD`. Only lowercase 40- or 64-character hexadecimal
values are accepted. COMMIT_REF is intentionally unsupported because many CI
systems use it for a branch name.

## Opslane API

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `PORT` | no (8080) | HTTP listen port |
| `JWT_SECRET` | yes | Signs session tokens and derives the notification destination encryption key (≥32 bytes). Rotating it invalidates stored webhook configs; users must re-enter their webhook URLs. |
| `OPSLANE_PUBLIC_INGEST_URL` | for creating source-map keys | Public Opslane server origin that source-map uploads should reach. Read by `cmd/mint-key`, which stores it in every `-scope sourcemaps` key it creates; a build therefore configures uploads with that one key and no endpoint variable. Must be an absolute origin (https, or http only for loopback) with no path, query, or fragment. `-endpoint` overrides it and must agree if both are set. |
| `AUTH_PROVIDER` | no | Identity provider: `github` (default) or `workos`. Selection is explicit and invalid/partial WorkOS configuration fails boot. |
| `AUTH_CALLBACK_ORIGIN` | no | Public Opslane server origin used to construct the allowed `/auth/callback` URL. Never derived from the request Host header. Defaults to the local server port; Compose sets `http://localhost:8082`. |
| `WORKOS_API_KEY` | when `AUTH_PROVIDER=workos` | WorkOS secret API key used for AuthKit code exchange. |
| `WORKOS_CLIENT_ID` | when `AUTH_PROVIDER=workos` | WorkOS project client ID used for AuthKit authorization. |
| `AUTH_WORKOS_SOCIAL` | no | Comma-separated social login buttons to show under `AUTH_PROVIDER=workos` (e.g. `google,github`). UI capability only; the WorkOS dashboard governs which methods actually work. |
| `DASHBOARD_DIR` | no | Directory of built dashboard SPA to serve (set in the Docker image) |
| `DASHBOARD_ORIGIN` | no | Allowed dashboard origin for CORS **and** the OAuth redirect target. For the bundled Compose setup, set `http://localhost:8082`. This is separate from the worker's `DASHBOARD_URL`, which supplies links in pull requests and notifications. |
| `DASHBOARD_URL` | no | Public or private HTTP(S) dashboard base URL used for notification links shown to users. Configure it explicitly; loopback URLs are rejected, and `DASHBOARD_ORIGIN` is not used as a fallback. This mirrors the worker variable of the same name. |
| `USAGE_EVENTS_SLACK_WEBHOOK` | no | Slack incoming webhook for best-effort operator usage notifications. Unset disables them. Configure the same private-channel webhook on both server-side services. |
| `GROUPING_DEBUG_ID_FRAMES` | no (`false`) | Uses valid SDK build identifiers to normalize temporary JavaScript stack-frame locations whose bundle URL changes between page loads. A build identifier is embedded in a built file and its source map so Opslane can match them. Only the literal `true` enables this setting, and the server reads it once at startup. Keep it consistent across server replicas. After source-map processing, Opslane groups each error into its final issue. |
| `DIGEST_UNIFIED_CARDS` | no (`off`) | Daily-summary card rollout mode: `off` keeps the current output and `on` sends the new cards. With `on`, an item appears only while it is waiting on a person, and it repeats every day until someone acts. Any other value, including the retired `shadow`, uses `off`. Each daily run keeps the mode chosen when it started. |
| `NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS` | no | **Development/test only.** Comma-separated exact `host[:port]` additions to the Slack webhook allowlist; added hosts may use HTTP. Never set this in production. |
| `GITHUB_APP_ID` | for GitHub App | App ID |
| `GITHUB_APP_CLIENT_ID` | for OAuth sign-in | OAuth client ID |
| `GITHUB_APP_CLIENT_SECRET` | for OAuth sign-in | OAuth client secret |
| `GITHUB_APP_PRIVATE_KEY` | for GitHub App | App private key (PEM) |
| `GITHUB_APP_SLUG` | no | App slug used in install URLs |
| `GITHUB_WEBHOOK_SECRET` | for webhooks | HMAC secret for webhook verification |
| `REPLAY_STORE_ENDPOINT` / `REPLAY_STORE_PUBLIC_ENDPOINT` | for replays | S3-compatible endpoint (internal / browser-visible) |
| `REPLAY_STORE_ACCESS_KEY` / `REPLAY_STORE_SECRET_KEY` | for replays | Storage credentials |
| `REPLAY_STORE_BUCKET` / `REPLAY_STORE_REGION` | for replays | Bucket and region |
| `INTERNAL_READ_TOKEN` | for worker replay evidence | Shared secret guarding recording-part reads from the worker to the Opslane server. Unset disables the internal endpoint. |
| `SESSION_IDLE_CLOSE_MINUTES` | no (30) | Idle minutes before a recording session closes and the server queues its `session_analysis` job to detect problems in the recording |
| `RETENTION_SWEEP_INTERVAL_SECONDS` | no (3600) | How often a background task closes idle sessions and removes expired recordings |
| `PRIORITY_SCORE_INTERVAL_SECONDS` | no (1800) | How often the server recomputes priority scores for open incidents and finds pages whose importance has not yet been assessed. Must be a positive integer number of seconds; invalid values use the default. |
| `SCRUB_INTERVAL_SECONDS` | no (15) | How often a background task looks for completed parts of recordings that need redaction. Tests may shorten it. |
| `RESOLVE_SWEEP_INTERVAL_SECONDS` | no (300) | How often a background task retries source-map processing and, after waiting too long, continues with the minified stack trace. |
| `IDENTITY_SETTLE_INTERVAL_SECONDS` | no (5) | How often the server groups reported errors after source-map processing finishes. |
| `FILTER_SWEEP_INTERVAL_SECONDS` | no (30) | How often the server checks uninvestigated errors for enough recent users in enabled environments, then queues a short repository review that decides whether to start a full investigation. Invalid values use the default. |
| `ADMIN_EMAILS` | no | Comma-separated operator email allowlist for the cross-tenant admin dashboard. Empty disables the admin API. Docker Compose maps it from the host-side `OPSLANE_ADMIN_EMAILS`. |
| `VERSION` | no | Reported by `/health` |

The Opslane server reads **only** the `REPLAY_STORE_*` names; `MINIO_*` names appear in its test code, not runtime configuration.

## Worker

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes (hard exit without it) | Postgres connection string |
| `INGESTION_BASE_URL` | for session replay evidence | Opslane server base URL used to fetch decoded recording parts with sensitive values removed |
| `INTERNAL_READ_TOKEN` | for session replay evidence | Shared secret sent to the Opslane server as `X-Internal-Token` |
| `ANTHROPIC_API_KEY` | for investigation | Claude API access; missing → `missing_llm_key` outcomes |
| `INVESTIGATION_MODEL` | no (`claude-sonnet-5`) | Anthropic model used by the codebase-aware diagnosis pass. Unknown model names use the default pricing estimate for budget enforcement. |
| `DIGEST_MODEL` | no (`INVESTIGATION_MODEL`, then `claude-sonnet-5`) | Anthropic model used to write daily-summary items selected by the server. |
| `DIGEST_WRITER_MAX_WRITES` | no (unlimited) | Most daily-summary items one run may write from scratch. Items reused from an earlier day cost nothing and are always delivered; anything over the limit is held for the next day with a stated reason. `0` delivers only reused items. A value that is not a whole number of zero or more runs unlimited and logs one warning. Compose passes this through; on AWS, add it to the worker task definition in the deploy repository or it has no effect there. |
| `INQUIRY_MODEL` | no (`INVESTIGATION_MODEL`, then `claude-sonnet-5`) | Anthropic model used for a short, read-only repository review that decides whether an issue that met the review threshold warrants a full investigation. |
| `PRODUCT_CONTEXT_MODEL` | no (`INVESTIGATION_MODEL`, then `claude-sonnet-5`) | Anthropic model used to refresh Opslane's understanding of your pages and user actions after a default-branch push. |
| `FIX_JUDGE_MODEL` | no (`claude-sonnet-5`) | Second Anthropic model that reviews a fix after tests run. Automated fixes stop when this model does not approve them. |
| `INVESTIGATION_MAX_TURNS` | no (10) | Maximum model and tool steps allowed for one investigation. |
| `INVESTIGATION_BUDGET_USD` | no (2.00) | Estimated model-spend ceiling for one investigation. It is a runaway backstop, not an operating target. Crossing it stops the attempt without inventing a conclusion. |
| `FRICTION_INVESTIGATION_MODEL` | no (`claude-sonnet-4-6`) | Anthropic model that reviews whether a session recording shows a real user problem. |
| `FRICTION_INVESTIGATION_MAX_TURNS` | no (20) | Maximum model and tool steps for exploring the repository before the model must submit a conclusion. Zero stops without a conclusion. |
| `FRICTION_INVESTIGATION_BUDGET_USD` | no (2.00) | Estimated model-spend ceiling in USD for investigating a problem detected from a session recording. Exceeding it stops the investigation without publishing a cause. |
| `E2B_API_KEY` | for verification | Sandbox where fixes are tested |
| `GITHUB_TOKEN` | one of the two GitHub modes | PAT for clone + PR |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | the other mode | GitHub App installation tokens |
| `DASHBOARD_URL` | no | Public or private HTTP(S) dashboard base URL used for incident links in PR bodies and notifications. Configure it explicitly; loopback URLs are rejected, and the Opslane server's `DASHBOARD_ORIGIN` is not used as a fallback. |
| `USAGE_EVENTS_SLACK_WEBHOOK` | no | Slack incoming webhook for best-effort operator usage notifications. Unset disables them. Messages can contain customer email addresses and error titles, so use a private channel. |
| `WORKER_ID` | no (generated) | Stable worker identity used when one worker takes temporary ownership of a job |
| `POLL_INTERVAL_MS` | no (5000) | How long the worker waits when the queue is empty (it drains continuously while work exists). Accepted range 50-300000; out-of-range or non-integer values log a warning and fall back to the default |
| `SHUTDOWN_GRACE_MS` | no (25000) | Maximum time to wait for the poll loop during shutdown. Must stay below the platform's container termination grace period, or the container is killed before the graceful path runs. Compose sets `stop_grace_period: 30s` on the worker for this reason; Docker's 10s default is *below* the 25s grace. Accepted range 1000-120000; out-of-range values log a warning and fall back to the default |
| `LEASE_DURATION_MS` / `REAPER_INTERVAL_MS` / `SILENCE_CHECK_INTERVAL_MS` | no | Duration of a worker's temporary job ownership, expired-job cleanup interval, and stalled-queue check interval |
| `RESOLVE_AGE_DAYS` | no (14) | Inactivity period before eligible human-review or completed-analysis issues resolve automatically |
| `INACTIVITY_CHECK_INTERVAL_MS` | no (900000) | How often the worker sweeps for inactive issues (15 minutes by default) |
| `SESSION_ANALYSIS_MAX_CONCURRENT` | no (2) | Fleet-wide cap on `session_analysis` jobs running at the same time; `0` prevents workers from starting analysis jobs; raising it has no effect at fleet size 1 |
| `ADJUDICATION_EVIDENCE_WINDOWS` | no (`off`) | Mode for an optional second review of a detected session problem using activity around the click: `off`, `shadow`, or `on`. `shadow` records the second opinion but does not use it. |
| `ADJUDICATION_DAILY_CAP` | no (500) | Per-project daily cap on model calls for the optional second review. Extra detected session problems remain pending and are revisited on the next budget day. |
| `HEALTH_PORT` | no (8081) | Health endpoint port. The worker's `/health` returns `status: ok`, `stalled` (eligible work waiting, no jobs started in the last minute, and none running), or `unknown` (no queue sample has landed, or the last one is stale). It also returns `claims_per_minute`, the number of jobs started per minute, and a per-job-type `queue_depth` with eligible, backed-off, and oldest-eligible-seconds counts. The queue is sampled once a minute, not every time a worker starts a job. |
| `REPLAY_STORE_ENDPOINT` / `REPLAY_STORE_ACCESS_KEY` / `REPLAY_STORE_SECRET_KEY` / `REPLAY_STORE_BUCKET` | for replay analysis | Reading stored replays |
| `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_BUCKET` | legacy aliases | Worker-side fallback names for the same settings |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` / `LANGFUSE_PROJECT_ID` | no | Optional LLM tracing |
| `ANTHROPIC_BASE_URL` | no (Anthropic default) | Alternate Claude API endpoint; automated tests use it for a fake model server |
| `OPSLANE_SANDBOX_BACKEND` | no (`e2b`) | Fix-verification sandbox backend; `local` is only for trusted automated reliability tests and also requires `OPSLANE_RELIABILITY_HARNESS=1` |
| `SANDBOX_LIFETIME_MS` | no (`1800000`) | Wall-clock ceiling for a verification sandbox. Values below `900000` fall back to the default; values above `1800000` are clamped to it (E2B enforces account-tier maximums). The ceiling is not billed unless consumed; raising it increases orphan exposure if the worker crashes. |
| `OPSLANE_PYTHON_PIPELINE` | no (off) | Routes Python errors through the Python-specific fix workflow for `1` or `true`; Opslane saves the chosen platform with the repair task. |
| `OPSLANE_E2B_PYTHON_TEMPLATE` | no (`opslane-python`) | Overrides the E2B template name used by Python repair tasks. |
| `OPSLANE_RELIABILITY_HARNESS` | no | Explicit guard required before tests can use the local process runner, which does not isolate commands |
| `OPSLANE_GITHUB_URL` | no (`https://github.com`) | Alternate git host for clones; used by tests and self-hosted git |
| `OPSLANE_GITHUB_API_URL` | no (GitHub default) | Alternate GitHub REST API base URL for PR creation |

The worker starts with only `DATABASE_URL` and logs a warning for missing `ANTHROPIC_API_KEY`, `E2B_API_KEY`, and `GITHUB_TOKEN`. Work that needs a missing credential stops with a reason instead of crashing the worker.

## Set in Compose but consumed by no code (known dead config)

| Variable | Status |
| --- | --- |
| `VITE_OPSLANE_RELEASE` | Read by no code in this repository. It fed the published legacy uploader's `release`; that plugin now throws, and debug IDs replaced release matching. Your own application may still read it to pass `init({ release })`, which is display metadata only. |
| `ALLOW_REGISTRATION` | Read by nothing; there is no self-serve registration path (sign-in is GitHub OAuth). |
| `OPSLANE_ADMIN_EMAILS` | Host-side name that docker-compose.yml maps into the Opslane server service (`ingestion`) as `ADMIN_EMAILS`; consumed by Compose interpolation, not read by code directly. |
| `INGESTION_PORT` | Host port published for the Opslane API and dashboard (default 8082). Compose interpolation only. `AUTH_CALLBACK_ORIGIN` follows it unless set explicitly. |
| `OPSLANE_POSTGRES_HOST_PORT` | Host port published for the bundled Postgres (default 5434). Compose interpolation only. Set it, plus a matching `DATABASE_URL`, to run a second stack beside an existing one. |
| `OPSLANE_MINIO_HOST_PORT` | Host port published for the bundled MinIO (default 9012). Compose interpolation only. `REPLAY_STORE_PUBLIC_ENDPOINT` follows it unless set explicitly. Browsers upload replay chunks to that origin, so the two must agree. |
| `OPSLANE_INFRA_BIND_ADDR` | Interface the Postgres and MinIO host ports bind to (default `127.0.0.1`; they carry committed dev credentials). Compose interpolation only. Widen it only when loopback is inside a VM, as with Colima or a remote `DOCKER_HOST`. |
| `OPSLANE_MINIO_READY_TIMEOUT_SECONDS` | How long `minio-setup` waits for MinIO before exiting non-zero with a diagnostic (default 60). Compose interpolation only. |
| `ENCRYPTION_KEY` | Reserved for future encrypted-at-rest token storage; not read by current code. |
