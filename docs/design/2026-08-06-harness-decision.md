# What to keep from the diagnosis-first branch, and what to build next

**Status:** Proposed — revised after two adversarial review passes
**Date:** 2026-08-06
**Supersedes the execution half of:** `docs/superpowers/plans/2026-08-06-diagnosis-first-m0-m1.md`
**Design reference:** `docs/design/incident-conclusions.md`

## Why this document exists

The branch `abhishekray07/agent-improvement` carries 26 commits not on
`origin/main`, built to a plan whose measurements were wrong in specific ways.
This document decides what survives, what is deleted now, and what is measured
before it ships.

It is not an implementation plan. It is the set of decisions one would execute.

## What we measured, and what it is worth

Six real closed bugs from three frontend applications, each with the file list of
its merged fix as hidden ground truth.

| | ours | Claude Agent SDK |
| --- | --- | --- |
| cited a file the fix touched | 2/6 | 6/6 |
| produced an adjudication | 4/6 | n/a (no evidence gate) |
| cost | not collected by the eval | $4.67 |

**The comparison is not matched, and every asymmetry favours us.**

- **Retries.** `run-apps.mjs:36-42` retries ours up to three times with backoff.
  `run-sdk.mjs:51-68` has one `try`/`catch` and no retry.
- **Turns.** `INVESTIGATION_MAX_TURNS=30` sets only the dossier phase.
  `ADJUDICATION_MAX_TURNS` (`investigate.ts:17`) defaults to 8 independently and
  was not overridden, so we ran 30 + 8 against the SDK's 30.
- **Tools.** Same class, not the same behaviour: read limits, listing depth and
  regex dialect differ from `Read`/`Glob`/`Grep`.

So: **given more retries and more total turns, we cited a fix-touched file in 2
of 6 where the SDK did so in 6 of 6.** Loop, prompts, architecture, output
contract and tool implementations all differ at once. **No claim in this document
attributes that gap to any single one of them,** including `readonly-agent.ts`
and including the second agent.

### The score is soft in three ways

**Ground truth is "files the merged fix touched," not the root cause.** That list
includes tests, generated files and incidental cleanup. Matching one shows
proximity, not correct diagnosis. Fix-file overlap is too weak on its own to
select a diagnosis architecture; positive cases need diagnosis-level judgement,
not just file localisation.

**The metric and the prompt form a gaming loop, and we built both in one commit.**
`investigate.ts:172` tells the adjudicator *"list each file you would expect to
change."* `run-apps.mjs:48` scores a hit if **any** citation matches **any**
ground-truth file. Longer lists raise the expected score without improving
diagnosis. Our 2/6 is an upper bound, and any prompt change that lengthens
citations will read as improvement whether or not it is one.

**Denominators were reported inconsistently.** `run-apps.mjs:62` prints hits over
*answered* (2/4); this document says 2/6, hits over *all*. Both must be reported.

### Numbers that must not be cited again

- **"The SDK found 5/5."** That arm had a shell. Clones fetch every ref, so for
  `documenso#2945` the fix commit `58f0f5da` is reachable and one
  `git log --all --grep` returns it.
- **"Raising turns to 30 fixes it."** Claimed off 3/3 on three cases; the same
  three at the same setting went 1/3 next run.
- **"Ours 2/6, SDK 5/6."** Unequal turns, unequal tools, and a scorer reading a
  renamed field.

### Variance outlasts all of it

One case run nine times on identical code and input gave five hits and four
misses. **No single pass settles anything here.**

## What is wrong with our pipeline

Of six cases: four produced an adjudication and two of those cited a fix-touched
file, so **two answered and were not scored correct**; two produced no
adjudication. `insufficient` is an adjudication *value*, not its absence.

The observable pattern is the adjudicator reaching for `insufficient`. **We have
not established it is wrong to do so.** `parseDossier`
(`dossier-schema.ts:217-220`) only requires `supports` to be a non-empty string
array; it never checks the evidence was observed or that it supports the claim.
An adjudicator refusing a dossier of unverified assertions may be correct.
Telling "miscalibrated gate" from "correctly rejecting bad dossiers" requires
reading dossiers from failing runs. That has not been done, and it is cheap.

## Decisions made now, without further measurement

### Retire the two-agent split as the production default

Its original justification — tracing one fixture, whose family was later found
broken — does not survive. No safety benefit has been demonstrated. It costs a
second model pass and adds a refusal surface that accounts for our two
no-adjudication runs. **Continued retention should not be the null hypothesis.**

Collapse to a single agent that submits a diagnosis directly. Keep
`dossier-schema.ts` in git history; it can be earned back by a trial that beats
the single agent, but it does not ship as the default while unjustified.

This also collapses the structure question out of the comparison below, taking it
from four cells to two.

### Delete the synthetic hard-case fixtures

