/**
 * THE ACCENT A PARTNER'S LOGO IS ACTUALLY WEARING, OR NOTHING AT ALL.
 *
 * The user asked for it and named the trap in the same sentence (2026-09-13): *"il pourrait etre
 * pertinent d'utiliser la couleur du logo importe (attention au fond blanc des fois) comme couleur
 * d'accentuation, en gardant la couleur de l'asso comme fallback"*. Half the partner logos are
 * artwork sitting on a white plate, so the most common colour in the file is white - and an accent
 * of white is not a wrong-looking accent, it is an INVISIBLE one. Nobody reports a bar they cannot
 * see, which is why the refusal is the part this module exists for and the part the tests pin.
 *
 * ## Refused, and why each one
 *
 * | Refused | Because |
 * | --- | --- |
 * | alpha under 128 | a mostly-transparent pixel says nothing about the mark; a PNG logo is mostly this |
 * | lightness over 0.90 | the plate, not the logo |
 * | lightness under 0.10 | an outline or a drop shadow, and black is not a hue |
 * | saturation under 0.20 | grey: a plate, a shadow, or the anti-aliased ramp between the two |
 *
 * **A pixel is refused, never corrected.** A "closest usable colour" would hand back something the
 * logo does not contain, and the fallback already exists and is correct: the association's own
 * colour. Returning `null` and taking it is a better answer than inventing a hue.
 *
 * ## What survives is read as a HUE, not reproduced
 *
 * The usable pixels are bucketed into 24 hue bins of 15 degrees and the heaviest bin wins, with its
 * own mean saturation and lightness - then both are clamped into the band `generateAvatarColor`
 * already draws every other accent in (s 45-85 %, l 40-58 %). That is deliberate: this value tints a
 * 3px bar, a badge and a hover outline that both themes have to show, so a pale logo must not
 * produce a bar nobody can see on white, and a near-black one must not produce a bar nobody can see
 * on the dark theme. **An accent is a UI hue that came FROM the logo; it is not a colour sample.**
 *
 * Bucketing by hue rather than counting exact colours is what makes a shaded or photographic logo
 * answer at all: a thousand distinct blues that differ by a few degrees are one bin, and the mark's
 * own colour wins over its own shading instead of losing to it. A bin is scored together with its
 * two neighbours ([0.5, 1, 0.5], wrapping), because **a bin edge is an arbitrary line through a real
 * colour**: without that, one solid brand hue in twenty-four falls on an edge, splits into two
 * half-weight bins, and loses to a smaller mark that happened to land centred.
 *
 * What this does NOT do is rescue a logo whose colour is genuinely spread over sixty degrees - a
 * photograph, a rainbow - against a small mark in one decided colour. That is the right outcome: the
 * decided colour is the one a reader would name.
 */
import { Log } from '$lib/utils/Log';

/** A pixel this transparent is not part of the mark. */
const MIN_ALPHA = 128;
/** Above this lightness a pixel is the plate the logo was exported onto. */
const MAX_LIGHTNESS = 0.9;
/** Below it, an outline or a shadow. */
const MIN_LIGHTNESS = 0.1;
/** Below this saturation there is no hue to take. */
const MIN_SATURATION = 0.2;

/** Hue bins. 24 x 15 degrees keeps two adjacent brand colours apart while merging a gradient. */
const HUE_BINS = 24;

/** The band every other accent in the app is drawn in, so this one is legible in both themes. */
const ACCENT_SATURATION = { min: 0.45, max: 0.85 } as const;
const ACCENT_LIGHTNESS = { min: 0.4, max: 0.58 } as const;

/** The square the logo is drawn into before its pixels are read. */
const SAMPLE_SIZE = 32;

/** HSL, each channel 0-1. */
interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** sRGB 0-255 to HSL 0-1. Straight from the definition; no library for four lines of arithmetic. */
function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The accent a run of RGBA pixels is wearing, or `null` when none of them carries a usable hue.
 *
 * Pure and synchronous on purpose: everything a test needs to pin lives here, and nothing about the
 * refusal depends on a canvas, a network or a browser.
 *
 * @param pixels RGBA quadruples, as `CanvasRenderingContext2D.getImageData().data` produces them.
 * @returns an `hsl(...)` string in the app's accent band, or `null` to mean "use the fallback".
 */
