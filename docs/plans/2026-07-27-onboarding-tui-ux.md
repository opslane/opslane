# Onboarding Experience: Plan of Record

> **For agents:** read `AGENTS.md` first. Implement one slice at a time, tests before code, and verify with the commands at the end of this document. Do not start a slice marked **blocked** until its prerequisite is resolved.

**Goal:** `opslane onboard` explains what it will do, asks once, shows honest progress, proves errors actually arrive, and can put the code files back after a *managed* failure once it has started writing.

**Deliberately not a goal:** surviving a crash or `SIGKILL`. Snapshots live in memory, so a process that dies takes them with it. Durable snapshots and an `opslane onboard --restore` command are a separate piece of work, and the terminal copy must not imply otherwise.

**Scope of this document.** Everything for the onboarding experience: what already shipped, what is planned, and what is known-broken and unowned. It is both a plan and a record — the record matters because several confident claims in earlier revisions turned out to be false, and re-deriving them would land somewhere worse.

**Architecture:** Independently shippable slices. The controller/view seam is unchanged: `runOnboardCore` emits `CoreEvent`s, `app.tsx` parks prompts, `tui.tsx` is pure. The structural addition already made is **ActionPreview** — an immutable object the controller builds by reading disk, because the plan alone cannot say what will actually change.

**Tech Stack:** Ink 7.1.1, `@inkjs/ui` 2.0.0, React 19.2.8, Vitest, `ink-testing-library` 4.0.0, `@anthropic-ai/claude-agent-sdk`. No new runtime dependency in any slice.

---

## Where this stands

| | Work | State |
|---|---|---|
| — | Bugs found by running it | **shipped** — see below |
| 1 | Informed consent | **shipped** — `c8bd7b9`, `bfe6d88`. Two agreed follow-ups not built: see below |
| 2 | Progress honesty | **ready to build**, once Task 2.2's recovery accounting is specified |
| 3 | Mutation journal and recovery | **blocked** — needs a write-instrumentation seam and a snapshot API (Task 3.0) |
| 4 | Prove it works | **blocked** — the backend cannot currently tell us an error arrived (Task 4.0) |
| — | Outstanding, unowned | see the last section |

Slices ship independently, in order. **Slices 3 and 4 are not implementation-ready**: each opens with a Task N.0 naming the contract that must be designed first. Building either before that would produce a user-facing promise the machinery cannot keep — which is the specific failure this whole document exists to stop.

## Already shipped, and why it is not in a slice

None of this was planned. All of it came from running the thing and watching it fail.

| Commit | What |
|---|---|
| `2f23fca`, `2f49cd5` | A real-repo Detect eval, then making it able to *fail* — it previously scored structure only, so a plan could pass every check and still not work |
| `ceae136` | `.env.local` written where the bundler actually reads it. **2 of 2 real monorepos were silently broken**: excalidraw sets `envDir: "../"`, hoppscotch `"../../"`. The plan gained `env_dir`, chosen by the model like every other repo-specific fact |
| `cad1c7d`, `95ec209` | A check that builds the app and confirms the key reaches the browser bundle, then a cheaper variant that asks Vite directly for repos that cannot build |
| `2f3a5be` | The crash that left a repo half-applied when it had no lockfile. Two call sites disagreed about what a missing lockfile meant, and the one that ran *after* the writes rejected what the validator had accepted |
| `c8bd7b9`, `bfe6d88` | Slice 1, plus the corrections that only appeared on a real terminal |

**The lesson worth keeping:** every one of these passed a green test suite. The eval scored excalidraw and hoppscotch full marks while both produced apps that would never report. Nothing in this document should be believed because the tests pass.

## The design

- **One destructive approval on the unambiguous happy path.** Not "exactly one prompt" — that was in earlier revisions and is false. Discovery questions (`ask_user`), a restore offer, and feedback are legitimate separate interactions. What must not happen is the *same* consent being asked for three times.
- **Nothing destructive happens that the user did not agree to**, and the approval names every destructive action.
- **Deviation is impossible, not negotiable.** See `docs/decisions/onboard-deviation.md`.
- **Specificity is the delight.** Everything on screen is true and specific to this repository. No decorative animation — none of PostHog, Cursor, Manus, Replit, Bolt or Qatalog has one.

