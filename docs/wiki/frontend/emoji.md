# Emoji - Noto's pictures, everywhere

Canari draws every emoji as **Noto's own SVG**, as an `<img>`, on every platform and in every surface
it draws itself - so the same codepoint is the same picture on Android, iOS, Windows and Linux, the
picker never depends on a third-party CDN, and no engine's colour-font support decides anything. Noto
over Microsoft's Fluent Emoji was decided 2026-08-23 on coverage (Fluent has no flags, no ZWJ families,
and stopped at Unicode 15.1); the numbers are in the [backlog](../backlog.md) entry of that date.

## Pictures replace the font - decided 2026-09-25, in four pull requests

**The user's decision**: the font never drew on WebKit (Safari and the iOS app showed Apple's glyphs,
[backlog](../backlog.md)), so every emoji becomes Noto's own SVG drawn as an `<img>` - on every
platform, one mechanism, the same pictures the font carried. Four pull requests, in this order: **(1)**
the pictures, the runtime rule, the build gate, and the first surfaces (message text, search hits,
reaction pills); **(2)** every other surface; **(3)** the picker drawn by our own grid; **(4)** the fonts
deleted - done: the fonts, their `@font-face`, every stack naming them, the harfbuzz gate and its two
dependencies, the split script and nginx's `/fonts/` block are gone. The composer's pictures were a
fifth pull request, and the rule for emoji sent without U+FE0F a sixth.

