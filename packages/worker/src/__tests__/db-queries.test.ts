import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pg module. claimJob checks out a client for its advisory-locked
// transaction; route the client's queries through the same mock so tests can
// assert on the claim SQL.
const mockQuery = vi.fn();
const mockClient = { query: mockQuery, release: vi.fn() };
vi.mock('pg', () => ({
  default: { Pool: vi.fn(() => ({ query: mockQuery, connect: vi.fn(async () => mockClient), end: vi.fn() })) },
  Pool: vi.fn(() => ({ query: mockQuery, connect: vi.fn(async () => mockClient), end: vi.fn() })),
}));

import {
  getErrorGroup,
  getErrorEvent,
  getEnvironmentNamesForGroup,
  getProject,
  getReplayForGroup,
  getSessionPointerForGroup,
  getPlayableChunkMetas,
  getReplayArtifacts,
  getSourceMapRows,
  setEventResolution,
  requeueStaleJobs,
  getFrictionSignalsForGroup,
  getScrubbedChunksForSession,
  getSessionForAnalysis,
  setSessionAnalysisStatus,
  claimJob,
  listUnmappedPatterns,
  MAX_ROUTE_PATTERN_BYTES,
  upsertRouteMapRows,
  updateGroupStatus,
  updateGroupInvestigation,
} from '../db.js';

describe('group lifecycle timestamp queries', () => {
  beforeEach(() => mockQuery.mockReset());

  it('stamps PR-created and needs-human transitions without clearing prior timestamps', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: 'g1' }] });

    await updateGroupStatus('g1', 'p1', 'pr_created');
    await updateGroupStatus('g1', 'p1', 'needs_human', {
      reason: {
        reason_code: 'missing_llm_key',
        reason_message: 'API key not configured',
        remediation: 'Configure the worker API key',
      },
    });

    // A needs_human transition also demotes a pending readiness row in a
    // follow-up query; assert the timestamp CASEs on the group updates only.
    const groupUpdates = mockQuery.mock.calls.filter(
      (call) => String(call[0]).includes('UPDATE error_groups'),
    );
    expect(groupUpdates).toHaveLength(2);
    for (const call of groupUpdates) {
      const query = String(call[0]);
      expect(query).toContain("WHEN $3::error_group_status = 'pr_created'");
      expect(query).toContain("AND status IS DISTINCT FROM 'pr_created' THEN now()");
      expect(query).toContain('ELSE pr_created_at');
      expect(query).toContain("WHEN $3::error_group_status = 'needs_human'");
      expect(query).toContain("AND status IS DISTINCT FROM 'needs_human' THEN now()");
      expect(query).toContain('ELSE needs_human_at');
    }
    expect(groupUpdates[0]?.[1]?.[2]).toBe('pr_created');
    expect(groupUpdates[1]?.[1]?.[2]).toBe('needs_human');
    const demotion = mockQuery.mock.calls.find(
      (call) => String(call[0]).includes('UPDATE digest_readiness'),
    );
    expect(String(demotion?.[0])).toContain("status = 'pending'");
    expect(demotion?.[1]?.[2]).toBe('missing_llm_key');
  });

  it('stamps needs-human investigation results without clearing lifecycle timestamps', async () => {
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'g1' }] })
      .mockResolvedValueOnce({});

    await updateGroupInvestigation('g1', 'p1', 'needs_human', {
      rootCause: 'External dependency failed',
      reason: {
        reason_code: 'worker_runtime_error',
        reason_message: 'The investigation could not complete',
        remediation: 'Review the incident manually',
      },
    });

    const query = String(mockQuery.mock.calls[1]?.[0]);
    expect(query).toContain("WHEN $3::error_group_status = 'pr_created'");
      expect(query).toContain("AND status IS DISTINCT FROM 'pr_created' THEN now()");
    expect(query).toContain('ELSE pr_created_at');
    expect(query).toContain("WHEN $3::error_group_status = 'needs_human'");
      expect(query).toContain("AND status IS DISTINCT FROM 'needs_human' THEN now()");
    expect(query).toContain('ELSE needs_human_at');
    expect(mockQuery.mock.calls[1]?.[1]?.[2]).toBe('needs_human');
  });

  it('persists candidate_diff and verification_evidence on needs_human', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: 'g1' }] });
    await updateGroupStatus('g1', 'p1', 'needs_human', {
      reason: { reason_code: 'low_confidence_fix', reason_message: 'm', remediation: 'r' },
      candidate_diff: 'DIFF',
      evidence: { version: 1, tier: 'E0', checks: [] },
    });
    // The last call is the pending-readiness demotion; the group update is the
    // one carrying the diff and evidence.
    const groupUpdate = mockQuery.mock.calls.find(
      (call) => String(call[0]).includes('UPDATE error_groups'),
    ) as [string, unknown[]];
    const [sql, params] = groupUpdate;
    expect(sql).toContain('candidate_diff');
    expect(sql).toContain('verification_evidence');
    expect(params).toContain('DIFF');
    expect(params).toContain(JSON.stringify({ version: 1, tier: 'E0', checks: [] }));
  });
});

