/**
 * Serves checkpoint.html and the app's generated WASM (`frontend/src/lib/wasm`, built by
 * `bun run generate`) on one origin, so the bench measures the exact bytes the app ships.
 *
 *   bun tools/perf-bench/serve.ts [port]     # default 5199, listens on every interface
 */
import { join } from 'node:path';

const here = import.meta.dir;
const wasmDir = join(here, '..', '..', 'frontend', 'src', 'lib', 'wasm');
const port = Number(process.argv[2] ?? 5199);
const TYPES: Record<string, string> = {
  wasm: 'application/wasm',
  js: 'text/javascript',
  html: 'text/html',
};

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch(req) {
    const path = new URL(req.url).pathname;
    const file = path.startsWith('/wasm/')
      ? join(wasmDir, path.slice('/wasm/'.length))
      : join(here, path === '/' ? 'checkpoint.html' : path.slice(1));
    if (!file.startsWith(here) && !file.startsWith(wasmDir))
      return new Response('no', { status: 403 });
    const ext = file.split('.').pop() ?? '';
    return new Response(Bun.file(file), {
      headers: { 'content-type': TYPES[ext] ?? 'text/plain' },
    });
  },
});
console.log(`[perf-bench] http://localhost:${port}/  (append ?groups=5,20,40,80)`);
