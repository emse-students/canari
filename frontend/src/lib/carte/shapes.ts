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

/**
 * Logo frame shapes: a small dedicated set (unlike the organic blob silhouettes) so a rectangular
 * logo is not cropped by an organic outline. Each carries an aspect ratio ({@link LogoShape.w} x
 * {@link LogoShape.h}, multipliers of the base logo size) plus a `border-radius`, so the logo can be
 * a circle, a rounded square, or a rounded rectangle in landscape / portrait.
 */
export interface LogoShape {
  /** Stable key persisted on the positioned bubble. */
  key: string;
  /** Width multiplier of the base logo size. */
  w: number;
  /** Height multiplier of the base logo size. */
  h: number;
  /** CSS `border-radius` value for the frame. */
  radius: string;
}

/** The dedicated logo frame shapes (round, rounded square, rounded rectangle landscape/portrait). */
export const LOGO_SHAPES: LogoShape[] = [
  { key: 'circle', w: 1, h: 1, radius: '50%' },
  { key: 'squircle', w: 1, h: 1, radius: '26%' },
  { key: 'wide', w: 1.5, h: 0.92, radius: '18%' },
  { key: 'tall', w: 0.92, h: 1.42, radius: '18%' },
];

/** Default logo shape key applied to freshly-seeded bubbles. */
export const DEFAULT_LOGO_SHAPE = LOGO_SHAPES[0].key;

/** Resolves a logo shape key to its {@link LogoShape}, falling back to the default (first) shape. */
export function logoShape(key: string): LogoShape {
  return LOGO_SHAPES.find((s) => s.key === key) ?? LOGO_SHAPES[0];
}

/** Whether a persisted logo shape key is a known logo shape. */
export function isLogoShapeKey(key: string): boolean {
  return LOGO_SHAPES.some((s) => s.key === key);
}
