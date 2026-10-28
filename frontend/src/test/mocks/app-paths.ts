/**
 * Vitest stub for `$app/paths` (its virtual `__sveltekit/paths` module exists only inside SvelteKit).
 *
 * `resolve` follows SvelteKit 3's two forms: a string starting with `/` is a ROUTE ID and a string
 * that does not is a PATHNAME, which gains its leading slash. The app is served at the root, so the
 * base is empty and both come back as an absolute path.
 */
export function resolve(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/** One page route of `src/routes`, as SvelteKit's router matches it. */
interface StubRoute {
  id: string;
  pattern: RegExp;
  /** Dynamic segments, so a static route wins over a parameter the way Kit sorts them. */
  dynamic: number;
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * THE APP'S OWN ROUTE TABLE, read from the files that define it, because under SvelteKit 3 the
 * answer matters: `goto` rejects a path no route matches, and `gotoAppPath` asks `match` first. A
 * stub that matched nothing would send every caller down the no-route branch and test nothing.
 * Groups `(x)` vanish, `[x]` is one segment, `[[x]]` an optional one, `[...x]` any rest.
 */
const ROUTES: StubRoute[] = Object.keys(import.meta.glob('/src/routes/**/+page.svelte'))
  .map((file) => {
    const id = file.slice('/src/routes'.length, -'/+page.svelte'.length) || '/';
    const segments = id.split('/').filter((s) => s && !/^\(.*\)$/.test(s));
    let source = '^';
    let dynamic = 0;
    for (const s of segments) {
      if (/^\[\[.+\]\]$/.test(s)) {
        source += '(?:/[^/]+)?';
        dynamic += 1;
      } else if (/^\[\.\.\..+\]$/.test(s)) {
        source += '(?:/.*)?';
        dynamic += 2;
      } else if (/^\[.+\]$/.test(s)) {
        source += '/[^/]+';
        dynamic += 1;
      } else {
        source += `/${s.replace(ESCAPE, '\\$&')}`;
      }
    }
    return { id, pattern: new RegExp(`${source}/?$`), dynamic };
  })
  .sort((a, b) => a.dynamic - b.dynamic);

/** Matches a path against `src/routes`, as `match` does in the app (params are not extracted). */
export async function match(url: string | URL): Promise<{ id: string; params: object } | null> {
  const { pathname } = new URL(url, 'https://canari.test');
  const route = ROUTES.find((r) => r.pattern.test(pathname));
  return route ? { id: route.id, params: {} } : null;
}
