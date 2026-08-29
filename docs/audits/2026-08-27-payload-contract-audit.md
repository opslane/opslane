# Payload contract failures and remediation plan

## Executive summary

1. The same stored digest is interpreted differently by Slack, the MCP tool, the API, and internal tools; that caused a customer-visible false message ("no digest exists" on a day Slack delivered five cards).
2. The audit found nine live defects, including three digest readers that ignore receipt items and two admin filters that reject valid job types.
3. The underlying problem: Go, TypeScript, and Vue often define the same database payload separately. When one copy changes, the others can silently return wrong results.
4. First: fix the customer-visible defects and give every digest reader one shared interpretation of stored payloads.
5. Then: add writer/reader compatibility tests and database constraints at the highest-risk boundaries, without breaking historical data or released SDKs.

## What broke

A customer asked the Opslane MCP tool for the daily digest and was told none had ever been delivered, minutes after Slack delivered that day's digest. Slack and MCP interpret the same stored digest differently, and no test checks that they show the same content. The digest holds two lists: new issues written up today, and older issues still waiting on a decision. Slack reads both; MCP reads only the first, which has been empty in production every day for a week.

## Why it keeps happening

There is no single definition of what most stored payloads contain. Each component keeps its own copy of the shape, the copies are synchronized by hand (sometimes only by a comment), and most readers turn a missing field into an empty value instead of an error. So when one side evolves, the other sides keep running and quietly show wrong results. Two surfaces are protected properly today (the SDK event wire format and the issue-triaged notification); roughly thirty others are not.

## Contracts we cannot change freely

| Boundary | Why compatibility matters | Examples |
|---|---|---|
| Public or independently deployed | Released SDK payloads must stay backward-compatible: old customer apps can keep sending them indefinitely. Same for what LLMs, browsers, and Slack consume. | `POST /api/v1/events` (protected), session/replay/sourcemap endpoints (unprotected), dashboard API, MCP tool output, Slack messages |
| Internal but stored | Old rows and queued jobs remain in the database during deployments, so even internal format changes need staged rollout: deploy readers that accept both formats, switch writers, settle existing rows, then drop the old format. | Job queue payloads, the digest pipeline's stored payloads, worker-written diagnosis/evidence/identity blobs |

## The tools, and where each fits

| Tool | Use it for | Current gap |
|---|---|---|
| A saved example payload checked by both the writer's and the reader's tests | Public contracts (immutable examples) and internal stored payloads (editable examples — changing one forces both test suites to move in the same PR) | Exists for 2 of ~30 surfaces |
| Database rejects unsupported values (enums, CHECK constraints) | Status and vocabulary columns | Applied to some columns; several vocabularies are free text with three hand-copies of the allowed values |
| One validated definition, imported everywhere | Same-language consumers (dashboard responses, shared TS types) | Dashboard duplicates types by hand and trusts responses without validation |

## Live defects (shipping today)

Ordered by customer impact. Evidence citations are in the appendix.

| # | Impact | Defect | Fix |
|---|---|---|---|
| 1 | Customers told "no digest exists" after one was delivered | Three readers (MCP tool, `GET /digest/latest`, digest-eval) ignore receipt items and treat "no new cards" as "no digest" | Load the full stored payload through one shared, version-aware accessor; make empty states honest ("delivered, nothing new, N waiting on you"). API change stays additive |
| 2 | Delivery analytics permanently wrong | The delivered-digest analytics event reads fields the current digest format no longer produces, so `new_issues` is always 0 | Define the metric for the current format first (product decision), then re-point the event |
| 3 | Admin API rejects valid work | Two admin job filters omit valid job types (`digest_write`; also `issue_inquiry`, `stack_resolve` in one) | Add the missing types. No renames (see appendix: `fix` and `error_fix` are different pipelines, not spelling drift) |
| 4 | Dead code misleads readers | The digest freeze query asks for a diagnosis field no writer produces; it always falls back | Delete the dead read |
| 5 | Possibly wrong readiness data | A past one-shot data migration counted any named verification check as evidence, even failed ones | Decide whether that was intended; if not, ship a new corrective migration (the old one cannot be edited or rerun) |
| 6 | Customers can see two different digest formats | "Send test" previews the legacy digest format; scheduled delivery uses the current one | Make test-send render the current pipeline, or label it; retire the legacy lane after |
| 7 | TS code cannot type today's digest | Shared TypeScript types do not describe all fields in the current digest format | Bring shared types up to the current version |
| 8 | Digest cards missing recording links | Current receipt generation omits recording links and impact details the renderer can still display | Populate the fields |
| 9 | PRs claim "0 console errors" when data is absent | Missing replay data renders as zeros instead of "data unavailable" | Fix the empty state; the endpoint contract itself stays |

**Test coverage gap** (not a shipping bug): one migration test round-trips a hand-made payload unlike anything production writes; replace it with an example generated by the real writer.

