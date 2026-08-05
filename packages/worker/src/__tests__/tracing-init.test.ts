import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const startSpy = vi.fn();
const shutdownSpy = vi.fn(async () => {});
const processorSpy = vi.fn();
const instrumentSpy = vi.fn();
const disableSpy = vi.fn();
const sdkConfigSpy = vi.fn();

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor(config: unknown) {
      sdkConfigSpy(config);
    }
    start = startSpy;
    shutdown = shutdownSpy;
  },
}));

vi.mock('@langfuse/otel', () => ({
  LangfuseSpanProcessor: class {
    constructor(options: unknown) {
      processorSpy(options);
    }
  },
}));

vi.mock('@arizeai/openinference-instrumentation-anthropic', () => ({
  AnthropicInstrumentation: class {
    manuallyInstrument = instrumentSpy;
    disable = disableSpy;
  },
}));

const LANGFUSE_VARS = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_PROJECT_ID',
] as const;

const COMPLETE_ENV: Record<string, string> = {
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
  LANGFUSE_PROJECT_ID: 'proj-1',
};

function setEnv(env: Record<string, string | undefined>): void {
  for (const key of LANGFUSE_VARS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
}

/** Fresh module registry per test so module-level tracing state cannot leak. */
async function loadTracing() {
  vi.resetModules();
  return await import('../tracing.js');
}

describe('initTracing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({});
  });
  afterEach(async () => {
    // vi.resetModules() does NOT clear OpenTelemetry's global diag registration
    // — it lives on a globalThis symbol and survives module resets. Without
    // this, adapters leak between tests and later setLogger calls emit
    // "current logger will be overwritten" through a stale logger object.
    const { diag } = await import('@opentelemetry/api');
    diag.disable();
    setEnv({});
    vi.restoreAllMocks();
  });

  it('does not start the SDK when the config is incomplete', async () => {
    setEnv({ LANGFUSE_PUBLIC_KEY: 'pk-lf-test', LANGFUSE_SECRET_KEY: 'sk-lf-test' });
    const tracing = await loadTracing();
    const { logger } = await import('../logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await tracing.initTracing();

    expect(startSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('Langfuse tracing disabled: incomplete config', {
      status: 'incomplete',
      missing: ['LANGFUSE_BASE_URL'],
      invalid: [],
    });
  });

  it('does not start the SDK when nothing is configured', async () => {
    const tracing = await loadTracing();
    await tracing.initTracing();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('passes normalized credentials and host explicitly to the processor', async () => {
    // The SDK must never fall back to reading process.env itself: that fallback
    // is what sent production spans to the wrong region.
    setEnv({ ...COMPLETE_ENV, LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com/' });
    const tracing = await loadTracing();
    await tracing.initTracing();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(processorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: 'https://us.cloud.langfuse.com',
      }),
    );
  });

  it('overrides the v5 span filter so our spans are not silently dropped', async () => {
    // Without shouldExportSpan the Langfuse v5 default filter drops every span
    // this worker produces — the other half of the original silent failure.
    setEnv(COMPLETE_ENV);
    const tracing = await loadTracing();
    await tracing.initTracing();

    const options = processorSpy.mock.calls[0]?.[0] as {
      shouldExportSpan?: (span: unknown) => boolean;
      flushAt?: number;
    };
    expect(typeof options.shouldExportSpan).toBe('function');
    expect(options.shouldExportSpan?.({})).toBe(true);
    expect(options.flushAt).toBe(50);
  });

  it('instruments the Anthropic module and registers the instrumentation', async () => {
    // initTracing must patch the Anthropic prototype; without this the LLM
    // spans the whole feature exists to capture are never produced.
    setEnv(COMPLETE_ENV);
    const tracing = await loadTracing();
    await tracing.initTracing();

    expect(instrumentSpy).toHaveBeenCalledTimes(1);
    const sdkOptions = sdkConfigSpy.mock.calls[0]?.[0] as { instrumentations?: unknown[] };
    expect(sdkOptions.instrumentations).toHaveLength(1);
  });

  it('keeps credentials out of a failed-initialization log line', async () => {
    // An SDK exception can quote the key. The catch handler logs outside the
    // diag adapter, so it needs its own redaction.
    setEnv({ ...COMPLETE_ENV, LANGFUSE_SECRET_KEY: 'sk-lf-verySecretValue' });
    startSpy.mockImplementationOnce(() => {
      throw new Error('rejected key sk-lf-verySecretValue');
    });
    const tracing = await loadTracing();
    const { logger } = await import('../logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await tracing.initTracing();

    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('sk-lf-verySecretValue');
  });

  it('logs the instrumentation line exactly once, after start', async () => {
    setEnv(COMPLETE_ENV);
    const tracing = await loadTracing();
    const { logger } = await import('../logger.js');
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    await tracing.initTracing();

    const lines = infoSpy.mock.calls.filter(
      ([msg]) => msg === 'Langfuse tracing instrumentation enabled',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toEqual({
      status: 'enabled',
      host: 'https://us.cloud.langfuse.com',
      has_project_id: true,
    });
  });

  it('warns about deep links when the project id is absent', async () => {
    setEnv({ ...COMPLETE_ENV, LANGFUSE_PROJECT_ID: undefined });
    const tracing = await loadTracing();
    const { logger } = await import('../logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await tracing.initTracing();

    expect(startSpy).toHaveBeenCalledTimes(1);
    // Called with a message only — asserting a second argument would fail.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('LANGFUSE_PROJECT_ID'));
  });

  it('ignores a second call instead of starting a second SDK', async () => {
    setEnv(COMPLETE_ENV);
    const tracing = await loadTracing();
    await tracing.initTracing();
    await tracing.initTracing();
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows a start failure, logs it, and attempts rollback', async () => {
    setEnv(COMPLETE_ENV);
    startSpy.mockImplementationOnce(() => {
      throw new Error('start exploded');
    });
    const tracing = await loadTracing();
    const { logger } = await import('../logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(tracing.initTracing()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith('Langfuse tracing failed to initialize', {
      error: 'start exploded',
    });
    expect(disableSpy).toHaveBeenCalled();
    // Spans degrade to pass-through.
    expect(await tracing.withJobTrace('j', 'e', 'p', async () => 'ok')).toBe('ok');
  });

  it('does not hang startup when rollback shutdown never settles', async () => {
    setEnv(COMPLETE_ENV);
    // Captured before the clock is faked: a fake clock cannot drive the
    // event-loop I/O that initTracing's dynamic imports need.
    const realSetTimeout = setTimeout;
    vi.useFakeTimers();
    startSpy.mockImplementationOnce(() => {
      throw new Error('start exploded');
    });
    shutdownSpy.mockImplementationOnce(() => new Promise<void>(() => {}));
    const tracing = await loadTracing();

    const pending = tracing.initTracing();
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // The rollback timeout is only scheduled once those imports resolve, and
    // advanceTimersByTimeAsync drains microtasks without returning to the event
    // loop. Advancing once would move the clock past a timer that does not
    // exist yet; it would then be scheduled 5s beyond a clock that never moves
    // again, and this test would hang on the very timeout it exists to prove.
    // So yield to the real event loop between advances until init settles.
    for (let i = 0; i < 100 && !settled; i += 1) {
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 0);
      });
      await vi.advanceTimersByTimeAsync(6_000);
    }
    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe('shutdownTracing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({});
  });
  afterEach(async () => {
    // Same reason as the initTracing block: OTel's diag registration lives on a
    // globalThis symbol and survives vi.resetModules().
    const { diag } = await import('@opentelemetry/api');
    diag.disable();
    setEnv({});
    vi.restoreAllMocks();
  });

  it('drains suppressed diagnostics after the SDK has shut down', async () => {
    // Failures raised *during* shutdown must still be reported, so the drain
    // has to run after shutdown, not before it.
    setEnv(COMPLETE_ENV);
    const tracing = await loadTracing();
    const { logger } = await import('../logger.js');
    await tracing.initTracing();

    const { diag } = await import('@opentelemetry/api');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    shutdownSpy.mockImplementationOnce(async () => {
      diag.warn('export failed');
      diag.warn('export failed');
    });

    await tracing.shutdownTracing();

    const drained = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes('suppressed diagnostics at shutdown'),
    );
    expect(drained).toHaveLength(1);
  });
});

describe('buildLangfuseTraceUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({});
  });
  afterEach(async () => {
    const { diag } = await import('@opentelemetry/api');
    diag.disable();
    setEnv({});
  });

  it('returns null when tracing was never initialized', async () => {
    const tracing = await loadTracing();
    expect(tracing.buildLangfuseTraceUrl('abc')).toBeNull();
  });

  it('returns null when the project id is absent', async () => {
    setEnv({ ...COMPLETE_ENV, LANGFUSE_PROJECT_ID: undefined });
    const tracing = await loadTracing();
    await tracing.initTracing();
    expect(tracing.buildLangfuseTraceUrl('abc')).toBeNull();
  });

  it('builds from the normalized config, not the raw environment', async () => {
    setEnv({ ...COMPLETE_ENV, LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com/' });
    const tracing = await loadTracing();
    await tracing.initTracing();
    expect(tracing.buildLangfuseTraceUrl('abc')).toBe(
      'https://us.cloud.langfuse.com/project/proj-1/traces/abc',
    );
  });

  it('ignores a whitespace-only project id instead of building a bad link', async () => {
    setEnv({ ...COMPLETE_ENV, LANGFUSE_PROJECT_ID: '   ' });
    const tracing = await loadTracing();
    await tracing.initTracing();
    expect(tracing.buildLangfuseTraceUrl('abc')).toBeNull();
  });
});
