---
description: Every environment variable each service reads.
---
# Environment variables

Every variable each service actually reads, from `os.Getenv` (ingestion) and `process.env` (worker). The [drift check](../../scripts/check-docs-drift.mjs) fails the repository test gate (`pnpm test`, which CI runs) if code and this page disagree.

## Browser SDK build

These variables are read only by the Vite build process; none is shipped as a
secret to the browser.

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPSLANE_COMMIT_SHA` | no | First environment override used by debug-ID build provenance. |
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

## Ingestion API

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `PORT` | no (8080) | HTTP listen port |
| `JWT_SECRET` | yes | Signs session tokens and derives the notification destination encryption key (≥32 bytes). Rotating it invalidates stored webhook configs; users must re-enter their webhook URLs. |
| `OPSLANE_PUBLIC_INGEST_URL` | for minting source-map keys | Public origin that source-map uploads should reach this deployment on. Read by `cmd/mint-key`, which seals it into every `-scope sourcemaps` key it prints; a build therefore configures uploads with that one key and no endpoint variable. Must be an absolute origin — https, or http only for loopback — with no path, query, or fragment. `-endpoint` overrides it and must agree if both are set. |
| `AUTH_PROVIDER` | no | Identity provider: `github` (default) or `workos`. Selection is explicit and invalid/partial WorkOS configuration fails boot. |
| `AUTH_CALLBACK_ORIGIN` | no | Public ingestion origin used to construct the allowlisted `/auth/callback` URL. Never derived from the request Host header. Defaults to the local ingestion port; Compose sets `http://localhost:8082`. |
| `WORKOS_API_KEY` | when `AUTH_PROVIDER=workos` | WorkOS secret API key used for AuthKit code exchange. |
| `WORKOS_CLIENT_ID` | when `AUTH_PROVIDER=workos` | WorkOS project client ID used for AuthKit authorization. |
| `AUTH_WORKOS_SOCIAL` | no | Comma-separated social login buttons to show under `AUTH_PROVIDER=workos` (e.g. `google,github`). UI capability only; the WorkOS dashboard governs which methods actually work. |
| `DASHBOARD_DIR` | no | Directory of built dashboard SPA to serve (set in the Docker image) |
| `DASHBOARD_ORIGIN` | no | Allowed dashboard origin for CORS **and** the OAuth redirect target. For the bundled Compose setup, set `http://localhost:8082`. This is separate from the worker's reader-facing `DASHBOARD_URL`. |
| `DASHBOARD_URL` | no | Public or private HTTP(S) dashboard base URL used for reader-facing notification links. Configure it explicitly; loopback URLs are rejected, and `DASHBOARD_ORIGIN` is not used as a fallback. This mirrors the worker variable of the same name. |
| `DIGEST_SWEEP_ENABLED` | no (`false`) | Enables the ingestion-side daily digest sweep only when set to the literal `true`. Keep it disabled during rollout phase 1; enable it after every ingestion replica has the `digest.daily` formatter. |
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
| `INTERNAL_READ_TOKEN` | for worker replay evidence | Shared secret guarding worker-to-ingestion chunk reads. Unset disables the internal endpoint. |
| `SESSION_IDLE_CLOSE_MINUTES` | no (30) | Idle minutes before a recording session closes and its `session_analysis` job is enqueued (friction detection producer) |
| `RETENTION_SWEEP_INTERVAL_SECONDS` | no (3600) | How often the retention sweeper runs (session close + expiry pass) |
| `PRIORITY_SCORE_INTERVAL_SECONDS` | no (1800) | How often ingestion recomputes priority scores for open incidents and discovers missing route-map classifications. Must be a positive integer number of seconds; invalid values use the default. |
| `SCRUB_INTERVAL_SECONDS` | no (15) | How often the chunk scrubber looks for committed chunks to redact. Test lanes shorten it to cut e2e wall-clock. Separate from the retained fixed 30s eligibility grace; chunk uploads are no longer presigned, so shortening that grace is now a separate privacy-timing decision. |
| `ADMIN_EMAILS` | no | Comma-separated operator email allowlist for the cross-tenant admin dashboard. Empty disables the admin API. Docker Compose maps it from the host-side `OPSLANE_ADMIN_EMAILS`. |
| `VERSION` | no | Reported by `/health` |

