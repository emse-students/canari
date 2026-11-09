/**
 * Which documents start the MLS binary beside their JavaScript (`wasmPreload.ts`).
 *
 * The overlap is worth its cost only where the first screen waits for the engine; elsewhere it takes
 * the binary's share of the link from the screen (12-13 s on Slow 3G, measured 2026-11-09). Two
 * things are pinned: the route list is DERIVED from the routes that mount `MainChatPage` (so it
 * cannot drift from the fact it names), and the served marker is filled for those routes and
 * untouched for every other.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  MLS_FIRST_SCREEN_ROUTES,
  WASM_PRELOAD_MARKER,
  firstScreenNeedsMls,
  renderWasmPreloadMeta,
  wasmPreloadMetaFor,
} from './wasmPreload';

const ROUTES_DIR = 'src/routes';
const URL_HASHED = '/_app/immutable/assets/mls_wasm_bg.AbCd1234.wasm';

/** Every `+page.svelte` under `src/routes`, as its URL path (groups and params kept as written). */
function pageFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...pageFiles(path));
    else if (name === '+page.svelte') found.push(path);
  }
  return found;
}

function routeOf(pageFile: string): string {
  const rel = relative(ROUTES_DIR, pageFile).split(sep).slice(0, -1).join('/');
  return `/${rel}`;
}

describe('the routes whose first screen waits for the MLS engine', () => {
  it('are exactly the routes that mount MainChatPage', () => {
    const mounting = pageFiles(ROUTES_DIR)
      .filter((file) => /import\s+MainChatPage\s+from/.test(readFileSync(file, 'utf8')))
      .map(routeOf)
      .sort();
    expect(mounting.length).toBeGreaterThan(0);
    expect([...MLS_FIRST_SCREEN_ROUTES].sort()).toEqual(mounting);
  });
});

describe('the served marker, per route', () => {
  it('is filled where the first screen waits for the engine', () => {
    for (const route of MLS_FIRST_SCREEN_ROUTES) {
      expect(wasmPreloadMetaFor(route, URL_HASHED)).toBe(renderWasmPreloadMeta(URL_HASHED));
    }
  });

  it('is left untouched everywhere else, so the head script starts nothing', () => {
    for (const path of [
      '/',
      '/posts',
      '/posts/abc',
      '/calendar',
      '/login',
      '/profile/x',
      '/c/join',
    ]) {
      expect(wasmPreloadMetaFor(path, URL_HASHED)).toBe(WASM_PRELOAD_MARKER);
    }
  });

  it('matches a route and the paths under it, never a route sharing its prefix', () => {
    expect(firstScreenNeedsMls('/chat')).toBe(true);
    expect(firstScreenNeedsMls('/chat/x')).toBe(true);
    expect(firstScreenNeedsMls('/chatter')).toBe(false);
    expect(firstScreenNeedsMls('/communities-old')).toBe(false);
  });
});
