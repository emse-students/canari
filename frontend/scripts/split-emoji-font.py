"""Derive the COLRv1-only emoji font from the committed merged artefact.

WHY THERE ARE TWO FILES. The merged font carries COLR/CPAL (read by Chromium and Firefox) AND an
`SVG ` table (read by WebKit). No engine reads both, so every browser downloads a table it will
never open - and on Chromium and Firefox, which is nearly every reader, that table is 80.2% of the
5 705 472 bytes. Dropping it leaves 1 980 972, and `tech(color-COLRv1)` in `src:` is what lets
those engines ask for it by name while every other engine falls through to the merged font.

This is a LOCAL, ONCE-PER-REBUILD step, exactly like the `maximum_color` merge it reads from - see
`docs/wiki/frontend/emoji.md`. Nothing in CI runs it. What CI does check is the OUTPUT:
`check-emoji-coverage.mjs` shapes every offered emoji against every shipped font.

    python frontend/scripts/split-emoji-font.py

Deterministic: same input bytes, same output.
"""

import hashlib
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

FONTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "fonts")
MERGED = os.path.join(FONTS, "NotoColorEmoji-Canari.woff2")
OUT = os.path.join(FONTS, "NotoColorEmoji-Canari-COLRv1.woff2")


def sha256(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def every_mapped_codepoint(font):
    """Every codepoint the font maps, THE VARIATION SEQUENCES INCLUDED - and that is the whole trap.

    `getBestCmap()` returns one subtable and never the format 14 one, which is where the emoji
    presentation sequences live: 371 pairs here, `U+263A U+FE0F` -> the emoji face among them.
    Subsetting on its keys alone left those target glyphs unreachable, so the subsetter pruned them
    AND the format 14 subtable with them - and 1034 of the 3846 offered emoji then shaped to TWO
    glyphs (the base, then a stray glyph for the unmatched selector) instead of one. Silent: the
    font still loaded, still drew most things, and only the coverage check saw it.

    So the closure must name the selectors, the bases AND the glyphs the pairs point at.

    Both come back SORTED, and that is load-bearing rather than tidy: Python randomises `str`
    hashing per process, so a `set` of glyph NAMES iterates in a different order every run, the
    subsetter lays the glyphs out in that order, and the same input produced a different woff2 each
    time. Measured - two runs, two hashes. An artefact nobody can re-derive byte for byte cannot be
    checked against the table in the wiki.
    """
    unicodes, glyphs = set(), set()
    for table in font["cmap"].tables:
        if table.format == 14:
            for selector, pairs in table.uvsDict.items():
                unicodes.add(selector)
                for base, glyph_name in pairs:
                    unicodes.add(base)
                    if glyph_name:
                        glyphs.add(glyph_name)
        else:
            unicodes.update(table.cmap.keys())
    return sorted(unicodes), sorted(glyphs)


def main():
    font = TTFont(MERGED)

    # THE SECOND SOURCE OF DRIFT, AND IT IS A CLOCK. `save()` stamps `head.modified` with NOW
    # unless `SOURCE_DATE_EPOCH` says otherwise, so two runs of a pure function produced two
    # hashes even after the glyph order was pinned. The input's OWN `modified` is the honest
    # value: the derived font is that font minus a table, and it inherits when it was made.
    # fontTools counts from 1904-01-01; the variable is a Unix epoch, hence the constant.
    os.environ["SOURCE_DATE_EPOCH"] = str(font["head"].modified - 2_082_844_800)

    del font["SVG "]

    # The subsetter is what PROVES the drop is complete rather than a hand-kept glyph list: with a
    # table gone, whatever only it referenced falls out on its own, and the GSUB closure is what
    # keeps the ZWJ ligatures (families, flags) forming across the cut.
    unicodes, glyphs = every_mapped_codepoint(font)
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=unicodes, glyphs=glyphs)
    subsetter.subset(font)
    font.flavor = "woff2"
    font.save(OUT)

    merged_size = os.path.getsize(MERGED)
    out_size = os.path.getsize(OUT)
    produced = TTFont(OUT)
    if 14 not in {t.format for t in produced["cmap"].tables}:
        sys.exit("cmap format 14 was dropped - see every_mapped_codepoint()")
    print(f"in  NotoColorEmoji-Canari.woff2        {merged_size:>10,}  {sha256(MERGED)}")
    print(f"out NotoColorEmoji-Canari-COLRv1.woff2 {out_size:>10,}  {sha256(OUT)}")
    print(f"    {len(produced.getGlyphOrder()):,} glyphs, {100 * out_size / merged_size:.1f}% of the merged font")


if __name__ == "__main__":
    main()
