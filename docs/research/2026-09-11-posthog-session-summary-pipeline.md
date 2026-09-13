# PostHog: from raw session recordings to grouped issues (session summaries, Replay Vision, Signals, self-driving)

Date: 2026-09-11
Location: `docs/research/`, following the dated-note convention used by `2026-08-09-session-bucketing-competitive-notes.md`.

Scope: how PostHog turns a single session recording into LLM observations, how observations from many sessions become "patterns" or "reports", what identity those units have, how they bound sampling bias, how the analogous error-tracking grouping works, and how detected issues feed the "self-driving" agent loop. Primary sources only: the `PostHog/posthog` repository (file paths below are repo paths; legacy paths are pinned to the last commit that contained them), `posthog.com/docs`, and PostHog's own blog/changelog. Prompt text is quoted verbatim.

Important framing: PostHog has shipped **two generations** of this pipeline, and only the second is live.

- **Legacy "session summaries" (`ee/hogai/session_summaries`)**: event-table-in, YAML-out single-session summaries with a closed 3-flag issue taxonomy, plus a three-prompt multi-session "patterns" pipeline (extract per chunk, combine chunks, assign events to patterns). Deleted on 2026-08-13 by PR #80312, "chore(replay): remove the legacy session summarization feature". The PR body says: "Replay Vision summarizer scanners replaced session summarization, and the old feature is slated for removal." All legacy citations below point at the parent commit `d58675c4fbf55ecf0fa083fa0a211263ad299705` (the last commit with the tree). Source: [PR #80312](https://github.com/PostHog/posthog/pull/80312).
- **Current: Replay Vision + Signals**: a Gemini model watches a rendered video of the recording with an events tool, emits one structured "observation" per (scanner, session), and an optional "signals" side-turn emits per-session defect findings into the **Signals** pipeline, where an embedding search + LLM match + LLM "PR-specificity" gate incrementally groups signals into persistent **SignalReports** that an agent researches and turns into pull requests. Sources: [products/replay_vision/backend](https://github.com/PostHog/posthog/tree/master/products/replay_vision/backend), [products/signals/backend](https://github.com/PostHog/posthog/tree/master/products/signals/backend), [Replay Vision docs](https://posthog.com/docs/replay-vision), [Self-driving docs](https://posthog.com/docs/self-driving).

---

## Summary

1. **Single session, legacy**: the LLM got a CSV-like event table (one row per event, with `event_id`, `event_index`, `event`, `timestamp`, `elements_chain_*`, `$window_id`, `$current_url`, `$event_type`, `$exception_types`, `$exception_values`) plus URL/window alias tables and session metadata, and returned YAML with `segments`, `key_actions` (each with a **closed taxonomy of three issue flags**: `abandonment: bool`, `confusion: bool`, `exception: null|blocking|non-blocking`), `segment_outcomes`, and `session_outcome`. Descriptions were free text; the taxonomy was the flags. A later video-based variant added `fix_suggestions`, a `sentiment` block with a closed 9-value `signal_type` enum, and a 14-tag fixed taxonomy for session tagging.
2. **Single session, current (Replay Vision)**: the model watches a ~3 fps video with a `URL:`/`REC_T:` footer, has a `get_events_around(rec_t)` tool, and answers a scanner-type-specific schema (monitor verdict, classifier tags, scorer score, summarizer title+summary), then an optional `signals` turn returns `SignalFinding{problem_type: bug|crash|design_flaw|ux_friction, start_time, end_time, url, description, confidence}`. Categories are closed (4 values); the description is free prose with timestamps stripped.
3. **Multi-session, legacy**: a second LLM pass over the single-session summaries (not embeddings). Three prompts: *extract patterns* per token-bounded chunk (≤150k tokens), *combine patterns* across chunks (LLM dedupe, max 20), *assign events to patterns* in chunks of 10 summaries, with a hard rule of **one event per session per pattern**. A pattern was `{pattern_id, pattern_name, pattern_description, severity, indicators[]}` enriched with the assigned events (each carrying `event_uuid`, `session_id`, ±3 neighbouring key actions, segment outcome, person) and stats (`occurences`, `sessions_affected`, `sessions_affected_ratio`, `segments_success_ratio`).
4. **Multi-session, current (Signals)**: incremental, not batch. Each new signal is embedded (`text-embedding-3-small-1536`), an LLM writes 1–3 search queries, ClickHouse cosine search returns ≤10 candidates per query, an LLM decides "existing group" vs "new group" using group titles and multi-query agreement, and a second LLM "senior engineer" gate asks whether **one PR would fix the whole group**; if not, the signal starts a new report. Reports accumulate `total_weight` and promote to research when `total_weight >= 1.0` (Vision findings weigh 0.5, so a finding must recur).
5. **Identity**: legacy patterns had no identity beyond the run (`SessionGroupSummary` stored a snapshot; the model's own comment says pattern inputs are "highly volatile (even a single session could change the meaning of the patterns)"). Current `SignalReport`s are persistent rows; resolved is terminal and a recurrence files a *new* report by design.
6. **Sampling bias / limits**: legacy: max 100 sessions per group summary, ≥5 sessions to use patterns at all, per-chunk extraction + LLM combine, one event per session per pattern, ≥2 sessions per pattern, ≤10 patterns per chunk unless justified. Current: per-scanner random sampling rate + activity-score coverage modes, ≤50,000 event rows per session, ≤30 navigation entries, ≤50 events per tool call, `MIN_SIGNAL_CONFIDENCE = 0.4`, signal weight 0.5, batch of ≤20 signals per grouping round, ≤8 group signals shown to the specificity gate.
7. **Error tracking**: deterministic fingerprints computed in Rust (`cymbal`): V1 = type + in-app resolved frames (or first frame, or message when no stack); V2 = all frames of all chain entries, unresolved line/column dropped, path/chunk-hash normalisation, message masking (quoted strings, hex ids, numbers, truncate 200). Precedence: client `$exception_fingerprint` > grouping rules (HogQL bytecode) > automatic. **AI-assisted grouping** exists: on issue creation the rendered "type_message_and_stack" text is embedded and auto-merged into the closest existing fingerprint when cosine distance `< 0.019` (behind `ERROR_TRACKING_AUTO_MERGE_ENABLED`). A "similar issues" query runner ranks issues by cosine distance to the average embedding of the target issue's fingerprints.
8. **Self-driving**: PostHog's stated loop is "Signal source → Signals → Report → Pull request → You review → Measured"; error-tracking issue lifecycle events (`issue_created`, `issue_reopened`, `issue_spiking`) and Replay Vision `scanner_finding`s are signal sources; an agent researches a promoted report, marks it actionable, and an implementation agent opens a PR at "$15 per pull request".

---

## 1. Single-session extraction

### 1a. Legacy event-based pipeline (removed 2026-08-13)

**What the LLM was given.** Events were fetched with a blocklist and extra fields, then filtered before prompting:

- Blocklist: `SESSION_SUMMARY_EVENT_BLOCKLIST: tuple[str, ...] = ("$feature_flag_called",)`. Pagination: `max_pages: int = 2, items_per_page: int = 3000` with the code comment "The estimation that we can cover 2 hours/3000 events per page within 200 000 token window". Source: [ee/hogai/session_summaries/constants.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/constants.py), [session/input_data.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session/input_data.py).
- Extra fields fetched: `elements_chain_ids, elements_chain, properties.$exception_types, properties.$exception_sources, properties.$exception_values, properties.$exception_fingerprint_record, properties.$exception_functions, uuid`. Columns removed before the LLM: `elements_chain, $exception_sources, $exception_fingerprint_record, $exception_functions`. Source: [posthog/session_recordings/constants.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/posthog/session_recordings/constants.py).
- Time cutoff: events within `SESSION_EVENTS_REPLAY_CUTOFF_MS = 5000` of the replay start or end were dropped ("as we can't verify them with videos confidently").
- Exception filtering (`_skip_exception_without_valid_context`): keep an `$exception` only if `len(exception_fingerprint_record) >= 5` ("blocking errors usually affect multiple flows") or if any function name, source file, or value matches the regex `.*(api|http|fetch|request|post|put|delete|response|xhr|ajax|graphql|socket|websocket|auth|token|login).*`; otherwise "Filter out all the rest".
- Context-less event filtering (`_skip_event_without_valid_context`): never skip multi-word/dotted/underscored event names; keep events with any `elements_chain_*` context; keep `$`-prefixed system events except empty `$autocapture`; skip the remaining short-named, context-free custom events.
- Element text/type enrichment from the raw `elements_chain` (regex on `text=`/`attr__aria-label=` and `attr__type=`), then URL and window IDs replaced by `url_N` / `window_N` aliases with mapping tables, and an 8-hex `event_id` per event derived deterministically ("Generate a hex for each event to make sure we can identify repeated events") with repeated events skipped. Source: [session/prompt_data.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session/prompt_data.py).

The prompt's own description of the input format (verbatim, from [identify-objectives/prompt.djt](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session/templates/identify-objectives/prompt.djt)):

> You'll receive a list of events with columns:
>
> - event_id: Unique identifier for the event - ALWAYS use this to reference specific events, NEVER generate or modify event IDs
> - event_index: Index of the event in the session - helps understand sequence
> - event: Type of event (e.g., $pageview, $autocapture) - signals user actions or system events
> - timestamp: When the event occurred - helps track sequence and time between actions
> - elements_chain_href: URL fragment interacted with - shows specific link or element targets
> - elements_chain_texts: Text content of elements the user interacted with
> - elements_chain_elements: Types of elements the user interacted with (clicked buttons, forms, etc.)
> - $window_id: Unique identifier for browser window/tab - helps track multi-window workflows (use simplified references from window_mapping)
> - $current_url: Page URL where the interaction happened on (use simplified references from url_mapping)
> - $event_type: Type of interaction (e.g., click, submit) - specifies how the user interacted
> - $elements_chain_ids: IDs of the elements that are part of the interaction
> - $exception_types: Type of the exception occurred, if applicable
> - $exception_values: Short description of the exception occurred, if applicable

Session metadata was also passed: "active_seconds", "inactive_seconds", "click_count, keypress_count, mouse_activity_count", "start_url".

**What it was asked to output.** YAML (parsed with `load_yaml_from_raw_llm_content`, then validated by DRF serializers). The system prompt ([system-prompt.djt](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session/templates/identify-objectives/system-prompt.djt)):

> You are an expert analyst of web application user behavior. Your specialty is identifying meaningful segments of user sessions by interpreting event sequences and recognizing patterns in user journeys. You excel at distinguishing between routine interactions and high-value conversion events or user failures.

Key instructions from the user prompt:

> CRITICAL WARNING: DO NOT hallucinate errors. Only mark events as errors when there is EXPLICIT evidence in the event data that an error occurred.

> 3.3. Issue Identification Guidelines (CRITICAL):
>
> - NEVER flag issues for:
>   ✗ Normal page navigation
>   ✗ Sequential UI interactions (changing filters, adjusting parameters)
>   ✗ Any other action without direct evidence of technical error or user frustration
>   ✗ Non-blocking background errors (tracking failures, minor rendering glitches, etc.)
>
> - Flag event issues with EXPLICIT evidence of:
>
>   Exceptions (`exception: null | blocking | non-blocking`):
>   ✓ Event name or type contains: 'exception', 'failed', 'error', etc.
>   ✓ `exception_types` or `exception_values` provide exception context
>   ✓ `elements_chain_texts` contains error messages (e.g., "Try again", "Failed to load", etc.)
>   ✓ Mark as `blocking` when the error prevented user from continuing their intended flow
>   ✓ Mark as `non-blocking` when the user could continue despite the error
>   ✓ Set as `null` when no technical exception occurred
>
>   Confusion (`confusion: true | false`):
>   ✓ Back-and-forth navigation loops indicating search for functionality
>   ✓ Multiple rapid identical form submissions
>   ✓ Repeated attempts to complete the same action without success
>   ✓ Rageclicks (multiple rapid clicks on the same element with no visible response)
>   ✓ Deadclicks (clicks on non-interactive elements)
>
>   Abandonment (`abandonment: true/false`):
>   ✓ Form abandonment after significant time investment (started typing but left without submitting)
>   ✓ Conversion flow abandonment (e.g., leaving checkout, subscription, or signup flow midway, etc.)
>   ✓ Feature exploration followed by exit without completion
>   ✓ Session termination during a multi-step process

> # Step 4: Consolidate Key Actions
>
> AGGRESSIVELY consolidate repeated similar actions, multi-step processes, or related errors. Include up to 3 key actions for short segments or up to 5 actions for long segments. If you need to include more than 5 actions - consolidate events.

> 7.5. Balanced Coverage Verification:
> - Is the entire session represented proportionally in the segments and key actions?
> - Are early, middle, and late events given appropriate attention?
> - Is the analysis free from recency or primacy bias?

**Schema** (DRF serializers in [session/output_data.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session/output_data.py)):

- `SessionSummaryIssueTypes = {abandonment, confusion, exception}`; `SessionSummaryExceptionTypes = {blocking, non-blocking}`.
- `RawKeyActionSerializer`: `description` (≤10,000 chars), `abandonment: bool`, `confusion: bool`, `exception: choice[blocking, non-blocking] | null`, `event_id`.
- Enriched (server-side) key action adds `timestamp, milliseconds_since_start, window_id, current_url, event, event_type, event_index`, then `session_id, event_uuid`.
- `RawSegmentSerializer`: `index, name, start_event_id, end_event_id`; `SegmentMetaSerializer` (computed): `duration, duration_percentage, events_count, events_percentage, key_action_count, failure_count, abandonment_count, confusion_count, exception_count`.
- `SegmentOutcomeSerializer`: `segment_index, summary, success`; `OutcomeSerializer` (session): `description, success`.
- `SessionSentimentSerializer` (from the video path): `frustration_score` (0–1), `outcome: choice[successful, friction, frustrated, blocked]`, `sentiment_signals[]` each `signal_type: choice[rage_click, repeated_error, backtracking, long_pause, abandonment, dead_click, confusion_loop, error_cascade, other]`, `segment_index`, `description`, `intensity` (0–1).
- Validation also enforced a hallucination ratio: `HALLUCINATED_EVENTS_MIN_RATIO = 0.15  # If more than 15% of events in the summary hallucinated, fail the summarization`.

So: **closed taxonomy for classification** (three boolean/tri-state flags, plus a closed 9-value sentiment enum and a 4-value outcome enum), **free text for descriptions and segment names**. Model: `SESSION_SUMMARIES_MODEL = "gpt-5.4"`, `SESSION_SUMMARIES_REASONING_EFFORT = "medium"`.

### 1b. Legacy video-based variant (also removed)

Before removal the same package had a video pipeline (`posthog/temporal/session_replay/session_summary/activities/video_based/a1..a7`): render the recording to video, upload to Gemini (`DEFAULT_VIDEO_UNDERSTANDING_MODEL = "gemini-3-flash-preview"`), slice into segments with per-segment event context, ask for timestamped raw observations, then consolidate.

Per-segment prompt (verbatim excerpt from [a4_analyze_video_segment.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/posthog/temporal/session_replay/session_summary/activities/video_based/a4_analyze_video_segment.py)):

> - Describe what the user did and how it went. Group related actions together — not every click is a separate entry.
> - Cover what went smoothly and what didn't — don't only report problems.
> - Mention errors only when they visibly affected the user (error on screen, page failed to load, action didn't complete). Ignore background console errors with no visible impact.
> - Note confusion (backtracking, repeated attempts, rage clicking) only when clearly present.
> - Red lines indicate mouse movements — ignore them.
> - If nothing is happening, return "Static" for the timestamp range.
>
> Output format (use timestamps relative to the FULL recording, starting at {start_timestamp}):
> * MM:SS - MM:SS: <what happened and the outcome>

Consolidation prompt (excerpt from [a6_consolidate_video_segments.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/posthog/temporal/session_replay/session_summary/activities/video_based/a6_consolidate_video_segments.py)):

> Segmentation:
> - Each segment is a meaningful chunk of activity, not a single action. A chunk covers the full flow: navigating to a feature, using it, and the outcome. Example: "Went to Feature Flags, created a new flag, got blocked by unresponsive dropdown" is ONE segment, not three.
> - Short sessions: 1-3 segments. Long sessions: 3-6. If you have more than 6, you are fragmenting too much — merge harder.
> [...]
> - **Flags**: exception="blocking" only if it visibly stopped the user. confusion/abandonment only when clearly observed.
> [...]
> fix_suggestions:
> - Error details belong here, not in segment descriptions. [...]
> - Each needs: issue, evidence (exact error or observed behavior), suggestion.
> - Only include when grounded in something specific. Empty list is fine.

Schema ([types/video.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/posthog/temporal/session_replay/session_summary/types/video.py)): `ConsolidatedVideoSegment{title, start_time, end_time, description, success, exception: blocking|non-blocking|None, confusion_detected, abandonment_detected}`, `VideoFixSuggestion{segment_index, issue, evidence, suggestion}`, `SessionSentiment` (as above), and a tagging step with a **14-tag fixed taxonomy** `AI_TAGS_FIXED_TAXONOMY` (`onboarding, error, frustration, idle, navigation_only, search, checkout, form_interaction, account_management, content_consumption, feature_exploration, support, collaboration, bot`), optional team custom tags, and 1–5 freeform tags. Per-segment problem classification was a **deterministic function**, not the LLM: `classify_consolidated_segment_problem` returns `blocking_exception` > `abandonment` > `confusion` > `failure` (if `not success`) > `None`, with the comment: "A non-blocking exception on its own is deliberately not a problem: the user wasn't blocked, it's the largest and weakest slice of replay session problems, and the main source of false positives (e.g. console errors merely viewed on screen)."

### 1c. Current: Replay Vision scanners

**Unit**: an *observation* = one application of a *scanner* to one session. "Each (scanner, session) pair is only ever observed once." Enforced by `UniqueConstraint(fields=["scanner", "session_id"])` on `ReplayObservation`. Sources: [Running scanners](https://posthog.com/docs/replay-vision/running-scanners), [models/replay_observation.py](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/models/replay_observation.py).

**What the model is given.** From the docs: "Renders the recording to a sped-up video (inactive periods are trimmed out). Sends that video, along with the session's raw events (clicks, pageviews, rage clicks, dead clicks, exceptions, and more), to a Google Gemini model." Source: [Replay Vision overview](https://posthog.com/docs/replay-vision). The shared preamble ([preamble.jinja](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/temporal/scanners/prompts/preamble.jinja), verbatim excerpts):

> You're analyzing a recorded user session from {{ team_name }}. Ground every claim in direct evidence — a specific moment in the video, or an analytics event; when evidence is ambiguous or absent, lower `confidence` and say so. Prefer admitting uncertainty over fabricating detail.

> The video plays at normal speed but at a low frame rate (about 3 frames per second), so motion looks choppy and brief states can flash by or be skipped between frames [...] A footer at the bottom of every frame shows the current page `URL:` and `REC_T:` — the whole number of seconds since the recording started; judge how long something lasted from `REC_T`, not from how fast it looks on screen.

> You have a tool, `get_events_around`: pass a footer `REC_T` and it returns the events within a few seconds of that moment, each tagged with its own `rec_t`. Fields include `event`, `$current_url`, `$event_type`, `elements_chain_*` (what was interacted with), and `$exception_types`/`$exception_values`.
>
> Use it liberally — call it for any moment that looks interesting, and always before you judge whether the user succeeded, failed, or hit friction, which are easy to misread from the video alone. `$rageclick` (the same element clicked again and again) and `$dead_click` (a click that changed nothing) are the highest-signal friction events: treat them as ground truth, concluding one only when `get_events_around` confirms it at that `REC_T` [...]

> The replay reconstructs each page from DOM snapshots, so states the user never saw can appear on screen: validation or error text that ships hidden in the page's HTML can render visible [...] Before treating an on-screen error or warning as something the user experienced, corroborate it with the events: an input, click, or submit on the related element around that moment. Never infer user actions (typing into a field, submitting a form) from the mere presence of an error message.

> Session Replay hides privacy-sensitive content before it is recorded. Masked elements render as solid or diagonally-striped black/grey boxes [...] Never flag masked content as an issue [...]

The preamble also injects a `<navigation>` timeline of every URL change ("Consult this timeline before concluding the user was stuck or went nowhere"), optional customer `product_context`, the customer's custom event descriptions (`<event_taxonomy>`), a `<session_identity>` block, output-privacy rules, a `<citations>` rule ("mark each one inline as `(t <seconds>)`"), and `<confidence_calibration>`: "Default to 0.5 and raise it only as independent evidence accumulates — reserve 0.9+ for unambiguous conclusions corroborated by 2+ independent signals, and cap it at 0.8 when a conclusion rests on a single moment with no corroboration."

Event ingestion for the tool ([fetch_session_events.py](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/temporal/activities/fetch_session_events.py), [events_tool.py](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/temporal/events_tool.py)): `_EVENTS_TO_IGNORE = ["$feature_flag_called"]`, `_MAX_TOTAL_EVENT_ROWS = 50_000` (sets `events_truncated`), `_MAX_FIELD_LEN = 2000`, dedup by fixed-size hash, `_MAX_NAVIGATION_ENTRIES = 30`, `_MAX_NAVIGATION_URL_LEN = 200`; the tool returns a ±10 s window (max ±60 s) capped at `_MAX_EVENTS_RETURNED = 50` nearest events, dropping `event_uuid` and absolute `timestamp`.

**What it must output.** A scan is "a multi-turn conversation over the cached video: a shared `preamble` (sent/cached once) followed by the ordered `mission_steps` — one structured turn each" ([scanners/base.py](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/temporal/scanners/base.py)). Core step per type ([Scanner types docs](https://posthog.com/docs/replay-vision/scanner-types)):

| Type | Output fields | Core instruction (verbatim) |
| --- | --- | --- |
| Monitor | `verdict: yes/no(/inconclusive)`, `reasoning`, `confidence` | "Decide whether the following condition occurred during the session: {{ user_prompt }} [...] A `yes` needs at least one specific moment you checked with `get_events_around`. A plausible story the events do not support is not a `yes`." ([monitor_step.jinja](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/temporal/scanners/prompts/monitor_step.jinja)) |
| Classifier | `tags[]` from a fixed vocabulary, optional `tags_freeform[]`, `reasoning`, `confidence` | "choose tags from this fixed vocabulary: [{{ vocabulary }}]. [...] The fixed vocabulary above is authoritative: whenever a fixed tag fits — even loosely — use it rather than coining a freeform one [...] Freeform tags this scanner has already used on other sessions: [{{ known_freeform_tags }}]. Reuse one of these exact identifiers whenever it names the concept you see, rather than coining a synonym" ([classifier_step.jinja](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/temporal/scanners/prompts/classifier_step.jinja)) |
| Scorer | `score` on a user scale, `reasoning`, `confidence` | "a score toward either end of the scale needs event-checked moments behind it" ([scorer_step.jinja](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/temporal/scanners/prompts/scorer_step.jinja)) |
| Summarizer | `title` (≤120 chars), `summary` (short/medium/long), `confidence` | "Summarize this session. [...] `summary` should be {{ length_guidance }}." ([summarizer_summary_step.jinja](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/temporal/scanners/prompts/summarizer_summary_step.jinja)) |

Note a docs/code drift: the docs still list summarizer facets `intent`, `outcome`, `friction_points`, `keywords`; master's `SummarizerSummaryResponse` has only `title`, `summary`, `confidence`. The facets were dropped on 2026-09-04 by "feat(replay-vision): one-turn summaries, sharper search, and observation-based search suggestions (#94070)". Source: [summarizer.py](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/temporal/scanners/summarizer.py) and its commit history.

**The "signals" side-turn** is the part that feeds cross-session grouping. When `scanner.emits_signals` is true, the final turn is [signals_step.jinja](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/temporal/scanners/prompts/signals_step.jinja) (verbatim):

> One more pass — a different job from the work above. You're looking for a genuine product defect this recording caught: a bug, a crash, or a design flaw that clearly broke or blocked the user. Put each in the `signals` list. The default is an empty list, and for most recordings that is the correct answer.
>
> The bar is deliberately high. Report a finding only when ALL of these hold:
> - **You can point to the exact thing on screen that reveals it** — a real error state, a crash, a broken or overlapping layout, a control that visibly does nothing when used. If you are inferring it, guessing, or it could be normal behavior, leave it out.
> - **It materially hurt the user** — it blocked, broke, or derailed what they were doing. Ordinary slowness, a brief spinner, a loading state that resolves, an empty-state that fills a moment later, or anything you would merely design better are NOT findings.
> - **An engineer opening this recording at that `REC_T` would unambiguously agree it is a defect.** If there is any real chance you are wrong, do not report it — a missed issue is far better than an invented one.
>
> What makes a finding belong here is that you *saw* it: the `description` must lead with the on-screen detail. Corroboration from the event log *raises* your confidence [...] but never report an issue you only know about from the events.
>
> Write the `description` as plain prose with no timestamp references [...] The timing belongs in `start_time` and `end_time`, not the text.
>
> One recording can surface more than one distinct defect; list each separately. Don't repeat the earlier turns' conclusions. Skip anything below {{ min_signal_confidence }} confidence.

Schema (`SignalFinding`, pydantic, [base.py](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/temporal/scanners/base.py)): `problem_type: Literal["bug", "crash", "design_flaw", "ux_friction"]`, `start_time: int` (REC_T seconds), `end_time: int`, `url: str` ("copy the `URL:` value shown in the video footer"), `description: str` (validator strips `(t N)` markers), `confidence: float` 0–1. `MIN_SIGNAL_CONFIDENCE = 0.4`. The turn is `required=False`: "a side-mission failure must not sink the whole scan." So the closed taxonomy here is four `problem_type` values; everything else is free prose plus a URL and a time range.

---

## 2. Multi-session grouping

### 2a. Legacy: a second LLM pass over single-session summaries (extract → combine → assign)

The group workflow (`SummarizeSessionGroupWorkflow`) ran single-session summaries for every session, then three prompt stages, all over YAML/JSON text (no embeddings, no fixed taxonomy). Source: [session_summary_group/workflow.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/posthog/temporal/session_replay/session_summary_group/workflow.py), [activities/group_patterns.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/posthog/temporal/session_replay/session_summary_group/activities/group_patterns.py), [session_group/summarize_session_group.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session_group/summarize_session_group.py).

Before grouping, each single summary was trimmed to the `IntermediateSessionSummarySerializer` shape (`remove_excessive_content_from_session_summary_for_llm`), i.e. without `session_id`/`event_uuid` on events, "to not feed LLM excessive info".

**Stage 1: extract patterns per chunk.** System prompt ([patterns_extraction/system-prompt.djt](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session_group/templates/patterns_extraction/system-prompt.djt)):

> You are an expert at analyzing user behavior patterns in web applications. Your specialty is identifying recurring pain points, failures, and friction across multiple user sessions.
>
> Your analysis should:
> 1. Identify meaningful patterns that appear across multiple sessions
> 2. Focus on issues that impact user success and business goals
> 3. Provide actionable insights for product improvement
> 4. Distinguish between isolated incidents and systemic issues

User prompt ([patterns_extraction/prompt.djt](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session_group/templates/patterns_extraction/prompt.djt)):

> ## Step 2: Extract Patterns
>
> 2.1. Find coherent patterns from analyzing similar issues across all provided sessions:
> ✓ Each pattern must be supported by evidence from at least 2 sessions
> ✓ Ensure patterns are specific enough to be actionable
> ✓ Use examples from the actual session data with clear, observable indicators
> ✓ Consider both technical and UX-related patterns
> ✓ Focus on patterns affecting conversions and critical flows
>
> ✗ DO NOT Create patterns based on single occurrences
> ✗ DO NOT Include overly generic patterns ("Users click buttons")
> ✗ DO NOT Invent patterns not supported by the sessions data
> ✗ DO NOT Focus on successful behaviors unless they reveal workarounds for issues
> ✗ DO NOT Create more than 10 patterns unless strongly justified by the data
>
> 2.2. Assign severity level to each pattern based on:
> - **Critical**: Patterns that block conversions or cause session abandonment
> - **High**: Patterns causing significant user frustration or workflow interruption
> - **Medium**: Patterns creating minor friction but not preventing goal completion
>
> IMPORTANT: If you want to assign "Low" severity (not listed) - better skip the pattern altogether.
>
> Pattern severity level should be higher if it happens often (medium-level pattern that happens in >50% sessions should be high, but not critical), and lower if it happens rarely (if blocking rendering issue happened 2 times out of 100, it should be high, but not critical).
>
> 2.3. Ensure actionability of each pattern, as each pattern must pass the "So what?" test:
> - Can specific UI/UX changes address this pattern?
> - Is the pattern specific enough to guide priorities?
> - Does it point to a clear problem owner (frontend, backend, UX, etc.)?
> - Can success be measured after implementing fixes?
>
> ## Step 3: Consolidate Patterns
>
> AGGRESSIVELY consolidate similar patterns.

> 4.3. Attach generalized indicators relevant to this pattern:
> - List observable behaviors that confirm this pattern
> - Include event types with contextual details, not specific events [...]
> - Each indicator should be verifiable in session data
> - Include 2-5 indicators per pattern

Output example ([patterns_extraction/example.yml](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session_group/templates/patterns_extraction/example.yml)):

```yaml
patterns:
    - pattern_id: 1
      pattern_name: 'Example Pattern'
      pattern_description: 'The description of the pattern 1'
      severity: 'medium' # low | medium | high | critical
      indicators:
          - Repeated actions confirming the pattern 1
          - Other actions confirming the pattern 1
```

**Stage 2: combine patterns across chunks** (only when more than one chunk). System prompt ([patterns_combining/system-prompt.djt](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session_group/templates/patterns_combining/system-prompt.djt)):

> You are an AI assistant specialized in analyzing and consolidating user experience patterns. Your task is to combine multiple sets of extracted patterns from different chunks of session analysis into a single, unified list of patterns that avoids redundancy while preserving important unique insights.

The merge rule ([patterns_combining/prompt.djt](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session_group/templates/patterns_combining/prompt.djt)):

> 2.2. Similarity decision process:
> For each pair of patterns, ask in order:
> - Are they in the same feature/flow area AND have similar root cause? → MERGE
> - Are they in the same feature area AND share 2+ indicators? → MERGE
> - Do they share 3+ indicators AND describe the same user behavior? → MERGE
> - Otherwise → KEEP SEPARATE

> 2.3. Create similarity groups and track frequency:
> [...]
> - Track pattern frequency: how many chunks contain each pattern (e.g., "appears in 5/10 chunks")
> - Note: Frequency determines inclusion priority, NOT severity
> - Patterns appearing in 50%+ chunks should almost always be included in final list

> 3.4. Determine severity:
> - Count severity levels across all similar patterns
> - Choose the most common severity level
> - If tied, choose the lower severity to avoid overhyping

> 5.2. Final count check:
> - Aim for up to 20 patterns maximum

**Stage 3: assign events to patterns**, in chunks of `PATTERNS_ASSIGNMENT_CHUNK_SIZE = 10` summaries, run concurrently. System prompt ([patterns_assignment/system-prompt.djt](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session_group/templates/patterns_assignment/system-prompt.djt)):

> Your core task is to analyze user session events and assign ONLY problematic events (those with confusion, exception, or abandonment flags) to predefined UX issue patterns. Never assign events without these flags, regardless of context.
> [...]
> Critical Constraints:
> - ONLY assign events with `confusion: true`, `exception: blocking`, `exception: non-blocking`, or `abandonment: true`
> - Each event can belong to maximum ONE pattern
> - Each session can contribute maximum ONE event per pattern - select the most representative one
> - Pattern indicators are guidelines, not exhaustive requirements
> - Some patterns may have zero matches - this is expected and correct

User prompt ([patterns_assignment/prompt.djt](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session_group/templates/patterns_assignment/prompt.djt)):

> 3.2. Evaluate Match Strength
> Strong Match (assign):
> - Event location matches pattern's affected feature
> - Event behavior matches at least one indicator
> - Issue type aligns with pattern description
> [...]
> 3.3. Make Assignment Decision
> - Only assign if match strength is Strong or clearly Moderate
> - If an event strongly matches multiple patterns, assign to the most specific pattern
> - Never assign the same event to multiple patterns
> - CRITICAL: Each session can contribute only ONE event per pattern. If multiple events from the same session match a pattern, select the single most representative one that best demonstrates the pattern
> - If uncertain, prefer no assignment over incorrect assignment

Output: `patterns: [{pattern_id, event_ids: [...]}]`.

**Data model for a pattern** ([session_group/patterns.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session_group/patterns.py), pydantic):

- `RawSessionGroupSummaryPattern`: `pattern_id: int (ge=1)`, `pattern_name: str`, `pattern_description: str`, `severity: low|medium|high|critical`, `indicators: list[str] (min 1)`.
- `EnrichedSessionGroupSummaryPattern` adds `events: list[PatternAssignedEventSegmentContext]` and `stats`.
- `PatternAssignedEventSegmentContext` is how a pattern points back at evidence: `segment_name, segment_outcome, segment_success, segment_index, previous_events_in_segment (≤3), target_event, next_events_in_segment (≤3), session_start_time_str, session_duration, person_distinct_ids, person_email`; `target_event` is an `EnrichedPatternAssignedEvent{event_id, event_uuid, session_id, description, abandonment, confusion, exception, timestamp, milliseconds_since_start, window_id, current_url, event, event_type, event_index}`.
- `EnrichedSessionGroupSummaryPatternStats`: `occurences`, `sessions_affected`, `sessions_affected_ratio` (0–1), `segments_success_ratio` (0–1, over unique `session_id_segment_index` pairs).

Server-side dedupe after assignment (`combine_patterns_assignments_from_single_session_summaries`): "Deduplicates to keep only one event per session per pattern (first occurrence wins)." Patterns with zero enriched events are dropped; final list is sorted `critical → high → medium → low`. Failure policy: "Fail only when patterns exist but none could be enriched - a partial report is still useful"; assignment "Abort only on total chunk failure; partial assignments still produce a useful patterns report."

### 2b. Current: Signals pipeline (incremental embedding search + LLM match + PR-specificity gate)

Replay Vision findings become signals via `emit_signal(source_product="replay_vision", source_type="scanner_finding", source_id=f"observation:{observation.id}:{index}", idempotency_key=<same>, description=signal.description, weight=SIGNAL_WEIGHT)` with `SIGNAL_WEIGHT = 0.5` and the comment "Findings accumulate into a report across sessions; promotion (total_weight >= 1.0) needs corroboration." `extra` carries `scanner_id, scanner_name, scanner_type, observation_id, session_id, exported_asset_id, distinct_id, recording_start_time, recording_end_time, recording_duration, recording_active_seconds, confidence, problem_type, start_time, end_time, url`. Source: [emit_observation_signal.py](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/temporal/activities/emit_observation_signal.py), [constants.py](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/temporal/constants.py).

The legacy video pipeline emitted the same way (`source_product="session_replay", source_type="session_problem"`, `source_id=f"{session_id}:{start_time}:{end_time}"`, weight 0.5) with the comment: "A full agentic research run fires per promoted report, and a report promotes once its signals' summed weight crosses 1.0. Emitting below that (0.5) means a single isolated problem no longer triggers research on its own; it has to recur before we pay to research it." Source: [a7b_emit_session_problem_signals.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/posthog/temporal/session_replay/session_summary/activities/video_based/a7b_emit_session_problem_signals.py).

Grouping ([products/signals/backend/temporal/grouping.py](https://github.com/PostHog/posthog/blob/master/products/signals/backend/temporal/grouping.py), [grouping_v2.py](https://github.com/PostHog/posthog/blob/master/products/signals/backend/temporal/grouping_v2.py)). Per team, one long-running Temporal workflow (`team-signal-grouping-v2-{team_id}`) collects S3 batches of up to `BATCH_COLLECT_MAX_SIGNALS = 20` signals (or 30 s) and runs `_process_signal_batch`:

1. Embed each signal's `description` with `EMBEDDING_MODEL = EmbeddingModelName.TEXT_EMBEDDING_3_SMALL_1536` ([signal_metadata.py](https://github.com/PostHog/posthog/blob/master/products/signals/backend/signal_metadata.py); Vision observations and error-tracking fingerprints use `text-embedding-3-large-3072` instead), and search candidates with `RunSignalSemanticSearchInput(..., limit=10)`.
2. **LLM query generation** (`QUERY_GENERATION_SYSTEM_PROMPT_TEMPLATE`, verbatim):

   > You are a signal grouping assistant. Your job is to generate search queries that will help find related signals in an embedding database.
   >
   > Signals come from diverse sources: exceptions, experiments, insight alerts, session behaviour analysis, and more.
   > Related signals may be different types but connected by the same underlying cause, feature, or user journey. Note that "related" does not just mean "semantically similar", but "likely to share a common root cause or impact".
   > [...]
   > Given a new signal, generate 1-3 search queries that would help find related signals. Each query should be a natural language description that captures a different angle of what might be related:
   >
   > 1. The specific feature, page, or component involved
   > 2. The type of user behavior or technical issue
   > 3. The broader category or business impact

   `MAX_SEARCH_QUERIES = 3`; each query is embedded and searched in ClickHouse; earlier signals in the same batch are injected as candidates by local cosine distance (`_augment_candidates_with_batch`, limit 10).
3. **LLM match** (`MATCHING_SYSTEM_PROMPT`, verbatim excerpts):

   > Your job is to determine if a new signal is related to an existing group of signals, or if it should start a new group.
   > [...]
   > IMPORTANT: Signals should be grouped if they are meaningfully related, not just superficially similar:
   > - An experiment reaching significance AND an error spike on the same feature SHOULD match (related by feature)
   > - A session behaviour anomaly AND an insight alert about the same user flow SHOULD match (related by user journey)
   > - Two "experiment reached significance" signals from DIFFERENT, unrelated experiments should NOT match
   > - Two signals about the SAME experiment (e.g., significance + follow-up analysis) SHOULD match
   > - Two error-tracking signals from the SAME underlying defect or resolved by the same fix applied at different call sites SHOULD match, even if they surface in different files, components, or pages (they resolve to one fix)
   >
   > You will receive:
   > 1. A new signal with its description and source information
   > 2. Discovery strength: how many independent search queries found signals in each existing group (higher = stronger evidence)
   > 3. Results from multiple search queries, each with candidate signals annotated with their group title and group size
   >
   > IMPORTANT — use group context when deciding:
   > - Each candidate belongs to a group. The group title tells you the group's overall theme.
   > - Match the new signal to a GROUP's theme, not just to an individual candidate signal.
   > - A candidate that shares a keyword with the new signal but belongs to an unrelated group should NOT be matched.
   > - Groups found by multiple independent queries are more likely genuinely related.

   Response is a discriminated union: `MatchFound{reason, match_type: "existing", signal_id, query_index}` or `NewGroup{reason, match_type: "new", title, summary}`, with "The "reason" field MUST be the first key in your JSON response. Write your reasoning BEFORE making the match decision."
4. **PR-specificity gate** on every existing-group match (`SPECIFICITY_CHECK_SYSTEM_PROMPT`, verbatim excerpts):

   > You are a senior engineer reviewing whether a group of signals belongs in a single pull request.
   > [...]
   > 1. Write a single PR title (max 70 chars) that covers ALL signals in the group INCLUDING the new one.
   > 2. Judge: would ONE focused change resolve every signal in the group? If a single fix — even one applied at several call sites — addresses them all, they belong in one PR.
   >
   > Judge by the FIX, not by where the symptom appears. [...]
   >
   > Reject the group only when the signals need SEPARATE, unrelated fixes that no single engineer would take on together, such as "Fix various PostHog AI issues" or "Address feature flag and authentication concerns".
   > [...]
   > Respond with valid JSON only:
   > {"pr_title": "...", "specific_enough": true/false, "reason": "..."}

   The gate sees at most `MAX_SIGNALS_IN_SPECIFICITY_CONTEXT = 8` existing signals (500 chars each). If `specific_enough` is true the report title is replaced with `pr_title`; if false the match is converted to `NewReportMatch(title=<first line of description>, summary=f"Split from group: {report_title}")`.
5. **Assign + emit**: the signal row (with embedding) is written to ClickHouse and the report's `total_weight += weight`, `signal_count += 1`. The unit of grouping is therefore *the report the matched candidate belongs to*; there is no fixed taxonomy and no re-clustering pass.

Signal-source dedup: `SignalEmissionRecord` has `UniqueConstraint(fields=["team", "source_product", "source_type", "source_id"])` ("One row per source record, upserted on emission"), and `emit_signal(idempotency_key=...)` maps to a deterministic Temporal workflow id (`signal-emitter-{team_id}-{sha256(key)}`). Sources: [models.py](https://github.com/PostHog/posthog/blob/master/products/signals/backend/models.py), [emitter.py](https://github.com/PostHog/posthog/blob/master/products/signals/backend/temporal/emitter.py), [facade/api.py](https://github.com/PostHog/posthog/blob/master/products/signals/backend/facade/api.py).

The product docs describe the same thing at a higher level: "As signals arrive, the inbox deduplicates them and groups related ones, so a signal from a support conversation, a matching error-tracking issue, and a session-replay pattern collapse into a single report rather than three." Source: [Signal sources](https://posthog.com/docs/self-driving/inbox/sources).

There is also a scheduled "scout" agent for session replay that bypasses signal grouping and files reports directly, with an explicit design statement about concentration: "**Concentration-vs-diffusion is the signal-vs-noise discriminator.** Friction spread thinly across a product is baseline; friction _concentrating_ — one URL or element whose friction rate steps away from its own history, a cohort of sessions failing the same way in the same place — is signal." It quantifies on `$rageclick`/`$dead_click` events and uses recordings as corroboration: "Quantify on events; corroborate and illustrate with recordings." Source: [products/signals/skills/signals-scout-session-replay/SKILL.md](https://github.com/PostHog/posthog/blob/master/products/signals/skills/signals-scout-session-replay/SKILL.md).

---

## 3. Unit of an issue: identity, persistence, counting

**Legacy patterns.** A pattern had only a run-local integer `pattern_id`; identity was the LLM-written `pattern_name`. Results were persisted as a whole-run snapshot in `SessionGroupSummary{title, session_ids[] (size 1000), summary: EnrichedSessionGroupSummaryPatternsList, extra_summary_context, run_metadata}`. The model deliberately did not index inputs for reuse: "Not indexing session ids or extra summary context, as the input for group summaries is highly volatile (even a single session could change the meaning of the patterns). Creating Manager for rare cases of `exact 300 ids + context input match` seems excessive." Single-session summaries *were* cached and reused (`SingleSessionSummary`, "get the latest version"; matched by `(team, session_id, extra_summary_context)`), so re-running a group summary re-ran only the pattern stages. Counts per pattern were computed from assigned events: `sessions_affected = len({event.target_event.session_id ...})`, `occurences = len(pattern_events)` (which, after the one-event-per-session rule, equals sessions affected), plus a segment success ratio. Persons were attached per session via `distinct_id → Person` lookup for display (`person_distinct_ids`, `person_email`), but there was no user-count field. Source: [products/replay/backend/models/session_summaries.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/products/replay/backend/models/session_summaries.py), [patterns.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/session_group/patterns.py).

**Current SignalReport.** Persistent Postgres row with `status ∈ {potential, candidate, in_progress, pending_input, ready, resolved, failed, deleted, suppressed}`, `total_weight`, `signal_count`, `signals_at_run`, `run_count`, `signals_researched`, `title`, `summary`, `charts`, `suggested_prompts`, `promoted_at`, `last_run_at`, `first_visible_at`, plus one-to-ones for `SignalReportAssignment` (actor, `pr_url`, `pr_state`, `pr_merged`), `SignalReportTrackerIssue`, and many `SignalReportArtefact`s. Promotion rules (code comment, verbatim):

> - SUPPRESSED: never promoted.
> - RESOLVED: terminal — never receives new signals (a recurrence spawns a fresh report above).
> - POTENTIAL: promote once total_weight >= WEIGHT_THRESHOLD and signal_count >= signals_at_run (snooze gate, defaults to 0). Uncapped — a report's first research always runs.
> - READY: re-research once the report has reached its next bucket in RESEARCH_SIGNAL_BUCKETS. Between buckets, and past the last one, signals are collected, not researched.

`WEIGHT_THRESHOLD = float(os.getenv("SIGNAL_WEIGHT_THRESHOLD", "1.0"))`; `RESEARCH_SIGNAL_BUCKETS` defaults to `1,2,4,10`. Source: [grouping.py](https://github.com/PostHog/posthog/blob/master/products/signals/backend/temporal/grouping.py), [types.py](https://github.com/PostHog/posthog/blob/master/products/signals/backend/temporal/types.py), [models.py](https://github.com/PostHog/posthog/blob/master/products/signals/backend/models.py).

Docs on identity over time: "A resolved report stays resolved. If the same problem returns later, self-driving files a new report. It does not reopen the old one." and "Reopening would blur two separate incidents into one item and lose the fact that a fix didn't hold, where a new report makes the pattern visible." Sources: [Inbox](https://posthog.com/docs/self-driving/inbox), [Reports](https://posthog.com/docs/self-driving/reports).

**User/session counting.** Reports count *signals* (`signal_count`) and weight, not users; user impact is left to the research agent ("It weighs three things: Code importance [...] User impact. How many users are affected, and are they on a paid plan? [...] Severity."). Source: [Research tasks](https://posthog.com/docs/self-driving/inbox/research). At the scanner level, Replay Vision counts impact per scanner over a trailing 30-day window from observations, keyed by session time: `affected_sessions=Count("session_id", distinct=True)`, `affected_users=Count("distinct_id", filter=_HAS_USER, distinct=True)`, `sessions_without_user`; monitors count `verdict == "yes"`, classifiers count per tag, scorers by score range, summarizers unsupported. Users can be exported as a static cohort (max 10,000 distinct ids). Source: [impact.py](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/impact.py), [Observations docs](https://posthog.com/docs/replay-vision/observations). Group (company) attribution per observation is resolved at scan time from `$group_N` on events via `argMaxIf(..., timestamp, ...)` ("the most recent one is the group the observed activity belongs to"). Source: [queries/session_group_keys.py](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/queries/session_group_keys.py).

---

## 4. Sampling bias and limits

**Legacy.**

- Group size and minimums: `MAX_SESSIONS_TO_SUMMARIZE = 100`, `GROUP_SUMMARIES_MIN_SESSIONS = 5` ("Minimum number of sessions to use group summary logic (find patterns) instead of summarizing them separately"). Fail-fast: `GROUP_SUMMARY_MIN_SUCCESS_FLOOR = 3`, `GROUP_SUMMARY_MIN_SUCCESS_RATIO = 0.3` ("Continue if `successes >= max(min(FLOOR, ceil(total/2)), total * RATIO)`").
- Session eligibility: `MIN_SESSION_DURATION_FOR_VIDEO_SUMMARY_S = 15`, `MIN_ACTIVE_SECONDS_FOR_VIDEO_SUMMARY_S = 10`, `MAX_ACTIVE_SECONDS_FOR_VIDEO_SUMMARY_S = 3600`.
- Per-session dominance: the single-session prompt caps key actions at 3–5 per segment and "AGGRESSIVELY consolidate[s]"; the assignment stage enforces one event per session per pattern both in the prompt and in code ("first occurrence wins"); extraction requires "at least 2 sessions" per pattern and "DO NOT Create more than 10 patterns unless strongly justified".
- Chunking: `PATTERNS_EXTRACTION_MAX_TOKENS = 150000` per extraction chunk, `SINGLE_ENTITY_MAX_TOKENS = 200000` (a session larger than the chunk limit but under this gets its own chunk; larger is skipped), `PATTERNS_ASSIGNMENT_CHUNK_SIZE = 10`. Chunk results were combined by the LLM combine prompt with a "maximum 20 patterns" cap and frequency-across-chunks ordering. Source: [constants.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/ee/hogai/session_summaries/constants.py), [group_patterns.py](https://github.com/PostHog/posthog/blob/d58675c4fbf55ecf0fa083fa0a211263ad299705/posthog/temporal/session_replay/session_summary_group/activities/group_patterns.py).

**Current.**

- Which sessions get scanned: recording filters, then a *session coverage* mode ("Highest activity only: Roughly the top 25% of sessions by activity score", "Skip lowest activity: Roughly the top 65%", "All recordings"), then a random *sampling rate* ("samples are random, so a 10% rate gives you a representative slice"). On-demand scans "Skip the sampling rate". Eligibility: `MIN_SESSION_DURATION_FOR_VIDEO_SCANNER_S = 15`, `MIN_ACTIVE_SECONDS_FOR_VIDEO_SCANNER_S = 10`, `MAX_ACTIVE_SECONDS_FOR_VIDEO_SCANNER_S = 3600`. Sources: [Creating scanners](https://posthog.com/docs/replay-vision/creating-scanners), [Running scanners](https://posthog.com/docs/replay-vision/running-scanners), [session_limits.py](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/session_limits.py).
- Per-session input bounds: 50,000 event rows, 30 navigation entries, 50 events per tool call, `_MAX_FIELD_LEN = 2000`.
- Per-session output bounds: findings need `confidence >= 0.4`; "One recording can surface more than one distinct defect; list each separately" — so one session can emit several signals, but each carries weight 0.5 and a distinct `source_id`, and the matching LLM is told to match to a group's theme. Nothing in the grouping code caps how many signals from one session can join one report; the "one event per session per pattern" rule from the legacy pipeline has no current equivalent.
- Grouping bounds: batches of ≤20 signals; ≤10 candidates per query, ≤3 queries; ≤8 group signals shown to the specificity gate; per-team daily report limit (`max_reports_per_day`, docs: "Choose how many self-driving reports your project receives each day", changelog 2026-08-27).
- Budget: Vision is metered in credits (2/5/15 credits per observation by model, default 15,000 credits/month per org). Digests summarise "up to 100 observations from the period; busier periods are sampled down to that limit." Sources: [Quota and limits](https://posthog.com/docs/replay-vision/quota-and-limits), [Digests and alerts](https://posthog.com/docs/replay-vision/actions).

---

## 5. Error tracking: fingerprinting, grouping rules, and AI-assisted merging

**Precedence** (docs): "Client-side defined custom fingerprint using $exception_fingerprint; Match grouping rules defined in PostHog; If no user defined logic, fall back to grouping as issues based on automatic fingerprinting." Merging: "After merging, all events and aggregated counts from the merged issues are added to the primary issue. The merged issues are then deleted (but the underlying events are not)." Fingerprint → issue is many-to-one: "Each fingerprint links to exactly one issue [...] Multiple different fingerprints can point to the same issue (a many-to-one relationship) if you merge issues." Sources: [Grouping exceptions into issues](https://posthog.com/docs/error-tracking/grouping-issues), [Fingerprints](https://posthog.com/docs/error-tracking/fingerprints), [Issues and exceptions](https://posthog.com/docs/error-tracking/issues-and-exceptions).

**Automatic fingerprint** (Rust `cymbal`, [fingerprinting/mod.rs](https://github.com/PostHog/posthog/blob/master/rust/cymbal/src/modes/processing/fingerprinting/mod.rs), [stages/grouping/fingerprint.rs](https://github.com/PostHog/posthog/blob/master/rust/cymbal/src/modes/processing/stages/grouping/fingerprint.rs)):

- Selection order in code: "1. Existing input fingerprint wins and is marked manual. 2. Matching grouping rule wins and is marked custom. 3. Automatic versions use the newest already-saved fingerprint, or the newest version." Manual fingerprints longer than 64 chars are SHA-512 hashed. Grouping rules are HogQL bytecode evaluated per event; a rule that errors is disabled with the message stored (`disabled_data`).
- V1 (`FingerprintStrategy::default()`): hash `exception_type`; if no resolved stack, hash the message; else select frames: if no in-app frames, "return frames.first()"; otherwise frames that are `in_app` and (resolved, or all if none resolved); per frame hash `source`, `module`, then `resolved_name` if resolved, else `mangled_name` + line + column + `lang`.
- V2: "hashes all frames of every chain entry, drops unresolved line/column, and normalizes volatile path and message tokens. Selected by an offline research loop: pairwise F1 0.40 vs 0.26 for V1 on a held-out LLM-labeled pair dataset." Normalisation: `strip_query_strings` ("app.js?v=abc123" → "app.js"), `strip_hashed_chunks` ("chunk-PGUQKT6S.js" → "chunk-*.js", regex `[A-Za-z0-9]{8,}` with a digit or all-uppercase), `basename_only`; message masking: quoted strings → `'*'`, `0x…`/UUIDs/≥16-hex runs → `*`, digit runs → `#`, truncate 200. Version selection "keeps the newest already-used fingerprint, and new issues are created under the last (newest) entry", so upgrading the algorithm does not fork existing issues.

**AI-assisted grouping (embeddings)**. On `issue_created`, the event is rendered as `EMBEDDING_RENDERING = "type_message_and_stack"` (≤7,000 tokens), embedded with `text-embedding-3-large-3072`, written to the `document_embeddings` ClickHouse table (`product="error_tracking", document_type="fingerprint", document_id=<fingerprint>`), then `merge_similar_fingerprints` runs a cosine search and, when `settings.ERROR_TRACKING_AUTO_MERGE_ENABLED`, merges the new issue into the closest existing fingerprint's issue for any candidate with `distance < AUTO_MERGE_DISTANCE_THRESHOLD` where `AUTO_MERGE_DISTANCE_THRESHOLD = 0.019`; the merge is captured as `error_tracking_issue_merged` with `merge_source: "auto"`. Embedding is skipped for manual/custom fingerprints, for `posthog-elixir`, and when the org has not approved AI data processing. Sources: [lifecycle/issue_created/activities.py](https://github.com/PostHog/posthog/blob/master/products/error_tracking/backend/temporal/lifecycle/issue_created/activities.py), [fingerprint_embedding_result/activities.py](https://github.com/PostHog/posthog/blob/master/products/error_tracking/backend/temporal/fingerprint_embedding_result/activities.py), [embedding.py](https://github.com/PostHog/posthog/blob/master/products/error_tracking/backend/embedding.py).

A separate UI query, `ErrorTrackingSimilarIssuesQueryRunner`, computes `avgForEach(embedding)` over the target issue's fingerprints and ranks other fingerprints by `cosineDistance(avg_embedding, embedding)` under a `max_distance`, collapsing to issues by closest fingerprint. Source: [error_tracking_similar_issues_query_runner.py](https://github.com/PostHog/posthog/blob/master/products/error_tracking/backend/hogql_queries/error_tracking_similar_issues_query_runner.py).

**Error tracking → Signals.** Issue lifecycle workflows emit signals with `source_type ∈ {issue_created, issue_reopened, issue_spiking}`; the `issue_created` preamble is "New error tracking issue created - this particular exception was observed for the first time", and the backfill uses `weight=1.0` with `extra={"fingerprint": ...}` (so a single new exception issue is enough to promote a report, while a Vision finding at 0.5 is not). Sources: [issue_created/activities.py](https://github.com/PostHog/posthog/blob/master/products/error_tracking/backend/temporal/lifecycle/issue_created/activities.py), [signals/backend/temporal/backfill_error_tracking.py](https://github.com/PostHog/posthog/blob/master/products/signals/backend/temporal/backfill_error_tracking.py). Docs: "Error tracking: New exceptions, reopened issues, and error volume spikes." ([Signal sources](https://posthog.com/docs/self-driving/inbox/sources)).

---

## 6. "Self-driving" statements and how detected issues feed it

Public framing (verbatim):

- "PostHog makes your product self-driving. It watches how people actually use your product, finds what's worth fixing, opens a pull request, and measures whether the change worked. You review and merge." — "It runs as a loop. Scouts and signal sources emit signals, signals group into reports, and an agent investigates each report." — "When a report is actionable, PostHog opens a pull request for you to review and merge; when it needs your input, it surfaces the report in your inbox instead." — "you pay a flat $15 per pull request, your first three each month are free, reports are always free, and if a PR wasn't worth paying for, we refund it." Source: [Self-driving](https://posthog.com/docs/self-driving).
- Loop stages: "Collect signals → Group into reports → Investigate each report → Open a pull request, or ask for input → Review and ship → Measure and improve". "Raw signals are noisy, so the loop deduplicates them and clusters the ones pointing at the same underlying problem into a single report." Source: [The self-improving loop](https://posthog.com/docs/self-driving/self-improving-loop).
- Signal definition: "A signal is a structured finding: something worth knowing, with the evidence behind it and a suggested action." Sources vs scouts: "A signal source is deterministic and exhaustive [...] A scout trades some of that determinism for judgement." Source: [Signals](https://posthog.com/docs/self-driving/signals).
- Research: "an agent investigates it automatically. It uses the MCP servers in your workspace, starting with the PostHog MCP [...] with access to your product's code for grounding. The result is a report rated on two axes: Actionability [...] Priority (P0 to P4)". Triage order: "P0 and P1 [...] Actionable items [...] Items needing research". Source: [Research tasks](https://posthog.com/docs/self-driving/inbox/research).
- Implementation: "The agent clones your repository into a secure, sandboxed environment. It then: Creates a new git branch (for example, ai-fix/billing-null-check). Applies the code changes. Runs any local tests, if configured." Source: [Implementation](https://posthog.com/docs/self-driving/inbox/implementation).
- Replay Vision specifically: "After it finds all clues, it actually solves the mystery and sends the cracked case in the form of a PR directly to your Inbox. [...] A scanner spotted the struggle in a recording. That finding became a signal in our Inbox. A background agent investigated it and opened a pull request." Two worked examples (posthog#67643 dead click + rate-limit storm; posthog#67499 cached empty search result). Source: [Replay Vision watches the session recordings you never will](https://posthog.com/blog/replay-vision), 2026-07-31.
- Blog on the concept (2026-05-05): "A self-driving product can prompt itself." — "Raw observations get grouped, enriched, and turned into concrete plans." — "Errors, replays, and external signals flow into the signals pipeline and are clustered into signal reports." — evaluation: "PostHog Code schedules evals as long-running Temporal jobs, so the check runs hours or days after the PR merges. [...] If the metric didn't move – or moved the wrong way – the agent reverts or reopens the work." Source: [PostHog Code and the self-driving product](https://posthog.com/blog/self-driving-product).
- Worked example of grouping across sources: an error-tracking exception, a rage-click cluster, and two Zendesk tickets become one report titled "Checkout confirm fails when the cart contains a discounted item", P1, then a PR on branch `ai-fix/checkout-discount-null`; "After a soak window, a validation scout re-checks that the fix actually held". Source: [Anatomy of a pull request](https://posthog.com/docs/self-driving/anatomy-of-a-pr).

Code-level wiring: a promoted report spawns `SignalReportSummaryWorkflow` → agentic research (`temporal/agentic/report.py`) → `transition_to(READY, title, summary)` or `PENDING_INPUT`; implementation is debounced (`IMPLEMENTATION_DEBOUNCE_SECONDS` default 900) and tracked on `SignalReportAssignment.pr_url/pr_state/pr_merged`. Replay Vision observations can also mint a Task directly (`ReplayObservation.created_task_id`: "PostHog Task minted from this observation's finding"). Sources: [summary.py](https://github.com/PostHog/posthog/blob/master/products/signals/backend/temporal/summary.py), [types.py](https://github.com/PostHog/posthog/blob/master/products/signals/backend/temporal/types.py), [replay_observation.py](https://github.com/PostHog/posthog/blob/master/products/replay_vision/backend/models/replay_observation.py).

---

## Contrast with Opslane

Opslane today: one narrator LLM call per session emits observations with a closed 9-category taxonomy and cited timeline lines; observations are fingerprinted by `category + route` (element added for only 3 categories) and grouped into incidents by that fingerprint; one investigator verdict per incident.

| Dimension | PostHog legacy (removed) | PostHog current | Opslane |
| --- | --- | --- | --- |
| Per-session input | Filtered event table + URL/window aliases + metadata; 5 s edge cutoff; exception keyword filter | Rendered video (~3 fps, idle trimmed) + `get_events_around` tool + navigation timeline + customer product context | Timeline lines (events) |
| Per-session taxonomy | Closed flags: `abandonment`, `confusion`, `exception ∈ {blocking, non-blocking}`; later `sentiment.signal_type` (9 values), 14 fixed session tags | Closed `problem_type ∈ {bug, crash, design_flaw, ux_friction}` on findings; classifier scanners get a user-defined closed vocabulary with optional reuse-first freeform tags | Closed 9 categories |
| Evidence pointer | `event_id` (8-hex) → `event_uuid`, ±3 neighbouring key actions, segment outcome | `(t N)` citations → `REC_T` seconds; findings carry `start_time`, `end_time`, footer `url` | Cited timeline lines |
| Grouping mechanism | Second LLM pass: extract per chunk → LLM combine → LLM assign; no embeddings, no key | Embedding search (3 LLM-written queries, ≤10 candidates each) → LLM "existing vs new group" → LLM "one PR?" gate; incremental, per signal | Deterministic fingerprint `category + route (+ element)` |
| Identity across runs | None; snapshot per run (`SessionGroupSummary`), inputs "highly volatile" | Persistent `SignalReport`; resolved is terminal; recurrence = new report | Incident keyed by fingerprint |
| Dominance control | 1 event per session per pattern (prompt + code); ≥2 sessions per pattern; ≤10 patterns per chunk, ≤20 after combine; 150k-token chunks | Random sampling + activity coverage; weight 0.5 per finding so a report needs ≥2 corroborating signals (or one weight-1.0 error issue); batch ≤20; no per-session cap inside a report | Fingerprint collapses repeats by construction |
| Counting | `sessions_affected`, `occurences`, `segments_success_ratio` from assigned events | Report: `signal_count`, `total_weight`; scanner: distinct sessions / distinct `distinct_id` over 30 days | Users/sessions per incident |
| Verdict | Per-pattern severity from the LLM (`critical/high/medium`), frequency-adjusted | One agentic research run per promoted report → actionable/needs-input + P0–P4 → PR | One investigator verdict per incident |

Observations relevant to Opslane's design choices:

1. **PostHog abandoned both the "assign observations to named patterns" batch design and pure semantic similarity.** The live pipeline routes every new signal through an LLM that is told "related does not just mean semantically similar, but likely to share a common root cause or impact", and then through a second LLM whose only question is whether one PR fixes the whole group. That second gate is the closest analogue to Opslane's "one investigator verdict per incident" invariant: the group boundary *is* the fix boundary. Opslane gets this for free from `category + route` but pays for it with route-level over-merging; PostHog pays an LLM call per signal instead.
2. **Evidence resolution.** PostHog's legacy pipeline carried the full event context (`event_uuid`, neighbours, segment outcome, person) through to the pattern so the UI could jump to the moment; the current one carries `start_time`/`end_time`/`url`/`observation_id` in `extra`. Opslane's cited timeline lines match the legacy approach; keeping `session_id + line range` on every observation is what lets a later merge pass re-verify.
3. **Recurrence gating by weight** (0.5 per replay finding, promote at 1.0) is PostHog's answer to "one session dominating": a single session's finding never triggers research on its own. Opslane's fingerprint grouping has the same effect only when the same `category + route` recurs; a novel category+route from one session still becomes an incident.
4. **Per-session one-vote rule** was explicit in the legacy pipeline ("Each session can contribute maximum ONE event per pattern") and disappeared in the current one. If Opslane's narrator can emit several observations with the same fingerprint from one session, the legacy dedupe (first occurrence wins, per session per pattern) is the cheap, proven rule.
5. **Closed taxonomies are used for classification, never for grouping.** In neither PostHog generation does the category alone define the group; the legacy assignment prompt uses flags only as an *eligibility filter* ("ONLY assign events with `confusion: true`, `exception: blocking`..."), and the current pipeline drops `problem_type` into `extra` and groups on the free-text description. Opslane is the outlier in making category part of the key.
6. **Error tracking is the only place PostHog groups deterministically**, and even there it added an embedding auto-merge (`distance < 0.019`) plus user-defined grouping rules and manual merge, and moved to a V2 fingerprint chosen by "pairwise F1 [...] on a held-out LLM-labeled pair dataset". A labelled pair set is the evaluation method to copy if Opslane wants to tune its fingerprint.

---

## Source index

Repository (master unless pinned):

- Legacy tree (pinned to `d58675c4`): `ee/hogai/session_summaries/{constants.py, session/input_data.py, session/prompt_data.py, session/output_data.py, session/templates/identify-objectives/*, session_group/patterns.py, session_group/summarize_session_group.py, session_group/templates/{patterns_extraction,patterns_combining,patterns_assignment}/*}`; `posthog/temporal/session_replay/session_summary/{activities/video_based/a4_analyze_video_segment.py, a6_consolidate_video_segments.py, a7b_emit_session_problem_signals.py, types/video.py}`; `posthog/temporal/session_replay/session_summary_group/{workflow.py, activities/group_patterns.py}`; `products/replay/backend/models/session_summaries.py`; `posthog/session_recordings/constants.py`. Removal: [PR #80312](https://github.com/PostHog/posthog/pull/80312).
- Replay Vision: `products/replay_vision/backend/{temporal/scanners/base.py, temporal/scanners/summarizer.py, temporal/scanners/prompts/*.jinja, temporal/activities/emit_observation_signal.py, temporal/activities/fetch_session_events.py, temporal/events_tool.py, temporal/constants.py, models/replay_observation.py, models/replay_scanner.py, session_limits.py, impact.py, queries/session_group_keys.py, embeddings.py}`.
- Signals: `products/signals/backend/{temporal/grouping.py, temporal/grouping_v2.py, temporal/types.py, temporal/emitter.py, temporal/summary.py, temporal/backfill_error_tracking.py, models.py, facade/api.py}`; `products/signals/skills/signals-scout-session-replay/SKILL.md`.
- Error tracking: `rust/cymbal/src/modes/processing/{fingerprinting/mod.rs, stages/grouping/fingerprint.rs, rules/grouping.rs}`; `products/error_tracking/backend/{temporal/lifecycle/issue_created/activities.py, temporal/fingerprint_embedding_result/activities.py, hogql_queries/error_tracking_similar_issues_query_runner.py, embedding.py}`.

Docs and blog: [Replay Vision](https://posthog.com/docs/replay-vision), [Scanner types](https://posthog.com/docs/replay-vision/scanner-types), [Observations](https://posthog.com/docs/replay-vision/observations), [Creating scanners](https://posthog.com/docs/replay-vision/creating-scanners), [Running scanners](https://posthog.com/docs/replay-vision/running-scanners), [Quota and limits](https://posthog.com/docs/replay-vision/quota-and-limits), [Digests and alerts](https://posthog.com/docs/replay-vision/actions), [Self-driving](https://posthog.com/docs/self-driving), [Signals](https://posthog.com/docs/self-driving/signals), [Reports](https://posthog.com/docs/self-driving/reports), [Inbox](https://posthog.com/docs/self-driving/inbox), [Signal sources](https://posthog.com/docs/self-driving/inbox/sources), [Research tasks](https://posthog.com/docs/self-driving/inbox/research), [Implementation](https://posthog.com/docs/self-driving/inbox/implementation), [The self-improving loop](https://posthog.com/docs/self-driving/self-improving-loop), [Anatomy of a pull request](https://posthog.com/docs/self-driving/anatomy-of-a-pr), [Scouts](https://posthog.com/docs/self-driving/scouts), [Grouping exceptions into issues](https://posthog.com/docs/error-tracking/grouping-issues), [Fingerprints](https://posthog.com/docs/error-tracking/fingerprints), [Issues and exceptions](https://posthog.com/docs/error-tracking/issues-and-exceptions), [Replay Vision blog post](https://posthog.com/blog/replay-vision), [PostHog Code and the self-driving product](https://posthog.com/blog/self-driving-product), [Changelog](https://posthog.com/changelog).
