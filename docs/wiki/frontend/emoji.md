# Bundled emoji font

**Decided 2026-08-23** ([backlog](../backlog.md), "P2 - the app draws emoji with the platform's
font"): Canari bundles **Noto Color Emoji** and draws every emoji with it, everywhere, on every
platform - so the same codepoint is the same picture on Android, iOS, Windows and Linux, and the
picker never depends on a third-party CDN. Why Noto over Microsoft's Fluent Emoji (rejected on
coverage: no flags, no ZWJ families, frozen at Unicode 15.1), the exact numbers measured on Noto's
git tree, and the licence terms are all in the backlog entry - not restated here.

## PICTURES REPLACE THE FONT - decided 2026-09-25, in four pull requests

**The user's decision**: the font never drew on WebKit (Safari and the iOS app showed Apple's glyphs,
[backlog](../backlog.md)), so every emoji becomes Noto's own SVG drawn as an `<img>` - on every
platform, one mechanism, the same pictures the font carried. Four pull requests, in this order: **(1)**
the pictures, the runtime rule, the build gate, and the first surfaces (message text, search hits,
reaction pills); **(2)** every other surface; **(3)** the picker drawn by our own grid; **(4)** the fonts
deleted. Everything below this section describes the font, and stays true until (4) removes it.

**Decided with the user, not to be re-opened**: Noto rather than Twemoji (same art as the font, the
2026-08-23 coverage argument unchanged); pictures EVERYWHERE rather than on Apple only (one mechanism);
the composer keeps the platform glyph while typing (`MentionComposerInput` is a `contenteditable`, so
pictures there are possible - the decision is about risk, not ability).

### The pictures, and how they were made

`tools/emoji-svg/build.mjs` (header comment = the procedure) takes noto-emoji at commit
`e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e`: the union of `2D/svg` and
`third_party/region-flags/waved-svg` (the waved flags the font drew, subdivisions included), **4012
pictures**, no overlap between the two. Licences sit next to them: Apache 2.0 (`2D/svg/LICENSE`) and
public domain (region flags). They are written to `frontend/static/emoji/<set>/`, where `<set>` is a
12-hex hash of every name and byte - so nginx serves `/emoji/` `immutable` for a year and a browser
fetches each picture once, ever.

**svgo is NOT lossless on this set with its default preset - measured, and three plugins are off.**
Every original and its optimised copy drawn by Chromium at 64 px and compared per pixel (a pixel counts
when a channel moves by more than 32):

| svgo@4.1.0 preset-default, `multipass` | pictures over 40 px changed | worst | compressed |
| --- | --- | --- | --- |
| everything on | 1 of 402 sampled | U+1FAE2, **1307 / 4096** | 1.00 MB / 2.09 MB sample |
| `convertTransform` off | 3 of 4012 | U+1F69F, 99 | - |
| **also `convertShapeToPath`, `convertPathData` off (shipped)** | **0 of 4012** | **U+26D3, 37 (edge antialiasing)** | **12.9 MB / 21.1 MB** |

Each plugin was found by disabling the preset's plugins one at a time against the damaged files; the
regenerated set is byte-identical to the one measured. resvg could not do this measurement: the
native addon crashed Bun 1.4.2, and the WASM build traps on one file and is unusable afterwards.

### The rule, in one module

`frontend/src/lib/utils/emojiSvg.ts`. A grapheme (`Intl.Segmenter`) is a picture only if BOTH:

1. **It presents as an emoji**: it carries U+FE0F, or a code point is `Emoji_Presentation`. Noto draws
   `©`, `™`, `↔` and every digit, and in `© 2026` those are text. This is `RGI_Emoji` without the regex
   `v` flag, which the WebKit of iOS 16 cannot parse (a SyntaxError at module load blanks the app).
2. **A picture exists**: its name is in `emojiSvgNames.json` (`{ set, names }`, 72 kB raw, 11 kB gzip
   in the bundle). A sequence newer than the pinned Noto, or an unassigned flag pair like `🇿🇿`, stays
   text - never a broken image.

