import { nearViewport } from './nearViewport';
import { preloadRouteCodeOnce } from '$lib/navigation/routeCodePreload';

/**
 * Preloads a link's route code the first time the link is on screen - ONCE PER DOCUMENT.
 *
 * It replaces `data-sveltekit-preload-code="viewport"` on the app's navigation links, which asks the
 * same question (is the link visible?) but asks it again after every navigation: SvelteKit re-scans
 * the page's links each time and preloads every visible one anew, and each preload re-resolves the
 * route's whole dependency list in Vite's helper (`routeCodePreload.ts` has the measurement). A link
 * that is never displayed (the bottom bar on a desktop, the sidebar on a phone) never intersects
 * and preloads nothing, as before.
 *
 * Event-driven, never timed: the first intersection after the link is drawn starts it.
 *
 * ONE ATTEMPT PER DRAWN LINK. The observer is one-shot, so a link whose preload FAILED does not
 * retry by itself: re-observing a link that is still on screen would fire at once and retry in a
 * loop for as long as the network is gone. The memo forgets the failure, so the next caller - this
 * link drawn again, a swipe neighbour - asks anew, and the navigation itself loads the route's
 * code regardless.
 *
 * @example
 * ```svelte
 * <a href={place.href} use:preloadRouteOnView={place.href}>
 * ```
 */
export function preloadRouteOnView(node: HTMLElement, pathname: string) {
  let target = pathname;
  const watch = nearViewport(node, {
    rootMargin: '0px',
    onnear: () => {
      void preloadRouteCodeOnce(target).catch(() => {
        // Already logged once, with its route, where it failed (`preloadRouteCodeOnce`).
      });
    },
  });
  return {
    update(next: string) {
      target = next;
    },
    destroy() {
      watch.destroy();
    },
  };
}