### What earlier revisions got wrong

Each was asserted confidently and is false. Verified against the code.

Line numbers below were correct when written and **will drift** — this is a durable record, so trust the symbol names and re-locate them rather than trusting the number. Several already moved once during this document's own revisions.

| Claim | Reality |
|---|---|
| "Anything not in the plan stops and asks" | `policy.ts:73` **hard-denies** any edit outside the two planned files, before `canUseTool` is consulted. `engine.ts:668` then reconciles against exactly those two, so an approved deviation would be rolled back anyway |
| An approval gate already existed | It did not. `core.ts:199` only *emitted* an event; `core.ts:204` called `runApply` immediately. A plan that auto-approved the planned edits would have produced **zero** prompts |
| Ctrl-C can offer a restore | Half right, and the stated reason was **wrong**. `installSignalHandlers` defaults `exitFn` to `process.exitCode = code`, which does **not** terminate — the process keeps running. Restore is unavailable because `controller.abort()` makes the shell settle every queued prompt `false` and refuse new ones. That is a lifecycle choice, so a soft-cancel phase is *possible*; it is not physics |
| The success screen should show the dev URL | `core.ts:317` stops the server in a `finally` whose comment reads *"teardown before the terminal event"*. The URL is dead when printed |
| Removing MCP tools from `allowedTools` routes them to our callback | It does, and **that callback denies them** (`engine.ts:113` allows only `Read`, `Glob`, `search`). Detect would break outright |
| The run log records "steps taken and files touched" | Metadata mode records `{ts, type, name, hash, bytes}` (`runlog.ts:128`). No file names |
| A return value can report what was written | `writeEnvLocal` writes `.gitignore` **before** `.env.local` (`envfile.ts:46`). If the second write throws, a real change happened that no accumulator would see |

### What already works — do not "fix" it

- `core.ts:103` `MAX_TASKS = 8` rolling window; `core.ts:115` counts dropped work separately: *"Failures are NEVER dropped silently."*
- `core.ts:201` resets tasks between stages deliberately. Do not make `tasks` sticky.
- `writeEnvLocal` merges rather than clobbers, and adds `.env.local` to `.gitignore` *before* writing the secret. Verified live: a planted `SECRET_SESSION_KEY` survived onboarding.
- Re-running on an already-wired repo makes no edits. Verified live: no duplicate `init()`, no duplicate dependency, unrelated uncommitted work untouched. It still asks once — *"Everything is already set up. Start your dev server?"* — because starting a server is an action, not a no-op.
- Apply's own rollback works (`engine.ts:607`, `engine.ts:657`). Slice 3 extends its *lifetime*, not its logic.

---

# Slice 1 — Informed consent — SHIPPED

Delivered in `c8bd7b9` and `bfe6d88`. Recorded here because the design decisions still bind later slices.

**What it does.** One approval, showing a preview built by reading disk. `ActionPreview` exists because the plan cannot answer the questions the screen asks: whether `.gitignore` will actually change, or whether an env key will be added or overwritten. A consent screen that states something it cannot know is worse than one that says less.

**Also shipped:** dirty-tree disclosure (`worktree.ts`, `git status --porcelain=v1 -z` with rename handling), repo-relative paths in prompts, the wordmark, and the deviation decision.

**Corrections made after seeing it on a real terminal:**

- The rationale read like a commit message. The spec had asked for it *"grounded in repository evidence"* — so that is what it produced. Now two sentences written for the person deciding, with worked good and bad examples. **640 characters → 231**, measured live.
- `then start npm run dev in .` was crammed onto the file list, where it read as a fourth file. Commands are their own list now, headed *"Then, to check it actually works"* — they are how the wiring gets proved, not housekeeping.
- The file column was padded to a fixed 48 characters. Now the widest path actually drawn.
- An already-wired repo was asked "Apply this?" under a summary saying nothing needed changing. It now asks about the dev server, and **fails safe**: an incomplete preview asks the question that assumes changes.
- The success screen printed a URL `core.ts` had already killed.
- **The run could not finish until a browser loaded the app, and nothing said so.** Every earlier success happened because a browser was already pointed at the port. A real user would have watched a spinner until the 15-minute timeout.

