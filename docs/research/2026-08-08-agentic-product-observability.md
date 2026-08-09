# How open-source agentic products do logging/observability

Date: 2026-08-08. Sources are primary only: repository source at stated commits, official docs, and first-party engineering blogs. Where a claim could not be verified against a primary source, that is stated explicitly.

Commits/refs used:

- `simstudioai/sim` @ `16e0a2b35fad580d36dd2cbf489553a8f877ce42` (shallow clone of `main`, 2026-08-08)
- `open-telemetry/semantic-conventions-genai` @ `1d85c963ea51e9c7d24cc330ff67057f6e90e6c5`
- `PostHog/posthog.com` @ `f7a425bda01f0cd401f32d347aaa638234fe43be` (docs content), plus rendered docs pages and the `PostHog/posthog` onboarding snippets they embed

## Summary

- **sim.ai** persists every workflow run as a first-class Postgres row (`workflow_execution_logs`) with a hand-rolled hierarchical `TraceSpan` JSON tree (blocks, tools, model iterations), per-span tokens/model/cost, and a **separate append-only cost ledger** (`usage_log`) whose per-run sum is projected back onto the run row as a write-once `cost_total` column for cheap list/filter/sort. OTel is used for anonymous product telemetry and optional self-hosted export, not as the system of record.
- **PostHog** models AI observability as ordinary analytics events — `$ai_generation`, `$ai_span`, `$ai_trace`, `$ai_embedding` — glued by `$ai_trace_id`/`$ai_span_id`/`$ai_parent_id`/`$ai_session_id` properties, so LLM data composes with product analytics, error tracking (link exceptions via `$ai_trace_id`), session replay, and surveys (thumbs up/down wired to traces). Cost is computed server-side per event into `$ai_total_cost_usd` from OpenRouter pricing.
- **The field converges** on: per-run trace trees with tool spans (OTel GenAI semconv now standardizes `invoke_agent` / `execute_tool` / `chat` spans and `gen_ai.usage.*` token attributes — still status "Development"); token/cost accounting *persisted in the product DB*, not trace-only, once billing or cost dashboards matter; outcome + feedback signals attached to traces (Langfuse scores, PostHog surveys); and systematic human review of production traces (PostHog's weekly "Traces Hour", Anthropic's full production tracing) over eval-only workflows.

---

## 1. sim.ai (Sim Studio)

Sim is an Apache-visible open-source agent workflow builder (Next.js app in `apps/sim`, Drizzle/Postgres schema in `packages/db`). All paths below are relative to the repo root at commit `16e0a2b`.

### What is stored per run

Two tables anchor run persistence, both in `packages/db/schema.ts`:

- **`workflow_execution_snapshots`** (lines 373–391): content-addressed snapshot of the workflow definition at execution time — `state_hash` + `state_data` jsonb, deduplicated by a unique `(workflow_id, state_hash)` index. Every run points at the exact workflow version that ran.
- **`workflow_execution_logs`** (lines 393–487): one row per run, unique on `execution_id`. Columns:
  - Identity/lineage: `workflow_id`, `workspace_id`, `execution_id`, `state_snapshot_id`, `deployment_version_id`.
  - Status model: `level` (`'info' | 'error'`), `status` (`'running' | 'pending' | 'completed' | 'failed' | 'cancelled'`), `trigger` (`'api' | 'webhook' | 'schedule' | 'manual' | 'chat'`) — all commented inline at lines 410–412.
  - Timing: `started_at`, `ended_at`, `total_duration_ms`, plus `execution_deadline_at` ("absolute deadline for the current active attempt", line 415) backing a watchdog via partial index `workflow_execution_logs_running_deadline_idx` on `status = 'running'` rows (lines 480–482).
  - **`execution_data` jsonb**: the trace payload — `traceSpans`, `finalOutput`, `workflowInput`, `executionState`, error details, token/model rollups. Heavy payloads are externalized to object storage and replaced by a `traceStoreRef` pointer with inline markers (`hasTraceSpans`, `traceSpanCount`, truncation flags) — documented in the column comment at lines 420–429 and implemented in `apps/sim/lib/logs/execution/trace-store.ts` (`externalizeExecutionData`, line 104).
  - **Cost**: `cost` jsonb is explicitly `@deprecated` — "cost lives in usage_log + the `cost_total` projection" (line 431). `cost_total` decimal is a "faithful, write-once projection of the run's usage_log ledger sum (dollars) … never an independently-computed value (cost_total == SUM(usage_log) for the run)" (lines 433–436). `models_used text[]` (line 438) exists purely to power the model filter, with a GIN index (line 471).
  - Query-shaped indexes: composite `(workspace_id, started_at DESC, id DESC)` for list pagination, `(workspace_id, cost_total)` for cost sort/filter, partial indexes for running/completed states (lines 460–487).

