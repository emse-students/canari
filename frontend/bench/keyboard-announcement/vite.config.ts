/**
 * The keyboard announcement bench, built as the salon-mount bench is (the same production Svelte, the
 * app's own Tailwind sheet, the same stubs): only the page and the output directory differ.
 */
import { resolve } from 'node:path';
import { mergeConfig } from 'vite';
import salonMount from '../salon-mount/vite.config';

const root = resolve(import.meta.dirname, '../..');

export default mergeConfig(salonMount, {
  build: {
    outDir:
      process.env.BENCH_OUT ?? resolve(root, 'node_modules/.cache/bench-keyboard-announcement'),
    rollupOptions: { input: resolve(import.meta.dirname, 'index.html') },
  },
});
