/**
 * EVERY WORKER THIS APP SPAWNS LOADS IN A WORKER SCOPE - proven by bundling it and running it in
 * one, not by reading its imports.
 *
 * A worker has no `window`, no `document` and no SvelteKit client runtime, and a module that touches
 * any of them AT LOAD kills the worker before its first message - with nothing in the page's own
 * graph to say so, since the page has all three. That shipped in `1.4.1-alpha.2` (2026-10-24): one
 * `import type` became a value import in `mlsWasmLoader.ts`, its target reached `$lib/utils/hex.ts`,
 * and `hex.ts` took `isTauriRuntime` from the link-click module, which imports `$app/navigation`.
 * SvelteKit's client runtime reads `window.fetch` when it loads, so all three MLS workers died with
 * `window is not defined`: the state checkpoint never stored, and every reload rotated the device
 * identity. Nothing failed - the page graph is fine, and a type-check sees an edge, not a scope.
 *
 * What each case does: bundle the worker entry with Vite (so tree-shaking and the erasure of
 * type-only imports are the real ones), then import the bundle in a `node:worker_threads` thread,
 * which has `fetch` and `crypto` like a browser worker and, like it, no `window` and no `document`.
 * `self` is set to the thread's global, as a `WorkerGlobalScope` has it. A load that throws is a
 * failure carrying the thrown error. The SvelteKit virtual modules (`$app/*`, `$env/*`,
 * `__sveltekit/*`) are refused at resolution with the importer named: the app build resolves them
 * through the SvelteKit plugin, which this bundle does not run, and none of them belongs in a
 * worker - so the chain that brought one in is the message.
 *
 * The worker set is READ from the source (`?worker` imports), and any other way to start a worker
 * fails the inventory, so a new worker cannot be added outside this test.
 *
 * Wiki: docs/wiki/frontend/mls-wasm.md#a-worker-loads-in-a-worker-scope.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { build, type Plugin } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sourceFiles } from '../../test/sourceTree';

const FRONTEND = resolvePath(import.meta.dirname, '../../..');

/** `import X from '<path>?worker'`, with any further query. */
const WORKER_IMPORT = /import\s+\w+\s+from\s+['"]([^'"?]+)\?worker(?:&[^'"]*)?['"]/g;
/**
 * Every OTHER way to start one of OUR modules as a worker. Not supported by this test, so it fails
 * the inventory rather than escape it. (pdf.js's own worker is set through `workerSrc` from a
 * prebuilt `?url` asset of the library, not one of ours, and matches none of these.)
 */
const OTHER_WORKER_FORM =
  /new\s+(?:Shared)?Worker\s*\(\s*new\s+URL|\?sharedworker|audioWorklet\.addModule|serviceWorker\.register/;

/** A worker entry: its frontend-root POSIX path. */
function workerEntries(): string[] {
  const entries = new Set<string>();
  for (const file of sourceFiles({
    under: 'src',
    extensions: ['ts', 'svelte'],
    tests: 'exclude',
  })) {
    expect(
      OTHER_WORKER_FORM.test(file.text),
      `${file.path} starts a worker in a form this test does not build`
    ).toBe(false);
    for (const match of file.text.matchAll(WORKER_IMPORT)) {
      const spec = match[1];
      const base = spec.startsWith('$lib/')
        ? posix.join('src/lib', spec.slice('$lib/'.length))
        : posix.join(posix.dirname(file.path), spec);
      entries.add(base.endsWith('.ts') || base.endsWith('.js') ? base : `${base}.ts`);
    }
  }
  return [...entries].sort();
}

/**
 * Refuses the SvelteKit virtual modules, naming who imported them. The app's own build resolves
 * them through the SvelteKit plugin; a worker must never need it.
 */
function noPageRuntime(): Plugin {
  return {
    name: 'no-page-runtime-in-a-worker',
    enforce: 'pre',
    resolveId(source, importer) {
      if (/^(\$app\/|\$env\/|__sveltekit\/)/.test(source)) {
        throw new Error(
          `a worker reached the SvelteKit page runtime: ${importer ?? '?'} imports ${source}`
        );
      }
      return null;
    },
  };
}

/** What a worker thread reports about loading the module it was handed. */
type LoadVerdict = { ok: true } | { ok: false; error: string };

/**
 * Imports `url` in a fresh `worker_threads` thread whose global has `self` and nothing a page adds.
 * Settles on the thread's own report, or on its `error` / `exit` - never on a clock.
 */
function loadInWorkerScope(url: string): Promise<LoadVerdict> {
  const bootstrap = `
    const { parentPort, workerData } = require('node:worker_threads');
    globalThis.self = globalThis;
    import(workerData.url).then(
      () => parentPort.postMessage({ ok: true }),
      (error) => parentPort.postMessage({ ok: false, error: String(error && error.stack || error) })
    );
  `;
  return new Promise((settle) => {
    const thread = new Worker(bootstrap, { eval: true, workerData: { url } });
    thread.once('message', (verdict: LoadVerdict) => {
      void thread.terminate();
      settle(verdict);
    });
    thread.once('error', (error: Error) =>
      settle({ ok: false, error: String(error.stack ?? error) })
    );
    thread.once('exit', (code) =>
      settle({ ok: false, error: `the thread exited (${code}) before reporting` })
    );
  });
}

const entries = workerEntries();
let outRoot = '';
/**
 * Per entry: the directory its bundle went to, or why it did not build. One build per entry, so a
 * worker is never blamed for a module only another one imports.
 */
const bundles = new Map<string, { dir: string } | { error: string }>();

/** Bundles ONE worker entry into its own directory. */
async function bundle(path: string): Promise<{ dir: string } | { error: string }> {
  const name = posix.basename(path, '.ts');
  const dir = join(outRoot, name);
  try {
    await build({
      configFile: false,
      root: FRONTEND,
      logLevel: 'silent',
      plugins: [noPageRuntime()],
      resolve: { alias: { $lib: join(FRONTEND, 'src/lib') } },
      build: {
        outDir: dir,
        emptyOutDir: true,
        minify: false,
        target: 'esnext',
        modulePreload: false,
        copyPublicDir: false,
        rollupOptions: {
          input: { [name]: join(FRONTEND, path) },
          preserveEntrySignatures: 'strict',
          output: {
            format: 'es',
            entryFileNames: '[name].mjs',
            chunkFileNames: '[name]-[hash].mjs',
          },
        },
      },
    });
    return { dir };
  } catch (error) {
    console.warn(`[workerScope] ${path} did not bundle`, error);
    return { error: String(error) };
  }
}

beforeAll(async () => {
  outRoot = mkdtempSync(join(tmpdir(), 'canari-worker-scope-'));
  console.debug(`[workerScope] bundling ${entries.length} worker entries into ${outRoot}`);
  for (const path of entries) bundles.set(path, await bundle(path));
}, 180_000);

afterAll(() => {
  if (outRoot) rmSync(outRoot, { recursive: true, force: true });
});

describe('every worker loads in a worker scope', () => {
  it('reads the four workers the app spawns from the source, not from a list', () => {
    expect(entries).toEqual([
      'src/lib/workers/encryption.worker.ts',
      'src/lib/workers/mlsCrypto.worker.ts',
      'src/lib/workers/mlsEncrypt.worker.ts',
      'src/lib/workers/mlsKeyPackage.worker.ts',
    ]);
  });

  it.each(entries)(
    '%s loads with no window, no document and no SvelteKit runtime',
    async (path) => {
      const built = bundles.get(path);
      expect(built && 'error' in built ? built.error : null).toBeNull();
      const { dir } = built as { dir: string };
      const url = pathToFileURL(join(dir, `${posix.basename(path, '.ts')}.mjs`)).href;
      expect(await loadInWorkerScope(url)).toEqual({ ok: true });
    }
  );
});
