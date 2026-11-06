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
   published render bold. Single markers are not tolerated (`2 * 3 * 4` is arithmetic). Code spans
   and fences are never rewritten. Known cost: `a ** b ** c` now renders `b` bold (the preview
   already did).
3. The toolbar (`computeComposerFormat`, pure) keeps edge whitespace outside, never wraps a line's
   block marker, wraps line by line, and toggles off.
4. `markdownParity.test.ts` renders one corpus through both parsers (same style on the same text)
   and renders the output of every toolbar case through marked.

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
| heading on a list or quote line | replaces the marker: one block marker per line |
| quote / list, several lines | every non-blank line (list skips blank lines) |
| quote / list on the same marker | off |
| link on a selection | `[sel](url)` (url selected), edge spaces outside |
| link on `[x](url)` | off: `x` |

Heading containing bold (`# **x**`) and bold in a heading both render bold in the post
(`h1 > strong`), and the preview shows the same.
