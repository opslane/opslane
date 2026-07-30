import { describe, it, expect } from 'vitest';
import { opslaneSourceMapPlugin } from '../../vite-plugin/index.js';

const opts = { apiKey: 'unused', endpoint: 'https://api.test' };

describe('vite plugin', () => {
  it('fails the build instead of silently dropping source maps', () => {
    const plugin = opslaneSourceMapPlugin(opts) as { configResolved: (config: unknown) => void };

    expect(() => plugin.configResolved({})).toThrow(/source-map upload is unavailable/);
  });

  it('no longer removes map assets from the bundle', () => {
    const plugin = opslaneSourceMapPlugin(opts) as Record<string, unknown>;

    expect(plugin.generateBundle).toBeUndefined();
  });
});
