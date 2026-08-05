<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { injectedSeoForPath } from '$lib/seo/injectedSeo';
  import { buildSiteJsonLd, renderJsonLdScript } from '$lib/seo/jsonLd';
  import { formatDocumentTitle, mergeSeo, resolveSeoForPath } from '$lib/seo/resolve';
  import { SITE, siteAssetUrl, siteOrigin } from '$lib/seo/site';
  import type { SeoMeta } from '$lib/seo/types';

  interface Props {
    /** Optional override (usually from `PageData.seo`). */
    seo?: Partial<SeoMeta> | null;
  }

  let { seo: seoOverride = null }: Props = $props();

  const pathname = $derived(page.url.pathname);
  /**
   * Precedence, weakest first: what the path alone implies, then the route's own `load`, then what
   * the server resolved for the page this document was served as.
   *
   * The server wins deliberately. A route `load` runs in the browser with no access to the
   * services, so `/associations/[slug]` can only offer the slug and a generic sentence, while the
   * injected payload carries the association's real name, its description and its structured data
   * (see `injectedSeo.ts`). It exists only for the first page of the document and only when the
   * paths match, so nothing later is affected by it.
   */
  const resolved = $derived(
    mergeSeo(
      mergeSeo(
        resolveSeoForPath(pathname),
        seoOverride ?? (page.data?.seo as Partial<SeoMeta> | undefined)
      ),
      injectedSeoForPath(pathname)
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
  /**
   * The declared dimensions and the alt text describe the SITE image and nothing else. An entity's
   * own logo has dimensions nobody here knows, and `defaultOgImageAlt` describes the Canari bird -
   * printing either over an association's logo is a wrong answer, where none is a correct one.
   */
  const isDefaultOgImage = $derived(ogImage === siteAssetUrl(SITE.defaultOgImagePath));
  const ogImageAlt = $derived(isDefaultOgImage ? SITE.defaultOgImageAlt : resolved.imageAlt);
  const robotsContent = $derived(resolved.noindex ? 'noindex, nofollow' : 'index, follow');
  const ogType = $derived(resolved.ogType ?? SITE.defaultOgType);
  /**
   * The server's nodes when it resolved any, else the site-level pair on the two entry pages.
   * Re-emitted rather than left in place because the block below replaces the whole injected head:
   * a crawler that renders must end up with the structured data, not without it.
   */
  const jsonLdNodes = $derived(
    resolved.jsonLd?.length
      ? resolved.jsonLd
      : pathname === '/posts' || pathname === '/'
        ? buildSiteJsonLd()
        : []
  );
  const jsonLdScript = $derived(renderJsonLdScript(jsonLdNodes));

  /**
   * Drops the head block the web server wrote into the shell (`hooks.server.ts`), which is about
   * to be superseded by the `<svelte:head>` below. Without this the document carries two of every
   * og/twitter tag - harmless to an unfurler, which never gets this far, but the kind of thing
   * that makes a later "why are there two og:title" investigation expensive. It applies to the
   * Tauri build as well, whose shell carries the generic block baked in at prerender time.
   */
  onMount(() => {
    for (const node of document.head.querySelectorAll('[data-canari-seo]')) node.remove();
  });
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
  {#if isDefaultOgImage}
    <meta property="og:image:width" content={String(SITE.defaultOgImageWidth)} />
    <meta property="og:image:height" content={String(SITE.defaultOgImageHeight)} />
  {/if}
  {#if ogImageAlt}
    <meta property="og:image:alt" content={ogImageAlt} />
  {/if}
  {#if ogType === 'article' && resolved.publishedAt}
    <meta property="article:published_time" content={resolved.publishedAt} />
  {/if}
  {#if ogType === 'article' && resolved.authorName}
    <meta property="article:author" content={resolved.authorName} />
  {/if}

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={documentTitle} />
  <meta name="twitter:description" content={resolved.description} />
  <meta name="twitter:image" content={ogImage} />
  {#if ogImageAlt}
    <meta name="twitter:image:alt" content={ogImageAlt} />
  {/if}

  {#if jsonLdScript}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- serializeJsonLd escapes `<` and `&`, so entity text cannot close the script element -->
    {@html jsonLdScript}
  {/if}
</svelte:head>
