/**
 * The PERCH composition: the canary standing on the bottom edge of a navy square, its tail hanging
 * out below and to the left. It is the brand mark wherever a surface shows the logo as a picture
 * of its own (the store listing, the link-preview image, the brand tile other sites embed) - as
 * opposed to the launcher icons, which are cut by a system mask and cannot carry a figure that
 * leaves its frame.
 *
 * The geometry is MEASURED on the original artwork (`og-canari.png`, 1080 px), not chosen: the
 * square is 67.9 percent of the canvas at its top right, the bird 74.8 percent wide, and the feet
 * rest 0.4 percent BELOW the square's lower edge - on it, not floating inside it, which is the whole
 * idea and what every first attempt got wrong. The background is transparent (user, 2026-09-30).
 */
import sharp from 'sharp';
import { renderBird } from './logo-render.mjs';
import { NAVY, NAVY_BOTTOM, NAVY_TOP } from './icon-spec.mjs';

/** Measured on the 1080 px original, as fractions of the canvas. */
const SQUARE = { x: 255 / 1080, y: 108 / 1080, side: 733 / 1080, radius: 0.115 };
/** Edge at and under which the square is flat navy. The bird is rendered AT the size, never shrunk. */
export const SMALL = 64;
const BIRD = { left: 92 / 1080, width: 808 / 1080, feetBelowEdge: 4 / 1080 };

/** Row of the lowest opaque pixel in the right 45 percent of the bird - its feet, not its tail. */
async function feetRow(bird) {
  const { data, info } = await sharp(bird)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let feet = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = Math.round(info.width * 0.55); x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 128) feet = Math.max(feet, y);
    }
  }
  return feet;
}

/**
 * The composition as a transparent square PNG of `size` px.
 *
 * @param {number} size Edge in pixels.
 * @param {{ top: string, bottom: string } | null} [gradient] Square fill; the brand gradient by
 *   default, `null` for the flat navy - which is the default at `SMALL` px and under, where a gradient
 *   is invisible and only costs the bird its contrast.
 */
export async function perchLogo(
  size,
  gradient = size <= SMALL ? null : { top: NAVY_TOP, bottom: NAVY_BOTTOM }
) {
  const s = SQUARE.side * size;
  const fill = gradient ? 'url(#g)' : NAVY;
  const defs = gradient
    ? `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${gradient.top}"/><stop offset="1" stop-color="${gradient.bottom}"/></linearGradient></defs>`
    : '';
  const tile = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${defs}` +
      `<rect x="${SQUARE.x * size}" y="${SQUARE.y * size}" width="${s}" height="${s}" rx="${SQUARE.radius * s}" fill="${fill}"/></svg>`
  );
  const bird = await renderBird(Math.round(BIRD.width * size));
  const feet = await feetRow(bird);
  const top = Math.round((SQUARE.y + SQUARE.side + BIRD.feetBelowEdge) * size - feet);
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: tile }, { input: bird, left: Math.round(BIRD.left * size), top }])
    .png()
    .toBuffer();
}
