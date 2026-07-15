import { SITE, siteOrigin } from '$lib/seo/site';

/** Organization + WebSite JSON-LD for rich results on the home feed. */
export function buildSiteJsonLd(): string {
  const origin = siteOrigin();
  const payload = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        name: SITE.name,
        url: origin,
        description: SITE.defaultDescription,
        logo: `${origin}${SITE.defaultOgImagePath}`,
      },
      {
        '@type': 'WebSite',
        name: SITE.name,
        url: origin,
        description: SITE.defaultDescription,
        inLanguage: SITE.language,
        publisher: { '@type': 'Organization', name: SITE.name },
      },
    ],
  };
  return JSON.stringify(payload);
}

/** Full JSON-LD script element for injection via `{@html}` in `<svelte:head>`. */
export function buildSiteJsonLdScriptTag(): string {
  return '<script type="application/ld+json">' + buildSiteJsonLd() + '</script>';
}
