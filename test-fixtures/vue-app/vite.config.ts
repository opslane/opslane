import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  // Source-map upload is unavailable until the batch API ships (#218).
  plugins: [vue()],
});
