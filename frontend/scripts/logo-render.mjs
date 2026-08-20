/**
 * Rendering `static/favicon.svg` to raster, shared by the web and Android icon
 * generators.
 *
 * It exists for ONE constant. The vector carries its own margin, so "how big is
 * the bird" and "how big is the canvas around it" are two different numbers, and
 * a second copy of the factor relating them would drift from the vector silently
 * - the symptom being launcher icons a tenth too small, on a surface nobody
 * looks at after a deploy.
 */
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The one drawing every icon in this repository comes from. */
export const SVG = path.resolve(__dirname, '..', 'static', 'favicon.svg');

/**
 * Fraction of the vector's canvas the bird itself occupies.
 *
 * The bird was reduced to this fraction, centred, so that it fits inside the
 * circle inscribed in its canvas: a consumer that masks the vector into a circle
 * - a browser tab chip, a launcher, a rounded tile - scales the WHOLE canvas and
 * has no margin of its own to give. The value is measured rather than chosen,
 * because the bird's tail and beak sit on opposite diagonals and so reach past
 * the circle long before they reach the square; `static/favicon.svg` carries the
 * figures. MUST stay in step with the `scale()` on that vector's `#logo` group;
 * `appIcons.test.ts` pins the two together, and pins the circle itself.
 */
export const LOGO_BIRD_FILL = 0.71;

/**
 * Renders the whole logo canvas, margin included, to a transparent square of
 * `box` pixels a side.
 *
 * This is what a caller wants when the box IS the icon - a favicon in a browser
 * tab - because there the vector's margin is the whole point.
 *
 * @param {number} box Edge of the output square, in pixels.
 * @returns {Promise<Buffer>} The rendered PNG.
 */
export function renderCanvas(box) {
  return sharp(SVG, { density: 1200 })
    .resize(box, box, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/**
 * Renders the logo so the BIRD - not the canvas around it - is `box` pixels
 * wide, cropped to its own bounding box.
 *
 * This is what a caller wants when it composites the bird onto a background it
 * paints itself and has already chosen the bird's size, as both the iOS
 * home-screen icon and the Android launcher foreground do.
 *
 * Rendered oversized and then trimmed, rather than either of the two obvious
 * one-liners, both of which are wrong: asking `renderCanvas` for a `box`-wide
 * canvas returns a bird a margin too SMALL, and compositing the oversized canvas
 * whole overflows any icon that is only `box` across - which is a hard sharp
 * error, and was, the first time the margin grew.
 *
 * @param {number} box Width the bird itself should come out at, in pixels.
 * @returns {Promise<Buffer>} The rendered PNG, cropped to the bird.
 */
export async function renderBird(box) {
  const padded = await renderCanvas(Math.round(box / LOGO_BIRD_FILL));
  return sharp(padded).trim({ threshold: 0 }).png().toBuffer();
}
