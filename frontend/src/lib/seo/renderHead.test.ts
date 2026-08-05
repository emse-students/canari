import { readFileSync } from 'node:fs';
import { escapeHtmlAttribute, renderSeoTags, renderSeoTitle } from './renderHead';
import type { SeoMeta } from './types';

const base: SeoMeta = { title: 'Titre', description: 'Description', path: '/posts/abc' };

describe('escapeHtmlAttribute', () => {
  it('neutralizes every character that can leave a quoted attribute', () => {
    expect(escapeHtmlAttribute(`"><script>alert(1)</script>`)).toBe(
      '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'
    );
    expect(escapeHtmlAttribute("it's")).toBe('it&#39;s');
    expect(escapeHtmlAttribute('a`b')).toBe('a&#96;b');
  });

  it('escapes the ampersand first, so entities are not double-encoded', () => {
    expect(escapeHtmlAttribute('a & "b"')).toBe('a &amp; &quot;b&quot;');
  });
});

describe('renderSeoTags', () => {
  it('never lets post text break out of an attribute', () => {
    // The realistic attack: a post whose first words close the tag and open a script.
    const html = renderSeoTags(
      { ...base, title: '"><script>fetch("//evil")</script>', description: 'x' },
      '/posts/abc'
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('marks every tag so the client can remove the block on hydration', () => {
    const tags = renderSeoTags(base, '/posts/abc').split('\n');
    expect(tags.length).toBeGreaterThan(5);
    for (const tag of tags) expect(tag).toContain('data-canari-seo');
  });

  it('declares image dimensions only for the default site image', () => {
    expect(renderSeoTags(base, '/posts/abc')).toContain('og:image:width');
    // An entity logo has dimensions this process does not know.
    const withLogo = renderSeoTags(
      { ...base, image: 'https://canari-emse.fr/api/media/public/abc' },
      '/posts/abc'
    );
    expect(withLogo).not.toContain('og:image:width');
    expect(withLogo).toContain('og:image');
  });

  it('canonicalizes to the meta path, falling back to the pathname', () => {
    expect(renderSeoTags(base, '/ignored')).toContain('/posts/abc" data-canari-seo');
    expect(renderSeoTags({ title: 'T', description: 'D' }, '/shop')).toContain('/shop');
  });

  it('emits noindex when the path is private', () => {
    expect(renderSeoTags({ ...base, noindex: true }, '/chat')).toContain('noindex, nofollow');
    expect(renderSeoTags(base, '/posts/abc')).toContain('index, follow');
  });
});

describe('the app.html contract', () => {
  // hooks.server.ts substitutes two literals. Renaming either turns the injection into a silent
  // no-op: the build still succeeds, the server still answers, and every preview goes generic.
  const appHtml = readFileSync('src/app.html', 'utf-8');

  it('still carries the marker the head block replaces', () => {
    expect(appHtml).toContain('<!--canari-seo-->');
  });

  it('still carries the static title the rendered title replaces', () => {
    expect(appHtml).toContain('<title>Canari</title>');
    expect(renderSeoTitle(base)).toBe('<title>Titre - Canari</title>');
  });
});