`EmojiText.svelte` renders the split: text nodes and `<img class="emoji" alt="<the emoji>">`, no
wrapper, sized `1.2em` by `app.css` so it follows the text it sits in (jumbomoji included).

**Copying keeps the emoji, measured**: in Chromium the clipboard carries the `alt` (`salut 😀 ça va`
round-trips), and Firefox is known to do the same. `Selection.toString()` does NOT include it, which is
why the clipboard, not the selection, was measured. **WebKit's copy is unmeasured** - owed on the
iPhone, and not written against before it is seen.

### Where the pictures are drawn - and the rule for a new surface

**Any user-written text printed into the page goes through `EmojiText`** (or reaches it through one
of the three chokepoints below); an app string from Paraglide, a count and anything in an attribute
(`title`, `aria-label`, `alt`) stay text - an attribute cannot hold a picture, and the platform glyph
there is expected.

| Chokepoint | Covers |
| --- | --- |
| `MessageInlineText` (and the search `<mark>` beside it in `MessageTextBody`) | message bodies, media captions, search hits |
| `POST_MARKDOWN_RENDERERS.rawtext` (`postMarkdownRenderers.ts`, the ONE renderer set for posts, comments and bios - it was three copies) | every Markdown leaf of prose; code blocks and inline code keep characters |
| `EmojiText` directly | reply quotes and the composer's reply preview, pinned messages, conversation names and previews, mention chips, system lines, every reaction surface (pills, quick reactions, the mobile sheet, the reactors panel, post reactions), notifications, poll questions and options, post and comment authors, community, salon and user names, toasts |

`postMarkdownRenderers.svelte.test.ts` proves the `rawtext` override is REACHED (the library honours
it only because it looks for one), with a control: without the key, the picture count fails.
`iconButtonScale.test.ts` reads `<EmojiText />` as text, so a reaction button stays a text button.

**Deliberately NOT pictures**: the composer while typing (decided with the user), the message edit
`<textarea>` and comment edit `<input>` (form fields cannot hold one), the OS notification shade and
anything else the platform draws.

### The gate

`check-emoji-coverage.mjs` (in `bun run build`) now checks the pictures first, importing the runtime's
own `emojiSvgSrc` rather than re-implementing it: `static/emoji/` holds exactly one set, the one the
list names; the list and the files agree; and every emoji the picker offers, **skin tones included
(7906, where the font half checks 7692 without them)**, has a picture.

## The format problem, and why one file solves it - and why it is then split in two

No single colour-font table is read by every engine Canari ships on:

| Table | Chromium (WebView2, Android WebView, Chrome/Edge) | WebKit (WKWebView, Safari) | Firefox |
| --- | --- | --- | --- |
| COLRv1 | yes | no (WebKit standards-positions 415) | yes |
| OT-SVG (`SVG` table) | no, ever | yes | yes |

`maximum_color`, from Google's own `nanoemoji` (the tool that builds Noto), merges both tables into
ONE font: each engine reads the table it understands, from a single `.woff2`. **That single file is
still the source of truth, and still what an engine gets if it cannot say what it can read** - the
split below derives from it and never replaces it. `nanoemoji` calls
itself "under active development, doubtless full of bugs", so it is never a CI dependency - the
font is built ONCE, locally, and the produced binary is committed. Nothing in CI can build this one
(the opposite disposition to `frontend/src/lib/wasm/`, which every pipeline generates for itself).

## Provenance - reproduce or verify the committed artefact

Source: `googlefonts/noto-emoji`, OFL 1.1, commit `8998f5dd683424a73e2314a8c1f1e359c19e8742`
(`main` on 2026-09-15). The prebuilt `fonts/Noto-COLRv1.ttf` already carries country flags (measured
in the backlog entry against the no-flags variant), so it is the merge's only input.

