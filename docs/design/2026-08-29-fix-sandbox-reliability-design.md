# Making fix attempts survive a broken work machine

Status: draft for review
Date: 2026-08-29

## For someone new to this

When Opslane finds a bug on a customer's site, it tries to fix it. To do that it rents a temporary Linux machine, copies the customer's code onto it, installs the code's dependencies, and lets the AI work there. When the attempt ends, the machine is destroyed. The machines come from a company called E2B.

Two fix attempts ran in the last fortnight. Both failed. Neither failed for a reason a customer could act on, and one told a customer to "review the error manually" for a bug the AI had never been shown.

This document proposes making those failures honest. Tell customers when their own dependencies are what failed. Quietly retry when our machine is what broke. Tell ourselves either way, within seconds. And stop paying for AI work on attempts that cannot succeed.

Words used throughout, defined once:

- **Work machine**: the temporary machine rented for one fix attempt.
- **Attempt**: one try at fixing one bug. The worker takes these off a queue and is allowed three tries before giving up.
- **Prebuilt machine**: a saved machine we boot copies of, rather than starting blank.
- **Customer message**: the Slack card a customer sees when we could not fix something.
- **Operator alert**: a Slack message to us, never to a customer.
- **The command ran**: E2B tells us the difference between a command that executed and returned a failure code, and a machine that never answered. That distinction carries most of the weight in this design.

Code names and line numbers live in the appendix so the body stays readable.

## Problem

On 2026-08-28 an attempt ran for 202 seconds against the AMFJ project and ended with this in a customer's Slack:

> Needs you: Review the error manually, the agent harness encountered an unexpected error

The AI was never called. From the worker logs:

```
13:33:54.315  Claimed job (job_type=fix)
13:33:56.806  Fix checkout (commit 324cc988)
13:36:46.447  WARN  setup install failed; continuing   error="2: [unknown] terminated"
13:37:16.735  WARN  Fix job completed: needs_human      reason_code=worker_runtime_error
```

The word `terminated` there is not the package manager exiting. Reading the E2B library we have pinned, it is one of four phrases E2B lists as how a program reports that its connection to a machine was cut while a request was still going. The `2:` in front is E2B's catch-all wording for a connection failure it has no specific handling for.

So the machine stopped answering. Our code read that as "the install failed", wrote a warning, and kept issuing commands. Thirty seconds later the next command hit its time limit, and because nothing catches that particular failure it fell through to a catch-all handler that has no idea what went wrong. That handler wrote the message above.

The day before, on the same repository, the install died with exit status 137, which is what a program reports when something kills it. That attempt did reach the AI, which spent all 45 of its turns across two models fighting a machine it could not use. Its last recorded thought was "The filesystem appears to be very slow."

Two attempts, two different symptoms. They may share one cause: a machine running out of memory can kill one program on one day and take the whole machine down on another. We cannot currently tell, and that is itself the problem.

### Continuing after a failed install can never help

Once the install has failed, a verified fix is already impossible. The code sets an infrastructure-failure flag the moment an install fails, and no later path can reach a successful outcome. Everything spent after that point buys an answer already known.

### We cannot investigate either failure

There is a function that logs a machine's identifier, its age, and how it died. Neither incident reaches it. The variable holding the machine stays empty until setup has fully succeeded, so any setup failure arrives at the error handler with nothing in hand. We threw the identifier away before anything could look it up. We cannot ask E2B what happened on 2026-08-28, and we will not be able to ask about the next one.

## Goals

- A customer whose dependencies cannot be installed is told that, in those words.
- A failure caused by our own infrastructure is retried, and only reaches a customer if retrying does not help.
- We hear about either kind within seconds, without a customer telling us.
- No AI spend on an attempt that cannot produce a fix.
- Every failure occurring after a machine exists carries that machine's identifier.

## Non-goals

- **Raising the fix success rate:** it is zero across the two attempts on record. This work does not move it. It makes failures legible so the next piece of work can.
- **Python, in milestone two only:** milestone one covers both platforms, because the decision it changes lives in shared code.
- **A stored dependency archive:** considered and rejected. See Alternatives.

On speed: milestone two does make attempts faster, and pretending otherwise would be dishonest. Speed is not the reason to do it. There were two attempts in fourteen days and nobody is waiting. It earns its place by moving dependency installs out of the moment a customer has an outage.

## Requirements

