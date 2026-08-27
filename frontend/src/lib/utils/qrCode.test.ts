import { describe, it, expect } from 'vitest';
import jsQR from 'jsqr';
import {
  badgeShape,
  finderShapes,
  isDarkModule,
  isFinderModule,
  logoBadge,
  logoBadgeDamageRatio,
  moduleContains,
  moduleCorners,
  qrFileName,
  qrSymbol,
  roundedSquareContains,
  QR_MODULE_RADIUS_FRACTION,
  QR_QUIET_ZONE_MODULES,
} from './qrCode';

/**
 * The claim this file exists to hold: a Canari QR code still decodes with the bird punched into
 * the middle of it, drawn in the house style rather than as a plain grid of squares.
 *
 * It is answered on PIXELS, not on the badge's arithmetic, because "22 percent of the side is
 * under what H recovers" is a budget and not a proof - the damage sits over the centre, where the
 * codewords of several blocks meet, and only a decoder can say whether the interleaving survived
 * it. And the style is not free either: rounding corners and softening the finders takes ink away
 * from exactly the runs a decoder measures.
 *
 * So the symbol is rasterised here through the SAME exported geometry the canvas draws -
 * `moduleCorners` and `moduleContains` for the strokes, `finderShapes` for the finders,
 * `badgeShape` for the hole - and handed to `jsQR`, which is a real decoder and knows nothing
 * about how the image was made. The canvas itself is NOT under test: happy-dom has no 2D context,
 * and a pixel buffer built from the shared geometry is the honest half to assert on.
 */

/** Side of a module, in pixels, for the rasteriser below. Eight is plenty for jsQR to sample. */
const MODULE_PX = 8;

/** Paints a symbol the way `renderQrCanvas` does, and punches the same badge into it. */
function rasterise(
  symbol: Awaited<ReturnType<typeof qrSymbol>>,
  withBadge: boolean
): { data: Uint8ClampedArray; side: number } {
  const size = symbol.modules.size;
  const side = (size + 2 * QR_QUIET_ZONE_MODULES) * MODULE_PX;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  const finders = finderShapes(size);
  const badge = badgeShape(size);

  /** Is this point, in module coordinates, inside one of the three finder patterns? */
  const inFinder = (x: number, y: number): boolean =>
    finders.some((finder) => {
      const at = (square: { half: number; radius: number }) =>
        roundedSquareContains(x, y, finder.cx, finder.cy, square.half, square.radius);
      if (!at(finder.outer)) return false;
      return !at(finder.inner) || at(finder.eye);
    });

  /** Is this point inside the stroke the dark module under it belongs to? */
  const inModule = (x: number, y: number): boolean => {
    const col = Math.floor(x);
    const row = Math.floor(y);
    if (row < 0 || col < 0 || row >= size || col >= size) return false;
    if (!isDarkModule(symbol, row, col) || isFinderModule(size, row, col)) return false;
    return moduleContains(
      x,
      y,
      col + 0.5,
      row + 0.5,
      0.5,
      QR_MODULE_RADIUS_FRACTION,
      moduleCorners(symbol, row, col)
    );
  };

  for (let py = 0; py < side; py++) {
    for (let px = 0; px < side; px++) {
      // Module coordinates of this pixel's centre, with the quiet zone taken back off.
      const x = (px + 0.5) / MODULE_PX - QR_QUIET_ZONE_MODULES;
      const y = (py + 0.5) / MODULE_PX - QR_QUIET_ZONE_MODULES;
      const erased =
        withBadge && roundedSquareContains(x, y, badge.cx, badge.cy, badge.half, badge.radius);
      if (erased || !(inFinder(x, y) || inModule(x, y))) continue;
      const at = (py * side + px) * 4;
      data[at] = 0;
      data[at + 1] = 0;
      data[at + 2] = 0;
    }
  }

  return { data, side };
}

/** The shape of link every call site encodes today: an absolute public form URL. */
const FORM_URL = 'https://canari-emse.fr/forms/8f14e45f-ceea-467a-9d94-2b6c1ca1d7a9';

