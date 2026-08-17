/**
 * Regenerate the two web icons the convention paths ask for, from the same
 * `static/favicon.svg` the Android launcher icons come from.
 *
 * Both files are BINARY and committed, so this script exists to make them
 * reproducible when the logo changes - otherwise the next person redraws them by
 * hand and the two surfaces drift apart.
 *
 * `apple-touch-icon.png` is deliberately OPAQUE: iOS composites a transparent
 * home-screen icon onto black, which turns the navy bird into a black square
 * with a bird in it. The navy is painted here instead, and it is the same
 * `--color-canvas` the splash screen uses.
 *
 * `favicon.ico` carries three sizes rather than one, because the consumers that
 * still ask for this path pick a size out of the container (a browser tab wants
 * 16, a Windows shortcut 32, a bookmark bar 48) and a single-size .ico is
 * rescaled by whoever reads it, badly, at exactly the sizes where one pixel
 * matters. The payloads are PNG, which every consumer that has asked for this
 * path in the last decade reads.
 *
 * Run from the `frontend` directory: `node scripts/gen-web-icons.mjs`
 */
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG = path.join(ROOT, 'static', 'favicon.svg');
const STATIC = path.join(ROOT, 'static');

/** `--color-canvas` in `app.css`, and the `theme-color` in `app.html`. */
const NAVY = { r: 0x15, g: 0x1b, b: 0x2c, alpha: 1 };

/** Home-screen icon edge, in CSS pixels - the size every current iOS device asks for. */
const TOUCH_ICON_SIZE = 180;

/**
 * Fraction of the touch icon the bird occupies.
 *
 * iOS rounds the corners itself and applies no safe zone, so this is margin
 * rather than crop protection: at 1.0 the bird would touch the rounded edge.
 */
const TOUCH_ICON_BIRD_SCALE = 0.76;

/** Sizes packed into `favicon.ico`, smallest first. */
const ICO_SIZES = [16, 32, 48];

/** Renders the logo to a transparent square of `box` pixels a side. */
function renderBird(box) {
  return sharp(SVG, { density: 1200 })
    .resize(box, box, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function makeTouchIcon() {
  const bird = await renderBird(Math.round(TOUCH_ICON_SIZE * TOUCH_ICON_BIRD_SCALE));
  const out = path.join(STATIC, 'apple-touch-icon.png');
  await sharp({
    create: {
      width: TOUCH_ICON_SIZE,
      height: TOUCH_ICON_SIZE,
      channels: 4,
      background: NAVY,
    },
  })
    .composite([{ input: bird, gravity: 'center' }])
    .png()
    .toFile(out);
  return out;
}

/**
 * Packs already-encoded PNGs into an ICO container.
 *
 * The header is 6 bytes, then one 16-byte directory entry per image, then the
 * payloads. A dimension of 256 is written as 0, which is the format's own
 * convention - not a concern at these sizes, but writing the encoding rather
 * than the value keeps the function honest if a 256 is ever added.
 */
function packIco(images) {
  const HEADER_BYTES = 6;
  const ENTRY_BYTES = 16;
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = HEADER_BYTES + ENTRY_BYTES * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(ENTRY_BYTES);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette colours - 0 for truecolour
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

async function makeFaviconIco() {
  const images = [];
  for (const size of ICO_SIZES) {
    images.push({ size, data: await renderBird(size) });
  }
  const out = path.join(STATIC, 'favicon.ico');
  await fs.writeFile(out, packIco(images));
  return out;
}

async function main() {
  console.log(`wrote ${await makeTouchIcon()}`);
  console.log(`wrote ${await makeFaviconIco()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
