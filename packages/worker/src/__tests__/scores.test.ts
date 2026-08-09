import { describe, expect, it, vi } from 'vitest';
import { pushScore } from '../scores.js';

const ENABLED_ENV = {
  LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  LANGFUSE_PROJECT_ID: 'proj',
};

describe('pushScore', () => {
  it('posts with basic auth, a stable id, and a bounded timeout', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(pushScore(
      { traceId: 't1', name: 'pr_outcome', value: 'merged', dataType: 'CATEGORICAL', id: 'pr-outcome-d1' },
      { env: ENABLED_ENV, fetchImpl },
    )).resolves.toBe(true);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://us.cloud.langfuse.com/api/public/scores');
    expect(init).toMatchObject({ method: 'POST' });
    expect(init.headers['Authorization']).toBe(
      `Basic ${Buffer.from('pk-lf-test:sk-lf-test').toString('base64')}`,
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toMatchObject({
      id: 'pr-outcome-d1',
      traceId: 't1',
      name: 'pr_outcome',
      value: 'merged',
      dataType: 'CATEGORICAL',
    });
  });

  it('is a no-op when tracing is disabled', async () => {
    const fetchImpl = vi.fn();
    await expect(pushScore(
      { traceId: 't1', name: 'x', value: 'y', dataType: 'CATEGORICAL' },
      { env: {}, fetchImpl },
    )).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on a rejected request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(pushScore(
      { traceId: 't1', name: 'x', value: 'y', dataType: 'CATEGORICAL' },
      { env: ENABLED_ENV, fetchImpl },
    )).rejects.toThrow('Langfuse score rejected: 401');
  });
});