### Trace/span schema

Hand-rolled, not OTel. `TraceSpan` in `apps/sim/lib/logs/types.ts` (lines 224–270): recursive `children`, `type` (block type; tool invocations are children with `type: 'tool'` — the flat `toolCalls` array is deprecated, lines 232–236), `status: 'success' | 'error'`, `tokens`, `model`, per-span `cost {input, output, total, toolCost}`, `providerTiming` with streaming segments, loop/parallel iteration context (`loopId`, `parallelId`, `iterationIndex`), and for model spans the assistant's `thinking` text and requested tool calls correlated by provider `tool_call.id` (lines 262–270). `ToolCall` (lines 39–48) carries name, duration, start/end, status, input/output, error. The run-level rollup in `WorkflowExecutionLog.executionData` includes `tokens {input, output, total}` and a per-model breakdown `models[model].{input, output, total, tokens}` (lines 148–158).

Span construction lives in `apps/sim/lib/logs/execution/trace-spans/` (`span-factory.ts`, `iteration-grouping.ts`); PII/secret handling is a first-class pipeline stage — `pii-redaction.ts`, `pii-large-values.ts`, and `trace-secret-projection.ts` mask secret values resolved during execution before persistence or display (also surfaced in docs: "Exact secret values activated by a successful `{{KEY}}` substitution are masked in this trace view", `apps/docs/content/docs/en/logs-debugging/logging.mdx`).

### Write path

`LoggingSession` (`apps/sim/lib/logs/execution/logging-session.ts`, class at line 198) writes the run row **at start** (`start()` line 750 → `executionLogger.startWorkflowExecution`, creating the `status='running'` row with trigger + environment + snapshot), and finalizes on `complete()` / `safeCompleteWithError()` (lines 828, 1376) with distinct `finalizationPath` values (`completed`, `fallback_completed`, `force_failed`, `cancelled`, `paused` — `types.ts` lines 78–84). Live rows are what the UI's "Live mode" streams from. Billing "reconciles from the usage_log ledger" on resume (comment at line 807).

### Cost ledger

`usage_log` (`packages/db/schema.ts`, lines 3521–3590): append-only, one row per billable event with `category` enum (model usage, knowledge-base, voice, enrichment…), `source`, `cost` decimal, idempotency `event_key` (unique partial index), billing entity/period columns, and back-references `workspace_id`/`workflow_id`/`execution_id`. Covering indexes are tuned for billing-period aggregation (extensive comment, lines 3566–3582). Legacy per-user usage counters on the user table are deprecated in favor of deriving from this ledger (lines 1025–1037).

### OTel usage

OTel is present but **not the persistence layer**:

- `apps/sim/lib/core/telemetry.ts` converts the hand-rolled TraceSpans/BlockLogs into OTel spans with GenAI semantic-convention attributes (`gen_ai.system`, `gen_ai.usage.input_tokens`, `gen_ai.agent.*`, `gen_ai.tool.name`, plus custom `gen_ai.workflow.*` extensions) — header comment: "This module converts TraceSpans -> OpenTelemetry Spans".
- `telemetry.config.ts` ships **enabled-by-default anonymous product telemetry** to `https://telemetry.simstudio.ai/v1/traces` (OTLP), opt-out via UI toggle or `NEXT_TELEMETRY_DISABLED=1`, with an explicit never-collect list (workflow content/outputs, keys, IPs) and a pointer for forks to send to their own collector. Sampling: "Error rates (always captured), Performance metrics (sampled at 10%), AI/LLM operation traces (always captured for workflows)".
- Full OTel SDK deps (`@opentelemetry/sdk-node`, OTLP trace/metrics/logs exporters) in `apps/sim/package.json` lines 82–91; Next.js `instrumentation-node.ts` wires it up.

### Product exposure