**Verified by sabotage, not by a green suite:** the approval gate, the gitignore claim, the added-versus-replaced split, the `git status` parsing and the "open your app" instruction were each broken deliberately to confirm a test caught it. Two sabotage attempts were themselves invalid at first — one patched a type rather than logic, one broke a file so 42 tests silently did not run.

## Slice 1 follow-ups — agreed, not built

Raised after watching a live run edit the working tree directly. The dirty-tree
disclosure shipped; these two did not, and were lost until someone asked where
they were tracked.

### Offer to put the changes on a branch

**A branch does not isolate anything on its own.** `git switch -c` carries
uncommitted work onto the new branch, and onboarding does not commit, so its
edits sit as uncommitted changes wherever you already were. Creating a branch
and stopping there is close to a no-op — that is the trap to avoid, because it
*looks* like protection.

Only two versions are real:

| Option | What it actually gives | Cost |
|---|---|---|
| **Branch, then commit our changes on it** | Genuine isolation. `git switch -` leaves the original branch untouched, and the change is reviewable as a commit or PR | We commit inside someone's repository, which is presumptuous, and it is wrong outright if the tree was already dirty — their work would be swept into our commit |
| **Print the commands, change nothing** | The user separates the work if they want it separated. Zero risk, zero surprise | Only helps someone who reads the last screen |

**Recommendation: print the commands.** Onboarding already writes to a
repository it does not own; committing there is a bigger step than editing two
files, and it cannot be done safely at all when the tree is dirty — which the
disclosure has already established is common.

On success, after the changed-file list:

```
To keep this separate:
  git switch -c opslane-onboarding && git add -A && git commit -m "Add Opslane"
```

Revisit the committing version only with a clean tree and an explicit opt-in
flag. It should never be the default.

### Never auto-commit

True today by omission, not by decision. Write it down so it stays true: no
slice may add a commit, a stash, or a branch switch without the user asking for
it in that run. This is the same boundary as the deviation decision — the user
approved edits to two files, not a change to their git state.

---

# Slice 2 — Progress honesty

Ships alone. Fixes the `✗ N failed` still visible on every run.

## Task 2.1: Keep path context through the pipeline

`events.ts:62` `labelFor` reduces every path to `path.basename(file)` **before** the label reaches the view. So a monorepo feed reads `Read package.json` five times, and no change to `tui.tsx` can recover the directory — the information is already gone.

Fix it at the source: keep the repo-relative path on `TaskLine` as structured data, and let the view shorten it for display. Left-truncate at `/` boundaries so it never reads as a broken word — `…/hoppscotch-selfhost-web/src/main.ts`, never `…ges/hoppscotch`.

**Test the real pipeline, not the view in isolation.** Feed a tool-use message through `reduceTasks` and render the result, so a future change to `labelFor` cannot silently defeat it.

## Task 2.2: Retried tool calls are not failures

A glob failed, the agent retried, the run succeeded, and the screen showed `✗ 1 failed`. A healthy run looks broken.

Two wrong fixes to avoid, both proposed in earlier revisions:

- Rendering settled lines with `✓` — that stamps a checkmark on a genuine failure, the exact false-success `core.ts:115` exists to prevent.
- Filtering out every `state === 'fail'` — that also erases failures the agent never recovered from, and the terminal message does not say *which* operation failed.

Model recovery explicitly: a failed call is hidden **only** when a later equivalent call (same tool, same target) succeeded, **or** when the stage as a whole succeeded. An unrecovered failure in a stage that then failed stays on screen, because it is the diagnostic.

