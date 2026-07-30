import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_PK, TEST_SK } from './test-keys';

describe('init key validation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('accepts a public ingest key', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { destroy, init } = await import('../index.js');

    init({ apiKey: TEST_PK });

    expect(error).not.toHaveBeenCalled();
    destroy();
  });

  it('refuses a secret source-map key and says so without debug enabled', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { init } = await import('../index.js');

    init({ apiKey: TEST_SK });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('opslane_pk_'));
  });

  it('refuses a legacy def_ key', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { init } = await import('../index.js');

    init({ apiKey: 'def_2f1c9a44-1b3e-4f4a-9c7a-4b2d8e6f0a11' });

    expect(error).toHaveBeenCalled();
  });
});
