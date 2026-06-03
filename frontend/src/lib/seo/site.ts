import { DEFAULT_PUBLIC_APP_ORIGIN } from '$lib/utils/publicAppUrl';

/** Public site branding and default copy for search / social previews. */
export const SITE = {
  name: 'Canari',
  shortName: 'Canari',
  locale: 'fr_FR',
  language: 'fr',
  tagline: 'Fil social et messagerie sécurisée pour l’EMSE',
  defaultDescription:
    'Canari réunit le fil social de l’école, les associations, l’agenda et une messagerie chiffrée de bout en bout (MLS) pour la communauté EMSE.',
  defaultOgType: 'website' as const,
  /** Open Graph / Twitter preview (`frontend/static/og-canari.png`, source: `src-tauri/icons/Canari.png`). */
  defaultOgImagePath: '/og-canari.png',
  defaultOgImageWidth: 1080,
  defaultOgImageHeight: 1080,
  defaultOgImageAlt:
    'Logo Canari : canari stylisé jaune, bec ouvert, sur un carré bleu marine aux coins arrondis.',
} as const;

/** Absolute site origin for canonical URLs and sitemaps (build-time / SSR). */
export function siteOrigin(): string {
  const fromEnv = (import.meta.env.VITE_FRONTEND_URL as string | undefined)?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return DEFAULT_PUBLIC_APP_ORIGIN;
}

/** Absolute URL for a static asset under the site root. */
export function siteAssetUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${siteOrigin()}${normalized}`;
}
