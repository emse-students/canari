import { SOCIAL_URL, fetchJson } from '$lib/seo/internalApi';
import {
  PUBLIC_SITEMAP_ENTRIES,
  SITEMAP_MAX_ASSOCIATIONS,
  type SitemapEntry,
  buildSitemapXml,
} from '$lib/seo/sitemap';
import { siteOrigin } from '$lib/seo/site';
import type { RequestHandler } from './$types';

/**
 * The sitemap is the only link graph this site has.
 *
 * It is built per request rather than prerendered because a static list of eight paths tells a
 * crawler nothing about the content: every association page lives behind a path a crawler can only
 * learn from here. Nothing links to them in served HTML - the app is a SPA, so its internal links
 * exist only after JavaScript has run against an authenticated session, which no crawler has.
 *
 * NO POSTS, SINCE 2026-11-02 (owner). The sitemap used to list the 500 newest association posts,
 * read from an anonymous listing route; that listing was a feed handed to anybody, and the owner
 * closed it - without an account Canari shows nothing the public showcase does not, and a single
 * shared post's link preview is the one exception he kept. A post is still previewed when its link
 * is shared; it is no longer advertised. See docs/wiki/anonymous-surface.md.
 *
 * Only the WEB build has a server to run this; the Tauri build ships without a sitemap, which is
 * what it wants.
 */
export const prerender = false;

/** The generated document is cheap but not free, and a crawler re-reads it often. */
const CACHE_SECONDS = 3600;

/** Longer than an enrichment budget: nothing is waiting on this, and a short sitemap is a loss. */
const SITEMAP_FETCH_TIMEOUT_MS = 5000;

interface PublicAssociationRow {
  slug?: string;
  archived?: boolean;
}

/**
 * Association pages, read through the PUBLIC projection - the same one the head injector uses.
 *
 * Archived associations are dropped: the page still resolves, but pointing a crawler at a body
 * that no longer runs is how a site accumulates results nobody wants to land on.
 */
async function associationEntries(): Promise<SitemapEntry[]> {
  const rows = await fetchJson<PublicAssociationRow[]>(
    `${SOCIAL_URL()}/api/public/associations`,
    {},
    SITEMAP_FETCH_TIMEOUT_MS
  );
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((row) => row.slug?.trim() && !row.archived)
    .slice(0, SITEMAP_MAX_ASSOCIATIONS)
    .map((row) => ({
      path: `/associations/${encodeURIComponent(row.slug!.trim())}`,
      changefreq: 'weekly' as const,
      priority: 0.8,
    }));
}

export const GET: RequestHandler = async () => {
  // Allowed to come back empty: a sitemap missing its associations is worth serving, a 500 is not.
  const associations = await associationEntries();
  const entries = [...PUBLIC_SITEMAP_ENTRIES, ...associations];

  console.log(
    `[SEO] sitemap: ${PUBLIC_SITEMAP_ENTRIES.length} static + ${associations.length} associations`
  );

  return new Response(buildSitemapXml(siteOrigin(), entries), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
    },
  });
};
