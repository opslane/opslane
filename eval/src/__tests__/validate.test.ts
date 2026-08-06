import { describe, expect, it } from 'vitest';
import { validateCase } from '../validate.js';

function baseCase(): Record<string, unknown> {
  return {
    id: 'demo-001',
    app: 'demo',
    bug_patch: null,
    error_event: {
      error: { type: 'TypeError', message: 'boom', stack: 'at App.vue:1:1' },
      breadcrumbs: [
        { type: 'fetch', timestamp: '2026-08-06T10:00:00.000Z', category: 'fetch', message: 'GET /a' },
      ],
      context: {},
    },
    expected: { outcome: 'fix_pr' },
    grading: { fail_to_pass: [], pass_to_pass: [] },
  };
}

function errorEvent(c: Record<string, unknown>): Record<string, unknown> {
  return c['error_event'] as Record<string, unknown>;
}

function firstBreadcrumb(c: Record<string, unknown>): Record<string, unknown> {
  return (errorEvent(c)['breadcrumbs'] as Array<Record<string, unknown>>)[0]!;
}

describe('validateCase', () => {
  it('accepts a well-formed case', () => {
    expect(() => validateCase(baseCase(), 'cases/demo-001')).not.toThrow();
  });

  it('rejects a breadcrumb with no timestamp', () => {
    const c = baseCase();
    delete firstBreadcrumb(c)['timestamp'];
    expect(() => validateCase(c, 'cases/demo-001')).toThrow(/breadcrumbs\[0\].*timestamp/);
  });

  it('rejects a breadcrumb with a non-ISO timestamp', () => {
    const c = baseCase();
    firstBreadcrumb(c)['timestamp'] = 'yesterday';
    expect(() => validateCase(c, 'cases/demo-001')).toThrow(/breadcrumbs\[0\].*timestamp/);
  });

  it('accepts an empty breadcrumb list', () => {
    const c = baseCase();
    errorEvent(c)['breadcrumbs'] = [];
    expect(() => validateCase(c, 'cases/demo-001')).not.toThrow();
  });

  it('names the case directory in the error', () => {
    const c = baseCase();
    delete c['id'];
    expect(() => validateCase(c, 'cases/demo-001')).toThrow(/cases\/demo-001/);
  });

  it('rejects an unknown expected.outcome', () => {
    const c = baseCase();
    (c['expected'] as Record<string, unknown>)['outcome'] = 'maybe';
    expect(() => validateCase(c, 'cases/demo-001')).toThrow(/expected\.outcome/);
  });
});