**Recovery has to happen before bounding.** `boundTasks` turns a dropped failure into `droppedFailed`, a bare count — the tool and target are gone, so a later equivalent success can never match it. Once bounded, the information needed to forgive a failure no longer exists.

So Task 2.2 requires:

- a **structured recovery key** on `TaskLine` (tool name plus normalised target), not the display label
- recovery applied **before** `boundTasks`, or dropped-failure accounting made reversible
- defined semantics for stage success covering **both** retained and dropped failures — a stage that succeeds must not leave `droppedFailed` reading as unexplained damage

Tests: retry-then-success → hidden; failure with no retry in a failed stage → visible with its label; a failure dropped by the window then recovered → not counted; stage failure message always visible.

## Task 2.3: The journey, and never looking stuck

Render `HEADLINE` (`tui.tsx:33`) as a list — completed `✓`, current highlighted, upcoming dimmed — with task lines indented under the current step. **Steps that will not run must not be shown**: no install step when `preview.installCommand === null`.

Set expectations without inventing numbers (a scaffold installs in ~20s, excalidraw takes minutes): `installing → "large monorepos can take several minutes"`.

**Never look stuck:** if no child output arrives for 20 seconds during install, say so. **This cannot live in `tui.tsx`**, which is pure by contract and has no notion of when `output` arrived. Put the timer in `app.tsx` and pass a plain `quiet?: boolean`.

No progress bar (we cannot know the file count), no elapsed clock (explicitly rejected), no decorative animation.

---

# Slice 3 — Mutation journal and recovery

Ships alone.

## Task 3.0 — BLOCKING: the journal cannot see the write it exists for

The motivating case is `.gitignore` succeeding and `.env.local` then failing. **An array passed into `runFlow` cannot observe that**, because both writes happen inside `writeEnvLocal` and neither is visible to the caller. Passing a journal down changes nothing without a seam.

Specify two interfaces before writing the journal:

- **`onMutation(file)` on `writeEnvLocal`**, invoked after each durable write, never throwing. A callback that can throw would turn a bookkeeping failure into a write failure.
- **A way to retain Apply's snapshots.** They are private to `runApply` today (`snapshotRegularFile`, restored at `engine.ts:607`). Recovery needs them to outlive it, with the post-Apply hash from Task 3.2 attached.

Also decide, explicitly, what the journal *is*:

- an **append-only event log** — every durable write, in order, replayable; or
- **one final disposition per file** — what is true now.

The `written | restored | left-in-place` type suggests both and is therefore neither. The terminal screen wants dispositions; a crash report wants the log. Pick one and derive the other.

## Task 3.1: A mutation journal, not a return value

Writes happen in three places and a return value cannot describe them honestly. `writeEnvLocal` writes `.gitignore` **before** `.env.local` (`envfile.ts:46`, deliberately — so a gitignore failure cannot leave a secret exposed). If the second write throws, `.gitignore` really changed and a return-value accumulator reports nothing.

Record each mutation as it succeeds, with its disposition:

```ts
type Mutation = {
  file: string;                                  // repo-relative
  action: 'written' | 'restored' | 'left-in-place';
};
```

Pass the journal **into** `runFlow` as a mutable array, exactly as `record` already is. `runFlow` does the writing while `runOnboardCore` owns the single terminal emit; returning it on `CoreResult` would lose it whenever `runFlow` throws — precisely the case needing honest reporting.

Append Apply's files **before** the `sameFiles` guard: that guard rejects a run whose files are already on disk, so appending after it would report "nothing changed" while edits sit in the tree.

## Task 3.2: An explicit restore state

Restoring is destructive — it discards the user's current file contents — so it gets its own stage and its own prompt. Without one, the view would still say "Installing dependencies" while asking whether to restore.

Add an `awaiting-restore` stage carrying the failure reason and the journal. Define the ordering: failure → emit `awaiting-restore` → prompt → act → terminal event showing final disposition.

**Ctrl-C is not a trigger.** `command.ts:46` exits before aborting, so no prompt can render. Document what an abort leaves behind and print the restore instructions instead.