describe('getErrorGroup', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns group data for valid ID with projectId scope', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'g1', title: 'TypeError: x', fingerprint: 'abc123',
        sample_event_id: 'e1', occurrence_count: 5, status: 'analyzing',
        kind: 'friction', signal_type: 'dead_click', element_selector: '#save',
        page_url_normalized: 'https://example.com/settings',
      }],
    });
    const group = await getErrorGroup('g1', 'p1');
    expect(group).toEqual(expect.objectContaining({ id: 'g1', title: 'TypeError: x' }));
    expect(group?.kind).toBe('friction');
    expect(mockQuery.mock.calls[0][0]).toContain('kind');
    // Verify both groupId and projectId are passed as params
    expect(mockQuery.mock.calls[0][1]).toEqual(['g1', 'p1']);
  });

  it('returns null when group not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const group = await getErrorGroup('nonexistent', 'p1');
    expect(group).toBeNull();
  });
});

describe('getEnvironmentNamesForGroup', () => {
  beforeEach(() => mockQuery.mockReset());

  it('loads error-group environments from the rollup with project and kind scope', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { name: 'production', total_count: 2 },
        { name: 'staging', total_count: 2 },
      ],
    });

    const names = await getEnvironmentNamesForGroup('g1', 'p1', 'error');

    expect(names).toEqual({ names: ['production', 'staging'], totalCount: 2 });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('error_group_environments');
    expect(sql).toContain("eg.kind = 'error'");
    expect(sql).toContain('eg.project_id = $2');
    expect(sql).toContain('e.project_id = eg.project_id');
    expect(sql).toContain('COUNT(*) OVER()');
    expect(sql).toContain('LIMIT 20');
    expect(params).toEqual(['g1', 'p1']);
  });

  it('loads a friction incident environment from error_groups without consulting the rollup', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'production', total_count: 1 }] });

    const names = await getEnvironmentNamesForGroup('g2', 'p1', 'friction');

    expect(names).toEqual({ names: ['production'], totalCount: 1 });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('e.id = eg.environment_id');
    expect(sql).toContain("eg.kind = 'friction'");
    expect(sql).not.toContain('error_group_environments');
    expect(sql).toContain('eg.project_id = $2');
    expect(sql).toContain('e.project_id = eg.project_id');
    expect(sql).toContain('COUNT(*) OVER()');
    expect(sql).toContain('LIMIT 20');
    expect(params).toEqual(['g2', 'p1']);
  });
});

