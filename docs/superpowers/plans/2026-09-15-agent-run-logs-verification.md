# Agent run logs verification

Date: 2026-09-15. Implements [the plan](2026-09-15-agent-run-logs.md) and [design](../specs/2026-09-15-agent-run-logs-design.md). The original plan and design remain unchanged. No commit or pull request was created.

## Build and repository checks

- `pnpm install --frozen-lockfile` passed.
- Removed package build outputs, then `pnpm -r build` passed, including worker scripts and shared contracts. Evidence: `/tmp/run-logs-clean-build.log`.
- `go build ./...`, the end-to-end package's TypeScript check, `docker compose config --quiet`, and `git diff --check` passed.
- Repository gate passed: 139 docs/tooling tests and 23 wire/Compose tests, with zero skips. Docs scope, drift, voice, action pins, and Compose port checks passed.
- Package tests passed: agent-runs 29, agent-core 37, dashboard 452, docs site 21, fix-target fixture 2, and reliability 5. Evidence: `/tmp/run-logs-final-gate.log`.
- The host's SDK test run failed because browser system libraries were missing. The entire SDK suite then passed in the official Playwright container: 410 tests in 43 files, zero skips. Evidence: `/tmp/run-logs-sdk-container.log`. The initial recursive test command stopped before worker tests; worker results are tracked separately below.

## Worker and Go checks

- Worker: **2003 passed, 11 skipped**, in 166 passed and two skipped files. The skips were six poller integration tests and five credentialed live tool-contract tests. All run-log database integration tests ran with zero skips. Evidence: `/tmp/run-logs-worker-final.log`.
- Go: **25 packages passed, zero failures and zero skips**. The initial full run reached its default ten-minute timeout in the database migration tests; the other 24 packages completed with 1516 test/subtest passes. The complete database package then passed with `-timeout 20m`: 468 test/subtest passes in 905.832 seconds. Together these runs cover 1984 passing tests/subtests; one additional retention test added afterward passed separately, bringing distinct coverage to **1985**. Evidence: `/tmp/run-logs-go.json` and `/tmp/run-logs-go-db.json`.

## Object storage and pipeline smokes

**Raw gateway, real storage.** A compiled diff judge called a local deterministic HTTP provider and wrote its bundle, transcript, started row, and finished row to real Postgres and MinIO. The run finished `completed`, with one model request, one turn, a provider request ID, 2135 bundle bytes, and 499 transcript bytes. The usage-based cost calculation returned $0.002035; this was calculated from fixture usage, not a provider charge. The `agent-runs.ts show` command read and displayed the stored log. Evidence: `/tmp/run-logs-live-smoke-summary.json` and `/tmp/run-logs-live-smoke-show.txt`.

**Docker event ingestion.** Posting an event to the running ingestion service produced event `1acec42d-fa3a-48d8-a26d-d96e075e4131`; its `stack_resolve` job reached `completed`. No later model phase ran without credentials.

**Real Vue browser pipeline.** The existing known-problems recording pipeline test passed: one test, zero skips. It captured a real Vue session, processed its evidence, published confirmed problems, and checked archival after replay deletion. Evidence: `/tmp/run-logs-browser-smoke.log`.

Database inspection found 17 completed run logs from that smoke:

| Phase | Completed logs | Provider coverage |
| --- | ---: | --- |
| `narrate` | 4 | Four requests to the local HTTP provider |
| `verify` | 4 | Four requests to the local HTTP provider |
| `friction_match` | 4 | Fixture completer; zero gateway requests |
| `friction_first_look` | 2 | Fixture completer; zero gateway requests |
| `friction_confirm` (grouped across batch suffixes) | 3 | Fixture completer; zero gateway requests |

The fixture-completer phases prove run boundaries and storage, but do not prove their live provider gateways. Unit and rebuild tests cover those gateways separately.

## Containers and test isolation

Worker and ingestion images built successfully. The worker image received HEAD SHA `e95d5de35ea75901cdc04525d1e5d1a5089e6749`, verified in its runtime environment. The separate host sink smoke supplied that same SHA and verified it in the stored bundle and rows. Both services became healthy. The worker health endpoint on port 8081 reported every new run-log failure counter as zero.

