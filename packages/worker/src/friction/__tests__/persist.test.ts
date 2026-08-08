import { readFileSync } from 'node:fs';
import type { SessionChunkEnvelope } from '@opslane/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeSession, type DetectedSignal } from '../analyzer.js';

interface StoredSignal {
  sessionId: string;
  projectId: string;
  environmentId: string;
  endUserId: string | null;
  ruleVersion: number;
  fingerprint: string;
  retracted: boolean;
  supersededBy: string | null;
  occurrenceCount: number;
}

const rows = new Map<string, StoredSignal>();
const query = vi.fn(async (sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
  if (sql.includes('INSERT INTO friction_signals')) {
    const values = params ?? [];
    const key = `${String(values[0])}|${String(values[6])}|${String(values[4])}`;
    rows.set(key, {
      sessionId: String(values[0]),
      projectId: String(values[1]),
      environmentId: String(values[2]),
      endUserId: values[3] === null ? null : String(values[3]),
      ruleVersion: Number(values[4]),
      fingerprint: String(values[6]),
      retracted: false,
      supersededBy: rows.get(key)?.supersededBy ?? null,
      occurrenceCount: Number(values[11]),
    });
  } else if (sql.includes('UPDATE friction_signals SET retracted_at') && sql.includes('rule_version <')) {
    const values = params ?? [];
    for (const row of rows.values()) {
      if (row.sessionId === values[0] && row.projectId === values[1]
        && row.ruleVersion < Number(values[2]) && !row.retracted && row.supersededBy === null) {
        row.retracted = true;
      }
    }
  } else if (sql.includes('UPDATE friction_signals SET retracted_at')) {
    const values = params ?? [];
    const liveFingerprints = new Set(values[3] as string[]);
    for (const row of rows.values()) {
      if (
        row.sessionId === values[0] &&
        row.projectId === values[1] &&
        row.ruleVersion === values[2] &&
        !row.retracted &&
        row.supersededBy === null &&
        !liveFingerprints.has(row.fingerprint)
      ) {
        row.retracted = true;
      }
    }
  }
  return { rows: [], rowCount: 1 };
});
const release = vi.fn();
const connect = vi.fn(async () => ({ query, release }));

vi.mock('../../db.js', () => ({
  getPool: () => ({ connect }),
}));

import { writeFrictionSignals } from '../persist.js';

const session = {
  id: 'session-1',
  project_id: 'project-from-session',
  environment_id: 'environment-from-session',
  end_user_id: 'user-from-session',
  status: 'pending',
  started_at: '2026-08-01T00:00:00Z',
  chunk_count: 1,
};

function signal(fingerprint: string, occurrenceCount = 1): DetectedSignal {
  return {
    signalType: 'dead_click',
    fingerprint,
    elementSelector: '#save',
    pageUrlNormalized: 'https://app.example.com/checkout/:id',
    occurredAt: 1720000001000,
    occurredAts: [1720000001000],
    occurrenceCount,
    ruleVersion: 1,
  };
}

function lateChunkFixture(): SessionChunkEnvelope[] {
  return JSON.parse(
    readFileSync(new URL('./fixtures/late_chunk_retraction.json', import.meta.url), 'utf8'),
  ) as SessionChunkEnvelope[];
}

describe('writeFrictionSignals', () => {
  beforeEach(() => {
    rows.clear();
    query.mockClear();
    connect.mockClear();
    release.mockClear();
  });

  it('is idempotent for repeated whole-session passes', async () => {
    await writeFrictionSignals(session, [signal('A'), signal('B')], 1);
    await writeFrictionSignals(session, [signal('A'), signal('B')], 1);

    expect([...rows.values()]).toHaveLength(2);
    expect([...rows.values()].every((row) => !row.retracted)).toBe(true);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('ON CONFLICT'))).toHaveLength(4);
  });

  it('retracts absent signals and resurrects legitimate recurrences', async () => {
    await writeFrictionSignals(session, [signal('A'), signal('B')], 1);
    await writeFrictionSignals(session, [signal('A')], 1);

    expect(rows.get('session-1|A|1')?.retracted).toBe(false);
    expect(rows.get('session-1|B|1')?.retracted).toBe(true);

    await writeFrictionSignals(session, [signal('A'), signal('B', 2)], 1);
    expect(rows.get('session-1|B|1')).toMatchObject({ retracted: false, occurrenceCount: 2 });

    const stableState = structuredClone([...rows.entries()]);
    await writeFrictionSignals(session, [signal('A'), signal('B', 2)], 1);
    expect([...rows.entries()]).toEqual(stableState);
  });

  it('retracts and resurrects analyzer output as late-chunk truth changes', async () => {
    const chunks = lateChunkFixture();
    const firstPass = analyzeSession(chunks.slice(0, 1));
    expect(firstPass).toHaveLength(1);

    await writeFrictionSignals(session, firstPass, 1);
    const key = `session-1|${firstPass[0]?.fingerprint}|1`;
    expect(rows.get(key)?.retracted).toBe(false);

    await writeFrictionSignals(session, analyzeSession(chunks), 1);
    expect(rows.get(key)?.retracted).toBe(true);

    await writeFrictionSignals(session, firstPass, 1);
    expect(rows.get(key)?.retracted).toBe(false);
  });

  it('takes tenant dimensions from the session and never writes superseded_by', async () => {
    await writeFrictionSignals(session, [signal('A')], 1);

    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO friction_signals'));
    expect(insert?.[1]?.slice(0, 5)).toEqual([
      'session-1',
      'project-from-session',
      'environment-from-session',
      'user-from-session',
      1,
    ]);
    expect(insert?.[0]).not.toContain('superseded_by');
    expect(rows.get('session-1|A|1')?.supersededBy).toBeNull();
  });

  it('rebuilds every incident affected by a retraction in the same transaction', async () => {
    query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 })); // BEGIN
    query.mockImplementationOnce(async () => ({
      rows: [{ incident_id: 'incident-1' }, { incident_id: 'incident-1' }, { incident_id: null }],
      rowCount: 3,
    }));

    await writeFrictionSignals(session, [], 1);

    const sql = query.mock.calls.map(([statement]) => String(statement));
    expect(sql.some((statement) => statement.includes('FROM error_groups') && statement.includes('FOR UPDATE'))).toBe(true);
    expect(sql.filter((statement) => statement.includes('DELETE FROM error_group_environments'))).toHaveLength(1);
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it('rolls back and releases the client when a write fails', async () => {
    query.mockImplementationOnce(async () => ({ rows: [], rowCount: 1 }));
    query.mockRejectedValueOnce(new Error('insert failed'));

    await expect(writeFrictionSignals(session, [signal('A')], 1)).rejects.toThrow('insert failed');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
