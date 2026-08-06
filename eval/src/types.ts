import type { ReasonCode } from '@opslane/shared';
import type { Platform } from '../../packages/worker/src/platform.js';
import type { RuntimeInfo } from '../../packages/worker/src/runtime-info.js';

/** The error event sent to the pipeline */
export interface EvalErrorEvent {
  platform?: Platform;
  runtime?: RuntimeInfo;
  error: {
    type: string;
    message: string;
    stack: string;
  };
  breadcrumbs: Array<{
    type: string;
    timestamp: string;
    category: string;
    message: string;
    data?: Record<string, unknown>;
    level?: string;
  }>;
  context: Record<string, unknown>;
}

/** A single eval case definition (loaded from case.json) */
export interface EvalCase {
  id: string;
  app: string;
  bug_patch: string | null;
  /** Git URL for E2B to clone. Required for agent harness runs. */
  repo_url?: string;
  /** Branch to clone. Defaults to 'main'. */
  default_branch?: string;

  error_event: EvalErrorEvent;

  expected: {
    outcome: 'fix_pr' | 'needs_human' | 'conclusion';
    rca_file?: string;
    reason_code?: ReasonCode;
  };

  grading: {
    fail_to_pass: string[];
    pass_to_pass: string[];
  };

  metadata: {
    category: string;
    difficulty: 'easy' | 'medium' | 'hard';
    framework: string;
  };
}

/** Result of evaluating a single case */
export interface EvalCaseResult {
  case_id: string;
  passed: boolean;

  outcome_correct: boolean;
  actual_outcome: 'fix_pr' | 'needs_human' | 'error';

  rca_file_correct?: boolean;
  actual_rca_file?: string;

  patch_applies?: boolean;
  fail_to_pass_results?: Array<{ test: string; passed: boolean }>;
  pass_to_pass_results?: Array<{ test: string; passed: boolean }>;

  reason_code_correct?: boolean;
  actual_reason_code?: string;

  confidence?: string;
  root_cause?: string;
  duration_ms: number;
  error_message?: string;
  token_usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };

  /** LLM-as-judge quality assessment (only for fix_pr cases with a diff) */
  judge_result?: JudgeResult;
  /** True if judge was expected to run but failed/skipped */
  judge_skipped?: boolean;
}

/** Result from LLM-as-judge diff quality evaluation */
export interface JudgeResult {
  /** 0-2: changes unrelated files/code (0), slightly over-scoped (1), minimal and targeted (2) */
  scope: number;
  /** 0-2: wrong root cause addressed (0), partially correct (1), addresses actual root cause (2) */
  correctness: number;
  /** 0-2: removes existing features (0), minor unnecessary removals (1), all behavior preserved (2) */
  preservation: number;
  /** Free-text rationale */
  explanation: string;
  /** Total score (scope + correctness + preservation, 0-6) */
  total: number;
  /** Whether the diff passes quality thresholds */
  quality_passed: boolean;
}
