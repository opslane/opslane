# Agent run logs

Date: 2026-09-15. Branch: `abhishekray07/opslane-agent-loop`. Status: revision 4. It follows two Codex review rounds and an owner alignment grill. Decisions come from the 2026-09-15 grill sessions; the changes made after review are listed under "Review log".

**Why this exists.** Opslane is its own first customer for understanding its agent loop. The same capability is meant to let Opslane's customers improve their own agent loops later, the way they improve their frontends with Opslane today. The design therefore stays generic wherever that costs little.

**Naming.** "Session recording" always means an end user's replay data captured by the browser SDK. "Run log" means what this spec stores about one of Opslane's own agent runs. The two are never both called "recording".

## Problem

Opslane's outcomes depend on model calls we cannot inspect after the fact. A run leaves a terminal status, sometimes a `last_error`, a `job_usage` row, and a Langfuse trace, but not what the model saw, what it did, or why it stopped.

- **Agent SDK stages are invisible.** Investigation, inquiry, product context/route map and friction investigation run through `@anthropic-ai/claude-agent-sdk` in a subprocess (`packages/worker/src/harness/sdk-agent.ts`). Langfuse's Anthropic instrumentation cannot see those calls. Their traces hold a wrapper span with summary attributes and no model or tool calls (sample trace `9878285519364d59e75fa8ccbcbfa485`). The message stream is read at `sdk-agent.ts:386` and discarded.
- **Failures read as judgments.** From 2026-08-13 to 2026-08-21, 354 AMFJ error investigations across 93 groups recorded `needs_more_context` with $0 spent. The real cause was an API 400 on the tool schema. It was found by accident during a verification run on 2026-08-19.
- **Validator rejections lose the reason.** Since 2026-09-13, 39 `friction_confirm` jobs failed with one catch-all message, "Malformed confirmation or evidence outside the recording" (`friction/confirm.ts:159`), which covers about twelve rules. 12 dead-lettered. The sampled outputs all broke one rule (`confirmed` with no signal IDs), visible only by pulling raw output from Langfuse by hand.
- **Failed spend disappears.** All 16 `route_map` dead letters in the last 30 days have no `job_usage` rows. Investigation, inquiry and product context write usage only after the model function returns, so a throw after the model ran records nothing (`sdk-agent.ts:482`, `inquiry/job.ts:217-231`, `product-context/job.ts:311-325`).
- **Transcripts found defects that outcome tables could not.** A 2026-09-14 spike re-ran 5 real friction tickets 3 times each and captured the SDK message stream:
  - `repositoryTree()` cuts the prompt's file list to 8,192 bytes (`friction/investigate-friction.ts:162`). The AMFJ tree is 165 KB, so `vue3/` never appears, and 7 published briefs cite only `client/asset-panel` code for screens the `vue3` app serves.
  - The search tool passes a comma-separated `include` as one glob (`investigate-tools.ts:93`). 27 of 39 empty searches were false negatives.

Without a log of each run, every such defect is found by accident.

## Goal

Log every model-calling run in the worker so that:
1. Every run with a finished log can be explained from that log alone: what the model was given, what it returned, what every tool returned to it, and why it stopped.
2. Every run with a started log keeps the input needed to replay it later, including a run that never finished.

This spec covers logging only. Checks, replay, production rebuild verification, a dashboard page and Langfuse span export are later work that reads these logs.

## Terms

- **Run:** one attempt by a job execution to get a usable answer from a phase's model entry point.
  - A retry controller that re-invokes the entry point on invalid output belongs to the same run. Examples: `validated()` in `friction/match-job.ts:101`, the immediate re-call at `friction/confirm-job.ts:499-500`, and the fix judge's malformed-verdict retry. The log then shows every attempt and every rejection, so "the re-ask did not help" is visible in one place.
  - A job retry, a fix tier and a fix test retry each start a new run.
