# Known-problems pipeline for friction

Date: 2026-09-11. Status: rev 6 (defect-only cards and fixes, insight investigation threshold), amended after the 2026-09-12 production replay and two Codex plan rounds (see plan for the logs). Supersedes the friction half of `docs/design/2026-08-31-session-narratives.md` (grouping, promotion, investigation gate, digest inputs). Narration, frame verification, the error lane, and the fix pipeline are unchanged unless named below.

## What is broken, in plain words

The digest told a customer that 91 users hit a date picker bug. One recording showed something like it. The other 299 recordings in that group were about search boxes, bulk editing, scrolling, and column pickers. They were grouped together because they shared a category label and a page, the investigator was shown one of them as "the incident", and the digest printed the group's user count under that story.

Measured on AMFJ, last 14 days:

- Category plus route grouping produced buckets holding up to 47 distinct problems (300 signals, 117 elements).
- The same recording narrated ten times found the obvious problems every time and the small ones one to four times in ten. The category label for the same problem flipped between runs. Two runs' signal sets agreed about half the time.
- A running list of problems with per-recording matching and a strong-model re-read before publishing produced cards whose matched counts over-stated confirmed counts by 2x to 5x, and held back every dead-click bucket.
- Text-only narration was contradicted by screenshots on 23 of 54 observations; half of its "nothing happened on screen" claims were wrong. Frames at the cited moment fixed most of that.
- Embedding tickets (not sessions) surfaces duplicates word-matching missed; one-fix rate by cosine band: 0.90+ 3/3, 0.85–0.90 69%, 0.80–0.85 57%.

Evidence: `docs/research/2026-09-11-posthog-session-summary-pipeline.md`, scratchpad spikes recorded in memory (theme grouping, narrator stability, researcher pipeline, embedding retrieval, vision vs text).

## Principle

Nothing reaches a customer unless it was seen in several recordings and checked by something other than the thing that found it. Missing a borderline problem is acceptable. Publishing a wrong one is not. Held-back problems are tracked internally and never shown.

## Glossary

- **Observation**: one sentence the narrator writes about one difficulty in one recording, with cited timeline lines. Unchanged concept, new shape (no category, no severity).
- **Ticket**: an entry on the project's known-problem list: name, control, steps, what happened, kind (defect or design insight), screens seen on. Written once by the strong model when a problem is first seen. Identity is the ticket id; it survives label edits.
- **Match**: a recording linked to a ticket by the cheap pass. Matched count is a lead, not a fact.
- **Confirmation read**: the strong model re-reads one matched recording, with frames, and says whether it really shows the ticket. Confirmed count and confirmed rate come only from these.
- **Card**: the digest entry for a ticket that passed confirmation.

## Pipeline

### 1. Narrate (changed output)

Per session, unchanged model and timeline. Output per observation: `what`, `evidence_lines`, and, only when the cheap pass cannot match a ticket, draft `name`, `control`, `steps`. No `category`, no `severity`. The nine category definitions stay in the prompt as "things to look for".

### 2. Verify frames (changed policy)

Unchanged job. Policy change: `inconclusive` observations are dropped, not passed through. Any observation whose sentence claims absence of a screen response (no response, no feedback, no indicator, nothing happened) must be `confirmed` by frames to survive.

### 3. Match (new)

Per observation, one cheap-model call (Haiku 4.5, switchable) with a shortlist of candidate tickets: tickets whose `screens` include a screen in this session, plus the 10 largest by matched count. Output: `ticket_id` or a draft. Matches increment the ticket's matched recordings and identified users, and store `{session_id, evidence_lines}`.

### 4. First careful look (new)

Only when step 3 produced a draft. The strong model (Sonnet 5) gets the session timeline, the draft, and the 10 nearest existing tickets by embedding of the draft text. It returns one of: `same_as` an existing ticket (then match it), `not_a_problem` (drop; rejects only normal use, idle, visible success), or `create` with the final ticket fields. New tickets get an embedding.

### 5. Promote and confirm (new)

