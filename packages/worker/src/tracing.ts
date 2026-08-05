/**
 * OpenTelemetry tracing with Langfuse exporter for agent harness observability.
 *
 * Configuration is resolved by `tracing-config.ts`; a partial config disables
 * tracing with a warning rather than starting an exporter that cannot deliver.
 *
 * Must call initTracing() before any `new Anthropic()` instantiation so that
 * manuallyInstrument() patches the class prototype in time.
 */

// @opentelemetry/api is the lightweight facade (~50KB) — always loaded so that
// traceSpan/withJobTrace can reference SpanStatusCode without dynamic imports.
// The heavy SDK + Langfuse + instrumentation packages are loaded lazily in initTracing().
import {
  trace,
  SpanStatusCode,
  context,
  diag,
  DiagLogLevel,
  type Tracer,
  type Span,
} from '@opentelemetry/api';
import { logger, safeErrorMessage } from './logger.js';
import {
  resolveTracingConfig,
  describeConfig,
  type EnabledTracingConfig,
} from './tracing-config.js';
import { DiagThrottle, createDiagLogger, createRedactor } from './tracing-diag.js';

const SHUTDOWN_TIMEOUT_MS = 5000;

let sdk: { shutdown(): Promise<void> } | null = null;
let tracer: Tracer | null = null;
let activeConfig: EnabledTracingConfig | null = null;
let diagThrottle: DiagThrottle | null = null;
let initialized = false;
/** Set once the config resolves to enabled. SDK errors can quote the keys. */
let redactError: (text: string) => string = (text) => text;

/**
 * `logger.warn` can throw — it JSON.stringifies its fields unguarded. Shutdown
 * and rollback promise never to throw, so every emission on those paths goes
 * through here; otherwise a logging failure would reject shutdown and skip
 * `diag.disable()`.
 */
function safeWarn(message: string, fields?: Record<string, unknown>): void {
  try {
    logger.warn(message, fields);
  } catch {
    // Nothing further is possible; never propagate out of a lifecycle path.
  }
}

/**
 * Stringify a lifecycle error for logging. Redacts first: a processor or SDK
 * exception can quote the configured credentials, and these call sites are
 * outside the diag adapter that already redacts.
 */
function lifecycleError(err: unknown): string {
  try {
    return redactError(safeErrorMessage(err));
  } catch {
    return 'unserializable error';
  }
}

/**
 * Shut a NodeSDK down without ever hanging or throwing. Used by both the normal
 * shutdown path and initialization rollback — an un-timed await in rollback
 * would leave the worker stuck in startup forever.
 */
async function shutdownWithTimeout(target: { shutdown(): Promise<void> }): Promise<void> {
  try {
    await Promise.race([
      target.shutdown(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Tracing shutdown timeout')),
          SHUTDOWN_TIMEOUT_MS,
        );
        timer.unref(); // Don't block process exit
      }),
    ]);
  } catch (err) {
    // Swallowing this entirely would recreate the silence this change removes.
    safeWarn('Langfuse tracing shutdown did not complete cleanly', {
      error: lifecycleError(err),
    });
  }
}

/** Report and clear whatever the throttle is still holding. */
function drainDiagnostics(): void {
  if (diagThrottle === null) return;
  try {
    for (const { fingerprint, suppressed } of diagThrottle.drain()) {
      safeWarn('otel diag: suppressed diagnostics at shutdown', { fingerprint, suppressed });
    }
  } catch {
    // Draining is best effort and must never block shutdown.
  }
}

/**
 * Initialize OpenTelemetry tracing with the Langfuse exporter.
 *
 * A partial config is treated as an error, not a degraded mode: half-configured
 * tracing that cannot deliver is worse than none, because it burns CPU and
 * network producing nothing while looking healthy.
 *
 * Must be awaited before any `new Anthropic()` call.
 */
