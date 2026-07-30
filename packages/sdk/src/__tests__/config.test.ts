import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, getConfig, resetConfig } from '../config';
import { TEST_PK } from './test-keys';

describe('SDK Config', () => {
  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    resetConfig();
    vi.restoreAllMocks();
  });

  it('should load config from provided options', () => {
    loadConfig({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
    });

    const config = getConfig();
    expect(config).toEqual({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
      release: '',
      environment: '',
      maxBreadcrumbs: 50,
      breadcrumbMaxAge: 30_000,
      flushInterval: 5_000,
      maxBatchSize: 10,
      debug: false,
      reportingEnabled: true,
      replayEnabled: true,
      sampleRate: 1,
      errorThrottleMs: 1000,
      beforeSend: undefined,
    });
  });

  it('should default release to empty string', () => {
    loadConfig({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
    });

    expect(getConfig().release).toBe('');
  });

  it('should accept a release option', () => {
    loadConfig({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
      release: 'v1.2.3',
    });

    expect(getConfig().release).toBe('v1.2.3');
  });

  it('defaults environment to empty and accepts an explicit environment', () => {
    loadConfig({ apiKey: TEST_PK });
    expect(getConfig().environment).toBe('');

    resetConfig();
    loadConfig({ apiKey: TEST_PK, environment: 'staging' });
    expect(getConfig().environment).toBe('staging');
  });

  it('should allow partial overrides with defaults', () => {
    loadConfig({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
      debug: true,
      maxBatchSize: 5,
    });

    const config = getConfig();
    expect(config.debug).toBe(true);
    expect(config.maxBatchSize).toBe(5);
    expect(config.flushInterval).toBe(5_000); // default
  });

  it('should load replay capture options', () => {
    loadConfig({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
      replay: {
        enabled: true,
      },
    });

    const config = getConfig();
    expect(config.replayEnabled).toBe(true);
  });

  describe('replay default (design v4-15)', () => {
    it('defaults replay to enabled when absent or empty', () => {
      loadConfig({ apiKey: TEST_PK });
      expect(getConfig().replayEnabled).toBe(true);
      resetConfig();
      loadConfig({ apiKey: TEST_PK, replay: {} });
      expect(getConfig().replayEnabled).toBe(true);
    });

    it('honours explicit opt-out and opt-in', () => {
      loadConfig({ apiKey: TEST_PK, replay: { enabled: false } });
      expect(getConfig().replayEnabled).toBe(false);
      resetConfig();
      loadConfig({ apiKey: TEST_PK, replay: { enabled: true } });
      expect(getConfig().replayEnabled).toBe(true);
    });
  });

  describe('session reporting', () => {
    it('defaults to enabled when absent or empty', () => {
      loadConfig({ apiKey: TEST_PK });
      expect(getConfig().reportingEnabled).toBe(true);
      resetConfig();
      loadConfig({ apiKey: TEST_PK, reporting: {} });
      expect(getConfig().reportingEnabled).toBe(true);
    });

    it('honours an explicit opt-out independently of replay', () => {
      loadConfig({
        apiKey: TEST_PK,
        reporting: { enabled: false },
        replay: { enabled: true },
      });
      expect(getConfig().reportingEnabled).toBe(false);
      expect(getConfig().replayEnabled).toBe(true);
    });
  });

  it('should throw if getConfig called before loadConfig', () => {
    expect(() => getConfig()).toThrow('SDK not initialized');
  });

  it('should throw if required fields are missing', () => {
    expect(() =>
      loadConfig({ endpoint: '', apiKey: TEST_PK })
    ).toThrow('endpoint is required');

    expect(() =>
      loadConfig({ endpoint: 'https://x.com', apiKey: '' })
    ).toThrow('apiKey is required');
  });

  it('should throw on a malformed endpoint', () => {
    expect(() => loadConfig({ endpoint: 'not-a-url', apiKey: TEST_PK }))
      .toThrow('endpoint must be a valid http(s) URL');
    expect(() => loadConfig({ endpoint: '   ', apiKey: TEST_PK }))
      .toThrow('endpoint must be a valid http(s) URL');
    // host-less URL a permissive regex would wrongly accept
    expect(() => loadConfig({ endpoint: 'https://?x', apiKey: TEST_PK }))
      .toThrow('endpoint must be a valid http(s) URL');
    // non-http(s) scheme
    expect(() => loadConfig({ endpoint: 'ftp://example.com', apiKey: TEST_PK }))
      .toThrow('endpoint must be a valid http(s) URL');
  });

  it('should accept the default endpoint and explicit http(s) endpoints', () => {
    expect(() => loadConfig({ apiKey: TEST_PK })).not.toThrow();
    expect(() => loadConfig({ endpoint: 'http://localhost:8080', apiKey: TEST_PK })).not.toThrow();
    expect(() => loadConfig({ endpoint: 'https://x.com', apiKey: TEST_PK })).not.toThrow();
  });
});