`eval/cases/hard-*` and `eval/fixtures-source/hard-cases-reference.ts`. Every
calibration made against these four-file toys was wrong when it met a real
repository: the turn budget, the claim nothing reaches `conclusive`, and the H4
case that had to be rebuilt. We have 22 real bugs. Delete them now rather than
carrying them as "on trial".

### Fix the known authorization defects

These are defects we can see in the code. They do not need a benchmark and are
**not gated on the eval repair**.

- `classify.ts:110` accepts an external conclusion when `rejected` holds any one
  string. It must verify each *supported local candidate* was rejected.
- `classify.ts:161-176` authorises `code_fix` when *any* citation lands
  in-surface, even if the primary cause is outside it. Authorise on the primary
  citation; treat secondary citations as advisory.
- `fix-surface.ts` validates the *cited diagnosis path* only. There is no
  write-time enforcement and no TOCTOU guarantee. Add the check at write time,
  where the authorization actually matters.
- `globs: null` means the whole repository is writable (`fix-surface.ts:79`) and
  `investigate.ts:325` only logs it. Decide whether that default is acceptable;
  if not, fail closed.
- Migrations `032`/`033` are described as immutable. Either enforce it in the
  schema or stop calling it that.

### Replace the stale triage rule with a concrete policy

`agent-fix.ts:271` — "Error is an infrastructure/network issue (CORS, DNS,
timeout, 502, 503)" — classifies by error shape, which this work exists to
replace. It is live in every fix job (`agent-fix.ts:581`) and it is also a cost
gate, so it cannot simply be deleted.

**The policy:** the investigation already produced a routed outcome and persisted
it (migration `033`). Fix jobs read that persisted decision instead of
re-triaging by error shape. `triageError`'s shape-based rules come out entirely;
the cost gate is preserved because `not_actionable` and `needs_more_context`
never reach the fix path. The eval must then exercise this path, which it
currently bypasses: `run-apps.mjs:38` calls `investigateError` directly.

## Keep

| Area | Files | Basis |
| --- | --- | --- |
| Fix-surface path resolution | `fix-surface.ts`, its two test files | Closes a real symlink escape: `client/vendor` → `../server` made `client/vendor/app.py` match `client/**` while writing to the backend. Keep the resolver; add write-time enforcement per above. |
| Deterministic routing | `classify.ts`, `__tests__/classify.test.ts` | Right shape — pure, no model, no I/O, keeps the decision in our code. Ships with the two authorization fixes above. Note determinism is not correctness, and `evidence_strength` is a model self-report, so routing on it does not by itself create a safety boundary. |
| Diagnosis contracts | `shared/src/diagnosis.ts`, `shared/src/types.ts` | Shared, runtime-free. `Dossier` and `rejected` retire with the split; `Diagnosis`, `EvidenceStrength` and `HypothesisKind` stay. |
| Decision persistence | `032`, `033`, `queries.go`, `db.ts` | Independent of how the diagnosis was produced, and now load-bearing for the triage replacement. |
| Three-way routing | `index.ts` | Verified: only `confidence === 'high'` reaches the fix path (`index.ts:597`, `index.ts:706`), so `suggestive` parks for a human. |
| Real-bug corpus | `eval/github-cases/*.jsonl` | 22 real closed bugs. The most valuable artifact here, with the caveats above. |

## Repair the eval

The instrument produced four wrong numbers today. This gates the *comparison*
below — it does not gate the defect fixes above.

1. **Ground-truth leak.** Fetch only the base commit and its ancestry; do not
   clone all refs. Specify the exact fetch: `git init` plus
   `git fetch --depth 1 origin <base_sha>`, no remote-tracking refs. Assert the
   invariant directly by attempting to resolve the known fix SHA and failing if
   it succeeds — and note that this is a spot check, not a proof, so the fetch
   design is what carries the guarantee. **Existing clones under
   `/tmp/opslane-gheval-repos/` are contaminated and are reused when present**
   (`run-apps.mjs:29`, `run-sdk.mjs:30`); invalidating that cache is part of this
   item.
2. **Equalise the arms.** Budget in **tokens and dollars**, not turns — a turn is
   not a comparable unit across differently structured systems. Same retry
   policy, same eligibility, and a stated rule for which attempt counts.
   Equalise the tool implementations; disclosure does not remove a confound.
3. **No silent partial runs.** `run-apps.mjs` defaults to 3 cases and
   `run-sdk.mjs` to 2, and the summary looks identical to a full run. Default to
   the whole file; print any subset.
4. **Report honestly.** Both denominators, `insufficient` counted separately from
   no-adjudication, repeats with spread shown, no bare single-run scores.
5. **Collect cost** on both sides with one definition: model spend including
   retries, cache reads, and discarded attempts. The worker already computes it
   (`investigate.ts:321`); the eval drops it.
6. **Score the primary citation only.** One rule, not three. The first entry in
   `cause_locations` is the claim; the rest are advisory and unscored. This
   removes the incentive to pad, which reporting precision alongside recall does
   not.
