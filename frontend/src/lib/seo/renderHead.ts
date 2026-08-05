import { renderJsonLdScript, serializeJsonLd } from '$lib/seo/jsonLd';
import { formatDocumentTitle } from '$lib/seo/resolve';
import { SITE, siteAssetUrl, siteOrigin } from '$lib/seo/site';
import type { SeoMeta } from '$lib/seo/types';

/** Id of the payload the client reads back to keep the head it was served. */
export const SEO_DATA_ELEMENT_ID = 'canari-seo-data';

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
 *
 * The last element is not a tag at all: it is the resolved metadata as JSON, which the client
 * reads back in `SeoHead.svelte`. Without it, hydration REPLACES this head with what the browser
 * can work out on its own - which for `/associations/bde` is the slug and a generic sentence. An
 * unfurler never gets that far, but Googlebot does render the page, and it would index the
 * downgrade rather than what was served.
 */
export function renderSeoTags(meta: SeoMeta, pathname: string): string {
  const documentTitle = formatDocumentTitle(meta.title);
  const canonicalPath = meta.path ?? pathname;
  const canonicalUrl = `${siteOrigin()}${canonicalPath.startsWith('/') ? canonicalPath : `/${canonicalPath}`}`;
  const image = absoluteImageUrl(meta.image);
  const isDefaultImage = image === siteAssetUrl(SITE.defaultOgImagePath);
  const imageAlt = isDefaultImage ? SITE.defaultOgImageAlt : meta.imageAlt;
  const isArticle = (meta.ogType ?? SITE.defaultOgType) === 'article';

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
    metaProperty('og:image:alt', imageAlt),
    isArticle ? metaProperty('article:published_time', meta.publishedAt) : '',
    isArticle ? metaProperty('article:author', meta.authorName) : '',
    metaName('twitter:card', 'summary_large_image'),
    metaName('twitter:title', documentTitle),
    metaName('twitter:description', meta.description),
    metaName('twitter:image', image),
    metaName('twitter:image:alt', imageAlt),
    renderJsonLdScript(meta.jsonLd ?? [], ' data-canari-seo'),
    renderSeoDataScript(meta, pathname),
  ]
    .filter(Boolean)
    .join('\n    ');
}

/**
 * The resolved metadata, for the client to adopt instead of re-deriving a weaker version.
 *
 * Carries the REQUESTED pathname - not the canonical one, which can differ (`/` canonicalises to
 * `/posts`) - because that is what the client compares against `page.url.pathname`. After one
 * client-side navigation the payload describes a page the user has left, and adopting it there
 * would pin the first page's title to every subsequent one.
 */
function renderSeoDataScript(meta: SeoMeta, pathname: string): string {
  const payload = serializeJsonLd({ path: pathname, meta });
  return `<script type="application/json" id="${SEO_DATA_ELEMENT_ID}" data-canari-seo>${payload}</script>`;
}

/** The `<title>` element the injection substitutes for the shell's static one. */
export function renderSeoTitle(meta: SeoMeta): string {
  return `<title>${escapeHtmlAttribute(formatDocumentTitle(meta.title))}</title>`;
}
