import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
    server: {
      deps: {
        // jsdom uses require() on this ESM-only package with top-level await,
        // which breaks on Node 22+. Forcing inline lets Vite handle the transform.
        inline: ['@asamuzakjp/css-color'],
      },
    },
  },
  resolve: {
    alias: {
      $lib: resolve(__dirname, './src/lib'),
      $app: resolve(__dirname, '../../node_modules/@sveltejs/kit/src/runtime/app'),
    },
  },
});
