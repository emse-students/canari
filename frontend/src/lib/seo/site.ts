import { DEFAULT_PUBLIC_APP_ORIGIN } from '$lib/utils/publicAppUrl';

/** Public site branding and default copy for search / social previews. */
export const SITE = {
  name: 'Canari',
  shortName: 'Canari',
  /**
   * The name people actually type. "Canari" alone competes with the bird for every query, so the
   * school is what has to travel with it - in `WebSite.alternateName`, in the default title and in
   * the description. Nothing else on the site can win that word on its own.
   */
  alternateName: 'Canari EMSE',
  /**
   * The title of the home page and of anything with nothing more specific to say. It is NOT
   * `name`: a `<title>` of one word that also names a bird disambiguates nothing, and the home
   * page is the one whose title matters most. The school travels with it, here as everywhere else.
   */
  defaultTitle: 'Canari - Mines Saint-Étienne',
  locale: 'fr_FR',
  language: 'fr',
  /**
   * The school the whole site belongs to, named identically everywhere schema.org asks for it.
   * Accented because these are the establishment's real names, displayed to people through search
   * results - the same exception the tagline and the default description below take.
   */
  institutionName: 'Mines Saint-Étienne',
  institutionLegalName: 'École nationale supérieure des mines de Saint-Étienne',
  institutionUrl: 'https://www.mines-stetienne.fr',
  institutionStreet: '158 cours Fauriel',
  institutionPostalCode: '42023',
  institutionCity: 'Saint-Étienne',
  tagline: "Fil social et messagerie sécurisée pour l'EMSE",
  defaultDescription:
    "Canari réunit le fil social de l'école, les associations, l'agenda et une messagerie chiffrée de bout en bout (MLS) pour la communauté EMSE.",
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
