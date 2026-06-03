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
    alias: {
      '$app/navigation': resolve(__dirname, './src/test/mocks/app-navigation.ts'),
      $lib: resolve(__dirname, './src/lib'),
      $app: resolve(__dirname, './node_modules/@sveltejs/kit/src/runtime/app'),
    },
  },
});
