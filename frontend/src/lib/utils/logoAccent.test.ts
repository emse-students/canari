/**
 * THE REFUSAL IS THE FEATURE, SO THE REFUSAL IS WHAT IS PINNED.
 *
 * A partner logo is usually artwork on a white plate, so the most common colour in the file is white
 * - and the backlog row that asked for this named the consequence rather than the cause: **a white
 * accent is invisible rather than wrong-looking, and nobody reports a bar they cannot see.** A test
 * that only checked "a red logo gives red" would have passed on every version of this that shipped
 * white.
 *
 * So the cases below are mostly logos that must give NOTHING, and the one assertion that matters
 * most is the last of them: a small mark on a large white plate answers with the MARK, not with the
 * plate it outnumbers it 15 to 1.
 */
import { describe, it, expect } from 'vitest';
import { accentFromPixels } from './logoAccent';

/** `n` pixels of one RGBA colour, as `getImageData().data` would hand them over. */
function pixels(colours: { rgba: [number, number, number, number]; count: number }[]) {
  const out: number[] = [];
  for (const { rgba, count } of colours) {
    for (let i = 0; i < count; i += 1) out.push(...rgba);
  }
  return new Uint8ClampedArray(out);
}

/** `count` pixels of one HSL colour (h in degrees, s and l 0-1), as RGBA. */
function fromHsl(colours: { hsl: [number, number, number]; count: number }[]) {
  const out: number[] = [];
  for (const { hsl, count } of colours) {
    const [h, s, l] = hsl;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const mm = l - c / 2;
    const sector = Math.floor((((h % 360) + 360) % 360) / 60);
    const rgb = [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ][sector];
    const px = [
      Math.round((rgb[0] + mm) * 255),
      Math.round((rgb[1] + mm) * 255),
      Math.round((rgb[2] + mm) * 255),
      255,
    ];
    for (let i = 0; i < count; i += 1) out.push(...px);
  }
  return new Uint8ClampedArray(out);
}

/** The hue an `hsl(...)` answer carries, for asserting a colour family rather than a byte. */
function hueOf(hsl: string | null): number | null {
  const m = /^hsl\((\d+), (\d+)%, (\d+)%\)$/.exec(hsl ?? '');
  return m ? Number(m[1]) : null;
}

function saturationOf(hsl: string | null): number | null {
  const m = /^hsl\((\d+), (\d+)%, (\d+)%\)$/.exec(hsl ?? '');
  return m ? Number(m[2]) : null;
}

function lightnessOf(hsl: string | null): number | null {
  const m = /^hsl\((\d+), (\d+)%, (\d+)%\)$/.exec(hsl ?? '');
  return m ? Number(m[3]) : null;
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];
const MID_GREY: [number, number, number, number] = [128, 128, 128, 255];
const TRANSPARENT: [number, number, number, number] = [220, 30, 30, 0];
const BRAND_RED: [number, number, number, number] = [200, 30, 30, 255];
const BRAND_BLUE: [number, number, number, number] = [30, 60, 200, 255];

describe('a logo that has no accent to give', () => {
  it('refuses a white plate, which is the case the user named', () => {
    expect(accentFromPixels(pixels([{ rgba: WHITE, count: 1024 }]))).toBeNull();
  });

  it('refuses black, because an outline is not a hue', () => {
    expect(accentFromPixels(pixels([{ rgba: BLACK, count: 1024 }]))).toBeNull();
  });

  it('refuses grey, which is a plate, a shadow, or the ramp between them', () => {
    expect(accentFromPixels(pixels([{ rgba: MID_GREY, count: 1024 }]))).toBeNull();
  });

  it('refuses a transparent logo however saturated the pixels underneath claim to be', () => {
    // A PNG mark is mostly this, and the colour channels of a fully transparent pixel are not
    // specified to be anything in particular - reading them is how a "dominant colour" ends up
    // being a colour that is not in the picture.
    expect(accentFromPixels(pixels([{ rgba: TRANSPARENT, count: 1024 }]))).toBeNull();
  });

  it('refuses an empty run rather than dividing by a count of zero', () => {
    expect(accentFromPixels(new Uint8ClampedArray([]))).toBeNull();
  });

  it('ignores a trailing partial pixel instead of reading past the end', () => {
    const truncated = new Uint8ClampedArray([...WHITE, 200, 30]);
    expect(accentFromPixels(truncated)).toBeNull();
  });
});

