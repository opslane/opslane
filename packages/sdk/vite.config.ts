import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import dts from 'vite-plugin-dts';

const pkgVersion = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf8')
).version as string;

export default defineConfig({
  define: {
    __OPSLANE_SDK_VERSION__: JSON.stringify(pkgVersion),
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        react: resolve(__dirname, 'src/react.tsx'),
        'vite-plugin': resolve(__dirname, 'vite-plugin/index.ts'),
        'build/debug-id': resolve(__dirname, 'src/build/debug-id.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['vue', 'react', 'react-dom', 'react/jsx-runtime', 'vite'],
    },
    sourcemap: false,
    outDir: 'dist',
  },
  plugins: [
    dts({
      include: ['src/**/*.ts', 'src/**/*.tsx', 'vite-plugin/**/*.ts'],
      // Bundle types into flat per-entry .d.ts files so type-only imports
      // from the private @opslane/shared package are inlined — without this,
      // the published tarball's types are unresolvable for npm consumers.
      rollupTypes: true,
      bundledPackages: ['@opslane/shared'],
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
