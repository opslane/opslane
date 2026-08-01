import { captureException, init } from '@opslane/sdk';

init({
  endpoint: import.meta.env['VITE_OPSLANE_ENDPOINT'] ?? 'http://localhost:8082',
  apiKey: 'opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq',
  maxBatchSize: 1,
  flushInterval: 50,
  replay: { enabled: false },
});

self.addEventListener('message', (event: MessageEvent<'capture' | 'forward'>) => {
  const error = new Error(
    event.data === 'capture'
      ? 'debug-id worker capture'
      : 'debug-id worker forwarded',
  );
  if (event.data === 'capture') {
    captureException(error);
    self.postMessage({ kind: 'worker-captured', stack: error.stack ?? '' });
    return;
  }
  self.postMessage({ kind: 'worker-stack', stack: error.stack ?? '' });
});