| | Requirement | Verified by |
|---|---|---|
| R1 | When a machine never answers and E2B then reports it is not running, the attempt retries rather than reporting a result | Test per failure shape, using real error objects |
| R2 | When a command runs and returns a failure code, that is handled as a command failure and never as a dead machine | Test that a deliberately failing test still reports as a failing test |
| R3 | When we cannot determine the machine's state, the attempt retries and nothing claims the machine is dead | Test with the state check itself failing |
| R4 | A failed install stops the attempt before any AI call | Replay asserting no AI-spend rows for the attempt |
| R5 | A customer is told their dependencies failed only after a second attempt has failed the same way | Replay with a broken dependency list across two attempts |
| R6 | An install failure caused by a kill, a timeout, or a lost connection does not produce a dependency message to the customer | Replay of the recorded exit-137 and lost-connection cases |
| R7 | Every failure occurring after a machine has been created logs that machine's identifier and its age | Replay asserting the log fields are populated |
| R8 | Both kinds of failure send an operator alert, best-effort | Manual check against a test webhook |

Three of these are narrower than they first look.

R6 says *dependency message*, not *no customer message*. If our infrastructure keeps failing, the customer does eventually see something, because giving up after three tries already writes a customer message today. R6 promises we never blame their dependencies for our problem, not that we stay silent forever.

R7 covers failures after the machine exists. If renting one fails there is no identifier to record, and that is reported as a provisioning failure instead.

R8 says best-effort on purpose. The alert sender drops messages when too many are in flight and never retries, which is the right trade for something that must not break its caller. Alerting is therefore not a guarantee and is not the only signal. See Observability.

## How we decide what went wrong

The first draft of this design read E2B's error types and message text. Reading the pinned library showed that cannot work.

E2B converts connection failures into its own error types through a fixed table. Three separate conditions all become the **same** type: the machine timing out, the request timing out, and one command exceeding its own time limit. Anything not in the table, including the exact case behind our 2026-08-28 failure, becomes a general error whose message is the code and the original text stitched together. That stitching is literally how the string `2: [unknown] terminated` gets made.

So the error type cannot separate a dead machine from a slow test suite. They are the same type. And the failure we actually saw is not that type at all.

There is a second reason not to trust the error alone. When E2B sees a lost connection it checks the machine itself, and only converts the error if that check says the machine is gone. Our error arrived without that conversion, so E2B checked and did **not** get back the answer "gone".

### The rule

Two questions, in order.

**Did the command run?** E2B raises a distinct error type for a command that executed and returned a failure code, carrying the exit code and the output. If we get that, the machine is demonstrably working. Handle it as a command failure and stop. This covers the common case, including tests we expect to fail, so the ordinary path gains no extra work.

**If the command never ran, ask E2B what state the machine is in.** The machine object offers a state check. It takes its own short time limit, so a sick machine cannot stall us:

```
machine reported missing        -> gone.    Retry the attempt.
state check says not running    -> gone.    Retry the attempt.
state check says running        -> alive.   Treat as a connection blip. Retry.
state check itself fails        -> unknown. Retry, and record "unknown",
                                             never "dead".
```

Every branch here retries, which raises a fair question: why ask at all? Because the answer is recorded, and telling these apart across many failures is how we learn which one is common. That is the whole reason milestone one comes first. The branches differ in what we write down, not yet in what we do.

Three honest limits on this, none of which the first draft admitted:

The state check describes the machine at the instant it is asked. It does not prove what the earlier failure was. We are choosing which bucket to record, not establishing a fact about the past.

The check might fail for the same reason the command did. Whether it travels a different path than the command that just failed is **unverified**, and settling it is a milestone-one exit criterion, not a footnote.

E2B reports a machine as either running or paused, and paused is not dead. We never pause machines, so this should not arise. The code will record it as its own outcome rather than folding it into "not running", so if it ever does arise we find out instead of retrying blindly.

### Install failures specifically

A package manager exiting with a failure code is ambiguous. A broken dependency list produces one. So does a registry outage, a name-lookup failure, or a disk filling up. The exit code cannot separate them.

We do not try. Instead:

- The command never ran, or was killed (exit code 137): infrastructure. Retry.
- The command ran and returned an ordinary failure code: retry once as well.
- Only when that same clean failure happens twice do we tell the customer their dependencies could not be installed.

Retrying is cheap at two attempts a fortnight, and it costs one retry to avoid blaming a customer for a registry blip.

