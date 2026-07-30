import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGlobalHandlers, uninstallGlobalHandlers, buildPayload } from '../core';
import { resetConfig, loadConfig } from '../config';
import { addBreadcrumb, clearBreadcrumbs, getBreadcrumbs } from '../breadcrumbs';
import * as transport from '../transport';
import { TEST_PK } from './test-keys';
import { COMMIT_SHA_GLOBAL } from '../build/registry-contract';

vi.mock('../transport', () => ({
  enqueueEvent: vi.fn(),
}));

describe('Core Error Capture', () => {
  beforeEach(() => {
    resetConfig();
    clearBreadcrumbs();
    loadConfig({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
    });
  });

  afterEach(() => {
    uninstallGlobalHandlers();
    resetConfig();
    clearBreadcrumbs();
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>)[COMMIT_SHA_GLOBAL];
  });

  it('should capture errors from window.onerror', () => {
    installGlobalHandlers();

    const errorEvent = new ErrorEvent('error', {
      message: 'Uncaught TypeError: x is not a function',
      filename: 'https://app.example.com/main.js',
      lineno: 42,
      colno: 10,
      error: new TypeError('x is not a function'),
    });

    window.dispatchEvent(errorEvent);

    expect(transport.enqueueEvent).toHaveBeenCalledTimes(1);
    const payload = (transport.enqueueEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.error.type).toBe('TypeError');
    expect(payload.error.message).toBe('x is not a function');
    expect(payload.error.stack).toBeTruthy();
    expect(payload.context.url).toBeTruthy();
  });

  it('should capture errors from unhandledrejection', () => {
    installGlobalHandlers();

    const error = new Error('Promise rejected');
    const event = new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.reject(error).catch(() => {}),
      reason: error,
    });

    window.dispatchEvent(event);

    expect(transport.enqueueEvent).toHaveBeenCalledTimes(1);
    const payload = (transport.enqueueEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.error.type).toBe('Error');
    expect(payload.error.message).toBe('Promise rejected');
  });

  it('should handle unhandledrejection with non-Error reason without fabricating an SDK stack', () => {
    installGlobalHandlers();

    const event = new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.reject('string error').catch(() => {}),
      reason: 'string error',
    });

    window.dispatchEvent(event);

    expect(transport.enqueueEvent).toHaveBeenCalledTimes(1);
    const payload = (transport.enqueueEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.error.type).toBe('UnhandledRejection');
    expect(payload.error.message).toBe('string error');
    // The origin is genuinely lost for non-Error rejections. We must NOT
    // synthesize a stack here: normalizeError runs inside the SDK's own global
    // handler, so new Error().stack would capture SDK frames (core.ts /
    // normalizeError), not user code — misleading triage into wasting a sandbox.
    // The server now accepts empty stacks, so send '' honestly.
    expect(payload.error.stack).toBe('');
    expect(payload.error.stack).not.toContain('normalizeError');
    expect(payload.error.stack).not.toContain('core.ts');
  });

  it('should capture cross-origin "Script error." (null error object) as stackless', () => {
    installGlobalHandlers();

    // Cross-origin script errors fire window.onerror with event.error === null.
    const errorEvent = new ErrorEvent('error', {
      message: 'Script error.',
      error: null,
    });

    window.dispatchEvent(errorEvent);

    expect(transport.enqueueEvent).toHaveBeenCalledTimes(1);
    const payload = (transport.enqueueEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.error.message).toBe('Script error.');
    expect(payload.error.stack).toBe('');
    expect(payload.error.stack).not.toContain('core.ts');
  });

  it('should add an error breadcrumb when capturing', () => {
    installGlobalHandlers();

    const errorEvent = new ErrorEvent('error', {
      message: 'Uncaught TypeError: x is not a function',
      error: new TypeError('x is not a function'),
    });

    window.dispatchEvent(errorEvent);

    const crumbs = getBreadcrumbs();
    expect(crumbs.length).toBeGreaterThanOrEqual(1);
    const errorCrumb = crumbs.find((c) => c.type === 'error');
    expect(errorCrumb).toBeTruthy();
    expect(errorCrumb!.category).toBe('exception');
    expect(errorCrumb!.level).toBe('error');
  });

  it('should include breadcrumbs in the event payload', () => {
    installGlobalHandlers();

    // Manually add a breadcrumb before the error
    addBreadcrumb({
      type: 'click' as const,
      timestamp: new Date().toISOString(),
      category: 'ui.click',
      message: 'button#submit clicked',
    });

    const errorEvent = new ErrorEvent('error', {
      message: 'Uncaught Error: fail',
      error: new Error('fail'),
    });

    window.dispatchEvent(errorEvent);

    const payload = (transport.enqueueEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Should have at least the click breadcrumb plus the error breadcrumb
    expect(payload.breadcrumbs.length).toBeGreaterThanOrEqual(2);
  });

  it('includes an explicitly configured environment in error payloads', () => {
    resetConfig();
    loadConfig({ apiKey: TEST_PK, environment: 'staging' });

    const payload = buildPayload('Error', 'boom', 'at app.js:1:1', {
      type: 'error',
      timestamp: new Date().toISOString(),
      category: 'error',
      message: 'boom',
    });

    expect(payload.environment).toBe('staging');
  });

  it('includes only a valid injected commit SHA', () => {
    const commit = 'e60b4d1e113538d40f09e31717e949aaa08659f8';
    (globalThis as Record<string, unknown>)[COMMIT_SHA_GLOBAL] = commit;
    const breadcrumb = {
      type: 'error' as const,
      timestamp: new Date().toISOString(),
      category: 'error',
      message: 'boom',
    };

    expect(
      buildPayload('Error', 'boom', 'at app.js:1:1', breadcrumb).commit_sha,
    ).toBe(commit);

    (globalThis as Record<string, unknown>)[COMMIT_SHA_GLOBAL] =
      commit.toUpperCase();
    expect(
      buildPayload('Error', 'boom', 'at app.js:1:1', breadcrumb).commit_sha,
    ).toBeUndefined();
  });

  it('should restore original handlers on uninstall', () => {
    const originalOnError = window.onerror;
    const originalOnUnhandled = window.onunhandledrejection;

    installGlobalHandlers();
    uninstallGlobalHandlers();

    expect(window.onerror).toBe(originalOnError);
    expect(window.onunhandledrejection).toBe(originalOnUnhandled);
  });

  it('should append synthetic caller stack when error has no user-code frames', () => {
    installGlobalHandlers();

    // Simulate a browser-internal SyntaxError (e.g. from JSON.parse on HTML)
    // These errors have stacks with no "at file.ext:line:col" frames
    const error = new SyntaxError('Unexpected token <');
    Object.defineProperty(error, 'stack', {
      value: 'SyntaxError: Unexpected token <',
      writable: true,
      configurable: true,
    });

    const errorEvent = new ErrorEvent('error', {
      message: 'Uncaught SyntaxError: Unexpected token <',
      error,
    });

    window.dispatchEvent(errorEvent);

    expect(transport.enqueueEvent).toHaveBeenCalledTimes(1);
    const payload = (transport.enqueueEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.error.stack).toContain('SyntaxError: Unexpected token <');
    expect(payload.error.stack).toContain('--- synthetic caller stack ---');
  });

  it('should NOT append synthetic stack when error has user-code frames', () => {
    installGlobalHandlers();

    // Normal error with user-code frames in stack
    const error = new TypeError('x is not a function');
    // In vitest/jsdom, new TypeError() already has user-code frames

    const errorEvent = new ErrorEvent('error', {
      message: 'Uncaught TypeError: x is not a function',
      error,
    });

    window.dispatchEvent(errorEvent);

    expect(transport.enqueueEvent).toHaveBeenCalledTimes(1);
    const payload = (transport.enqueueEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.error.stack).not.toContain('--- synthetic caller stack ---');
  });

  it('does not append a synthetic stack to Firefox/WebKit URL frames', () => {
    installGlobalHandlers();
    const error = new Error('firefox boom');
    error.stack =
      'trigger@https://app.example.com/assets/index.js:10:20';

    window.dispatchEvent(
      new ErrorEvent('error', {
        message: error.message,
        error,
      }),
    );

    const payload = (transport.enqueueEvent as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(payload.error.stack).toBe(error.stack);
    expect(payload.error.stack).not.toContain('synthetic caller stack');
  });

  it('should never throw even if internal processing fails', () => {
    // Make enqueueEvent throw
    (transport.enqueueEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('transport broken');
    });

    installGlobalHandlers();

    const errorEvent = new ErrorEvent('error', {
      message: 'Uncaught Error: user error',
      error: new Error('user error'),
    });

    // Should NOT throw
    expect(() => window.dispatchEvent(errorEvent)).not.toThrow();
  });

  it('stamps the configured release onto the event payload (C5)', () => {
    resetConfig();
    loadConfig({ endpoint: 'https://i.com', apiKey: TEST_PK, release: 'sha-abc123' });
    const payload = buildPayload('Error', 'boom', 'at a.js:1:1', {
      type: 'error', timestamp: new Date().toISOString(), category: 'exception', message: 'x', level: 'error',
    });
    expect(payload.release).toBe('sha-abc123');
  });
});
