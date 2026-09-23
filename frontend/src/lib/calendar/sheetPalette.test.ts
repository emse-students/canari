import { dominantHue } from './sheetPalette';

/**
 * Builds a pixel buffer in the shape `getImageData` returns: four bytes per pixel, RGBA.
 *
 * @param colors - one `[r, g, b]` per pixel, repeated `repeat` times.
 */
function pixels(colors: [number, number, number][], repeat = 1): Uint8ClampedArray {
  const out = new Uint8ClampedArray(colors.length * repeat * 4);
  let i = 0;
  for (let n = 0; n < repeat; n += 1) {
    for (const [r, g, b] of colors) {
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
      i += 4;
    }
  }
  return out;
}

/** One `[r, g, b]` at the given hue, at the saturation and lightness the vote actually counts. */
function atHue(h: number, s = 0.6, l = 0.5): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Circular distance between two hues, in degrees. */
function apart(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe('dominantHue', () => {
  it('names the hue of a single-colour image', () => {
    // A saturated blue, hue 210.
    const hue = dominantHue(pixels([[51, 128, 204]], 40));
    expect(hue).not.toBeNull();
    expect(hue as number).toBeCloseTo(210, 0);
  });

  it('AVERAGES A SUBJECT STRADDLING THE 0/359 SEAM TO ITS OWN COLOUR, NOT TO ITS OPPOSITE', () => {
    // Twenty reds spread either side of the seam, 350 through 9. Averaging the hue NUMBERS gives
    // (350+..+359+0+..+9)/20 = 179.5 - cyan, the exact opposite of every pixel in the buffer, and
    // a colour that is not in the picture at all. Unit vectors have no seam to fall off.
    const reds: [number, number, number][] = [];
    for (let h = 350; h < 370; h += 1) reds.push(atHue(h % 360));

    const hue = dominantHue(pixels(reds, 3));
    expect(hue).not.toBeNull();
    expect(apart(hue as number, 0)).toBeLessThan(5);
    expect(apart(hue as number, 180)).toBeGreaterThan(170);
  });

  it('rotates its answer with the image, so 0/360 is not a special place on the wheel', () => {
    // The property that makes the seam a non-event: no bucket edge, no origin, nothing the picture
    // can be unlucky enough to sit on. A red-and-green scene and the same scene turned 137 degrees
    // must give answers 137 degrees apart.
    const scene = (turn: number) =>
      new Uint8ClampedArray([
        ...Array.from(pixels([atHue((0 + turn) % 360)], 60)),
        ...Array.from(pixels([atHue((124 + turn) % 360)], 40)),
      ]);

    const straight = dominantHue(scene(0));
    const turned = dominantHue(scene(137));
    expect(straight).not.toBeNull();
    expect(turned).not.toBeNull();
    expect(apart((straight as number) + 137, turned as number)).toBeLessThan(2);
  });

  it('returns null for a greyscale image rather than inventing a tint', () => {
    expect(
      dominantHue(
        pixels(
          [
            [20, 20, 20],
            [128, 128, 128],
            [230, 230, 230],
          ],
          20
        )
      )
    ).toBeNull();
  });

  it('returns null when the hues cancel out, which is not the same as hue 0', () => {
    // Red against cyan: equal weight, opposite directions. The resultant is ~zero-length, and
    // reporting its angle would name a colour that is in the picture no more than its opposite is.
    expect(
      dominantHue(
        pixels(
          [
            [204, 51, 51],
            [51, 204, 204],
          ],
          20
        )
      )
    ).toBeNull();
  });

  it('ignores blown-out highlights and crushed shadows, which carry a meaningless hue', () => {
    // A near-white with a faint warm cast, plus a near-black with a faint cool one: both are
    // exposure, not subject. Only the handful of real green pixels should decide.
    const hue = dominantHue(
      pixels(
        [
          [252, 248, 244],
          [6, 8, 12],
          [51, 204, 61],
        ],
        20
      )
    );
    expect(hue).not.toBeNull();
    expect(hue as number).toBeCloseTo(125, -1);
  });

  it('weights by saturation, so a vivid minority outvotes a washed-out majority', () => {
    const washedBlue = atHue(215, 0.16, 0.66);
    const vividOrange = atHue(30, 0.85, 0.5);

    const hue = dominantHue(
      new Uint8ClampedArray([
        ...Array.from(pixels([washedBlue], 30)),
        ...Array.from(pixels([vividOrange], 10)),
      ])
    );
    expect(hue).not.toBeNull();
    // The claim is comparative, so the assertion is too: the answer lands nearer the ten vivid
    // pixels than the thirty pale ones. Pinning a degree count would be pinning the arithmetic.
    expect(apart(hue as number, 30)).toBeLessThan(apart(hue as number, 215));
  });

  it('skips fully transparent pixels', () => {
    const buf = pixels([[51, 128, 204]], 10);
    const withGhost = new Uint8ClampedArray(buf.length + 4);
    withGhost.set(buf);
    // A transparent red that would drag the answer if its alpha were ignored.
    withGhost.set([255, 0, 0, 0], buf.length);

    expect(dominantHue(withGhost) as number).toBeCloseTo(210, 0);
  });
});
