/**
 * The launch-screen logo: the PERCH composition (see `perch-logo.mjs`) on a transparent ground, so
 * it sits on the launch screen's own background colour, light or dark.
 *
 * - iOS: `LaunchLogo.imageset` in `Assets.xcassets`, drawn by `LaunchScreen.storyboard`.
 * - Android: `drawable-xxhdpi/splash_logo.png`, drawn by `drawable/launch_background.xml` (every
 *   version) and handed to the Android 12+ system splash as its icon.
 *
 * Run from the `frontend` directory: `bun scripts/gen-splash-logo.mjs`
 */
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { perchLogo } from './perch-logo.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEN = path.resolve(__dirname, '..', 'src-tauri', 'gen');

/** Logo edge on the iOS launch screen, in points. */
const IOS_POINTS = 160;
/**
 * Android canvas in xxhdpi pixels: the 12+ splash masks an icon to a circle two thirds of its
 * canvas, so the composition - whose tail leaves its square - is drawn at half of the canvas.
 */
const ANDROID_CANVAS = 576;
const ANDROID_LOGO = 288;

async function writeIos() {
  const dir = path.join(GEN, 'apple', 'Assets.xcassets', 'LaunchLogo.imageset');
  await fs.mkdir(dir, { recursive: true });
  const images = [];
  for (const scale of [1, 2, 3]) {
    const filename = `launch-logo@${scale}x.png`;
    await fs.writeFile(path.join(dir, filename), await perchLogo(IOS_POINTS * scale));
    images.push({ idiom: 'universal', filename, scale: `${scale}x` });
  }
  await fs.writeFile(
    path.join(dir, 'Contents.json'),
    JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2) + '\n'
  );
}

async function writeAndroid() {
  const logo = await perchLogo(ANDROID_LOGO);
  const out = path.join(GEN, 'android', 'app', 'src', 'main', 'res', 'drawable-xxhdpi');
  await fs.mkdir(out, { recursive: true });
  await sharp({
    create: {
      width: ANDROID_CANVAS,
      height: ANDROID_CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toFile(path.join(out, 'splash_logo.png'));
}

await writeIos();
await writeAndroid();
console.log('Launch-screen logos regenerated.');
