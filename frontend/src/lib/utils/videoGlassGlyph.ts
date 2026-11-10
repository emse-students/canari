/**
 * THE GEOMETRY OF THE VIDEO PLAYER'S GLASS GLYPHS (owner, 2026-11-09: *"J'aurais juste fait le
 * triangle en liquid glass"* - no disc behind the play button, the triangle itself is the glass).
 *
 * A glyph is drawn as a rounded SHAPE that is clipped out of a glass layer (`.glass-video-shape`,
 * `VideoGlassGlyph`), so the blur and the dark tint exist only inside it. This file is the shape,
 * pure: the same path is the clip, the rim stroke and the soft shadow, so the three can never
 * disagree. Authored on a 64-unit box and scaled to the pixel size asked for, because `clip-path:
 * path()` takes pixels and does not scale with its element.
 */

/** Which glyph. */
export type GlassGlyphKind = 'play' | 'pause';

/** The authoring box, in units. */
const BOX = 64;
/** Corner radius in units: soft enough to read as glass, small enough to stay a triangle. */
const CORNER = 5;

type Point = readonly [number, number];

/**
 * The play triangle: optically centred (its centroid sits a little right of the middle of the box,
 * so the glyph does not look pushed left), pointing right.
 */
const PLAY: readonly Point[] = [
  [21, 12],
  [21, 52],
  [55, 32],
];

/** The two bars of a pause, as rectangles `[x, y, width, height]`. */
const PAUSE_BARS: readonly (readonly [number, number, number, number])[] = [
  [17, 14, 12, 36],
  [35, 14, 12, 36],
];

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/** A closed polygon with every corner rounded by a quadratic curve of radius `r`. */
function roundedPolygon(points: readonly Point[], r: number, k: number): string {
  const n = points.length;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i + n - 1) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    const toward = (a: Point, b: Point): Point => {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const len = Math.hypot(dx, dy);
      return [b[0] + (dx / len) * r, b[1] + (dy / len) * r];
    };
    const enter = toward(prev, cur);
    const leave = toward(next, cur);
    parts.push(
      `${i === 0 ? 'M' : 'L'}${fmt(enter[0] * k)} ${fmt(enter[1] * k)}`,
      `Q${fmt(cur[0] * k)} ${fmt(cur[1] * k)} ${fmt(leave[0] * k)} ${fmt(leave[1] * k)}`
    );
  }
  return `${parts.join('')}Z`;
}

/** A rectangle with rounded corners, closed. */
function roundedRect(x: number, y: number, w: number, h: number, r: number, k: number): string {
  const [X, Y, W, H, R] = [x, y, w, h, r].map((v) => v * k);
  return (
    `M${fmt(X + R)} ${fmt(Y)}H${fmt(X + W - R)}Q${fmt(X + W)} ${fmt(Y)} ${fmt(X + W)} ${fmt(Y + R)}` +
    `V${fmt(Y + H - R)}Q${fmt(X + W)} ${fmt(Y + H)} ${fmt(X + W - R)} ${fmt(Y + H)}` +
    `H${fmt(X + R)}Q${fmt(X)} ${fmt(Y + H)} ${fmt(X)} ${fmt(Y + H - R)}` +
    `V${fmt(Y + R)}Q${fmt(X)} ${fmt(Y)} ${fmt(X + R)} ${fmt(Y)}Z`
  );
}

/**
 * The SVG path of `kind` in a square box of `size` pixels. Valid both as an SVG `d` and inside CSS
 * `clip-path: path('...')`.
 */
export function glassGlyphPath(kind: GlassGlyphKind, size: number): string {
  const k = size / BOX;
  if (kind === 'play') return roundedPolygon(PLAY, CORNER, k);
  return PAUSE_BARS.map(([x, y, w, h]) => roundedRect(x, y, w, h, CORNER - 1, k)).join('');
}
