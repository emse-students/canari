/** Single URL entry for `sitemap.xml`. */
export interface SitemapEntry {
  path: string;
  /** ISO 8601 date (YYYY-MM-DD). */
  lastmod?: string;
  changefreq?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  priority?: number;
}

/** Public indexable routes (dynamic post/form URLs are discovered via internal links). */
export const PUBLIC_SITEMAP_ENTRIES: SitemapEntry[] = [
  { path: '/posts', changefreq: 'daily', priority: 1 },
  { path: '/associations', changefreq: 'weekly', priority: 0.9 },
  { path: '/calendar', changefreq: 'weekly', priority: 0.7 },
  { path: '/forms', changefreq: 'weekly', priority: 0.6 },
  { path: '/shop', changefreq: 'weekly', priority: 0.5 },
  { path: '/legal/cgu', changefreq: 'yearly', priority: 0.3 },
  { path: '/legal/privacy', changefreq: 'yearly', priority: 0.3 },
  { path: '/legal/child-safety', changefreq: 'yearly', priority: 0.3 },
];

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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
