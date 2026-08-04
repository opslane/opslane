import { describe, it, expect } from 'vitest';

describe('SDK Package Exports', () => {
  it('should export init function', async () => {
    const sdk = await import('../index');
    expect(typeof sdk.init).toBe('function');
  });

  it('should export destroy function', async () => {
    const sdk = await import('../index');
    expect(typeof sdk.destroy).toBe('function');
  });

  it('should export opslaneVuePlugin', async () => {
    const sdk = await import('../index');
    expect(sdk.opslaneVuePlugin).toBeDefined();
    expect(typeof sdk.opslaneVuePlugin.install).toBe('function');
  });

  it('should not export the removed opslaneSourceMapPlugin', async () => {
    const plugin = await import('../../vite-plugin/index') as Record<string, unknown>;
    expect(plugin['opslaneSourceMapPlugin']).toBeUndefined();
  });
});
