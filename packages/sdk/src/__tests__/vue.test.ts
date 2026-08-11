import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { opslaneVuePlugin } from '../vue';
import { resetConfig, loadConfig } from '../config';
import { clearBreadcrumbs } from '../breadcrumbs';
import * as transport from '../transport';
import { TEST_PK } from './test-keys';

vi.mock('../transport', () => ({
  enqueueEvent: vi.fn(),
}));

// Minimal Vue 3 app mock
function createMockApp() {
  const config = {
    errorHandler: null as ((err: unknown, instance: unknown, info: string) => void) | null,
    warnHandler: null as ((msg: string, instance: unknown, trace: string) => void) | null,
  };
  return {
    config,
    use(plugin: { install: (app: any) => void }) {
      plugin.install(this);
      return this;
    },
  };
}

describe('Vue 3 Plugin', () => {
  beforeEach(() => {
    resetConfig();
    clearBreadcrumbs();
    loadConfig({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
    });
  });

  afterEach(() => {
    resetConfig();
    clearBreadcrumbs();
    vi.restoreAllMocks();
  });

  it('should install as a Vue 3 plugin', () => {
    const app = createMockApp();
    app.use(opslaneVuePlugin);

    expect(app.config.errorHandler).toBeTypeOf('function');
  });

  it('should capture Vue component errors via errorHandler', () => {
    const app = createMockApp();
    app.use(opslaneVuePlugin);

    const error = new TypeError('Cannot read properties of undefined');
    app.config.errorHandler!(error, null, 'render function');

    expect(transport.enqueueEvent).toHaveBeenCalledTimes(1);
    const payload = (transport.enqueueEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.error.type).toBe('TypeError');
    expect(payload.error.message).toBe('Cannot read properties of undefined');
  });

  it('prefers err.name over the constructor name for the error type', () => {
    const app = createMockApp();
    app.use(opslaneVuePlugin);

    // Simulates a minified bundle: the class identifier churns per release,
    // the string assigned to this.name does not.
    class Nu extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'FetchError';
      }
    }

    app.config.errorHandler!(new Nu('Error deleting Assets'), null, 'render function');

    const payload = (transport.enqueueEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.error.type).toBe('FetchError');
  });

  it('should include Vue lifecycle info in breadcrumb data', () => {
    const app = createMockApp();
    app.use(opslaneVuePlugin);

    const error = new Error('render failed');
    app.config.errorHandler!(error, { $options: { name: 'MyComponent' } }, 'render function');

    const payload = (transport.enqueueEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const errorCrumb = payload.breadcrumbs.find(
      (b: any) => b.type === 'error' && b.category === 'vue.error'
    );
    expect(errorCrumb).toBeTruthy();
    expect(errorCrumb!.data).toHaveProperty('lifecycleHook', 'render function');
    expect(errorCrumb!.data).toHaveProperty('componentName', 'MyComponent');
  });

  it('should handle non-Error reasons in errorHandler', () => {
    const app = createMockApp();
    app.use(opslaneVuePlugin);

    app.config.errorHandler!('string error', null, 'setup');

    expect(transport.enqueueEvent).toHaveBeenCalledTimes(1);
    const payload = (transport.enqueueEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.error.type).toBe('VueError');
    expect(payload.error.message).toBe('string error');
  });

  it('should never throw even if internal processing fails', () => {
    (transport.enqueueEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('transport broken');
    });

    const app = createMockApp();
    app.use(opslaneVuePlugin);

    expect(() => {
      app.config.errorHandler!(new Error('user error'), null, 'setup');
    }).not.toThrow();
  });

  it('should chain to existing errorHandler if one was set', () => {
    const existingHandler = vi.fn();
    const app = createMockApp();
    app.config.errorHandler = existingHandler;
    app.use(opslaneVuePlugin);

    const error = new Error('test');
    app.config.errorHandler!(error, null, 'mounted');

    expect(transport.enqueueEvent).toHaveBeenCalledTimes(1);
    expect(existingHandler).toHaveBeenCalledWith(error, null, 'mounted');
  });
});