```sh
python3 -m venv /tmp/emoji-font-build/venv
/tmp/emoji-font-build/venv/bin/pip install nanoemoji==0.16.0 brotli
curl -LO https://raw.githubusercontent.com/googlefonts/noto-emoji/main/fonts/Noto-COLRv1.ttf
cp Noto-COLRv1.ttf NotoColorEmoji-Canari.ttf
# nanoemoji shells out to `picosvg`/`resvg` by NAME (via ninja), so the venv's own bin/ must be on
# PATH for the subprocess - activating the venv alone is not enough.
PATH="/tmp/emoji-font-build/venv/bin:$PATH" /tmp/emoji-font-build/venv/bin/maximum_color NotoColorEmoji-Canari.ttf
```

**Do not pass `--bitmaps`**: Chrome and anything on Skia *prefers* CBDT to COLR when both tables are
present, and CBDT is a ~10 MB table nobody asked for (weight is explicitly not a factor in the
user's decision, but drawing the WRONG table is a defect regardless). Verified on the committed
artefact: no `CBDT`/`CBLC`/`sbix`/`EBDT`/`EBLC` table.

The merge is single-threaded and took ~55 minutes for this run (~8000 glyphs, most of it the
`nanoemoji.write_font` step) - it is not a CI dependency (see above), so this cost is paid once,
locally, per rebuild. It does NOT write in place: the final merged font lands at
`build/Font.ttf`, carrying both `COLR`+`CPAL` (from the source) and the new `SVG ` table (added by
`maximum_color`), plus the `GSUB` ligatures. That file is converted to `.woff2` with fontTools:

```python
from fontTools.ttLib import TTFont
f = TTFont("build/Font.ttf")
f.flavor = "woff2"  # needs the `brotli` package installed
f.save("NotoColorEmoji-Canari.woff2")
```

...and committed as `frontend/static/fonts/NotoColorEmoji-Canari.woff2`, alongside
`frontend/static/fonts/OFL.txt` (the licence must travel with the binary - one of the two real OFL
obligations, the other being that the font is never sold on its own).

| | |
| --- | --- |
| Source commit | `8998f5dd683424a73e2314a8c1f1e359c19e8742` |
| Source file | `fonts/Noto-COLRv1.ttf`, sha256 `0ae57fe58645638523ba35f388d93739d292539a9acb84df5700c81b1e1a28d2` |
| nanoemoji | 0.16.0 (`maximum_color`) |
| Committed artefact | `frontend/static/fonts/NotoColorEmoji-Canari.woff2`, 5 705 472 bytes, sha256 `d1bdd49068ebbbc3706bd8fc8b346c237437d804698f340aba03194ba5f671e6` |
| Tables present | `COLR`+`CPAL` (source), `SVG ` (added), `GSUB` (ligatures) - verified with `fontTools.ttLib`; no `CBDT`/`CBLC`/`sbix`/`EBDT`/`EBLC` bitmap table |

## The COLRv1 derivation - 34.7% of the bytes, the same pixels

**No engine reads both tables, so nearly every reader downloads one it will never open.** On the
merged artefact the `SVG ` table is **80.2%** of 5 705 472 bytes, and Chromium and Firefox - which
is nearly every reader here - never touch it. `frontend/scripts/split-emoji-font.py` drops it and
subsets what is left:

| | |
| --- | --- |
| Input | `NotoColorEmoji-Canari.woff2`, 5 705 472 bytes, sha256 `d1bdd490...5f671e6` |
| Output | `NotoColorEmoji-Canari-COLRv1.woff2`, **1 981 256 bytes (34.7%)**, sha256 `cf9f21500f515413f40e508894756b03d5b2bbcb1999753907ba27d7f6d1570d` |
| Glyphs | 41 863 - unchanged; the COLR layer glyphs ARE the picture, so none of them is spare |
| Command | `python frontend/scripts/split-emoji-font.py` |

Like the merge it reads from, this is a LOCAL once-per-rebuild step and never a CI dependency. What
CI checks is the output, below.

**THE FIRST TRAP: `getBestCmap()` NEVER RETURNS THE VARIATION-SEQUENCE SUBTABLE.** The emoji
presentation sequences live in cmap format 14 - 371 pairs here, `U+263A U+FE0F` -> the emoji face
among them. Subsetting on the best cmap's keys alone left those target glyphs unreachable, so the
subsetter pruned them and the format 14 subtable with them, and **1034 of the 3846 offered emoji
then shaped to TWO glyphs** (the base, then a stray glyph for the unmatched selector). Nothing
announced it: the font loaded, and drew most things. The closure must name the selectors, the bases
AND the glyphs the pairs point at, and the script asserts format 14 survived before it exits.

**THE SECOND TRAP: THE SAME INPUT PRODUCED A DIFFERENT FILE EVERY RUN**, measured twice, for two
reasons that both had to go. Python randomises `str` hashing per process, so a `set` of glyph NAMES
iterates in a different order each time and the subsetter lays glyphs out in that order - hence the
sorted closure. And `save()` stamps `head.modified` with the clock unless `SOURCE_DATE_EPOCH` says
otherwise - hence the input font's own `modified`, which is the honest value for a derivation. **An
artefact nobody can re-derive byte for byte cannot be checked against the table above.**

**THE RENDER PROOF, AND WHY SHAPING WAS NOT ENOUGH.** Shaping says the cmap and GSUB survived; it
says nothing about whether the colour table still draws. Both fonts were rastered to canvas in
Chrome 153 at 64 px over eight clusters chosen to exercise what a subset breaks - a ZWJ family, two
regional-indicator flags, a skin-tone modifier sequence and a VS16 sequence - and compared:

| | |
| --- | --- |
| Differing subpixels | **0 of 360 000** |
| Advance width | 637.5 px, both |
| Files fetched through the `app.css` ladder | `NotoColorEmoji-Canari-COLRv1.woff2` only, 1 981 256 bytes |

The merged font is **never requested** by an engine that understands the first source line. The
same probe run against an SVG-only derivation painted **0 pixels** in Chrome, which is the other
half of the proof: the two tables really are disjoint, and Chromium really does read only one.

**THE COST, NAMED: THE NATIVE APPS CARRY +2 MB THEY NEVER USE.** `frontendDist: "../build"` means
an APK and an IPA EMBED `static/`, so both now ship both fonts while each reads exactly one - the
Android WebView is Chromium and takes the derivation, WKWebView is WebKit and takes the merged file.
The web pays nothing for this (a browser downloads one file and the other is never requested) and
the store binaries pay ~2 MB of install size for nothing. **It is accepted rather than unnoticed**:
the measurement this work serves is a cold start in a BROWSER, where the font crosses the network,
and an embedded font crosses nothing. Splitting `static/` per platform at build time would close it
and is a bigger change than this one.

**AN SVG-ONLY DERIVATION IS NOT SHIPPED, DELIBERATELY.** The same script shape produces one (4 033
glyphs, 3 730 056 bytes, 65.4%) and it would save WebKit ~2 MB. It is not committed because
**nothing on this workstation can verify that it draws** - Chromium cannot read OT-SVG by
construction, and the only local engine that can is the user's own Firefox, which must not be
driven. Shipping an unverified colour font to iOS is the precise shape of the three iOS defects
that were invisible to every gate here. When a WebKit engine is reachable, the derivation is one
edit away; until then WebKit gets the merged font it already had.

## Wired in

- One `@font-face` (`font-display: swap`) in `frontend/src/app.css`, family name
  `'Noto Color Emoji Canari'`, with **TWO source components and the engine picking**:
  `url(...-COLRv1.woff2) format('woff2') tech(color-COLRv1)` first, the merged font with no
  `tech()` last. An engine that cannot parse `tech()` treats that ONE component as invalid and
  skips it - the `@font-face` survives and the next component answers, which is verified behaviour
  in a real Chrome (an unrecognised `tech()` value falls through the same way) rather than an
  inference from the grammar. **The fall-through is the mechanism, not a fallback path**: no engine
  that understands the first line ever requests the second file.
  **It is deliberately NOT preloaded, and was until 2026-09-16.**
  5 705 472 bytes is larger than the MLS engine and larger than the application bundle - the
  biggest single thing this site serves - and a preload puts exactly that in front of everything
  else on a first visit. Measured on production that day it held the origin link for ~12 s while
  the 723 kB encryption engine queued behind it at 54 kB/s, and Firefox reported the preload
  "not used after a few seconds" in the same load. `swap` already defines the behaviour without it:
  the platform glyphs draw, this font replaces them when it arrives.
- **Its bytes are worth a month at the edge** - `location /fonts/` in
  `infrastructure/local/Dockerfile.frontend` sends `public, max-age=2592000`, which is as long as a
  stable filename may safely claim. There is no content hash in the name, so `immutable` is not
  available: a rebuilt font under the same name would be unreachable for a year. The monthly
  conditional request is answered 304 from nginx's ETag, so a returning browser downloads these
  bytes once. **If either font is ever rebuilt, the sha256 in the tables above changes and the cached
  copies expire within thirty days** - that is the whole safety margin, and it is why the TTL is a
  month rather than a year. Both files sit under `/fonts/`, so both take that policy.
- Appended as the last fallback (before the generic keyword) on both global stacks (`body`,
  `h1`-`h6`/`.font-brand`) and on every stack re-declared for an export: `PosterCanvas.svelte` (5
  inline stacks), `calendarExport.ts` (3 stacks, including the two JS-side container assignments),
  `trombinoscope.ts` (2 stacks), `avatar.ts` (the SVG data-URI initials fallback) and
  `MentionComposerInput.svelte`'s monospace stack.
- The emoji picker (`MessageEmojiPicker.svelte`) sets `--emoji-font-family` on the `<emoji-picker>`
  element - the library's own shadow-DOM CSS reads `.emoji { font-family: var(--emoji-font-family) }`,
  so this is the entire change on that side.

## The picker's dataset - already self-hosted, both locales, by a sibling fix

Both datasets were already served from `frontend/static/` before this entry: `#682` (2026-09-15)
self-hosted the English half the same way the French half already was, via
`tools/emoji-data/sync.mjs` (copies `emoji-picker-element-data`, pinned to an EXACT version, verbatim
into `static/`) and `emojiData.test.ts` (asserts the committed files stay byte-identical to the
package). This entry only ADDS `--emoji-font-family` on the `<emoji-picker>` element - it does not
touch the dataset or its sync mechanism.

## The picker's interface strings come from Paraglide, like every other string on screen

`emoji-picker-element` translates NOTHING from its `locale` attribute - that attribute only chooses
which search keywords the dataset carries - so the `i18n` PROPERTY has to be set explicitly or the
search box reads "Search" in a French interface. Until 2026-09-18 that was two hand-written objects
in `emojiPickerShared.ts` and a `getLocale()` branch picking between them: Paraglide's job, done
twice by hand, in the one file whose docblock already records what an incomplete table costs.

It is now one `emojiPickerI18n()` built from 27 `m.emoji_picker_*` keys, spread onto the library's
own `enI18n` exactly as before. Two properties come out of that shape rather than out of discipline:
a key present in one locale and missing in the other is no longer expressible, and the table is a
FUNCTION because `m.*()` reads the locale at call time - a module-level constant would freeze
whichever locale was live at import, which the two constants it replaced did not do.

`emojiPickerShared.test.ts` asserts the completeness in BOTH locales against `Object.keys(enI18n)`,
so the crash below is pinned rather than remembered.

## `emojiUnsupportedMessage` - not deleted, and why

`emojiPickerShared.ts`'s i18n table carries an `emojiUnsupportedMessage` string,
required by `emoji-picker-element`'s own completeness invariant (every i18n key must be present or
the picker throws - see the docblock above `EMOJI_PICKER_BASE_I18N`). It cannot be deleted without
breaking that invariant, so it stays; bundling the font everywhere makes the state it describes
practically unreachable (WebKitGTK, the one engine that might still lack colour-emoji support, is no
longer a build target - see the backlog entry). This corrects the backlog's own assumption that the
key could simply be dropped.