Ingestion reads **only** the `REPLAY_STORE_*` names; `MINIO_*` names appear in its test code, not runtime configuration.

## Worker

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes (hard exit without it) | Postgres connection string |
| `INGESTION_BASE_URL` | for session replay evidence | Base URL used to fetch decoded, re-redacted session chunks from ingestion |
| `INTERNAL_READ_TOKEN` | for session replay evidence | Shared secret sent to ingestion as `X-Internal-Token` |
| `ANTHROPIC_API_KEY` | for investigation | Claude API access; missing → `missing_llm_key` outcomes |
| `INVESTIGATION_MODEL` | no (`claude-sonnet-5`) | Anthropic model used by the codebase-aware diagnosis pass. Unknown model names use the default pricing estimate for budget enforcement. |
| `FIX_JUDGE_MODEL` | no (`claude-sonnet-5`) | Anthropic model used by the independent post-verification fix judge. Automated fixes fail closed when this judge does not approve them. |
| `INVESTIGATION_MAX_TURNS` | no (10) | Maximum tool-use turns allowed for one diagnosis pass. |
| `INVESTIGATION_BUDGET_USD` | no (2.00) | Estimated model-spend ceiling in USD for the investigation. It is a runaway backstop, not the operating budget: turns are what the agent paces itself against. Exceeding it fails closed as `needs_more_context`; it never becomes a conclusion. |
| `FRICTION_INVESTIGATION_MODEL` | no (`claude-sonnet-4-6`) | Anthropic model used by the repository-aware friction classification pass. |
| `FRICTION_INVESTIGATION_MAX_TURNS` | no (20) | Maximum repository-exploration turns allowed before the friction classifier must submit its verdict. Zero produces an evidence-incomplete result. |
| `FRICTION_INVESTIGATION_BUDGET_USD` | no (2.00) | Estimated model-spend ceiling in USD for friction investigation. Exceeding it fails closed without publishing a cause. |
| `E2B_API_KEY` | for verification | Sandbox where fixes are tested |
| `GITHUB_TOKEN` | one of the two GitHub modes | PAT for clone + PR |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | the other mode | GitHub App installation tokens |
| `DASHBOARD_URL` | no | Public or private HTTP(S) dashboard base URL used for reader-facing incident links in PR bodies and notifications. Configure it explicitly; loopback URLs are rejected, and the ingestion service's `DASHBOARD_ORIGIN` is not used as a fallback. |
| `WORKER_ID` | no (generated) | Stable worker identity for lease ownership |
| `POLL_INTERVAL_MS` | no (5000) | How long the worker waits when the queue is empty (it drains continuously while work exists). Accepted range 50-300000; out-of-range or non-integer values log a warning and fall back to the default |
| `SHUTDOWN_GRACE_MS` | no (25000) | Maximum time to wait for the poll loop during shutdown. Must stay below the platform's container termination grace period, or the container is killed before the graceful path runs. Compose sets `stop_grace_period: 30s` on the worker for this reason; Docker's 10s default is *below* the 25s grace. Accepted range 1000-120000; out-of-range values log a warning and fall back to the default |
| `LEASE_DURATION_MS` / `REAPER_INTERVAL_MS` / `SILENCE_CHECK_INTERVAL_MS` | no | Queue lease and maintenance tuning |
| `RESOLVE_AGE_DAYS` | no (14) | Days without a new occurrence before `needs_human` and `investigated` issues are auto-resolved |
| `INACTIVITY_CHECK_INTERVAL_MS` | no (900000) | How often the worker sweeps for inactive issues (15 minutes by default) |
| `SESSION_ANALYSIS_MAX_CONCURRENT` | no (2) | Fleet-wide cap on concurrently claimed `session_analysis` jobs; `0` disables analysis claiming entirely; raising it has no effect at fleet size 1 |
| `ADJUDICATION_EVIDENCE_WINDOWS` | no (`off`) | Evidence-window adjudication mode: `off`, `shadow`, or `on`. `shadow` makes a second model call for flagged signals while the selector-only verdict still decides. |
| `ADJUDICATION_DAILY_CAP` | no (500) | Per-project daily model-call cap for friction adjudication. Overflow signals remain pending and are revisited on the next budget day. |
| `HEALTH_PORT` | no (8081) | Health endpoint port. The worker's `/health` returns `status: ok`, `stalled` (eligible work waiting, no claims in the last minute, nothing in flight), or `unknown` (no queue sample has landed, or the last one is stale), plus `claims_per_minute` and a per-job-type `queue_depth` carrying eligible, backed-off, and oldest-eligible-seconds counts. The queue is sampled once a minute, not per claim |
| `REPLAY_STORE_ENDPOINT` / `REPLAY_STORE_ACCESS_KEY` / `REPLAY_STORE_SECRET_KEY` / `REPLAY_STORE_BUCKET` | for replay analysis | Reading stored replays |
| `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_BUCKET` | legacy aliases | Worker-side fallback names for the same settings |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` / `LANGFUSE_PROJECT_ID` | no | Optional LLM tracing |
| `ANTHROPIC_BASE_URL` | no (Anthropic default) | Alternate Claude API endpoint; used by the hermetic test harness's fake model server |
| `OPSLANE_SANDBOX_BACKEND` | no (`e2b`) | Fix-verification sandbox backend; `local` is only for trusted reliability fixtures and also requires `OPSLANE_RELIABILITY_HARNESS=1` |
| `SANDBOX_LIFETIME_MS` | no (`1800000`) | Wall-clock ceiling for a verification sandbox. Values below `900000` fall back to the default; values above `1800000` are clamped to it (E2B enforces account-tier maximums). The ceiling is not billed unless consumed; raising it increases orphan exposure if the worker crashes. |
| `OPSLANE_PYTHON_PIPELINE` | no (off) | Enables durable Python incident routing for `1` or `true`; the effective platform is persisted on the fix job. |
| `OPSLANE_E2B_PYTHON_TEMPLATE` | no (`opslane-python`) | Overrides the E2B template name used by Python fix jobs. |
| `OPSLANE_RELIABILITY_HARNESS` | no | Explicit guard required before the non-isolating local sandbox test transport can run |
| `OPSLANE_GITHUB_URL` | no (`https://github.com`) | Alternate git host for clones; used by tests and self-hosted git |
| `OPSLANE_GITHUB_API_URL` | no (GitHub default) | Alternate GitHub REST API base URL for PR creation |