Two accounting details the first draft got wrong. "Happened twice" cannot be read off the attempt counter, because a previous attempt may have failed while renting a machine or cloning. The install's own outcome must be written down and read back, so a new small column on the job row holds the previous install classification. And if the first clean install failure happens on the *third* attempt there is no retry left. In that case we surface the dependency message anyway and mark it as unconfirmed, rather than silently converting it into an infrastructure error.

### What the customer sees

A twice-repeated clean install failure ends the attempt with a new reason, `dependency_install_failed`, and a message naming what failed. Every customer-facing final result must carry a reason, a message, and a suggested next step, so a new reason is required rather than optional.

Install output is not passed through as-is. It goes through the existing secret remover, is cut to 2000 characters, and has unreadable characters replaced rather than dropped. Registry addresses stay, because a customer needs them to debug; any password inside them is removed.

Adding a reason touches more than the worker: the shared type definitions, the dashboard, the Slack card, and their tests. That work is inside the milestone.

## Keeping the machine identifier

The setup function currently rents the machine, prepares it, and returns both together, so a failure anywhere inside leaves the caller holding nothing. We split it. The caller rents the machine, then hands it to a preparation step. It therefore holds the reference from the moment the machine exists, so the existing failure-logging function works for setup failures exactly as it already works for later ones.

Two consequences the first draft missed. The preparation step needs somewhere to record evidence, because the infrastructure error type demands an evidence record and the setup path has no recorder today; one gets passed in. And destroying the machine moves to the caller, in one place, so it happens exactly once no matter where the failure was.

The existing failure log says a machine "became unavailable". That wording is only correct for the confirmed cases, so the unknown-state case gets its own message rather than reusing it.

## What can go wrong, and what we do

| Where | What happened | What we do |
|---|---|---|
| Renting a machine | Provider refuses or times out | Retry. No identifier exists to log |
| Any step | Command ran, returned a failure code | Handle as a command failure |
| Any step | Machine never answered, reported missing or not running | Retry as a dead machine |
| Any step | Machine never answered, reports running | Retry as a connection blip |
| Any step | Machine never answered, state check failed | Retry as unknown state |
| Copying in code | Repository or commit unreachable | Existing behaviour, unchanged |
| Install | Killed (137) or never ran | Retry as infrastructure |
| Install | Clean failure, first time | Retry once |
| Install | Clean failure, second time | Customer message: dependencies failed |
| Building a prebuilt machine | Any failure | Operator alert only, never a customer message |
| Alerting | Send dropped or failed | Counters still record it. Alerts are best-effort |

## Milestone one: honest failures

Everything above. This is **not** JavaScript-only, because the machine-state decision lives in code shared with Python.

It ships behind a switch that starts off, so it can be turned on for one project first. Attempts already running keep their old behaviour only if workers are drained before replacement; without draining, an interrupted attempt is reclaimed and restarts under the new behaviour. That is acceptable here because the new behaviour is strictly more conservative, but it is a real difference and worth stating rather than claiming safety we do not have.

Exit criteria:

1. Replaying both recorded failures puts each in the correct bucket.
2. No AI-spend rows exist for either replayed attempt.
3. A deliberately broken dependency list produces a customer message only on its second attempt.
4. A real E2B machine, deliberately killed mid-attempt, is classified correctly, and the state check is confirmed to work when the machine's own connection has failed.

Criterion 4 is not optional. Everything else only proves the code agrees with our reading of the library.

## Milestone two: prebuilt machines per repository

Each connected repository gets a saved machine holding a clone and its installed dependencies. An attempt boots a copy, fetches, and checks out the commit where the error happened.

Builds run as their own queued work, not inside a fix attempt. The first draft proposed building inside the attempt while it held its place in the queue. On review that is a bad pairing, because one slow build would occupy the fix queue and tangle the retry logic.

Builds are triggered ahead of need, not on demand. All connected repositories are built when this milestone deploys, a newly connected repository is built at that moment rather than when a fix first wants it, and a push that changes the install triggers a rebuild. The point is that a fix attempt should never be the thing that discovers no machine exists.

When it does happen anyway, the attempt does not wait. It asks for a build and uses today's clone-and-install path for that one attempt. Waiting is not an option: retries are spaced 30 seconds apart and then double, with three attempts in total, so a job could wait about 90 seconds before running out. A build has to clone, install and save, and setup alone took 168 seconds on 2026-08-28 before it even failed. A waiting job would exhaust its attempts first and surface to the customer as an infrastructure failure, which is worse than being slow once.

