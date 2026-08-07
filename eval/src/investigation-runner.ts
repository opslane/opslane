import type { DiagnosisOutcome } from '@opslane/shared';
import { investigateError } from '@opslane/worker/dist/investigate.js';
import type { EvalCase } from './types.js';

export type ExpectedOutcome = 'fix_pr' | 'needs_human' | 'conclusion';

export function expectedToOutcome(expected: ExpectedOutcome): DiagnosisOutcome {
  switch (expected) {
    case 'fix_pr': return 'code_fix';
    case 'conclusion': return 'not_actionable';
    case 'needs_human': return 'needs_more_context';
  }
}

export function scoreTrials(
  expected: ExpectedOutcome,
  got: DiagnosisOutcome[],
): { passes: number; trials: number } {
  const wanted = expectedToOutcome(expected);
  return {
    passes: got.filter((outcome) => outcome === wanted).length,
    trials: got.length,
  };
}

export interface InvestigationCaseResult {
  id: string;
  expected: ExpectedOutcome;
  got: DiagnosisOutcome[];
  causeLocations: Array<string | null>;
  passes: number;
  trials: number;
}

/** Run one fixture repeatedly because a single stochastic result is not a measurement. */
export async function runInvestigationCase(
  evalCase: EvalCase,
  repoPath: string,
  trials: number,
): Promise<InvestigationCaseResult> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required to run investigation cases');
  }
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error('trials must be a positive integer');
  }

  const got: DiagnosisOutcome[] = [];
  const causeLocations: Array<string | null> = [];
  for (let trial = 0; trial < trials; trial++) {
    const result = await investigateError(apiKey, {
      platform: evalCase.error_event.platform,
      customerRuntime: evalCase.error_event.runtime,
      errorType: evalCase.error_event.error.type,
      title: evalCase.error_event.error.message,
      errorMessage: evalCase.error_event.error.message,
      stackTrace: evalCase.error_event.error.stack,
      resolvedStackTrace: null,
      breadcrumbs: JSON.stringify(evalCase.error_event.breadcrumbs),
    }, repoPath);
    got.push(result.outcome);
    causeLocations.push(result.diagnosis?.cause_location ?? null);
  }

  const expected = evalCase.expected.outcome;
  return {
    id: evalCase.id,
    expected,
    got,
    causeLocations,
    ...scoreTrials(expected, got),
  };
}
