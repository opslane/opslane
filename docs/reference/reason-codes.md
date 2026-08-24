---
description: Every needs_human reason code with its remediation.
---
# Reason codes

Every `needs_human` incident carries a `reason_code`, a `reason_message`, and a `remediation`. The catalog lives in `packages/worker/src/reason-codes.ts` as an exhaustive `Record<ReasonCode, string>` — adding a code to `shared/src/types.ts` without a remediation entry is a compile error, so this table cannot silently fall behind the type.

## Credentials and access

| Code | Remediation |
| --- | --- |
| `missing_github_token` | Connect the GitHub App to this repository (Settings → GitHub) so Opslane can read and open PRs. |
| `repo_access_denied` | Confirm the GitHub App is installed on this repository and has read + pull-request permissions. |
| `token_decrypt_failed` | Re-connect the GitHub integration — the stored credential could not be decrypted. |
| `auth_invalid` | Re-authenticate the GitHub connection; the existing token was rejected as invalid. |
| `policy_blocked` | A repository or org policy blocked the change. Review branch-protection / app permissions, then retry. |
| `missing_llm_key` | Set the `ANTHROPIC_API_KEY` environment variable on the worker with a valid Anthropic API key. |

## Repository state

| Code | Remediation |
| --- | --- |
| `empty_repository` | Push at least one commit to this repository, then retry — there is no branch for Opslane to work from yet. |
| `invalid_default_branch` | This repository's default branch points at a branch that no longer exists. Set a valid default branch in GitHub (Settings → Branches), then retry. |
| `unresolvable_head` | Opslane could not determine this repository's default branch. Check the repository is not in an unusual state, then retry. |

## Investigation and fix quality

| Code | Remediation |
| --- | --- |
| `malformed_diff` | Review the error manually — the agent could not produce a valid, applicable diff. |
| `verification_failed` | Review the candidate fix manually — Opslane could not verify it satisfied the failing behavior. |
| `tests_failed` | Review the candidate diff manually — the agent produced a fix but the test suite still fails, so it may be partial or cause regressions. |
| `low_confidence_fix` | Review the candidate diff and root-cause writeup, then apply or refine the fix manually — it did not clear the bar for an automatic PR. |
| `repro_not_achievable` | Review the candidate diff and evidence manually — Opslane could not construct a reliable reproduction test for this error, so the fix is verified only against the existing suite. |
| `draft_cap_reached` | Review or close an existing Opslane draft PR, then retry this fix. The candidate diff remains available on the incident. |
| `budget_exhausted` | Review the error manually — the agent could not complete within its turn/budget limits. Consider guiding it with more context. |
| `insufficient_context` | Add a replay, breadcrumbs, or a reproduction so Opslane has enough context to investigate. |

## Inputs and artifacts

| Code | Remediation |
| --- | --- |
| `sourcemap_unresolved` | Upload source maps for this release (see the SDK build plugin) so the stack trace resolves to original source. |
| `artifact_fetch_failed` | Retry later — Opslane could not fetch a stored artifact (screenshot/replay) needed to analyze this error. |

## Triage verdicts (deliberately not fixed)

| Code | Remediation |
| --- | --- |
| `triage_unfixable` | Review the error manually — triage determined it cannot be fixed with application code changes. |
| `unfixable_no_app_frames` | Add the `crossorigin` attribute to your `<script>` tags (with CORS headers) and throw `Error` objects (not strings) so the SDK captures real stack frames. |
| `unfixable_test_error` | No action needed — this looks like a deliberate test error thrown to exercise Opslane. |
| `unfixable_third_party` | Review manually — the error originates entirely in third-party code, so the fix is not in your application source. |
| `unfixable_infra` | Investigate infrastructure/network (CORS, DNS, timeouts, 5xx) — this is not an application code bug. |
| `unfixable_no_sourcemap` | Upload source maps for this release so the minified stack trace resolves to original source, then retry. |

## Runtime

| Code | Remediation |
| --- | --- |
| `worker_runtime_error` | Review the error manually — the Opslane worker hit an unexpected internal error while processing this incident. |
| `lease_lost` | No action needed — the job lease expired mid-run and the incident will be retried automatically. |
| `verification_infra_error` | No immediate action needed — verification infrastructure failed (dependency install, test runner crash, or timeout), so the fix could not be proven either way. It will be retried on recurrence; if it persists, check worker logs. |

28 codes total. The [drift check](../../scripts/check-docs-drift.mjs) fails the repository test gate (`pnpm test`, which CI runs) if this page and `shared/src/types.ts` disagree.
