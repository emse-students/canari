import type { SeoMeta } from '$lib/seo/types';
import type { PageLoad } from './$types';

/**
 * Prerendered so that ONE plain HTML file capable of booting the SPA exists in the web build.
 *
 * `adapter-node` emits no `index.html`, which left nginx with nothing to answer when the
 * `frontend-ssr` container is down: every navigation became a 502 and the whole site went with it,
 * where before this feature the same outage was impossible. nginx serves this file on a 502/503/504
 * from that upstream, and the app boots exactly as it always did - it resolves its route from
 * `location.pathname` on the client - with the generic site head instead of the per-page one.
 *
 * That is a degradation of the SEO head, not a fallback hiding a fault: the head is the bonus this
 * feature added, and losing it must not cost the app. The outage is still visible in
 * `docker compose ps` through the container's healthcheck.
 *
 * `noindex` because this path is an implementation detail with no content of its own; `robots.txt`
 * disallows it as well.
 */
export const prerender = true;

export const load: PageLoad = () => {
  const seo: SeoMeta = {
    title: 'Canari',
    description: 'Chargement de Canari.',
    path: '/app-shell',
    noindex: true,
  };
  return { seo };
};