## Build-time coverage proof

`frontend/scripts/check-emoji-coverage.mjs` (wired into `bun run build`, after
`check-bundle-consistency.mjs`) shapes every entry's `emoji` codepoint sequence from BOTH datasets
against **every committed font** with `harfbuzzjs` and asserts it resolves to EXACTLY ONE glyph -
not zero (a gap in the font) and not more than one (the GSUB ligature that merges a flag or a ZWJ
family into a single glyph did not fire). A miss fails the build with every offending entry listed,
named by font, never a silent gap. Passes for all **7 692 (entry x font) pairs**: 3 846 entries
across both datasets, against both the merged artefact and the COLRv1 derivation.

**It reads every shipped font because a gate that reads one of two proves nothing about the one the
reader gets.** The ladder hands Chromium and Firefox the derivation and everything else the merged
file, so a defect in the derivation is invisible to a check pointed at the merged file alone - and
the format 14 loss above is exactly that defect, caught by this check and by nothing else.

**This build of `harfbuzzjs` cannot read a `.woff2` directly** - handed the committed file's bytes
as-is, `hb.Face` reports zero GSUB scripts and shapes every codepoint to glyph 0 (glyph .notdef),
which reads exactly like an empty font rather than a decode error. Verified this is a harfbuzzjs
limitation and not a defect in the merge: round-tripping the known-good SOURCE font
(`Noto-COLRv1.ttf`) through the same woff2 save reproduces the identical all-zero result. The script
decompresses the woff2 back to a plain TTF in memory first, with `wawoff2` (a devDependency), and
shapes THAT.

