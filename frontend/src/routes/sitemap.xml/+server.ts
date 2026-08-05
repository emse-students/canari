import { SOCIAL_URL, fetchJson } from '$lib/seo/internalApi';
import {
  PUBLIC_SITEMAP_ENTRIES,
  SITEMAP_MAX_ASSOCIATIONS,
  SITEMAP_MAX_POSTS,
  type SitemapEntry,
  buildSitemapXml,
  toLastmod,
} from '$lib/seo/sitemap';
import { siteOrigin } from '$lib/seo/site';
import type { RequestHandler } from './$types';

/**
 * The sitemap is the only link graph this site has.
 *
 * It is built per request rather than prerendered because a static list of eight paths tells a
 * crawler nothing about the content: every association page and every post lives behind a path a
 * crawler can only learn from here. Nothing links to them in served HTML - the app is a SPA, so
 * its internal links exist only after JavaScript has run against an authenticated session, which
 * no crawler has.
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

interface PostRow {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
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

/**
 * Recent ASSOCIATION posts, newest first.
 *
 * `feed=associations`, not `feed=all`, and the distinction is deliberate. Both are readable
 * without a session and both already exclude scheduled and moderation-hidden rows, so either would
 * be safe to serve - but submitting a URL to a search engine is not the same act as not blocking
 * it. An association's post is a communication its authors want found; a student's personal post
 * on the school feed is not something to go and put in front of a search engine on their behalf.
 */
async function postEntries(): Promise<SitemapEntry[]> {
  const rows = await fetchJson<PostRow[]>(
    `${SOCIAL_URL()}/api/posts?feed=associations&limit=${SITEMAP_MAX_POSTS}&offset=0`,
    {},
    SITEMAP_FETCH_TIMEOUT_MS
  );
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((row) => row.id)
    .map((row) => ({
      path: `/posts/${row.id}`,
      lastmod: toLastmod(row.updatedAt ?? row.createdAt),
      changefreq: 'monthly' as const,
      priority: 0.6,
    }));
}

export const GET: RequestHandler = async () => {
  // Both halves in parallel, and both allowed to come back empty: a sitemap missing its posts is
  // worth serving, a 500 is not.
  const [associations, posts] = await Promise.all([associationEntries(), postEntries()]);
  const entries = [...PUBLIC_SITEMAP_ENTRIES, ...associations, ...posts];

  console.log(
    `[SEO] sitemap: ${PUBLIC_SITEMAP_ENTRIES.length} static + ${associations.length} associations + ${posts.length} posts`
  );

  return new Response(buildSitemapXml(siteOrigin(), entries), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
    },
  });
};
