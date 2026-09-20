import type { JsonLdNode } from '$lib/seo/jsonLd';

/** SEO metadata consumed by `SeoHead` and route `load` functions. */
export interface SeoMeta {
  /** Document title (suffix " - Canari" added when missing). */
  title: string;
  /** Meta description (plain text, ≤ ~160 chars recommended). */
  description: string;
  /** Canonical pathname (e.g. `/posts`). Defaults to current path. */
  path?: string;
  /** Open Graph type. */
  ogType?: 'website' | 'article';
  /** When true, emits `noindex, nofollow` for private or auth-only screens. */
  noindex?: boolean;
  /** Absolute or site-relative OG/Twitter image URL. */
  image?: string;
  /** Describes `image` for screen readers and for the alt text an unfurler shows. */
  imageAlt?: string;
  /**
   * Pixel dimensions of `image`, when the enricher genuinely knows them.
   *
   * Declared only where they are a fact - a post's own photo, whose size is stored beside it - and
   * never guessed. An unfurler reserves the box these describe before the bytes arrive, so a wrong
   * pair is worse than none: the card renders a gap the image never fills. It is also what lets
   * `twitter:card: summary_large_image` render large rather than silently degrading to a thumbnail.
   */
  imageWidth?: number;
  imageHeight?: number;
  /** ISO 8601 publication date, emitted as `article:published_time` for `ogType: 'article'`. */
  publishedAt?: string;
  /** Display name credited as the author of an article. */
  authorName?: string;
  /**
   * schema.org nodes for this page, rendered into one `application/ld+json` script.
   *
   * Structured data is the only route by which the real content of a page reaches a search engine
   * here: the app is a SPA behind a login, so a crawler that renders the page sees the sign-in
   * screen and nothing else. What is described here is what can be indexed.
   */
  jsonLd?: JsonLdNode[];
}
