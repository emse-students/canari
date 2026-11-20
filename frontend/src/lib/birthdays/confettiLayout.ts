/**
 * THE BIRTHDAY CONFETTI LAYOUT (decision 3, docs/wiki/birthdays.md): where the small pieces sit on
 * the ring of a celebrated member's avatar. PURE AND DETERMINISTIC - the same size always yields
 * the same picture (a seeded generator, never `Math.random`), so a list re-rendering or two
 * readers see one image, and a test can assert it.
 *
 * Positions are percentages of the avatar's box (so the pieces follow the box wherever the CSS
 * sizes it); piece sizes are pixels derived from the measured box. The pieces FLOAT round the
 * ring (owner, 2026-11-20): each is centred 14% to 24% of the size beyond the photo's edge, so the
 * overshoot is at most ~0.3 x size - the ring itself stays thin and flush.
 */

export interface ConfettiPiece {
  /** Centre, as a percentage of the avatar box (0 = left/top edge). */
  xPct: number;
  yPct: number;
  /** Size in px. */
  widthPx: number;
  heightPx: number;
  /** A dot is round; otherwise a short rectangle. */
  dot: boolean;
  /** Index into the four warm confetti tokens (`--birthday-c0` .. `--birthday-c3`). */
  colour: number;
  rotationDeg: number;
  /** Twinkle phase, seconds. */
  delayS: number;
}

/** The ring's thickness in px: max(2px, 6% of the avatar) - the one formula, also in `app.css`. */
export function ringWidthPx(sizePx: number): number {
  return Math.max(2, sizePx * 0.06);
}

/** 12 pieces from 48 px, 8 from 30 px, 5 dots below. */
export function confettiCount(sizePx: number): number {
  return sizePx >= 48 ? 12 : sizePx >= 30 ? 8 : 5;
}

/** Park-Miller generator: tiny, seedable, identical on every engine. */
function rng(seed: number): () => number {
  let s = Math.max(1, Math.floor(seed)) % 2147483647;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * The pieces for an avatar `sizePx` wide. Pieces are spread evenly round the ring with a small
 * jitter; below 30 px they are all dots (a rectangle is noise at that size).
 */
export function confettiLayout(sizePx: number): ConfettiPiece[] {
  const size = Math.max(1, Math.round(sizePx));
  const n = confettiCount(size);
  const rand = rng(size * 7 + n);
  const pieces: ConfettiPiece[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.5 - Math.PI / 2;
    // Distance of the centre from the avatar's centre, as a share of the size.
    const radiusPct = 50 + (0.14 + rand() * 0.1) * 100;
    const dot = size < 30 || rand() < 0.4;
    const width = Math.max(2.5, size * (dot ? 0.07 : 0.05));
    const height = dot ? width : Math.max(4, size * 0.12);
    pieces.push({
      xPct: 50 + Math.cos(angle) * radiusPct,
      yPct: 50 + Math.sin(angle) * radiusPct,
      widthPx: width,
      heightPx: height,
      dot,
      colour: (i + Math.floor(rand() * 3)) % 4,
      rotationDeg: Math.floor(rand() * 180),
      delayS: Number((rand() * 2.6).toFixed(2)),
    });
  }
  return pieces;
}
