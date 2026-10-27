/**
 * CanaRun - the trace as a bare SVG polyline in a FIXED viewBox.
 *
 * Decided (2026-10-27): no map tiles and no request of any kind - the trace is the only picture,
 * drawn from the points the message carries. An equirectangular projection with the longitude
 * scaled by cos(mean latitude) keeps a loop round at any latitude a run can happen at; the shape is
 * then fitted, aspect kept, into {@link TRACK_VIEWBOX}, so whatever the peer sent the drawing has
 * the same bounded size and at most `RUN_BOUNDS.maxPoints` vertices.
 */

/** The fixed drawing space every trace is fitted into. */
export const TRACK_VIEWBOX = { width: 320, height: 160, padding: 10 } as const;

/**
 * The `points` attribute of the polyline for an absolute E5 trace (`[lat0, lon0, ...]`, already
 * checked by `checkRunActivity`), or `null` when fewer than two points leave nothing to draw.
 * A trace with no extent (every point the same) is drawn as a dot at the centre.
 */
export function trackPolylinePoints(trackE5: readonly number[]): string | null {
  const count = Math.floor(trackE5.length / 2);
  if (count < 2) return null;

  let latSum = 0;
  for (let i = 0; i < trackE5.length; i += 2) latSum += trackE5[i];
  const meanLatRad = ((latSum / count) * 1e-5 * Math.PI) / 180;
  const kx = Math.cos(meanLatRad);

  const xs: number[] = [];
  const ys: number[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < trackE5.length; i += 2) {
    const x = trackE5[i + 1] * kx;
    // North up: the screen's y grows downwards.
    const y = -trackE5[i];
    xs.push(x);
    ys.push(y);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const { width, height, padding } = TRACK_VIEWBOX;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const innerW = width - 2 * padding;
  const innerH = height - 2 * padding;
  const span = Math.max(spanX / innerW, spanY / innerH);
  // No extent: every point lands on the centre rather than dividing by zero.
  const scale = span > 0 ? 1 / span : 0;
  const offsetX = padding + (innerW - spanX * scale) / 2;
  const offsetY = padding + (innerH - spanY * scale) / 2;

  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const px = scale > 0 ? offsetX + (xs[i] - minX) * scale : width / 2;
    const py = scale > 0 ? offsetY + (ys[i] - minY) * scale : height / 2;
    out.push(`${px.toFixed(1)},${py.toFixed(1)}`);
  }
  return out.join(' ');
}
