import { createApp } from 'vue';
import App from './App.vue';
import { init, opslaneVuePlugin } from '@opslane/sdk';

// Endpoint/key are overridable so the same fixture drives any local stack
// (e.g. the Batch 4 dogfood on non-default ports, or a staging environment
// key for isolation runs). Defaults preserve the standard compose setup.
const release = import.meta.env['VITE_OPSLANE_RELEASE'] ?? 'e2e-fixture-v1';

init({
  endpoint: import.meta.env['VITE_OPSLANE_ENDPOINT'] ?? 'http://localhost:8082',
  apiKey: import.meta.env['VITE_OPSLANE_API_KEY']
    ?? 'opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq',
  ...(release ? { release } : {}),
  environment: import.meta.env['VITE_OPSLANE_ENVIRONMENT'] ?? 'development',
  reporting: { enabled: import.meta.env['VITE_OPSLANE_REPORTING'] !== 'false' },
  replay: { enabled: true },
});

const app = createApp(App);
app.use(opslaneVuePlugin);
app.mount('#app');