**Pre-expansion risk** (works today, breaks on growth): notification-config encryption binds "slack" as a constant on write but the destination type on read. Fine while Slack is the only type; a second destination type would produce undecryptable rows. Fix with exact type binding before expansion — no cross-type fallback.

## Where the next incident will come from

Ordered by likelihood and customer impact. Plain statements here; field-level detail in the appendix.

| Stored data | What could silently go wrong | Consequence |
|---|---|---|
| Digest input snapshots | A renamed Go field becomes missing data inside the TS digest writer | Wrong or ungrounded digest cards |
| Issue-identity envelopes | A mismatched frame field changes the fingerprint computation | Events permanently grouped under the wrong issue |
| Diagnosis blobs | Three writers produce different shapes; four readers assume specific fields | Digest and triage read stale or absent diagnosis data |
| Verification evidence | The most-read column in the repo, all readers silent, dashboard copy already 4 fields stale | Dashboard and receipts show incomplete evidence |
| Queued job payloads | Malformed required data logs a warning and the job completes "successfully" | Work silently skipped (score sync dropped, fixes run undiagnosed, full refreshes instead of targeted ones) |
| Reason codes | Go hand-copies subsets of the TS list; new codes silently default to "retriable" | Wrong retry/priority behavior for new failure classes |
| Platform tokens | Unknown platform silently routed as JavaScript | Python-style work mis-handled without a trace |
| Debug metadata | Three parallel declarations; drift downgrades to "no source map" | Issue identity settles permanently on the wrong fingerprint |
| Delivery policy | Go handles one value, TS handles the other; a third value disables both | Notifications silently stop |

## Roadmap

Three rules govern everything below: public contracts stay backward-compatible forever; stored internal formats change only through staged deployments; every payload with more than one reader gets either one validated definition or a writer/reader compatibility test.