**Never offer restore when `runApply` itself failed** — it already rolled back, so its snapshots describe files that are already original.

**Never write a stale snapshot.** Installs take minutes, which is exactly when someone opens an editor. Record a post-Apply hash and restore only files that still match it; report the rest:

> `src/main.tsx changed since I edited it, so I left it alone.`

Release the snapshots once restore is no longer offerable — they hold whole file contents, up to 4 MiB + 1 MiB per run.

**Call it "Restore the two code files", not "Undo".** `.env.local`, `.gitignore`, the lockfile, `node_modules`, and the provisioned project on the server all remain by design.

Tests: offered and declined; restore succeeds; a user-modified file is skipped; restore itself fails; and what the terminal screen says in each case.

## Task 3.3: An honest terminal screen

List the journal, not the plan. Heading **"Written by onboarding"** — a successful install also writes a lockfile and `node_modules`, which we do not track.

Render on `done`, `failed`, **and `aborted`**; `unsupported` returns before any write.

---

# Slice 4 — Prove it works

Ships alone. Turns *"your app is connected"* into a real error arriving from the user's own app.

## Why

Onboarding asserts its own success. Every failure this project has hit looks identical from there — an app that installs, starts, and never reports:

- `UMAMI_` variables the browser could not read
- `.env.local` written where the bundler was not looking, on 2 of 2 real monorepos
- an SDK version pinned to a release that did not exist

All three passed every structural check we had. **One end-to-end error would have caught all three.**

This is also the delight beat: the difference between a receipt and a demonstration.

## Task 4.0 — BLOCKING: we cannot currently observe the thing we promise to show

The payoff screen claims an error message, a source file, and a round-trip time. **None of that is available**, and one existing behaviour actively breaks the design.

| Fact | Where | Consequence |
|---|---|---|
| The poll returns `apiKey`, `orgId`, `projectId`, `repo`, `message`, `failureReason`, `retryAfterSeconds` — and no error event | `PollPayload` in `agent-protocol.ts` | "Error: …", "src/main.tsx" and "received in 0.8s" cannot be sourced |
| `MarkAgentSessionsAppReporting` is keyed on **`project_id`**, not session, and fires when the SDK **registers** — not when an error arrives | `packages/ingestion/db/queries.go` | **The plain load consumes the completion signal.** Step 1 of the inertness check would mark the session `app_reporting` before the trigger ever fires, and would mark *every* active onboarding session for that project |

So the design as written cannot distinguish "the SDK started" from "our test error arrived", and the safety check destroys the evidence the demo depends on.

**Design this before writing any Slice 4 code:**

- **A nonce per run**, not a reusable marker string. Two concurrent onboardings of the same project must not satisfy each other.
- **A server-side query that confirms the matching error event** and returns its received timestamp and source location, distinct from session status.
- **A local acknowledgement that the trigger actually fired**, so "no error arrived" can be told apart from "the page never loaded".
- **Explicit semantics** for duplicates, a stale nonce from a previous run, two runs at once, and timeout.

Until that exists, Slice 4 can honestly offer only *"the SDK registered"* — which is what onboarding already claims, and precisely the claim that has repeatedly been wrong.

## Constraints that decide the design

Verified, not assumed.

| Constraint | Where | Consequence |
|---|---|---|
| The entry file must differ from the original by **exactly** the planned import and init insertion | `verify.ts:933` | A trigger cannot be a separate edit |
| Reconciliation requires exactly the entry file and the manifest | `engine.ts:668` | A third file fails the run |
| The hook's writable set is those same two files | `engine.ts:634` | A third file is denied before `canUseTool` |
| Apply may not deviate | `docs/decisions/onboard-deviation.md` | A new file would require amending that decision |

**Therefore the trigger lives inside `init_block`** — already planned, already verified, already shown on the consent screen.

This also settles the framework problem: a `npm create vite` app **has no router**, so there is nowhere to put a test page. A guard inside the entry runs everywhere, with no routing knowledge.

## Who writes what

