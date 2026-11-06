# Markdown coherence: the toolbar, the composer preview and the published post (2026-11-06)

Reported on a production post: `**TOP 5 MINIMOYS **` was shown with its asterisks, not in bold.

## The cause

CommonMark pairs a closing `**` only when it is right-flanking, so it must NOT follow whitespace.
`MarkdownComposerToolbar` wrapped the raw selection, and a double-click or a drag that ends on a
space selects that space. The composer showed it bold anyway, because the live preview is not the
renderer.

## Three surfaces, two parsers

| Surface | Parser |
| --- | --- |
| Toolbar (`composerMarkdownFormat.ts`) | writes text, parses nothing |
| Composer preview (`inlinePreview.ts`, drawn by `mentionEditor.ts`) | a HAND parser: a contenteditable cannot host the renderer |
| Published post, comment, bio, reel caption | `preprocessPostMarkdown` then marked through svelte-markdown (`gfm`, `breaks`), via `PostMarkdown` / `ProfileBioMarkdown` / the comment components |

Chat messages are not markdown (`messageDisplay.ts` links and mentions only), so they are untouched.

They DID differ: the preview drew `__x__` as an underline (the post renders it bold), italicised
`2 * 3 * 4` and `snake_case_name` (the post does not), and paired `*x *`. The sanitiser is unchanged
(`postMarkdownRenderers.ts`, no raw HTML).

## The rules now

1. The published post decides. The preview follows marked: `__x__` is bold (no underline exists any
   more), a single `*` / `_` needs CommonMark flanking, `_` is not intra-word.
2. One tolerance, in the renderer and mirrored in the preview: whitespace just inside a DOUBLE
   marker (`**`, `__`, `~~`, `***`) is moved outside it (`emphasisTolerance.ts`, called first by
   `preprocessPostMarkdown`), so posts already published render bold.
   **The rule, TRUE BY CONSTRUCTION (decided 2026-11-06, after two adversarial reviews): no post that
   rendered an emphasis before may render differently after.** Nothing predicts marked. Per
   paragraph (the blocks between blank lines; code untouched), the paragraph is rendered as today.
   Only if that render still shows a literal `**`, `__` or `~~` is a rewrite tried, one loose span at
   a time, and a span is kept only if the new render (a) still holds every strong / em / del run of
   the original render, same tag over the SAME PLACE (start and length counted in rendered characters that are not whitespace or `*`, `_`, `~`, so two runs with the same text are two runs and a rewrite cannot move a bold onto its twin) at the same nesting depth or deeper, and (b) shows strictly fewer
   literal markers. Otherwise the original text stays. A paragraph with no leftover marker costs one
   extra render; a paragraph over 8000 characters, and spans past the 24th, are left alone, and a
   document has a fixed budget of 300000 rendered characters (checked before every render): past it
   the rest of the document is left as written. Every fallback is the original, which cannot lose
   anything. A crafted 48k post (six 7990-character paragraphs of 24+ loose spans) cost 255 ms before
   the budget and is bounded now, the tail paragraphs byte for byte unchanged. The first version predicted marked with
   regexes and lost `**a **b** c**` (nested bold, which is what the old toolbar wrote around a phrase
   holding a bold word), a bold continuing past a code span or a URL or a soft break, and any bold
   whose closer was more than 1500 characters away.
   The moved space is dropped next to existing whitespace or a line edge (`- ** item **` and
   `1. ** x**` keep their nesting). Never rewritten: fenced code (``` and ~~~, any indent), 4-space
   indented code outside a list, code spans (matched by backtick-run length) and autolinked URLs.
   Single `*` / `_` are never tolerated. Accepted consequence: `2 ** 3 ** 2` now reads `3` as bold
   (it shows literal markers and the rewrite loses nothing).
3. The preview pairs by the same rules in LINEAR time (`PairingIndex` in `inlinePreview.ts`: every
   closer search is an array lookup). The first version scanned and sliced from each opener, so 20000
   characters of `**a ` cost two minutes per keystroke; it is 8 to 15 ms now (measured 2026-11-06:
   20000 characters of `**a `, `*a `, `__a `, `** a `, `**a ** `, backticks or `h ` probes all between
   7 and 15 ms; the renderer's tolerance on a 7.7k stray-marker paragraph 61 ms).
4. The toolbar (`computeComposerFormat`, pure) keeps edge whitespace outside, never wraps a line's
   prefix (indentation, `>` levels, then ONE of `#`..`######`, `-` `*` `+`, `1.` `1)`, with its
   `[ ]` box), wraps line by line, and applies ONE inline rule, as a word processor has it.
   Coverage is read from the preview's own pairing (`inlineSpans`) on that line. A selection wholly
   inside styled spans turns the style OFF by SPLITTING each span around it and dropping the empty
   pieces: bold on `soir` in `**Prix ce soir**` gives `**Prix ce** soir`, on `Prix` gives
   `Prix **ce soir**`, on `ce` gives `**Prix** ce **soir**`, on `b` in `**ab**` gives `**a**b`; a `***`
   span keeps its other style. Anything else strips every inner run of that marker (partial edge runs
   included, `**a`) and wraps the trimmed selection once (`**a** and *b*` + bold gives
   `**a and *b***`). A run with whitespace on both sides (`2 * 3`) is text and is kept. Pressed
   twice over the whole text, the button round-trips when nothing nested is absorbed
   (`**a** b **c**` italic, `a ** b ** c` bold, plain text, a whole bold phrase); a style NESTED in the
   selection is absorbed by the wrap and not given back (`**a *b* c**` italic twice gives
   `**a b c**`), a documented semantic of "wrap everything".
