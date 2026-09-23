/**
 * THE SHEET'S COLOURS, READ OFF THE PHOTOGRAPH THE SHEET WILL BE PRINTED ON.
 *
 * The monthly agenda PDF used to ask a human for fourteen colours. What a human actually does is
 * choose a picture - an Octobre Rose photograph, a snowy one in December - and then spend twenty
 * minutes hunting for the reds and greys that go with it. That hunt is arithmetic, so it belongs
 * here (user, 2026-09-23: *"tu pourrais faire aussi en sorte que les couleurs de mise en valeur
 * soient automatiquement modifiees a l'import d'une image pour que le theme soit harmonieux"*).
 *
 * The result is a STARTING POINT, not a lock: the three pickers stay, pre-filled. Nothing here
 * decides anything the user cannot immediately overrule.
 */
import { hslToHex } from '$lib/utils/color';

/** The three colours the calendar sheet still exposes, as {@link CalendarExportOptions} names them. */
export interface SheetPalette {
  textColor: string;
  accentColor: string;
  cellBg: string;
}

/**
 * Width the image is sampled at. 64 columns is ~3000 pixels once the height follows the aspect -
 * far more than a dominant hue needs, and small enough that the whole read is one synchronous pass
 * over a canvas nobody sees.
 */
const SAMPLE_WIDTH = 64;

/**
 * Pixels this pale or this dark are dropped before the hue vote.
 *
 * A photograph is mostly highlights and shadows, and both carry a hue that is real but meaningless:
 * the white blown-out corner of a flower picture is nominally orange. Voting on them returns the
 * hue of the exposure rather than the hue of the subject.
 */
const MIN_LIGHT = 0.12;
const MAX_LIGHT = 0.92;
/** Below this saturation a pixel is grey, and a grey pixel has no hue to contribute. */
const MIN_SAT = 0.12;

/** Above this mean luminance the image is treated as a light one - see {@link paletteFromImage}. */
const LIGHT_IMAGE_LUMINANCE = 0.45;

interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** sRGB (0-255) to HSL, hue in degrees. */
function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function hsl(h: number, s: number, l: number): string {
  return hslToHex(`hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`);
}

/** Draws `image` into an offscreen canvas at {@link SAMPLE_WIDTH} and returns its pixels. */
function sample(image: HTMLImageElement): Uint8ClampedArray | null {
  const ratio = image.naturalHeight / image.naturalWidth;
  const width = SAMPLE_WIDTH;
  const height = Math.max(1, Math.round(width * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    console.warn('[SheetPalette] No 2D context - the palette keeps whatever the user had.');
    return null;
  }
  ctx.drawImage(image, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

/**
 * The dominant hue of a set of pixels, in degrees, or null when the image has no usable hue at all
 * (a black-and-white photograph, which is a real answer rather than a failure).
 *
 * The vote is a SUM OF UNIT VECTORS weighted by saturation, which makes this the saturation-weighted
 * circular MEAN hue rather than the modal one - worth saying plainly, because the name suggests a
 * mode and a scene of two strong colours answers with the arc between them, not with either.
 *
 * Bucketing was the alternative and it is worse twice over. Hue is circular, so a histogram has a
 * seam: a red subject spread either side of 0 lands in the 350s and the 0s and loses to anything
 * concentrated, and averaging the hue NUMBERS of those same pixels returns 179 - cyan, a colour not
 * in the picture at all. Vectors have no origin and no bucket edge, so nothing on the wheel is a
 * special place; turn the picture and the answer turns with it.
 *
 * Exported for its test: it is the one claim in this file a browser cannot be asked to settle, and
 * it takes raw pixels, so a test can hand it the exact seam case that a histogram gets wrong.
 */
export function dominantHue(pixels: Uint8ClampedArray): number | null {
  let x = 0;
  let y = 0;
  let weight = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const { h, s, l } = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (s < MIN_SAT || l < MIN_LIGHT || l > MAX_LIGHT) continue;
    const radians = (h * Math.PI) / 180;
    x += Math.cos(radians) * s;
    y += Math.sin(radians) * s;
    weight += s;
  }
  if (weight === 0) return null;
  const magnitude = Math.hypot(x, y) / weight;
  // A near-zero resultant means the hues cancelled out - a picture with no dominant colour rather
  // than one whose dominant colour happens to sit at 0 degrees.
  if (magnitude < 0.08) return null;
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Mean perceived luminance (0-1) of a set of pixels, highlights and shadows included. */
function meanLuminance(pixels: Uint8ClampedArray): number {
  let total = 0;
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    total += (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) / 255;
    count += 1;
  }
  return count === 0 ? 0.5 : total / count;
}

/**
 * The three sheet colours that go with `dataUrl`, or null when the image cannot be read.
 *
 * THE TEXT IS WHITE AND THAT IS NOT LAZINESS. On the sheet this copies, white type sits on a pale
 * pink photograph and reads perfectly - because what separates it from the background is the hard
 * offset duplicate behind it, not its own contrast. So the derivation spends its one degree of
 * freedom on the ACCENT, which is that duplicate, and flips it dark or light depending on whether
 * the photograph is light or dark. A light image gets a deep accent; a dark one gets a bright accent
 * that can still be seen against it.
 *
 * `null` is returned rather than a guess when the image has no dominant hue (a monochrome photo) -
 * the caller keeps the colours the user already had, which is better than tinting a grey picture.
 */
export async function paletteFromImage(dataUrl: string): Promise<SheetPalette | null> {
  const image = new Image();
  image.src = dataUrl;
  try {
    await image.decode();
  } catch (error) {
    console.warn(`[SheetPalette] Image could not be decoded: ${String(error)}`);
    return null;
  }

  const pixels = sample(image);
  if (!pixels) return null;

  const hue = dominantHue(pixels);
  if (hue === null) {
    console.warn('[SheetPalette] No dominant hue in this image - the palette is left alone.');
    return null;
  }
  const isLight = meanLuminance(pixels) >= LIGHT_IMAGE_LUMINANCE;

  return {
    textColor: '#ffffff',
    accentColor: isLight ? hsl(hue, 0.68, 0.32) : hsl(hue, 0.62, 0.62),
    // The cells are the one neutral on the sheet: the same hue, drained almost to grey, so they
    // belong to the picture without competing with the association colours they carry.
    cellBg: isLight ? hsl(hue, 0.08, 0.52) : hsl(hue, 0.08, 0.68),
  };
}
