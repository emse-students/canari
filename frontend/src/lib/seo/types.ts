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
}
