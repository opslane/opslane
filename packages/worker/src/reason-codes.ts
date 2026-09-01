import type { ReasonCode, NeedsHumanReason } from '@opslane/shared';
import type { PersistedDecision } from './db.js';

/**
 * The persisted routing basis, mapped to the incident's reason code.
 *
 * `basis` is our internal routing vocabulary; `ReasonCode` is the reader-facing
 * contract the dashboard renders. They are deliberately not the same list, so
 * the basis is carried in reason_message rather than leaked into the code.
 *
 * Read the outcome, never the prose. Two call sites used to re-derive this by
 * hand and one matched a substring of our own message, so rewording a message
 * silently changed the reason code written to the incident.
 */
export function reasonCodeForDecision(decision: PersistedDecision | null): ReasonCode {
  if (!decision) return 'insufficient_context';
  if (decision.outcome === 'not_actionable') {
    return decision.causeKind === 'external_system' ? 'unfixable_third_party' : 'unfixable_infra';
  }
  if (decision.outcome === 'code_fix') return 'low_confidence_fix';
  return 'insufficient_context';
}

/**
 * The remediation a human acts on when we open no PR: the reproduction the
 * investigation established, or the caller's fallback when it established none.
 */
export function reproductionRemediation(steps: string[], fallback: string): string {
  return steps.length > 0 ? `Reproduce with: ${steps.join('; ')}` : fallback;
}

/**
 * Default, human-actionable remediation for every reason code.
 * The Record<ReasonCode, string> type makes this exhaustive at COMPILE TIME:
 * adding a ReasonCode to shared without an entry here is a type error.
 */
export const DEFAULT_REMEDIATION: Record<ReasonCode, string> = {
  missing_github_token:
    'Connect the GitHub App to this repository (Settings → GitHub) so Opslane can read and open PRs.',
  repo_access_denied:
    'Confirm the GitHub App is installed on this repository and has read + pull-request permissions.',
  empty_repository:
    'Push at least one commit to this repository, then retry — there is no branch for Opslane to work from yet.',
  invalid_default_branch:
    "This repository's default branch points at a branch that no longer exists. Set a valid default branch in GitHub (Settings → Branches), then retry.",
  unresolvable_head:
    "Opslane could not determine this repository's default branch. Check the repository is not in an unusual state, then retry.",
  token_decrypt_failed:
    'Re-connect the GitHub integration — the stored credential could not be decrypted.',
  auth_invalid:
    'Re-authenticate the GitHub connection; the existing token was rejected as invalid.',
  policy_blocked:
    'A repository or org policy blocked the change. Review branch-protection / app permissions, then retry.',
  missing_llm_key:
    'Set the ANTHROPIC_API_KEY environment variable on the worker with a valid Anthropic API key.',
  malformed_diff:
    'Review the error manually — the agent could not produce a valid, applicable diff.',
  verification_failed:
    'Review the candidate fix manually — Opslane could not verify it satisfied the failing behavior.',
  sourcemap_unresolved:
    'Upload source maps for this release (see the SDK build plugin) so the stack trace resolves to original source.',
  artifact_fetch_failed:
    'Retry later — Opslane could not fetch a stored artifact (screenshot/replay) needed to analyze this error.',
  insufficient_context:
    'Add a replay, breadcrumbs, or a reproduction so Opslane has enough context to investigate.',
  worker_runtime_error:
    'Review the error manually — the Opslane worker hit an unexpected internal error while processing this incident.',
  lease_lost:
    'No action needed — the job lease expired mid-run and the incident will be retried automatically.',
  budget_exhausted:
    'Review the error manually — the agent could not complete within its turn/budget limits. Consider guiding it with more context.',
  tests_failed:
    'Review the candidate diff manually — the agent produced a fix but the test suite still fails, so it may be partial or cause regressions.',
  low_confidence_fix:
    'Review the candidate diff and root-cause writeup, then apply or refine the fix manually — it did not clear the bar for an automatic PR.',
  repro_not_achievable:
    'Review the candidate diff and evidence manually — Opslane could not construct a reliable reproduction test for this error, so the fix is verified only against the existing suite.',
  verification_infra_error:
    'No immediate action needed — verification infrastructure failed (dependency install, test runner crash, or timeout), so the fix could not be proven either way. It will be retried on recurrence; if it persists, check worker logs.',
  draft_cap_reached:
    'Review or close an existing Opslane draft PR, then retry this fix. The candidate diff remains available on the incident.',
  triage_unfixable:
    'Review the error manually — triage determined it cannot be fixed with application code changes.',
  unfixable_no_app_frames:
    'Add the `crossorigin` attribute to your <script> tags (with CORS headers) and throw Error objects (not strings) so the SDK captures real stack frames.',
  unfixable_test_error:
    'No action needed — this looks like a deliberate test error thrown to exercise Opslane.',
  unfixable_third_party:
    'Review manually — the error originates entirely in third-party code, so the fix is not in your application source.',
  unfixable_infra:
    'Investigate infrastructure/network (CORS, DNS, timeouts, 5xx) — this is not an application code bug.',
  unfixable_no_sourcemap:
    'Upload source maps for this release so the minified stack trace resolves to original source, then retry.',
  billing_limit_reached:
    'This organization has used its included fix PRs for the month. Upgrade in Settings → Billing to resume automated fix PRs.',
  dependency_install_failed:
    'Check that your dependencies install cleanly on a fresh checkout — Opslane could not install them, so it could not build or test a fix.',
};

/**
 * Build a NeedsHumanReason, defaulting the message and/or remediation from the
 * registry so every needs_human writeup is consistent and actionable.
 */
export function buildReason(
  code: ReasonCode,
  message?: string,
  remediation?: string,
  platform: 'javascript' | 'python' = 'javascript',
): NeedsHumanReason {
  const defaultRemediation = code === 'unfixable_no_app_frames' && platform === 'python'
    ? 'Capture a complete Python traceback with application frames and confirm deployed file paths correspond to tracked repository files.'
    : DEFAULT_REMEDIATION[code];
  return {
    reason_code: code,
    reason_message: message ?? defaultRemediation,
    remediation: remediation ?? defaultRemediation,
  };
}
