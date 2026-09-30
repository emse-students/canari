/**
 * The rules every generated icon obeys, in ONE place.
 *
 * The bird was too big on every surface and too big by DIFFERENT amounts: 0.76 of the
 * home-screen icon on iOS, and 0.5 of the Android adaptive canvas - where the launcher only shows
 * the central two thirds, so the bird filled three quarters of what the user sees. Two constants
 * in two scripts drifted apart without a review ever showing it. They live here now, and
 * `appIcons.test.ts` pins them.
 *
 * Chosen on a contact sheet at 40, 50 and 60 percent (user, 2026-09-30): 50.
 */
import sharp from 'sharp';

/** Width of the bird, as a fraction of the part of the icon a person actually SEES. */
export const BIRD_ICON_FILL = 0.5;

/**
 * Fraction of an Android adaptive-icon canvas the launcher shows whatever mask it applies: the
 * canvas is 108 dp and the always-visible window 72 dp. A foreground sized against the canvas
 * instead of the window comes out a third too large.
 */
export const ANDROID_VISIBLE = 72 / 108;

/**
 * What the Mi 9T launcher (Launcher3 Quickstep, Android 16) does on top of that, MEASURED on a
 * capture of its drawer: a bird sized at 0.5 of the window rendered at 0.74 of the round icon,
 * tail and beak on the edge - the launcher zooms the layers about 1.48x. The Android bird is
 * drawn at this fraction of the spec so its extremities sit near three quarters of the radius
 * there, and still clear the edge on a launcher that does not zoom.
 */
export const ANDROID_LAUNCHER_ZOOM_COMPENSATION = 0.75;

/**
 * The brand navy, `--color-cn-ink` in `app.css` and the `theme-color` in `app.html`, as the
 * MIDDLE of the background gradient: the icon stays the colour the app is wearing around it.
 */
export const NAVY = '#151B2C';

/** Background gradient, top to bottom, either side of {@link NAVY} (user, 2026-09-30). */
export const NAVY_TOP = '#1E2742';
export const NAVY_BOTTOM = '#0E1220';

/**
 * The gradient of the DEV / pre-release build, so a tester can tell it from production on the home
 * screen: the same two-stop shape pulled from navy to a deep violet (user, 2026-09-30). The bird
 * stays yellow - the tint says WHICH build, never which product.
 */
export const DEV_TOP = '#2E2152';
export const DEV_BOTTOM = '#150E2E';

/** The two palettes a launcher icon is built in, and the flag that picks one (`--dev`). */
export const BRAND_PALETTE = { top: NAVY_TOP, bottom: NAVY_BOTTOM };
export const DEV_PALETTE = { top: DEV_TOP, bottom: DEV_BOTTOM };
/** @param {string[]} argv */
export const paletteFor = (argv) => (argv.includes('--dev') ? DEV_PALETTE : BRAND_PALETTE);

/** The bird's yellow. NOT the app's `--cn-yellow`: the logo is the identity, the token is the UI. */
export const BIRD_YELLOW = '#fac809';

/**
 * The gradient as an opaque square PNG, `size` pixels on a side.
 *
 * @param {number} size Edge in pixels.
 * @param {'square' | 'squircle' | 'circle'} [mask] Shape to cut it to; transparent outside it.
 * @param {{ top: string, bottom: string }} [palette] The two stops; the brand navy by default.
 */
export function gradientBackground(
  size,
  mask = 'square',
  palette = { top: NAVY_TOP, bottom: NAVY_BOTTOM }
) {
  const shape = {
    square: `<rect width="${size}" height="${size}"/>`,
    squircle: `<rect width="${size}" height="${size}" rx="${Math.round(size * 0.2)}"/>`,
    circle: `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}"/>`,
  }[mask];
  const svg =
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${palette.top}"/><stop offset="1" stop-color="${palette.bottom}"/>` +
    `</linearGradient></defs><g fill="url(#g)">${shape}</g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * The same bird as a single colour, keeping only its alpha. The Android themed icon and the
 * status-bar icon are tinted by the system from the alpha channel alone, so the colour a caller
 * passes is whatever it wants to see in a preview.
 *
 * @param {Buffer} bird A PNG with an alpha channel.
 * @param {string} [color] Fill, as `#rrggbb`.
 */
export async function silhouette(bird, color = '#ffffff') {
  const { width, height } = await sharp(bird).metadata();
  const alpha = await sharp(bird).ensureAlpha().extractChannel(3).raw().toBuffer();
  const rgb = Buffer.from(color.slice(1), 'hex');
  const flat = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.copy(flat, i * 3);
  return sharp(flat, { raw: { width, height, channels: 3 } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}
