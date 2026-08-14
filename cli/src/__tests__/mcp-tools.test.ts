import { describe, expect, it } from 'vitest';
import { recordingLine, selectWorklist } from '../mcp/tools.js';
import type { McpIncident } from '../mcp/types.js';

function incident(overrides: Partial<McpIncident>): McpIncident {
  return {
    id: '9d4e2a71-77aa-4f83-b8f1-0123456789ab',
    kind: 'friction',
    title: 'Dead clicks',
    status: 'insight',
    occurrence_count: 1,
    affected_users_count: 1,
    first_seen: '2026-07-29T00:00:00Z',
    last_seen: '2026-08-13T00:00:00Z',
    ...overrides,
  };
}

describe('selectWorklist', () => {
  it('drops incidents whose investigation was marked ineligible', () => {
    const result = selectWorklist([
      incident({ id: 'a', investigation_readiness: 'eligible' }),
      incident({ id: 'b', investigation_readiness: 'ineligible' }),
    ]);
    expect(result.rows.map((r) => r.id)).toEqual(['a']);
    expect(result.droppedIneligible).toBe(1);
  });

  it('keeps incidents with no readiness recorded', () => {
    expect(selectWorklist([incident({ id: 'a' })]).rows).toHaveLength(1);
  });

  it('drops errors, since version 1 is friction only', () => {
    const result = selectWorklist([
      incident({ id: 'a', kind: 'friction' }),
      incident({ id: 'b', kind: 'error' }),
    ]);
    expect(result.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('drops incidents that are already finished', () => {
    const result = selectWorklist([
      incident({ id: 'a', status: 'insight' }),
      incident({ id: 'b', status: 'resolved' }),
      incident({ id: 'c', status: 'archived' }),
      incident({ id: 'd', status: 'merged' }),
    ]);
    expect(result.rows.map((r) => r.id)).toEqual(['a']);
  });
});

describe('recordingLine', () => {
  const withSession = incident({
    watchable_session: { session_id: 's1', anchor_ms: 98000 },
  });

  it('builds a seekable link when a dashboard url is configured', () => {
    expect(recordingLine(withSession, 'https://app.example.com/'))
      .toContain('https://app.example.com/sessions/s1?t=98000');
  });

  it('reports the session and anchor without inventing an origin', () => {
    const line = recordingLine(withSession, null);
    expect(line).toContain('s1');
    expect(line).toContain('98000');
    expect(line).not.toContain('http');
  });

  it('returns null when there is no watchable session', () => {
    expect(recordingLine(incident({}), 'https://app.example.com')).toBeNull();
  });
});
