/**
 * Regenerate the desktop and iOS icons from `static/favicon.svg` and `icon-spec.mjs`.
 *
 * `tauri icon` knows every size and container (`.icns`, `.ico`, the Windows tiles, the whole iOS
 * set), so this script only builds its two 1024 px sources and copies the results where they live:
 *
 * - iOS: only `src-tauri/icons/ios`, the set `tauri ios init` reads. The icon the app ships is the
 *   Icon Composer document `gen/apple/AppIcon.icon` (`gen-ios-icon.mjs`). A full-bleed OPAQUE square. The system cuts the corners itself, and the App Store refuses
 *   a marketing icon with an alpha channel.
 * - desktop: the PERCH composition (`perch-logo.mjs`), transparent around it - the desktop set
 *   always showed it, and no system mask cuts a desktop icon.
 *
 * The Android files are not taken from `tauri icon`: they have layers it cannot express (the
 * gradient background, the themed layer, the status-bar icon) and come from `gen-android-icons.mjs`.
 *
 * Run from the `frontend` directory: `bun scripts/gen-native-icons.mjs`
 */
import sharp from 'sharp';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderBird } from './logo-render.mjs';
import { BIRD_ICON_FILL, gradientBackground } from './icon-spec.mjs';
import { perchLogo } from './perch-logo.mjs';
import { packIco } from './ico.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ICONS = path.join(ROOT, 'src-tauri', 'icons');
const SOURCE = 1024;

/** One 1024 px source: the gradient cut to `mask`, the bird centred on it. */
async function makeSource(mask, outPath, opaque) {
  const bird = await renderBird(Math.round(SOURCE * BIRD_ICON_FILL));
  let image = sharp(await gradientBackground(SOURCE, mask)).composite([
    { input: bird, gravity: 'center' },
  ]);
  if (opaque) image = image.flatten();
  await image.png().toFile(outPath);
}

/** Runs `tauri icon` on `source` into `outDir`; the CLI is the repo's own, not a global one. */
function tauriIcon(source, outDir) {
  const bin = path.join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tauri.exe' : 'tauri'
  );
  const run = spawnSync(bin, ['icon', source, '-o', outDir], { cwd: ROOT, stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`tauri icon failed for ${source}`);
}

/**
 * Re-encodes every PNG in `dir` without an alpha channel. `tauri icon` writes RGBA even from an
 * opaque source, and the App Store refuses an icon that HAS an alpha channel, opaque or not.
 */
async function stripAlpha(dir) {
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.png')) continue;
    const file = path.join(dir, name);
    await fs.writeFile(file, await sharp(file).removeAlpha().png().toBuffer());
  }
}

/**
 * Desktop sizes that must not be a 1024 px source scaled down: `tauri icon` shrinks the master, which
 * turns the bird into a smear at 32 px - the taskbar size. Each is rendered AT its size instead, and
 * the ICO is packed from natively rendered frames.
 */
const NATIVE_SIZES = {
  '32x32.png': 32,
  '64x64.png': 64,
  'Square30x30Logo.png': 30,
  'Square44x44Logo.png': 44,
  'StoreLogo.png': 50,
};
const ICO_FRAMES = [16, 24, 32, 48, 64, 256];

async function renderSmallDesktop() {
  for (const [name, size] of Object.entries(NATIVE_SIZES)) {
    await fs.writeFile(path.join(ICONS, name), await perchLogo(size));
  }
  const frames = [];
  for (const size of ICO_FRAMES) frames.push({ size, data: await perchLogo(size) });
  await fs.writeFile(path.join(ICONS, 'icon.ico'), packIco(frames));
}

async function copyAll(from, to, keep) {
  for (const name of await fs.readdir(from)) {
    if (keep(name)) await fs.copyFile(path.join(from, name), path.join(to, name));
  }
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'canari-icons-'));
  try {
    const desktopSource = path.join(tmp, 'desktop.png');
    const iosSource = path.join(tmp, 'ios.png');
    await fs.writeFile(desktopSource, await perchLogo(SOURCE));
    await makeSource('square', iosSource, true);

    const desktopOut = path.join(tmp, 'desktop');
    const iosOut = path.join(tmp, 'ios');
    tauriIcon(desktopSource, desktopOut);
    tauriIcon(iosSource, iosOut);

    await copyAll(desktopOut, ICONS, (n) => !['android', 'ios'].includes(n));
    await renderSmallDesktop();
    await stripAlpha(path.join(iosOut, 'ios'));
    await copyAll(path.join(iosOut, 'ios'), path.join(ICONS, 'ios'), (n) => n.endsWith('.png'));
    console.log('Desktop and iOS icons regenerated.');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