describe('friction and session queries', () => {
  beforeEach(() => mockQuery.mockReset());

  it('loads live friction signals with incident and tenant scope', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getFrictionSignalsForGroup('g1', 'p1');
    expect(mockQuery.mock.calls[0][0]).toContain('incident_id = $1 AND project_id = $2');
    expect(mockQuery.mock.calls[0][1]).toEqual(['g1', 'p1']);
  });

  it('loads only scrubbed chunks in sequence order', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getScrubbedChunksForSession('s1', 'p1');
    expect(mockQuery.mock.calls[0][0]).toContain('scrubbed_at IS NOT NULL');
    expect(mockQuery.mock.calls[0][1]).toEqual(['s1', 'p1']);
  });

  it('loads the session analysis identity and status', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: 's1', project_id: 'p1', environment_id: 'e1', end_user_id: null, status: 'closed',
    }] });
    const session = await getSessionForAnalysis('s1', 'p1');
    expect(session?.environment_id).toBe('e1');
    expect(mockQuery.mock.calls[0][0]).toContain('end_user_id, status');
  });

  it('updates analysis status and optional rule version with tenant scope', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await setSessionAnalysisStatus('s1', 'p1', 'analyzed', 1);
    expect(mockQuery.mock.calls[0][1]).toEqual(['s1', 'p1', 'analyzed', 1]);
  });

  it('fences session status writes to the current session lease', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 's1' }] });
    await setSessionAnalysisStatus('s1', 'p1', 'analyzed', 1, {
      id: 'j1',
      workerId: 'worker-1',
      leaseGeneration: '7',
      projectId: 'p1',
      errorGroupId: null,
      sessionId: 's1',
    });

    expect(mockQuery.mock.calls[0][0]).toContain('lease_generation = $7::bigint');
    expect(mockQuery.mock.calls[0][0]).toContain('session_id IS NOT DISTINCT FROM $1');
    expect(mockQuery.mock.calls[0][1]).toEqual([
      's1', 'p1', 'analyzed', 1, 'j1', 'worker-1', '7', null,
    ]);
  });
});

describe('claimJob friction scheduling fields', () => {
  beforeEach(() => mockQuery.mockReset());

  it('demotes session analysis and returns receipts/session identity', async () => {
    // Transaction sequence: BEGIN, advisory lock, UPDATE, COMMIT.
    mockQuery.mockResolvedValueOnce({}); // BEGIN
    mockQuery.mockResolvedValueOnce({}); // pg_advisory_xact_lock
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: 'j1', error_group_id: null, source_id: null, project_id: 'p1',
      job_type: 'session_analysis', attempts: 0, guidance: null,
      worker_id: 'worker-1', lease_generation: '1',
      triggered_by: 'auto', session_id: 's1',
    }] });
    mockQuery.mockResolvedValueOnce({}); // COMMIT

    const job = await claimJob('worker-1', 30_000);

    expect(job).toEqual(expect.objectContaining({ sessionId: 's1', triggeredBy: 'auto' }));
    // Serialized admission (issue #28): the claim runs under an advisory lock.
    expect(mockQuery.mock.calls[0][0]).toBe('BEGIN');
    expect(mockQuery.mock.calls[1][0]).toContain('pg_advisory_xact_lock');
    // Scheduling policy: error_fix first, capped analysis, lane alternation.
    const claimSql = mockQuery.mock.calls[2][0] as string;
    expect(claimSql).toContain("WHEN job_type = 'error_fix' THEN 0");
    expect(claimSql).toContain("WHEN job_type = 'route_map' THEN 4");
    expect(claimSql.indexOf("WHEN job_type = 'route_map' THEN 4"))
      .toBeLessThan(claimSql.indexOf("WHEN job_type <> 'session_analysis' THEN 2"));
    expect(claimSql).toContain("AND job_type = 'session_analysis'");
    expect(claimSql).toContain('< $3');
    // Cap defaults to 2 when SESSION_ANALYSIS_MAX_CONCURRENT is unset.
    expect(mockQuery.mock.calls[2][1]).toEqual(['worker-1', 30, 2]);
    expect(mockQuery.mock.calls[3][0]).toBe('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('passes an explicit session_analysis cap through to the claim query', async () => {
    mockQuery.mockResolvedValueOnce({}); // BEGIN
    mockQuery.mockResolvedValueOnce({}); // advisory lock
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({}); // COMMIT
    await claimJob('worker-1', 30_000, 0);
    expect(mockQuery.mock.calls[2][1]).toEqual(['worker-1', 30, 0]);
  });
});

