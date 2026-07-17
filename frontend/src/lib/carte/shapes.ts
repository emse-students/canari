/**
 * Curated "blob" silhouettes for the association units on the Carte de la Vie Asso poster. Each
 * shape is a CSS `border-radius` shorthand producing an organic (or geometric) rounded outline -
 * fully self-contained (no SVG asset, no external font) so the snapdom export rasterises it as-is.
 * The author picks one per association in the bubble property panel; the president sits inside the
 * shape and the bureau polaroids fan out radially around it.
 */

/** A single silhouette: a stable key + the CSS `border-radius` value producing the outline. */
export interface CarteShape {
  /** Stable key persisted on the positioned bubble. */
  key: string;
  /** CSS `border-radius` value giving the silhouette. */
  radius: string;
}

/** Curated silhouettes, kept small + distinct so the per-asso picker stays scannable. */
export const CARTE_SHAPES: CarteShape[] = [
  { key: 'circle', radius: '50%' },
  { key: 'soft', radius: '63% 37% 54% 46% / 55% 48% 52% 45%' },
  { key: 'pebble', radius: '40% 60% 70% 30% / 40% 40% 60% 60%' },
  { key: 'drop', radius: '70% 30% 30% 70% / 70% 70% 30% 30%' },
  { key: 'wave', radius: '38% 62% 63% 37% / 41% 44% 56% 59%' },
  { key: 'egg', radius: '60% 40% 30% 70% / 60% 30% 70% 40%' },
  { key: 'leaf', radius: '12% 88% 12% 88% / 88% 12% 88% 12%' },
  { key: 'rounded', radius: '28%' },
];

/** Default shape key applied to freshly-seeded bubbles. */
export const DEFAULT_SHAPE = CARTE_SHAPES[0].key;

/** Resolves a shape key to its CSS border-radius, falling back to the default (first) shape. */
export function shapeRadius(key: string): string {
  return CARTE_SHAPES.find((s) => s.key === key)?.radius ?? CARTE_SHAPES[0].radius;
}

/** Whether a persisted shape key is a known shape. */
export function isShapeKey(key: string): boolean {
  return CARTE_SHAPES.some((s) => s.key === key);
}