export async function initTracing(): Promise<void> {
  // Idempotent: a second call would start a second SDK and orphan the first
  // one's shutdown handle.
  if (initialized) {
    logger.warn('initTracing called more than once; ignoring');
    return;
  }
  initialized = true;

  const config = resolveTracingConfig(process.env);

  if (config.status === 'disabled') {
    logger.info('Langfuse tracing disabled', describeConfig(config));
    return;
  }
  if (config.status === 'incomplete') {
    logger.warn('Langfuse tracing disabled: incomplete config', describeConfig(config));
    return;
  }
  if (config.projectId === null) {
    logger.warn('LANGFUSE_PROJECT_ID not set — trace_url deep links will not be recorded');
  }

  let instrumentation: { disable?: () => void } | undefined;
  let nodeSdk: { start(): void; shutdown(): Promise<void> } | undefined;

  // Built BEFORE the try so the catch below can redact too — an exception from
  // the processor constructor is a credential-bearing string like any other.
  // The base64 blob is seeded explicitly: Langfuse sends the credential as
  // `Authorization: Basic base64(publicKey:secretKey)`, which contains neither
  // plaintext key, so the literal pass alone would never match the form the
  // credential actually travels in.
  const basicToken = Buffer.from(
    `${config.credentials.publicKey}:${config.credentials.secretKey}`,
  ).toString('base64');
  const redact = createRedactor([
    config.credentials.publicKey,
    config.credentials.secretKey,
    basicToken,
  ]);
  redactError = redact;

  try {
    // Dynamic imports keep the heavy SDK out of the disabled path.
    const [{ NodeSDK }, { LangfuseSpanProcessor }, { AnthropicInstrumentation }, AnthropicModule] =
      await Promise.all([
        import('@opentelemetry/sdk-node'),
        import('@langfuse/otel'),
        import('@arizeai/openinference-instrumentation-anthropic'),
        import('@anthropic-ai/sdk'),
      ]);

    diagThrottle = new DiagThrottle({
      onEvict: ({ fingerprint, suppressed }) => {
        safeWarn('otel diag: suppressed diagnostics dropped', { fingerprint, suppressed });
      },
    });

    const inst = new AnthropicInstrumentation();
    instrumentation = inst;
    inst.manuallyInstrument(AnthropicModule.default ?? AnthropicModule);

    nodeSdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          // Explicit, so the SDK never falls back to reading the environment
          // itself — that fallback is what shipped spans to the wrong region.
          publicKey: config.credentials.publicKey,
          secretKey: config.credentials.secretKey,
          baseUrl: config.baseUrl,
          flushAt: 50,
          flushInterval: 5, // seconds
          // The v5 default filter only exports spans from Langfuse's own tracer,
          // gen_ai.*-attributed spans, or known LLM scopes. Our 'opslane-worker'
          // tracer and '@arizeai/openinference-instrumentation-anthropic' match
          // none of those, so every span is silently dropped. Export everything —
          // the worker registers no other instrumentations.
          shouldExportSpan: () => true,
        }),
      ],
      instrumentations: [inst],
    });
    nodeSdk.start();

    // Installed AFTER the NodeSDK: when OTEL_LOG_LEVEL is set, the NodeSDK
    // *constructor* calls diag.setLogger(new DiagConsoleLogger()) itself
    // (sdk-node sdk.js:96-98). Installing ours first means an operator who sets
    // OTEL_LOG_LEVEL to debug this very subsystem silently replaces the
    // redacting, throttled adapter with a raw console logger.
    diag.setLogger(createDiagLogger(diagThrottle, redact), DiagLogLevel.WARN);

    sdk = nodeSdk;
    tracer = trace.getTracer('opslane-worker');
    activeConfig = config;

    // start() is synchronous and returns void: it registers local components and
    // performs no handshake. This line claims instrumentation, not delivery —
    // whether spans land is knowable only from the diag warnings above.
    logger.info('Langfuse tracing instrumentation enabled', describeConfig(config));
  } catch (err) {
    await rollbackPartialInit(instrumentation, nodeSdk);
    safeWarn('Langfuse tracing failed to initialize', { error: lifecycleError(err) });
  }
}

/**
 * Best effort, not guaranteed. `manuallyInstrument` patches the Anthropic module
 * prototype before start() runs, and start() registers global OTel state
 * incrementally, so a mid-initialization throw can leave global state partly
 * mutated. Nulling `tracer` is what makes our own helpers pass through.
 */