5. Tests. `markdownParity.test.ts` renders one corpus through both parsers and every toolbar output
   through marked ALONE (the tolerance cannot hide a bad output), asserting the selection lands on
   the text the action touched. `emphasisToleranceRule.test.ts` proves the rule from outside: hand
   cases from both reviews, a deterministic fuzz of 20000 documents (generator: loose and stray
   markers, `***`, list and quote prefixes, indentation, links, URLs, code, blank lines; it asserts
   the generator reaches the tolerance on more than 500 of them; deleting the run-preservation check
   makes it fail), the same four strings the third review named (`** a**a**a**`, `~~ a~~a~~a~~`,
   `****a ***a**`, `**a **a**a*`), an EXHAUSTIVE search (every string of up to 8 tokens over
   `** a *` and over `~~ a **`) judged by an independent DOM reader and offsets, the crafted-post
   budget, the run scanner checked against a real DOM, and the preview's cost on adversarial shapes
   (generous bounds, no step counter). Switching the run key back to tag and text fails the hand
   strings and both exhaustive searches.

### What parity covers, exactly

Covered, one line at a time, same style on the same text: bold, italic, bold-italic (`*`, `_`,
`**`, `__`, `***`), strike (`~~` and GFM `~`), code spans (backtick runs of equal length), escapes,
ATX headings, an autolinked URL containing markers, intra-word `_` / `__`.

**Known gaps, each asserted to still differ** (`KNOWN_GAPS`, fixing one must change this list):
a span crossing a line break (`**a` newline `b**`: the preview parses lines apart), and
nested same-marker pairings that need a real delimiter stack (`~~a ~~b~~`, `***a** b*`,
`**a *b** c*`, `**a **b** c**`). Not styled by the preview at all: links, lists, quotes (the toolbar outputs are
checked against marked directly instead).

## The cases (each is a row of `markdownParity.test.ts`)

| Action, selection | Result |
| --- | --- |
| bold `word` | `**word**` |
| bold `TOP 5 MINIMOYS ` (trailing space) | `**TOP 5 MINIMOYS** ` |
| bold ` a ` (spaces both sides) | spaces stay outside |
| italic / strike / code with edge spaces | same: `*x* `, `~~x~~ `, `` `x` `` |
| bold, nothing selected | `**placeholder**`, the placeholder selected |
| bold, whitespace-only selection | the placeholder inserted, whitespace kept |
| bold on `**x**` (markers selected, or only `x`) | off: `x` |
| italic on `**x**` | `***x***`; italic again: `**x**` |
| bold on `*x*` | `***x***`; bold again: `*x*` |
| bold, several lines | each non-blank line wrapped on its own |
| bold inside `## Title` | `## **Title**` (the `## ` is never wrapped) |
| bold on a whole heading / list line | `## **Title**`, `- **item**` |
| heading on a plain line | `## Title`; again, or on `# Title`: off |
| heading on `**x**` | `## **x**` |
| heading on a list line | replaces the marker: one block marker per line; a nested item loses its indent |
| bold on a nested, quoted, `1)` or `- [ ]` item | the text only: `  - **sub**`, `> - **item**`, `- [ ] **task**` |
| bold on one word inside a bold phrase (`**Prix ce soir**`, `soir`) | `**Prix ce** soir`: the span is split |
| strike on a word inside `~~Prix ce soir~~` | `~~Prix ce~~ soir` |
| bold on `ab`'s last letter in `**ab**` | `**a**b` |
| bold / italic over two separate runs (`**a** b **c**`) | merged into one span |
| bold over `**a** and *b*` | `**a and *b***` (a, and, b bold; b italic) |
| bold on a partial run `**a` | `**a**` |
| bold on `2 * 3` | `**2 * 3**` (a lone `*` between spaces is text) |
| quote on a list item | `> - a`; list on a quoted line keeps the quote |
| list toggles off a nested item | `  b`, its indent kept |
| quote / list, several lines | every non-blank line (list skips blank lines) |
| quote / list on the same marker | off |

| link on a selection | the selection becomes the link text, the word `url` as destination (selected), edge spaces outside |
| link on an existing link | off: the label alone |

Ctrl+Z does not undo a toolbar action (older than this page, [backlog](../backlog.d/p3-ctrl-z-does-not-undo-a-toolbar-action.md)).

Heading containing bold (`# **x**`) and bold in a heading both render bold in the post
(`h1 > strong`), and the preview shows the same.
