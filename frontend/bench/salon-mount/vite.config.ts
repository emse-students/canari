/**
 * THE SALON MOUNT, BUILT AS THE APP SHIPS IT, OUTSIDE THE APP.
 *
 * A production Svelte build (no dev checks), the app's own Tailwind sheet, and ONE page that mounts
 * `ChatArea` over a synthetic salon. What it measures is the component's mount in a real engine -
 * script, style and layout - with nothing else on the main thread: no session, no MLS, no network.
 * The driver is `run.mjs`; the readings are on docs/wiki/frontend/community-open-budget.md.
 *
 * The root is `frontend/`, so Tailwind's source detection sees the same files the app build sees.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

const root = resolve(import.meta.dirname, '../..');
const here = import.meta.dirname;

export default defineConfig({
  root,
  base: './',
  mode: 'production',
  logLevel: 'warn',
  plugins: [tailwindcss(), svelte({ configFile: false })],
  define: {
    // The app's build stamps its version here; the bench is no release.
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('bench'),
  },
  resolve: {
    conditions: ['browser'],
    alias: [
      // Sender names and avatars ask the network; the bench answers from memory (`stubs/`).
      {
        find: /^\$lib\/utils\/users\/displayName$/,
        replacement: resolve(here, 'stubs/displayName.ts'),
      },
      { find: /^\$lib\/utils\/userAvatarCache$/, replacement: resolve(here, 'stubs/avatar.ts') },
      { find: '$app/navigation', replacement: resolve(root, 'src/test/mocks/app-navigation.ts') },
      { find: '$app/paths', replacement: resolve(root, 'src/test/mocks/app-paths.ts') },
      { find: '$app/state', replacement: resolve(here, 'stubs/app-state.ts') },
      { find: '$app/environment', replacement: resolve(here, 'stubs/app-environment.ts') },
      { find: '$lib', replacement: resolve(root, 'src/lib') },
    ],
  },
  build: {
    // `BENCH_READABLE=1` keeps names for a CPU profile; the timings are read on the minified build.
    minify: process.env.BENCH_READABLE !== '1',
    // `BENCH_OUT` keeps a second build apart (a baseline for `run.mjs --compare`).
    outDir: process.env.BENCH_OUT ?? resolve(root, 'node_modules/.cache/bench-salon-mount'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(here, 'index.html') },
  },
});
