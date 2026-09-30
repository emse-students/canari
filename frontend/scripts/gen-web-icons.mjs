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
import { SVG, renderBird, renderCanvas } from './logo-render.mjs';
import { BIRD_ICON_FILL, gradientBackground } from './icon-spec.mjs';
import { packIco } from './ico.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATIC = path.join(ROOT, 'static');

/** Home-screen icon edge, in CSS pixels - the size every current iOS device asks for. */
const TOUCH_ICON_SIZE = 180;

/** Sizes packed into `favicon.ico`, smallest first. */
const ICO_SIZES = [16, 32, 48];

/**
 * iOS rounds the corners itself and applies no safe zone, so the bird is sized by the shared
 * `BIRD_ICON_FILL` alone and the background is the square gradient, flattened to drop the alpha.
 * It is a BIRD size, so `renderBird` adds the vector's own margin around it.
 */
async function makeTouchIcon() {
  const bird = await renderBird(Math.round(TOUCH_ICON_SIZE * BIRD_ICON_FILL));
  const out = path.join(STATIC, 'apple-touch-icon.png');
  await sharp(await gradientBackground(TOUCH_ICON_SIZE))
    .composite([{ input: bird, gravity: 'center' }])
    .flatten()
    .removeAlpha()
    .png()
    .toFile(out);
  return out;
}

async function makeFaviconIco() {
  const images = [];
  for (const size of ICO_SIZES) {
    images.push({ size, data: await renderCanvas(size) });
  }
  const out = path.join(STATIC, 'favicon.ico');
  await fs.writeFile(out, packIco(images));
  return out;
}

/**
 * `favicon.png`: the bird alone, trimmed to its own box and filling the canvas. The interface puts
 * it inside a navy tile of its own (header, login, QR badge), so it carries NO margin - unlike the
 * vector, whose margin exists for the circular masks.
 */
async function makeFaviconPng() {
  const out = path.join(STATIC, 'favicon.png');
  const rendered = await sharp(SVG, { density: 1200 }).png().toBuffer();
  const trimmed = await sharp(rendered).trim({ threshold: 0 }).toBuffer();
  await sharp(trimmed)
    .resize(337, 325, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out);
  return out;
}

async function main() {
  console.log(`wrote ${await makeTouchIcon()}`);
  console.log(`wrote ${await makeFaviconIco()}`);
  console.log(`wrote ${await makeFaviconPng()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
