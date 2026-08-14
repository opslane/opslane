import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildTriagedPayload,
  incidentURL,
  isTriageTerminalStatus,
  triageLabel,
  triagedDedupKey,
} from '../db.js';

const originalDashboardURL = process.env['DASHBOARD_URL'];

afterEach(() => {
  if (originalDashboardURL === undefined) delete process.env['DASHBOARD_URL'];
  else process.env['DASHBOARD_URL'] = originalDashboardURL;
});

describe('issue.triaged helpers', () => {
  it('recognizes only paging terminals', () => {
    expect(isTriageTerminalStatus('needs_human')).toBe(true);
    expect(isTriageTerminalStatus('pr_created')).toBe(true);
    expect(isTriageTerminalStatus('insight')).toBe(false);
    expect(isTriageTerminalStatus('fixing')).toBe(false);
  });

  it('keys labels on terminal status and reason', () => {
    expect(triageLabel('pr_created', 'low_confidence_fix')).toBe('Fix PR opened');
    expect(triageLabel('needs_human', 'worker_runtime_error')).toBe('Needs review — investigation crashed');
    expect(triageLabel('needs_human', 'future_reason')).toBe('Needs review');
  });

  it('includes the terminal job in the dedup key', () => {
    expect(triagedDedupKey('group', 'job')).toBe('issue.triaged:group:job');
  });

  it.each([
    ['https://app.example.com', 'https://app.example.com/incidents/G?project_id=P'],
    ['https://app.example.com/', 'https://app.example.com/incidents/G?project_id=P'],
    ['https://app.example.com/base///', 'https://app.example.com/base/incidents/G?project_id=P'],
    ['http://localhost:3000', ''],
    ['ftp://app.example.com', ''],
    [undefined, ''],
  ])('matches incident URL behavior for %s', (base, expected) => {
    expect(incidentURL(base, 'G', 'P')).toBe(expected);
  });

  it('constructs the shared cross-runtime fixture without model prose', () => {
    process.env['DASHBOARD_URL'] = 'https://app.example.com';
    const payload = buildTriagedPayload({
      id: '11111111-1111-4111-8111-111111111111',
      title: 'TypeError: checkout failed',
      first_seen: '2026-08-13T00:00:00Z',
      project_id: '22222222-2222-4222-8222-222222222222',
      project_name: 'storefront',
      environment: 'production',
      identified_users: 2,
      recent_anon_sessions: 3,
    }, 'needs_human', 'insufficient_context');
    const fixture = JSON.parse(readFileSync(
      new URL('../../../../test-fixtures/wire/issue-triaged-v1.json', import.meta.url),
      'utf8',
    ));
    expect(payload).toEqual(fixture);
    expect(JSON.stringify(payload)).not.toContain('reason_message');
    expect(JSON.stringify(payload)).not.toContain('root_cause');
  });
});
