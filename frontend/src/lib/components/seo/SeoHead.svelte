<script lang="ts">
  import { page } from '$app/state';
  import { buildSiteJsonLdScriptTag } from '$lib/seo/jsonLd';
  import { formatDocumentTitle, mergeSeo, resolveSeoForPath } from '$lib/seo/resolve';
  import { SITE, siteAssetUrl, siteOrigin } from '$lib/seo/site';
  import type { SeoMeta } from '$lib/seo/types';

  interface Props {
    /** Optional override (usually from `PageData.seo`). */
    seo?: Partial<SeoMeta> | null;
  }

  let { seo: seoOverride = null }: Props = $props();

  const pathname = $derived(page.url.pathname);
  const resolved = $derived(
    mergeSeo(
      resolveSeoForPath(pathname),
      seoOverride ?? (page.data?.seo as Partial<SeoMeta> | undefined)
    )
  );

  const documentTitle = $derived(formatDocumentTitle(resolved.title));
  const canonicalPath = $derived(resolved.path ?? pathname);
  const canonicalUrl = $derived(
    `${siteOrigin()}${canonicalPath.startsWith('/') ? canonicalPath : `/${canonicalPath}`}`
  );
  const ogImage = $derived(
    resolved.image?.startsWith('http')
      ? resolved.image
      : siteAssetUrl(resolved.image ?? SITE.defaultOgImagePath)
  );
  const robotsContent = $derived(resolved.noindex ? 'noindex, nofollow' : 'index, follow');
  const ogType = $derived(resolved.ogType ?? SITE.defaultOgType);
  const showSiteJsonLd = $derived(pathname === '/posts' || pathname === '/');
  const jsonLdScript = $derived(showSiteJsonLd ? buildSiteJsonLdScriptTag() : '');
</script>

<svelte:head>
  <title>{documentTitle}</title>
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"
  />
  <meta name="description" content={resolved.description} />
  <meta name="robots" content={robotsContent} />
  <link rel="canonical" href={canonicalUrl} />

  <meta property="og:site_name" content={SITE.name} />
  <meta property="og:locale" content={SITE.locale} />
  <meta property="og:type" content={ogType} />
  <meta property="og:title" content={documentTitle} />
  <meta property="og:description" content={resolved.description} />
  <meta property="og:url" content={canonicalUrl} />
  <meta property="og:image" content={ogImage} />
  <meta property="og:image:width" content={String(SITE.defaultOgImageWidth)} />
  <meta property="og:image:height" content={String(SITE.defaultOgImageHeight)} />
  <meta property="og:image:alt" content={SITE.defaultOgImageAlt} />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={documentTitle} />
  <meta name="twitter:description" content={resolved.description} />
  <meta name="twitter:image" content={ogImage} />
  <meta name="twitter:image:alt" content={SITE.defaultOgImageAlt} />

  {#if showSiteJsonLd}
    <!-- JSON-LD script tag; payload is built in-app via JSON.stringify, never user-supplied -->
    {@html jsonLdScript}
  {/if}
</svelte:head>
