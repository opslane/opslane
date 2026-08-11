import type { Breadcrumb } from '@opslane/shared';
import { buildPayload } from './core';
import { enqueueEvent } from './transport';

interface VueApp {
  config: {
    errorHandler:
      | ((err: unknown, instance: unknown, info: string) => void)
      | null;
  };
}

function extractComponentName(instance: unknown): string {
  if (
    instance &&
    typeof instance === 'object' &&
    '$options' in instance &&
    instance.$options &&
    typeof instance.$options === 'object' &&
    'name' in instance.$options
  ) {
    return String((instance.$options as { name?: string }).name || 'Anonymous');
  }
  return 'Anonymous';
}

export const opslaneVuePlugin = {
  install(app: unknown): void {
    const vueApp = app as VueApp;
    const existingHandler = vueApp.config.errorHandler;

    vueApp.config.errorHandler = (
      err: unknown,
      instance: unknown,
      info: string
    ): void => {
      try {
        let errorType: string;
        let errorMessage: string;
        let stack: string;

        if (err instanceof Error) {
          // err.name survives minification; the constructor name does not.
          errorType = err.name || err.constructor.name || 'Error';
          errorMessage = err.message;
          stack = err.stack || '';
        } else {
          errorType = 'VueError';
          errorMessage = String(err);
          stack = '';
        }

        const vueCrumb: Breadcrumb = {
          type: 'error',
          timestamp: new Date().toISOString(),
          category: 'vue.error',
          message: `${errorType}: ${errorMessage}`,
          level: 'error',
          data: {
            lifecycleHook: info,
            componentName: extractComponentName(instance),
          },
        };

        const payload = buildPayload(errorType, errorMessage, stack, vueCrumb);
        enqueueEvent(payload, 'uncaught_error');
      } catch (_e) {
        // SDK must never throw into the customer's app
      }

      // Chain to existing handler
      if (existingHandler) {
        existingHandler(err, instance, info);
      }
    };
  },
};
