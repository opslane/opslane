import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagThrottle, createDiagLogger } from '../tracing-diag.js';

const tracingSdk = vi.hoisted(() => ({ shutdown: vi.fn(async () => {}) }));

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    start(): void {}
    shutdown = tracingSdk.shutdown;
  },
}));
vi.mock('@langfuse/otel', () => ({ LangfuseSpanProcessor: class {} }));
vi.mock('@arizeai/openinference-instrumentation-anthropic', () => ({
  AnthropicInstrumentation: class {
    manuallyInstrument(): void {}
    disable(): void {}
  },
}));

describe('createDiagLogger export errors', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports every export error even when duplicate log lines are throttled', () => {
    const onExportError = vi.fn();
    const logger = createDiagLogger(new DiagThrottle(), (text) => text, () => 0, onExportError);

    logger.error('OTLPExporterError: Forbidden');
    logger.error('OTLPExporterError: Forbidden');
    logger.error('OTLPExporterError: Forbidden');

    expect(onExportError).toHaveBeenCalledTimes(3);
    expect(onExportError).toHaveBeenLastCalledWith('OTLPExporterError: Forbidden');
  });

  it('ignores unrelated diagnostics and contains callback failures', () => {
    const onExportError = vi.fn(() => { throw new Error('callback broke'); });
    const logger = createDiagLogger(new DiagThrottle(), (text) => text, () => 0, onExportError);

    expect(() => logger.warn('unrelated otel notice')).not.toThrow();
    expect(() => logger.error('OTLPExporterError: Forbidden')).not.toThrow();
    expect(onExportError).toHaveBeenCalledOnce();
  });

  it('keeps the callback optional', () => {
    const logger = createDiagLogger(new DiagThrottle(), (text) => text, () => 0);
    expect(() => logger.error('OTLPExporterError: Forbidden')).not.toThrow();
  });
});

describe('tracing export health', () => {
  beforeEach(() => {
    tracingSdk.shutdown.mockReset();
    process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-test';
    process.env['LANGFUSE_SECRET_KEY'] = 'sk-lf-test';
    process.env['LANGFUSE_BASE_URL'] = 'https://us.cloud.langfuse.com';
  });

  afterEach(async () => {
    const tracing = await import('../tracing.js');
    await tracing.shutdownTracing();
    const { diag } = await import('@opentelemetry/api');
    diag.disable();
    delete process.env['LANGFUSE_PUBLIC_KEY'];
    delete process.env['LANGFUSE_SECRET_KEY'];
    delete process.env['LANGFUSE_BASE_URL'];
  });

  it('suspends export at the failure limit and tears down only once under re-entry', async () => {
    const tracing = await import('../tracing.js');
    const { diag } = await import('@opentelemetry/api');
    tracingSdk.shutdown.mockImplementationOnce(async () => {
      diag.error('OTLPExporterError: re-entrant failure');
    });
    await tracing.initTracing();

    for (let i = 0; i < 49; i += 1) diag.error('OTLPExporterError: Forbidden');
    expect(tracing.getTracingExportHealth()).toMatchObject({ failures: 49, suspended: false });

    diag.error('OTLPExporterError: Forbidden');
    await vi.waitFor(() => expect(tracingSdk.shutdown).toHaveBeenCalledOnce());

    expect(tracing.getTracingExportHealth()).toMatchObject({
      failures: 51,
      lastError: 'OTLPExporterError: re-entrant failure',
      suspended: true,
    });
  });
});
