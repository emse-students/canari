/**
 * Regenerate Android launcher icons from the bird-only favicon SVG.
 *
 * Fixes the "too zoomed" adaptive icon: the foreground now contains only the
 * bird centered within the adaptive-icon safe zone (~62% of the canvas) on a
 * transparent background, so the launcher mask never crops it. The navy comes
 * from the `ic_launcher_background` color layer. Legacy (pre-API 26) icons get
 * a navy rounded square / circle with the same centered bird.
 *
 * Run from the `frontend` directory: `node scripts/gen-android-icons.mjs`
 */
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG = path.join(ROOT, 'static', 'favicon.svg');
const RES = path.join(ROOT, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');

const NAVY = '#151B2C';
const BIRD_SCALE = 0.62;

const FOREGROUND = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

function renderBird(box) {
  return sharp(SVG, { density: 1200 })
    .resize(box, box, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

function roundedRectSvg(size) {
  const r = Math.round(size * 0.2);
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${NAVY}"/></svg>`
  );
}

function circleSvg(size) {
  const r = size / 2;
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${r}" cy="${r}" r="${r}" fill="${NAVY}"/></svg>`
  );
}

async function makeForeground(canvas, outPath) {
  const bird = await renderBird(Math.round(canvas * BIRD_SCALE));
  await sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: bird, gravity: 'center' }])
    .png()
    .toFile(outPath);
}

async function makeLegacy(size, outPath, round) {
  const bgSvg = round ? circleSvg(size) : roundedRectSvg(size);
  const bg = await sharp(bgSvg).png().toBuffer();
  const bird = await renderBird(Math.round(size * BIRD_SCALE));
  await sharp(bg)
    .composite([{ input: bird, gravity: 'center' }])
    .png()
    .toFile(outPath);
}

async function main() {
  const only = process.argv[2];
  if (only === 'test') {
    await makeForeground(432, path.join(ROOT, 'icon-test-foreground.png'));
    await makeLegacy(192, path.join(ROOT, 'icon-test-legacy.png'), false);
    await makeLegacy(192, path.join(ROOT, 'icon-test-round.png'), true);
    console.log('wrote test icons to frontend/');
    return;
  }
  for (const [bucket, size] of Object.entries(FOREGROUND)) {
    await makeForeground(size, path.join(RES, `mipmap-${bucket}`, 'ic_launcher_foreground.png'));
  }
  for (const [bucket, size] of Object.entries(LEGACY)) {
    await makeLegacy(size, path.join(RES, `mipmap-${bucket}`, 'ic_launcher.png'), false);
    await makeLegacy(size, path.join(RES, `mipmap-${bucket}`, 'ic_launcher_round.png'), true);
  }
  console.log('Android launcher icons regenerated.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
