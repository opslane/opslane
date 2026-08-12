import { afterEach, describe, expect, it, vi } from 'vitest';
import { processScoreSyncJob, syncScoresForPrOutcome } from '../score-sync.js';
import type { ClaimedJob } from '../db.js';

vi.mock('../db.js', () => ({ getPool: vi.fn() }));
vi.mock('../scores.js', () => ({ pushScore: vi.fn() }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { getPool } = await import('../db.js');
const { pushScore } = await import('../scores.js');

describe('syncScoresForPrOutcome', () => {
  it('loads the trace tenant-scoped and pushes an idempotent outcome score', async () => {
    const loadTraceUrl = vi.fn().mockResolvedValue(
      'https://us.cloud.langfuse.com/project/proj/traces/abc123',
    );
    const push = vi.fn().mockResolvedValue(true);
    await syncScoresForPrOutcome(
      {
        fixJobId: 'fj1', projectId: 'p1', outcome: 'merged', deliveryId: 'd1',
        occurredAt: '2026-08-08T12:00:00Z',
      },
      { loadTraceUrl, push },
    );
    expect(loadTraceUrl).toHaveBeenCalledWith('fj1', 'p1');
    expect(push).toHaveBeenCalledWith({
      traceId: 'abc123',
      name: 'pr_outcome',
      value: 'merged',
      dataType: 'CATEGORICAL',
      id: 'pr-outcome-d1',
      metadata: { occurred_at: '2026-08-08T12:00:00Z' },
    });
  });

  it('throws when trace_url is not available yet', async () => {
    const push = vi.fn();
    await expect(syncScoresForPrOutcome(
      { fixJobId: 'fj1', projectId: 'p1', outcome: 'closed', deliveryId: 'd2' },
      { loadTraceUrl: vi.fn().mockResolvedValue(null), push },
    )).rejects.toThrow('no trace_url yet');
    expect(push).not.toHaveBeenCalled();
  });

  it('treats a trace_url without a traces segment as unresolvable', async () => {
    const push = vi.fn();
    await expect(syncScoresForPrOutcome(
      { fixJobId: 'fj1', projectId: 'p1', outcome: 'merged', deliveryId: 'd4' },
      {
        loadTraceUrl: vi.fn().mockResolvedValue('https://langfuse.example.com/project/p/sessions/abc'),
        push,
      },
    )).rejects.toThrow('no trace_url yet');
    expect(push).not.toHaveBeenCalled();
  });

  it('treats an unparseable trace_url as unresolvable', async () => {
    const push = vi.fn();
    await expect(syncScoresForPrOutcome(
      { fixJobId: 'fj1', projectId: 'p1', outcome: 'merged', deliveryId: 'd5' },
      { loadTraceUrl: vi.fn().mockResolvedValue('not a url'), push },
    )).rejects.toThrow('no trace_url yet');
    expect(push).not.toHaveBeenCalled();
  });

  it('propagates score push failures', async () => {
    await expect(syncScoresForPrOutcome(
      { fixJobId: 'fj1', projectId: 'p1', outcome: 'merged', deliveryId: 'd3' },
      {
        loadTraceUrl: vi.fn().mockResolvedValue('https://x/traces/t9'),
        push: vi.fn().mockRejectedValue(new Error('Langfuse score rejected: 503')),
      },
    )).rejects.toThrow('503');
  });
});

describe('processScoreSyncJob', () => {
  const baseJob: ClaimedJob = {
    id: 'ss-1', workerId: 'w1', leaseGeneration: '1',
    errorGroupId: 'g1', eventId: null, sourceId: null, projectId: 'p1',
    jobType: 'score_sync', attempts: 0, guidance: null,
    triggeredBy: null, sessionId: null,
    payload: { fix_job_id: 'fj1', outcome: 'merged', delivery_id: 'd1' },
  };

  function enableTracing(): void {
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://us.cloud.langfuse.com');
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-test');
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-test');
    vi.stubEnv('LANGFUSE_PROJECT_ID', 'proj');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('is a permanent no-op when tracing is disabled', async () => {
    await expect(processScoreSyncJob(baseJob)).resolves.toBeUndefined();
    expect(getPool).not.toHaveBeenCalled();
    expect(pushScore).not.toHaveBeenCalled();
  });

  it('reads the snake_case payload written by the Go enqueue and pushes the score', async () => {
    enableTracing();
    const query = vi.fn().mockResolvedValue({
      rows: [{ trace_url: 'https://us.cloud.langfuse.com/project/proj/traces/t1' }],
    });
    vi.mocked(getPool).mockReturnValue({ query } as never);
    vi.mocked(pushScore).mockResolvedValue(true);

    await processScoreSyncJob({
      ...baseJob,
      payload: {
        fix_job_id: 'fj1', outcome: 'merged', delivery_id: 'd1',
        occurred_at: '2026-08-08T12:00:00Z',
      },
    });

    expect(query).toHaveBeenCalledWith(expect.any(String), ['fj1', 'p1']);
    expect(pushScore).toHaveBeenCalledWith({
      traceId: 't1',
      name: 'pr_outcome',
      value: 'merged',
      dataType: 'CATEGORICAL',
      id: 'pr-outcome-d1',
      metadata: { occurred_at: '2026-08-08T12:00:00Z' },
    });
  });

  it('throws when the tracing config is incomplete so the queue retries', async () => {
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://us.cloud.langfuse.com');
    // public/secret keys missing: operator error, not "disabled"
    await expect(processScoreSyncJob(baseJob)).rejects.toThrow('tracing config incomplete');
    expect(getPool).not.toHaveBeenCalled();
    expect(pushScore).not.toHaveBeenCalled();
  });

  it('drops cleanly when no trace_url exists and LANGFUSE_PROJECT_ID is unset', async () => {
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://us.cloud.langfuse.com');
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-test');
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-test');
    // no LANGFUSE_PROJECT_ID: trace URLs are never recorded in this config,
    // so "no trace_url yet" is "never" — retrying would only dead-letter
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.mocked(getPool).mockReturnValue({ query } as never);

    await expect(processScoreSyncJob(baseJob)).resolves.toBeUndefined();
    expect(pushScore).not.toHaveBeenCalled();
  });

  it('still throws on a missing trace_url when LANGFUSE_PROJECT_ID is set', async () => {
    enableTracing();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.mocked(getPool).mockReturnValue({ query } as never);

    await expect(processScoreSyncJob(baseJob)).rejects.toThrow('no trace_url yet');
  });

  it('drops a malformed payload without querying or pushing', async () => {
    enableTracing();
    await expect(processScoreSyncJob({
      ...baseJob,
      // camelCase keys: the drift the snake_case contract test guards against
      payload: { fixJobId: 'fj1', outcome: 'merged', deliveryId: 'd1' },
    })).resolves.toBeUndefined();
    expect(getPool).not.toHaveBeenCalled();
    expect(pushScore).not.toHaveBeenCalled();
  });

  it('drops an unknown outcome value without pushing', async () => {
    enableTracing();
    await expect(processScoreSyncJob({
      ...baseJob,
      payload: { fix_job_id: 'fj1', outcome: 'reopened', delivery_id: 'd1' },
    })).resolves.toBeUndefined();
    expect(pushScore).not.toHaveBeenCalled();
  });
});