## The PDF export - rasterised, never embedded

jsPDF's text embedding (`frontend/src/lib/pdf/appFonts.ts`) only supports plain TrueType outlines -
it cannot render a COLR/SVG colour glyph. `searchableRaster.ts`'s existing "hide text, rasterise the
background, redraw as vector on top" pass already has a clean seam for this: a `data-pdf-text` node
whose text contains emoji (`$lib/utils/emoji.ts`'s `containsEmoji`) is marked
`data-pdf-text-raster-only` for the raster pass instead of hidden, so it is captured pixel-perfect in
colour - and `drawTextSpecs` skips it, so nothing invisible is drawn on top. A heading with no emoji
keeps the exact existing behaviour (crisp, searchable vector text). `appFonts.ts` needed no change:
the decision is made one layer up, so it never needs to know about colour fonts.

## Jumbomoji

`$lib/utils/emoji.ts` also exports `isEmojiOnlyText(text, maxCount)`, built on `Intl.Segmenter`
grapheme clusters (which group a ZWJ family, a flag pair or a skin-toned person as ONE unit each) -
the same primitive `containsEmoji` uses, shared rather than duplicated. `MessageBubble.svelte`
computes `isEmojiOnly` from it (up to 5 emoji, no media/reply/poll) and folds it into the same
"naked bubble" condition as `isMediaOnly`/`isLinkOnly`/`isGifOnly`/`isPollOnly`. `MessageTextBody`'s
new `jumbo` prop swaps `text-sm leading-relaxed` for `text-3xl leading-tight` - the largest existing
`--text-*` step, not an eighth size.

## What bundling a font does NOT change

The notification shade, the OS share sheet, the keyboard's own emoji panel and every other native
surface are drawn by the platform - bundling a font changes nothing there, and "the notification
shows a different emoji" is expected, not a regression. WebKitGTK (the one engine that reads neither
table) is no longer a build target ([cicd](../cicd.md#the-linux-desktop-build-is-suspended-not-lost-2026-09-03));
verify once, on a real build, if it ever comes back.
