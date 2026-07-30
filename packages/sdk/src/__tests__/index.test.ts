import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TEST_PK } from './test-keys';

// We need to test the public API, so we mock the internals
vi.mock('../core', () => ({
  installGlobalHandlers: vi.fn(),
  uninstallGlobalHandlers: vi.fn(),
  captureException: vi.fn(),
  setUser: vi.fn(),
  clearUser: vi.fn(),
  onIdentityChange: vi.fn(),
}));

vi.mock('../console', () => ({
  patchConsole: vi.fn(),
  unpatchConsole: vi.fn(),
}));

vi.mock('../network', () => ({
  patchFetch: vi.fn(),
  unpatchFetch: vi.fn(),
  patchXHR: vi.fn(),
  unpatchXHR: vi.fn(),
}));

vi.mock('../transport', () => ({
  startTransport: vi.fn(),
  stopTransport: vi.fn(),
  enqueueEvent: vi.fn(),
  flushEvents: vi.fn(),
}));

vi.mock('../replay', () => ({
  registerSession: vi.fn().mockResolvedValue(false),
  resetSessionRegistrations: vi.fn(),
  startReplayCapture: vi.fn(),
  stopReplayCapture: vi.fn(),
}));

vi.mock('../telemetry', () => ({
  installInteractionTelemetry: vi.fn(),
  uninstallInteractionTelemetry: vi.fn(),
}));

import { init, destroy } from '../index';
import { loadConfig, resetConfig } from '../config';
import * as core from '../core';
import * as consolePatcher from '../console';
import * as network from '../network';
import * as transport from '../transport';
import * as replay from '../replay';
import * as telemetry from '../telemetry';

describe('SDK Public API', () => {
  afterEach(() => {
    destroy();
    resetConfig();
    vi.clearAllMocks();
  });

  it('should initialize all subsystems on init()', () => {
    init({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
    });

    expect(core.installGlobalHandlers).toHaveBeenCalledTimes(1);
    expect(consolePatcher.patchConsole).toHaveBeenCalledTimes(1);
    expect(network.patchFetch).toHaveBeenCalledTimes(1);
    expect(network.patchXHR).toHaveBeenCalledTimes(1);
    expect(telemetry.installInteractionTelemetry).toHaveBeenCalledTimes(1);
    expect(transport.startTransport).toHaveBeenCalledTimes(1);
    expect(replay.registerSession).toHaveBeenCalledTimes(1);
    expect(replay.startReplayCapture).toHaveBeenCalledTimes(1);
  });

  it('should tear down all subsystems on destroy()', () => {
    init({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
    });

    destroy();

    expect(core.uninstallGlobalHandlers).toHaveBeenCalledTimes(1);
    expect(consolePatcher.unpatchConsole).toHaveBeenCalledTimes(1);
    expect(network.unpatchFetch).toHaveBeenCalledTimes(1);
    expect(network.unpatchXHR).toHaveBeenCalledTimes(1);
    expect(telemetry.uninstallInteractionTelemetry).toHaveBeenCalledTimes(1);
    expect(transport.stopTransport).toHaveBeenCalledTimes(1);
    expect(replay.stopReplayCapture).toHaveBeenCalledTimes(1);
    expect(replay.resetSessionRegistrations).toHaveBeenCalledTimes(1);
  });

  it('should not double-initialize', () => {
    init({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
    });

    init({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
    });

    expect(core.installGlobalHandlers).toHaveBeenCalledTimes(1);
  });

  it('should re-export the Vue plugin', async () => {
    const mod = await import('../index');
    expect(mod.opslaneVuePlugin).toBeDefined();
  });

  it('should never throw even if a subsystem fails during init', () => {
    (core.installGlobalHandlers as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error('core broken');
      }
    );

    expect(() =>
      init({
        endpoint: 'https://ingest.example.com',
        apiKey: TEST_PK,
      })
    ).not.toThrow();
  });
});