The disposable services were stopped after verification. Their database and object-storage volumes remain available for inspection.

Database suites and browser smokes used separate disposable databases to avoid fixture interference. Browser tests used `CHOKIDAR_USEPOLLING=1` after the host exhausted its file-watcher limit. The host-only public endpoint override was unset while checking Compose ports. These were test-environment adjustments; no product behavior was weakened to pass verification.

## Initial port collision

The first migration attempt mistakenly reached the existing `error-tracking` Postgres on port 5444. It applied migrations through 077, then stopped at 078 because that server lacked the vector extension. Migration 079 did not run there. The baseline statement `UPDATE error_group_jobs SET source_id = error_group_id WHERE source_id IS NULL` reported 33,567 matched rows; some may have been null-to-null assignments. There is no before snapshot, so the number of changed values is unverified. Other logged INSERT, UPDATE, and DELETE counts before the failure were zero.

The existing schema changed: migrations added dead-letter fields and indexes (071), agent-session metadata and an expiry default (074), session steps (075, with its step constraint removed by 076), and installation `html_url` (077). Existing functions and triggers were also recreated.

The three test fixture rows added there (one organization, project, and job) were removed by their exact IDs. No attempt was made to reverse the migration backfill. Subsequent work uses the verified disposable stack on ports 18792, 15744, and 19722, with separate databases for Go tests, worker tests, and pipeline smokes.

## Coverage limits

Real Anthropic, E2B, and GitHub credentials were unavailable. No credentialed Anthropic smoke, E2B investigation, or GitHub fix/PR delivery was verified. The local HTTP smoke exercises the provider transport and real persistence, with deterministic provider responses.

## Independent verification

A second pass drove nine acceptance criteria on a throwaway Compose stack. It used real Anthropic and E2B for an issue inquiry, a friction ticket investigation, and a session narration. Every other model call went through a recording proxy that logged each request and response. The first pass proved 7 of 9 criteria, found 4 defects, and ran on an older disposable stack.

**Proven:**
- Both Agent SDK runs logged every tool result byte-identical to what the model received.
- `agent-runs.ts show` printed a run while Postgres was paused.
- The real narration's request ID, usage, and thinking block matched the provider response.
- The view reported `running` while the job held its lease, and `unfinished` after the worker was killed and the lease expired.
- With MinIO paused, jobs completed about 10 seconds slower and recorded the write failures on `/health`.
- Retention removed an expired day, including an orphaned object, and kept the boundary day.
- Stub-driven prompts for narrate, verify, match, first look, and confirm matched `e95d5de` after normalizing IDs, timestamps, frame bytes, and job-order-dependent ticket lists.

**Defects found and fixed:**
1. The SDK transcriber split one streamed response into many whenever system notices or tool results arrived between its frames. A real investigation logged 18 responses and `model_requests = 18` for 5 API requests, with no stop reasons. Interleaved messages are now held until the response ends. The last response takes the result's stop reason, and earlier tool-calling responses are marked `tool_use`. `turns` counts logged responses.
2. Confirm, one-fix, match, and first-look rejections stored `payload: null`. They now store the parsed reply, or its raw text when it did not parse.
3. The `Authorization:` scrubber deleted the rest of the line. One-line JSON model replies were stored cut off mid-string. It now replaces only the credential.
4. The model gateway guard did not catch imports of `anthropic-client`. Phases now get a client from `messagesClient()` in `run-logs/logged-messages.ts`, and the guard rejects any other import. Mutation checks confirmed the guard fails on a static or dynamic import.

**After the fixes:**
- Worker tests against a migrated disposable database: 2005 passed, 11 skipped (the same poller integration and credentialed tool-contract tests).
- A live recheck with real Anthropic and E2B:
  - Both SDK runs logged 5 responses for 5 wire requests, with `model_requests` and `turns` of 5 and stop reasons `tool_use` then `end_turn`.
  - Rejection payloads held the rejected answer.
  - The narration reply with planted secrets was stored as valid JSON, with every secret redacted and the surrounding text kept.

**Not verified live:**
- The fix path: model port, diff judge, fix judge, and fix narrative.
- The digest writer, visual analysis, product context, and route map.
- The 72-hour production coverage window.
