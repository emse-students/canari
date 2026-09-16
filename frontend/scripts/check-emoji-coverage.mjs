#!/usr/bin/env node
/**
 * Build-time proof that the picker's offered emoji are level with the bundled font.
 *
 * The picker offers exactly the entries in `static/emoji-data-fr.json` and `static/emoji-data-en.json`
 * (see `MessageEmojiPicker.svelte`), and every one of them must be drawable by the bundled font the
 * reader's engine actually picks (see `docs/wiki/frontend/emoji.md`) - offering an entry the font
 * cannot draw is the exact defect this work package exists to close, on the picker's own side.
 *
 * THERE IS MORE THAN ONE SHIPPED FONT SINCE 2026-09-16, SO THIS CHECKS EVERY ONE OF THEM. The
 * `src:` ladder in `app.css` hands Chromium and Firefox a COLRv1-only derivation and every other
 * engine the merged font, so a defect in the derivation is invisible to a check that reads only the
 * merged file. It was: the first derivation silently lost the format 14 cmap and 1034 of these
 * entries shaped to TWO glyphs instead of one - a font that still loaded and still drew most
 * things. A gate that reads one of two artefacts proves nothing about the one the reader gets.
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
/** Every font `app.css` can hand a reader - the merged last resort, and the COLRv1 derivation. */
const FONT_FILES = ['NotoColorEmoji-Canari.woff2', 'NotoColorEmoji-Canari-COLRv1.woff2'];
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

const misses = [];
let checked = 0;

for (const fontFile of FONT_FILES) {
  const ttfBytes = await wawoff2.decompress(readFileSync(join(ROOT, 'static/fonts', fontFile)));
  const font = new hb.Font(new hb.Face(new hb.Blob(ttfBytes)));

  for (const relPath of DATASETS) {
    const entries = JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
    for (const entry of entries) {
      checked++;
      const glyphIds = shapeGlyphIds(font, entry.emoji);
      const ok = glyphIds.length === 1 && glyphIds[0] !== 0;
      if (!ok) {
        misses.push({
          font: fontFile,
          dataset: relPath,
          emoji: entry.emoji,
          annotation: entry.annotation,
          glyphIds,
        });
      }
    }
  }
}

if (misses.length > 0) {
  const lines = misses
    .map(
      (m) =>
        `  ${m.font} / ${m.dataset}: "${m.emoji}" (${m.annotation}) -> ${m.glyphIds.length} glyph(s): [${m.glyphIds.join(', ')}]`
    )
    .join('\n');
  fail(
    `${misses.length} of ${checked} (offered emoji x bundled font) pairs do not resolve to exactly one glyph:\n${lines}\n` +
      `  Each is either a font to rebuild (see docs/wiki/frontend/emoji.md) or an entry to drop.`
  );
}

console.log(
  `[check-emoji-coverage] ${checked} (offered emoji x bundled font) pairs across ${DATASETS.length} ` +
    `dataset(s) and ${FONT_FILES.length} font(s) all resolve to one glyph`
);
