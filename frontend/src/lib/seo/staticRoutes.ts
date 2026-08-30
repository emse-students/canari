/**
 * Which paths SvelteKit resolves to a STATIC route, derived from the route tree at build time.
 *
 * It is its own module for the reason `sitemap.ts` is: `serverSeo.ts` reaches the services through
 * `internalApi.ts`, which reads `$env/dynamic/private` and therefore cannot be imported outside a
 * server process. This fact needs none of that - it is a statement about the route tree alone.
 */

/**
 * Every page path that a real `+page.svelte` owns.
 *
 * DERIVED and not listed, so it cannot drift: a new static route joins it by existing. The glob is
 * resolved at build time, so nothing here costs anything at request time. Parameterised routes are
 * excluded by the `[` their directory name carries.
 */
const STATIC_ROUTES: ReadonlySet<string> = new Set(
  Object.keys(import.meta.glob('/src/routes/**/+page.svelte'))
    .filter((file) => !file.includes('['))
    .map((file) => file.slice('/src/routes'.length, -'/+page.svelte'.length) || '/')
);

/** Strips the optional trailing slash a path may carry, leaving the root itself alone. */
export function normalizePath(pathname: string): string {
  return pathname.replace(/(.)\/$/, '$1');
}

/**
 * True when a real page owns this exact path, and no `:id` pattern may therefore claim it.
 *
 * `serverSeo.ts` picks an enricher with a regex, which is NOT how SvelteKit routes: there a literal
 * segment always beats a parameterised sibling, so `/forms/success` is the post-payment page and
 * never the form whose id is `success`. A regex has no such rule, and without this four real pages
 * were handed to an enricher as an id - `/forms/success`, `/forms/cancel`, `/forms/create` and
 * `/associations/new`. The first three reached Postgres as a `uuid` and social-service answered 500
 * on every completed payment, measured on prod 2026-08-27.
 */
export function isStaticPageRoute(pathname: string): boolean {
  return STATIC_ROUTES.has(normalizePath(pathname));
}