describe('route-map persistence queries', () => {
  beforeEach(() => mockQuery.mockReset());

  it('lists distinct unmapped patterns only for open groups in one project', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ pattern: '/assets/:id' }] });

    await expect(listUnmappedPatterns('p1')).resolves.toEqual(['/assets/:id']);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('eg.project_id = $1');
    expect(sql).toContain("eg.status NOT IN ('resolved', 'merged', 'archived')");
    expect(sql).toContain('rm.pattern = eg.page_url_normalized');
    // A pattern too large for route_map's btree key would abort the single
    // transaction that writes every other route for the project.
    expect(sql).toContain('octet_length(eg.page_url_normalized) <= $2');
    expect(params).toEqual(['p1', MAX_ROUTE_PATTERN_BYTES]);
    expect(MAX_ROUTE_PATTERN_BYTES).toBeLessThan(2704);
  });

  it('lease-fences classification and unresolved writes and preserves human rows', async () => {
    mockQuery.mockResolvedValueOnce({}); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] }); // lease
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // model row
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // unresolved row
    mockQuery.mockResolvedValueOnce({}); // COMMIT

    await expect(upsertRouteMapRows({
      projectId: 'p1',
      jobId: 'j1',
      workerId: 'w1',
      leaseGeneration: '7',
      rows: [{ pattern: '/assets/:id', name: 'Asset', purpose: 'View asset', tier: 'standard' }],
      unresolved: ['/unknown'],
    })).resolves.toBe(true);

    const leaseSql = String(mockQuery.mock.calls[1]?.[0]);
    expect(leaseSql).toContain('project_id = $2');
    expect(leaseSql).toContain('lease_generation = $4::bigint');
    expect(leaseSql).toContain("status = 'claimed'");
    expect(leaseSql).toContain('lease_expires_at > now()');
    expect(leaseSql).toContain('FOR UPDATE');
    expect(mockQuery.mock.calls[1]?.[1]).toEqual(['j1', 'p1', 'w1', '7']);

    const writeSql = String(mockQuery.mock.calls[2]?.[0]);
    expect(writeSql).toContain("WHERE route_map.source <> 'human'");
    expect(mockQuery.mock.calls[2]?.[1]).toEqual([
      'p1', '/assets/:id', 'Asset', 'View asset', 'standard', 'llm',
    ]);
    expect(mockQuery.mock.calls[3]?.[1]).toEqual([
      'p1', '/unknown', '/unknown', 'unclassified', 'standard', 'llm-unresolved',
    ]);
    expect(mockQuery.mock.calls[4]?.[0]).toBe('COMMIT');
  });

  it('writes nothing when the job lease is no longer current', async () => {
    mockQuery.mockResolvedValueOnce({}); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // lease
    mockQuery.mockResolvedValueOnce({}); // ROLLBACK

    await expect(upsertRouteMapRows({
      projectId: 'p1', jobId: 'j1', workerId: 'w1', leaseGeneration: '6',
      rows: [{ pattern: '/', name: 'Home', purpose: '', tier: 'standard' }],
      unresolved: [],
    })).resolves.toBe(false);

    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls[2]?.[0]).toBe('ROLLBACK');
  });
});

describe('getErrorEvent', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns event with all fields including release and session_id', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'e1', error_type: 'TypeError', error_message: 'x is not defined',
        stack_trace_raw: 'at foo.js:1', stack_trace_resolved: null,
        debug_meta: null,
        breadcrumbs: '[]', context: '{}', release: 'v1.0.0', session_id: 'sess-1',
      }],
    });
    const event = await getErrorEvent('e1', 'p1');
    expect(event).toEqual(expect.objectContaining({
      id: 'e1', breadcrumbs: '[]', context: '{}', release: 'v1.0.0', session_id: 'sess-1',
    }));
    expect(mockQuery.mock.calls[0][0]).toContain('breadcrumbs::text AS breadcrumbs');
    expect(mockQuery.mock.calls[0][0]).toContain('context::text AS context');
    expect(mockQuery.mock.calls[0][0]).toContain('debug_meta::text AS debug_meta');
    expect(mockQuery.mock.calls[0][1]).toEqual(['e1', 'p1']);
  });
});