Tickets are scoped per project **and environment**, matching the existing incident boundary. Trigger: a ticket reaches 3 matched recordings. Confirmation runs in batches over unread matches: first batch up to 10 (30 if matched count is already over 50), later batches up to 10 whenever 10 new matches have arrived since the batch that was last taken, before and after publication alike. Reads spread across identified users. Each read: strong model, timeline plus frames around the cited lines, outcome `confirmed | refuted | inconclusive | unavailable`, plus `evidence_lines`, `note`, `cost_to_user`. The note is customer-facing prose (it becomes the card's steps): no line ids, no mention of timelines, screenshots or frames; a note that carries them is rejected and the read retried. `unavailable` (capture failure, malformed output, budget) is retryable and never counts, and it consumes no read budget: the budget is reserved only once a capture has produced frames. A replay that aborts the app's cross-origin stylesheets, fonts or images is not a capture failure; the read runs with a note that styling may be incomplete. `inconclusive` counts as a read but not as confirmed.

Publish when: confirmed ≥ 3, distinct identified users among confirmed ≥ 2 when any identity is known, and confirmed / (confirmed + refuted + inconclusive) ≥ 0.40. A published ticket whose rate later falls below 0.25 over ≥ 10 reads is unpublished automatically (its incident is archived and it leaves the digest). Reads are keyed by (ticket, session). Ticket definitions (name, control, what happened) are immutable after creation; a wrong name is fixed by archiving the ticket. The quote is presentation and may be rewritten at publication; the confirmer's note is customer prose that feeds the writer as evidence and is never shown as a steps line.

Internal-only numbers: matched count (when to spend), checked count (the denominator), confirmed rate (ticket sharpness and pipeline health). None of them is shown to a customer.

### 6. Digest: one list, one card, one button

The digest is a single list of verified issues. No lanes ("Needs a decision", "Session intelligence", "Fixes ready"), no per-card "Needs you" line, no impact roll-up ("visits", "recovered"), and none of the pipeline's internal counts (matched, checked, rates). The customer never sees the word "confirmed" or the defect/insight kind.

Card contract: issue name; what users hit (rewritten at publication from verified sessions); "N users · M sessions this week" and the accounts, counted over verified sessions only; one replay link to a verified session (the one closest to the median cost, not the most dramatic); the cause line (always present, since a card requires one); one button: "Review PR" when a PR exists, "Fix in progress" when a fix attempt is running, otherwise "Create fix PR", which starts the fix immediately (the cause already exists). There is no steps line; the replay is the reproduction.

Entry rule: a ticket enters the digest only when it is verified **and** its investigation found a cause that explains at least half of the verified recordings. No cause, no card; the verified ticket stays on the dashboard only. There is no time-based fallback. Only tickets of kind defect get a card or a fix; insight tickets (kind ux_insight) are tracked, listed on the dashboard, never enter the digest, and never become a PR by click or by autonomy. Defects are investigated automatically on publication. Insights are investigated automatically only once at least 5 confirmed identified users have hit them (`FRICTION_INSIGHT_INVESTIGATE_USERS`), and that rule applies to reinvestigation too; the kind stays internal. Auto-PR follows the existing project setting `friction_autonomy` (`ask_first` | `auto_fix`; `auto_fix_ux` removed) with a cap of 5 open fix PRs per project; it governs only whether a found cause becomes a PR without a click. The digest ends with one line, "Merged this week", listing cards whose PR merged in the last seven days.

### 7. Investigation (changed input)

The existing investigator runs for every verified defect immediately on publication, and for a verified insight once its confirmed identified users reach the threshold above, and receives the ticket plus the verified observations only, not the whole matched set. Its verdict partitions the verified observations into explained and unexplained; the cause line is shown only when the explained share is at least half. A verdict with no code cause, or with coverage under half, keeps the ticket off the digest; it is retried when verified evidence grows. The fix pipeline is unchanged for defects; an insight never enters it (no button, no autonomy, a queued fix job for one is refused).

### 8. Duplicate check at the publish gate (replaces the weekly sweep)

A duplicate only matters if the customer sees it twice, so the check runs at the moment a ticket passes the publish rule, before its card exists. Candidates: the nearest published tickets by embedding with similarity ≥ 0.75 (`FRICTION_FOLD_MIN_SIMILARITY`, at most 10). The spike measured one-fix rates of 57% and above from 0.80; the production replay of 2026-09-12 found two tickets for one bug at 0.775, and since the one-fix question is the precision gate, retrieval favours recall. Every one-fix answer is recorded in `friction_gate_decisions` so a duplicate card can be traced to its decision. For each, the strong model answers the one-fix question once. On yes, the new ticket is not published: its verified evidence is added to the existing published ticket, its status becomes `merged` with `merged_into`, and the existing card simply gains users. On no, it publishes on its own. Two unpublished duplicates are left alone until one publishes. No weekly sweep, no merging of two published tickets, no name-based rules.

## Data

Migration `078_friction_tickets.sql`, all additive:

- `friction_tickets`: definition (name, control, what_happened, kind, steps, screens_confirmed, screens_proposed), status (`tracking` | `published` | `unpublished` | `merged` | `archived`), embedding (1536) + embedding_model, matched_count, arrival_boundary, next_arrival_number, evidence_version, live_generation, fold_retries, fixed_at, cohort_cutoff, reconcile_needed, reinvestigate_needed, merged_into.
- `friction_observation_decisions`: one row per atomic observation (signal) with its decision (`reserved` | `matched` | `created` | `not_a_problem`) and ticket.
- `friction_ticket_matches` (ticket, session, end_user, arrival_number, source, occurred_at) and `friction_ticket_match_observations` (ticket, session, signal): the counting unit and the evidence unit.
- `friction_session_processed`: the ledger of narratives the match job has finished, keyed by narrative id.
- `friction_confirm_batches`, `friction_confirmation_budget`, `friction_check_attempts` (staged reads incl. `unavailable`), `friction_checks` (finalized reads), `friction_unavailable_retries`.
- `friction_incident_evidence`: the verified signals an incident generation links.
- `friction_fix_attempts`, `friction_investigation_results`, `friction_pr_events`, `friction_fix_failures`.
- `friction_gate_decisions`: every one-fix answer asked at the publish gate (candidate, similarity, answer, reason).
- `error_groups` gains `ticket_id`, `publication_generation`, `fix_substate`, `investigation_status`, `evidence_version_used`, `explained_signal_ids`, `investigation_execution`. A ticket's incident is an `error_groups` row of kind `friction` with `ticket_id` set; legacy route-bucket rows (no `ticket_id`) are archived at cutover.
- `friction_signals` gains `observation_id`, `evidence_lines`, `narrative_id`.

## Cutover and reseed

No shadow, but a staged cutover, not a boot-time flip: (1) deploy the additive migration and ingestion; (2) deploy the worker, whose narrative seam now enqueues `friction_match` and no longer promotes buckets; (3) once no old worker is running, run the one-off archive script (archives route-bucket friction groups without a PR, fails their pending investigate jobs); (4) run the backfill over the last 14 days of stored narratives, restart-safe and metered, with `matched_at` taken from the recording time; (5) confirmations drain; (6) next digest. Old links keep resolving.

## Cost shape (AMFJ, ~166 sessions/day)

Cheap pass 166 calls/day. First looks about 45/day, falling as the list fills. Confirmation reads only for tickets whose status changes, roughly 30 to 50/day. Embeddings about 350/day. Strong-model calls per day stay roughly flat with traffic.

## Out of scope

Frames-first narration on a sampled slice (later experiment). Changing the error lane. Human editing UI for tickets beyond a status flag. Replacing frame verification with video.

## Open choices

- Embedding provider: OpenAI `text-embedding-3-small` (1536), behind one function; model name stored with each vector.
- Reads per card may be tuned after a week of live volume.


Rev 5 note (2026-09-11): definitions immutable; see `2026-09-11-known-problems-lifecycle.md` for the full lifecycle rulebook.

Rev 6 note (2026-09-12): after the 200-recording production replay: defect-only cards and fixes, insight investigation threshold, no steps line, retrieval floor 0.75 with the gate audit table `friction_gate_decisions`, unavailable reads consume no budget, aborted external assets are a degraded capture. `projects.default_branch` is a cache the worker writes from the repository's default branch, not a setting.
