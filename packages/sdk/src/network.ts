import type { Breadcrumb } from '@opslane/shared';
import { addBreadcrumb } from './breadcrumbs';
import { getConfig } from './config';
import {
  discardTiming,
  finalizeTiming,
  markHeaders,
  startTiming,
  type Outcome,
} from './network-timing';
import { currentClickId, emitTelemetry, nextRequestId } from './telemetry';

// -- Fetch interceptor --

let originalFetch: typeof globalThis.fetch | null = null;

/** Executes SDK-owned traffic without generating app network telemetry. */
export function sdkFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const implementation = originalFetch ?? globalThis.fetch;
  return implementation.call(globalThis, input, init);
}

function isSdkEndpoint(url: string): boolean {
  try {
    const config = getConfig();
    return url.startsWith(config.endpoint);
  } catch {
    return false;
  }
}

function extractFetchInfo(
  input: RequestInfo | URL,
  init?: RequestInit
): { url: string; method: string } {
  let url: string;
  let method: string;

  if (input instanceof Request) {
    url = input.url;
    method = input.method || 'GET';
  } else {
    url = String(input);
    method = init?.method || 'GET';
  }

  return { url, method: method.toUpperCase() };
}

export function patchFetch(): void {
  if (originalFetch) return;

  originalFetch = globalThis.fetch;
  const orig = originalFetch;

  globalThis.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const { url, method } = extractFetchInfo(input, init);

    if (isSdkEndpoint(url)) {
      return orig.call(globalThis, input, init);
    }

    const requestId = nextRequestId('f');
    emitTelemetry({
      kind: 'request_start',
      requestId,
      clickId: currentClickId(),
      method,
      url,
      at: Date.now(),
    });

    let timingHandle = -1;
    try {
      timingHandle = startTiming('fetch', method, url);
    } catch {
      // SDK must never throw
    }

    try {
      const response = await orig.call(globalThis, input, init);

      try {
        markHeaders(timingHandle);
        if (response.type === 'opaque' || response.type === 'opaqueredirect') {
          finalizeTiming(timingHandle, 'ok');
        } else {
          const storableStatus = response.status >= 100 && response.status <= 599;
          finalizeTiming(
            timingHandle,
            response.status >= 400 ? 'http_error' : 'ok',
            storableStatus ? response.status : undefined,
          );
        }
      } catch {
        // SDK must never throw
      }

      emitTelemetry({ kind: 'request_end', requestId, status: response.status, at: Date.now() });

      try {
        const crumb: Breadcrumb = {
          type: 'fetch',
          timestamp: new Date().toISOString(),
          category: 'fetch',
          message: `${method} ${url}`,
          level: response.ok ? 'info' : 'warning',
          data: {
            method,
            url,
            status_code: response.status,
          },
        };
        addBreadcrumb(crumb);
      } catch {
        // SDK must never throw
      }

      return response;
    } catch (error: unknown) {
      emitTelemetry({ kind: 'request_end', requestId, status: 0, at: Date.now() });
      try {
        const name =
          typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string'
            ? (error as { name: string }).name
            : '';
        finalizeTiming(
          timingHandle,
          name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'abort' : 'network_error',
        );
      } catch {
        // SDK must never throw
      }
      try {
        const crumb: Breadcrumb = {
          type: 'fetch',
          timestamp: new Date().toISOString(),
          category: 'fetch',
          message: `${method} ${url}`,
          level: 'error',
          data: {
            method,
            url,
            error: error instanceof Error ? error.message : String(error),
          },
        };
        addBreadcrumb(crumb);
      } catch {
        // SDK must never throw
      }

      throw error; // Re-throw the original error to the app
    }
  };
}

export function unpatchFetch(): void {
  if (!originalFetch) return;
  globalThis.fetch = originalFetch;
  originalFetch = null;
}

// -- XMLHttpRequest interceptor --

let originalXHROpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXHRSend: typeof XMLHttpRequest.prototype.send | null = null;