Investigation is untouched by all of this, and the reason is narrower than it first looks. Both jobs copy the repository onto our own hardware. The difference is that investigation stops there, reading those files with local tools, while a fix additionally rents a work machine and does a second copy onto it. Only the second copy is what this milestone changes, so an investigation can neither wait for a build nor fail the way a fix can.

Rebuilds trigger on a push that changes anything the install depends on, which is more than the dependency lockfile. It includes every lockfile in the repository, the definitions of any sub-projects, the registry configuration file, a declared package-manager version, any patch files, and any script that runs as part of installing. Even that list is not airtight: some install scripts read the repository's own source, so a source-only change can in principle change the result. The build records which commit it came from, and an attempt that finds a mismatch installs on top rather than trusting the saved copy.

Two facts about machine size, from the pinned library rather than the documentation. There is no way to ask for a memory size when renting a machine, so size can only be set when saving one. And the default when saving is 1024 MB, not the 512 the command-line documentation states.

A build failure sends an operator alert and never a customer message. The customer path for broken dependencies stays in milestone one, driven by a real attempt, so the two cannot contradict each other.

Milestone two starts once milestone one ships. The first draft gated it on classifying a real production failure first; at two attempts a fortnight that could block for months, which is not defensible.

### Deliberately deferred out of milestone two

These are real and are not designed here. Naming them is the point.

- **Where saved machines live and who can read them:** customer source code moves from machines destroyed in minutes to machines that persist. Encryption, tenant separation, access control, retention, and proof of deletion all need answering before a single image is built.
- **Naming, replacing, and cleaning up:** how a machine is named, how a project points at its current one, how a replacement swaps in without an attempt catching it half-done, what happens when two builds race, and what deletes old ones.
- **Build cost and quotas:** rebuild frequency, storage, and backfilling five repositories.
- **Credentials for private registries at build time.**

Milestone two does not start until these have a written answer.

## Testing and validation

Both failures are replayed from strings recorded in production, which are real observed inputs preserved in the logs and in the stored failure reason.

Strings alone are not enough, because the design now decides on the *kind* of error and on a state answer, not on wording. So the tests construct a real error of each kind, and the stand-in machine used in tests learns to answer the state question with running, not running, or a failure. Teaching that fake machine to produce E2B's error shapes is part of the milestone, not an afterthought.

In automated tests: the decision against every failure shape and every state answer, and the whole attempt path against injected failures, checking both the bucket and the absence of AI calls.

Needs a live run: killing a real machine mid-attempt, as above, and the operator alert against a test webhook.

## Observability

Alerts are best-effort, so they are not the record. Milestone one also adds counters, labelled by which step failed and how it was classified, plus the machine's identifier and its age on every failure log line. That is what makes "which of these two failures is more common" answerable, which is the entire reason this milestone comes first.

## Risks

**We may be fixing the less common failure first.** Neither milestone stops machines dying. If most failures turn out to be dead machines, neither raises the success rate and a third piece of work follows. Milestone one is what tells us.

**The evidence is two data points.** Every claim in the Problem section rests on those plus the library source. A third failure with an unseen shape would not surprise me.

**Our reading of E2B is from source, not experiment.** The live kill exists to close this. Until it runs, the classification is a well-supported hypothesis.

**Milestone two takes on lasting storage of customer code before we have tested whether a current runtime version and more memory would have been enough on their own.** That cheaper experiment was not run. It is a fair criticism of the ordering, recorded rather than argued away.

**Two known defects in this area are not fixed here.** The synthetic commit we make before the AI starts runs the customer's own git hooks and file filters, which is both a slowdown and a place customer code executes unexpectedly. And a successful install that modifies tracked files has those changes silently absorbed into that same commit, hiding them from the final diff. Both deserve fixing. Neither is on the path from "the card was useless" to "the card is honest", so both are filed separately.

## The honest caveat

None of this makes a fix more likely to succeed. Both recent attempts would still have failed. The first would have retried and, if the machine kept dying, still produced a customer message, just an accurate one. The second would have stopped in seconds instead of twenty minutes and saved the AI spend, and still produced no fix.

What it buys is that the next failure is explicable. That is worth doing before anything aimed at the success rate, because right now we cannot tell which failure we are looking at.

