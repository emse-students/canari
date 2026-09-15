#!/usr/bin/env node
/**
 * Build-time proof that the picker's offered emoji are level with the bundled font.
 *
 * The picker offers exactly the entries in `static/emoji-data-fr.json` and `static/emoji-data-en.json`
 * (see `MessageEmojiPicker.svelte`), and every one of them must be drawable by the single bundled font
 * every surface in the app now falls back to (`NotoColorEmoji-Canari.woff2`, see
 * `docs/wiki/frontend/emoji.md`) - offering an entry the font cannot draw is the exact defect this
 * work package exists to close, on the picker's own side.
 *
 * "Drawable" means HarfBuzz shapes the entry's `emoji` codepoint sequence into EXACTLY ONE glyph -
 * not zero (nothing in the font maps that codepoint) and not more than one (the GSUB ligature that
 * turns a flag pair or a ZWJ family into a single glyph did not fire, so the app would draw separate
 * components instead of the merged picture). A miss is then a known fact, named here, rather than a
 * surprise on a member's screen: either the font needs rebuilding or the entry needs dropping.
 *
 * THE COMMITTED FONT IS WOFF2, AND HARFBUZZJS CANNOT READ IT DIRECTLY. This build of harfbuzzjs has
 * no WOFF2 decoder compiled in: handed the `.woff2` bytes as-is, `hb.Face` silently exposes zero
 * GSUB scripts and shapes every codepoint to glyph 0 - a font that LOOKS entirely empty, not a
 * decode error. Verified on the known-good source font too (`Noto-COLRv1.ttf` round-tripped through
 * the same woff2 save), so it is a harfbuzzjs limitation, not a defect in the merge. `wawoff2`
 * decompresses the bytes back to a plain TTF in memory first, which is what every check here shapes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hb from 'harfbuzzjs';
import wawoff2 from 'wawoff2';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_PATH = join(ROOT, 'static/fonts/NotoColorEmoji-Canari.woff2');
const DATASETS = ['static/emoji-data-fr.json', 'static/emoji-data-en.json'];

/** Glyph IDs HarfBuzz shapes `text` into, using the bundled font. Ignores the .notdef glyph (0). */
function shapeGlyphIds(font, text) {
  const buffer = new hb.Buffer();
  buffer.addText(text);
  buffer.guessSegmentProperties();
  hb.shape(font, buffer);
  return buffer.getGlyphInfos().map((g) => g.codepoint);
}

function fail(message) {
  console.error(`[check-emoji-coverage] ${message}`);
  process.exit(1);
}

const woff2Bytes = readFileSync(FONT_PATH);
const ttfBytes = await wawoff2.decompress(woff2Bytes);
const blob = new hb.Blob(ttfBytes);
const face = new hb.Face(blob);
const font = new hb.Font(face);

const misses = [];
let checked = 0;

for (const relPath of DATASETS) {
  const entries = JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
  for (const entry of entries) {
    checked++;
    const glyphIds = shapeGlyphIds(font, entry.emoji);
    const ok = glyphIds.length === 1 && glyphIds[0] !== 0;
    if (!ok) {
      misses.push({ dataset: relPath, emoji: entry.emoji, annotation: entry.annotation, glyphIds });
    }
  }
}

if (misses.length > 0) {
  const lines = misses
    .map(
      (m) =>
        `  ${m.dataset}: "${m.emoji}" (${m.annotation}) -> ${m.glyphIds.length} glyph(s): [${m.glyphIds.join(', ')}]`
    )
    .join('\n');
  fail(
    `${misses.length} of ${checked} offered emoji do not resolve to exactly one glyph in the bundled font:\n${lines}\n` +
      `  Each is either a font to rebuild (see docs/wiki/frontend/emoji.md) or an entry to drop.`
  );
}

console.log(
  `[check-emoji-coverage] ${checked} offered emoji across ${DATASETS.length} dataset(s) all resolve to one glyph in the bundled font`
);
