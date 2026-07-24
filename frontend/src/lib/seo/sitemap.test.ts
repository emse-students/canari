import { buildSitemapXml } from './sitemap';

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
