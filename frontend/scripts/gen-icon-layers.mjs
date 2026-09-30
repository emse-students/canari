/**
 * Write the store icons and the LAYERS an icon editor needs (Icon Composer, Liquid Composer) into
 * `store/icons/`, from `static/favicon.svg` and the rules in `icon-spec.mjs`.
 *
 * - `play-store-512.png`: the Google Play listing icon. Full-bleed and opaque; Play cuts the corners.
 * - `app-store-1024.png`: the App Store icon, opaque (the store refuses an alpha channel).
 * - `layers/`: the bird alone on a transparent square (`bird.svg`, `bird-2048.png`), its flat
 *   one-colour silhouette for tinted/monochrome modes (`bird-mono-2048.png`), and the gradient
 *   (`background.svg`, `background-2048.png`). The bird is sized so that on the 1024 canvas it is
 *   `BIRD_ICON_FILL` wide, the same rule as every generated icon.
 *
 * Run from the `frontend` directory: `bun scripts/gen-icon-layers.mjs`
 */
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SVG, renderBird } from './logo-render.mjs';
import {
  BIRD_ICON_FILL,
  BIRD_YELLOW,
  NAVY_BOTTOM,
  NAVY_TOP,
  gradientBackground,
  silhouette,
} from './icon-spec.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', '..', 'store', 'icons');
const LAYERS = path.join(OUT, 'layers');

/** The logo canvas, in the vector's own units (see `static/favicon.svg`). */
const VIEW = { width: 337, height: 325 };

/** A square icon of `size` px: the gradient with the bird centred on it, opaque. */
async function composed(size) {
  const bird = await renderBird(Math.round(size * BIRD_ICON_FILL));
  return sharp(await gradientBackground(size))
    .composite([{ input: bird, gravity: 'center' }])
    .flatten()
    .removeAlpha()
    .png()
    .toBuffer();
}

/**
 * The bird alone as an SVG on a square viewBox in which it is `BIRD_ICON_FILL` wide and centred.
 * The bird's box is read off a render rather than assumed: the vector's margin is not symmetric.
 */
async function birdSvg() {
  const src = await fs.readFile(SVG, 'utf8');
  const inner = src.slice(src.indexOf('<g '), src.lastIndexOf('</svg>'));
  const png = await sharp(SVG, { density: 720 }).png().toBuffer();
  const { info } = await sharp(png).trim({ threshold: 0 }).toBuffer({ resolveWithObject: true });
  const { width: cw, height: ch } = await sharp(png).metadata();
  const k = VIEW.width / cw;
  const boxW = info.width * k;
  const cx = (-info.trimOffsetLeft + info.width / 2) * k;
  const cy = (-info.trimOffsetTop + info.height / 2) * (VIEW.height / ch);
  const side = boxW / BIRD_ICON_FILL;
  const vb = `${(cx - side / 2).toFixed(3)} ${(cy - side / 2).toFixed(3)} ${side.toFixed(3)} ${side.toFixed(3)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="1024" height="1024">\n${inner}</svg>\n`;
}

function backgroundSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${NAVY_TOP}"/><stop offset="1" stop-color="${NAVY_BOTTOM}"/>
  </linearGradient></defs>
  <rect width="1024" height="1024" fill="url(#g)"/>
</svg>
`;
}

async function main() {
  await fs.mkdir(LAYERS, { recursive: true });
  await fs.writeFile(path.join(OUT, 'play-store-512.png'), await composed(512));
  await fs.writeFile(path.join(OUT, 'app-store-1024.png'), await composed(1024));

  const svg = await birdSvg();
  await fs.writeFile(path.join(LAYERS, 'bird.svg'), svg);
  await fs.writeFile(path.join(LAYERS, 'background.svg'), backgroundSvg());

  const birdPng = await sharp(Buffer.from(svg), { density: 192 })
    .resize(2048, 2048)
    .png()
    .toBuffer();
  await fs.writeFile(path.join(LAYERS, 'bird-2048.png'), birdPng);
  await fs.writeFile(path.join(LAYERS, 'bird-mono-2048.png'), await silhouette(birdPng));
  await fs.writeFile(path.join(LAYERS, 'background-2048.png'), await gradientBackground(2048));
  console.log(`icon layers written to ${OUT} (bird ${BIRD_YELLOW})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
