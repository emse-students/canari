#!/usr/bin/env bun
/**
 * Build-time proof that every emoji the picker offers is drawn as a picture.
 *
 * The app draws emoji as Noto's SVGs, not with a font (since 2026-09-25, `docs/wiki/frontend/emoji.md`).
 * The picker offers exactly the entries of `static/emoji-data-fr.json` and `static/emoji-data-en.json`,
 * and offering one the app cannot draw is the defect this gate exists to close. It fails on:
 *
 * - `static/emoji/` holding anything but the ONE set `emojiSvgNames.json` names (a stale set would
 *   ship twice, a missing one would break every picture);
 * - the name list and the files disagreeing (a listed picture that 404s, or a file nothing draws);
 * - any offered emoji, skin tones included, for which the runtime rule answers "no picture".
 *
 * Every failure names what to run: `tools/emoji-svg/build.mjs`, never a hand edit. Until 2026-09-25
 * this gate shaped the entries against the bundled fonts with harfbuzz; the fonts are gone, and so is
 * that half.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATASETS = ['static/emoji-data-fr.json', 'static/emoji-data-en.json'];

function fail(message) {
  console.error(`[check-emoji-coverage] ${message}`);
  process.exit(1);
}

// Imported, not re-implemented: the gate applies the RUNTIME's own rule (`emojiSvgSrc`), both halves
// of it - presentation and "a picture exists" - so a gate that passes is a picker whose every offer
// is drawn, skin tones included.
const { emojiSvgSrc } = await import('../src/lib/utils/emojiSvg.ts');
const { set: svgSet, names: svgNames } = JSON.parse(
  readFileSync(join(ROOT, 'src/lib/utils/emojiSvgNames.json'), 'utf8')
);
const sets = readdirSync(join(ROOT, 'static/emoji'), { withFileTypes: true }).filter((d) =>
  d.isDirectory()
);
if (sets.length !== 1 || sets[0].name !== svgSet) {
  fail(
    `static/emoji/ must hold exactly the set emojiSvgNames.json names (${svgSet}), found: ` +
      `${sets.map((d) => d.name).join(', ') || 'none'}. Re-run tools/emoji-svg/build.mjs.`
  );
}
const svgFiles = readdirSync(join(ROOT, 'static/emoji', svgSet))
  .filter((f) => f.endsWith('.svg'))
  .map((f) => f.slice(0, -4));

const listed = new Set(svgNames);
const onDisk = new Set(svgFiles);
const unlisted = svgFiles.filter((n) => !listed.has(n));
const missingFiles = svgNames.filter((n) => !onDisk.has(n));
if (unlisted.length > 0 || missingFiles.length > 0) {
  fail(
    `static/emoji/${svgSet}/ and emojiSvgNames.json disagree - ${missingFiles.length} listed without a file ` +
      `(${missingFiles.slice(0, 10).join(', ')}), ${unlisted.length} files never listed ` +
      `(${unlisted.slice(0, 10).join(', ')}). Re-run tools/emoji-svg/build.mjs; never edit either by hand.`
  );
}

const undrawn = [];
let offered = 0;
for (const relPath of DATASETS) {
  for (const entry of JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'))) {
    for (const emoji of [entry.emoji, ...(entry.skins ?? []).map((skin) => skin.emoji)]) {
      offered++;
      if (emojiSvgSrc(emoji) === null)
        undrawn.push(`  ${relPath}: "${emoji}" (${entry.annotation})`);
    }
  }
}
if (undrawn.length > 0) {
  fail(
    `${undrawn.length} of ${offered} offered emoji (skin tones included) have no picture:\n${undrawn.join('\n')}\n` +
      `  Each is a Noto commit to move forward (tools/emoji-svg/build.mjs) or an entry the picker must not offer.`
  );
}
console.log(
  `[check-emoji-coverage] ${offered} offered emoji (skin tones included) across ${DATASETS.length} dataset(s) ` +
    `all have a picture, and the ${svgNames.length} pictures match their list`
);
