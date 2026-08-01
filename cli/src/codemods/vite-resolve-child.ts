import { resolveInChild, type ResolveInChildOptions } from './vite-resolve.js';

process.once('message', async (message: unknown) => {
  const invalid = !message
    || typeof message !== 'object'
    || (message as { type?: unknown }).type !== 'vite-resolve-request'
    || typeof (message as { requestId?: unknown }).requestId !== 'string'
    || typeof (message as { appDir?: unknown }).appDir !== 'string'
    || typeof (message as { configPath?: unknown }).configPath !== 'string';
  const result = invalid
    ? { ok: false as const, reason: 'vite_resolve_child_failed' as const, error: 'invalid request' }
    : await resolveInChild(message as ResolveInChildOptions);
  const requestId = invalid ? '' : (message as { requestId: string }).requestId;
  if (process.send) {
    process.send({
      type: 'vite-resolve-result',
      requestId,
      result,
    }, () => process.exit(0));
  }
});