**Decided with the user, not to be re-opened**: Noto rather than Twemoji (same art as the font, the
2026-08-23 coverage argument unchanged); pictures EVERYWHERE rather than on Apple only (one mechanism);
and pictures in the composer too, while typing (user, 2026-09-25: *"ce que discord fait, c'est aussi
inserer l'emoji en svg dans l'input"* - the first answer, "keep the platform glyph", rested on this
page's author calling the composer a textarea, which it is not).

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

1. **It is not one of the few characters that are really text**: `#`, `*`, the digits, `©`, `®` and
   `™` are a picture only with U+FE0F (in `© 2026` or `#1` they are text); every other emoji is a
   picture with or without it - Twemoji's and Discord's rule. No Unicode property is asked at runtime.
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

**Deliberately NOT pictures**: the message edit `<textarea>` and comment edit `<input>` (form fields
cannot hold one), code in the composer (as once sent), the OS notification shade and anything else
the platform draws.

### In the composer, an emoji is an atom

`MentionComposerInput` is a `contenteditable` rebuilt from plain text, and every caller reads plain
text, so the picture must be invisible to all of them. It is modelled on the mention chip
(`mentionEditor.ts`): an `<img class="emoji" data-emoji="...">` that `serializeMentionEditor` writes
back as the emoji, that the caret functions count as the emoji's UTF-16 length and never land inside,
and that native Backspace removes whole. Emoji arrive as TEXT - the keyboard, a paste, an IME commit -
so `needsEmojiRender` (a text node outside code holding a drawable emoji) joins the mention and
markdown triggers that rebuild the DOM at the caret. The placeholder test reads the pictures too: an
editor holding only an emoji has an empty `textContent`.

Measured in a real Chromium on a throwaway route: typing then inserting `😀` draws it and the next
keystrokes land after it; seven Backspaces remove " ça va" and then the emoji whole; pasting
` 🇫🇷 et 👍🏽` draws two pictures; the value handed back is the exact text every time; no page error.
**The iPhone keyboard and its IME are owed on the device.** Native undo across a rebuild is what it
already was with mentions and the markdown preview: the rebuild replaces the DOM.

### The gate

`check-emoji-coverage.mjs` (in `bun run build`) now checks the pictures first, importing the runtime's
own `emojiSvgSrc` rather than re-implementing it: `static/emoji/` holds exactly one set, the one the
list names; the list and the files agree; and every emoji the picker offers, **skin tones included
(7906, where the font half checks 7692 without them)**, has a picture.

## The picker - our own grid since 2026-09-25, on the same self-hosted dataset

`emoji-picker-element` drew with a font inside its shadow root, so it kept Apple's glyphs on WebKit
after the messages had moved to pictures. It is REMOVED (dependency, `vite.config.js` pre-bundle,
its i18n table and `attachEmojiPicker`); both pickers - reactions (`MessageEmojiPicker`) and the
composer's (`ComposerEmojiPicker`) - mount `EmojiGrid.svelte`, which does what the library did for us
and nothing more:

- **The data is unchanged**: the two datasets in `static/`, copied byte for byte from the pinned
  `emoji-picker-element-data` by `tools/emoji-data/sync.mjs` and held identical by `emojiData.test.ts`.
  `emojiCatalog.ts` groups them into the nine categories in the dataset's own order - emojibase group
  2 ("component", the bare tone and hair swatches) is left out, as the library left it out.
- **Search follows the ecosystem's contract**, applied in the browser by `tolerantSearch.ts` - its
  first client-side user: folded case and accents (and ligatures: French writes "cœur"), every word
  must match, closest first, one typo from four letters. "ceour" finds the hearts.
- **One skin tone at a time**, persisted (`canari_emoji_skin_tone`) and shared by both pickers like the
  recents; a multi-person entry takes the variant where everyone has that tone, as the library did.
- **The recents row** stays with each mount, which already owned it, now drawn with `EmojiText`.
- **The interface strings are Paraglide's** `m.emoji_picker_*`; the five keys only the library read
  (`unsupported_message`, `favorites_label`, `search_description`, `skin_tone_description`,
  `category_custom`) are deleted, and `no_results` / `retry` added.

Verified in a real Chromium on a throwaway route: 1914 buttons, lazily loaded (697 of them fetched on
open), a French typo search, a tone applied to a whole category and returned by the click.

**THE PRESENTATION RULE WAS WRONG ON OLD ENGINES, and this PR is where it was caught.** The first
version asked `\p{Emoji_Presentation}` at runtime, which answers from the ENGINE's Unicode tables:
under Node, seven Unicode 16 entries the picker offers (U+1FAEA among them) were not emoji at all, so
an older WebView would have drawn them as text while holding their picture. The runtime now reads no
Unicode property; `emojiSvg.test.ts` pins U+1FAEA under Node.

**AND UNICODE'S OWN TEXT-DEFAULT LIST WAS TOO STRICT, found by the user the same day.** The second
version shipped the 230 code points Unicode calls text-default and drew them as text without U+FE0F.
`📽` (U+1F4FD) stayed a character - keyboards and pastes routinely send such pictographs without the
selector, and every platform draws them as emoji regardless. The list is now the fifteen characters
with a real typographic life (`#`, `*`, `0`-`9`, `©`, `®`, `™`), fixed in `emojiSvg.ts`; the computed
list and its code in `tools/emoji-svg/build.mjs` are gone.

## The PDF export - rasterised, never embedded

jsPDF's text embedding (`frontend/src/lib/pdf/appFonts.ts`) only supports plain TrueType outlines, so
an emoji is never text in a PDF. `searchableRaster.ts`'s "hide text, rasterise the background, redraw
as vector on top" pass keeps any `data-pdf-text` node holding an emoji in the RASTER
(`data-pdf-text-raster-only`) instead of hiding it - one whose text contains an emoji character, and
since 2026-09-25 one that CONTAINS a picture (`img.emoji`), which `textContent` does not show: read as
plain text, it would have been hidden, picture included (`searchableRaster.test.ts` pins it, with a
control). The string-built exports - the calendar and the trombinoscope - write their user text through
`emojiHtml()` (escaped, pictures inlined with their size, since the sheet is rasterised off-page); the
poster is Svelte and uses `EmojiText`. **Measured in Chromium** through the real
`rasterizeElementToCanvas` -> snapdom path: the pictures are embedded from their relative URLs, and the
missing-image report stays empty.

## Jumbomoji

`$lib/utils/emoji.ts` also exports `isEmojiOnlyText(text, maxCount)`, built on `Intl.Segmenter`
grapheme clusters (which group a ZWJ family, a flag pair or a skin-toned person as ONE unit each) -
the same primitive `containsEmoji` uses, shared rather than duplicated. `MessageBubble.svelte`
computes `isEmojiOnly` from it (up to 5 emoji, no media/reply/poll) and folds it into the same
"naked bubble" condition as `isMediaOnly`/`isLinkOnly`/`isGifOnly`/`isPollOnly`. `MessageTextBody`'s
new `jumbo` prop swaps `text-sm leading-relaxed` for `text-3xl leading-tight` - the largest existing
`--text-*` step, not an eighth size.

## What the pictures do NOT change

The notification shade, the OS share sheet, the keyboard's own emoji panel and every other native
surface are drawn by the platform, as are form fields (`<textarea>`, `<input>`) and attributes
(`title`, `aria-label`): "the notification shows a different emoji" is expected, not a regression.

## History - the bundled font, 2026-08-23 to 2026-09-25

The first answer was a font: Noto Color Emoji merged by `nanoemoji`'s `maximum_color` into ONE file
carrying both COLRv1 (Chromium, Firefox) and OT-SVG (WebKit), a COLRv1-only derivation for the engines
that could say so through `tech()`, a harfbuzz gate proving every picker entry shaped to one glyph, and
no preload after it held the origin link for ~12 s. It drew everywhere except WebKit - Safari and the
iOS app kept Apple's glyphs, for one of two causes nothing here could separate - and that is why the
pictures replaced it. The whole mechanism (provenance, sha256s, the derivation's measurements, the
format-14 loss the gate caught) is in this page's history at `5041d12de`, the last commit that shipped
the fonts: `git show 5041d12de:docs/wiki/frontend/emoji.md`.
