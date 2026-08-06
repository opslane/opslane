import type { EvalCase } from './types.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const OUTCOMES = ['fix_pr', 'needs_human', 'conclusion'] as const;

function fail(caseDir: string, what: string): never {
  throw new Error(`Invalid case.json in ${caseDir}: ${what}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate untrusted case.json data before exposing it as an EvalCase. */
export function validateCase(raw: unknown, caseDir: string): EvalCase {
  if (!isRecord(raw)) fail(caseDir, 'not an object');

  for (const key of ['id', 'app'] as const) {
    if (typeof raw[key] !== 'string' || !raw[key]) fail(caseDir, `missing required field "${key}"`);
  }

  const event = raw['error_event'];
  if (!isRecord(event)) fail(caseDir, 'missing required field "error_event"');

  const error = event['error'];
  if (!isRecord(error)) fail(caseDir, 'error_event.error is missing');
  for (const key of ['type', 'message', 'stack'] as const) {
    if (typeof error[key] !== 'string') fail(caseDir, `error_event.error.${key} must be a string`);
  }

  const breadcrumbs = event['breadcrumbs'];
  if (!Array.isArray(breadcrumbs)) fail(caseDir, 'error_event.breadcrumbs must be an array');
  breadcrumbs.forEach((breadcrumb, index) => {
    if (!isRecord(breadcrumb)) fail(caseDir, `error_event.breadcrumbs[${index}] is not an object`);
    const timestamp = breadcrumb['timestamp'];
    if (typeof timestamp !== 'string' || !ISO.test(timestamp)) {
      fail(
        caseDir,
        `error_event.breadcrumbs[${index}].timestamp must be an ISO 8601 string, got ${JSON.stringify(timestamp)}`,
      );
    }
    for (const key of ['type', 'category', 'message'] as const) {
      if (typeof breadcrumb[key] !== 'string') {
        fail(caseDir, `error_event.breadcrumbs[${index}].${key} must be a string`);
      }
    }
  });

  if (event['platform'] !== undefined && typeof event['platform'] !== 'string') {
    fail(caseDir, 'error_event.platform must be a string when present');
  }
  if (event['context'] !== undefined && !isRecord(event['context'])) {
    fail(caseDir, 'error_event.context must be an object when present');
  }

  const grading = raw['grading'];
  if (!isRecord(grading)) fail(caseDir, 'missing required field "grading"');
  for (const key of ['fail_to_pass', 'pass_to_pass'] as const) {
    if (!Array.isArray(grading[key])) fail(caseDir, `grading.${key} must be an array`);
  }

  const expected = raw['expected'];
  if (!isRecord(expected)) fail(caseDir, 'missing required field "expected"');
  if (!OUTCOMES.includes(expected['outcome'] as (typeof OUTCOMES)[number])) {
    fail(
      caseDir,
      `expected.outcome must be one of ${OUTCOMES.join(', ')}, got ${JSON.stringify(expected['outcome'])}`,
    );
  }

  return raw as unknown as EvalCase;
}
