import { readFileSync } from 'node:fs';
import { escapeHtmlAttribute, renderSeoTags, renderSeoTitle } from './renderHead';
import { SITE } from './site';
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
    // A META TAG AND NOT A COMMENT SINCE 2026-09-02. The marker used to be `<!--canari-seo-->`,
    // which Svelte's hydration counts as a node the client render does not have - one unreadable
    // `hydration_mismatch` warning per page load. This literal has to match `SEO_MARKER` in
    // `hooks.server.ts` exactly, or the substitution becomes a silent no-op: the build still
    // succeeds, the server still answers, and every preview goes generic.
    expect(appHtml).toContain('<meta name="canari-seo-placeholder" data-canari-seo />');
  });

  it('still carries the static title the rendered title replaces', () => {
    // Pinned against SITE.defaultTitle rather than a copy of the string: hooks.server.ts builds
    // the marker from it, so a change on one side has to be made on the other or this fails.
    expect(appHtml).toContain(`<title>${SITE.defaultTitle}</title>`);
    expect(renderSeoTitle(base)).toBe('<title>Titre - Canari</title>');
  });

  it('names the school in the fallback title, which is what an outage indexes', () => {
    // The @app_shell fallback and the Tauri shell both ship app.html unsubstituted, and nginx now
    // answers the former with 200 - so this title is indexable. "Canari" alone is a bird.
    expect(SITE.defaultTitle).toContain(SITE.institutionName);
  });
});

describe('renderSeoTags structured data and the client payload', () => {
  it('renders the JSON-LD nodes it is given, inside one script element', () => {
    const html = renderSeoTags(
      { ...base, jsonLd: [{ '@type': 'Article', headline: 'Titre' }] },
      '/posts/abc'
    );

    expect(html).toContain('<script type="application/ld+json" data-canari-seo>');
    expect(html).toContain('"@context":"https://schema.org"');
    expect(html).toContain('"@type":"Article"');
  });

  it('omits the JSON-LD element entirely when there are no nodes', () => {
    expect(renderSeoTags(base, '/posts/abc')).not.toContain('application/ld+json');
  });

  it('cannot be closed early by entity text', () => {
    // The attack the escaping exists for: a post title that ends the script element and opens
    // markup of its own. JSON.stringify alone leaves `</script>` intact.
    const html = renderSeoTags(
      { ...base, jsonLd: [{ '@type': 'Article', headline: '</script><img onerror=alert(1)>' }] },
      '/posts/abc'
    );

    expect(html).not.toContain('</script><img');
    expect(html).toContain('\u003c/script');
  });

  it('carries the resolved metadata for the client to adopt, keyed by the REQUESTED path', () => {
    // `/` canonicalises to `/posts`, so keying the payload on the canonical path would stop the
    // client ever recognising it - it compares against `page.url.pathname`.
    const html = renderSeoTags({ ...base, title: 'Le BDE', path: '/posts' }, '/associations/bde');

    expect(html).toContain('id="canari-seo-data"');
    const payload = html.match(/id="canari-seo-data" data-canari-seo>(.*?)<\/script>/)?.[1];
    expect(payload).toBeDefined();
    const parsed = JSON.parse(payload!.replace(/\u003c/g, '<').replace(/\u0026/g, '&')) as {
      path: string;
      meta: SeoMeta;
    };
    expect(parsed.path).toBe('/associations/bde');
    expect(parsed.meta.title).toBe('Le BDE');
  });

  it('emits the article dates only for an article', () => {
    const article = renderSeoTags(
      { ...base, ogType: 'article', publishedAt: '2026-08-05T10:00:00.000Z', authorName: 'BDE' },
      '/posts/abc'
    );
    expect(article).toContain('article:published_time');
    expect(article).toContain('article:author');

    const page = renderSeoTags({ ...base, publishedAt: '2026-08-05T10:00:00.000Z' }, '/shop');
    expect(page).not.toContain('article:published_time');
  });

  it('describes an entity image only when told what it shows', () => {
    const entity = { ...base, image: 'https://canari-emse.fr/api/media/public/abc' };
    expect(renderSeoTags(entity, '/posts/abc')).not.toContain('og:image:alt');
    expect(renderSeoTags({ ...entity, imageAlt: 'Logo BDE' }, '/posts/abc')).toContain('Logo BDE');
    // The default image is the one whose alt text is known.
    expect(renderSeoTags(base, '/posts/abc')).toContain('og:image:alt');
  });
});
