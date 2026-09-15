import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';

const span = vi.hoisted(() => ({
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
}));

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class { start = vi.fn(); shutdown = vi.fn(async () => {}); },
}));
vi.mock('@langfuse/otel', () => ({ LangfuseSpanProcessor: class {} }));
vi.mock('@arizeai/openinference-instrumentation-anthropic', () => ({
  AnthropicInstrumentation: class { manuallyInstrument = vi.fn(); disable = vi.fn(); },
}));
vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  // Keep the real TraceAPI methods on the prototype chain; only the tracer is fake.
  const trace = Object.assign(Object.create(actual.trace) as typeof actual.trace, {
    getTracer: () => ({
      startActiveSpan: (_name: string, fn: (s: typeof span) => unknown) => fn(span),
    }),
  });
  return { ...actual, trace };
});

const ENV = {
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
  LANGFUSE_PROJECT_ID: 'proj-1',
};
const job = {
  id: 'j1', jobType: 'friction_confirm' as const, projectId: 'p1',
  errorGroupId: null, sourceId: null, sessionId: null, attempts: 0,
};

async function loadTracing() {
  vi.resetModules();
  const tracing = await import('../tracing.js');
  await tracing.initTracing();
  return tracing;
}

describe('withJobTrace completion signals', () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
    Object.values(span).forEach((fn) => fn.mockReset());
  });
  afterEach(async () => {
    // vi.resetModules() does not clear OpenTelemetry's global diag logger
    // (tracing-init.test.ts explains); leaving it registered leaks into later tests.
    const { diag } = await import('@opentelemetry/api');
    diag.disable();
    for (const key of Object.keys(ENV)) delete process.env[key];
  });

  it.each(['JobCompletedInTransaction', 'JobRescheduledError'])(
    'ends a job that threw %s with an OK status and no exception',
    async (name) => {
      const tracing = await loadTracing();
      const signal = Object.assign(new Error('finished'), { name });
      await expect(tracing.withJobTrace(job, () => Promise.reject(signal))).rejects.toBe(signal);
      expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
      expect(span.recordException).not.toHaveBeenCalled();
      expect(span.end).toHaveBeenCalledOnce();
    },
  );

  it('still records a real failure as an error with its exception', async () => {
    const tracing = await loadTracing();
    const failure = new Error('boom');
    await expect(tracing.withJobTrace(job, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'boom' });
    expect(span.recordException).toHaveBeenCalledWith(failure);
  });
});
