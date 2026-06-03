import { PUBLIC_SITEMAP_ENTRIES, buildSitemapXml } from '$lib/seo/sitemap';
import { siteOrigin } from '$lib/seo/site';
import type { RequestHandler } from './$types';

/** Prerendered XML sitemap for search engines. */
export const prerender = true;

export const GET: RequestHandler = () => {
  const xml = buildSitemapXml(siteOrigin(), PUBLIC_SITEMAP_ENTRIES);
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
};
