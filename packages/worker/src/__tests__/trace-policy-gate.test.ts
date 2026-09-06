import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spans = vi.hoisted(() => [] as Array<{ attributes: Record<string, unknown> }>);

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      getTracer: () => ({
        startActiveSpan: async <T>(
          _name: string,
          fn: (span: {
            attributes: Record<string, unknown>;
            setAttribute(key: string, value: unknown): void;
            setStatus(): void;
            recordException(): void;
            end(): void;
          }) => Promise<T>,
        ): Promise<T> => {
          const span = {
            attributes: {} as Record<string, unknown>,
            setAttribute(key: string, value: unknown) { this.attributes[key] = value; },
            setStatus() {},
            recordException() {},
            end() {},
          };
          spans.push(span);
          return fn(span);
        },
      }),
      getSpan: actual.trace.getSpan.bind(actual.trace),
    },
  };
});

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    start(): void {}
    async shutdown(): Promise<void> {}
  },
}));
vi.mock('@langfuse/otel', () => ({ LangfuseSpanProcessor: class {} }));
vi.mock('@arizeai/openinference-instrumentation-anthropic', () => ({
  AnthropicInstrumentation: class {
    manuallyInstrument(): void {}
    disable(): void {}
  },
}));

function job(jobType: 'session_analysis' | 'stack_resolve' | 'investigate' = 'session_analysis') {
  return {
    id: 'job-1',
    jobType,
    projectId: 'proj-1',
    errorGroupId: null,
    sourceId: null,
    sessionId: 'sess-1',
    attempts: 0,
  };
}

describe('withJobTrace policy gate', () => {
  beforeEach(() => {
    spans.length = 0;
    process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-test';
    process.env['LANGFUSE_SECRET_KEY'] = 'sk-lf-test';
    process.env['LANGFUSE_BASE_URL'] = 'https://us.cloud.langfuse.com';
  });

  afterEach(async () => {
    const { shutdownTracing } = await import('../tracing.js');
    await shutdownTracing();
    delete process.env['LANGFUSE_PUBLIC_KEY'];
    delete process.env['LANGFUSE_SECRET_KEY'];
    delete process.env['LANGFUSE_BASE_URL'];
  });

  it('creates no span for a policy-off job and records the type for a traced job', async () => {
    const { initTracing, withJobTrace } = await import('../tracing.js');
    await initTracing();

    await expect(withJobTrace(job(), async () => 'off')).resolves.toBe('off');
    expect(spans).toHaveLength(0);

    await expect(withJobTrace(job('investigate'), async () => 'full')).resolves.toBe('full');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['job.type']).toBe('investigate');
  });
});
