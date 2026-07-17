import { m } from '$lib/paraglide/messages';

/**
 * Curated organic "blob" background shapes for the Carte de la Vie Asso poster. A blob is a soft,
 * colored background ornament rendered as a CSS `border-radius` organic silhouette - fully
 * self-contained (no SVG asset, no external font) so the snapdom export rasterises it as-is.
 * Blobs sit behind the bubbles by default to give the poster theme character (design doc:
 * "theme background blobs").
 */

/** A blob silhouette: a CSS `border-radius` shorthand producing an organic rounded outline. */
export interface BlobShape {
  /** Stable key persisted in the decoration. */
  key: string;
  /** Localized display name for the palette tooltip. */
  label: () => string;
  /** CSS `border-radius` value (8-value shorthand) giving the organic silhouette. */
  radius: string;
}

/** Curated blob silhouettes. Kept small + distinct so the palette stays scannable. */
export const BLOB_SHAPES: BlobShape[] = [
  { key: 'soft', label: () => m.carte_blob_soft(), radius: '63% 37% 54% 46% / 55% 48% 52% 45%' },
  {
    key: 'pebble',
    label: () => m.carte_blob_pebble(),
    radius: '40% 60% 70% 30% / 40% 40% 60% 60%',
  },
  { key: 'drop', label: () => m.carte_blob_drop(), radius: '70% 30% 30% 70% / 70% 70% 30% 30%' },
  { key: 'wave', label: () => m.carte_blob_wave(), radius: '38% 62% 63% 37% / 41% 44% 56% 59%' },
  { key: 'egg', label: () => m.carte_blob_egg(), radius: '60% 40% 30% 70% / 60% 30% 70% 40%' },
  { key: 'oval', label: () => m.carte_blob_oval(), radius: '50% 50% 50% 50% / 62% 62% 38% 38%' },
];

/** Fallback silhouette used when a persisted blob shape key is unknown. */
const FALLBACK_RADIUS = BLOB_SHAPES[0].radius;

/** Resolves a blob shape key to its CSS border-radius, falling back to the first shape. */
export function blobRadius(key: string): string {
  return BLOB_SHAPES.find((s) => s.key === key)?.radius ?? FALLBACK_RADIUS;
}

/** Whether a persisted shape key is a known blob shape. */
export function isBlobShape(key: string): boolean {
  return BLOB_SHAPES.some((s) => s.key === key);
}
