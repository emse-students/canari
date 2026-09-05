import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
  },
  resolve: {
    // THE CLIENT BUILD OF SVELTE, NOT THE SERVER ONE. Without it `svelte` resolves to
    // `index-server.js`, whose `mount()` throws `lifecycle_function_unavailable` - so a component
    // could only ever be tested through the functions it happens to export, and a defect that lives
    // in the DOM event path (see `Modal.dismissal.svelte.test.ts`) has nowhere to be caught. Measured
    // 2026-09-05: the 257 files and 2449 tests that predate this answer identically with it.
    conditions: ['browser'],
    alias: {
      '$app/navigation': resolve(import.meta.dirname, './src/test/mocks/app-navigation.ts'),
      $lib: resolve(import.meta.dirname, './src/lib'),
      $app: resolve(import.meta.dirname, './node_modules/@sveltejs/kit/src/runtime/app'),
    },
  },
});