The worker starts with only `DATABASE_URL` and logs a warning for missing `ANTHROPIC_API_KEY`, `E2B_API_KEY`, and `GITHUB_TOKEN` — jobs then end in explicit `needs_human` states rather than crashing.

## Set in Compose but consumed by no code (known dead config)

| Variable | Status |
| --- | --- |
| `VITE_OPSLANE_RELEASE` | Read by no code in this repository. It fed the published legacy uploader's `release`; that plugin now throws, and debug IDs replaced release matching. Your own application may still read it to pass `init({ release })`, which is display metadata only. |
| `ALLOW_REGISTRATION` | Read by nothing; there is no self-serve registration path (sign-in is GitHub OAuth). |
| `OPSLANE_ADMIN_EMAILS` | Host-side name that docker-compose.yml maps into the ingestion service's `ADMIN_EMAILS`; consumed by Compose interpolation, not read by code directly. |
| `INGESTION_PORT` | Host port published for the ingestion API and dashboard (default 8082). Compose interpolation only. `AUTH_CALLBACK_ORIGIN` follows it unless set explicitly. |
| `OPSLANE_POSTGRES_HOST_PORT` | Host port published for the bundled Postgres (default 5434). Compose interpolation only. Set it, plus a matching `DATABASE_URL`, to run a second stack beside an existing one. |
| `OPSLANE_MINIO_HOST_PORT` | Host port published for the bundled MinIO (default 9012). Compose interpolation only. `REPLAY_STORE_PUBLIC_ENDPOINT` follows it unless set explicitly — browsers upload replay chunks to that origin, so the two must agree. |
| `OPSLANE_INFRA_BIND_ADDR` | Interface the Postgres and MinIO host ports bind to (default `127.0.0.1`; they carry committed dev credentials). Compose interpolation only. Widen it only when loopback is inside a VM, as with Colima or a remote `DOCKER_HOST`. |
| `OPSLANE_MINIO_READY_TIMEOUT_SECONDS` | How long `minio-setup` waits for MinIO before exiting non-zero with a diagnostic (default 60). Compose interpolation only. |
| `ENCRYPTION_KEY` | Read by nothing except a sandbox scrub list; at-rest token encryption is not implemented (see [trust](../architecture/trust.md#honest-gaps-current-state)). |