export function accentFromPixels(pixels: Uint8ClampedArray): string | null {
  const weight = Array.from({ length: HUE_BINS }, () => 0);
  const sumS = Array.from({ length: HUE_BINS }, () => 0);
  const sumL = Array.from({ length: HUE_BINS }, () => 0);
  let usable = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < MIN_ALPHA) continue;
    const { h, s, l } = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (l > MAX_LIGHTNESS || l < MIN_LIGHTNESS || s < MIN_SATURATION) continue;

    // `h` is 0-1 and 1 is the same hue as 0, so the top edge folds back into the first bin rather
    // than into a 25th that would exist for exactly one value.
    const bin = Math.floor(h * HUE_BINS) % HUE_BINS;
    weight[bin] += 1;
    sumS[bin] += s;
    sumL[bin] += l;
    usable += 1;
  }

  if (usable === 0) return null;

  // EACH BIN IS SCORED WITH ITS NEIGHBOURS, because a bin edge is an arbitrary line through a real
  // colour. A single solid brand hue sitting on one - and one in twenty-four does - would otherwise
  // split into two half-weight bins and lose to a smaller mark that happened to land centred. The
  // kernel is [0.5, 1, 0.5] and it wraps, since bin 23 and bin 0 are adjacent on a wheel.
  const at = (bin: number) => (bin + HUE_BINS) % HUE_BINS;
  const scoreOf = (bin: number) => weight[bin] + 0.5 * (weight[at(bin - 1)] + weight[at(bin + 1)]);

  let best = 0;
  for (let bin = 1; bin < HUE_BINS; bin += 1) {
    if (scoreOf(bin) > scoreOf(best)) best = bin;
  }

  // The winner's own saturation and lightness are averaged over the same three bins the score came
  // from, so a colour split across an edge reports the mean of the WHOLE colour rather than of the
  // half that happened to fall on the winning side.
  const span = [at(best - 1), best, at(best + 1)];
  const kernel = [0.5, 1, 0.5];
  const mass = span.reduce((total, bin, i) => total + kernel[i] * weight[bin], 0);
  const meanS = span.reduce((total, bin, i) => total + kernel[i] * sumS[bin], 0) / mass;
  const meanL = span.reduce((total, bin, i) => total + kernel[i] * sumL[bin], 0) / mass;

  // The bin's CENTRE, not its lower edge: the pixels that landed in it are spread across the whole
  // 15 degrees, and taking the edge would tilt every answer the same way.
  const hue = ((best + 0.5) / HUE_BINS) * 360;
  const saturation = clamp(meanS, ACCENT_SATURATION.min, ACCENT_SATURATION.max);
  const lightness = clamp(meanL, ACCENT_LIGHTNESS.min, ACCENT_LIGHTNESS.max);

  return `hsl(${Math.round(hue)}, ${Math.round(saturation * 100)}%, ${Math.round(lightness * 100)}%)`;
}

/**
 * One in-flight or settled answer per URL.
 *
 * A wall of partnership cards re-renders whenever any one of them is claimed, and the effect that
 * asks for an accent runs again each time. Keyed on the URL rather than on the card, because the
 * same partner logo appears on the association's page and on `/shop`.
 */
const cache = new Map<string, Promise<string | null>>();

/** Reads back one logo's pixels; separated so a test can drive `loadLogoAccent` with no DOM. */
async function pixelsOf(url: string): Promise<Uint8ClampedArray | null> {
  const image = new Image();
  // Same-origin in the web build, and the media host sets no credentials. Anonymous is what keeps
  // the canvas untainted: a tainted canvas throws on `getImageData` and there is nothing to read.
  image.crossOrigin = 'anonymous';
  image.src = url;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  return context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
}

/**
 * The accent for one logo URL, or `null` when the logo has none to give.
 *
 * **NEVER THROWS, AND THE CALLER HAS A CORRECT ANSWER FOR `null` ALREADY.** Every way this can fail
 * - a 404, a decode error, a canvas tainted by a redirect to another origin, a runtime with no
 * canvas at all - ends at the association's own colour, which is what the cards wore before this
 * existed. So the failure is logged rather than surfaced: it is a nicety that did not arrive, not a
 * broken card.
 */
export async function loadLogoAccent(url: string): Promise<string | null> {
  const cached = cache.get(url);
  if (cached) return cached;

  const pending = (async () => {
    try {
      const pixels = await pixelsOf(url);
      if (!pixels) {
        Log.d(
          'logoAccent',
          `no 2d context for ${url.slice(0, 80)} - falling back to the asso colour`
        );
        return null;
      }
      const accent = accentFromPixels(pixels);
      Log.d(
        'logoAccent',
        `${url.slice(0, 80)} -> ${accent ?? 'no usable hue, using the fallback'}`
      );
      return accent;
    } catch (e) {
      Log.d(
        'logoAccent',
        `could not read ${url.slice(0, 80)} (${e instanceof Error ? e.message : String(e)}) - using the fallback`
      );
      return null;
    }
  })();

  cache.set(url, pending);
  return pending;
}

/** Test seam: forget every answer. Never called by the app - the cache lives as long as the tab. */
export function resetLogoAccentCache(): void {
  cache.clear();
}
