# Posts module

**Routes**: `src/routes/posts/`, `src/routes/post/[postId]/`  
**Components**: `src/lib/components/posts/`

## Responsibilities

- News feed with three tabs: all posts, followed associations, by category.
- Post creation with rich content: Markdown, image, poll, embedded form.
- Reactions (emoji), comments, post sharing.
- Search within the feed.
- Pin/unpin (admin only).
- Report posts (moderation).

## Feed tabs

| Tab | Content |
|---|---|
| All | All posts from all associations |
| Followed | Posts from associations the user follows |
| Association filter | Posts from a specific association or category |

Posts are loaded via `GET /api/posts` (social-service), paginated with infinite scroll (`IntersectionObserver`).

## Post creation (EditPostForm.svelte)

- Markdown content editor.
- Optional image upload (CEK not used here — public media via `POST /api/media/upload/public`).
- Optional poll (question + options).
- Optional embedded form (link to an association form).
- Optional scheduling (publish at a future time).
- Publish on behalf of an association (if admin with `MANAGE_ASSO`).

## Key components

| Component | Role |
|---|---|
| `posts/+page.svelte` | Feed page with tabs, search, infinite scroll |
| `posts/[postId]/+page.svelte` | Single post detail page |
| `EditPostForm.svelte` | Create/edit post (markdown, image, poll) |
| `PostCard.svelte` | Post card in the feed |
| `PostReactions.svelte` | Emoji reaction bar |
| `PostComments.svelte` | Comment thread + composer (text, mentions, image/GIF) |

## Attachment layout (PostContent / PostMedia)

A post attachment is decrypted client-side, so its container has to hold a shape before the bytes
arrive. That reservation is per media type, not universal — `reservesAspectRatio` in
`utils/mediaLayout.ts` is the single decision, and `resolveMediaType` is the single
explicit-type-then-mime fallback:

- **image / video** — the container sets `aspect-ratio` (from `width`/`height`, else 4:3) so the
  feed does not jump when the media lands. `PostMedia` fills it with `absolute inset-0`
  placeholders.
- **file / audio** — no reservation: the card sizes itself. A document has no `width`/`height`, so
  reserving would apply the 4:3 fallback and strand a ~70 px card in a ~430 px box. Its skeleton
  and its error box must therefore be in the flow, not `absolute` — a parent with no reserved
  height renders an absolutely-positioned child as nothing, including the decrypt-failure state.

The gallery lightbox holds `lightboxMedia`, which is the attachment list **compacted** to
image/video. A grid position is therefore not a lightbox index: each cell resolves its own index
via `indexOf`, and `-1` doubles as "not lightboxable". Passing the grid index would let one
document renumber every image after it.

## PDF previews, and the in-app reader

`utils/pdfDocument.ts` is the one pdf.js seam: it loads the library once, opens a decrypted
document, and rasterises any page to a PNG object URL. `PdfThumbnail.svelte` (page 1 only) and
`PdfViewerModal.svelte` (the whole document) both go through it. Two constraints fix this design:

- **No server-side thumbnail is possible.** Media is encrypted with a per-file CEK before upload;
  the backend only ever holds an opaque blob.
- **No `<iframe>` either.** Desktop browsers and iOS WKWebView render a PDF natively, Android's
  WebView does not — it would be blank on the main mobile platform. Rasterising is what lets one
  component serve web, Android, iOS and desktop identically.

pdf.js and its worker load through a dynamic `import()`, so they stay out of the main bundle. The
preview is a bonus and never a gate: on any failure the file icon and the download button remain.
A post renders the page full-width under the file row; a chat bubble uses the 44 px icon square.
List surfaces that do not decrypt their files (`ConversationMediaPanel`, `AssociationDocumentManager`)
are excluded on purpose — previewing there would mean downloading and decrypting every listed
document, and a password-protected vault document cannot be decrypted at all without its password.

**The whole card opens the reader**, header row and preview alike — a preview nobody can click is
decoration. The download button is carved out of that area, which is why the clickable region wraps
the row's *content* rather than the row (a `<button>` inside a `<button>` is not markup), and the
preview repeats the header's action with `tabindex="-1"` rather than adding a second tab stop.

Three things in `PdfViewerModal` are not obvious and each one produced a blank or flickering
viewer before it was right:

- **Its effects must depend on the document URL, and on the render width, and on nothing else.**
  Reading the page array inside either one makes every arriving page re-run the teardown, which
  revokes the object URLs the `<img>`s are currently displaying. Both read it under `untrack`.
- **A page already in view fires no new intersection event.** Lazy rendering is driven by an
  `IntersectionObserver`, so after a zoom invalidates every bitmap the observer has nothing to say
  and the viewer would stay empty — the visible indices are tracked separately and re-requested.
- **Zooming re-renders rather than scaling a bitmap**, so text stays sharp; the placeholder that
  stands in meanwhile keeps each page's own proportions once known (A4 until then), which is why
  `renderPage` returns the bitmap's dimensions rather than just its URL.

## Comment media (image + GIF)

A comment can carry one image or GIF (encrypted + uploaded via `MediaService.encryptAndUpload`,
stored as a `PostImageRef`). Three entry points, all funnelled through one `stageMediaFile` helper:
paste, the in-app GIF picker (`GifPickerModal`/KLIPY — fetches the chosen `.gif` bytes), and the
Android keyboard's GIF button (the `canari-keyboard-media` event; only the focused comment box
handles it). GIFs are uploaded as-is — never canvas-compressed, which would flatten the animation.

## Routes

| Route | Description |
|---|---|
| `/posts` | Main feed |
| `/post/[postId]` | Single post page |
| `/posts/new` | Create post form |