async function rollbackPartialInit(
  instrumentation: { disable?: () => void } | undefined,
  nodeSdk: { shutdown(): Promise<void> } | undefined,
): Promise<void> {
  try {
    instrumentation?.disable?.();
  } catch {
    // best effort
  }
  if (nodeSdk !== undefined) await shutdownWithTimeout(nodeSdk);
  drainDiagnostics();
  try {
    diag.disable();
  } catch {
    // best effort
  }
  sdk = null;
  tracer = null;
  activeConfig = null;
  diagThrottle = null;
  // `redactError` is deliberately NOT reset here: initTracing's catch logs the
  // failure *after* calling this, and that message still needs redacting.
}

/**
 * Flush pending spans and shut down the OTel SDK. Never throws.
 */
export async function shutdownTracing(): Promise<void> {
  const current = sdk;
  // Shut down BEFORE draining: the flush itself can produce export failures,
  // and draining first would discard exactly those counts.
  if (current !== null) await shutdownWithTimeout(current);
  drainDiagnostics();
  try {
    // Without this the global OTel logger keeps the adapter (and its throttle)
    // alive through its closure after shutdown.
    diag.disable();
  } catch {
    // best effort
  }
  sdk = null;
  tracer = null;
  activeConfig = null;
  diagThrottle = null;
  initialized = false;
  redactError = (text) => text;
}

/**
 * Wrap a job execution in a root OTel trace with job metadata.
 * No-op pass-through if tracing is not initialized.
 */
export async function withJobTrace<T>(
  jobId: string,
  errorGroupId: string,
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracer) return fn();
  return tracer.startActiveSpan('process-job', async (span: Span) => {
    span.setAttribute('job.id', jobId);
    span.setAttribute('job.error_group_id', errorGroupId);
    span.setAttribute('job.project_id', projectId);
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Wrap an async function in a child OTel span with attributes.
 * No-op pass-through if tracing is not initialized.
 */
export async function traceSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracer) return fn();
  return tracer.startActiveSpan(name, async (span: Span) => {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Returns the trace ID of the currently active span, or null if no span is active.
 */
export function getActiveTraceId(): string | null {
  const span = trace.getSpan(context.active());
  return span?.spanContext().traceId ?? null;
}

/**
 * Langfuse trace URL for a trace ID, or null when tracing is not active or no
 * project ID was configured. Reads the resolved config so a value the validator
 * rejected can never reach a link.
 */
export function buildLangfuseTraceUrl(traceId: string): string | null {
  if (activeConfig === null || activeConfig.projectId === null) return null;
  return `${activeConfig.baseUrl}/project/${activeConfig.projectId}/traces/${traceId}`;
}

/**
 * Extract safe-to-log span attributes for a tool call.
 * Never includes raw file content, bash output, or write content.
 */
export function getToolSpanAttributes(
  toolName: string,
  input: Record<string, unknown>,
  output?: string,
  isError?: boolean,
): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    'tool.name': toolName,
  };
  if (output !== undefined) attrs['tool.output_length'] = output.length;
  if (isError !== undefined) attrs['tool.is_error'] = isError;

  switch (toolName) {
    case 'read':
    case 'write':
    case 'edit':
      if (typeof input['path'] === 'string') attrs['tool.file_path'] = input['path'];
      break;
    case 'bash':
      if (typeof input['command'] === 'string') {
        attrs['tool.command'] = input['command'].slice(0, 200);
      }
      break;
    case 'search':
      if (typeof input['pattern'] === 'string') attrs['tool.pattern'] = input['pattern'];
      if (typeof input['path'] === 'string') attrs['tool.search_path'] = input['path'];
      break;
    case 'read_many':
      if (Array.isArray(input['paths'])) {
        attrs['tool.paths'] = (input['paths'] as string[]).map(String).join(', ');
      }
      break;
    case 'patch':
      break;
    case 'give_up':
      if (typeof input['reason_code'] === 'string') attrs['tool.reason_code'] = input['reason_code'];
      break;
  }

  return attrs;
}
