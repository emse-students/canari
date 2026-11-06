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
2. One tolerance, in BOTH: whitespace just inside a DOUBLE marker (`**`, `__`, `~~`, `***`) is moved
   outside it (`emphasisTolerance.ts`, called first by `preprocessPostMarkdown`), so posts already
   published render bold. **The rule that bounds it: no post that rendered a bold correctly before
   may render differently after.** A loose span is rewritten only if (`looseSpanAccepted`, shared
   with the preview so they pair alike): its inside does not contain the marker, its closer is not
   glued to a letter, digit or marker, a `__` opener is not inside a word, and no more real closers
   follow than real openers (else the first would have closed OUR opener today:
   `foo **bar ** baz** qux` is bold from `bar` to `baz` and stays so). A rejected span resumes the scan
   after its closer. `5 ** 2 = 25, **important**` and `x ** y **bold**` are left alone.
   The moved space is dropped next to existing whitespace or a line edge, so `- ** item **` and
   `1. ** x**` keep their list nesting. Never rewritten: fenced code (``` and ~~~, any indent),
   4-space indented code outside a list, code spans (matched by backtick-run length) and autolinked
   URLs. Single `*` / `_` are never tolerated (`2 * 3 * 4` is arithmetic).
3. The toolbar (`computeComposerFormat`, pure) keeps edge whitespace outside, never wraps a line's
   prefix (indentation, `>` levels, then ONE of `#`..`######`, `-` `*` `+`, `1.` `1)`, with its
   `[ ]` box), wraps line by line, and toggles off. A selection that starts and ends with the marker
   but holds two spans (`**Prix** : 5 **ce soir**`) is MERGED into one (`**Prix : 5 ce soir**`), not
   mistaken for one wrapped span.
4. `markdownParity.test.ts` renders one corpus through both parsers, and renders every toolbar
   output through marked ALONE (the tolerance cannot hide a bad output), asserting also that the
   selection lands on the text the action touched. A fuzz of 4000 strings asserts the tolerance never
   removes a bold or strike that marked drew from the raw text.

### What parity covers, exactly

Covered, one line at a time, same style on the same text: bold, italic, bold-italic (`*`, `_`,
`**`, `__`, `***`), strike (`~~` and GFM `~`), code spans (backtick runs of equal length), escapes,
ATX headings, an autolinked URL containing markers, intra-word `_` / `__`.

**Known gaps, each asserted to still differ** (`KNOWN_GAPS`, fixing one must change this list):
a span crossing a line break (`**a` newline `b**`: the preview parses lines apart), and
nested same-marker pairings that need a real delimiter stack (`~~a ~~b~~`, `***a** b*`,
`**a *b** c*`). Not styled by the preview at all: links, lists, quotes (the toolbar outputs are
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
| bold / italic over two separate runs (`**a** b **c**`) | merged into one span |
| quote on a list item | `> - a`; list on a quoted line keeps the quote |
| list toggles off a nested item | `  b`, its indent kept |
| quote / list, several lines | every non-blank line (list skips blank lines) |
| quote / list on the same marker | off |

| link on a selection | `[sel](url)` (url selected), edge spaces outside |
| link on `[x](url)` | off: `x` |

Ctrl+Z does not undo a toolbar action (older than this page, [backlog](../backlog.d/p3-ctrl-z-does-not-undo-a-toolbar-action.md)).

Heading containing bold (`# **x**`) and bold in a heading both render bold in the post
(`h1 > strong`), and the preview shows the same.
