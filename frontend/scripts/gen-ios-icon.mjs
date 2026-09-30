/**
 * Write `src-tauri/gen/apple/AppIcon.icon`, the Icon Composer document iOS 26 renders in its
 * default, dark and tinted appearances with the Liquid Glass treatment.
 *
 * It is a FOLDER (an `icon.json` and the layer artwork), so it can be written without the Mac
 * application that normally authors it. The format is Apple's and its schema is not published, so
 * what this writes is checked where it counts: the `ios.yml` compile check builds it with Xcode 26
 * and dumps the compiled appearances.
 *
 * The background is a FILL, not a layer - Icon Composer keeps the gradient out of the artwork so
 * that the system can darken or tint it per appearance. The bird is the only layer, taken from
 * `store/icons/layers/bird.svg` (`gen-icon-layers.mjs`), already sized by `BIRD_ICON_FILL`.
 *
 * Run from the `frontend` directory, after `gen-icon-layers.mjs`: `bun scripts/gen-ios-icon.mjs`
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAVY_BOTTOM, NAVY_TOP } from './icon-spec.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BIRD_SVG = path.resolve(ROOT, '..', 'store', 'icons', 'layers', 'bird.svg');
const OUT = path.join(ROOT, 'src-tauri', 'gen', 'apple', 'AppIcon.icon');

/** Dark appearance: the same two stops pulled towards black, so the icon recedes on a dark home screen. */
const DARK_TOP = '#141A2E';
const DARK_BOTTOM = '#080B14';

/** `#rrggbb` as the `srgb:r,g,b,a` string the document uses, components in 0..1. */
function srgb(hex) {
  const c = [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5));
  return `srgb:${c.join(',')},1.00000`;
}

/** A top-to-bottom linear gradient fill between two hex colours. */
function gradient(top, bottom) {
  return {
    'linear-gradient': [srgb(top), srgb(bottom)],
    orientation: { start: { x: 0.5, y: 0 }, stop: { x: 0.5, y: 1 } },
  };
}

async function main() {
  const doc = {
    fill: gradient(NAVY_TOP, NAVY_BOTTOM),
    'fill-specializations': [
      { value: gradient(NAVY_TOP, NAVY_BOTTOM) },
      { appearance: 'dark', value: gradient(DARK_TOP, DARK_BOTTOM) },
    ],
    groups: [
      {
        layers: [
          {
            'image-name': 'bird.svg',
            name: 'bird',
            glass: true,
            position: { scale: 1, 'translation-in-points': [0, 0] },
          },
        ],
        shadow: { kind: 'neutral', opacity: 0.5 },
        translucency: { enabled: true, value: 0.5 },
      },
    ],
    'supported-platforms': { squares: 'shared' },
  };
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, 'Assets'), { recursive: true });
  await fs.writeFile(path.join(OUT, 'icon.json'), `${JSON.stringify(doc, null, 2)}\n`);
  await fs.copyFile(BIRD_SVG, path.join(OUT, 'Assets', 'bird.svg'));
  console.log(`wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
