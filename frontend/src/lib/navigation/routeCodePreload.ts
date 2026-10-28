import { preloadCode } from '$app/navigation';
import { match } from '$app/paths';
import { Log } from '$lib/utils/Log';

/**
 * A ROUTE'S CODE IS FETCHED ONCE PER PROCESS, NOT ONCE PER NAVIGATION.
 *
 * WHAT IT COST BEFORE (Mi 9T, `v1.2.8`, CPU profile of a tap on "Communautes", 2026-10-15). SvelteKit
 * re-scans every `data-sveltekit-preload-code="viewport"` link after EACH navigation and calls
 * `preloadCode` for each one on screen - the four tabs of the bottom bar, every time - and the
 * layout preloads both swipe neighbours on every arrival. Each call runs the route's node loaders,
 * and each loader goes through Vite's `__vitePreload` helper, which resolves EVERY dependency URL of
 * the node (about 250 for a tab: two `new URL` and an `import.meta.resolve` each) before it looks at
 * its own cache. Nothing is fetched - the modules have been loaded since boot - and the helper still
 * cost 60-118 ms of main thread per tab tap; 31 ms of it ran between the communities page's mount
 * and its first paint.
 *
 * WHY A MEMO IS CORRECT. A module imported once stays in the module map for the life of the
 * document: there is nothing a second `preloadCode` of the same route can add. A preload that FAILS
 * (a web build offline, a deploy that replaced the chunk) is forgotten, so the next CALLER tries
 * again - the memo holds successes and attempts in flight, never a failure. Whether a next caller
 * comes is the caller's business: `preloadRouteOnView` makes one attempt per drawn link, and the
 * layout asks again for the swipe neighbours on every arrival. Either way the navigation itself
 * loads the route's code, so a missed preload costs only its head start.
 *
 * Keyed by pathname: `preloadCode` takes one, and a query string never changes a route's code.
 */
const preloads = new Map<string, Promise<void>>();

/**
 * SvelteKit 3's `preloadCode` takes a ROUTE ID, no longer a pathname: the path is matched to its
 * route first. A path no route owns has no code to fetch, which is not an error.
 */
async function preloadPathCode(pathname: string): Promise<void> {
  const matched = await match(pathname);
  if (matched) await preloadCode(matched.id);
}

/**
 * Preloads `pathname`'s route code unless this document already did (or is doing) so.
 *
 * @param pathname an in-app path such as `/communities`.
 * @param preload the route preloader; SvelteKit's `preloadCode`, injectable for tests.
 * @returns the preload in flight or settled; rejects when this attempt failed.
 */
export function preloadRouteCodeOnce(
  pathname: string,
  preload: (pathname: string) => Promise<void> = preloadPathCode
): Promise<void> {
  const known = preloads.get(pathname);
  if (known) return known;
  Log.d('RoutePreload', { pathname, first: true });
  const attempt = preload(pathname).catch((err: unknown) => {
    preloads.delete(pathname);
    console.warn('[RoutePreload] code preload failed, the next caller retries:', pathname, err);
    throw err;
  });
  preloads.set(pathname, attempt);
  return attempt;
}

/** Test seam: forgets every preload, as a fresh document would. */
export function resetRouteCodePreloadsForTests(): void {
  preloads.clear();
}