7. **Freeze a held-out split** by repository, as a checked-in manifest, with the
   rule that prompts are not tuned after viewing held-out results. With only
   three application repositories, repository-level inference is weak; state that
   limit rather than implying the split makes results generalisable.

## The comparison, and how it decides

With the split retired, one live question remains: **our loop or the SDK**, both
running a single agent. Two cells, not four.

- **Cases:** all 22, tuning split held out per item 7.
- **Repeats:** 3 per case per cell. 132 runs. At the observed SDK rate of
  $0.78/case that is roughly $103 for the SDK cell plus our own, so call it
  **$150–200 total**. Five repeats would be ~$171 for the SDK cell alone and is
  not justified by anything we have measured.
- **Metric:** primary-citation hit rate over all cases, averaged within case
  first so a flaky case cannot dominate.
- **Decision rule:** paired by case. Compute the paired difference, bootstrap
  over cases for a one-sided 90% bound, and declare a winner only if that bound
  exceeds a predeclared margin δ. **Set δ = 2 cases out of 22 (~9pp)** — below
  that, the observed flip rate makes the difference uninterpretable. If the bound
  does not clear δ, the result is **inconclusive and the incumbent stays**. This
  replaces the earlier "mean exceeds the observed spread", which had no
  statistical meaning.
- **Veto:** a variant that wins on hit rate still loses if its **false
  authorization rate** — authorising `code_fix` on a case with no actionable
  local cause — has an upper 90% bound above **zero events in the safety set**.
  A wrong fix is worse than a `needs_human`.

**Forced submission is measured inside this comparison, not after it.** Our loop
forces the terminal tool call on the last turn (`readonly-agent.ts:148-150`) and
the SDK has no equivalent. Run our cell both ways and record how many successful
submissions happened *only* on the forced final turn. That number prices the
loss. Measuring it after choosing a loop would contaminate the choice.

**What this comparison cannot decide.** Fix-file overlap cannot measure refusal
quality or safety. Build the safety set first: cases with no actionable local
cause, cases with a tempting-but-wrong local candidate, and scoring for false
authorization. Those cases do not exist yet and the veto above depends on them.

## Shipping gates for the SDK

Answers required before migration ships, not questions to revisit.

- **Transcripts on disk.** The subprocess writes session transcripts containing
  customer source. Needs a per-incident `CLAUDE_CONFIG_DIR` on ephemeral storage
  and a guaranteed cleanup path, or it violates our replay-privacy posture.
- **Redaction coverage.** Our vault redacts every event, tool input/output and
  error `cause`. The SDK's built-in spans and transcripts sit outside it.
  `PreToolUse`/`PostToolUse` hooks run in our process and carry our attributes;
  they do not cover transcript files.
- **Credential isolation.** In TypeScript, `env` replaces the inherited
  environment. The documented workaround is spreading `...process.env`, which
  hands every worker credential to a subprocess running against customer code.
  Use an explicit allowlist.
- **Permission traps.** `allowedTools` does not constrain `bypassPermissions`,
  which approves everything. Use `permissionMode: 'dontAsk'` with explicit
  `allowedTools` plus `disallowedTools` by bare name. Auto-approved tools never
  reach `canUseTool`; per-call checks belong in a `PreToolUse` hook.
- **Isolation.** `settingSources: []`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (auto
  memory loads regardless of `settingSources`), per-incident `CLAUDE_CONFIG_DIR`,
  explicit `cwd`.
- **Capacity.** One subprocess per concurrent incident. The ~1 GiB figure comes
  from Anthropic's hosting guidance, not from our measurement; measure it on our
  workload before sizing anything.

## Sequencing

**Track A — no measurement needed, start now.**

1. Retire the two-agent split; collapse to a single agent submitting a diagnosis.
2. Delete the synthetic hard-case fixtures.
3. Fix the authorization defects: primary-citation authorization, per-candidate
   rejection check, write-time surface enforcement, the `globs: null` default,
   persistence immutability.
4. Replace `triageError`'s shape rules with the persisted-decision policy, and
   give the eval a path that exercises it.

**Track B — the instrument, then the comparison.**

5. Repair the eval (items 1-7). Re-baseline with repeats. Do this *after* step 4
   so the baseline covers the triage path rather than immediately going stale.
6. Build the safety set: no-actionable-cause, tempting-but-wrong-local, false
   authorization scoring.
7. Run the two-cell comparison with forced submission varied inside our cell.
8. Migrate only if step 7 clears δ, with the shipping gates closed first.
9. Re-measure. **Then** consider tool breadth — which additionally requires
   moving investigation into a sandbox, since a shell against customer
   repository content on the worker is not acceptable and no eval repair creates
   that sandbox.

Track A does not wait for Track B.

## Open questions

- **Is the adjudicator miscalibrated, or correctly rejecting bad dossiers?** Read
  the dossiers from the failing runs. Cheap, and it may change step 1's shape.
- **Does the branch rebase cleanly?** It is 3 commits behind `origin/main`, which
  diverged in `tracing.ts`, `logger.ts` and the e2e suite.
