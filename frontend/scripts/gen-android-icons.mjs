/**
 * Regenerate every Android icon from `static/favicon.svg` and the rules in `icon-spec.mjs`:
 * the adaptive foreground, the themed (monochrome) layer, the gradient background layer and the
 * status-bar icon.
 *
 * The bird is `ANDROID_BIRD_DP` wide on the 108 dp canvas: Google's minimum logo size, its tips
 * inside the 66 dp safe circle, so no mask can crop it. The background is a gradient DRAWABLE
 * written here rather than a colour resource, so its numbers come from the one spec.
 *
 * No legacy `ic_launcher.png` / `ic_launcher_round.png` is written: `minSdk` is 28, so every
 * device resolves `@mipmap/ic_launcher` to the adaptive XML in `mipmap-anydpi-v26`, and the
 * manifest declares no `roundIcon`. They were drawn and never shown (deleted 2026-11-15).
 *
 * Run from the `frontend` directory: `bun scripts/gen-android-icons.mjs [--dev]`
 */
import sharp from 'sharp';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderBird } from './logo-render.mjs';
import { ANDROID_BIRD_DP, ANDROID_CANVAS_DP, paletteFor, silhouette } from './icon-spec.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
/** The pre-release build is tinted violet (`--dev`), applied by `android.yml` and never committed. */
const PALETTE = paletteFor(process.argv);
const RES = path.join(ROOT, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');

const FOREGROUND = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
/** Status-bar icon edge per density: 24 dp, which is what the system draws it at. */
const NOTIFICATION = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };
/** Fraction of the 24 dp status-bar icon the silhouette fills; the guideline leaves 2 dp a side. */
const NOTIFICATION_FILL = 20 / 24;

/** A transparent square with `layer` centred on it. */
function centred(canvas, layer) {
  return sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: layer, gravity: 'center' }])
    .png();
}

/** Adaptive layer: the bird `ANDROID_BIRD_DP` wide, for a canvas of `canvas` px (= 108 dp). */
function birdLayer(canvas) {
  return renderBird(Math.round((canvas * ANDROID_BIRD_DP) / ANDROID_CANVAS_DP));
}

async function makeForeground(canvas, outPath) {
  await centred(canvas, await birdLayer(canvas)).toFile(outPath);
}

/** Themed icon (Android 13+): the launcher tints the alpha, so the layer is one flat colour. */
async function makeMonochrome(canvas, outPath) {
  await centred(canvas, await silhouette(await birdLayer(canvas))).toFile(outPath);
}

async function makeNotification(size, outPath) {
  const bird = await renderBird(Math.round(size * NOTIFICATION_FILL));
  await centred(size, await silhouette(bird)).toFile(outPath);
}

/** The adaptive background layer, as a gradient drawable using the spec's two stops. */
async function writeBackgroundDrawable() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android">
  <gradient android:angle="270" android:startColor="${PALETTE.top}" android:endColor="${PALETTE.bottom}"/>
</shape>
`;
  await fs.mkdir(path.join(RES, 'drawable'), { recursive: true });
  await fs.writeFile(path.join(RES, 'drawable', 'ic_launcher_background.xml'), xml);
}

async function main() {
  for (const [bucket, size] of Object.entries(FOREGROUND)) {
    const dir = path.join(RES, `mipmap-${bucket}`);
    await makeForeground(size, path.join(dir, 'ic_launcher_foreground.png'));
    await makeMonochrome(size, path.join(dir, 'ic_launcher_monochrome.png'));
  }
  for (const [bucket, size] of Object.entries(NOTIFICATION)) {
    await makeNotification(size, path.join(RES, `drawable-${bucket}`, 'ic_notification.png'));
  }
  await writeBackgroundDrawable();
  console.log('Android icons regenerated.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
