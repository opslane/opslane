/**
 * Langfuse tracing configuration: resolution, normalization, and a loggable
 * projection.
 *
 * Pure by design — no I/O, no OTel imports, no process.env access. The caller
 * passes the environment in, which is what makes every branch testable without
 * starting an SDK. The resolved value is the single source of truth for both
 * span delivery and trace-URL construction; nothing downstream re-reads the
 * environment.
 */

const DELIVERY_VARS = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
] as const;

export type DeliveryVar = (typeof DELIVERY_VARS)[number];

export type TracingConfig =
  | { status: 'disabled' }
  | { status: 'incomplete'; missing: DeliveryVar[]; invalid: DeliveryVar[] }
  | {
      status: 'enabled';
      /** Normalized and validated. Safe to log. */
      baseUrl: string;
      projectId: string | null;
      /** Nested so nothing logs the config object wholesale. Never logged. */
      credentials: { publicKey: string; secretKey: string };
    };

export type EnabledTracingConfig = Extract<TracingConfig, { status: 'enabled' }>;

type EnvLike = Record<string, string | undefined>;

/** Trim, and treat empty or whitespace-only as unset (Terraform emits ""). */
function readVar(env: EnvLike, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalize a Langfuse host, or return null when it is unusable.
 * Embedded credentials are rejected outright: this value gets logged.
 */
export function normalizeBaseUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

export function resolveTracingConfig(env: EnvLike): TracingConfig {
  const publicKey = readVar(env, 'LANGFUSE_PUBLIC_KEY');
  const secretKey = readVar(env, 'LANGFUSE_SECRET_KEY');
  const rawBaseUrl = readVar(env, 'LANGFUSE_BASE_URL');
  const projectId = readVar(env, 'LANGFUSE_PROJECT_ID') ?? null;

  const anySet =
    publicKey !== undefined ||
    secretKey !== undefined ||
    rawBaseUrl !== undefined ||
    projectId !== null;
  if (!anySet) return { status: 'disabled' };

  const missing: DeliveryVar[] = [];
  const invalid: DeliveryVar[] = [];

  if (publicKey === undefined) missing.push('LANGFUSE_PUBLIC_KEY');
  if (secretKey === undefined) missing.push('LANGFUSE_SECRET_KEY');

  let baseUrl: string | null = null;
  if (rawBaseUrl === undefined) {
    missing.push('LANGFUSE_BASE_URL');
  } else {
    baseUrl = normalizeBaseUrl(rawBaseUrl);
    if (baseUrl === null) invalid.push('LANGFUSE_BASE_URL');
  }

  if (missing.length > 0 || invalid.length > 0) {
    return { status: 'incomplete', missing, invalid };
  }

  return {
    status: 'enabled',
    baseUrl: baseUrl as string,
    projectId,
    credentials: { publicKey: publicKey as string, secretKey: secretKey as string },
  };
}

/** Loggable projection. Never includes credentials. */
export function describeConfig(config: TracingConfig): Record<string, unknown> {
  switch (config.status) {
    case 'disabled':
      return { status: 'disabled' };
    case 'incomplete':
      return { status: 'incomplete', missing: config.missing, invalid: config.invalid };
    case 'enabled':
      return {
        status: 'enabled',
        host: config.baseUrl,
        has_project_id: config.projectId !== null,
      };
  }
}