- **Phase:** as in `CONTEXT.md`, a named stage of a job that spends model tokens. A run carries the phase name its `job_usage` row uses.
- **Run log:** the stored record of one run. It has two parts:
  - **Input bundle:** what is needed to rebuild the run's first model request and repeat the run. That is the prompt builder's structured input, effective settings including derived capability flags, repository identity, image references, and a canonical copy of the first request.
  - **Transcript:** the ordered record after the first request: model responses, model-visible tool results, re-asks, validator rejections, errors and the stop reason.
- **Logged gateway:** one of the four places where worker code talks to a model provider. Each gateway writes run logs for what passes through it.

## Requirements

### R1. Coverage and logged gateways

**The four gateways.** The worker reaches models four ways, added at different times:

| Gateway | Added | Wraps | Used by |
|---|---|---|---|
| `loggedMessages` | 2026-07-15 | `Anthropic.messages.create`, via the factory in `anthropic-client.ts` | diff judge (`harness/diff-judge.ts:97`), fix judge (`harness/fix-judge.ts:128`), fix narrative (`agent-fix.ts:279`), visual analysis (`visual-analysis.ts:53`), digest writer (`digest-writer/job.ts:560`) |
| logged `ModelPort` decorator | 2026-07-22 | agent-core `ModelPort.generate`, applied in `harness/agent-loop.ts` before `toolLoop` sees the response | fix agent tiers and test retries |
| logged SDK runner | 2026-08-31 | `runReadOnlyAgentSdk` (`harness/sdk-agent.ts:349`): the message stream and the MCP tool handler results | investigation (including the fix job's inline investigation at `agent-fix.ts:544`), friction investigation (with and without ticket), inquiry, product context and route map |
| `NarrativeClient.complete` | 2026-09-01 | logging inside the method, before non-text blocks and request metadata are dropped (`narrative/client.ts:88-110`) | narrate, verify frames, match and first look, confirm and one-fix |

Merging `NarrativeClient` with the raw client would reduce this to three gateways. That is a separate cleanup, not part of this change.

**Run boundaries,** as of `e95d5de`:
- one gateway call per run for SDK runs, the digest writer, narrate, verify, visual analysis, the diff judge and the fix narrative;
- one run per tier and per test retry for the fix agent;
- the whole judge, including its malformed-verdict retry, for the fix judge;
- the `validated()` pair for match and first look;
- the re-call pair for confirm and one-fix.

Phase code opens the run, passes the run handle to the gateway, and closes it.

**Guard.** A repository test fails when a worker source file outside the gateway files does any of the following:
- imports `anthropic-client.ts`;
- imports `@anthropic-ai/sdk` for anything other than types;
- constructs `NarrativeClient` without a run logger;
- imports `query` from `@anthropic-ai/claude-agent-sdk`;
- implements `ModelPort`.

### R2. Run identity

- **ID:** each run gets a `run_id` (UUID v4) in the worker.
- **Execution numbering is not used for identity.** Handlers disagree on it: some use `job.attempts`, others `job.leaseGeneration` (`index.ts:1627`), and `visual_analysis` uses `attempts` on ticket fixes (`index.ts:1595`). Runs store both values as observed.
- **Identifiers stored when in scope,** for querying only (they play no part in retention): `job_id`, `job_type`, `project_id`, `phase`, `error_group_id`, `ticket_id`, `episode_id`, `batch_id`, `session_id`, and repository `commit_sha`.
- **Object prefix:** `agent-runs/<project_id>/<yyyy-mm-dd>/<run_id>/`, where the date is the worker's UTC date at run start. It is chosen once and stored verbatim in the started row.

### R3. `agent_run_started`

Inserted after the input bundle write completes or its deadline passes, and before the first model request.

**Columns:**
- `run_id`, `job_id`, `job_type`, `project_id`, `phase`, `entry_point`
- `attempts`, `lease_generation`
- the identifiers from R2, `object_prefix`
- `models`, `worker_build_sha`
- `bundle_written`, `bundle_bytes`
- `recorded_at` (worker clock)

**Keys and index:** no foreign keys to jobs or sessions; an index on `(project_id, recorded_at)`.

### R4. `agent_run_finished`

Inserted once, in a `finally` around the run, after the transcript write completes or its deadline passes.

**Columns:**
- `run_id` (references the started row `ON DELETE CASCADE`)
- `stop`, one of `completed`, `terminal_tool`, `invalid_output`, `turns_exhausted`, `budget`, `truncated`, `no_tool_call`, `no_evidence`, `api_error`, `machine_lost`, `aborted`, `threw`
- `error_class`, `error_detail` (scrubbed per R7, at most 500 characters)
- `model_requests`, `turns`
- `usage`: per model, input, output, cache-read and cache-write tokens, measured for this run only
- `cost_usd`
- `transcript_written`, `transcript_bytes`

**Usage deltas.** Where usage state is shared across runs, the logger snapshots counters at run start and records the difference. Example: fix test retries keep `agentState.tokenUsage` across `toolLoop` calls (`agent-fix.ts:936`, `tool-loop.ts:96,128`).

**Coverage of throws.** Because the write sits in `finally`, an in-process throw after the model ran still produces a transcript and usage. That includes machine loss (`sdk-agent.ts:482`), lease-loss aborts, inquiry non-terminal stops and product-context early returns.

**Unfinished runs.** `agent_runs_v` reports a started row with no finished row as `stop = 'unfinished'` once the job is no longer claimed with the recorded `lease_generation`. That means the worker process died before `finally` ran, or the finished insert failed; v1 does not tell these apart. An unfinished run has its input bundle, and may have a transcript object if only the row insert failed.

### R5. Input bundle

JSON payloads (bundle and transcript) use camelCase field names, matching the TypeScript types in `@opslane/agent-runs`. The snake_case names below describe the fields; Postgres columns stay snake_case.

`<object_prefix>input.json`, written before the started row, within the deadline in R8.

**Top-level fields:**
- `schema_version`, `run_id`, `phase`, `entry_point`, `worker_build_sha`
- `repository`: provider, owner/name and `commit_sha`, when the phase reads a repository

**`settings`.** The effective values after environment resolution:
- model, max tokens, thinking, temperature, timeouts;
- for agent runs: max turns, budget, max resubmits, allowed and denied tools;
- derived capability flags that change the request's shape:
  - `command_enabled`: whether `run_command` is offered, which depends on a `commandRunner` (`sdk-agent.ts:244-267`);
  - `probe_enabled`: whether the fix judge offers `run_probe`, which depends on anomalies plus a live sandbox (`fix-judge.ts:95-100`);
  - `assets_missing`: the confirmation prompt variant (`confirm.ts:106`).

**`structured_input`.** The argument object of the phase's prompt builder, as plain JSON, in the order passed.
- Readers, command runners, clients, meters, sandboxes and abort signals are omitted; their effect on the request is captured by the capability flags.
- A repository file list is stored as the repository reference and rebuilt from the commit.

**`request`.** A canonical, serializable DTO of the first request.
- Direct API calls: `system`, `messages`, `tools`, `tool_choice` and settings.
- Agent SDK runs: `systemPrompt`, `firstMessage`, tool definitions (name, description, input schema) and the terminal tool.
- Live objects, such as the MCP server handlers built in `buildQueryOptions`, are not part of the DTO.

**`images`.** One reference per image block, in order, each with the SHA-256 of the exact bytes sent:
- Visual analysis: the replay artifact `object_key`. The bytes sent are the object bytes (`index.ts:1580-1589`).
- Verify and confirm frames: a capture recipe of `session_id`, `offset_ms`, `pair` and capture settings. The model receives `modelPng`, which differs from the uploaded full-size `png` (`narrative/verify.ts:256` vs `:275`).

Image bytes are never stored in run logs.

### R6. Transcript

`<object_prefix>transcript.jsonl`, written once at the end of the run, on normal return or throw, within the deadline in R8. Events, in order:

- **`response`,** one per model response:
  - content blocks: text, tool use, and thinking text (empty or encrypted thinking logged as a redacted placeholder; signatures are not stored). Providers report thinking tokens per response, not per block, so the response usage carries `thinking` tokens when reported;
  - `stop_reason`, usage, and the provider request ID when the gateway can read it.

  **Capture per gateway:**
  - The `ModelPort` decorator captures the provider response before agent-core reduces it. agent-core's `ModelResponse` gains an optional `requestId`; it already has `stopReason` (`model-port.ts:63`).
  - `NarrativeClient.complete` captures the full response inside the method.
  - The SDK runner captures assistant messages from the stream.
- **`tool_call`** (name, input) and **`tool_result`**. The result is exactly the string the model received after the tool layer's own redaction (`tool-loop.ts:201-217`, the SDK MCP handlers in `sdk-agent.ts:174-191`), passed through the logger's scrubber (R7). It is not truncated. `is_error` is set as the tool layer sets it.
- **`request`,** only for re-asks inside a retry controller. Follow-up requests in SDK and tool-loop runs are not logged, because they are exactly the first request plus the logged responses and tool results.
- **`validator_rejection`:** `message` and the rejected payload, plus `rule` when the validator reports one. The confirmation validator reports only a catch-all message today (`confirm.ts:139-160`).
- **`sdk_message`:** Agent SDK system and result messages not covered above.
- **`error`:** class, message and the first 10 stack frames.
- **`stop`.**

**Size cap.** A transcript is capped at 20 MB. Past the cap, further events are dropped, and the `stop` event records `transcript_truncated` with the dropped event count.

### R7. Secret scrubbing

Every persisted string passes through the worker's scrubber before it is written: bundle fields, transcript text, tool inputs and results, validator payloads, error details and thinking text.

`scrubSecrets` (`harness/redact.ts`) is extended, with tests, for:
- PEM private key blocks;
- AWS access key IDs;
- `Authorization` headers;
- `KEY=value` and `"key": "value"` pairs whose key names contain `secret`, `token`, `password` or `api_key`.

Scrubbing cannot find arbitrary credentials in a customer repository. That residual risk is the same class of data Opslane already sends to Anthropic, and it is disclosed in `trust.md` (R12). Objects use unique keys per run and are never overwritten.

### R8. Failure handling and deadlines

**Logging failures do not throw into the job.** Every logging step has an end-to-end deadline, enforced with an abort signal that also covers pool acquisition and upload:

| Step | Deadline |
|---|---|
| Bundle write | 5 seconds |
| Started insert, including connection acquisition | 3 seconds |
| Transcript write | 5 seconds |
| Finished insert | 3 seconds |

- The worst-case added time per run is 16 seconds. The default lease is 300 seconds, with a heartbeat every lease/3 (`index.ts:183`, `poller.ts:159-182`).
- The worker disables run logging and logs a warning at startup when `LEASE_DURATION_MS` is below 60 seconds.
- Logging writes still run after the job's abort signal fires, within their own deadlines.

**Diagnostic counters.** Failures increment per-process `agent_run_log_failures{kind}` counters on `/health`. They reset on restart; the done criteria use database and object-store queries instead.

### R9. Retention

One rule for every run, with nothing specific to Opslane's session model. A run log is deleted when it is older than the project's `session_retention_days`, which defaults to 30 and is capped at 90 days by the existing hard cap. A new pass in the Go sweeper does this per project:

1. **List day prefixes.** List the common prefixes under `agent-runs/<project_id>/` with delimiter `/`: one list call per project, returning its day prefixes. `minio/client.go` gains `ListPrefixes` next to `RemovePrefix`.
2. **Remove expired days.** For each day older than the retention days plus one day, call `RemovePrefix`. The extra day absorbs worker/database clock skew. This also removes objects orphaned by failed row inserts.
3. **Delete rows.** Only after that day's `RemovePrefix` succeeds, delete started rows for that project with `recorded_at` in that day; finished rows cascade. A failed removal leaves the rows for the next pass.

**Accepted consequence.** A run log that contains session-derived text (narrate, verify, confirm, match, friction investigation) is deleted by the run's age, not the session's. It can outlive the session recording it came from by up to one retention period. This is disclosed (R12).

**Row triggers.** Both tables reject UPDATE with a row trigger and TRUNCATE with a statement trigger. This differs from the `043_job_usage_ledger.sql` idiom, which also rejects DELETE (`043:42-45`); DELETE stays allowed for retention and cascades.

### R10. Package boundary

`packages/agent-runs` (`@opslane/agent-runs`) exports:
- schema types, and strict runtime validators for the payloads readers consume: input bundles and transcript events (rows are produced in-process and constrained by the database);
- the object-prefix function;
- `RunLogger`, an in-memory transcript builder with the usage-delta helper;
- adapters from Agent SDK messages and from agent-core model responses and tool results to transcript events.

It performs no I/O and has no scrubber of its own; the worker injects the scrubber. A package test walks its sources and fails on imports of `@opslane/worker`, `pg`, `@aws-sdk/*`, `e2b`, or paths outside the package. The repository has no ESLint config; this follows the source-walking test pattern in `packages/dashboard/src/*.test.ts`.

**Worker-side changes:**
- the four gateways and phase run handles;
- `minio-client.ts` gains `putObject(key, body, contentType, signal)`;
- rows are written through `db.ts`;
- `packages/worker/Dockerfile` copies and builds `packages/agent-runs`;
- the image build passes an `OPSLANE_BUILD_SHA` build argument into the worker environment, and bundles record it (`unknown` when unset). It cannot be added to past run logs, so it ships now even though the production verify command does not.

### R11. Read path and rebuild tests

- **SQL:** a view `agent_runs_v` joins started and finished rows and derives `stop = 'unfinished'`.
- **`packages/worker/scripts/agent-runs.ts show <object_prefix>`:** reads only object storage and prints the bundle summary, the first request and the transcript as text. Tool results are cut on screen, with a flag to print them in full.
- **Rebuild tests in CI:** every phase's prompt builder is a named pure function of `structured_input` plus `settings`.
  - Two phases build prompts inline today and are extracted: `friction/confirm.ts:106` and `visual-analysis.ts:56`.
  - Phases whose user message or tool list is assembled inline move that assembly into named builders: diff judge, fix judge, fix narrative, digest user payload, match, first look, one-fix.
  - For each phase, a test builds a request from a committed fixture and logs it through the run logger into an in-memory sink. It then rebuilds from the bundle's `structured_input` and `settings`, with image bytes resolved from fixture references, and asserts canonical structural equality with `request` (object keys sorted, image bytes replaced by references).

### R12. Documentation

- **`docs/architecture/trust.md`** gains a section on run logs:
  - what they contain: prompts, code excerpts, full tool output, session-derived timelines and signals, model output;
  - that secrets are scrubbed on a best-effort basis;
  - where they are stored and how long they live.
- **`docs/guides/replay-privacy.md`:**
  - "How long recordings live" states that run logs derived from a session recording follow the project retention setting counted from the run, so they can outlive the recording by up to one retention period.
  - The end-user notice template is updated to cover derived diagnostic records.
- **`CONTEXT.md`** gains **Run**, **Run log**, **Input bundle**, **Transcript** and **Logged gateway**.

## Done when

1. **Static coverage.** The R1 guard test passes, so no worker code reaches a model outside a gateway.
2. **Runtime coverage,** in a 72-hour production window:
   - At least 99% of terminal jobs of model-calling types that have a `job_usage` row also have at least one started run.
   - Every terminal job of a model-calling type with neither usage nor runs is listed and checked by hand to have made no model call.
   - Of started rows whose job is terminal, at most 1% are `unfinished`.
3. **Rebuild tests.** The CI rebuild test passes for every phase in R1.
4. **Explainability.** For three failed runs from the window (a dead letter, an `invalid_output`, and a thrown or unfinished run where available), `show` alone explains why each failed, or for an unfinished run, what input it had.
5. **Retention.** A local stack test shows the retention pass deleting objects and rows for an expired day prefix, including an orphaned object with no row.

## Decisions

- **D1. Log first, analyze later.** Checks can run over stored transcripts later, and replay adapters can be written later against stored bundles. Capture is the only part that cannot be backfilled, so v1 is capture only.
- **D2. Every model-calling phase, not a sample.** Coverage is what makes this useful. A phase left out now can never be analyzed for the period it was skipped.
- **D3. Two insert-only rows per run, transcript written once.** Per-turn appends were rejected as more machinery than v1 needs. Only process death or a failed finished insert leaves a run unfinished.
- **D4. Best-effort writes with deadlines.** This follows ADR-0001's reasoning for `job_usage`. Run logging is diagnostic infrastructure and must not become a new way for jobs to fail.
- **D5. Save structured input, settings and a canonical first request.** Replaying only the exact request cannot test prompt-builder changes. Saving only structured input cannot tell model variance from builder drift, and cannot recover request shape that depends on live capabilities.
- **D6. Images by reference and hash.** Bytes stay out of run logs. A replay must re-fetch or re-render them, compare hashes, and report drift.
- **D7. Object storage for payloads, Postgres for the index.** Reading a run log needs only object storage credentials. That avoids the 64 KiB output cap on `prod-sql.sh`.
- **D8. One storage layout, deleted by run age.**
  - Tying run logs to session lifetimes would build Opslane's session concept into the storage design, which does not carry over to other agent apps.
  - Opslane has no early session deletion today: only the retention sweeper calls `MarkSessionDeleting` (`retention/retention.go:89`).
  - The cost is that derived run logs can outlive a session recording by up to one retention period, which is disclosed.
- **D9. Log at four gateways, not per call site.** Every future model call is logged automatically, and the guard test stops a fifth path appearing. This is also the shape a customer integration would take: wrap the model client or the agent framework's model and tool layer once.
- **D10. Isolated package.** Run log types and adapters live in `@opslane/agent-runs` with no I/O. The worker owns gateways, capture, storage and retention.
- **D11. Log what the model read, in full.** A 4 KB cap discards exactly the content that explains the model's next move, and re-executing tools later is not deterministic. This reverses the earlier 4 KB decision.
- **D12. A run spans its retry controller.** A run matches what the job was trying to do, not how many API calls it took. Both attempts and their rejections sit in one log.
- **D13. Rebuild tests in CI now; production verification later.** CI fixtures catch builder inputs we forgot to save. Checking real production bundles against their recorded worker version matters only once replay exists, so it is the first follow-up. `OPSLANE_BUILD_SHA` ships now because it cannot be backfilled.

## Non-goals

- Mechanical checks (stop category, cited-not-read, empty search where files exist, cited code outside the screen's app).
- Replay tooling, and the production `verify` command. That command is the first follow-up, before replay.
- A dashboard page for runs or failure signatures.
- Exporting runs as OpenTelemetry GenAI spans to Langfuse.
- Merging `NarrativeClient` and the raw Anthropic client into one gateway (separate cleanup).
- Named validator rules, and fixing the defects above (tree truncation, search include parsing).
- Deleting run logs together with the session recordings they derive from.
- Telling a dead process apart from a failed finished insert.
- Pinning runs past retention, or curated long-lived datasets.
- Logging OpenAI embedding calls, which produce vectors rather than reasoning.
- The onboarding agent in `agent_sessions`, which already stores its own steps.
- Encrypting objects beyond what the deployment's object store already provides.

## Review log

### Codex round 1 (2026-09-15): verdict "reject as written", 21 findings

**Accepted and changed:**

| # | Finding | Change |
|---|---|---|
| 1 | A crashed run has no transcript. | Transcript and finished row written in `finally`. |
| 2, 3, 16 | Best-effort writes orphan objects; date-derived prefixes can miss. | Prefix stored verbatim; objects deleted by day prefix. |
| 5 | The re-ask boundary didn't match the code. | Run boundary at the retry controllers. |
| 6 | agent-core drops response metadata. | `requestId` added. |
| 7 | The verify frame reference pointed at different bytes. | Recipe plus hash of `modelPng`. |
| 9 | Rule names don't exist yet. | `rule` optional. |
| 10 | Secrets could persist. | Every persisted string scrubbed; scrubber extended. |
| 11 | Fix job's inline investigation missing. | Added. |
| 13 | Fix usage wrong across test retries. | Usage deltas. |
| 14, 15 | Byte-for-byte can't hold; settings missing. | Canonical DTO; effective settings and repository identity. |
| 17 | Dockerfile work missing. | Dockerfile and `OPSLANE_BUILD_SHA`. |
| 18 | Health counters are per process. | Diagnostics only. |
| 19 | Logging adds latency. | Deadlines. |
| 20 | Trigger idiom misdescribed. | UPDATE and TRUNCATE rejected, DELETE allowed. |

**Superseded later:** #4 (4 KB tool results), #8 (session nesting) and #12 (import confinement), all changed again below.

**Declined:** #21, "not recording-only" (see the owner alignment grill).

### Codex round 2 (2026-09-15): verdict "needs another revision", 13 findings

**Accepted and changed:**

| # | Finding | Change |
|---|---|---|
| 1 | A missing finished row isn't always process death. | `unfinished` state; goal scoped to runs with a finished log. |
| 2 | 4 KB tool results can't explain the model. | Full tool results with a 20 MB transcript cap (D11). |
| 3, 4 | Session-scoped deletion races; session provenance incomplete. | Superseded by one age-based layout (D8). |
| 5 | Tool-loop events can't produce response records. | `ModelPort` decorator. |
| 6 | `NarrativeClient` drops thinking and request metadata. | Logging inside `NarrativeClient.complete`. |
| 7 | Confinement missed the client factory. | Four logged gateways plus a guard on factory, SDK and `ModelPort` imports (D9). |
| 8 | Sweep unspecified; deletion order ambiguous. | One delimited list per project; rows deleted after `RemovePrefix` succeeds. |
| 9 | Deadlines didn't cover pool acquisition. | End-to-end deadlines; logging disabled below a 60-second lease. |
| 10 | `parent_run_id` didn't match the code. | Removed; `batch_id` added. |
| 11 | `job_usage` isn't a sufficient coverage denominator. | Static guard plus runtime cross-check. |
| 12 | Rebuild can't recover capability-dependent request shape. | Capability flags in `settings`. |

**Resolved in the owner alignment grill:** #13, overcomplexity.

### Owner alignment grill after Codex (2026-09-15)

| Question | Decision |
|---|---|
| Keep the package and production verify (Codex round 2 #13)? | Package kept. Production `verify` cut to the first follow-up; CI rebuild tests stay; `OPSLANE_BUILD_SHA` still recorded (D13). |
| Session-nested storage for session-derived runs, or one layout? | One age-based layout (D8). Derived logs may outlive a session recording by one retention period, disclosed. Early session deletion does not exist today. |
| Naming | "Run logs" for this feature; "recording" is reserved for session replay. |
| Privacy notice | Docs and the notice template updated as part of the change (R12); no wording review needed. |
| Four gateways or per call site? | Four gateways plus the guard (D9). Merging `NarrativeClient` with the raw client is a separate cleanup. |
| Full tool results or 4 KB? | Full, with a 20 MB cap (D11), reversing the earlier 4 KB decision. |
| Re-ask: one run or two? | One run spanning the retry controller (D12). |