describe('logoBadge', () => {
  // Every QR version, from 21 modules to 177. A symbol's side is always odd.
  const sides = Array.from({ length: 40 }, (_, i) => 21 + 4 * i);

  it('centres an odd hole on the symbol s middle module', () => {
    for (const side of sides) {
      const { holeModules, offsetModules } = logoBadge(side);
      expect(holeModules % 2).toBe(1);
      expect(offsetModules).toBe((side - holeModules) / 2);
      expect(Number.isInteger(offsetModules)).toBe(true);
    }
  });

  it('destroys far less than the 30 percent H recovers, at every version', () => {
    for (const side of sides) {
      expect(logoBadgeDamageRatio(side)).toBeLessThan(0.1);
    }
  });

  it('never reaches a finder pattern', () => {
    // The finders occupy 7 modules plus a separator in each corner; the hole must clear them.
    for (const side of sides) {
      expect(logoBadge(side).offsetModules).toBeGreaterThan(8);
    }
  });
});

describe('moduleCorners', () => {
  it('rounds a corner only where both of its neighbours are light', async () => {
    const symbol = await qrSymbol(FORM_URL);
    const size = symbol.modules.size;

    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (!isDarkModule(symbol, row, col)) continue;
        const corners = moduleCorners(symbol, row, col);
        const up = isDarkModule(symbol, row - 1, col);
        const down = isDarkModule(symbol, row + 1, col);
        const left = isDarkModule(symbol, row, col - 1);
        const right = isDarkModule(symbol, row, col + 1);
        // A rounded corner on a dark-to-dark edge would notch a light bite out of the stroke.
        expect(corners.topLeft).toBe(!up && !left);
        expect(corners.topRight).toBe(!up && !right);
        expect(corners.bottomRight).toBe(!down && !right);
        expect(corners.bottomLeft).toBe(!down && !left);
      }
    }
  });

  it('keeps a module s centre covered whatever its corners do', () => {
    const every = { topLeft: true, topRight: true, bottomRight: true, bottomLeft: true };
    expect(moduleContains(0.5, 0.5, 0.5, 0.5, 0.5, QR_MODULE_RADIUS_FRACTION, every)).toBe(true);
    // A fully rounded module is a disc: its own corner is outside it, its edge midpoints are in.
    expect(moduleContains(0.02, 0.02, 0.5, 0.5, 0.5, QR_MODULE_RADIUS_FRACTION, every)).toBe(false);
    expect(moduleContains(0.5, 0.02, 0.5, 0.5, 0.5, QR_MODULE_RADIUS_FRACTION, every)).toBe(true);
    // The same corner, left square because a dark neighbour shares it, is inside.
    expect(
      moduleContains(0.02, 0.02, 0.5, 0.5, 0.5, QR_MODULE_RADIUS_FRACTION, {
        ...every,
        topLeft: false,
      })
    ).toBe(true);
  });
});

describe('the rendered symbol', () => {
  it('decodes back to the link with no badge', async () => {
    const symbol = await qrSymbol(FORM_URL);
    const { data, side } = rasterise(symbol, false);
    expect(jsQR(data, side, side)?.data).toBe(FORM_URL);
  });

  it('still decodes back to the link with the bird punched into it', async () => {
    const symbol = await qrSymbol(FORM_URL);
    const { data, side } = rasterise(symbol, true);
    expect(jsQR(data, side, side)?.data).toBe(FORM_URL);
  });

  it('survives the badge on a link far longer than a form URL', async () => {
    // A longer payload means a denser symbol: more modules under the same 22 percent.
    const long = `${FORM_URL}?redirect=/associations/une-association-au-nom-tres-long&ref=affiche`;
    const symbol = await qrSymbol(long);
    const { data, side } = rasterise(symbol, true);
    expect(jsQR(data, side, side)?.data).toBe(long);
  });
});

describe('qrFileName', () => {
  it('strips accents and punctuation into one slug', () => {
    // Escaped rather than typed: the accents are the fixture here, not localized prose.
    expect(qrFileName('R\u00e9union des d\u00e9l\u00e9gu\u00e9s')).toBe(
      'canari-qr-reunion-des-delegues.png'
    );
    expect(qrFileName('Inscription Gala 2026 !')).toBe('canari-qr-inscription-gala-2026.png');
  });

  it('keeps a name when the label slugs to nothing', () => {
    expect(qrFileName('!!!')).toBe('canari-qr.png');
    expect(qrFileName('')).toBe('canari-qr.png');
  });

  it('never ends on the hyphen the length cap can leave', () => {
    const clipped = qrFileName(`${'a'.repeat(47)} suite`);
    expect(clipped.endsWith('-.png')).toBe(false);
  });
});
