## P2 - A post's attachments follow one standard (owner, 2026-11-14/15)

target: 1.7.0

The owner: *"homogeneiser un peu les posts"*. A post carrying several attachments at once (links, a
form, images, a PDF) draws each kind with its own shape, icon, chip, border, spacing and action
affordance. This is a feed design pass, not a pairing of two form cards. Nothing is built yet.

### Inventory (read from the code, 2026-11-15; phone screenshots still to take)

Order today in `PostCard`: header, `PostContent` (text, then link previews, then media), actions, `PostPolls`,
attached forms, comments.

| Kind | Component | Shape | Icon / chip | Border, padding | Action affordance |
| --- | --- | --- | --- | --- | --- |
| Image, gallery | `PostContent` grid, `PostMedia` | edge to edge, square cells, `gap-0.5`, "+N" past four | none | no border, no side inset | tap opens the viewer |
| Video, CanaReel | `PostMedia` | edge to edge, 60svh ceiling | play glyph | none | tap plays / opens the reels viewer |
| Replay | `ReplayCard` | its own card | own | own | opens the reel viewer |
| PDF / file | document row (`usesCompactDocumentRows`) | row, text's 16 px inset; compact from two files | file glyph | own | tap opens |
| Link, external | `LinkPreviewCard` | `rounded-2xl` card, 64 px thumb or favicon, host chip | host chip (amber) | `border-black/5`, `p-3 sm:p-4`, `mt-3` | external-link arrow |
| Link, in-app (post, form, association, profile, route) | `LinkPreviewCard` + `CanariLinkPreviewMedia` | same card, logo tile, kind chip ("Formulaire") | kind chip, accent ring | as above plus `ring-accent/12` | up-right arrow |
| Link, MiGallery / ecosystem cover | `EcosystemCoverPreview` | blurred cover, stacked tiles, own layout | site label | own | own |
| Attached form | `PostForms` / `FormCard` | `rounded-2xl` card, 40 px tinted icon tile, NO chip | clipboard / check | `border-black/5`, `p-4`, `px-5 py-3` wrapper, `space-y-3` | external-link or arrow, plus the bell when not open yet |
| Poll | `PostPolls` | bigger card, `p-5`, `px-5 py-4` wrapper, `space-y-5`, `border-2` options | poll glyph | `border-black/5` | vote buttons |
| Event chip | to be inventoried (linked event on the header) | | | | |

The two non-media card families differ in: thumbnail (64 px photo or logo vs a 40 px glyph tile), chip
(present vs absent), padding (`p-3 sm:p-4` vs `p-4` vs `p-5`), wrapper inset (none, `px-5`, `px-4`),
vertical rhythm (`mt-3`, `space-y-3`, `space-y-5`) and the arrow (external, up-right, forward).
Screenshots of each, to keep OUT of the repo (they may show names), go in
`F:/Programmation/canari-harness/post-layout/`.

### Proposed standard (the feed follows Instagram and Facebook, [design-reference](../frontend/design-reference.md))

- ONE anatomy for every non-media attachment: leading 48 px tile (image, logo or glyph), a kind chip
  above a one-line title, ONE status line below, a trailing slot. Radius `rounded-2xl` (the 12 px card
  step), `p-3`, one border, one hover. The poll keeps its voting body but takes the same frame.
- Media stays edge to edge and never inset; the cards sit on the text's 16 px inset, `space-y-2` between
  them.
- Order: text, media, then ONE attachments group (files, links, form, poll), then the action bar.
- The trailing slot is the primary action of the kind, never a decorative arrow: the bell for a form not
  open yet, "Open" for an open one, a check for an answered one; a plain link shows none.
- The bell and the status line (opens on, closed, full, answered) appear on EVERY form card, attached or
  linked, from the one form-state function.

### Questions for the owner (each with a recommended option first)

1. Are the poll and the file row in scope, or only links and forms? Recommended: links, forms, files
   and poll, media untouched.
2. One kind chip on every card (a form gets "Formulaire" as a link does today)? Recommended: yes.
3. Where does the attachments group sit relative to the action bar? Recommended: above it, as listed.
4. Does a form link in the text become the same card as an attached form, and is a link that merely
   repeats an attached form dropped? Recommended: same card; a link repeating an attachment is hidden.
5. Is the chat bubble's link preview changed too? Recommended: no, it keeps the compact card.

A first attempt at questions 4's card (form link drawn as `FormCard`) is parked on branch
`park/form-card-unify`.
