import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { opslaneVitePlugin } from '@opslane/sdk/vite-plugin';

export default defineConfig({
  // opslaneSourceMapPlugin is deliberately absent: it fails the build until
  // batch upload ships (#218).
  worker: {
    format: 'es',
    // A worker is a separate build pass; without this its chunks ship unstamped.
    plugins: () => [opslaneVitePlugin()],
  },
  plugins: [vue(), opslaneVitePlugin()],
});