`init_block` is **already model-authored executable code**, verified by the host parsing the file with the TypeScript compiler. Model writes, host verifies, is the established pattern. What justifies extra care is blast radius, not authorship: a wrong `init_block` means the SDK does not start; a wrong trigger means the app throws for **every visitor**.

| Concern | Owner |
|---|---|
| What the trigger looks like and what it raises | the prompt |
| The code | the model, inside `init_block` |
| Where it goes and how it fires | the model — framework-specific |
| Proving it is inert | the host, by loading the app |
| Triggering, confirming, removing | the host |

## The check that is also the demo

Static analysis cannot prove "this does not throw on a normal load". Loading it can:

1. Open the app **without** the trigger → expect **no error carrying this run's nonce**. Not "zero errors": the user's app may throw its own, and treating that as a non-inert guard would be wrong. Match the nonce, never "any error"
2. Open it **with** the trigger → expect **exactly one** error carrying the nonce

Step 1 proves inertness better than any parsing; step 2 is the payoff. If step 1 sees an error, remove the trigger immediately and say so.

## Task 4.1: The plan carries a self-test

Add to `OnboardingPlan`:

```ts
  self_test: {
    url_suffix: string;   // e.g. "?opslane-test=1"
    nonce: string;        // unique per run; see Task 4.0
    /**
     * The EXACT text to delete afterwards. Task 4.4 promises "the host knows
     * the exact text it inserted", and with only a marker it does not — the
     * model authors the trigger. Validation requires this to occur exactly
     * once in `init_block`, so removal is an unambiguous string operation and
     * never a regex over the user's file.
     */
    removable_block: string;
  } | null;
```

`null` is legal — the run finishes without the demo rather than failing.

Validation, failing tests first: `url_suffix` starts with `?` or `#` and contains no `/`; `nonce` is non-empty and unique to this run; and `removable_block` occurs **exactly once** in `init_block` — zero occurrences means the plan describes a trigger it did not write, and more than one makes removal ambiguous.

Record three hashes, which Slice 3's stale-write protection also needs: the original entry file, the applied file with the trigger, and the expected file after removal. Removal that does not produce the third hash has gone wrong and must stop.

Spec guidance: inert unless triggered, and a **real uncaught error** — `captureException` would skip the `window.onerror` wiring most likely to be broken.

## Task 4.2: The consent screen shows it

Add `selfTest` to `ActionPreview`. One line under *"Then, to check it actually works"*:

```
  open the app with ?opslane-test=1, catch the error, then remove the test code
```

Do not describe it as harmless. Say what it is. This line is also what makes the later removal a write the user approved.

## Task 4.3: Drive it

New `cli/src/onboard/selftest.ts`. After the dev server is up: plain load → triggered load → show it → remove it.

Two decisions to make explicitly:

- **The CLI must not gain a Playwright dependency** just to load two URLs. Either bundle a helper or ask the user to open them. Decide before writing code.
- **Timeouts.** No error within ~30s → remove the trigger, say the check was inconclusive, finish. An inconclusive demo must never block a working onboarding.

## Task 4.4: Remove the trigger, honestly

The host knows the exact text it inserted. Remove by exact match, never by regex over the user's file. If the entry changed since Apply, **do not edit it** — say the test code is still there and how to remove it. If removal fails, print the lines to delete; the guard is inert, so it is untidy rather than dangerous.

## Task 4.5: The payoff screen

```
✓ Opslane is working.

  ⚡ Error: Opslane test error
     src/main.tsx
     sent → received in 0.8s

  I removed the temporary self-test code.
```

Three states, each needing a screen and a test:

| State | Screen |
|---|---|
| error caught | the above |
| trigger fired, nothing arrived | wired but not reporting — **usually means the keys are not reaching the browser**, the exact failure this slice exists to catch |
| `self_test` null, or inconclusive | **setup finished, delivery unverified.** Not "connected" — this document exists because structural success has repeatedly failed to report |

The middle state is the valuable one: it turns a silent future failure into a message at setup time.

**Define the result and exit status for every end state**, and test each. They are not variations of success:

| End state | Meaning |
|---|---|
| delivery verified | an error carrying this run's nonce arrived |
| setup completed, delivery unverified | wiring applied, no confirmation — the honest default when the check is skipped or times out |
| delivery verification failed | the trigger fired and nothing arrived. The keys are probably not reaching the browser |
| restore accepted / declined / partial / failed | four distinct outcomes; "partial" must name which files were restored and which were left |
| temporary test code left behind | say so every time, with the lines to delete |

**The consent screen must disclose the synthetic error**, not just the code change: a deliberate error will be thrown in the browser and sent to Opslane, along with the diagnostics that accompany any report. A user approving an edit is not thereby approving telemetry.

## Risks

**A guard that is not inert** — caught by the plain load before the trigger fires. That check is why this design is acceptable.

**Leftover throwing code** — only if removal fails, and only inert code behind a query parameter. Compare the rejected alternative, an unconditional `setTimeout(() => { throw … })`, where a crash before cleanup leaves an app that throws on every load.

**A user's own error during step 1** — match on `marker`, not "any error".

---

## Outstanding, not owned by any slice

- **`@opslane/sdk` 2.0.1.** The Vite 8 peer fix is on `main` and **unreleased**; npm still has `2.0.0` with `vite: ^6.0.0 || ^7.0.0`. **Every user scaffolding a current Vite app hits `ERESOLVE`.** A one-line release, and the cheapest item here.
- **The SDK shadow warning** printed above every run. The fix is *not* just removing the two names from `allowedTools` — `engine.ts:113` allows only `Read`, `Glob`, `search`, so Detect would break. It needs `report_plan` and `ask_user` added to the callback, with tests pinning both, and two existing tests inverted.
- **A second-model reviewer.** Tested by hand on the corpus: **2 real bugs in 2 tries, no false positives** — including one in our own code. Its output must never say "a second model disagreed"; either we accept the correction silently, or we ask the user a domain question through the existing `ask_user` path. Gated on an offline eval showing it stays quiet on correct plans.
- **`ctrl+f` to report a problem.** Needs honest copy: metadata logging records `{ts, type, name, hash, bytes}` — no file names — and a prefilled GitHub URL cannot attach a file. Scope as "open the issue and show the log path".
- **#193**, SDK 409 recovery.
- **A killed run orphans the dev server.** Ctrl-C is handled; SIGKILL is not. Observed twice.

## Notes on testing this view

- `lastFrame()` is ANSI-stripped, so `.toContain()` on substrings is sound.
- **Never assert frame width against `process.stdout.columns`** — it is `undefined` under Vitest and `ink-testing-library` uses its own mock width.
- Prefer content assertions over layout.
- **Sabotage every new guarantee.** Break the code, confirm a test fails, revert. Watch for invalid sabotage: patching a type rather than logic changes nothing, and a syntax error makes tests *skip* rather than fail.

## Final verification

```bash
pnpm --filter @opslane/cli build && pnpm --filter @opslane/cli test
pnpm -r build && pnpm test
```

Then **live runs**, because every defect here survived a green suite.

**Single app** (`npm create vite`, then pin `vite@^7` *and* `@vitejs/plugin-react@^5` — plugin-react 6 requires Vite 8, which published SDK 2.0.0 rejects):

1. One destructive approval for the whole run
2. No red `✗` for a retried glob
3. The end screen lists only files really written — check against `git status`
4. `.gitignore` shown only if it actually changed

**Monorepo** (`node cli/scripts/onboard-eval-corpus.mjs --only excalidraw --clone-only`, then onboard it):

5. `.env.local` at the **repo root**, not `excalidraw-app/` — the case a single-app run cannot exercise
6. The preview names the custom `VITE_APP_` prefix and that Sentry is kept
7. Restore the clone afterwards so later evals score it as published

**For Slice 4, additionally:** deliberately break the env prefix and confirm the run reports *"no error arrived"* rather than success. That is the regression test for the entire class of bug that motivated this work.

Paste the terminal output into the PR.