describe('a logo that does', () => {
  it('answers with the mark and not with the plate it is outnumbered by', () => {
    // THE CASE THE WHOLE MODULE EXISTS FOR: 960 white pixels against 64 red ones is a small logo on
    // a white background, which is what a partner actually uploads. A dominant-colour reading is
    // white; the right answer is red.
    const accent = accentFromPixels(
      pixels([
        { rgba: WHITE, count: 960 },
        { rgba: BRAND_RED, count: 64 },
      ])
    );

    expect(accent).not.toBeNull();
    expect(hueOf(accent)).toBeLessThan(30);
  });

  it('picks the heavier of two brand colours', () => {
    const accent = accentFromPixels(
      pixels([
        { rgba: BRAND_RED, count: 40 },
        { rgba: BRAND_BLUE, count: 200 },
      ])
    );

    // 30/60/200 is around 232 degrees. Asserted as a band, because the answer is a hue BIN's centre
    // and pinning the exact degree would be pinning the bin count rather than the behaviour.
    expect(hueOf(accent)).toBeGreaterThan(200);
    expect(hueOf(accent)).toBeLessThan(260);
  });

  it('keeps the answer inside the band every other accent in the app is drawn in', () => {
    // A pale logo must not yield a bar nobody can see on white, and a nearly-black one must not
    // yield one nobody can see in the dark theme. This is what makes the value a UI hue that came
    // from the logo rather than a colour sample.
    const pale = accentFromPixels(pixels([{ rgba: [255, 200, 200, 255], count: 512 }]));
    const deep = accentFromPixels(pixels([{ rgba: [40, 10, 10, 255], count: 512 }]));

    for (const accent of [pale, deep]) {
      if (accent === null) continue;
      expect(saturationOf(accent)).toBeGreaterThanOrEqual(45);
      expect(saturationOf(accent)).toBeLessThanOrEqual(85);
      expect(lightnessOf(accent)).toBeGreaterThanOrEqual(40);
      expect(lightnessOf(accent)).toBeLessThanOrEqual(58);
    }
  });

  it('keeps a solid brand colour whole when it lands on a bin edge', () => {
    // A BIN EDGE IS AN ARBITRARY LINE THROUGH A REAL COLOUR, and one solid hue in twenty-four falls
    // on one. Without the neighbour kernel it splits into two half-weight bins and loses to a
    // smaller mark that happened to land centred - which is a wrong answer produced entirely by
    // where the bins were drawn. Every hue is swept, so this cannot pass by missing the edges.
    const losses: string[] = [];
    for (let degree = 0; degree < 360; degree += 1) {
      const shaded: { hsl: [number, number, number]; count: number }[] = [];
      // 120 pixels of ONE brand hue with the faint shading any real logo has, against 40 pixels of
      // a single competing colour 90 degrees away.
      // THE SHADING VARIES THE HUE, not just the lightness. A first version of this swept 360
      // degrees with 120 pixels of one EXACT hue and could never fail: a single hue lands in exactly
      // one bin whatever the bin edges are, so nothing was ever split and the kernel was never
      // exercised. Real artwork spreads a few degrees, and that is what straddles an edge.
      for (let i = 0; i < 120; i += 1)
        shaded.push({ hsl: [degree + (i % 6) - 3, 0.7, 0.45], count: 1 });
      // 70 RIVAL PIXELS IS THE NUMBER THAT MAKES THIS TEST MEAN ANYTHING: more than half of 120 and
      // fewer than all of it. A brand colour sitting inside one bin beats 70 outright; one split in
      // half by an edge scores 60 and LOSES, unless the two halves are counted together. A gentler
      // rival passes with or without the kernel, which is a test that cannot fail - measured, not
      // assumed: at 40 the whole sweep stayed green on a build with the kernel deleted.
      const rival = (degree + 90) % 360;
      const accent = accentFromPixels(fromHsl([...shaded, { hsl: [rival, 0.7, 0.45], count: 70 }]));
      const answered = hueOf(accent);
      if (answered === null) {
        losses.push(`${degree}: refused`);
        continue;
      }
      // The answer is a bin CENTRE, so it can be up to half a bin (7.5 degrees) from the true hue.
      const off = Math.min(Math.abs(answered - degree), 360 - Math.abs(answered - degree));
      if (off > 8) losses.push(`${degree} -> ${answered}`);
    }

    expect(losses).toEqual([]);
  });

  it('lets a decided mark beat a colour spread across sixty degrees, which is the right outcome', () => {
    // The kernel rescues a colour split by an EDGE. It deliberately does not rescue a logo whose
    // colour is genuinely spread - a photograph, a rainbow - against a small mark in one decided
    // colour, because the decided colour is the one a reader would name.
    const spread: { hsl: [number, number, number]; count: number }[] = [];
    for (let i = 0; i < 64; i += 1) spread.push({ hsl: [180 + i, 0.7, 0.45], count: 1 });
    const accent = accentFromPixels(fromHsl([...spread, { hsl: [10, 0.7, 0.45], count: 40 }]));

    expect(hueOf(accent)).toBeLessThan(30);
  });

  it('folds the top of the hue wheel back into the first bin', () => {
    // A hue of exactly 1.0 is the same hue as 0.0. Without the fold it lands in a 25th bin that
    // exists for one value, which is an out-of-range read rather than a wrong colour.
    const accent = accentFromPixels(pixels([{ rgba: [200, 0, 0, 255], count: 64 }]));

    expect(accent).not.toBeNull();
    expect(hueOf(accent)).toBeGreaterThanOrEqual(0);
    expect(hueOf(accent)).toBeLessThan(360);
  });
});