describe('getProject', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns project metadata', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'p1', name: 'My App', github_repo: 'org/repo', default_branch: 'main' }],
    });
    const project = await getProject('p1');
    expect(project?.github_repo).toBe('org/repo');
    expect(mockQuery.mock.calls[0][0]).toContain('friction_autonomy');
  });
});

describe('getReplayForGroup', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns null when no replay exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const replay = await getReplayForGroup('g1', 'p1');
    expect(replay).toBeNull();
  });

  it('joins via session_id through error_events', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'r1', session_id: 'sess-1', status: 'complete',
        replay_signals: { console: {} }, object_key: 'replays/p1/r1.json',
      }],
    });
    const replay = await getReplayForGroup('g1', 'p1');
    expect(replay?.id).toBe('r1');
    // Verify query uses projectId scope
    expect(mockQuery.mock.calls[0][1]).toContain('p1');
  });
});

describe('session replay pointer queries', () => {
  beforeEach(() => mockQuery.mockReset());

  it('resolves the newest session pointer with event time and project scope', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ kind: 'error' }] })
      .mockResolvedValueOnce({
        rows: [{ session_id: 'sess-1', error_at: new Date('2026-07-15T12:00:00Z') }],
      });

    const pointer = await getSessionPointerForGroup('g1', 'p1');

    expect(pointer).toEqual({ session_id: 'sess-1', error_at: '2026-07-15T12:00:00.000Z' });
    expect(mockQuery.mock.calls[1][1]).toEqual(['g1', 'p1']);
    expect(mockQuery.mock.calls[1][0]).toContain('ee.timestamp AS error_at');
    expect(mockQuery.mock.calls[1][0]).not.toContain('scrubbed_at');
  });

  it('uses the live friction representative with earliest accepted fallback ordering', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ kind: 'friction' }] })
      .mockResolvedValueOnce({
        rows: [{ session_id: 'sess-friction', error_at: '2026-07-15T12:00:00Z' }],
      });

    await expect(getSessionPointerForGroup('g1', 'p1')).resolves.toEqual({
      session_id: 'sess-friction', error_at: '2026-07-15T12:00:00Z',
    });
    const query = String(mockQuery.mock.calls[1]?.[0]);
    expect(query).toContain("fs.adjudication_status = 'accepted'");
    expect(query).toContain('fs.retracted_at IS NULL');
    expect(query).toContain('(fs.id = g.representative_signal_id) DESC');
  });

  it('returns scrubbed chunk metadata in sequence order and normalizes bigint strings', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        seq: 2,
        size_bytes: '1234',
        decoded_size_bytes: '5678',
        has_full_snapshot: true,
        first_event_ms: '1700000000000',
        last_event_ms: '1700000005000',
      }],
    });

    const chunks = await getPlayableChunkMetas('sess-1', 'p1');

    expect(chunks).toEqual([{
      seq: 2,
      size_bytes: 1234,
      decoded_size_bytes: 5678,
      has_full_snapshot: true,
      first_event_ms: 1700000000000,
      last_event_ms: 1700000005000,
    }]);
    expect(mockQuery.mock.calls[0][1]).toEqual(['sess-1', 'p1']);
    expect(mockQuery.mock.calls[0][0]).toContain('c.scrubbed_at IS NOT NULL');
    expect(mockQuery.mock.calls[0][0]).toContain('ORDER BY c.seq ASC');
  });
});

describe('getReplayArtifacts', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns artifact list with projectId scope', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'a1', kind: 'crash_viewport', object_key: 'replays/p1/a1.webp', content_type: 'image/webp', width: 1920, height: 1080 },
        { id: 'a2', kind: 'last_interaction_focus', object_key: 'replays/p1/a2.webp', content_type: 'image/webp', width: 800, height: 600 },
      ],
    });
    const artifacts = await getReplayArtifacts('r1', 'p1');
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].kind).toBe('crash_viewport');
  });
});

