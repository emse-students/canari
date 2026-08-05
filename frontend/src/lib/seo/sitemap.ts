/** Single URL entry for `sitemap.xml`. */
export interface SitemapEntry {
  path: string;
  /** ISO 8601 date (YYYY-MM-DD). */
  lastmod?: string;
  changefreq?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  priority?: number;
}

/**
 * The routes that exist whether or not anything is published on them.
 *
 * Everything else in the sitemap is discovered at request time (`routes/sitemap.xml/+server.ts`),
 * because there is no other way for a crawler to find it: the app is a SPA, so the pages it links
 * to exist only after JavaScript has run and a session has been established. A crawler follows no
 * link on this site - the sitemap IS the link graph.
 */
export const PUBLIC_SITEMAP_ENTRIES: SitemapEntry[] = [
  { path: '/posts', changefreq: 'daily', priority: 1 },
  { path: '/associations', changefreq: 'weekly', priority: 0.9 },
  { path: '/calendar', changefreq: 'daily', priority: 0.8 },
  { path: '/forms', changefreq: 'weekly', priority: 0.6 },
  { path: '/shop', changefreq: 'weekly', priority: 0.5 },
  { path: '/legal/cgu', changefreq: 'yearly', priority: 0.3 },
  { path: '/legal/privacy', changefreq: 'yearly', priority: 0.3 },
  { path: '/legal/child-safety', changefreq: 'yearly', priority: 0.3 },
];

/** Sitemaps cap at 50 000 URLs; these ceilings keep the document far below it and cheap to build. */
export const SITEMAP_MAX_POSTS = 500;
export const SITEMAP_MAX_ASSOCIATIONS = 300;

/** Builds a valid sitemap XML document. */
export function buildSitemapXml(origin: string, entries: SitemapEntry[]): string {
  const base = origin.replace(/\/$/, '');
  const today = new Date().toISOString().slice(0, 10);
  const urls = entries
    .map((e) => {
      const loc = `${base}${e.path.startsWith('/') ? e.path : `/${e.path}`}`;
      const lastmod = e.lastmod ?? today;
      const changefreq = e.changefreq ? `\n    <changefreq>${e.changefreq}</changefreq>` : '';
      const priority =
        e.priority !== undefined ? `\n    <priority>${e.priority.toFixed(1)}</priority>` : '';
      return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>${changefreq}${priority}\n  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** `YYYY-MM-DD` for a sitemap `lastmod`, or undefined when the input is not a usable date. */
export function toLastmod(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
