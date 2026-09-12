import type { ErrorEventPayload } from '@opslane/shared';

export type BeforeSendHook = (event: ErrorEventPayload) => ErrorEventPayload | null;

export interface SdkConfig {
  endpoint: string;
  apiKey: string;
  release: string;
  environment: string;
  maxBreadcrumbs: number;
  breadcrumbMaxAge: number;
  flushInterval: number;
  maxBatchSize: number;
  debug: boolean;
  reportingEnabled: boolean;
  replayEnabled: boolean;
  sampleRate: number;
  errorThrottleMs: number;
  beforeSend?: BeforeSendHook;
}

export interface ReplayInitOptions {
  enabled?: boolean;
}

export interface ReportingInitOptions {
  enabled?: boolean;
}

export interface SdkInitOptions {
  apiKey: string;
  /** Absolute server URL, or a same-origin proxy path such as `/opslane`. */
  endpoint?: string;
  release?: string;
  environment?: string;
  maxBreadcrumbs?: number;
  breadcrumbMaxAge?: number;
  flushInterval?: number;
  maxBatchSize?: number;
  debug?: boolean;
  reporting?: ReportingInitOptions;
  replay?: ReplayInitOptions;
  sampleRate?: number;
  errorThrottleMs?: number;
  beforeSend?: BeforeSendHook;
}

const DEFAULT_ENDPOINT = 'https://app.opslane.com';
const PUBLIC_KEY_PREFIX = 'opslane_pk_';

export class InvalidApiKeyError extends Error {
  constructor(prefixSeen: string) {
    super(
      `[opslane] refusing to initialize: apiKey must start with "${PUBLIC_KEY_PREFIX}". ` +
      `Got "${prefixSeen}". Only the public ingest key belongs in browser code. ` +
      `Keys starting with "opslane_sk_" or "opslane_ak_" are secrets and must never ship in a bundle.`,
    );
    this.name = 'InvalidApiKeyError';
  }
}

const DEFAULTS: Omit<SdkConfig, 'endpoint' | 'apiKey' | 'release'> = {
  environment: '',
  maxBreadcrumbs: 50,
  breadcrumbMaxAge: 30_000,
  flushInterval: 5_000,
  maxBatchSize: 10,
  debug: false,
  reportingEnabled: true,
  // BREAKING in 1.0: recording is always-on unless explicitly opted out.
  replayEnabled: true,
  sampleRate: 1,
  errorThrottleMs: 1000,
};

let currentConfig: SdkConfig | null = null;

export function loadConfig(options: SdkInitOptions): void {
  if (!options.apiKey) {
    throw new Error('apiKey is required');
  }
  if (!options.apiKey.startsWith(PUBLIC_KEY_PREFIX)) {
    throw new InvalidApiKeyError(options.apiKey.slice(0, 11));
  }
  if (options.endpoint === '') {
    throw new Error('endpoint is required');
  }
  let endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  if (endpoint.startsWith('/')) {
    const origin = typeof location !== 'undefined' && location && typeof location.origin === 'string'
      ? location.origin : '';
    if (!origin || origin === 'null') {
      throw new Error('endpoint path requires a browser origin; pass an absolute URL');
    }
    let end = endpoint.length;
    while (end > 0 && endpoint.charCodeAt(end - 1) === 47 /* '/' */) end--;
    endpoint = origin + endpoint.slice(0, end);
  }
  // URL-parse (not regex): rejects 'not-a-url', whitespace, and host-less inputs
  // like 'https://?x' that a permissive regex would wrongly accept.
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('endpoint must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('endpoint must be a valid http(s) URL');
  }

  currentConfig = {
    endpoint,
    apiKey: options.apiKey,
    release: options.release ?? '',
    environment: options.environment ?? DEFAULTS.environment,
    maxBreadcrumbs: options.maxBreadcrumbs ?? DEFAULTS.maxBreadcrumbs,
    breadcrumbMaxAge: options.breadcrumbMaxAge ?? DEFAULTS.breadcrumbMaxAge,
    flushInterval: options.flushInterval ?? DEFAULTS.flushInterval,
    maxBatchSize: options.maxBatchSize ?? DEFAULTS.maxBatchSize,
    debug: options.debug ?? DEFAULTS.debug,
    reportingEnabled: options.reporting?.enabled ?? DEFAULTS.reportingEnabled,
    replayEnabled: options.replay?.enabled ?? DEFAULTS.replayEnabled,
    sampleRate: Math.min(1, Math.max(0, options.sampleRate ?? DEFAULTS.sampleRate)),
    errorThrottleMs: options.errorThrottleMs ?? DEFAULTS.errorThrottleMs,
    beforeSend: options.beforeSend,
  };
}

export function getConfig(): SdkConfig {
  if (!currentConfig) {
    throw new Error('SDK not initialized. Call init() first.');
  }
  return currentConfig;
}

export function resetConfig(): void {
  currentConfig = null;
}