describe('source-map resolution queries', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns project-scoped rows for debug IDs', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        debug_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        object_key: 'sourcemaps/p1/a/map',
        content_sha256: '1'.repeat(64),
      }],
    });
    const maps = await getSourceMapRows('p1', [
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ]);
    expect(maps).toHaveLength(1);
    expect(maps[0]?.object_key).toContain('sourcemaps/p1/');
    expect(mockQuery.mock.calls[0]?.[1]).toEqual([
      'p1',
      ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    ]);
  });

  it('persists status and the pinned envelope with event and project scope', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await setEventResolution('e1', 'p1', 'resolved', {
      version: 1,
      frames: [{
        original_file: 'src/a.ts', original_line: 1, original_column: 0,
        source_snippet: 'source', generated_file: 'app.js',
        generated_line: 1, generated_column: 1,
        debug_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      }],
    });
    expect(mockQuery.mock.calls[0]?.[0]).toContain(
      'WHERE id = $1 AND project_id = $2',
    );
    expect(mockQuery.mock.calls[0]?.[1]?.slice(0, 3)).toEqual([
      'e1', 'p1', 'resolved',
    ]);
  });

  // Investigate and fix both resolve the same sample event, so a fix job
  // running during a storage blip must not erase the frames investigate stored.
  it('never overwrites a stored envelope with a failed re-resolution', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await setEventResolution('e1', 'p1', 'resolution_failed', null);
    const sql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sql).toContain(
      'stack_trace_resolved = COALESCE($4::jsonb, stack_trace_resolved)',
    );
    // The status has to move with the envelope or the pair can disagree.
    expect(sql).toContain(
      'WHEN $4::jsonb IS NULL AND stack_trace_resolved IS NOT NULL',
    );
    expect(mockQuery.mock.calls[0]?.[1]?.[3]).toBeNull();
  });
});

describe('requeueStaleJobs — reconcile dead-lettered fix jobs', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    // requeueStaleJobs now runs in a transaction (BEGIN → UPDATE ... RETURNING
    // → reconciliation → COMMIT); default every un-mocked call to empty.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('terminates a dead-lettered fix job group as needs_human (no stuck "fixing")', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'j1', error_group_id: 'g1', project_id: 'p1', job_type: 'fix', status: 'dead_letter' }],
    });

    const count = await requeueStaleJobs();
    expect(count).toBe(1);

    const statusCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('UPDATE error_groups') && c[1]?.[2] === 'needs_human',
    );
    expect(statusCall, 'expected a needs_human reconciliation update').toBeTruthy();
    expect(statusCall![1][0]).toBe('g1');         // errorGroupId
    expect(statusCall![1][7]).toBe('lease_lost'); // reason_code
    expect(statusCall![1][8]).toBeTruthy();        // reason_message
    expect(statusCall![1][9]).toBeTruthy();        // remediation
  });

  it('leaves requeued (non-dead-letter) and non-fix dead-letter jobs alone', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockQuery.mockResolvedValueOnce({
      rowCount: 2,
      rows: [
        { id: 'j2', error_group_id: 'g2', project_id: 'p1', job_type: 'fix', status: 'pending' },            // requeued, not dead
        { id: 'j3', error_group_id: 'g3', project_id: 'p1', job_type: 'investigate', status: 'dead_letter' }, // not a fix job
      ],
    });

    const count = await requeueStaleJobs();
    expect(count).toBe(2);

    const statusCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('UPDATE error_groups'),
    );
    expect(statusCall).toBeUndefined();
  });

  it('marks a dead-lettered session analysis as analysis_failed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        id: 'j4', error_group_id: null, session_id: 's1', project_id: 'p1',
        job_type: 'session_analysis', status: 'dead_letter',
      }],
    });

    await requeueStaleJobs();

    const update = mockQuery.mock.calls.find((call) => String(call[0]).includes('UPDATE sessions'));
    expect(update?.[1]).toEqual(['s1', 'p1']);
  });
});
