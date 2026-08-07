# Incident conclusions: diagnosis first, then routing

**Status:** Shipped on `abhishekray07/agent-improvement`
**Supersedes:** the M0/M1 plan and the harness-decision doc, both removed once executed

## The problem this fixes

The pipeline used to classify an error and then justify the classification. That
produced band-aid fixes: for [PR #1297](https://github.com/conelike/asset-management-jira/pull/1297)
it opened a code change against a client-side timeout constant while its own
reasoning said "the server did not respond within 10 seconds". The chain it built
was a *mechanism* chain — how the error surfaced — not a *cause* chain.

The rule now: **reach a diagnosis backed by evidence, then derive the routing from
it in code.** The model never names an outcome.

## What the investigation produces

One model pass with three read-only tools (`read_file`, `search`, `list_files`)
against a clone of the customer's repository, bounded by a turn budget stated in
the prompt. It ends by calling `submit_diagnosis` exactly once. A run that ends
any other way is an execution failure, never a finding.

The submission carries:

| Field | Why routing needs it |
| --- | --- |
| `best_supported` | The cause, one sentence |
| `candidates_considered` | Every cause weighed, each typed `local_code` / `external_system` / `data_or_input` / `configuration` / `unknown` |
| `rejected` | What ruled each one out |
| `evidence_strength` | `conclusive` / `suggestive` / `insufficient` |
| `cause_kind` | Typed, so routing never pattern-matches prose |
| `cause_locations` | Most important first. **The first entry is the claim**; the rest are advisory |
| `why_chain`, `reproduction_steps`, `evidence_check` | The receipts a human reads |

## How routing is derived

`deriveOutcome` in `packages/worker/src/classify.ts` is pure — no model, no I/O —
and answers two questions: is the evidence good enough, and where does the cause
live. It returns one of `code_fix` / `not_actionable` / `needs_more_context`, plus
a `basis` value and a confidence.

The ladder, in order:

1. No submission → `needs_more_context`.
2. `insufficient` evidence → `needs_more_context`, whatever the location says. Checked first so a confident-looking path cannot rescue a run that could not separate its own candidates.
3. `cause_kind: unknown` → `needs_more_context`.
4. External or data cause → `not_actionable`, **but only if every local candidate was rejected by name**. Concluding "external" while a supported local candidate went unrejected is how a model escapes reading the code.
5. First citation unparseable, or resolving to no file in the clone → `needs_more_context`. A hallucinated path is an evidence defect.
6. Otherwise → `code_fix`.

`evidence_strength` maps to confidence: `conclusive` → high, `suggestive` →
medium, `insufficient` → low. **Only high opens a pull request unattended.**
Medium parks the incident for a human. That gate is enforced twice — once at
routing, once when the fix job loads the persisted decision.

`basis` is a forensic label written to the incident, not a routing input. It
exists because an earlier version matched substrings of its own prose, so
rewording a message silently changed the reason code.

## What guards writes

One rule, enforced where the mutation happens: **a write must land inside the repo
clone.** `assertWritable` (local) resolves symlinks via `realpath` before deciding;
`assertWritableSandboxPath` (remote E2B) is lexical and documented as unable to
follow symlinks. `write`, `edit` and `patch` all pass through it.

`bash` is deliberately not gated — it can write anywhere and no tool-level check
covers it. Its containment is the E2B sandbox, not this.

## Things tried and dropped — do not rebuild these

**A two-agent split** (compile a dossier of candidates, then adjudicate it).
Justified by tracing one fixture whose family was later found broken. It never
demonstrated a safety benefit, cost a second model pass, and produced the refusal
surface behind two of six no-answer runs on the real corpus. The instruction that
does the work is "enumerate, then settle", which one prompt carries fine.

**A per-project "fix surface"** — a `fix_surface_globs` column plus glob matching
that restricted which paths the fix agent could touch. It was a security control
requiring manual per-customer setup with no safe default: NULL-means-open granted
the widest permission to unconfigured projects, NULL-means-closed broke every
project on deploy. The output of this pipeline is a pull request a human reviews,
so it was preventing a noisy PR, not an unsafe merge. The load-bearing part —
stay inside the clone — survives above. If a customer auto-merges on green CI,
revisit it, and derive the surface from the resolved stack trace rather than
hand-configuring globs.

## Two measurement lessons that cost real time

**Ground truth leaked through git history.** The eval cloned with
`--filter=blob:none` and checked out the base commit, which fetches *every ref* —
so the merged fix sat in the clone and one `git log --all --grep` returned the
answer. Any arm with a shell could read what it was being scored on. Clones are
now single-commit, with the fix SHA asserted unreachable. A number produced before
that fix cannot be cited.

**Comparisons diverge silently.** An "ours vs the Agent SDK" run was reported as
matched while our arm had three retries to the SDK's none, and 30+8 turns to its
30. The retry policy now lives in exactly one place for that reason.

And run-to-run variance is large: one case run nine times on identical code and
input gave five hits and four misses. **No single pass of the eval settles a design
question.**
