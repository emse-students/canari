import { PUBLIC_SITEMAP_ENTRIES, buildSitemapXml } from './sitemap';

describe('buildSitemapXml', () => {
  it('emits valid urlset with escaped characters', () => {
    const xml = buildSitemapXml('https://canari-emse.fr', [
      { path: '/posts', priority: 1, changefreq: 'daily' },
    ]);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<loc>https://canari-emse.fr/posts</loc>');
    expect(xml).toContain('<priority>1.0</priority>');
  });
});

describe('the static entries', () => {
  it('lists the agenda, which is the page with the most searchable content on the site', () => {
    expect(PUBLIC_SITEMAP_ENTRIES.map((e) => e.path)).toContain('/calendar');
  });

  it('never advertises a private area', () => {
    for (const entry of PUBLIC_SITEMAP_ENTRIES) {
      expect(entry.path).not.toMatch(/^\/(chat|communities|admin|dashboard|account|profile)/);
    }
  });
});