## Alternatives considered

**Keep continuing after a failed install and only fix the labels.** Least invasive. Rejected because continuing cannot produce a fix, so it pays full AI cost for a known answer and leaves the AI working on a machine we know is broken.

**Decide from the error type.** The first draft did this. Rejected on reading the library: one type covers a dead machine, a timed-out request, and a slow command, and the failure we actually saw is a different type again.

**Match on message text.** Rejected as unsafe. Customer command output can contain the same words, and E2B's wording is not a promise.

**Store dependency archives in shared storage,** keyed on a hash of the dependency list. Rejected. The key would need the processor type, the system C library, the runtime version, the package-manager version and the install settings, because dependencies that contain compiled programs only run on the machine that built them. Restoring an archive also skips the setup scripts and integrity checks a real install performs. A prebuilt machine avoids the portability problem, since the dependencies were installed on that exact machine, but shares the skipped-scripts and stored-code concerns.

**Build prebuilt machines before fixing classification.** Argued for at length in review and it has the strongest case: it removes dependency installs from the customer's incident entirely. Rejected on ordering only. It would have fixed 2026-08-27 and done nothing for 2026-08-28, and until the identifier is recorded we cannot tell which is common.

**Rebuild every machine nightly.** Rejected. A nightly rebuild burns builds on days nothing changed and still serves a stale machine for up to a day after a real change. The push notification tells us when it actually happens.

## Open questions for review

1. Builds moved out of the fix attempt into their own queued work, reversing a decision made during review. Confirm or overturn.
2. Should we test a current runtime version and more memory on the shared path before committing to per-repository machines?
3. Is `dependency_install_failed` the right name, and what should its suggested next step say?
4. Every branch of the state check currently retries. Should any of them do something different, or is recording the difference enough for now?

## Appendix: where this lives in the code

| Claim | Source |
|---|---|
| Install failure is caught and the attempt continues | `packages/worker/src/harness/sandbox-repo.ts:227` |
| The command that timed out on 2026-08-28, 30s limit | `sandbox-repo.ts:249`, inside `createRepoSandbox` (114-264). The similar call at `:275` is in `extractDiff` and is not this one |
| Node 22 is downloaded on every JavaScript attempt | `sandbox-repo.ts:91` |
| Only a missing machine counts as death today | `sandbox-runtime.ts:93` |
| Machine is rented with no size option | `sandbox-runtime.ts:147` |
| Local test machine, behind two environment variables | `sandbox-runtime.ts:151` |
| Machine reference is empty until setup succeeds | `agent-fix.ts:594` declares, `:632` assigns |
| Failure logger that never runs for setup failures | `agent-fix.ts:63` |
| Failed install sets the infrastructure flag | `agent-fix.ts:699` tests, `:704` sets |
| No path from a failed install to a successful fix | `agent-fix.ts:1212` throws |
| Catch-all handler that wrote the customer message | `agent-fix.ts:1486` |
| Retry lane, three attempts, then a customer message | `packages/worker/src/index.ts:408` |
| Queue claim renewed while an attempt runs | `packages/worker/src/poller.ts:105` |
| Push notifications already received and verified | `packages/ingestion/handler/webhook.go:83` |
| Operator alert sender | `packages/worker/src/usage-events.ts` |
| Error table; only Unavailable, Canceled and DeadlineExceeded become the timeout type; everything else falls through to `SandboxError("<code>: <message>")`, which produces `2: [unknown] terminated` | `e2b@2.45.0` `dist/index.js`, `DEFAULT_ERROR_MAP` and `handleRpcError` |
| E2B checks the machine on a lost connection and converts only when confirmed gone | same file, `handleRpcErrorWithHealthCheck` |
| A command that ran and failed is a distinct type carrying exit code and output | `dist/index.d.ts`, `CommandExitError` |
| State check with its own request time limit | `dist/index.d.ts:10878`, `isRunning(opts?)` |
| Machine state is running or paused | `dist/index.d.ts:9493`, `SandboxState` |
| Memory only settable when saving; default 1024 MB | `dist/index.d.ts`, `SandboxOpts` has no size field; `BasicBuildOptions.memoryMB` |
| Build entry point takes the name as its own argument, not inside the options | `dist/index.d.ts:11968` |
| Scale: 9 projects, 5 with repositories, 2 attempts in 14 days | production query, 2026-08-29 |
