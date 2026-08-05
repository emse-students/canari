import { formatDocumentTitle } from '$lib/seo/resolve';
import { SITE, siteAssetUrl, siteOrigin } from '$lib/seo/site';
import type { SeoMeta } from '$lib/seo/types';

/**
 * Escapes a value for use inside a double-quoted HTML attribute.
 *
 * Load-bearing: the strings interpolated here are post text, association names and community
 * names - user-supplied, arriving from the API into the app shell of every visitor. `"` alone
 * would be enough to break out of the attribute, and `<` to break out of the tag, so both are
 * escaped along with `&` (first, or it would double-encode the entities added after it), `'` and
 * `` ` `` (some attribute parsers accept them as delimiters).
 */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

/** `<meta property="..." content="...">`, or '' when the value is empty. */
function metaProperty(property: string, content: string | undefined | null): string {
  if (!content) return '';
  return `<meta property="${property}" content="${escapeHtmlAttribute(content)}" data-canari-seo />`;
}

/** `<meta name="..." content="...">`, or '' when the value is empty. */
function metaName(name: string, content: string | undefined | null): string {
  if (!content) return '';
  return `<meta name="${name}" content="${escapeHtmlAttribute(content)}" data-canari-seo />`;
}

/** Absolute URL for an OG image path, leaving an already-absolute one alone. */
export function absoluteImageUrl(image: string | undefined | null): string {
  if (!image) return siteAssetUrl(SITE.defaultOgImagePath);
  return image.startsWith('http') ? image : siteAssetUrl(image);
}

/**
 * Renders the head block injected into the shell by `hooks.server.ts`.
 *
 * Emits the same tag set `SeoHead.svelte` produces on hydration - deliberately, so the two can be
 * compared line by line - with two differences that only make sense server-side:
 *
 * - every tag carries `data-canari-seo`, which is how the client removes this block before adding
 *   its own and the document does not end up with two of each;
 * - `og:image:width`/`height` are emitted only for the default site image. Those numbers are
 *   `SITE.defaultOgImage*`, and an entity's own logo has dimensions nobody here knows - declaring
 *   1080x1080 for a 200x200 logo makes the unfurler reserve a box the image never fills.
 */
export function renderSeoTags(meta: SeoMeta, pathname: string): string {
  const documentTitle = formatDocumentTitle(meta.title);
  const canonicalPath = meta.path ?? pathname;
  const canonicalUrl = `${siteOrigin()}${canonicalPath.startsWith('/') ? canonicalPath : `/${canonicalPath}`}`;
  const image = absoluteImageUrl(meta.image);
  const isDefaultImage = image === siteAssetUrl(SITE.defaultOgImagePath);

  return [
    metaName('description', meta.description),
    metaName('robots', meta.noindex ? 'noindex, nofollow' : 'index, follow'),
    `<link rel="canonical" href="${escapeHtmlAttribute(canonicalUrl)}" data-canari-seo />`,
    metaProperty('og:site_name', SITE.name),
    metaProperty('og:locale', SITE.locale),
    metaProperty('og:type', meta.ogType ?? SITE.defaultOgType),
    metaProperty('og:title', documentTitle),
    metaProperty('og:description', meta.description),
    metaProperty('og:url', canonicalUrl),
    metaProperty('og:image', image),
    isDefaultImage ? metaProperty('og:image:width', String(SITE.defaultOgImageWidth)) : '',
    isDefaultImage ? metaProperty('og:image:height', String(SITE.defaultOgImageHeight)) : '',
    isDefaultImage ? metaProperty('og:image:alt', SITE.defaultOgImageAlt) : '',
    metaName('twitter:card', 'summary_large_image'),
    metaName('twitter:title', documentTitle),
    metaName('twitter:description', meta.description),
    metaName('twitter:image', image),
  ]
    .filter(Boolean)
    .join('\n    ');
}

/** The `<title>` element the injection substitutes for the shell's static one. */
export function renderSeoTitle(meta: SeoMeta): string {
  return `<title>${escapeHtmlAttribute(formatDocumentTitle(meta.title))}</title>`;
}
