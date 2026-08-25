# Apply cannot deviate from the approved plan

- **Status:** SUPERSEDED (2026-08-23) — the CLI onboarding agent was removed. Originally ACCEPTED (2026-07-28), ratifying behaviour the code had.
- **Verified against:** `cli/src/onboard/policy.ts`, `cli/src/onboard/engine.ts` at commit `8fe33b1`.
- **Prompted by:** the onboarding TUI plan (`docs/plans/2026-07-27-onboarding-tui-ux.md`), which
  in revisions 1–5 promised that a write outside the plan would "stop and ask". It cannot, and
  should not.

The Apply agent may write to exactly two files: the entry file and the manifest named in the
approved plan. An attempt to write anywhere else is **denied outright**. The agent is not
offered the choice, and neither is the user.

## What the code actually does

Three independent layers enforce this. They were built separately and none was added for this
decision; the decision is to keep them and stop describing them as something else.

**1. The write never happens.** `engine.ts:633` builds Apply's PreToolUse hook with
`writablePaths: [entry.relative, manifest.relative]`. `policy.ts:46` canonicalises those into a
set, and `policy.ts:73-77` denies any edit tool whose target is not a member:

```
return deny(`${toolName} is not allowed to modify ${relative}`);
```

This runs **before** `canUseTool`, so an off-plan edit never reaches the approval callback. There
is no point at which a prompt could be shown, because the tool call has already failed.

**2. A deviation that somehow landed would be rolled back.** `engine.ts:668` computes
`expectedFiles = [entry.relative, manifest.relative]` and requires the agent's own report and the
engine's tracked commits to both equal that set (`sameSet`). Any mismatch returns
`edit_reconciliation_failed` and rolls back. So even if the hook were widened, an approved
deviation would be undone moments later.

**3. The result is verified against the plan.** `verifyApplied` re-checks the applied wiring
against the plan's import line and init block.

## Why this is the right choice

**One approval only means something if the approved set is fixed.** The consent screen shows the
user a finite list of files and says "this is what I will change". That sentence is only true if
the set cannot grow after they answer. Allowing deviation would make the approval a statement
about intent rather than about outcome, and the user has no way to re-examine a set that changes
while they are not looking.

**A prompt mid-Apply is a bad place to ask.** The user has just approved a plan and looked away.
An interruption several seconds later, describing a file they have not seen in a summary they
have already dismissed, is exactly the prompt people approve without reading.

**The agent has a better recovery than asking.** A denied tool call returns an error the model
can see. If its plan was wrong — the anchor moved, the file is not what it expected — it can
re-read and try again within the same turn budget. Failing the call is more informative to the
agent than a human "no" would be.

## What the alternative would cost

Supporting deviation is not a matter of relaxing one check. It would require:

- widening the hook's writable set, which is the only thing standing between an agent with
  `Edit` and `Write` and the rest of the repository
- changing reconciliation at `engine.ts:668`, which currently requires exactly the two files
- changing `verifyApplied`, which validates against the plan
- a new interaction to show a deviation, mid-Apply, with enough context to judge it

That is a much larger change, and it trades away the property that makes a single approval safe.
Not worth it for a case the agent can handle by re-planning.

## Consequences

- The onboarding plan **must not** promise that off-plan writes prompt the user. Revisions 1–5
  did; revision 6 removes it.
- `onPlanApproval` — a helper proposed to auto-approve the two planned files inside `canUseTool`
  and prompt for anything else — is unnecessary. The hook has already made the decision by the
  time `canUseTool` runs.
- If Apply repeatedly fails on denied writes, that is a **Detect** problem: the plan pointed at
  the wrong file. Fix it there, not by loosening this boundary.
- Revisit only with evidence: real repositories where the correct wiring genuinely needs a third
  file, and no plan could have named it in advance. None has been seen across the eval corpus
  (umami, excalidraw, hoppscotch) or any live run.
