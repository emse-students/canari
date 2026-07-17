/**
 * Fixed visual style for the "Carte de la Vie Asso" poster. The poster used to offer three theme
 * presets; that was dropped - there is now a single warm, playful look (the former "colorful"
 * preset, closest to the hand-made poster). The association bubbles keep their own brand colors so
 * the map stays recognisable. An uploaded background image, when present, replaces the flat
 * {@link CarteStyle.pageBg} (drawn on top of it), with an optional scrim for legibility.
 */
export interface CarteStyle {
  /** Page background color, painted under an optional background image. */
  pageBg: string;
  /** Overlay color drawn over the background image to keep text legible. */
  scrimColor: string;
  /** Poster title color. */
  titleColor: string;
  /** Association name text under each bubble. */
  bubbleNameColor: string;
  /** Polaroid card background (member photo frame). */
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

/** The single poster style (the warm "vitamine" look). */
export const CARTE_STYLE: CarteStyle = {
  pageBg: '#fdf3e3',
  scrimColor: '#3a2a12',
  titleColor: '#7c2d12',
  bubbleNameColor: '#1f2937',
  polaroidBg: '#ffffff',
  polaroidTextColor: '#374151',
  directoryBg: 'rgba(255,255,255,0.86)',
  directoryTextColor: '#1f2937',
  directoryMutedColor: '#6b7280',
};

/** Default scrim opacity (0-100) applied when a background image is set. */
export const DEFAULT_SCRIM_OPACITY = 18;