interface XHRWithOpslane extends XMLHttpRequest {
  _opslaneMethod?: string;
  _opslaneUrl?: string;
  _opslaneRequestId?: string;
  _opslaneTimingHandle?: number;
  _opslaneTimingBound?: boolean;
}

export function patchXHR(): void {
  if (originalXHROpen) return;

  originalXHROpen = XMLHttpRequest.prototype.open;
  const origOpen = originalXHROpen;

  XMLHttpRequest.prototype.open = function (
    this: XHRWithOpslane,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    this._opslaneMethod = method.toUpperCase();
    this._opslaneUrl = String(url);

    this.addEventListener('loadend', function (this: XHRWithOpslane) {
      try {
        const reqUrl = this._opslaneUrl || '';
        const reqMethod = this._opslaneMethod || 'GET';

        if (isSdkEndpoint(reqUrl)) return;

        const crumb: Breadcrumb = {
          type: 'xhr',
          timestamp: new Date().toISOString(),
          category: 'xhr',
          message: `${reqMethod} ${reqUrl}`,
          level: this.status >= 400 ? 'warning' : 'info',
          data: {
            method: reqMethod,
            url: reqUrl,
            status_code: this.status,
          },
        };
        addBreadcrumb(crumb);
      } catch {
        // SDK must never throw
      }
    });

    // XHR.open has overloaded signatures; targeted cast to forward variadic args
    (origOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
  };

  originalXHRSend = XMLHttpRequest.prototype.send;
  const origSend = originalXHRSend;
  XMLHttpRequest.prototype.send = function (
    this: XHRWithOpslane,
    ...args: Parameters<XMLHttpRequest['send']>
  ): void {
    const previousTimingHandle = this._opslaneTimingHandle;
    try {
      const url = this._opslaneUrl || '';
      if (url && !isSdkEndpoint(url)) {
        const requestId = nextRequestId('x');
        this._opslaneRequestId = requestId;
        emitTelemetry({
          kind: 'request_start',
          requestId,
          clickId: currentClickId(),
          method: this._opslaneMethod || 'GET',
          url,
          at: Date.now(),
        });
        this.addEventListener('loadend', () => {
          emitTelemetry({ kind: 'request_end', requestId, status: this.status, at: Date.now() });
        }, { once: true });

        const timingHandle = startTiming('xhr', this._opslaneMethod || 'GET', url);
        this._opslaneTimingHandle = timingHandle;

        // Bind persistent listeners once. XHR instances may be reused, and
        // each callback reads the current request handle from the instance.
        if (!this._opslaneTimingBound) {
          this._opslaneTimingBound = true;

          this.addEventListener('readystatechange', () => {
            if (this.readyState === 2 && this._opslaneTimingHandle !== undefined) {
              try {
                markHeaders(this._opslaneTimingHandle);
              } catch {
                // SDK must never throw
              }
            }
          });

          const finalize = (outcome: Outcome, withStatus: boolean): void => {
            try {
              const handle = this._opslaneTimingHandle;
              if (handle === undefined) return;
              finalizeTiming(handle, outcome, withStatus ? this.status : undefined);
            } catch {
              // SDK must never throw
            }
          };
          this.addEventListener('load', () => {
            const storable = this.status >= 100 && this.status <= 599;
            finalize(this.status >= 400 ? 'http_error' : 'ok', storable);
          });
          this.addEventListener('timeout', () => finalize('timeout', false));
          this.addEventListener('abort', () => finalize('abort', false));
          this.addEventListener('error', () => finalize('network_error', false));
          this.addEventListener('loadend', () => finalize('network_error', false));
        }
      }
    } catch {
      // SDK must never throw.
    }
    try {
      return origSend.apply(this, args);
    } catch (error) {
      try {
        if (this._opslaneTimingHandle !== undefined) discardTiming(this._opslaneTimingHandle);
        this._opslaneTimingHandle = previousTimingHandle;
      } catch {
        // SDK must never throw
      }
      throw error;
    }
  };
}

export function unpatchXHR(): void {
  if (originalXHROpen) {
    XMLHttpRequest.prototype.open = originalXHROpen;
    originalXHROpen = null;
  }
  if (originalXHRSend) {
    XMLHttpRequest.prototype.send = originalXHRSend;
    originalXHRSend = null;
  }
}

// -- Generic request timing hooks --

export interface RequestHandle {
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly timingHandle: number;
  readonly ignored: boolean;
}

export type RequestResult =
  | { status: number; error?: never }
  | { error: unknown; status?: never }
  | { status?: number; error?: unknown };

export function requestStarted(info: { method: string; url: string }): RequestHandle {
  try {
    const method = (info?.method || 'GET').toUpperCase();
    const url = String(info?.url || '');

    if (isSdkEndpoint(url)) {
      return {
        requestId: '',
        method,
        url,
        timingHandle: -1,
        ignored: true,
      };
    }

    const requestId = nextRequestId('m');
    emitTelemetry({
      kind: 'request_start',
      requestId,
      clickId: currentClickId(),
      method,
      url,
      at: Date.now(),
    });

    let timingHandle = -1;
    try {
      timingHandle = startTiming('fetch', method, url);
    } catch {
      // SDK must never throw
    }

    return {
      requestId,
      method,
      url,
      timingHandle,
      ignored: false,
    };
  } catch {
    // SDK must never throw into app code
    return {
      requestId: '',
      method: (info?.method || 'GET').toUpperCase(),
      url: String(info?.url || ''),
      timingHandle: -1,
      ignored: true,
    };
  }
}

export function requestEnded(
  handle: RequestHandle,
  result: { status?: number; error?: unknown }
): void {
  try {
    if (!handle || handle.ignored) return;

    const hasError = 'error' in result && result.error !== undefined;
    const at = Date.now();

    if (hasError) {
      const error = result.error;
      const status = typeof result.status === 'number' ? result.status : 0;
      emitTelemetry({
        kind: 'request_end',
        requestId: handle.requestId,
        status,
        at,
      });

      try {
        const name =
          typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string'
            ? (error as { name: string }).name
            : '';
        finalizeTiming(
          handle.timingHandle,
          name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'abort' : 'network_error',
        );
      } catch {
        // SDK must never throw
      }

      try {
        const crumb: Breadcrumb = {
          type: 'fetch',
          timestamp: new Date().toISOString(),
          category: 'fetch',
          message: `${handle.method} ${handle.url}`,
          level: 'error',
          data: {
            method: handle.method,
            url: handle.url,
            error: error instanceof Error ? error.message : String(error),
          },
        };
        addBreadcrumb(crumb);
      } catch {
        // SDK must never throw
      }
    } else {
      const status = typeof result.status === 'number' ? result.status : 200;

      try {
        markHeaders(handle.timingHandle);
        const storableStatus = status >= 100 && status <= 599;
        finalizeTiming(
          handle.timingHandle,
          status >= 400 ? 'http_error' : 'ok',
          storableStatus ? status : undefined,
        );
      } catch {
        // SDK must never throw
      }

      emitTelemetry({
        kind: 'request_end',
        requestId: handle.requestId,
        status,
        at,
      });

      try {
        const crumb: Breadcrumb = {
          type: 'fetch',
          timestamp: new Date().toISOString(),
          category: 'fetch',
          message: `${handle.method} ${handle.url}`,
          level: status >= 400 ? 'warning' : 'info',
          data: {
            method: handle.method,
            url: handle.url,
            status_code: status,
          },
        };
        addBreadcrumb(crumb);
      } catch {
        // SDK must never throw
      }
    }
  } catch {
    // SDK must never throw
  }
}

export async function trackRequest<T>(
  info: { method: string; url: string },
  run: () => Promise<T>
): Promise<T> {
  const handle = requestStarted(info);
  try {
    const result = await run();
    const status =
      typeof result === 'object' && result !== null && typeof (result as unknown as { status?: unknown }).status === 'number'
        ? (result as unknown as { status: number }).status
        : 200;
    requestEnded(handle, { status });
    return result;
  } catch (error: unknown) {
    requestEnded(handle, { error });
    throw error;
  }
}