- **Logs page** per workspace (`apps/sim/app/workspace/[workspaceId]/logs/`): every run from every trigger, filtered by time range, status, trigger type, folder, workflow; full-text search; "Live mode" streaming; click-through to a sidebar with the run timeline and per-block input/output (docs: `apps/docs/content/docs/en/logs-debugging/logging.mdx`). Query layer in `apps/sim/lib/logs/` (`list-logs.ts`, `query-parser.ts`, `filters.ts`, `log-views.ts`).
- **Real-time Console** in the editor for the run being watched (same doc).
- Public **logs API** (`apps/sim/app/api/v1/logs/`) and per-user usage endpoint (`apps/sim/app/api/users/me/usage-logs/`); enterprise **audit logs** (`apps/sim/ee/audit-logs/`, `apps/sim/app/api/v1/audit-logs/`).
- Cost surfaces in the logs list via the `cost_total` projection + index rather than live aggregation (schema comment, lines 433–436).

**Takeaway**: sim treats run logs as an operational product table (status machine, deadline watchdog, pagination indexes), keeps the trace tree as a jsonb/object-storage document, and keeps money in a separate idempotent ledger with a denormalized per-run sum — exactly the "persist cost, don't leave it trace-only" pattern.

---

## 2. PostHog LLM observability ("AI Observability")

Docs live under `posthog.com/docs/ai-observability/` (repo path `contents/docs/ai-observability/` in `PostHog/posthog.com` @ `f7a425b`; property tables are embedded from `PostHog/posthog` `docs/onboarding/ai-observability/_snippets/*.tsx`).

### Event model — analytics events, not OTel

Everything is a PostHog event with `$ai_*` properties; the trace view is reconstructed from events:

- **`$ai_generation`** — one LLM call ("A generation is a single call to an LLM", `generation-event.tsx`). Core properties: `$ai_trace_id` (required grouping ID), `$ai_session_id` (optional, groups traces), `$ai_span_id`, `$ai_span_name`, `$ai_parent_id` (tree structure), `$ai_model`, `$ai_provider`, `$ai_input`, `$ai_input_tokens`, `$ai_output_choices`, `$ai_output_tokens`, `$ai_latency` (seconds), `$ai_time_to_first_token` (streaming), `$ai_tools`, `$ai_total_cost_usd` (`notable-generation-properties.tsx`; also https://posthog.com/docs/ai-observability/generations).
- **`$ai_span`** — "a single action within your application, such as a function call or vector database search"; properties `$ai_trace_id`, `$ai_span_id`, `$ai_span_name` (examples: `vector_search`, `data_retrieval`, `tool_call`), `$ai_parent_id` ("trace_id or another span_id"), `$ai_input_state` / `$ai_output_state` (any JSON-serializable state) (`span-event.tsx`).
- **`$ai_trace`** — top-level grouping; "can be manually sent as events or appear as pseudo-events automatically created from child events"; properties `$ai_trace_id`, `$ai_session_id`, `$ai_input_state`, `$ai_output_state`, `$ai_latency` (`trace-event.tsx`; hierarchy diagram in https://posthog.com/docs/ai-observability/traces).
- **`$ai_embedding`** for embedding calls; the manual-capture docs also list `$ai_metric` and `$ai_feedback` event types (https://posthog.com/docs/llm-analytics/manual-capture).
- Hierarchy: session (`$ai_session_id`, optional) → trace (`$ai_trace_id`, required on all AI events) → spans (nestable) → generations (traces doc, "AI event hierarchy" section). Sessions are deliberately free-form: "whatever grouping makes sense for your application (user sessions, workflows, conversations…)" (https://posthog.com/docs/ai-observability/sessions).

SDK wrappers (e.g. `@posthog/ai` wrapping the OpenAI client) autocapture these and accept `posthogDistinctId`, `posthogTraceId`, `posthogProperties`, `posthogGroups`, `posthogPrivacyMode` per call (generations doc code sample).

### Cost tracking

Server-side, per event, into `$ai_total_cost_usd` (https://posthog.com/docs/ai-observability/calculating-costs):

- Pricing matched from **OpenRouter's pricing data** via `$ai_provider` + `$ai_model`, with a manually maintained fallback DB.
- Components: token costs, cache read/write, per-request, per-web-search, reasoning tokens.
- Cache-token accounting is provider-aware — Anthropic counts cache tokens *exclusive* of `$ai_input_tokens`, OpenAI *inclusive* — auto-detected, overridable via `$ai_cache_reporting_exclusive`, and the resolved value is written back onto the event.
- Custom pricing overrides: `$ai_input_token_price`, `$ai_output_token_price`, `$ai_cache_read_token_price`, `$ai_cache_write_token_price`, `$ai_request_price`, `$ai_web_search_price`.

### Product surface and cross-product glue

- **AI Observability dashboard** out of the box: Users, Traces, Costs, Generations, Latency, answering "Are users using our LLM-powered features? What are my LLM costs by customer, model, and in total? Are generations erroring? … latency spikes?" (`contents/docs/ai-observability/dashboard.md`).
- **Trace timeline** with waterfall (latency breakdown, concurrency lanes, red-bordered errored ops) (traces doc).
- **Error tracking link**: capture exceptions with `$ai_trace_id` attached → click from an error to the full LLM trace; alert on LLM error rates by model/prompt version/user segment (https://posthog.com/docs/ai-observability/link-error-tracking).
- **User feedback**: native Surveys integration — thumbs up/down attached to a trace by sending survey events carrying `$ai_trace_id`; React `useThumbSurvey` hook; per-trace Feedback tab and aggregated survey metrics (https://posthog.com/docs/ai-observability/collect-user-feedback, beta as of 2026-02).
- Evals (LLM-as-judge scoring of generations) and local-model sentiment classification of user messages run against production traces (generations doc, "Evaluating generations"/"Sentiment classification").

### How PostHog instruments its own agent (Max / "PostHog AI")

First-party sources:

- Handbook ("AI/LLM Observability" use-case page, https://posthog.com/handbook/growth/use-case-selling/ai-llm-observability): they used LLM analytics while building Max "to keep an eye on operational costs to find sustainable pricing", then "monitored traces to see how Max was being used and gather feedback"; the connection of traces to person profiles and session replay is called out as the key advantage.
- Blog "8 learnings from 1 year of agents – PostHog AI" (https://posthog.com/blog/8-learnings-from-1-year-of-agents-posthog-ai): weekly **"Traces Hour"** reviewing production traces; verdict that evals alone are insufficient for multi-step agent tasks; streaming every tool call and reasoning token to users because hiding process destroyed trust; Claude Sonnet 4.5 chosen for the core loop on quality/speed/cost.
- The positioning docs state the combination explicitly: "Error Tracking catches model failures, Session Replay shows the user experience, and Product Analytics measures business impact" (per posthog.com AI observability marketing/docs; same framing in the handbook page above).

**Takeaway**: PostHog's bet is that agent telemetry should live in the same event store as product analytics so cost-per-customer, feedback, errors, and behavior are one query surface — the opposite pole from OTel-first architectures, and the pattern most relevant to a product dashboard.

---

## 3. Broader patterns

### OpenTelemetry GenAI semantic conventions (the emerging neutral standard)

Now maintained in `open-telemetry/semantic-conventions-genai` (moved off opentelemetry.io; the old pages redirect). All GenAI conventions are **Status: Development**, i.e. not yet stable (`docs/gen-ai/gen-ai-spans.md` line 7 @ `1d85c96`). Key shapes:

- **Inference spans** named `{gen_ai.operation.name} {gen_ai.request.model}` (e.g. `chat gpt-4`); required `gen_ai.operation.name` (`chat`, `generate_content`, `text_completion`…) and `gen_ai.provider.name`; conditionally required `error.type`, `gen_ai.conversation.id`, `gen_ai.request.model`; recommended `gen_ai.response.model`, `gen_ai.response.finish_reasons`, and token usage `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, `gen_ai.usage.reasoning.output_tokens` (`docs/gen-ai/gen-ai-spans.md` lines 53–95). Prompt-management attributes exist (`gen_ai.prompt.name` / `gen_ai.prompt.version`).
- **Agent spans** (`docs/gen-ai/gen-ai-agent-spans.md`): `create_agent {gen_ai.agent.name}` and `invoke_agent {gen_ai.agent.name}` with `gen_ai.agent.id/name/description/version`.
- **Tool spans**: `execute_tool {gen_ai.tool.name}`, span kind INTERNAL, required `gen_ai.tool.name`, recommended `gen_ai.tool.call.id`; "Application developers are encouraged to follow this semantic convention for tools invoked by their own code" (`docs/gen-ai/gen-ai-spans.md`, "Execute tool span", lines ~1061–1098).
- **Metrics** (`docs/gen-ai/gen-ai-metrics.md`): client histograms `gen_ai.client.token.usage` (`{token}`), `gen_ai.client.operation.duration` (s), `gen_ai.client.operation.time_to_first_chunk`, `time_per_output_chunk`; server-side `gen_ai.server.request.duration`, `time_per_output_token`, `time_to_first_token`.
- **Events** (`docs/gen-ai/gen-ai-events.md`): `gen_ai.client.inference.operation.details` (full inputs/outputs off the span) and — notably — `gen_ai.evaluation.result`, standardizing eval scores as telemetry.
- Content capture guidance: full prompts/outputs either on span attributes or **uploaded to external storage with a reference** (`gen-ai-spans.md`, "Capturing instructions, inputs, and outputs") — the same externalization move sim made independently.

### Langfuse data model (what Opslane already uses)

- Hierarchy: `trace` = "a single request or operation"; **observations** = "the individual steps of your application: LLM calls, tool calls, retrieval steps… can be nested"; traces optionally group into **sessions** ("group traces that are part of the same user interaction"); traces carry `user_id`, `session_id`, `tags`, `metadata`, environment, release/version (https://langfuse.com/docs/observability/data-model).
- Observation types: `event`, `span`, `generation`, plus agentic types `agent`, `tool`, `chain`, `retriever`, `evaluator`, `embedding`, `guardrail` (https://langfuse.com/docs/observability/features/observation-types).
- Usage/cost on `generation`/`embedding` observations: `usage_details` ("number of units consumed per usage type" — flexible keys like `input`, `output`, `cached_tokens`) and `cost_details` ("USD cost per usage type"); "ingested usage and cost are prioritized over inferred"; inference falls back to tokenizers + model pricing definitions; usage types must be mutually exclusive buckets (https://langfuse.com/docs/observability/features/token-and-cost-tracking).
- **Scores**: data types `NUMERIC`, `CATEGORICAL`, `BOOLEAN`, `TEXT`; `source` is `API`, `EVAL`, or `ANNOTATION`; optional `ScoreConfig` schema (`minValue`/`maxValue`/`categories`, referenced by `configId`); each score attaches to exactly one of `traceId`, `observationId`, `sessionId`, or `datasetRunId` (https://langfuse.com/docs/evaluation/scores/data-model). Dataset runs link dataset items to production-shaped traces ("DatasetRunItems reference TraceIDs directly", https://langfuse.com/docs/evaluation/dataset-runs/data-model) — this is the standard mechanism for wiring evals and user feedback to traces without new infrastructure.

### Production-agent engineering blogs (first-party)

- **Anthropic, "How we built our multi-agent research system"** (https://www.anthropic.com/engineering/multi-agent-research-system): "Adding full production tracing let us diagnose why agents failed and fix issues systematically"; "Beyond standard observability, we monitor agent decision patterns and interaction structures" (without logging conversation contents); LLM-as-judge rubric scoring (factual accuracy, citation accuracy, completeness, source quality, tool efficiency); and on BrowseComp, "token usage by itself explains 80% of the variance" in performance, with tool-call count and model choice the other factors — i.e. token accounting is a *performance* signal, not just a cost signal.
- **PostHog, "8 learnings from 1 year of agents"** (cited above): weekly human trace review beats eval-only loops for multi-step agents; stream tool calls/reasoning for trust.
- **PostHog handbook** (cited above): cost monitoring drove pricing; trace↔replay↔person linkage drove product decisions for Max.
- Not verified from primary sources: internal observability practices at Cursor, Sierra, or Dust — no sufficiently specific first-party engineering write-up on their logging schemas was located in this pass, so no claims are made about them.

### Where practices diverge

- **Analytics-events-first (PostHog)** vs **trace-store-first (Langfuse, OTel)** vs **product-DB-first (sim)**. PostHog optimizes for querying agent data next to user behavior; Langfuse/OTel optimize for deep trace inspection and evals; sim optimizes for an in-product logs page and billing. Mature setups run two of the three and join on a shared run/trace ID.
- **Cost**: everyone computes tokens on the LLM span, but products that show cost in-app (sim, PostHog) *persist* a queryable per-run/per-event USD figure (sim's `cost_total` projection; PostHog's `$ai_total_cost_usd`) rather than aggregating from traces at read time. Idempotent ledger + denormalized sum is sim's answer; server-side pricing enrichment is PostHog's.
- **Feedback/outcomes**: PostHog attaches survey responses to `$ai_trace_id`; Langfuse models it as `ANNOTATION`/`API` scores on traces; OTel now has `gen_ai.evaluation.result`. All three converge on "outcome signals must reference the trace ID".
- **Self-error-tracking**: PostHog explicitly links agent exceptions to traces via `$ai_trace_id` in its error-tracking product; sim distinguishes run-level `level='error'` + `errorDetails{blockId, error, stackTrace}` in `execution_data` (`apps/sim/lib/logs/types.ts` lines 172–177) from infra logs.

---

## Implications for Opslane

Current state (for grounding): Langfuse tracing is live (process-job root spans, tool spans, Anthropic generations); structured JSON logs go to CloudWatch; the admin dashboard reads Postgres outcome tables (`diagnosis_decisions`, `pr_outcomes`). Gaps: cost/tokens computed but Langfuse-only; no self-error-tracking/dogfooding; no product analytics events; `job_type` missing from job lifecycle logs.

Recommendations, ordered by leverage:

1. **Persist cost/tokens to Postgres per job, ledger-style.** This is the clearest convergent pattern: sim keeps an append-only `usage_log` (with idempotency `event_key`) and projects a write-once `cost_total` + `models_used` onto the run row for list-page filter/sort (`packages/db/schema.ts` lines 431–438, 3521+); PostHog persists `$ai_total_cost_usd` per event. For Opslane: add `cost_total_usd`, `input_tokens`, `output_tokens`, `models_used` columns (or a small `job_usage` ledger keyed by `job_id` + Langfuse trace ID) written at job finalization. Keep Langfuse as the drill-down, Postgres as the queryable rollup — same split sim uses between trace jsonb and `cost_total`. Follow the OTel token buckets (`input_tokens` inclusive of cache reads, separate `cache_read`/`cache_creation`/`reasoning` if tracked) so numbers stay comparable.
2. **Add product/outcome analytics events keyed by trace ID.** PostHog's whole design says: emit a small set of typed events (`job_completed`, `pr_opened`, `pr_merged`, `needs_human`, `diagnosis_rejected`, `dashboard_viewed`…) with `trace_id`, `job_type`, `org/repo`, status, duration, and cost, into whatever store the dashboard can query (Postgres table is fine; a PostHog project is the low-effort alternative). The existing `diagnosis_decisions` / `pr_outcomes` tables are already half of this — the missing piece is user-behavior events (does anyone open the incident? act on the PR?) and a uniform event envelope joining them to traces.
3. **Wire outcome/feedback signals into Langfuse as scores — it's already paid for.** Langfuse scores attach to exactly one of `traceId`/`observationId`/`sessionId`/`datasetRunId` with `source` `API`/`EVAL`/`ANNOTATION`. Push `pr_outcomes` (merged/closed) and `diagnosis_decisions` (accepted/rejected) as `BOOLEAN`/`CATEGORICAL` scores on the process-job trace at decision time. That makes acceptance rate filterable in Langfuse next to cost/latency, and makes production traces directly usable as eval datasets (`DatasetRunItems reference TraceIDs directly`).
4. **Dogfood: self-error-tracking with trace linkage.** PostHog's pattern is exact: capture worker/ingestion exceptions as first-class error events carrying the trace ID so an agent failure links to its run. Opslane *is* an error tracker — point the browser SDK/server reporting at the Opslane dashboard itself, and include `trace_id` + `job_id` in the error payload the way PostHog includes `$ai_trace_id` on exceptions.
5. **Fix `job_type` in job lifecycle logs, and treat the job row as the run row.** sim's `workflow_execution_logs` shows the target shape for an operational run table: status enum, trigger/type, started/ended/duration, deadline column with a partial index for watchdogging, and pagination/cost indexes. Opslane's jobs table already plays this role; adding `job_type` to every lifecycle log line (and the trace ID to the job row if not present) is the cheap prerequisite for all of the above joins.
6. **Don't adopt OTel GenAI semconv as a system of record yet.** Everything gen_ai.* is still status "Development"; sim uses OTel only for opt-in export/telemetry, and Langfuse already speaks OTel ingestion. Borrow the *vocabulary* (`invoke_agent`/`execute_tool` naming, `gen_ai.usage.*` token semantics, `gen_ai.evaluation.result` for outcomes) in span names/metadata so a future OTel export is mechanical, but keep Langfuse + Postgres as the stores.
7. **Institutionalize trace review.** The strongest non-schema finding: PostHog's weekly "Traces Hour" and Anthropic's decision-pattern monitoring both treat human review of production traces as the primary quality loop for multi-step agents, with evals as a supplement. Cheap to start once outcome scores (rec 3) make "failed/rejected runs this week" a one-click Langfuse filter.
