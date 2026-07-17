import { m } from '$lib/paraglide/messages';

/**
 * Visual preset for the "Carte de la Vie Asso" poster. A theme controls only the chrome
 * (page background, headings, polaroid + directory colors); the association bubbles keep
 * their own brand colors so the map stays recognisable across themes. The uploaded
 * background image is independent of the theme (a user can compose any theme + their photo),
 * mirroring the calendar-export theme model.
 */
export interface CarteTheme {
  /** Stable id used for selection state and persisted in the project layout. */
  id: string;
  /** Localized display name (function so it re-resolves on locale change). */
  name: () => string;
  /** Page background color, painted under an optional background image. */
  pageBg: string;
  /** Overlay color drawn over the background image to keep text legible. */
  scrimColor: string;
  /** Default scrim opacity (0-100) applied when a background image is set. */
  scrimOpacity: number;
  /** Poster title color. */
  titleColor: string;
  /** Category zone heading color. */
  zoneHeadingColor: string;
  /** Association name text under each bubble. */
  bubbleNameColor: string;
  /** Polaroid card background (president photo frame). */
  polaroidBg: string;
  /** Polaroid caption text color. */
  polaroidTextColor: string;
  /** Directory panel background. */
  directoryBg: string;
  /** Directory primary text color. */
  directoryTextColor: string;
  /** Directory secondary text color (roles, contact). */
  directoryMutedColor: string;
}

/**
 * Curated presets. `colorful` is a warm, playful light look closest to the hand-made poster;
 * `dark` is a self-contained on-brand dark look; `minimal` is a clean neutral base.
 */
export const CARTE_THEMES: CarteTheme[] = [
  {
    id: 'colorful',
    name: () => m.carte_theme_colorful(),
    pageBg: '#fdf3e3',
    scrimColor: '#3a2a12',
    scrimOpacity: 18,
    titleColor: '#7c2d12',
    zoneHeadingColor: '#b45309',
    bubbleNameColor: '#1f2937',
    polaroidBg: '#ffffff',
    polaroidTextColor: '#374151',
    directoryBg: 'rgba(255,255,255,0.86)',
    directoryTextColor: '#1f2937',
    directoryMutedColor: '#6b7280',
  },
  {
    id: 'dark',
    name: () => m.carte_theme_dark(),
    pageBg: '#0f1420',
    scrimColor: '#05070d',
    scrimOpacity: 40,
    titleColor: '#f5c518',
    zoneHeadingColor: '#f5c518',
    bubbleNameColor: '#f8fafc',
    polaroidBg: '#1b2335',
    polaroidTextColor: '#e2e8f0',
    directoryBg: 'rgba(21,27,44,0.88)',
    directoryTextColor: '#e2e8f0',
    directoryMutedColor: '#94a3b8',
  },
  {
    id: 'minimal',
    name: () => m.carte_theme_minimal(),
    pageBg: '#ffffff',
    scrimColor: '#0b1220',
    scrimOpacity: 12,
    titleColor: '#151b2c',
    zoneHeadingColor: '#607188',
    bubbleNameColor: '#151b2c',
    polaroidBg: '#f1f5f9',
    polaroidTextColor: '#334155',
    directoryBg: 'rgba(248,250,252,0.92)',
    directoryTextColor: '#334155',
    directoryMutedColor: '#64748b',
  },
];

/** First-load theme: the colorful preset, closest to the printed poster. */
export const DEFAULT_CARTE_THEME_ID = 'colorful';

/** Resolves a theme by id, falling back to the default when unknown. */
export function resolveCarteTheme(id: string | undefined | null): CarteTheme {
  return CARTE_THEMES.find((t) => t.id === id) ?? CARTE_THEMES[0];
}
