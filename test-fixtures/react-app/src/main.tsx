import { createRoot } from 'react-dom/client';
import { init } from '@opslane/sdk';
import { OpslaneErrorBoundary } from '@opslane/sdk/react';
import { App } from './App';

init({
  endpoint: 'http://localhost:8082',
  apiKey: 'opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq',
  release: 'e2e-react-fixture-v1',
  replay: { enabled: true },
});

createRoot(document.getElementById('root')!).render(
  <OpslaneErrorBoundary fallback={<p data-testid="boundary-fallback">Something broke</p>}>
    <App />
  </OpslaneErrorBoundary>
);
