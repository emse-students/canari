/** The part of SvelteKit's `Navigation` this reads: the route ids it left and reached. */
export interface NavigationRoutes {
  from: { route: { id: string | null } } | null;
  to: { route: { id: string | null } } | null;
}

/**
 * Whether a navigation landed on the route it left: the page is already mounted and will NOT
 * remount, so whatever it reads in `onMount` is stale. A first entry (`from` null) or a coming from
 * another route mounts the page fresh and reads for itself, so this is false there - which is what
 * keeps a fresh mount from fetching twice.
 */
export function isReentryOfSameRoute(nav: NavigationRoutes): boolean {
  const from = nav.from?.route.id;
  return from != null && from === nav.to?.route.id;
}