**Now — close the incident class (first PR series).** Build the shared digest accessor: one version-aware function that decides which cards, receipts, alerts, and counts a stored digest contains. Move MCP, the API, and digest-eval onto it without changing their existing response contracts (additive only; Slack's per-version renderers stay). Then add the cross-channel consistency test (given the same digest, every channel starts from the same item set; channel caps and formatting may differ) and a receipts-only end-to-end test, since receipts-only is the dominant production shape and is untested. Fix defects 2-9 as independent small PRs (2 and 5 need a product decision before code).

**Next — test the highest-risk stored payloads across Go and TypeScript.** Saved example payloads generated by the real writer's tests and replayed by the reader's tests, one per payload: digest input snapshots, diagnosis blobs (one per writer variant), verification evidence, identity envelopes (regenerate the current hand-authored example from the real writer), and one schema per queued-job type. Job validation gets teeth: malformed required payloads fail into retry/dead-letter before side effects instead of completing green; tolerance only for explicitly optional or legacy-versioned fields. The digest writer payload gets a version field, deployed reader-first.

**Later — remove duplicated interpretations.** Dashboard API responses defined and validated once, with tests that Go emits the same shape (importing shared types alone binds nothing — validation at the fetch boundary is the point). Reason codes move to one registry that records each code's behavior, generating both languages' definitions. The MCP formatter's duplicate digest structs collapse onto the canonical ones. Remaining coverage checklist: fixtures for the SDK session/replay/sourcemap endpoints (public, so immutable examples), a logged decision when platform downgrades an unknown token, a shared debug-metadata example, a third-value guard for delivery policy. Finally, document these rules and the contract inventory in the repository (AGENTS.md + docs/contracts).

**Compatibility constraints** (deliberately unchanged): `network_timings`, legacy stack-resolution fallbacks, the legacy replay endpoints, the replay `signals` body, and the unused `failed` job status all stay — they are obligations to released SDKs and to rows already in the database, even where no current code writes them.

Sequencing: "Now" items are small and independent. "Next" items are each roughly a fixture plus two test-suite changes. The dashboard work in "Later" is the largest single item. Estimates need owner review before they become commitments.

---

## Appendix: evidence and method

**Method.** Four parallel code surveys (digest payload consumers; cross-language job/DB contracts; externally consumed surfaces; every jsonb and enum-like column), then three adversarial review rounds with Codex, which spot-checked citations against commit `800da86` and corrected several draft claims. Full review history in git.

**Defect evidence.**
1. `db/queries.go:82` (reads only `generated_cards`), `mcp/format.go:123` ("no digest" on zero cards), `handler/read_api.go:222`, `cmd/digest-eval/main.go:62`. Prod AMFJ 2 digests receipts-only Aug 21-27 (verified via read-only prod SQL).
2. `notify/dispatcher.go:439-440` reads `TopNewIssues`/`NeedsHumanBacklog` (v1-only). Proposed metric: `new_issues` = cards with `label=="new"`; backlog = uncapped receipts + overflow.
3. `handler/admin.go:15`, `db/admin.go:98`. `fix` runs `processFixJob` while `error_fix` runs investigation (`worker/src/index.ts:385`); `inquiry` at `worker/src/inquiry/job.ts:190` is a usage-event phase, not a job type.
4. `digest/freeze.go:148` reads `diagnosis->>'summary'`; writers emit no such key.
5. `047_readiness_backfill.sql:32-39`; one-shot guard via `applied_data_migrations`; its own test treats any named check as usable.
6. `handler/notifications.go:365` (v2 Sweeper lane) vs `digest/scheduler.go` (v4).
7. `shared/src/types.ts` `DigestReceiptFields`; worker `c0-contracts.test.ts` pins a v2 example.
8. `digest/actionable.go:210-222` omits `SessionURL`/`ImpactClass` (renderer-visible) and `ClusterIncidentIDs` (not consumed by the v4 renderer; lower priority).
9. `worker/src/pr.ts:275`; no current SDK sends `signals`, but `CompleteReplay` accepts them.
Coverage gap: `db/migration_044_test.go:115,133` asserts `policy_basis->'basis'`; the writer emits `{v, identified_users, recent_anon_sessions}` (`worker/src/db.ts:238-250`).
AAD risk: writers hardcode `"slack"` (`handler/notifications.go:180,252`); readers use the DB `type` column (`notify/dispatcher.go:357-359`). Exact binding on both sides; re-encrypt or version mismatched rows explicitly if any ever exist; no cross-type fallback (ciphertext/type confusion).

**Drift-risk evidence.**
- Digest snapshots: Go writer `digest/freeze.go:17-39`; TS reader `worker/src/digest-writer/job.ts:16-34` (unvalidated cast; `!episodeId` is the only check). Existing wrinkle: Go always emits `occurrenceCount`, TS treats it as optional and the optionality is load-bearing (`job.ts:79,105-109`).
- Identity envelopes: TS writer `resolve/envelope.ts:5-24`; Go reader `identity/canonical.go:13-32` (sync by comment); loud on version/empty, silent per-frame. Fixture `test-fixtures/grouping/resolved-envelope-v2.json` is hand-authored, not writer-generated.
- Diagnosis: TS writers `worker/src/index.ts:736,994,1028` (three key sets); Go readers `db/queries.go:1571`, `digest/build.go:32-43`, `digest/freeze.go:148`, `047`.
- Verification evidence: writer `worker/src/db.ts:1275+`; readers in Go SQL (047), `read_api.go:201`, worker ×3, Vue `EvidenceWell.vue`/`ProvenanceFooter.vue`; dashboard's `EvidenceRecord` copy in `dashboard/src/types/api.ts:153` is 4 fields behind `shared/src/types.ts:237`.
- Job payloads: `score_sync` Go SQL literal (`db/queries.go:2188,2326`) vs TS keys (`score-sync.ts:80-91`, warn+drop); `product_context` (`product-context/job.ts:272`, silent full refresh); `fix` diagnosis (`index.ts:1501`, silent null); `ci_watch` camelCase (`db.ts:1593`) vs Go snake_case elsewhere; job-type lists in `shared/src/types.ts:479`, `db.ts:625`, `handler/admin.go:15`.
- Reason codes: union `shared/src/types.ts:186-213`; Go subsets `db/queries.go:651-666`, `priority/sweeper.go:14`. Registry approach: union membership alone cannot generate behavior sets; the registry must record each code's categories.
- Platform: `db.ts:684-687` → `platform.ts:12-16`.
- Debug metadata: `shared/src/types.ts:72-80`, `handler/error_event.go:322-330`, `resolve-stack.ts:57-68`; drift settles identity as `no_map` (`resolve/job.ts:105-108`).
- Rendered payload: MCP partial duplicate `mcp/format.go:10-25` (digest-eval already imports `notify.EventPayload`).
- Delivery policy: Go `db/notifications.go:226,262` (`immediate`); TS `db.ts:1186,1198` (`post_triage`); also enumerated in `handler/notifications.go:26` and `dashboard/src/types/api.ts:81`.

**Healthy surfaces for contrast.** `POST /api/v1/events`: frozen fixtures per SDK release (`test-fixtures/wire/events/`), replayed by `handler/wire_compat_test.go` and asserted byte-exact by the SDKs' wire-shape tests, immutability enforced by `scripts/check-wire-fixtures.mjs` from a trusted CI context with a reviewed `contract-change` label as the only escape. `issue.triaged`: one fixture asserted from both the worker producer test and the Go renderer test. Slack digests: stored-payload golden + retained per-version renderers, so old undelivered events render with the format they were written in.

**Fixture mechanics for internal payloads** (implementation note): new `test-fixtures/internal/` prefix, not under the append-only `wire/` guard; fixtures generated by producer tests, replayed by consumer tests; CI asserts every internal fixture is referenced by at least one test on each side; editing one therefore moves both suites in the same PR. TS validation via zod schemas in `shared/`; Go via mirrored structs pinned by the same fixture; reason-code registry generation via a checked-in generated file plus a CI staleness test. Dashboard: zod DTOs validated in `fetchWithAuth`, route fixtures generated from Go handler tests; supersedes `packages/dashboard/AGENTS.md`'s "contracts live in `src/types/api.ts`" (update it in the same change).
