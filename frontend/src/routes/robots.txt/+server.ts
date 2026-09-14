import { PRIVATE_PREFIXES } from '$lib/seo/resolve';
import { siteOrigin } from '$lib/seo/site';
import type { RequestHandler } from './$types';

/** Prerendered for static hosting (nginx serves `/robots.txt`). */
export const prerender = true;

/**
 * Crawler rules for the public Canari web app.
 *
 * THE DISALLOW LIST IS NOT WRITTEN HERE. It is `PRIVATE_PREFIXES`, the same list that decides
 * whether a page emits `noindex` - a page cannot be private to one and public to the other. This
 * file held a second copy until 2026-09-14 and the two had drifted: `/profile/` and `/admin/` were
 * spelled with a trailing slash, which leaves `/profile` and `/admin` themselves crawlable, and
 * neither list had heard of `/directory`, the student directory.
 *
 * `/api/` is the one line that is still written here, because it is not a page: no route resolves
 * SEO for it, so it has no business in a list about pages.
 */
export const GET: RequestHandler = () => {
  const origin = siteOrigin();
  const disallow = [...PRIVATE_PREFIXES]
    .sort()
    .map((prefix) => `Disallow: ${prefix}`)
    .join('\n');
  const body = `# Canari - https://canari-emse.fr
User-agent: *
Allow: /posts
Allow: /associations
Allow: /calendar
Allow: /shop
Allow: /forms/
Allow: /legal/
Disallow: /api/
${disallow}

Sitemap: ${origin}/sitemap.xml
`;

  return new Response(body.trim() + '\n', {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
};
